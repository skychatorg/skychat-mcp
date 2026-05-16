#!/usr/bin/env node
// Stdio MCP demands a clean stdout: only JSON-RPC frames may go there. The
// upstream `skychat` SDK calls `console.info(...)` on server info/error
// events, which Node routes to stdout. Redirect both `console.log` and
// `console.info` to stderr *before* importing anything that might pull
// `skychat` in.
console.log = console.error;
console.info = console.error;

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SkyChat } from './skychat.js';
import { resolveAuth } from './auth.js';
import { registerTools } from './tools.js';
import { startAutoReply, parseAutoReplyArgs } from './auto-reply.js';

interface Args {
    transport: 'stdio' | 'http' | 'sse';
    port: number;
    guest: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        transport: 'stdio',
        port: 8765,
        guest: argv.includes('--guest'),
    };
    if (argv.includes('--http')) {
        args.transport = 'http';
    } else if (argv.includes('--sse')) {
        args.transport = 'sse';
    } else if (argv.includes('--stdio')) {
        args.transport = 'stdio';
    }
    for (const a of argv) {
        if (a.startsWith('--port=')) {
            args.port = Number(a.slice('--port='.length));
        }
    }
    return args;
}

function usage(): void {
    process.stdout.write(`\
skychat-mcp - MCP server for skych.at chat

Usage:
  skychat-mcp [options]

Transport (default: stdio):
  --stdio                Speak MCP on stdin/stdout (best for Claude Code)
  --http                 Streamable HTTP server on /mcp
  --sse                  SSE server on /sse
  --port=N               Port for --http or --sse (default 8765)

Auth (resolved in order):
  --guest                Skip auth and join as guest
  SKYCHAT_TOKEN env var  Resume with a saved auth token (JSON or string)
  ~/.config/skychat-mcp/token.json  Last saved token from a successful login
  SKYCHAT_USERNAME + SKYCHAT_PASSWORD env vars  Username/password login
  fallback               Guest

Misc:
  SKYCHAT_URL env var    Override the WebSocket URL (default wss://skych.at/api/ws)

Auto-reply bot (optional):
  --auto-reply           Respond when the bot is @mentioned
  --llm-url=URL          OpenAI-compatible API base (default http://localhost:8080)
  --system-prompt=TEXT   Override the LLM system prompt
  --system-prompt-file=PATH  Read system prompt from a file

  -h, --help             Show this help
`);
}

async function main() {
    if (process.argv.includes('-h') || process.argv.includes('--help')) {
        usage();
        return;
    }

    const args = parseArgs(process.argv.slice(2));
    const auth = resolveAuth({ guest: args.guest });

    // Logging goes to stderr so stdio transport stays clean for MCP frames.
    console.error(`skychat-mcp: transport=${args.transport} auth=${auth.kind}`);

    const sc = new SkyChat();
    await sc.start(auth);
    console.error(`skychat-mcp: connected as ${sc.username}`);

    const autoReplyCfg = parseAutoReplyArgs(process.argv.slice(2));
    if (autoReplyCfg.enabled) {
        console.error(`skychat-mcp: auto-reply enabled (LLM: ${autoReplyCfg.llmUrl})`);
        startAutoReply(sc, autoReplyCfg);
    }

    const shutdown = async () => {
        await sc.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (args.transport === 'stdio') {
        const server = new McpServer({ name: 'skychat', version: '0.1.0' });
        registerTools(server, sc);
        await server.connect(new StdioServerTransport());
        return;
    }

    if (args.transport === 'http') {
        // Stateless: one MCP server per request keeps the binding simple.
        // The SkyChat instance is shared across requests, so all sessions see
        // the same buffer and same authenticated identity.
        const httpServer = createServer(async (req, res) => {
            const server = new McpServer({ name: 'skychat', version: '0.1.0' });
            registerTools(server, sc);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            const cleanup = () => {
                try {
                    transport.close();
                } catch {
                    // ignore
                }
                try {
                    server.close();
                } catch {
                    // ignore
                }
            };
            res.on('close', cleanup);
            try {
                await server.connect(transport);
                await transport.handleRequest(req, res);
            } catch (err) {
                console.error('skychat-mcp: http request error:', err);
                cleanup();
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.end();
                }
            }
        });
        httpServer.listen(args.port, () => {
            console.error(`skychat-mcp: streamable-http on http://localhost:${args.port}/mcp`);
        });
        return;
    }

    if (args.transport === 'sse') {
        const transports = new Map<string, SSEServerTransport>();
        const httpServer = createServer(async (req, res) => {
            if (req.method === 'GET' && req.url?.startsWith('/sse')) {
                const server = new McpServer({ name: 'skychat', version: '0.1.0' });
                registerTools(server, sc);
                const transport = new SSEServerTransport('/messages', res);
                transports.set(transport.sessionId, transport);
                res.on('close', () => {
                    transports.delete(transport.sessionId);
                });
                await server.connect(transport);
                return;
            }
            if (req.method === 'POST' && req.url?.startsWith('/messages')) {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const id = url.searchParams.get('sessionId');
                const t = id ? transports.get(id) : undefined;
                if (!t) {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                await t.handlePostMessage(req, res);
                return;
            }
            res.statusCode = 404;
            res.end();
        });
        httpServer.listen(args.port, () => {
            console.error(`skychat-mcp: sse on http://localhost:${args.port}/sse`);
        });
        return;
    }
}

main().catch((err) => {
    console.error('skychat-mcp fatal:', err);
    process.exit(1);
});
