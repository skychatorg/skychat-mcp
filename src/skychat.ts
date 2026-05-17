import { SkyChatClient } from 'skychat';
import { AuthMethod, clearToken, saveToken } from './auth.js';

// Minimal upstream message/room shapes. The skychat npm package only exports
// the client class via its API entry point; the full type definitions live
// under `build/server`, so we mirror just the fields we read.

interface SanitizedMessage {
    id: number;
    room: number | null;
    content: string;
    formatted: string;
    createdTimestamp: number;
    user: { username: string } | null;
}

interface SanitizedRoom {
    id: number;
    name?: string;
    isPrivate?: boolean;
}

const MAX_BUFFER = 500;
const DEFAULT_ROOM = 0;
const SKYCHAT_URL = process.env.SKYCHAT_URL ?? 'wss://skych.at/api/ws';

const TAG_RE = /<[^>]+>/g;
const ENTITY_RE = /&(amp|lt|gt|quot|#39|nbsp);/g;
const ENTITY_MAP: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'', nbsp: ' ',
};

function strip(s: string | null | undefined): string {
    if (!s) {
        return '';
    }
    return s
        .replace(TAG_RE, '')
        .replace(ENTITY_RE, (_, e) => ENTITY_MAP[e] ?? '')
        .trim();
}

