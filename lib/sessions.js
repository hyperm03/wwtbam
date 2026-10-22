import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config, installation } from './config.js';
import { readJson, writeJson } from './durable.js';

export const sessionEvents = new EventEmitter();
const file = path.join(config.dataDir, 'sessions.json');
const records = readJson(file, {});
const digest = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const persist = () => writeJson(file, records);

export function createSession(data, purpose = 'staff', ttl = 8 * 3600000) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = digest(token);
    records[id] = { ...data, purpose, exp: Date.now() + ttl };
    persist();
    return { token, id, ...records[id] };
}
export function findSession(token, purpose = 'staff') {
    if (typeof token !== 'string' || token.length > 128) return null;
    const id = digest(token), row = records[id];
    if (!row || row.purpose !== purpose) return null;
    if (row.exp <= Date.now()) { revokeSession(id); return null; }
    return { ...row, id };
}
export function revokeSession(id) {
    if (!records[id]) return;
    delete records[id]; persist(); sessionEvents.emit('revoked', id);
}
export function revokeUser(user) {
    for (const [id, row] of Object.entries(records)) if (row.user === user) revokeSession(id);
}
export function revokeAccount(key) {
    for (const [id, row] of Object.entries(records)) if (row.accountKey === key) revokeSession(id);
}
export function purgeSessions() {
    for (const [id, row] of Object.entries(records)) if (row.exp <= Date.now()) revokeSession(id);
}
purgeSessions();
setInterval(purgeSessions, 60000).unref();
installation.events.on('changed', names => {
    const originChanged = names.some(name => ['PUBLIC_URL', 'OUTPUT_PUBLIC_URL'].includes(name));
    const identityChanged = names.some(name => /^(DISCORD_(?!ANNOUNCEMENT|BOT)|PRIVACY_|PARTICIPANT_MIN_AGE)/.test(name));
    for (const [id, row] of Object.entries(records)) if (originChanged || identityChanged && row.accountKey) revokeSession(id);
});
