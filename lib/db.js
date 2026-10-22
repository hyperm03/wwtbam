import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { config } from './config.js';
import { platformSettings } from './settings.js';
import { ensureUids, linkStack, unlinkStack } from './bank.js';

/**
 * MySQL / MariaDB storage: users of the control panel, question stacks (AI, builder, manual) and system logs.
 * Configured from Admin → Connections; the schema is created automatically on the first connection.
 * Without a database the platform still works: only the built-in admin can sign in, stacks are unavailable
 * and logs go to data/system.log.
 */
const scrypt = promisify(crypto.scrypt);
let pool = null;
let lastError = '';

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'operator',
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS question_stacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        source VARCHAR(24) NOT NULL DEFAULT 'manual',
        notes TEXT NULL,
        created_by VARCHAR(64) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS stack_questions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stack_id INT NOT NULL,
        set_type VARCHAR(12) NOT NULL,
        level TINYINT NOT NULL,
        category VARCHAR(80) NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        answers TEXT NOT NULL,
        correct TINYINT NOT NULL DEFAULT 0,
        comment TEXT NULL,
        UNIQUE KEY one_per_slot (stack_id, set_type, level),
        CONSTRAINT fk_stack FOREIGN KEY (stack_id) REFERENCES question_stacks(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS show_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        room VARCHAR(64) NOT NULL,
        game INT NOT NULL DEFAULT 0,
        ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        username VARCHAR(64) NULL,
        type VARCHAR(16) NOT NULL,
        level TINYINT NULL,
        message VARCHAR(600) NOT NULL,
        data TEXT NULL,
        KEY by_room (room, id),
        KEY by_game (room, game)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS bank_questions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uid VARCHAR(16) NULL,
        hash CHAR(40) NOT NULL,
        category VARCHAR(80) NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        answers TEXT NOT NULL,
        correct TINYINT NOT NULL DEFAULT 0,
        comment TEXT NULL,
        language VARCHAR(40) NULL,
        source VARCHAR(24) NOT NULL DEFAULT 'manual',
        source_ref VARCHAR(200) NULL,
        difficulty TINYINT NULL,
        difficulty_source VARCHAR(8) NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'available',
        stack_id INT NULL,
        used_count INT NOT NULL DEFAULT 0,
        used_at DATETIME NULL,
        used_room VARCHAR(64) NULL,
        used_game INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(64) NULL,
        UNIQUE KEY by_uid (uid),
        UNIQUE KEY by_hash (hash),
        KEY by_status (status, difficulty),
        KEY by_stack (stack_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        username VARCHAR(64) NULL,
        room VARCHAR(64) NULL,
        action VARCHAR(64) NOT NULL,
        details TEXT NULL,
        ip VARCHAR(64) NULL,
        KEY by_time (ts),
        KEY by_action (action)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

function poolOptions(m) {
    return {
        host: m.host, port: Number(m.port), user: m.user, password: m.password, database: m.database,
        connectionLimit: 8, waitForConnections: true, connectTimeout: 8000, charset: 'utf8mb4', dateStrings: true
    };
}

/** Changes to tables created by earlier versions (works on both MySQL and MariaDB). */
async function migrate(conn, database) {
    const hasColumn = async (table, column) => {
        const [rows] = await conn.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [database, table, column]);
        return rows.length > 0;
    };
    // Stack slots point to the question bank (unique question IDs)
    if (!(await hasColumn('stack_questions', 'bank_uid'))) await conn.query('ALTER TABLE stack_questions ADD COLUMN bank_uid VARCHAR(16) NULL');
    if (!(await hasColumn('question_stacks', 'kind'))) await conn.query("ALTER TABLE question_stacks ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'manual'");
}

export const db = {
    get enabled() { return !!pool; },
    get lastError() { return lastError; },

    /** (Re)connects with the saved settings; creates the schema. Returns { ok, error }. */
    async connect() {
        const m = platformSettings.get().mysql;
        if (pool) { await pool.end().catch(() => { }); pool = null; }
        if (!m.enabled || !m.user) { lastError = m.enabled ? 'No user configured' : ''; return { ok: false, error: lastError }; }
        const candidate = mysql.createPool(poolOptions(m));
        try {
            for (const sql of SCHEMA) await candidate.query(sql);
            await migrate(candidate, m.database);
            pool = candidate;
            lastError = '';
            return { ok: true };
        } catch (e) {
            await candidate.end().catch(() => { });
            lastError = e.message;
            return { ok: false, error: e.message };
        }
    },

    /** Tests settings without saving or switching to them. */
    async test(m) {
        let conn;
        try {
            conn = await mysql.createConnection({ ...poolOptions(m), connectionLimit: undefined, waitForConnections: undefined });
            const [[row]] = await conn.query('SELECT VERSION() AS version');
            return { ok: true, version: row.version };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            await conn?.end().catch(() => { });
        }
    },

    async query(sql, params) {
        if (!pool) throw new Error('The MySQL database is not connected (Admin → Connections)');
        const [rows] = await pool.query(sql, params);
        return rows;
    }
};

// ---------------------------------------------------------------------------------------------- passwords

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(String(password), salt, 64);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const key = await scrypt(String(password), Buffer.from(salt, 'base64'), 64);
    const expected = Buffer.from(hash, 'base64');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------------------------- users

export const ROLES = ['admin', 'operator'];

export const users = {
    async list() {
        return db.query('SELECT id, username, role, active, created_at, last_login FROM users ORDER BY username');
    },
    async find(username) {
        const rows = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        return rows[0] ?? null;
    },
    async create(username, password, role) {
        await db.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, await hashPassword(password), role]);
    },
    async update(id, { password, role, active }) {
        if (password) await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), id]);
        if (role) await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        if (typeof active === 'boolean') await db.query('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    },
    async remove(id) {
        await db.query('DELETE FROM users WHERE id = ?', [id]);
    },
    async touch(id) {
        await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
    }
};

