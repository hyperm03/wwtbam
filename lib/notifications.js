import crypto from 'node:crypto';
import path from 'node:path';
import { config, installation } from './config.js';
import { readJson, writeJson } from './durable.js';
import { schedule } from './schedule.js';

const file = path.join(config.dataDir, 'discord-notifications.json');
const state = readJson(file, { sent: {}, events: {} });
const token = () => installation.get('DISCORD_BOT_TOKEN');
const channel = () => installation.get('DISCORD_ANNOUNCEMENT_CHANNEL_ID');
const guild = () => installation.get('DISCORD_GUILD_ID');
const enabled = () => installation.get('DISCORD_ANNOUNCEMENTS_ENABLED') === '1' && !!token() && /^\d{17,20}$/.test(channel()) && /^\d{17,20}$/.test(guild());
const api = 'https://discord.com/api/v10';
const persist = () => writeJson(file, state);
let running = false;
async function request(route, method, body) {
    const response = await fetch(api + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bot ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Discord notification failed (' + response.status + ')');
    return response.status === 204 ? {} : response.json();
}
export function notificationStatus() { return { enabled: enabled(), events: state.events, delivery: state.sent }; }
async function sendOnce(key, content) {
    if (!enabled() || state.sent[key]) return;
    // Persist an uncertain delivery before sending. Never blindly duplicate a message after a process crash.
    state.sent[key] = { status: 'pending', at: new Date().toISOString() }; persist();
    try {
        const nonce = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
        await request(`/channels/${channel()}/messages`, 'POST', { content: content.slice(0, 1900), allowed_mentions: { parse: [] }, nonce, enforce_nonce: true });
        state.sent[key].status = 'sent';
    } catch { state.sent[key].status = 'failed'; }
    persist();
}
export async function syncDiscordEvent(event) {
    if (!enabled()) throw new Error('Configure and explicitly enable the Discord bot first');
    if (!event.public || !event.discordNotify) throw new Error('Enable Discord notifications for this public event first');
    const saved = state.events[event.id];
    const cancelled = event.status === 'cancelled';
    if (cancelled && !saved) return { ok: true };
    if (!cancelled && Date.parse(event.start) <= Date.now()) throw new Error('Only future events can be scheduled');
    const payload = cancelled ? { status: 4 } : { name: event.title.slice(0, 100), description: `${event.description || ''}\n${config.publicUrl}/e/${event.slug}`.slice(0, 1000), scheduled_start_time: event.start, scheduled_end_time: new Date(Date.parse(event.start) + event.duration * 60000).toISOString(), privacy_level: 2, entity_type: 3, channel_id: null, entity_metadata: { location: event.location.slice(0, 100) || 'Discord game show' } };
    const remote = await request(`/guilds/${guild()}/scheduled-events${saved ? '/' + saved : ''}`, saved ? 'PATCH' : 'POST', payload);
    if (remote.id) { state.events[event.id] = remote.id; persist(); }
    return { ok: true };
}
export async function runReminders(now = Date.now()) {
    if (running || !enabled()) return;
    running = true;
    try {
        for (const event of schedule.list()) {
            if (!event.public || !event.discordNotify || event.status === 'cancelled') continue;
            const remaining = Date.parse(event.start) - now;
            for (const [label, offset] of [['24h', 86400000], ['1h', 3600000], ['live', 0]]) {
                if (remaining <= offset && remaining > offset - 90000) await sendOnce(`${event.id}:${event.start}:${label}`, `${label === 'live' ? 'Sta per iniziare' : 'Promemoria ' + label}: ${event.title}\n${config.publicUrl}/e/${event.slug}`);
            }
        }
        for (const [key, item] of Object.entries(state.sent)) if (Date.parse(item.at) < now - 30 * 86400000) delete state.sent[key];
        persist();
    } finally { running = false; }
}
export async function announceResult(roomId, prize) {
    for (const event of schedule.list().filter(e => e.room === roomId && e.public && e.discordNotify && e.status !== 'cancelled')) {
        await sendOnce(`${event.id}:${event.start}:result`, `${event.title}: puntata conclusa${prize ? '. Premio finale: ' + prize : ''}.\n${config.publicUrl}/e/${event.slug}`);
    }
}
setInterval(() => runReminders().catch(() => {}), 30000).unref();
