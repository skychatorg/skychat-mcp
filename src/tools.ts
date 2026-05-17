import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SkyChat } from './skychat.js';
import { clearToken } from './auth.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function registerTools(server: McpServer, sc: SkyChat): void {

    server.registerTool('read_messages', {
        description:
            'Return buffered chat messages. Messages accumulate live as people chat, so '
            + 'recent traffic is always available without a history fetch.',
        inputSchema: {
            room_id: z.number().int().nullable().optional()
                .describe('Filter by room ID. Omit to get all buffered messages.'),
            limit: z.number().int().min(1).max(200).default(30)
                .describe('Max messages to return (1-200).'),
        },
    }, async ({ room_id, limit }) => {
        const msgs = sc.getMessages(room_id ?? null, limit);
        if (msgs.length === 0) {
            return text(
                'No messages buffered yet. They accumulate as people chat — try again shortly, '
                + 'or call fetch_history() to load older messages.',
            );
        }
        return text(msgs.map((m) => `[${m.ts}] <${m.user}> ${m.content}`).join('\n'));
    });

    server.registerTool('send_message', {
        description: 'Send a chat message.',
        inputSchema: {
            text: z.string().describe('Message content.'),
            room_id: z.number().int().nullable().optional()
                .describe('Target room ID. Omit for the currently joined room.'),
        },
    }, async ({ text: body, room_id }) => {
        if (!body.trim()) {
            return text('Error: message text is empty.');
        }
        if (!sc.connected) {
            return text('Error: not connected to SkyChat. Try again shortly.');
        }
        await sc.post(body, room_id ?? null);
        return text(`Sent: ${body.slice(0, 80)}`);
    });

    server.registerTool('reply_to', {
        description: 'Quote-reply to a specific message using @<id> syntax.',
        inputSchema: {
            message_id: z.number().int().describe('ID of the message to reply to.'),
            reply_text: z.string().describe('Your reply.'),
            room_id: z.number().int().nullable().optional()
                .describe('Room (omit for current room).'),
        },
    }, async ({ message_id, reply_text, room_id }) => {
        if (!sc.connected) {
            return text('Error: not connected to SkyChat.');
        }
        await sc.post(`@${message_id} ${reply_text}`, room_id ?? null);
        return text(`Replied to message ${message_id}.`);
    });

    server.registerTool('list_rooms', {
        description: 'List all rooms the server has sent us.',
        inputSchema: {},
    }, async () => {
        const rooms = sc.getRooms();
        if (rooms.length === 0) {
            return text('No rooms known yet.');
        }
        const lines = rooms.map((r) => `  [${r.id}] ${r.isPrivate ? '@' : '#'} ${r.name ?? '?'}`);
        return text('Rooms:\n' + lines.join('\n'));
    });

    server.registerTool('join_room', {
        description: 'Switch to a different room and fetch its history.',
        inputSchema: {
            room_id: z.number().int().describe('Room ID to join.'),
        },
    }, async ({ room_id }) => {
        if (!sc.connected) {
            return text('Error: not connected to SkyChat.');
        }
        await sc.join(room_id);
        return text(`Joined room ${room_id}.`);
    });

    server.registerTool('fetch_history', {
        description: 'Request older messages from the server (limited for guests).',
        inputSchema: {
            before_id: z.number().int().nullable().optional()
                .describe('Fetch messages older than this message ID.'),
        },
    }, async ({ before_id }) => {
        if (!sc.connected) {
            return text('Error: not connected to SkyChat.');
        }
        await sc.fetchHistory(before_id ?? null);
        const { buffered } = sc.bufferStats();
        return text(`${buffered} messages buffered.`);
    });

    server.registerTool('status', {
        description: 'Connection status, username, and buffer stats.',
        inputSchema: {},
    }, async () => {
        const { buffered, rooms } = sc.bufferStats();
        return text(
            `Username:     ${sc.username}\n`
            + `Connected:    ${sc.connected ? 'True' : 'False'}\n`
            + `Current room: ${sc.currentRoomId}\n`
            + `Buffered:     ${buffered} messages\n`
            + `Rooms:        ${rooms} known`,
        );
    });

    server.registerTool('logout', {
        description: 'Clear the saved auth token. Restart the server to log in again.',
        inputSchema: {},
    }, async () => {
        clearToken();
        return text('Token cleared. Restart skychat-mcp to log in with new credentials.');
    });
}
