import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInstallation } from './installation.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
for (const name of ['PUBLIC_URL', 'OUTPUT_PUBLIC_URL']) if (process.env[name]) {
    try {
        const url = new URL(process.env[name]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== process.env[name].replace(/\/+$/, '')) throw new Error();
    } catch { throw new Error(name + ' must be an HTTP(S) origin without credentials or paths'); }
}
fs.mkdirSync(path.join(dataDir, 'themes'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });

/** A value kept in data/ so it survives restarts (session secret, generated password). */
function persistent(file, create) {
    const full = path.join(dataDir, file);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8').trim();
    const value = create();
    fs.writeFileSync(full, value, { mode: 0o600 });
    return value;
}

let adminPassword = process.env.ADMIN_PASSWORD;
let generatedPassword = false;
if (!adminPassword) {
    adminPassword = persistent('admin-password.txt', () => crypto.randomBytes(9).toString('base64url'));
    generatedPassword = true;
}

const sessionSecret = process.env.SESSION_SECRET || persistent('session-secret.txt', () => crypto.randomBytes(32).toString('hex'));
export const installation = createInstallation({ dataDir, sessionSecret });

export const config = {
    port: Number(process.env.PORT || 13410),
    host: process.env.HOST || '0.0.0.0',
    dataDir,
    themesDir: path.join(dataDir, 'themes'),
    tmpDir: path.join(dataDir, 'tmp'),
    adminPassword,
    generatedPassword,
    sessionSecret,
    /** Public base URL used for the voting QR code (e.g. https://millionaire.example.com). Optional. */
    get publicUrl() { return installation.get('PUBLIC_URL').replace(/\/+$/, ''); },
    get outputPublicUrl() { return installation.get('OUTPUT_PUBLIC_URL').replace(/\/+$/, ''); },
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 1024),
    /** Question builder integration (phase 2). */
    builderUrl: (process.env.BUILDER_URL || '').replace(/\/+$/, ''),
    trustProxy: process.env.TRUST_PROXY === '1',
    // multi-tenant platform: the community this engine serves, and the global themes shared by every community
    tenantId: process.env.TENANT_ID || null,
    sharedThemesDir: process.env.SHARED_THEMES_DIR ? path.resolve(process.env.SHARED_THEMES_DIR) : null
};
