# skychat-mcp

An MCP server that connects [skych.at](https://skych.at) chat to any MCP client (Claude Code, llama.cpp web UI, etc.).

The WebSocket stays open in the background, buffering live messages as they arrive. The LLM reads from and writes to that buffer — no polling.

Built on top of the official [`skychat`](https://www.npmjs.com/package/skychat) npm package and the [Model Context Protocol TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

---

## use with Claude Code

**1. Register the server** (one-time, from any directory where you launch `claude`):

```bash
claude mcp add skychat -- npx -y skychat-mcp@latest --guest
```

Add `-s user` to make it available in every project. Confirm with:

```bash
$ claude mcp list
skychat: npx -y skychat-mcp@latest --guest - ✓ Connected
```

**2. Use it.** Start a Claude Code session — there is no separate process to run, Claude Code spawns the server itself. The tools (`read_messages`, `send_message`, `reply_to`, …) appear automatically. Talk to Claude in plain English:

> "What are people saying in skychat right now?"
>
> "Send 'hello from Claude Code' to the general room."
>
> "Reply to message 12345 with a thumbs up."
>
> "Switch to the IT room and summarise the last 30 messages."

**3. Log in with an account** (optional — guest works but has limited history):

```bash
claude mcp add \
    -e SKYCHAT_USERNAME=alice \
    -e SKYCHAT_PASSWORD=hunter2 \
    skychat -- npx -y skychat-mcp@latest
```

The first successful login saves a token to `~/.config/skychat-mcp/token.json` (chmod 0600), so you can drop the env vars after that.

---

## use with llama.cpp web UI

llama.cpp can't spawn a subprocess, so this one needs the HTTP transport, which you do run as a long-lived process:

```bash
npx -y skychat-mcp@latest --http --guest
```

In `llama-server` → **Settings → MCP** → add `http://localhost:8765/mcp`. Tools appear automatically. Then talk to the model in the web UI just like the Claude Code examples above.

---

## install

Requires **Node 18+**. You don't usually need a local install — `npx -y skychat-mcp@latest` works for both setups above. For the Claude Code setup you don't run anything manually at all: Claude Code spawns the server itself as a subprocess.

If you specifically want a global install (mainly useful for running the long-lived HTTP/SSE servers for browser-based clients):

```bash
npm install -g skychat-mcp
skychat-mcp --http --port=8765       # streamable HTTP
skychat-mcp --sse --port=8765        # legacy SSE
```

---

## auth

Resolved on startup in this order:

| Priority | Source | Notes |
|---|---|---|
| 1 | `--guest` flag | anonymous, no prompt |
| 2 | `SKYCHAT_TOKEN` env var | JSON or string token |
| 3 | `~/.config/skychat-mcp/token.json` | saved after a successful login |
| 4 | `SKYCHAT_USERNAME` + `SKYCHAT_PASSWORD` env vars | new login, token gets saved |
| 5 | fallback | guest |

There is no interactive prompt — env vars are the only way to log in. This keeps the server safe to spawn over stdio (the recommended Claude Code setup).

To log out: call the `logout` tool, or delete the token file. The next start with no `SKYCHAT_*` env vars falls back to guest.

---

## tools

| Tool | Description |
|---|---|
| `read_messages` | Return buffered messages. `room_id` filters, `limit` caps count (default 30, max 200). |
| `send_message` | Send a message. Optional `room_id`. |
| `reply_to` | Quote-reply to a message by its ID using `@<id>` syntax. |
| `list_rooms` | List all rooms the server knows about. |
| `join_room` | Switch to a different room by numeric ID. |
| `fetch_history` | Ask the server for older messages (limited for guests). |
| `status` | Connection status, username, buffer stats. |
| `logout` | Clear the saved auth token. Restart the server to log in again. |

---

## auto-reply bot

Pass `--auto-reply` to have the server respond automatically whenever the bot account is @mentioned. The LLM receives the mention, calls tools (`reply_to`, `send_message`, `join_room`, `read_messages`) until it's satisfied, then stops.

```bash
npx -y skychat-mcp@latest --http --auto-reply
npx -y skychat-mcp@latest --http --auto-reply --llm-url=http://localhost:8080
npx -y skychat-mcp@latest --http --auto-reply --system-prompt="You are a pirate."
npx -y skychat-mcp@latest --http --auto-reply --system-prompt-file=prompt.txt
```

| Flag | Default | Description |
|---|---|---|
| `--auto-reply` | off | Enable the mention→LLM loop |
| `--llm-url=URL` | `http://localhost:8080` | Base URL of an OpenAI-compatible API (`/v1/chat/completions`) |
| `--system-prompt=TEXT` | brief helpful-assistant prompt | System prompt sent to the LLM |
| `--system-prompt-file=PATH` | — | Read system prompt from a file instead |

The LLM must support OpenAI-style function/tool calling. `llama-server` works out of the box with a tool-capable model. Mentions are processed serially — extras are dropped if the queue fills (cap 2) to avoid flooding chat.

---

## environment variables

| Variable | Default | Description |
|---|---|---|
| `SKYCHAT_URL` | `wss://skych.at/api/ws` | WebSocket URL — override for self-hosted instances |
| `SKYCHAT_TOKEN` | — | Resume with a previously issued token (JSON or string) |
| `SKYCHAT_USERNAME` | — | Username for fresh login |
| `SKYCHAT_PASSWORD` | — | Password for fresh login |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for token storage |

---

## development

```bash
git clone https://github.com/skychatorg/skychat-mcp.git
cd skychat-mcp
npm install
npm run build
npm start -- --guest --http
```

Other scripts: `npm run dev` (watch mode via tsx), `npm run lint`, `npm run lint-fix`.

---

## notes

- Guests can read messages and join rooms, but history is very limited. Log in for full access.
- Buffer holds the last **500 messages** across all rooms; oldest are dropped at the cap.
- Default transport is **stdio**, which is what Claude Code expects and the most efficient. `--http` and `--sse` exist for browser-based clients like llama-server.

---

## license

WTFPL — Do What the Fuck You Want to Public License.
