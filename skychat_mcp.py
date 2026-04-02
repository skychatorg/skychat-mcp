#!/usr/bin/env python3
"""
skychat_mcp.py — MCP server for skych.at

The WebSocket connection runs as a permanent background asyncio task.
MCP tool calls read from / write to shared in-memory state — they never
block waiting for the network.

Auth (first match wins):
  1. --guest flag          → anonymous, no prompt
  2. Saved token           → ~/.config/skychat-mcp/token.json
                             (deliberately separate from skychat-tui)
  3. Interactive prompt    → username/password, token saved on success

Usage:
    python skychat_mcp.py --http           # streamable-http :8765/mcp  (llama.cpp)
    python skychat_mcp.py --sse            # SSE             :8765/sse
    python skychat_mcp.py --guest --http   # skip login, guest session
    python skychat_mcp.py --port=9000 --http

Requires: pip install websockets mcp uvicorn
"""

import asyncio
import getpass
import json
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from html import unescape
from pathlib import Path
from typing import Any, Optional

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    raise SystemExit("MCP SDK not found.  Run: pip install mcp")

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    raise SystemExit("websockets not found.  Run: pip install websockets")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [skychat-mcp] %(levelname)s %(message)s",
)
log = logging.getLogger("skychat-mcp")

# ── Constants ─────────────────────────────────────────────────────────────────
WSS_URL      = os.environ.get("SKYCHAT_URL", "wss://skych.at/api/ws")
DEFAULT_ROOM = 0
MAX_MESSAGES = 500

# ── Token storage — separate from skychat-tui ────────────────────────────────
_CONFIG_DIR = Path(
    os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
) / "skychat-mcp"
_TOKEN_FILE = _CONFIG_DIR / "token.json"


def _load_token() -> Optional[Any]:
    try:
        return json.loads(_TOKEN_FILE.read_text()).get("token")
    except Exception:
        return None


def _save_token(token: Any) -> None:
    try:
        _CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = _TOKEN_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"token": token}, indent=2))
        tmp.chmod(0o600)
        tmp.replace(_TOKEN_FILE)
        log.info("Token saved → %s", _TOKEN_FILE)
    except Exception as e:
        log.warning("Could not save token: %s", e)


def _clear_token() -> None:
    try:
        _TOKEN_FILE.unlink(missing_ok=True)
        log.info("Token cleared")
    except Exception:
        pass


# ── Login prompt ──────────────────────────────────────────────────────────────

def _prompt_login() -> tuple:
    """Interactive credential prompt. Returns (username, password) or (None, None) for guest."""
    print()
    print("╭─ skychat-mcp ────────────────────────────────────╮")
    print("│  Enter credentials, or press Enter for guest.    │")
    print("│  Guests get limited history.                     │")
    print("╰───────────────────────────────────────────────────╯")
    try:
        username = input("  Username: ").strip()
        if not username:
            print("  → Joining as guest.\n")
            return None, None
        password = getpass.getpass("  Password: ")
        return username, password
    except (EOFError, KeyboardInterrupt):
        print("\n  → Joining as guest.\n")
        return None, None


# ── Helpers ───────────────────────────────────────────────────────────────────
_TAG_RE = re.compile(r"<[^>]+>")


def _strip(s: str) -> str:
    return unescape(_TAG_RE.sub("", s or "")).strip()


def _parse_ts(msg: dict) -> str:
    for key in ("date", "createdTimestamp", "createdAt", "timestamp", "time"):
        raw = msg.get(key)
        if raw is None:
            continue
        try:
            v = float(raw)
            if v > 4_102_444_800:   # milliseconds → seconds
                v /= 1000
            return time.strftime("%H:%M", time.localtime(v))
        except Exception:
            pass
    return time.strftime("%H:%M")


# ── SkyChat WebSocket client ──────────────────────────────────────────────────