// ---------------------------------------------------------------------------------------------- question stacks

const cleanQ = q => ({
    category: String(q?.category ?? '').slice(0, 80),
    text: String(q?.text ?? '').slice(0, 600),
    answers: Array.from({ length: 4 }, (_, i) => String(q?.answers?.[i] ?? '').slice(0, 200)),
    correct: Number.isInteger(q?.correct) && q.correct >= 0 && q.correct <= 3 ? q.correct : 0,
    comment: String(q?.comment ?? '').slice(0, 1000)
});

export const stacks = {
    async list() {
        return db.query(`SELECT s.id, s.name, s.source, s.kind, s.notes, s.created_by, s.created_at, s.updated_at,
                SUM(q.set_type = 'main') AS main_count, SUM(q.set_type = 'replacement') AS replacement_count
            FROM question_stacks s LEFT JOIN stack_questions q ON q.stack_id = s.id
            GROUP BY s.id ORDER BY s.updated_at DESC, s.id DESC`);
    },

    /** { id, name, ..., main: [15], sw: [15] } with empty slots filled. */
    async get(id) {
        const [stack] = await db.query('SELECT * FROM question_stacks WHERE id = ?', [id]);
        if (!stack) return null;
        const empty = () => Array.from({ length: 15 }, () => cleanQ({}));
        const main = empty(), sw = empty();
        const rows = await db.query(`SELECT q.*, b.difficulty, b.difficulty_source, b.status AS bank_status
            FROM stack_questions q LEFT JOIN bank_questions b ON b.uid = q.bank_uid WHERE q.stack_id = ?`, [id]);
        for (const r of rows) {
            let answers = [];
            try { answers = JSON.parse(r.answers); } catch { /* broken row */ }
            const q = {
                ...cleanQ({ category: r.category, text: r.text, answers, correct: r.correct, comment: r.comment }),
                uid: r.bank_uid || '', difficulty: r.difficulty ?? null, difficultySource: r.difficulty_source ?? null, bankStatus: r.bank_status ?? null
            };
            if (r.level >= 1 && r.level <= 15) (r.set_type === 'replacement' ? sw : main)[r.level - 1] = q;
        }
        return { ...stack, main, sw };
    },

    /**
     * Saves questions into a stack (new when id is null). `slots` is a list of { level, replacement, question };
     * with replaceAll the stack's previous questions are removed first. Empty questions are not stored.
     */
    async save({ id = null, name, source = 'manual', notes = '', user = null, slots, replaceAll = true, kind = 'manual' }) {
        if (!db.enabled) throw new Error('The MySQL database is not connected (Admin → Connections)');
        const valid = slots.filter(s => String(s.question?.text ?? '').trim() && s.level >= 1 && s.level <= 15);
        // Every question gets its unique ID in the question bank (existing ones keep theirs)
        const uids = await ensureUids(valid.map(s => ({ ...s.question, difficulty: s.difficulty ?? s.question?.difficulty, difficultySource: s.difficultySource })),
            { source: String(source).slice(0, 24), sourceRef: name ? String(name).slice(0, 200) : null, user });
        let stackId = id;
        if (!stackId) {
            const r = await db.query('INSERT INTO question_stacks (name, source, kind, notes, created_by) VALUES (?, ?, ?, ?, ?)',
                [String(name || 'Untitled').slice(0, 160), String(source).slice(0, 24), kind, String(notes || '').slice(0, 2000), user]);
            stackId = Number(r.insertId);
        } else {
            await db.query('UPDATE question_stacks SET name = COALESCE(?, name), updated_at = NOW() WHERE id = ?', [name ? String(name).slice(0, 160) : null, stackId]);
            if (replaceAll) {
                await db.query('DELETE FROM stack_questions WHERE stack_id = ?', [stackId]);
                await unlinkStack(stackId, uids);
            }
        }
        valid.forEach((s, k) => { if (s.question && uids[k]) s.question.uid = uids[k]; });
        for (const [k, s] of valid.entries()) {
            const q = cleanQ(s.question);
            await db.query(`INSERT INTO stack_questions (stack_id, set_type, level, category, text, answers, correct, comment, bank_uid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE category = VALUES(category), text = VALUES(text), answers = VALUES(answers),
                    correct = VALUES(correct), comment = VALUES(comment), bank_uid = VALUES(bank_uid)`,
                [stackId, s.replacement ? 'replacement' : 'main', s.level, q.category, q.text, JSON.stringify(q.answers), q.correct, q.comment, uids[k]]);
        }
        await linkStack(stackId, uids);
        return stackId;
    },

    async rename(id, name) {
        await db.query('UPDATE question_stacks SET name = ? WHERE id = ?', [String(name).slice(0, 160), id]);
    },
    /** Deleting a stack puts its questions back in the bank as available (used ones stay used). */
    async remove(id) {
        await unlinkStack(id);
        await db.query('DELETE FROM question_stacks WHERE id = ?', [id]);
    }
};

