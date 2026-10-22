import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Fastest Finger First questions: a question, four items (A-D) and the correct order (e.g. "BDAC").
 * Stored in data/fff-questions.json (works with or without MySQL). Each has a unique ID (F-000001) and is marked as
 * used when it goes on air, so it is not repeated in later rounds (tie-breakers included).
 */
const FILE = path.join(config.dataDir, 'fff-questions.json');
let questions = [];
try { questions = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first start */ }

function persist() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(questions, null, 1));
    fs.renameSync(tmp, FILE);
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const key = q => str(q.text, 600).toLowerCase() + '#' + q.answers.map(a => a.toLowerCase()).sort().join('|');

/** "B, D, A, C" / "bdac" / "B-D-A-C" -> "BDAC"; null unless it is the four letters once each. */
export function cleanOrder(value) {
    const letters = String(value ?? '').toUpperCase().replace(/[^ABCD]/g, '');
    return letters.length === 4 && new Set(letters).size === 4 ? letters : null;
}

function clean(input, previous = {}) {
    const text = str(input.text ?? previous.text, 600);
    if (!text) throw new Error('Enter the question');
    const answers = [0, 1, 2, 3].map(i => str(input.answers?.[i] ?? previous.answers?.[i], 200));
    if (answers.some(a => !a)) throw new Error('Enter all four items');
    const order = cleanOrder(input.order ?? previous.order);
    if (!order) throw new Error('The correct order must use A, B, C and D once each (e.g. BDAC)');
    return { text, answers, order, category: str(input.category ?? previous.category ?? '', 80), comment: str(input.comment ?? previous.comment ?? '', 1000) };
}

function nextUid() {
    const max = Math.max(0, ...questions.map(q => Number(q.uid.slice(2)) || 0));
    return 'F-' + String(max + 1).padStart(6, '0');
}

export const fffQuestions = {
    list: () => questions,
    get: uid => questions.find(q => q.uid === uid) ?? null,

    create(input, user) {
        const q = { uid: nextUid(), ...clean(input), used: false, usedCount: 0, usedAt: null, usedRoom: null, createdBy: user, createdAt: new Date().toISOString() };
        if (questions.some(x => key(x) === key(q))) throw new Error('This question is already in the list');
        questions.push(q);
        persist();
        return q;
    },

    update(uid, input) {
        const i = questions.findIndex(q => q.uid === uid);
        if (i < 0) throw new Error('Question not found');
        questions[i] = { ...questions[i], ...clean(input, questions[i]) };
        persist();
        return questions[i];
    },

    remove(uid) {
        const before = questions.length;
        questions = questions.filter(q => q.uid !== uid);
        if (questions.length !== before) persist();
    },

    setUsed(uid, used, room = null) {
        const q = questions.find(x => x.uid === uid);
        if (!q) return;
        q.used = !!used;
        if (used) { q.usedCount = (q.usedCount || 0) + 1; q.usedAt = new Date().toISOString(); q.usedRoom = room; }
        persist();
    },

    /** A random question never used, excluding the given ones. */
    randomUnused(exclude = []) {
        const pool = questions.filter(q => !q.used && !exclude.includes(q.uid));
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    },

    /** Rows of a table (CSV / Excel): question, A, B, C, D and the correct order; duplicates skipped. */
    importRows(rows, user) {
        if (!rows.length) return { added: 0, skipped: 0, invalid: 0 };
        const header = rows[0].map(c => String(c).trim().toLowerCase());
        const find = re => header.findIndex(h => re.test(h));
        const cols = {
            text: find(/^(domanda|question|text|testo)$/), a: find(/^a$/), b: find(/^b$/), c: find(/^c$/), d: find(/^d$/),
            order: find(/^(ordine( corretto)?|order|correct( order)?|corretta|risposta( corretta)?|answer)$/),
            category: find(/^(categoria|category)$/), comment: find(/^(commento|comment|note|notes)$/)
        };
        const hasHeader = cols.text >= 0 && cols.order >= 0;
        const map = hasHeader ? cols : { text: 0, a: 1, b: 2, c: 3, d: 4, order: 5, category: -1, comment: -1 };
        const known = new Set(questions.map(key));
        let added = 0, skipped = 0, invalid = 0;
        for (const r of rows.slice(hasHeader ? 1 : 0)) {
            const get = i => (i >= 0 ? String(r[i] ?? '') : '');
            let q;
            try {
                q = clean({ text: get(map.text), answers: [get(map.a), get(map.b), get(map.c), get(map.d)], order: get(map.order), category: get(map.category), comment: get(map.comment) });
            } catch { if (get(map.text).trim()) invalid++; continue; }
            if (known.has(key(q))) { skipped++; continue; }
            known.add(key(q));
            questions.push({ uid: nextUid(), ...q, used: false, usedCount: 0, usedAt: null, usedRoom: null, createdBy: user, createdAt: new Date().toISOString() });
            added++;
        }
        if (added) persist();
        return { added, skipped, invalid };
    }
};
