import crypto from 'node:crypto';
import { db } from './db.js';
import { engineFor, generate, generateForLevel, difficulty as ladder } from './ai.js';
import { questionReview } from './editorial.js';

/**
 * Question bank: every question in the system, with a permanent unique ID (Q-000001), its difficulty on the
 * 1-15 ladder and where that difficulty came from (file, manual, ai), and its status:
 *   available - not in any stack
 *   stack     - assigned to a stack (the builder will not reuse it)
 *   used      - it went on air in a show (show, game and time recorded)
 * The same question imported twice (same text and answers, in any order) is recognised and not duplicated.
 */
const LEVELS = 15;
const UID_RE = /^Q-\d{6,}$/;

const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function questionHash(q) {
    const answers = (q.answers ?? []).map(norm).sort().join('|');
    return crypto.createHash('sha1').update(norm(q.text) + '#' + answers).digest('hex');
}

function clean(q) {
    const question = {
        category: String(q?.category ?? '').slice(0, 80),
        text: String(q?.text ?? '').slice(0, 600),
        answers: Array.from({ length: 4 }, (_, i) => String(q?.answers?.[i] ?? '').slice(0, 200)),
        correct: Number.isInteger(q?.correct) && q.correct >= 0 && q.correct <= 3 ? q.correct : 0,
        comment: String(q?.comment ?? '').slice(0, 1000)
    };
    question.editorial = questionReview(question);
    return question;
}

const validDifficulty = d => Number.isInteger(d) && d >= 1 && d <= LEVELS ? d : null;