function timestamp(seconds: number | undefined | null): string {
    const ms = seconds ? seconds * 1000 : Date.now();
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface BufferedMessage {
    id: number;
    ts: string;
    user: string;
    content: string;
    roomId: number | null;
}

function normalize(m: SanitizedMessage): BufferedMessage | null {
    const content = strip(m.content || m.formatted);
    if (!content) {
        return null;
    }
    return {
        id: m.id,
        ts: timestamp(m.createdTimestamp),
        user: m.user?.username ?? '?',
        content,
        roomId: m.room ?? null,
    };
}

export type MentionHandler = (m: BufferedMessage) => void | Promise<void>;

export class SkyChat {
    private client: SkyChatClient;
    private messages: BufferedMessage[] = [];
    private seen = new Set<number>();
    private rooms: SanitizedRoom[] = [];
    private currentRoom: number | null = null;
    private ready: Promise<void> | null = null;
    private onMention: MentionHandler | null = null;
    private auth: AuthMethod | null = null;
    private wasOpen = false;

    constructor() {
        this.client = new SkyChatClient(SKYCHAT_URL);
        this.setupListeners();
    }

    private setupListeners(): void {
        this.client.on('auth-token', (token) => {
            if (token) {
                saveToken(token);
            }
        });

        this.client.on('room-list', (rooms) => {
            this.rooms = rooms;
        });

        this.client.on('join-room', (roomId) => {
            this.currentRoom = roomId;
        });

        this.client.on('messages', (batch) => {
            const newOnes: BufferedMessage[] = [];
            for (const m of batch) {
                const e = normalize(m);
                if (e && !this.seen.has(e.id)) {
                    newOnes.push(e);
                    this.seen.add(e.id);
                }
            }
            this.messages = [...newOnes, ...this.messages].slice(-MAX_BUFFER);
            this.trimSeen();
        });

        this.client.on('message', (m) => {
            const e = normalize(m);
            if (!e || this.seen.has(e.id)) {
                return;
            }
            this.messages.push(e);
            this.seen.add(e.id);
            if (this.messages.length > MAX_BUFFER) {
                const dropped = this.messages.shift();
                if (dropped) {
                    this.seen.delete(dropped.id);
                }
            }

            // Fire mention callback if the bot is @mentioned by someone else
            const me = this.username;
            if (
                this.onMention &&
                me !== '*Guest' &&
                e.user !== me &&
                new RegExp('@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e.content)
            ) {
                Promise.resolve(this.onMention(e)).catch((err) =>
                    console.error('skychat-mcp: mention handler error:', err),
                );
            }
        });

        this.client.on('message-edit', (m) => {
            const edited = normalize(m);
            if (!edited) {
                return;
            }
            const target = this.messages.find((b) => b.id === edited.id);
            if (target) {
                target.content = edited.content;
            }
        });
    }

    private trimSeen(): void {
        if (this.seen.size > MAX_BUFFER * 2) {
            this.seen = new Set(this.messages.map((m) => m.id));
        }
    }

    private waitForOpen(): Promise<void> {
        const ws: any = (this.client as any)._websocket;
        if (ws && ws.readyState === 1) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const tries = setInterval(() => {
                const w: any = (this.client as any)._websocket;
                if (w && w.readyState === 1) {
                    clearInterval(tries);
                    resolve();
                } else if (w && w.readyState === 3) {
                    clearInterval(tries);
                    reject(new Error('WebSocket closed before opening'));
                }
            }, 20);
            setTimeout(() => {
                clearInterval(tries);
                reject(new Error('Timed out waiting for WebSocket to open'));
            }, 10_000);
        });
    }

    private waitForHistory(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onMessages = () => {
                this.client.off('messages', onMessages);
                resolve();
            };
            this.client.on('messages', onMessages);
            setTimeout(() => {
                this.client.off('messages', onMessages);
                reject(new Error('Timed out waiting for history'));
            }, 10_000);
        });
    }

    async start(auth: AuthMethod): Promise<void> {
        if (this.ready) {
            return this.ready;
        }
        this.auth = auth;
        this.ready = (async () => {
            this.client.connect();
            await this.waitForOpen();

            try {
                await this.runAuth(auth);
            } catch (err) {
                // Token auth can fail if the saved token expired. Fall back to
                // guest so the server still comes up — matches the behavior of
                // the previous Python implementation.
                if (auth.kind === 'token') {
                    console.error(`skychat-mcp: token auth failed (${err}), falling back to guest`);
                    clearToken();
                    this.auth = { kind: 'guest' };
                    await this.runAuth(this.auth);
                } else {
                    throw err;
                }
            }

            // Server auto-joins preferred room (0) and emits 'messages' with history.
            await this.waitForHistory().catch(() => {
                /* history is best-effort */
            });

            this.wasOpen = true;
            this.watchReconnect();
        })();
        return this.ready;
    }

    private async runAuth(auth: AuthMethod): Promise<void> {
        switch (auth.kind) {
            case 'guest':
                await this.client.authAsGuest();
                return;
            case 'token':
                await this.client.authenticate({ token: auth.token as any, roomId: DEFAULT_ROOM });
                return;
            case 'credentials':
                await this.client.login(auth.username, auth.password);
                return;
        }
    }

    /**
     * The upstream SDK auto-reconnects after a dropped websocket but only
     * re-authenticates from localStorage, which doesn't exist in Node. Watch
     * for close→open transitions and re-auth ourselves with the same method
     * the user started with.
     */
    private watchReconnect(): void {
        this.client.on('update', () => {
            const ws: any = (this.client as any)._websocket;
            const open = !!ws && ws.readyState === 1;
            if (open && !this.wasOpen) {
                this.wasOpen = true;
                if (this.auth) {
                    this.runAuth(this.auth).catch((err) => {
                        console.error('skychat-mcp: re-auth after reconnect failed:', err);
                    });
                }
            } else if (!open && this.wasOpen) {
                this.wasOpen = false;
            }
        });
    }

    async stop(): Promise<void> {
        // Suppress the SDK's auto-reconnect so the process can exit cleanly.
        const ws: any = (this.client as any)._websocket;
        if (ws) {
            (this.client as any)._websocket = null;
            try {
                ws.close();
            } catch {
                // ignore
            }
        }
    }

    setMentionHandler(handler: MentionHandler | null): void {
        this.onMention = handler;
    }

    get connected(): boolean {
        const ws: any = (this.client as any)._websocket;
        return !!ws && ws.readyState === 1;
    }

    get username(): string {
        return this.client.state?.user?.username ?? '*Guest';
    }

    get currentRoomId(): number | null {
        return this.currentRoom;
    }

    getMessages(roomId: number | null | undefined, limit: number): BufferedMessage[] {
        const all = roomId == null
            ? this.messages
            : this.messages.filter((m) => m.roomId === roomId);
        return all.slice(-limit);
    }

    getRooms(): SanitizedRoom[] {
        return this.rooms;
    }

    bufferStats(): { buffered: number; rooms: number } {
        return { buffered: this.messages.length, rooms: this.rooms.length };
    }

    async post(text: string, roomId?: number | null): Promise<void> {
        if (roomId != null && roomId !== this.currentRoom) {
            this.client.sendMessage(`/join ${roomId}`);
            await new Promise((r) => setTimeout(r, 500));
        }
        this.client.sendMessage(text);
    }

    async join(roomId: number): Promise<void> {
        this.client.join(roomId);
        await new Promise((r) => setTimeout(r, 500));
    }

    async fetchHistory(beforeId?: number | null): Promise<void> {
        const cmd = beforeId ? `/messagehistory ${beforeId}` : '/messagehistory';
        this.client.sendMessage(cmd);
        await new Promise((r) => setTimeout(r, 1500));
    }
}
