import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'skychat-mcp');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

export type SavedToken = unknown;

export function loadToken(): SavedToken | null {
    try {
        const raw = readFileSync(TOKEN_FILE, 'utf-8');
        return JSON.parse(raw).token ?? null;
    } catch {
        return null;
    }
}

export function saveToken(token: SavedToken): void {
    try {
        mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
        const tmp = TOKEN_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify({ token }, null, 2));
        chmodSync(tmp, 0o600);
        renameSync(tmp, TOKEN_FILE);
    } catch (e) {
        console.error('skychat-mcp: could not save token:', e);
    }
}

export function clearToken(): void {
    try {
        unlinkSync(TOKEN_FILE);
    } catch {
        // ignore
    }
}

export type AuthMethod =
    | { kind: 'guest' }
    | { kind: 'token'; token: SavedToken }
    | { kind: 'credentials'; username: string; password: string };

/**
 * Pick an auth method based on flags + env vars + saved token.
 *
 * Order:
 *   1. --guest flag                       → guest
 *   2. $SKYCHAT_TOKEN env var             → token
 *   3. saved token file                   → token
 *   4. $SKYCHAT_USERNAME + $SKYCHAT_PASSWORD env vars → credentials
 *   5. fallback                           → guest
 */
export function resolveAuth(opts: { guest: boolean }): AuthMethod {
    if (opts.guest) {
        return { kind: 'guest' };
    }

    const envToken = process.env.SKYCHAT_TOKEN;
    if (envToken) {
        try {
            return { kind: 'token', token: JSON.parse(envToken) };
        } catch {
            return { kind: 'token', token: envToken };
        }
    }

    const savedToken = loadToken();
    if (savedToken) {
        return { kind: 'token', token: savedToken };
    }

    const username = process.env.SKYCHAT_USERNAME;
    const password = process.env.SKYCHAT_PASSWORD;
    if (username && password) {
        return { kind: 'credentials', username, password };
    }

    return { kind: 'guest' };
}
