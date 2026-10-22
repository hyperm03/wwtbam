import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './durable.js';

const FILE = path.join(config.dataDir, 'rooms.json');
const LEVELS = 15;

export function emptyQuestion() {
    return { category: '', text: '', answers: ['', '', '', ''], correct: 0, comment: '' };
}

function emptySet() {
    return Array.from({ length: LEVELS }, emptyQuestion);
}

/** A show: theme, questions, contestant, audience settings. Runtime data (game state, votes) is kept in memory only. */
function newRoom(id, name) {
    return {
        id,
        name: name || id,
        theme: '',
        mode: 'rehearsal',
        frozen: null,
        outputToken: crypto.randomBytes(12).toString('base64url'),
        loadId: 1,
        questions: { main: emptySet(), sw: emptySet() },
        contestant: { first: '', last: '', location: '' },
        ata: { source: 'game', manual: [25, 25, 25, 25], autoVoting: true },
        fiftyPick: null,
        // scrypt hashes of the host and player screen passwords ('' = screen disabled)
        screens: { host: '', player: '', ff: '' },
        game: 0,
        hostComment: false,
        hostMessage: null,
        // Clocked 2009: the three Phone a Friend contacts (null = the theme's own)
        pafContacts: null,
        status: 'active',
        endedAt: null,
        endedBy: null,
        createdBy: null,
        createdAt: new Date().toISOString()
    };
}

let rooms = new Map();
try {
    const saved = readJson(FILE, []);
    for (const r of saved) {
        const room = { ...newRoom(r.id), ...r };
        room.screens = { host: '', player: '', ff: '', ...r.screens };
        for (const set of ['main', 'sw']) room.questions[set] = room.questions[set].map(q => ({ comment: '', ...q }));
        rooms.set(r.id, room);
    }
} catch (error) {
    throw new Error('Cannot load saved shows; restore a verified backup before starting', { cause: error });
}

let saveTimer = null;
export function saveRooms() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushRooms, 300);
}
export function flushRooms() { clearTimeout(saveTimer); writeJson(FILE, [...rooms.values()]); }

export function slugify(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export const store = {
    list: () => [...rooms.values()],
    get: (id) => rooms.get(id),
    create(name, createdBy = null) {
        let base = slugify(name) || 'show';
        let id = base, n = 2;
        while (rooms.has(id)) id = `${base}-${n++}`;
        const room = newRoom(id, String(name || '').trim().slice(0, 60) || id);
        room.createdBy = createdBy;
        rooms.set(id, room);
        saveRooms();
        return room;
    },
    remove(id) {
        const ok = rooms.delete(id);
        if (ok) saveRooms();
        return ok;
    },
    rotateToken(room) {
        room.outputToken = crypto.randomBytes(12).toString('base64url');
        saveRooms();
    }
};

/** Validates and normalises a question coming from the control panel. */
export function cleanQuestion(q) {
    const answers = Array.isArray(q?.answers) ? q.answers.slice(0, 4).map(a => String(a ?? '').slice(0, 200)) : [];
    while (answers.length < 4) answers.push('');
    const correct = Number.isInteger(q?.correct) && q.correct >= 0 && q.correct <= 3 ? q.correct : 0;
    return {
        category: String(q?.category ?? '').slice(0, 80),
        text: String(q?.text ?? '').slice(0, 600),
        answers,
        correct,
        comment: String(q?.comment ?? '').slice(0, 1000),
        // Unique ID in the question bank (Q-000123), kept so that the question can be marked as used on air
        uid: /^Q-\d{6,}$/.test(q?.uid ?? '') ? q.uid : ''
    };
}

/** Shape expected by the bridge (same as the desktop app). */
export function toDto(q) {
    return {
        category: q.category,
        text: q.text.replace(/\r?\n/g, '++++'),
        a: q.answers[0], b: q.answers[1], c: q.answers[2], d: q.answers[3],
        correct: 'abcd'[q.correct]
    };
}