function fromRow(r) {
    let answers = [];
    try { answers = JSON.parse(r.answers); } catch { /* broken row */ }
    const question = {
        uid: r.uid, category: r.category, text: r.text, answers, correct: r.correct, comment: r.comment ?? '',
        difficulty: r.difficulty, difficultySource: r.difficulty_source, status: r.status, stackId: r.stack_id, stackName: r.stack_name ?? null,
        usedCount: r.used_count, usedAt: r.used_at, usedRoom: r.used_room, usedGame: r.used_game,
        source: r.source, sourceRef: r.source_ref, language: r.language, createdAt: r.created_at, createdBy: r.created_by
    };
    question.editorial = questionReview(question);
    return question;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------------------------- adding

/**
 * Adds questions to the bank. items: [{ question, difficulty?, difficultySource? }] (or plain questions).
 * Returns the unique ID of every item (existing ID for duplicates), plus how many were new.
 */
export async function addToBank(items, { source = 'manual', sourceRef = null, user = null, language = null } = {}) {
    const prepared = items.map(it => {
        const q = clean(it?.question ?? it);
        if (!q.text.trim()) return null;
        const d = validDifficulty(it?.difficulty);
        return { q, hash: questionHash(q), difficulty: d, difficultySource: d ? (it?.difficultySource || 'file') : null };
    });
    const valid = prepared.filter(Boolean);
    let added = 0;
    for (const part of chunks(valid, 200)) {
        const r = await db.query(`INSERT IGNORE INTO bank_questions
            (hash, category, text, answers, correct, comment, language, source, source_ref, difficulty, difficulty_source, created_by) VALUES ?`,
            [part.map(p => [p.hash, p.q.category, p.q.text, JSON.stringify(p.q.answers), p.q.correct, p.q.comment, language, source, sourceRef, p.difficulty, p.difficultySource, user])]);
        added += r.affectedRows;
    }
    await db.query("UPDATE bank_questions SET uid = CONCAT('Q-', LPAD(id, 6, '0')) WHERE uid IS NULL");

    // A duplicate brings a difficulty the bank did not have yet
    for (const p of valid.filter(p => p.difficulty)) {
        await db.query('UPDATE bank_questions SET difficulty = ?, difficulty_source = ? WHERE hash = ? AND difficulty IS NULL', [p.difficulty, p.difficultySource, p.hash]);
    }
    const map = new Map();
    for (const part of chunks([...new Set(valid.map(p => p.hash))], 500)) {
        for (const r of await db.query('SELECT hash, uid FROM bank_questions WHERE hash IN (?)', [part])) map.set(r.hash, r.uid);
    }
    return { uids: prepared.map(p => (p ? map.get(p.hash) ?? null : null)), added, duplicates: valid.length - added, skipped: prepared.length - valid.length };
}

/** Unique IDs for questions that may already carry one (e.g. loaded from a stack): adds the others to the bank. */
export async function ensureUids(questions, opts = {}) {
    const result = questions.map(q => (UID_RE.test(q?.uid ?? '') ? q.uid : null));
    const known = result.filter(Boolean);
    if (known.length) {
        const existing = new Set((await db.query('SELECT uid FROM bank_questions WHERE uid IN (?)', [known])).map(r => r.uid));
        result.forEach((u, i) => { if (u && !existing.has(u)) result[i] = null; });
    }
    const missing = questions.map((q, i) => (result[i] || !String(q?.text ?? '').trim() ? null : i)).filter(i => i !== null);
    if (missing.length) {
        const { uids } = await addToBank(missing.map(i => ({ question: questions[i], difficulty: questions[i].difficulty, difficultySource: questions[i].difficultySource })), opts);
        missing.forEach((i, k) => { result[i] = uids[k]; });
    }
    return result;
}

// ---------------------------------------------------------------------------------------------- reading and editing

export async function bankStats() {
    const byStatus = { available: 0, stack: 0, used: 0 };
    for (const r of await db.query('SELECT status, COUNT(*) AS n FROM bank_questions GROUP BY status')) byStatus[r.status] = Number(r.n);
    const available = Array(LEVELS).fill(0);
    for (const r of await db.query("SELECT difficulty, COUNT(*) AS n FROM bank_questions WHERE status = 'available' AND difficulty IS NOT NULL GROUP BY difficulty"))
        available[r.difficulty - 1] = Number(r.n);
    const [unrated] = await db.query('SELECT COUNT(*) AS n FROM bank_questions WHERE difficulty IS NULL');
    const sources = await db.query('SELECT difficulty_source AS source, COUNT(*) AS n FROM bank_questions WHERE difficulty IS NOT NULL GROUP BY difficulty_source');
    const categories = await db.query("SELECT category, COUNT(*) AS n FROM bank_questions WHERE category <> '' GROUP BY category ORDER BY n DESC LIMIT 40");
    const total = byStatus.available + byStatus.stack + byStatus.used;
    return {
        total, byStatus, availableByDifficulty: available, unrated: Number(unrated.n),
        ratedBy: Object.fromEntries(sources.map(r => [r.source, Number(r.n)])), categories,
        // How many complete stacks the available, rated questions could still make (the scarcest level decides)
        possibleStacks: Math.min(...available)
    };
}

export async function listBank({ q = '', status = '', difficulty = '', unrated = '', category = '', source = '', page = 1, pageSize = 50 } = {}) {
    const where = [], params = [];
    if (q) { where.push('(b.text LIKE ? OR b.answers LIKE ? OR b.uid = ? OR b.category LIKE ?)'); params.push(`%${q}%`, `%${q}%`, q.toUpperCase(), `%${q}%`); }
    if (['available', 'stack', 'used'].includes(status)) { where.push('b.status = ?'); params.push(status); }
    if (validDifficulty(Number(difficulty))) { where.push('b.difficulty = ?'); params.push(Number(difficulty)); }
    if (unrated === '1') where.push('b.difficulty IS NULL');
    if (category) { where.push('b.category = ?'); params.push(category); }
    if (source) { where.push('b.source = ?'); params.push(source); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    pageSize = Math.min(200, Math.max(10, Number(pageSize) || 50));
    page = Math.max(1, Number(page) || 1);
    const [count] = await db.query(`SELECT COUNT(*) AS n FROM bank_questions b ${w}`, params);
    const rows = await db.query(`SELECT b.*, s.name AS stack_name FROM bank_questions b LEFT JOIN question_stacks s ON s.id = b.stack_id ${w}
        ORDER BY b.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    return { total: Number(count.n), page, pageSize, questions: rows.map(fromRow) };
}

export async function getBankQuestion(uid) {
    const [r] = await db.query('SELECT b.*, s.name AS stack_name FROM bank_questions b LEFT JOIN question_stacks s ON s.id = b.stack_id WHERE b.uid = ?', [uid]);
    return r ? fromRow(r) : null;
}

/** Edits a question; a difficulty set here counts as manual. The copies in its stack follow the change. */
export async function updateBankQuestion(uid, patch) {
    const current = await getBankQuestion(uid);
    if (!current) throw new Error('Question not found');
    if (patch.difficulty !== undefined) {
        const d = patch.difficulty === null || patch.difficulty === '' ? null : validDifficulty(Number(patch.difficulty));
        await db.query('UPDATE bank_questions SET difficulty = ?, difficulty_source = ? WHERE uid = ?', [d, d ? 'manual' : null, uid]);
    }
    if (patch.text !== undefined || patch.answers !== undefined || patch.correct !== undefined || patch.category !== undefined || patch.comment !== undefined) {
        const q = clean({ ...current, ...patch });
        try {
            await db.query('UPDATE bank_questions SET category = ?, text = ?, answers = ?, correct = ?, comment = ?, hash = ? WHERE uid = ?',
                [q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, questionHash(q), uid]);
        } catch (e) {
            if (/Duplicate/i.test(e.message)) throw new Error('Another question in the bank already has this text and these answers');
            throw e;
        }
        await db.query('UPDATE stack_questions SET category = ?, text = ?, answers = ?, correct = ?, comment = ? WHERE bank_uid = ?',
            [q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, uid]);
    }
    return getBankQuestion(uid);
}

/** Deletes questions from the bank (and their stack slots). */
export async function deleteBankQuestions(uids) {
    if (!uids.length) return 0;
    await db.query('DELETE FROM stack_questions WHERE bank_uid IN (?)', [uids]);
    const r = await db.query('DELETE FROM bank_questions WHERE uid IN (?)', [uids]);
    return r.affectedRows;
}

/** Makes questions available again: out of their stack, and optionally no longer marked as used. */
export async function releaseBankQuestions(uids, { clearUsed = false } = {}) {
    if (!uids.length) return 0;
    await db.query('DELETE FROM stack_questions WHERE bank_uid IN (?)', [uids]);
    const r = clearUsed
        ? await db.query("UPDATE bank_questions SET status = 'available', stack_id = NULL WHERE uid IN (?)", [uids])
        : await db.query("UPDATE bank_questions SET status = IF(status = 'used', 'used', 'available'), stack_id = NULL WHERE uid IN (?)", [uids]);
    return r.affectedRows;
}

/** A question went on air: marked as used with the show, the game and the time. */
export async function markUsed(uid, room, game) {
    if (!UID_RE.test(uid ?? '')) return;
    await db.query("UPDATE bank_questions SET status = 'used', used_count = used_count + 1, used_at = NOW(), used_room = ?, used_game = ? WHERE uid = ?", [room, game, uid]);
}

// ---------------------------------------------------------------------------------------------- stacks linked to the bank

/** After a stack is saved: its questions are marked as "in a stack" (used ones stay used). */
export async function linkStack(stackId, uids) {
    const list = uids.filter(Boolean);
    if (!list.length) return;
    await db.query("UPDATE bank_questions SET status = 'stack', stack_id = ? WHERE uid IN (?) AND status <> 'used'", [stackId, list]);
    await db.query('UPDATE bank_questions SET stack_id = ? WHERE uid IN (?) AND status = \'used\'', [stackId, list]);
}

/** Questions no longer in a stack become available again (not the used ones). */
export async function unlinkStack(stackId, keepUids = []) {
    const keep = keepUids.filter(Boolean);
    if (keep.length) await db.query("UPDATE bank_questions SET status = IF(status = 'used', 'used', 'available'), stack_id = NULL WHERE stack_id = ? AND uid NOT IN (?)", [stackId, keep]);
    else await db.query("UPDATE bank_questions SET status = IF(status = 'used', 'used', 'available'), stack_id = NULL WHERE stack_id = ?", [stackId]);
}

async function setSlot(stackId, set, level, uid) {
    await db.query('DELETE FROM stack_questions WHERE stack_id = ? AND set_type = ? AND level = ?', [stackId, set, level]);
    if (!uid) return;
    const q = await getBankQuestion(uid);
    if (!q) throw new Error('Question not found');
    await db.query(`INSERT INTO stack_questions (stack_id, set_type, level, category, text, answers, correct, comment, bank_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stackId, set, level, q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, uid]);
    await linkStack(stackId, [uid]);
    await db.query('UPDATE question_stacks SET updated_at = NOW() WHERE id = ?', [stackId]);
}

/** Puts a bank question into a stack slot; the question that was there becomes available again. */
export async function swapSlot(stackId, set, level, newUid) {
    const [old] = await db.query('SELECT bank_uid FROM stack_questions WHERE stack_id = ? AND set_type = ? AND level = ?', [stackId, set, level]);
    if (newUid) {
        const q = await getBankQuestion(newUid);
        if (!q) throw new Error('Question not found');
        if (q.status === 'stack' && q.stackId !== stackId) throw new Error(`${newUid} is already in the stack "${q.stackName}"`);
    }
    await setSlot(stackId, set, level, newUid);
    if (old?.bank_uid && old.bank_uid !== newUid) {
        const [still] = await db.query('SELECT 1 FROM stack_questions WHERE stack_id = ? AND bank_uid = ?', [stackId, old.bank_uid]);
        if (!still) await db.query("UPDATE bank_questions SET status = IF(status = 'used', 'used', 'available'), stack_id = NULL WHERE uid = ?", [old.bank_uid]);
    }
}

/** Available questions for a slot: exact difficulty first, then the nearest ones, unrated last. */
export async function candidates(level, { limit = 30, q = '' } = {}) {
    const where = ["status = 'available'"], params = [];
    if (q) { where.push('(text LIKE ? OR category LIKE ? OR uid = ?)'); params.push(`%${q}%`, `%${q}%`, String(q).toUpperCase()); }
    const rows = await db.query(`SELECT * FROM bank_questions WHERE ${where.join(' AND ')}
        ORDER BY difficulty IS NULL, ABS(COALESCE(difficulty, 99) - ?), RAND() LIMIT ${Math.min(100, Number(limit) || 30)}`, [...params, Number(level) || 1]);
    return rows.map(fromRow);
}

// ---------------------------------------------------------------------------------------------- the builder

function pickFrom(buckets, level, maxDeviation, avoidCategories) {
    for (let d = 0; d <= maxDeviation; d++) {
        for (const lv of d === 0 ? [level] : [level - d, level + d]) {
            const bucket = buckets[lv];
            if (!bucket?.length) continue;
            // Prefer a subject not already used in this stack
            const fresh = bucket.filter(q => !q.category || !avoidCategories.has(q.category.toLowerCase()));
            const pool = fresh.length ? fresh : bucket;
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            bucket.splice(bucket.indexOf(chosen), 1);
            return chosen;
        }
    }
    return null;
}

/**
 * Builds stacks of 15 from the available, rated questions, one per difficulty level, with varied subjects.
 * options: count (0 = as many as possible), prefix ("Stack"), replacements (fill them automatically),
 * maxDeviation (0-2 levels of tolerance when a level runs out), user.
 */
export async function buildStacks({ count = 0, prefix = 'Stack', replacements = true, maxDeviation = 0, user = null, only = 'both', name = null } = {}) {
    const rows = await db.query("SELECT * FROM bank_questions WHERE status = 'available' AND difficulty IS NOT NULL");
    const buckets = {};
    for (const r of rows.map(fromRow)) (buckets[r.difficulty] ??= []).push(r);

    // Continue the numbering of stacks already named "<prefix> N"
    const existing = await db.query('SELECT name FROM question_stacks WHERE name LIKE ?', [`${prefix} %`]);
    let number = Math.max(0, ...existing.map(e => Number(e.name.slice(prefix.length + 1))).filter(Number.isFinite)) + 1;

    // "main": the 15 game questions; "replacement": the 15 Switch the Question ones; "both": main + (optionally) replacements
    const wantMain = only !== 'replacement';
    const wantSw = only === 'replacement' || (only === 'both' && replacements);
    const required = only === 'replacement' ? 'sw' : 'main';

    const pickSet = (categories, mustComplete) => {
        const list = [];
        for (let level = 1; level <= LEVELS; level++) {
            const q = pickFrom(buckets, level, maxDeviation, categories);
            if (!q && mustComplete) {
                for (const back of list.filter(Boolean)) (buckets[back.difficulty] ??= []).push(back); // give them back
                return { list: null, shortage: level };
            }
            list.push(q);
            if (q?.category) categories.add(q.category.toLowerCase());
        }
        return { list };
    };

    const created = [];
    let shortage = null;
    const limit = count > 0 ? Math.min(count, 500) : 500;
    while (created.length < limit) {
        const categories = new Set();
        let main = [], sw = [];
        if (wantMain) {
            const r = pickSet(categories, required === 'main');
            if (!r.list) { shortage = r.shortage; break; }
            main = r.list;
        }
        if (wantSw) {
            const r = pickSet(categories, required === 'sw');
            if (!r.list) { shortage = r.shortage; break; }
            sw = r.list;
        }
        const stackName = name && count === 1 ? String(name).slice(0, 160) : `${prefix} ${number++}`;
        const setLabel = only === 'main' ? 'main game only' : only === 'replacement' ? 'replacement questions only' : 'main game' + (wantSw ? ' + replacements' : '');
        const r = await db.query("INSERT INTO question_stacks (name, source, kind, notes, created_by) VALUES (?, 'builder', 'builder', ?, ?)",
            [stackName, `Random from the question bank: ${setLabel}${maxDeviation ? ` (tolerance ±${maxDeviation})` : ''}`, user]);
        const stackId = Number(r.insertId);
        const values = [];
        main.forEach((q, i) => { if (q) values.push([stackId, 'main', i + 1, q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, q.uid]); });
        sw.forEach((q, i) => { if (q) values.push([stackId, 'replacement', i + 1, q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, q.uid]); });
        if (values.length) await db.query('INSERT INTO stack_questions (stack_id, set_type, level, category, text, answers, correct, comment, bank_uid) VALUES ?', [values]);
        await linkStack(stackId, values.map(v => v[8]));
        created.push({ id: stackId, name: stackName, main: main.filter(Boolean).length, replacements: sw.filter(Boolean).length });
    }
    return { created, shortageAtLevel: shortage, remaining: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])) };
}

