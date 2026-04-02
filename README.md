# skychat-mcp

A lightweight MCP server that connects a local LLM to [skych.at](https://skych.at) chat.

The WebSocket connection runs permanently in the background, buffering live messages as they arrive. Your LLM reads from and writes to that buffer — no polling, no blocking on network calls.

Tested with [llama.cpp](https://github.com/ggerganov/llama.cpp) web UI (`llama-server`).

---

## requirements

- Python 3.10+
- `pip install websockets mcp uvicorn`

---

## install

```bash
git clone <your-repo>
cd skychat-mcp
pip install websockets mcp uvicorn
```

---

## usage

```bash
# streamable-http — what llama.cpp web UI expects
python skychat_mcp.py --http

# SSE transport
python skychat_mcp.py --sse

# skip login, connect as guest (read-only, limited history)
python skychat_mcp.py --guest --http

# different port
python skychat_mcp.py --http --port=9000

# self-hosted instance
SKYCHAT_URL=wss://chat.example.com/api/ws python skychat_mcp.py --http

# auto-reply bot: LLM responds when @mentioned
python skychat_mcp.py --http --auto-reply
python skychat_mcp.py --http --auto-reply --llm-url=http://localhost:8080
python skychat_mcp.py --http --auto-reply --system-prompt="You are a pirate."
python skychat_mcp.py --http --auto-reply --system-prompt-file=prompt.txt
```

### connecting llama.cpp web UI

1. Start the MCP server: `python skychat_mcp.py --http`
2. Open `http://localhost:8080` (your llama-server)
3. Go to **Settings → MCP**
4. Add server URL: `http://localhost:8765/mcp`
5. Save — the tools will appear automatically

---

## auth

On startup, auth is resolved in this order:

| Priority | Method | How |
|----------|--------|-----|
| 1 | `--guest` flag | anonymous, no prompt |
| 2 | Saved token | loaded from `~/.config/skychat-mcp/token.json` |
| 3 | Interactive prompt | enter username/password on the terminal |

After a successful password login, the server saves the token for next time so you won't be prompted again.

Token is stored in **`~/.config/skychat-mcp/token.json`** — deliberately separate from skychat-tui's token at `~/.config/skychat/token.json` so the two don't interfere.

To log out: call the `logout` tool, or delete `~/.config/skychat-mcp/token.json`, then restart.

---

## tools

| Tool | Description |
|------|-------------|
| `read_messages` | Return buffered messages. Pass `room_id` to filter, `limit` for count (default 30). |
| `send_message` | Send a message. Optionally specify `room_id`. |
| `reply_to` | Quote-reply to a message by its ID using `@<id>` syntax. |
| `list_rooms` | List all rooms the server has sent us. |
| `join_room` | Switch to a different room by numeric ID. |
| `fetch_history` | Ask the server for older messages (limited for guests). |
| `status` | Connection status, username, buffer stats. |
| `logout` | Clear the saved token. Restart the server to log in again. |

### example LLM prompts

> "Read the last 20 messages from the general chat."

> "Send 'Hello everyone!' to room 0."

> "What are people talking about in the chat right now? Summarise it."

> "Reply to message 12345 saying thanks for the info."

---

## auto-reply bot

Pass `--auto-reply` to have the server respond automatically whenever the bot account is @mentioned. It runs a small agentic loop: the LLM receives the mention, can call tools (`reply_to`, `send_message`, `join_room`, `read_messages`) until it's satisfied, then stops.

```bash
python skychat_mcp.py --http --auto-reply
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--auto-reply` | off | Enable the mention→LLM loop |
| `--llm-url=URL` | `http://localhost:8080` | Base URL of the OpenAI-compatible API (`/v1/chat/completions`) |
| `--system-prompt=TEXT` | a brief helpful-assistant prompt | System prompt sent to the LLM |
| `--system-prompt-file=PATH` | — | Read system prompt from a file instead |

The LLM must support OpenAI-style function/tool calling. llama.cpp (`llama-server`) works out of the box if the model has tool-call support.

Only one mention is processed at a time — if another arrives while the agent is running it is skipped to avoid flooding the chat.

---

## how it works

```
startup:
  1. Validate credentials (prompt / token / guest)
  2. Connect to wss://skych.at/api/ws
  3. Receive room-list, join room 0, fetch history
  4. Start uvicorn — WebSocket task runs inside its event loop

while running:
  • Live messages buffer automatically as they arrive
  • LLM calls read_messages → reads from the buffer (instant)
  • LLM calls send_message → writes to the WebSocket
  • On disconnect: exponential backoff reconnect, re-auth with saved token
```

Auth wire format matches the skychat-tui client exactly:

```json
// guest
{}

// credentials
{"credentials": {"username": "alice", "password": "hunter2"}}

// token resume
{"token": <token object from server>}
```

---

## environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYCHAT_URL` | `wss://skych.at/api/ws` | WebSocket URL — override for self-hosted instances |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for config/token storage |

---

## files

| Path | Contents |
|------|----------|
| `~/.config/skychat-mcp/token.json` | Saved auth token (chmod 0o600) |

---

## notes

- **Guests** can read messages and join rooms, but history is very limited — the server only sends what's in the recent window. Log in for full access.
- The server must be **restarted** to switch accounts. Call `logout` first to clear the token, then restart and enter new credentials at the prompt.
- Message buffer holds the last **500 messages** across all rooms. Oldest are dropped when the limit is reached.
- The `SKYCHAT_URL` environment variable works the same way as in skychat-tui.

---

## license

WTFPL — Do What the Fuck You Want to Public License.
