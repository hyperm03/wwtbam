import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

/**
 * Detailed log of every show: from its creation to every control action and every moment of the gameplay.
 * Stored in the MySQL table show_events, or in data/showlogs/<show>.jsonl when the database is not connected.
 *
 * Event types:
 *   show     - creation, rename, theme, links, deletion
 *   control  - every command from the control panel (with the user)
 *   game     - what actually happened on air, read from the game state
 *   audience - keypad votes and voting rounds
 *   screen   - output, host and player screens connecting / disconnecting
 */
export const EVENT_TYPES = ['show', 'control', 'game', 'audience', 'screen'];
const DIR = path.join(config.dataDir, 'showlogs');
fs.mkdirSync(DIR, { recursive: true });

let emitter = () => { };
/** Live updates: shows.js registers a function that pushes each new event to the panels watching that show. */
export function onShowEvent(fn) { emitter = fn; }

const fileOf = room => path.join(DIR, String(room).replace(/[^a-z0-9-]/g, '') + '.jsonl');

export async function showEvent(room, { type, message, user = null, level = null, game = 0, data = null }) {
    const event = {
        room, game: Number(game) || 0, ts: new Date().toISOString(), username: user, type,
        level: Number.isInteger(level) ? level : null, message: String(message).slice(0, 600),
        data: data == null ? null : JSON.stringify(data).slice(0, 8000)
    };
    try {
        if (db.enabled) {
            const r = await db.query('INSERT INTO show_events (room, game, username, type, level, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [room, event.game, user, type, event.level, event.message, event.data]);
            event.id = Number(r.insertId);
        } else {
            fs.appendFileSync(fileOf(room), JSON.stringify(event) + '\n');
        }
    } catch {
        try { fs.appendFileSync(fileOf(room), JSON.stringify(event) + '\n'); } catch { /* never break the show */ }
    }
    try { emitter(room, event); } catch { /* ignore */ }
    return event;
}

/** Events of a show, newest first. Filters: game, types (comma list), text search, limit, before (id, for paging). */
export async function listShowEvents(room, { game = '', types = '', q = '', limit = 500, before = '' } = {}) {
    limit = Math.min(20000, Math.max(1, Number(limit) || 500));
    const typeList = String(types || '').split(',').filter(t => EVENT_TYPES.includes(t));
    if (db.enabled) {
        const where = ['room = ?'], params = [room];
        if (game !== '' && game != null) { where.push('game = ?'); params.push(Number(game)); }
        if (typeList.length) { where.push(`type IN (${typeList.map(() => '?').join(',')})`); params.push(...typeList); }
        if (q) { where.push('(message LIKE ? OR username LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
        if (before) { where.push('id < ?'); params.push(Number(before)); }
        return db.query(`SELECT id, room, game, ts, username, type, level, message, data FROM show_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, params);
    }
    const file = fileOf(room);
    if (!fs.existsSync(file)) return [];
    const needle = String(q || '').toLowerCase();
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((line, i) => { try { return { id: i + 1, ...JSON.parse(line) }; } catch { return null; } })
        .filter(e => e && (game === '' || game == null || e.game === Number(game)) && (!typeList.length || typeList.includes(e.type)) &&
            (!needle || e.message.toLowerCase().includes(needle) || String(e.username || '').toLowerCase().includes(needle)) &&
            (!before || e.id < Number(before)))
        .reverse().slice(0, limit);
}

/** Per show: number of events, number of games, last activity. */
export async function showStats() {
    const out = {};
    if (db.enabled) {
        for (const r of await db.query('SELECT room, COUNT(*) AS events, MAX(game) AS games, MAX(ts) AS last FROM show_events GROUP BY room'))
            out[r.room] = { events: Number(r.events), games: Number(r.games) || 0, last: r.last };
        return out;
    }
    for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
        const lines = fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').filter(Boolean);
        const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        out[f.replace(/\.jsonl$/, '')] = { events: lines.length, games: last?.game || 0, last: last?.ts || null };
    }
    return out;
}

export async function clearShowEvents(room) {
    if (db.enabled) await db.query('DELETE FROM show_events WHERE room = ?', [room]);
    fs.rmSync(fileOf(room), { force: true });
}

// ---------------------------------------------------------------------------------------------- readable names

export const KEY_NAMES = {
    37: 'Rules / money tree', 38: 'Show the clock', 39: 'Next', 40: 'Total prize', 48: 'Pause / resume the clock', 66: 'Banked time', 49: 'Final answer A', 50: 'Final answer B', 51: 'Final answer C', 52: 'Final answer D',
    65: 'Ask the Audience', 67: 'Commercial break', 68: 'Double Dip', 69: 'Rules music', 70: '50:50', 71: 'Game over', 75: 'Klaxon',
    76: 'Lifelines strap', 77: 'Prize at stake', 78: 'Name strap', 80: 'Phone a Friend', 81: 'Resume music', 83: 'Switch the Question',
    84: 'Ask the Expert', 85: 'Undo final answer', 87: 'Walk away'
};
export const LIFELINE_NAMES = ['50:50', 'Phone a Friend', 'Ask the Audience', 'Switch the Question', 'Double Dip', 'Ask the Expert'];
export const LIFELINE_IDS = ['ff', 'paf', 'ata', 'stq', 'dd', 'ate'];