/** Fills an empty (or any) slot automatically with the best available question. */
export async function autoFillSlot(stackId, set, level) {
    const stack = await db.query('SELECT category FROM stack_questions WHERE stack_id = ?', [stackId]);
    const used = new Set(stack.map(r => (r.category || '').toLowerCase()));
    const list = await candidates(level, { limit: 40 });
    const pick = list.find(q => q.difficulty === level && !used.has((q.category || '').toLowerCase())) ?? list.find(q => q.difficulty === level) ?? list[0];
    if (!pick) throw new Error('No available question in the bank for this level');
    await swapSlot(stackId, set, level, pick.uid);
    return pick.uid;
}

// ---------------------------------------------------------------------------------------------- AI: difficulty and generation

const RATE_SCHEMA = {
    type: 'object',
    properties: { ratings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, level: { type: 'integer' } }, required: ['id', 'level'] } } },
    required: ['ratings']
};

const RATE_PROMPT = `You rate the difficulty of quiz questions for the TV show "Who Wants to Be a Millionaire?" on its 1-15 money ladder:
- 1-5: ${ladder(1)}
- 6-9: ${ladder(6)}
- 10-14: ${ladder(10)}
- 15: ${ladder(15)}
Judge how many people in the general public would know the correct answer, considering how plausible the wrong answers are.
Use the whole scale. Reply with JSON only: one rating (id and level) for every question you receive.`;

