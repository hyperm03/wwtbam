import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Platform settings (question builder, AI engines), stored in data/settings.json.
 * The Gemini API key is encrypted with AES-256-GCM using a key derived from the session secret,
 * and it is never sent back to the browser (the panel only learns whether one is set).
 */
const FILE = path.join(config.dataDir, 'settings.json');
const KEY = crypto.createHash('sha256').update('mc-settings:' + config.sessionSecret).digest();

/** MySQL/MariaDB and Gemini secrets are encrypted at rest; everything else is plain JSON. */
const defaults = {
    mysql: { enabled: false, host: '127.0.0.1', port: 3450, user: '', password: '', database: 'millionaire' },
    builder: { baseUrl: config.builderUrl || 'http://127.0.0.1:13400', path: '', token: '' },
    ai: {
        provider: 'gemini', geminiKey: '', geminiModel: 'gemini-2.5-flash',
        ollamaUrl: 'http://localhost:11434', ollamaModel: '',
        language: 'English', topic: '', extra: ''
    }
};

function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(blob) {
    if (!blob) return '';
    try {
        const raw = Buffer.from(blob, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

let settings = structuredClone(defaults);
try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    settings = {
        mysql: { ...defaults.mysql, ...saved.mysql, password: decrypt(saved.mysql?.password) },
        builder: { ...defaults.builder, ...saved.builder },
        ai: { ...defaults.ai, ...saved.ai, geminiKey: decrypt(saved.ai?.geminiKey) }
    };
} catch { /* first start */ }

function persist() {
    const out = structuredClone(settings);
    out.ai.geminiKey = encrypt(settings.ai.geminiKey);
    out.mysql.password = encrypt(settings.mysql.password);
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

export const platformSettings = {
    /** Full settings, key included: server side only. */
    get: () => settings,

    /** What the control panel may see. */
    public() {
        return {
            mysql: { ...settings.mysql, password: undefined, hasPassword: !!settings.mysql.password },
            builder: { baseUrl: settings.builder.baseUrl, path: settings.builder.path, hasToken: !!settings.builder.token },
            ai: { ...settings.ai, geminiKey: undefined, hasGeminiKey: !!settings.ai.geminiKey }
        };
    },

    update(patch) {
        if (patch.mysql) {
            const m = patch.mysql;
            if (typeof m.enabled === 'boolean') settings.mysql.enabled = m.enabled;
            if (m.host !== undefined) settings.mysql.host = str(m.host, 200) || '127.0.0.1';
            if (m.port !== undefined) settings.mysql.port = Math.min(65535, Math.max(1, Number(m.port) || 3450));
            if (m.user !== undefined) settings.mysql.user = str(m.user, 100);
            if (m.database !== undefined) settings.mysql.database = str(m.database, 64).replace(/[^A-Za-z0-9_$]/g, '') || 'millionaire';
            if (m.password) settings.mysql.password = String(m.password).slice(0, 200);
        }
        if (patch.builder) {
            const b = patch.builder;
            if (b.baseUrl !== undefined) settings.builder.baseUrl = str(b.baseUrl, 300).replace(/\/+$/, '');
            if (b.path !== undefined) settings.builder.path = str(b.path, 300);
            if (b.token !== undefined && b.token !== null) settings.builder.token = str(b.token, 500);
        }
        if (patch.ai) {
            const a = patch.ai;
            if (['gemini', 'ollama'].includes(a.provider)) settings.ai.provider = a.provider;
            // An empty key field means "keep the current key"; clearing it needs clearGeminiKey
            if (a.geminiKey) settings.ai.geminiKey = str(a.geminiKey, 300);
            if (a.clearGeminiKey) settings.ai.geminiKey = '';
            for (const k of ['geminiModel', 'ollamaUrl', 'ollamaModel', 'language', 'topic', 'extra'])
                if (a[k] !== undefined) settings.ai[k] = str(a[k], k === 'extra' ? 2000 : 300);
        }
        persist();
        return this.public();
    }
};
