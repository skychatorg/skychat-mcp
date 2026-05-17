import { readFileSync } from 'node:fs';
import type { BufferedMessage, SkyChat } from './skychat.js';

export interface AutoReplyConfig {
    enabled: boolean;
    llmUrl: string;
    systemPrompt: string;
}

interface ToolCall {
    id: string;
    function: { name: string; arguments: string };
}

interface LlmMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

// OpenAI-style tool definitions mirror the MCP tools.
const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'reply_to',
            description: 'Quote-reply to a specific message by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    message_id: { type: 'integer', description: 'ID of the message to reply to.' },
                    reply_text: { type: 'string', description: 'Your reply text.' },
                    room_id: { type: 'integer', description: 'Room containing the message (omit if already joined).' },
                },
                required: ['message_id', 'reply_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_message',
            description: 'Send a plain message to a room.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Message content.' },
                    room_id: { type: 'integer', description: 'Target room ID (omit for current room).' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'join_room',
            description: 'Switch to a different room.',
            parameters: {
                type: 'object',
                properties: {
                    room_id: { type: 'integer', description: 'Room ID to join.' },
                },
                required: ['room_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_messages',
            description: 'Return recent buffered messages from a room.',
            parameters: {
                type: 'object',
                properties: {
                    room_id: { type: 'integer', description: 'Filter by room ID.' },
                    limit: { type: 'integer', description: 'Max messages to return (1-200, default 30).' },
                },
                required: [],
            },
        },
    },
] as const;

export function parseAutoReplyArgs(argv: string[]): {
    enabled: boolean;
    llmUrl: string;
    systemPrompt: string;
} {
    const enabled = argv.includes('--auto-reply');
    let llmUrl = 'http://localhost:8080';
    let systemPrompt = 'You are a helpful, concise chat participant. Reply briefly.';

    for (const arg of argv) {
        if (arg.startsWith('--llm-url=')) {
            llmUrl = arg.slice('--llm-url='.length);
        } else if (arg.startsWith('--system-prompt=')) {
            systemPrompt = arg.slice('--system-prompt='.length);
        } else if (arg.startsWith('--system-prompt-file=')) {
            systemPrompt = readFileSync(arg.slice('--system-prompt-file='.length), 'utf-8').trim();
        }
    }

    return { enabled, llmUrl, systemPrompt };
}

async function executeAgentTool(sc: SkyChat, name: string, args: any): Promise<string> {
    switch (name) {
        case 'reply_to':
            if (!sc.connected) {
                return 'Error: not connected.';
            }
            await sc.post(`@${args.message_id} ${args.reply_text}`, args.room_id ?? null);
            return `Replied to message ${args.message_id}.`;

        case 'send_message':
            if (!sc.connected) {
                return 'Error: not connected.';
            }
            await sc.post(args.text, args.room_id ?? null);
            return 'Sent.';

        case 'join_room':
            await sc.join(args.room_id);
            return `Joined room ${args.room_id}.`;

        case 'read_messages': {
            const msgs = sc.getMessages(args.room_id ?? null, args.limit ?? 30);
            if (msgs.length === 0) {
                return 'No messages buffered.';
            }
            return msgs
                .map((m) => `[${m.ts}] id=${m.id} <${m.user}> ${m.content}`)
                .join('\n');
        }

        default:
            return `Unknown tool: ${name}`;
    }
}

async function runAgent(
    sc: SkyChat,
    cfg: AutoReplyConfig,
    initialMessages: LlmMessage[],
    maxRounds = 10,
): Promise<void> {
    const url = cfg.llmUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    const messages: LlmMessage[] = [...initialMessages];

    for (let round = 0; round < maxRounds; round++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);

        let result: any;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages,
                    tools: AGENT_TOOLS,
                    tool_choice: 'auto',
                    max_tokens: 512,
                    temperature: 0.7,
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`LLM HTTP ${res.status}`);
            }
            result = await res.json();
        } catch (exc) {
            console.error(`skychat-mcp: auto-reply LLM request failed (round ${round}):`, exc);
            return;
        } finally {
            clearTimeout(timer);
        }

        const message = result.choices?.[0]?.message;
        if (!message) {
            return;
        }
        messages.push(message);

        const toolCalls: ToolCall[] = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
            console.error(`skychat-mcp: auto-reply agent done after ${round + 1} round(s)`);
            return;
        }

        for (const tc of toolCalls) {
            let args: any = {};
            try {
                args = JSON.parse(tc.function.arguments || '{}');
            } catch {
                // ignore parse errors
            }
            const toolResult = await executeAgentTool(sc, tc.function.name, args);
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolResult,
            });
        }
    }
    console.error('skychat-mcp: auto-reply hit max rounds, stopping');
}

export function startAutoReply(sc: SkyChat, cfg: AutoReplyConfig): void {
    if (!cfg.enabled) {
        return;
    }

    // Serial queue: process one mention at a time; drop extras when full.
    const queue: BufferedMessage[] = [];
    let working = false;

    const drain = async () => {
        if (working) {
            return;
        }
        working = true;
        try {
            while (queue.length > 0) {
                const msg = queue.shift() as BufferedMessage;
                const initial: LlmMessage[] = [
                    { role: 'system', content: cfg.systemPrompt },
                    {
                        role: 'user',
                        content:
                            `You (@${sc.username}) were mentioned by <${msg.user}> in room ${msg.roomId}.\n`
                            + `Message ID: ${msg.id}\n`
                            + `Their message: ${msg.content}\n\n`
                            + 'Use your tools to join the correct room (if needed) and reply to that message ID.',
                    },
                ];
                await runAgent(sc, cfg, initial);
            }
        } finally {
            working = false;
        }
    };

    sc.setMentionHandler((msg) => {
        if (queue.length >= 2) {
            console.error(`skychat-mcp: auto-reply queue full, dropping mention from <${msg.user}>`);
            return;
        }
        queue.push(msg);
        drain();
    });
}