/**
 * Rates with AI the questions that have no difficulty yet (or, with includeAi, also those rated by AI before).
 * Difficulties from the file or set by hand are never changed.
 */
export async function rateWithAi(ai, { includeAi = false, limit = 5000, progress = () => { }, signal } = {}) {
    const engine = engineFor(ai);
    const rows = await db.query(`SELECT uid, text, answers, correct FROM bank_questions WHERE ${includeAi ? "(difficulty IS NULL OR difficulty_source = 'ai')" : 'difficulty IS NULL'} ORDER BY id LIMIT ${Math.min(20000, limit)}`);
    let rated = 0;
    const batches = chunks(rows, 40);
    for (let b = 0; b < batches.length; b++) {
        if (signal?.aborted) throw new Error('Cancelled');
        progress(`Rating ${b * 40 + 1}-${Math.min(rows.length, (b + 1) * 40)} of ${rows.length} · ${engine.name}`);
        const list = batches[b].map(r => {
            let a = [];
            try { a = JSON.parse(r.answers); } catch { /* ignore */ }
            return `${r.uid} | ${r.text} | A: ${a[0]} | B: ${a[1]} | C: ${a[2]} | D: ${a[3]} | correct: ${'ABCD'[r.correct]}`;
        }).join('\n');
        let data;
        try { data = JSON.parse(String(await engine.complete(RATE_PROMPT, 'Questions:\n' + list, signal, RATE_SCHEMA)).replace(/^```(json)?\s*|\s*```$/g, '')); }
        catch (e) { if (signal?.aborted) throw new Error('Cancelled'); progress(`A batch could not be rated (${e.message.slice(0, 80)}), continuing`); continue; }
        const valid = new Set(batches[b].map(r => r.uid));
        for (const r of data.ratings ?? []) {
            const level = validDifficulty(Number(r.level));
            if (!level || !valid.has(r.id)) continue;
            await db.query("UPDATE bank_questions SET difficulty = ?, difficulty_source = 'ai' WHERE uid = ? AND (difficulty IS NULL OR difficulty_source = 'ai')", [level, r.id]);
            rated++;
        }
    }
    return { rated, total: rows.length };
}