// ---------------------------------------------------------------------------------------------- system log

const LOG_FILE = path.join(config.dataDir, 'system.log');

/** Records an action; MySQL when connected, otherwise data/system.log (JSON lines). Never throws. */
export async function logEvent(action, { user = null, room = null, details = null, ip = null } = {}) {
    const text = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 4000);
    try {
        if (db.enabled) {
            await db.query('INSERT INTO logs (username, room, action, details, ip) VALUES (?, ?, ?, ?, ?)', [user, room, action, text, ip]);
            return;
        }
    } catch { /* fall back to the file */ }
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), username: user, room, action, details: text, ip }) + '\n');
    } catch { /* logging must never break the show */ }
}

export async function readLogs({ limit = 300, action = '', user = '', room = '' } = {}) {
    limit = Math.min(2000, Math.max(1, Number(limit) || 300));
    if (db.enabled) {
        const where = [], params = [];
        if (action) { where.push('action = ?'); params.push(action); }
        if (user) { where.push('username = ?'); params.push(user); }
        if (room) { where.push('room = ?'); params.push(room); }
        return db.query(`SELECT id, ts, username, room, action, details, ip FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, params);
    }
    if (!fs.existsSync(LOG_FILE)) return [];
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && (!action || r.action === action) && (!user || r.username === user) && (!room || r.room === room))
        .reverse().slice(0, limit);
}
