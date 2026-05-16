# skychat-mcp

A lightweight MCP server that exposes [skych.at](https://skych.at) chat to any MCP client (Claude Code, llama.cpp web UI, etc.).

The WebSocket connection runs permanently in the background, buffering live messages as they arrive. The LLM reads from and writes to that buffer — no polling, no blocking on network calls.

---

## requirements

- Python 3.10+
- `pip install websockets mcp uvicorn`

---

## install

```bash
git clone https://github.com/skychatorg/skychat-mcp.git
cd skychat-mcp
pip install websockets mcp uvicorn
```

---

## run the server

```bash
# streamable-http (default for Claude Code and llama.cpp web UI)
python skychat_mcp.py --http

# SSE transport
python skychat_mcp.py --sse

# guest session, no login prompt (read-only, limited history)
python skychat_mcp.py --http --guest

# custom port
python skychat_mcp.py --http --port=9000

# self-hosted skychat instance
SKYCHAT_URL=wss://chat.example.com/api/ws python skychat_mcp.py --http
```

On first run you'll be prompted for username/password (or press Enter for guest). The token is saved to `~/.config/skychat-mcp/token.json` and reused next time.

---

## use with Claude Code

Start the MCP server in a terminal first — the login prompt only appears here, not inside Claude Code:

```bash
python skychat_mcp.py --http
```

Then, from the project where you want to use skychat (any directory you'd normally launch `claude` from), register the server:

```bash
claude mcp add --transport http skychat http://localhost:8765/mcp
```

`claude mcp add` defaults to `local` scope (private to you, scoped to this project). Add `-s user` to make it visible from any project, or `-s project` to commit a shared `.mcp.json` for your team. Verify the connection:

```bash
$ claude mcp list
skychat: http://localhost:8765/mcp (HTTP) - ✓ Connected
```

Inside a Claude Code session, the tools (`read_messages`, `send_message`, `reply_to`, …) appear automatically. Try:

> "Read the last 20 messages from skychat and tell me what people are discussing."
>
> "Send 'Hi from Claude Code' to room 0."

To remove the server: `claude mcp remove skychat`.

---

## use with llama.cpp web UI

1. Start the MCP server: `python skychat_mcp.py --http`
2. Open `http://localhost:8080` (your `llama-server`)
3. **Settings → MCP** → add server URL `http://localhost:8765/mcp`
4. Save — tools appear automatically.

---

## tools

| Tool | Description |
|------|-------------|
| `read_messages` | Return buffered messages. `room_id` filters, `limit` caps count (default 30). |
| `send_message` | Send a message. Optional `room_id`. |
| `reply_to` | Quote-reply to a message by its ID using `@<id>` syntax. |
| `list_rooms` | List all rooms the server has sent us. |
| `join_room` | Switch to a different room by numeric ID. |
| `fetch_history` | Ask the server for older messages (limited for guests). |
| `status` | Connection status, username, buffer stats. |
| `logout` | Clear the saved token. Restart the server to log in again. |

---

## auth

Resolved on startup in this order:

| Priority | Method | How |
|----------|--------|-----|
| 1 | `--guest` flag | anonymous, no prompt |
| 2 | Saved token | loaded from `~/.config/skychat-mcp/token.json` |
| 3 | Interactive prompt | enter username/password on the terminal |

Token storage is deliberately separate from skychat-tui (`~/.config/skychat/token.json`) so the two don't interfere. To log out: call the `logout` tool or delete the token file, then restart.

---

## auto-reply bot

Pass `--auto-reply` to have the server respond automatically whenever the bot account is @mentioned. The LLM receives the mention, calls tools (`reply_to`, `send_message`, `join_room`, `read_messages`) until it's satisfied, then stops.

```bash
python skychat_mcp.py --http --auto-reply
python skychat_mcp.py --http --auto-reply --llm-url=http://localhost:8080
python skychat_mcp.py --http --auto-reply --system-prompt="You are a pirate."
python skychat_mcp.py --http --auto-reply --system-prompt-file=prompt.txt
```

| Flag | Default | Description |
|------|---------|-------------|
| `--auto-reply` | off | Enable the mention→LLM loop |
| `--llm-url=URL` | `http://localhost:8080` | Base URL of an OpenAI-compatible API (`/v1/chat/completions`) |
| `--system-prompt=TEXT` | brief helpful-assistant prompt | System prompt sent to the LLM |
| `--system-prompt-file=PATH` | — | Read system prompt from a file instead |

The LLM must support OpenAI-style function/tool calling. `llama-server` works out of the box with a tool-capable model. Mentions are processed serially — extras are dropped if the queue fills (cap 2) to avoid flooding chat.

---

## environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYCHAT_URL` | `wss://skych.at/api/ws` | WebSocket URL — override for self-hosted instances |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for config/token storage |

---

## notes

- Guests can read messages and join rooms, but history is very limited. Log in for full access.
- Restart the server to switch accounts: call `logout`, then restart and enter new credentials.
- Buffer holds the last **500 messages** across all rooms; oldest are dropped at the cap.

---

## license

WTFPL — Do What the Fuck You Want to Public License.