/**
 * Generates new questions with AI straight into the bank: `perLevel` questions for each of the 15 levels, or, with
 * `level`, `count` questions all for that level (e.g. 10 for question 15).
 */
export async function generateIntoBank(ai, { perLevel = 1, level = null, count = 10, language = 'English', topic = '', extra = '', user = null, progress = () => { }, signal } = {}) {
    const engine = engineFor(ai);
    if (level) {
        // the questions of that level already in the bank are not written again
        const avoid = [
            ...(await db.query('SELECT text FROM bank_questions WHERE difficulty = ? ORDER BY RAND() LIMIT 50', [level])).map(r => r.text),
            ...(await db.query('SELECT text FROM bank_questions ORDER BY RAND() LIMIT 10')).map(r => r.text)
        ];
        const results = await generateForLevel(engine, { level, count, language, topic, extra, avoid }, { shuffle: true, signal, progress });
        const r = await addToBank(results.map(x => ({ question: x.question, difficulty: level, difficultySource: 'ai' })),
            { source: ai.provider, sourceRef: `${engine.name} · level ${level}${topic ? ' · ' + topic : ''}`, user, language });
        return { added: r.added, duplicates: r.duplicates, engine: engine.name, level, asked: count };
    }
    const sample = (await db.query('SELECT text FROM bank_questions ORDER BY RAND() LIMIT 60')).map(r => r.text);
    let added = 0, duplicates = 0;
    for (let round = 1; round <= perLevel; round++) {
        if (signal?.aborted) throw new Error('Cancelled');
        const results = await generate(engine, {
            from: 1, to: LEVELS, main: true, replacement: false, language, topic, extra,
            skipMain: new Set(), skipReplacement: new Set(), avoid: sample
        }, { shuffle: true, signal, progress: t => progress(`Round ${round} of ${perLevel} · ${t}`) });
        const r = await addToBank(results.map(x => ({ question: x.question, difficulty: x.level, difficultySource: 'ai' })),
            { source: ai.provider, sourceRef: `${engine.name}${topic ? ' · ' + topic : ''}`, user, language });
        added += r.added;
        duplicates += r.duplicates;
        sample.push(...results.map(x => x.question.text));
    }
    return { added, duplicates, engine: engine.name };
}