class SkyChat:
    """
    Permanent WebSocket connection.  Auth logic mirrors skychat-tui's client.py:

      - token auth:   send raw {"token": <token>}
      - creds auth:   send raw {"credentials": {"username": ..., "password": ...}}
      - guest auth:   send raw {}
      - connection accepted: server sends a bare dict with NO "event" key
      - room-list:    pushed automatically by server after auth
      - join room:    send {"event": "message", "data": "/join <id>"}
      - history:      send {"event": "message", "data": "/messagehistory"}

    The TUI keeps its WS alive because client.connect() is spawned as an
    asyncio.Task that runs for the entire lifetime of the process — the
    ``async with websockets.connect()`` in the task keeps the TCP socket
    open while ``async for raw in ws`` blocks waiting for frames.

    Here we do the same: ``_run()`` is an infinite reconnect loop spawned
    as a Task.  The critical requirement is that this Task lives in the
    **same** event loop as the MCP/uvicorn server — otherwise it gets
    garbage-collected when the loop ends.
    """

    def __init__(self):
        self._ws:       Optional[Any] = None
        self.user:      dict          = {}
        self.rooms:     list          = []
        self.messages:  list          = []        # normalised, oldest first
        self._seen_ids: set           = set()
        self._ready:    Optional[asyncio.Event] = None
        self._task:     Optional[asyncio.Task]  = None

        # Track the current room so post() can skip redundant /join
        self._current_room: Optional[int] = None

        # Auth credentials — set once before start(), reused on reconnect
        self._token:    Any  = None
        self._username: str  = ""
        self._password: str  = ""
        self._guest:    bool = False

    # ── Public startup ────────────────────────────────────────────────

    async def start(self, *, token=None, username="", password="",
                    guest=False) -> None:
        """
        Start the background WS task and wait until we have history.

        MUST be called from within the event loop that will run for the
        lifetime of the process (i.e. uvicorn's loop).  The background
        task is created with ``asyncio.create_task`` so it lives in that
        same loop and won't be killed when start() returns.
        """
        self._token    = token
        self._username = username
        self._password = password
        self._guest    = guest

        # Always create a fresh Event bound to the CURRENT running loop.
        self._ready = asyncio.Event()

        # Cancel any stale task (e.g. from a pre-flight asyncio.run())
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

        self._ws   = None
        self._task = asyncio.create_task(self._run(), name="skychat-ws")

        try:
            await asyncio.wait_for(self._ready.wait(), timeout=15)
        except asyncio.TimeoutError:
            raise RuntimeError(
                "Timed out connecting to SkyChat. "
                "Check your credentials or network."
            )

    async def stop(self) -> None:
        """Cancel the background task and close the WebSocket."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None

    # ── Background loop ───────────────────────────────────────────────
    #
    # Mirrors the TUI's client.py _open_connection() / _receive_loop():
    #
    #   async with websockets.connect(url) as ws:
    #       self._ws = ws
    #       await self._receive_loop()
    #
    # BUT: the TUI wraps this in ``try/except Exception`` to catch
    # everything (including errors from __aexit__) and routes them to
    # ``_on_ws_close → _reconnect``.  We need to be at least as robust.
    #
    # Critical websockets v16 behaviour:
    #   ``async for raw in ws`` uses __aiter__ which catches
    #   ConnectionClosedOK (normal close, code 1000/1001) and silently
    #   returns — the loop just ends.  Only ConnectionClosedError
    #   (abnormal close) propagates.  This means a server-initiated clean
    #   shutdown makes _recv_loop() return *normally*, and we'd never
    #   know the connection died unless we explicitly detect it.
    #
    # We avoid ``async for`` entirely and call ``ws.recv()`` directly so
    # ALL close types are raised as exceptions.  We also avoid relying on
    # ``async with`` __aexit__ for cleanup because ``await ws.close()``
    # on an already-dead socket can block for up to close_timeout (10 s).
    # Instead we connect manually, set self._ws, run the recv loop, and
    # always nil self._ws in the finally block before reconnecting.

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            ws = None
            try:
                log.info("Connecting to %s …", WSS_URL)
                ws = await websockets.connect(WSS_URL)
                self._ws = ws
                backoff  = 1.0
                await self._auth()
                await self._recv_loop()
                # _recv_loop only returns if we add a non-exception exit
                # path in the future; treat it as a disconnect.
                log.info("_recv_loop returned normally — reconnecting")
            except asyncio.CancelledError:
                log.info("WS task cancelled — exiting _run()")
                return
            except Exception as exc:
                log.warning("Disconnected: %s  — retry in %.0fs", exc, backoff)
            finally:
                # Always nil the reference FIRST so MCP tools see
                # ``connected == False`` immediately, before we spend
                # time on the close handshake.
                self._ws = None
                if ws is not None:
                    try:
                        await asyncio.wait_for(ws.close(), timeout=2)
                    except BaseException:
                        # Catches CancelledError too — we must not let
                        # ws.close() override the caller's return/raise.
                        pass

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _auth(self) -> None:
        """Send the auth payload — identical to TUI client.py."""
        if self._token:
            payload = json.dumps({"token": self._token})
            log.info("Auth: token")
        elif self._username and self._password:
            payload = json.dumps({
                "credentials": {
                    "username": self._username,
                    "password": self._password,
                }
            })
            log.info("Auth: credentials (%s)", self._username)
        else:
            payload = json.dumps({})
            log.info("Auth: guest")
        await self._ws.send(payload)

    async def _recv_loop(self) -> None:
        """Read frames until the connection drops.

        Uses ``ws.recv()`` directly instead of ``async for raw in ws``
        because in websockets v16 the async iterator silently swallows
        ConnectionClosedOK (normal close, code 1000).  The TUI's
        _receive_loop does the same: it catches ConnectionClosed (the
        base class covering both OK and Error) and routes both to its
        reconnect handler.

        By calling recv() we get ConnectionClosedOK as an exception
        which propagates to _run()'s except clause → reconnect.
        """
        while True:
            raw = await self._ws.recv()
            if isinstance(raw, bytes):
                continue    # skip audio / cursor binary frames
            try:
                frame = json.loads(raw)
            except Exception:
                continue
            await self._dispatch(frame)

    # ── Event handling ────────────────────────────────────────────────

    async def _dispatch(self, frame: dict) -> None:
        ev   = frame.get("event", "")
        data = frame.get("data")

        if ev:
            await self._on_event(ev, data)
        elif "error" in frame:
            log.warning("Server error frame: %s", frame["error"])
        else:
            # Bare dict with no "event" key = server accepted our auth.
            # Mirrors TUI client.py _on_raw(): no "event" and no "error"
            # means connection-accepted.
            await self._on_accepted()

    async def _on_accepted(self) -> None:
        log.info("Connection accepted — joining room %d", DEFAULT_ROOM)
        await self._send_raw("message", f"/join {DEFAULT_ROOM}")

    async def _on_event(self, ev: str, data: Any) -> None:

        if ev == "set-user":
            self.user = data or {}
            log.info("Logged in as: %s (id=%s)",
                     self.user.get("username", "?"),
                     self.user.get("id", "?"))

        elif ev == "auth-token":
            # Server issues a fresh token after password login.
            if data:
                self._token    = data
                self._username = ""
                self._password = ""
                _save_token(data)

        elif ev == "room-list":
            self.rooms = data or []
            log.info("room-list: %d rooms received", len(self.rooms))

        elif ev == "join-room":
            self._current_room = data
            log.info("join-room: %s", data)
            # Request history now that we're in the room
            await self._send_raw("message", "/messagehistory")

        elif ev == "messages":
            # History batch — older messages prepended to the front
            if isinstance(data, list):
                added      = 0
                new_entries = []
                for m in data:
                    e = self._norm(m)
                    if e and e["id"] not in self._seen_ids:
                        new_entries.append(e)
                        self._seen_ids.add(e["id"])
                        added += 1
                self.messages = new_entries + self.messages
                self.messages = self.messages[-MAX_MESSAGES:]
                # Trim _seen_ids to prevent unbounded growth
                if len(self._seen_ids) > MAX_MESSAGES * 2:
                    self._seen_ids = {m["id"] for m in self.messages}
                if added:
                    log.info("History: +%d (total buffered: %d)",
                             added, len(self.messages))
            # Signal ready — we're connected, in a room, and have history
            if self._ready is not None:
                self._ready.set()

        elif ev == "message":
            # Live message arriving in real time
            e = self._norm(data)
            if e and e["id"] not in self._seen_ids:
                self.messages.append(e)
                self._seen_ids.add(e["id"])
                if len(self.messages) > MAX_MESSAGES:
                    removed = self.messages.pop(0)
                    self._seen_ids.discard(removed["id"])
                log.info("[room %s] <%s> %s",
                         e["room_id"], e["user"], e["content"][:100])

        elif ev == "message-edit":
            if isinstance(data, dict):
                mid = data.get("id")
                if mid:
                    new_content = _strip(
                        data.get("content") or data.get("formatted") or "")
                    for m in self.messages:
                        if m["id"] == mid and new_content:
                            m["content"] = new_content
                            break

        elif ev == "error":
            log.warning("Server event error: %s", data)

        # Silently ignore other events (typing-list, connected-list, etc.)

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _norm(m: Any) -> Optional[dict]:
        if not isinstance(m, dict):
            return None
        content = _strip(m.get("content") or m.get("formatted") or "")
        if not content:
            return None
        user_obj = m.get("user", {})
        username = (user_obj.get("username", "?")
                    if isinstance(user_obj, dict) else str(user_obj))
        room_id = m.get("room") if m.get("room") is not None else m.get("roomId")
        try:
            room_id = int(room_id) if room_id is not None else None
        except (TypeError, ValueError):
            room_id = None
        return {
            "id":      m.get("id", 0),
            "ts":      _parse_ts(m),
            "user":    username,
            "content": content,
            "room_id": room_id,
        }

    async def _send_raw(self, event: str, data: Any) -> None:
        """Send an event frame.  Mirrors TUI client.py _send_event()."""
        ws = self._ws
        if ws is None:
            log.warning("_send_raw: not connected, dropping %r %r", event, data)
            return
        try:
            await ws.send(json.dumps({"event": event, "data": data}))
        except ConnectionClosed:
            log.warning("_send_raw: connection lost while sending %r", event)
            self._ws = None
        except Exception as exc:
            log.warning("_send_raw: send failed: %s", exc)

    # ── API used by MCP tools ─────────────────────────────────────────

    def get_messages(self, room_id: Optional[int] = None,
                     limit: int = 50) -> list:
        msgs = (
            [m for m in self.messages if m["room_id"] == room_id]
            if room_id is not None
            else list(self.messages)
        )
        return msgs[-limit:]

    async def post(self, text: str, room_id: Optional[int] = None) -> None:
        if room_id is not None and room_id != self._current_room:
            await self._send_raw("message", f"/join {room_id}")
            await asyncio.sleep(0.5)
        await self._send_raw("message", text)

    async def join(self, room_id: int) -> None:
        await self._send_raw("message", f"/join {room_id}")
        await asyncio.sleep(0.5)
        await self._send_raw("message", "/messagehistory")

    async def history(self, before_id: Optional[int] = None) -> None:
        cmd = f"/messagehistory {before_id}" if before_id else "/messagehistory"
        await self._send_raw("message", cmd)

    @property
    def connected(self) -> bool:
        return self._ws is not None

    @property
    def username(self) -> str:
        return self.user.get("username", "*Guest")


# ── Singleton ─────────────────────────────────────────────────────────────────
_sc = SkyChat()


# ── MCP tools ─────────────────────────────────────────────────────────────────
mcp = FastMCP("skychat")


@mcp.tool()
async def read_messages(room_id: Optional[int] = None, limit: int = 30) -> str:
    """
    Return buffered chat messages. Messages accumulate live as people chat,
    so recent traffic is always available without a history fetch.

    Args:
        room_id: Filter by room ID. Omit to get all buffered messages.
        limit:   Max messages to return (1–200, default 30).
    """
    limit = max(1, min(limit, 200))
    msgs  = _sc.get_messages(room_id=room_id, limit=limit)
    if not msgs:
        return (
            "No messages buffered yet. "
            "They accumulate as people chat — try again shortly, "
            "or call fetch_history() to load older messages."
        )
    return "\n".join(
        f"[{m['ts']}] <{m['user']}> {m['content']}" for m in msgs
    )


@mcp.tool()
async def send_message(text: str, room_id: Optional[int] = None) -> str:
    """
    Send a chat message.

    Args:
        text:    Message content.
        room_id: Target room ID. Omit for the currently joined room.
    """
    if not text.strip():
        return "Error: message text is empty."
    if not _sc.connected:
        return "Error: not connected to SkyChat. Try again shortly."
    await _sc.post(text, room_id=room_id)
    return f"Sent: {text[:80]}"


@mcp.tool()
async def reply_to(message_id: int, reply_text: str,
                   room_id: Optional[int] = None) -> str:
    """
    Quote-reply to a specific message using @<id> syntax.

    Args:
        message_id: ID of the message to reply to.
        reply_text: Your reply.
        room_id:    Room (omit for current room).
    """
    if not _sc.connected:
        return "Error: not connected to SkyChat."
    await _sc.post(f"@{message_id} {reply_text}", room_id=room_id)
    return f"Replied to message {message_id}."


@mcp.tool()
async def list_rooms() -> str:
    """List all rooms the server has sent us."""
    if not _sc.rooms:
        return "No rooms known yet."
    lines = [
        f"  [{r.get('id')}] {'@' if r.get('isPrivate') else '#'} {r.get('name', '?')}"
        for r in _sc.rooms
    ]
    return "Rooms:\n" + "\n".join(lines)


@mcp.tool()
async def join_room(room_id: int) -> str:
    """Switch to a different room and fetch its history."""
    if not _sc.connected:
        return "Error: not connected to SkyChat."
    await _sc.join(room_id)
    return f"Joined room {room_id}."


@mcp.tool()
async def fetch_history(before_id: Optional[int] = None) -> str:
    """
    Request older messages from the server (limited for guests).

    Args:
        before_id: Fetch messages older than this message ID.
    """
    if not _sc.connected:
        return "Error: not connected to SkyChat."
    await _sc.history(before_id=before_id)
    await asyncio.sleep(1.5)
    return f"{len(_sc.messages)} messages buffered."


@mcp.tool()
async def status() -> str:
    """Connection status, username, and buffer stats."""
    return (
        f"Username:     {_sc.username}\n"
        f"Connected:    {_sc.connected}\n"
        f"Current room: {_sc._current_room}\n"
        f"Buffered:     {len(_sc.messages)} messages\n"
        f"Rooms:        {len(_sc.rooms)} known"
    )


@mcp.tool()
async def logout() -> str:
    """Clear the saved auth token. Restart the server to log in again."""
    _clear_token()
    return "Token cleared. Restart skychat_mcp.py to log in with new credentials."


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    from starlette.middleware.cors import CORSMiddleware

    # ── Parse args ────────────────────────────────────────────────────
    guest = "--guest" in sys.argv
    http  = "--http"  in sys.argv
    port  = 8765
    for arg in sys.argv:
        if arg.startswith("--port="):
            port = int(arg.split("=", 1)[1])

    # ── Resolve credentials BEFORE uvicorn (stdin still available) ────
    # We don't connect here — just figure out what credentials to use.
    # The actual WS connection happens inside uvicorn's event loop via
    # the lifespan handler, so the background task lives in the right
    # loop and won't be killed.
    _auth_kwargs: dict = {}

    if guest:
        log.info("--guest: will connect anonymously")
        _auth_kwargs = {"guest": True}
    else:
        token = _load_token()
        if token:
            log.info("Found saved token — will attempt resume")
            _auth_kwargs = {"token": token}
        else:
            username, password = _prompt_login()
            if username:
                _auth_kwargs = {"username": username, "password": password}
            else:
                _auth_kwargs = {"guest": True}

    # ── Build the MCP app, then wrap it with our own lifespan ─────────
    #
    # CRITICAL FIX: The MCP SDK's streamable_http_app() and sse_app()
    # both IGNORE mcp.settings.lifespan — they hardcode their own.
    # So we can't use mcp.settings.lifespan to start our WS task.
    #
    # Instead we:
    #   1. Let FastMCP build its Starlette app normally
    #   2. Wrap it in a NEW Starlette app that has OUR lifespan
    #   3. Our lifespan starts the WS task in uvicorn's loop
    #
    # This way the background _run() task is created inside uvicorn's
    # event loop and lives for the entire process lifetime — exactly
    # like how the TUI's main.py does:
    #   conn_task = asyncio.create_task(client.connect())

    mcp.settings.host           = "0.0.0.0"
    mcp.settings.port           = port
    mcp.settings.stateless_http = True

    if http:
        log.info("Transport: streamable-http  →  http://localhost:%d/mcp", port)
        inner_app = mcp.streamable_http_app()
    else:
        log.info("Transport: SSE  →  http://localhost:%d/sse", port)
        inner_app = mcp.sse_app()

    # ── CORS for llama.cpp web UI and other browser-based clients ─────
    inner_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    # ── Wrap the MCP app with our own lifespan ──────────────────────
    #
    # We build a thin ASGI wrapper that:
    #   1. Intercepts the "lifespan" ASGI events to start/stop our WS task
    #   2. Forwards ALL other ASGI events (http, websocket) to the inner
    #      MCP app unchanged — no Route remapping needed
    #
    # The inner MCP app has its own lifespan handler (session manager).
    # We chain them: our startup runs first, then we forward the lifespan
    # protocol to the inner app so its own startup/shutdown also runs.

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            # We need to run our WS startup, AND forward lifespan to the
            # inner app so MCP's session manager also initialises.
            #
            # ASGI lifespan protocol:
            #   receive → {"type": "lifespan.startup"}
            #   send    ← {"type": "lifespan.startup.complete"}
            #   receive → {"type": "lifespan.shutdown"}
            #   send    ← {"type": "lifespan.shutdown.complete"}

            msg = await receive()
            assert msg["type"] == "lifespan.startup"

            # Start our WebSocket background task
            log.info("Lifespan startup: connecting WebSocket in uvicorn's loop")
            try:
                await _sc.start(**_auth_kwargs)
                log.info("WebSocket connected as: %s", _sc.username)
            except RuntimeError as exc:
                if _auth_kwargs.get("token"):
                    log.warning("Token auth failed (%s) — retrying as guest", exc)
                    _clear_token()
                    try:
                        await _sc.start(guest=True)
                    except Exception as exc2:
                        await send({"type": "lifespan.startup.failed",
                                    "message": str(exc2)})
                        return
                else:
                    await send({"type": "lifespan.startup.failed",
                                "message": str(exc)})
                    return

            # Now forward the full lifespan protocol to the inner MCP app
            # so its session manager starts up too.  We use an asyncio.Task
            # to run the inner app's lifespan handler concurrently.
            inner_shutdown_trigger = asyncio.Event()
            inner_done = asyncio.Event()
            _inner_startup_sent = False

            async def inner_receive():
                """Feed lifespan events to the inner app."""
                nonlocal _inner_startup_sent
                if not _inner_startup_sent:
                    _inner_startup_sent = True
                    return {"type": "lifespan.startup"}
                # Block until we get the real shutdown signal
                await inner_shutdown_trigger.wait()
                return {"type": "lifespan.shutdown"}

            async def inner_send(msg):
                """Capture inner app's lifespan responses."""
                if msg["type"] == "lifespan.shutdown.complete":
                    inner_done.set()

            inner_task = asyncio.create_task(
                inner_app({"type": "lifespan", "asgi": scope.get("asgi", {})},
                          inner_receive, inner_send),
                name="mcp-lifespan",
            )

            # Tell the server we're ready
            await send({"type": "lifespan.startup.complete"})

            # Wait for shutdown signal
            msg = await receive()
            assert msg["type"] == "lifespan.shutdown"

            # Shut down our WS task
            log.info("Lifespan shutdown: stopping WebSocket")
            await _sc.stop()

            # Signal the inner app to shut down too
            inner_shutdown_trigger.set()
            try:
                await asyncio.wait_for(inner_task, timeout=5)
            except (asyncio.TimeoutError, Exception):
                inner_task.cancel()

            await send({"type": "lifespan.shutdown.complete"})

        else:
            # HTTP / WebSocket requests — pass through to MCP app unchanged
            await inner_app(scope, receive, send)

    uvicorn.run(app, host="0.0.0.0", port=port)