/**
 * Millionaire Show Control - multi-tenant gateway.
 *
 * One platform, many communities. The gateway is the only process facing the network:
 *  - it recognises the community from the domain of the request and forwards it (HTTP and WebSocket) to that
 *    community's engine;
 *  - every community has its own engine: the platform (server.js) running in its own process with its own data
 *    folder (data/tenants/<id>), so a community can never reach the data of another one;
 *  - it supervises the engines (restart with back-off) and serves the super-admin panel (/_superadmin) on every
 *    address that is not a community's (e.g. admin.example.com or the server's IP);
 *  - global themes (data/shared/themes) are offered to every community.
 *
 * Environment: PORT (13410), HOST, DATA_DIR, TRUST_PROXY=1 behind Nginx Proxy Manager & co., SUPERADMIN_PASSWORD,
 * PUBLIC_SCHEME (https: scheme of the communities' addresses), ENGINE_BASE_PORT (14100).
 * A single installation (data/rooms.json...) found at the first start becomes the community "tph"
 * (MIGRATE_TENANT_ID / MIGRATE_TENANT_NAME), domain taken from PUBLIC_URL.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || './data');
const PORT = Number(process.env.PORT || 13410);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SCHEME = process.env.PUBLIC_SCHEME === 'http' ? 'http' : 'https';
const BASE_PORT = Number(process.env.ENGINE_BASE_PORT || 14100);
const TENANTS_DIR = path.join(DATA, 'tenants');
const ARCHIVE_DIR = path.join(DATA, 'tenants-archive');
const SHARED = path.join(DATA, 'shared');
const SHARED_THEMES = path.join(SHARED, 'themes');
const REGISTRY = path.join(DATA, 'tenants.json');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
for (const d of [DATA, TENANTS_DIR, SHARED_THEMES, path.join(SHARED, 'tmp')]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), '[gateway]', ...a);
const persistent = (file, make) => {
    const full = path.join(DATA, file);
    try { return fs.readFileSync(full, 'utf8').trim(); } catch { /* first start */ }
    const v = make(); fs.writeFileSync(full, v, { mode: 0o600 }); return v;
};
const SECRET = persistent('gateway-secret.txt', () => crypto.randomBytes(32).toString('hex'));
let SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD;
if (!SUPERADMIN_PASSWORD) {
    SUPERADMIN_PASSWORD = persistent('superadmin-password.txt', () => crypto.randomBytes(12).toString('base64url'));
    log(`super-admin password (set SUPERADMIN_PASSWORD to choose your own): ${SUPERADMIN_PASSWORD}  - also in ${path.join(DATA, 'superadmin-password.txt')}`);
}

// ================================================================================================ registry
/** tenants.json: [{ id, name, domains:[], enabled, port, adminPassword, createdAt }] (readable by root only). */
let tenants = [];
const saveRegistry = () => {
    const tmp = REGISTRY + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(tenants, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, REGISTRY);
};
const tenantDir = id => path.join(TENANTS_DIR, id);
const byDomain = () => new Map(tenants.flatMap(t => t.domains.map(d => [d, t])));
const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
const validDomain = d => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(d);
const newPassword = () => crypto.randomBytes(12).toString('base64url');
const nextPort = () => Math.max(BASE_PORT - 1, ...tenants.map(t => t.port)) + 1;

function writeBranding(id, name) {
    const b = { name, logo: '/static/brand/generic-circle', presents: `${name} presents`, locationName: '', locationUrl: '', joinLabel: `Join ${name}`, footer: `a ${name} fan event` };
    fs.writeFileSync(path.join(tenantDir(id), 'branding.json'), JSON.stringify(b, null, 1));
}

/** A single installation (data/rooms.json, data/themes...) becomes the first community, with all its data. */
function migrateSingleInstallation() {
    if (fs.existsSync(REGISTRY)) return;
    const KEEP = new Set(['tenants', 'tenants-archive', 'shared', 'tenants.json', 'gateway-secret.txt', 'superadmin-password.txt']);
    const legacy = fs.readdirSync(DATA).filter(n => !KEEP.has(n));
    const hasData = legacy.some(n => ['rooms.json', 'themes', 'schedule.json', 'settings.json', 'showlogs'].includes(n));
    if (!hasData) { tenants = []; saveRegistry(); return; }
    const id = (process.env.MIGRATE_TENANT_ID || 'tph').toLowerCase();
    const name = process.env.MIGRATE_TENANT_NAME || 'TPH';
    const dir = tenantDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of legacy) fs.renameSync(path.join(DATA, n), path.join(dir, n));
    let adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) { try { adminPassword = fs.readFileSync(path.join(dir, 'admin-password.txt'), 'utf8').trim(); } catch { adminPassword = newPassword(); } }
    const domain = cleanDomain(process.env.PUBLIC_URL || '');
    tenants = [{ id, name, domains: domain && validDomain(domain) ? [domain] : [], enabled: true, port: BASE_PORT, adminPassword, createdAt: new Date().toISOString() }];
    saveRegistry();
    log(`the single installation became the community "${id}" (${legacy.length} items moved to ${dir})`);
}

try { tenants = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { migrateSingleInstallation(); }

// ================================================================================================ engines
const engines = new Map(); // id -> { proc, state, restarts, startedAt, lastExit, backoff, timer, stopping }
const engineOf = id => { if (!engines.has(id)) engines.set(id, { proc: null, state: 'stopped', restarts: 0, backoff: 1000 }); return engines.get(id); };

function engineEnv(t) {
    const env = { ...process.env };
    for (const k of ['SUPERADMIN_PASSWORD', 'ADMIN_PASSWORD', 'PUBLIC_URL', 'SESSION_SECRET', 'MIGRATE_TENANT_ID', 'MIGRATE_TENANT_NAME', 'ENGINE_BASE_PORT', 'PUBLIC_SCHEME']) delete env[k];
    return {
        ...env,
        DATA_DIR: tenantDir(t.id), PORT: String(t.port), HOST: '127.0.0.1', TRUST_PROXY: '1',
        ADMIN_PASSWORD: t.adminPassword, TENANT_ID: t.id, SHARED_THEMES_DIR: SHARED_THEMES,
        PUBLIC_URL: t.domains[0] ? `${SCHEME}://${t.domains[0]}` : ''
    };
}

function startEngine(t) {
    const e = engineOf(t.id);
    if (!t.enabled || e.proc) return;
    fs.mkdirSync(path.join(tenantDir(t.id), 'logs'), { recursive: true });
    const out = fs.createWriteStream(path.join(tenantDir(t.id), 'logs', 'engine.log'), { flags: 'a' });
    out.write(`--- ${new Date().toISOString()} starting (port ${t.port})\n`);
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: engineEnv(t), stdio: ['ignore', 'pipe', 'pipe'] });
    Object.assign(e, { proc, state: 'starting', startedAt: Date.now(), stopping: false });
    proc.stdout.pipe(out, { end: false });
    proc.stderr.pipe(out, { end: false });
    proc.stdout.once('data', () => { if (e.proc === proc) e.state = 'running'; });
    proc.on('exit', (code, signal) => {
        out.write(`--- ${new Date().toISOString()} stopped (code ${code}${signal ? ', ' + signal : ''})\n`);
        out.end();
        if (e.proc !== proc) return;
        e.proc = null;
        e.lastExit = { code, signal, at: Date.now() };
        if (e.stopping || !tenants.find(x => x.id === t.id && x.enabled)) { e.state = 'stopped'; return; }
        // crashed: start it again, waiting longer each time (reset after a minute of good running)
        if (Date.now() - e.startedAt > 60000) e.backoff = 1000;
        e.state = 'crashed';
        e.restarts++;
        log(`engine "${t.id}" stopped (code ${code}): restarting in ${e.backoff / 1000} s`);
        clearTimeout(e.timer);
        e.timer = setTimeout(() => { const now = tenants.find(x => x.id === t.id); if (now) startEngine(now); }, e.backoff);
        e.backoff = Math.min(e.backoff * 2, 30000);
    });
}

function stopEngine(id) {
    const e = engineOf(id);
    clearTimeout(e.timer);
    if (!e.proc) { e.state = 'stopped'; return Promise.resolve(); }
    e.stopping = true;
    const proc = e.proc;
    return new Promise(resolve => {
        const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
        proc.once('exit', () => { clearTimeout(kill); resolve(); });
        proc.kill('SIGTERM');
    });
}
const restartEngine = async t => { await stopEngine(t.id); engineOf(t.id).backoff = 1000; startEngine(t); };

function memoryMb(pid) {
    try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return null; }
}

// ================================================================================================ proxy
/** The community of a request, from its domain (the original one, behind a reverse proxy). */
function hostOf(req) {
    const h = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || '';
    return cleanDomain(String(h).split(',')[0]);
}
function forwardHeaders(req, host) {
    const h = { ...req.headers };
    // the engine trusts one hop: the last address it receives must be the visitor's
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
    h['x-forwarded-for'] = TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] : remote;
    h['x-forwarded-proto'] = TRUST_PROXY && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : (req.socket.encrypted ? 'https' : 'http');
    h['x-forwarded-host'] = host;
    return h;
}
function notice(res, status, title, text, refresh) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...(refresh ? { 'Retry-After': '3' } : {}) });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${title}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1530;color:#eef;font-family:Segoe UI,Arial,sans-serif;text-align:center">
<div><h1 style="font-size:24px">${title}</h1><p style="color:#a8b2df">${text}</p></div></body>`);
}

function proxyHttp(req, res, t) {
    const e = engineOf(t.id);
    if (!t.enabled) return notice(res, 503, 'Community suspended', 'This community is not available at the moment.');
    if (!e.proc) return notice(res, 503, 'Starting…', 'The platform of this community is starting: this page reloads by itself.', true);
    const host = hostOf(req);
    const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: req.url, headers: forwardHeaders(req, host) }, r => {
        res.writeHead(r.statusCode, r.statusMessage, r.headers);
        r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) notice(res, 502, 'Starting…', 'The platform of this community is not answering yet: this page reloads by itself.', true); else res.destroy(); });
    req.pipe(up);
}

function proxyUpgrade(req, socket, head, t) {
    const e = engineOf(t.id);
    if (!t.enabled || !e.proc) { socket.destroy(); return; }
    const headers = forwardHeaders(req, hostOf(req));
    const up = net.connect(t.port, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) up.write(head);
        socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
}

// ================================================================================================ super-admin panel
const admin = express();
admin.disable('x-powered-by');
if (TRUST_PROXY) admin.set('trust proxy', 1);
admin.use(express.json({ limit: '1mb' }));

const sign = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const makeCookie = () => { const body = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })).toString('base64url'); return `${body}.${sign(body)}`; };
function isSuper(req) {
    const m = /(?:^|;\s*)mc_super=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const [body, sig] = decodeURIComponent(m[1]).split('.');
    if (!body || !sig || sig.length !== sign(body).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) return false;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
const failures = new Map(); // ip -> [times]
admin.post('/_superadmin/api/login', (req, res) => {
    const now = Date.now(), list = (failures.get(req.ip) || []).filter(x => now - x < 15 * 60e3);
    if (list.length >= 10) return res.status(429).json({ error: 'Too many attempts: try again in 15 minutes' });
    const given = Buffer.from(String(req.body?.password || '')), real = Buffer.from(SUPERADMIN_PASSWORD);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
        list.push(now); failures.set(req.ip, list);
        log(`super-admin: wrong password from ${req.ip}`);
        return res.status(401).json({ error: 'Wrong password' });
    }
    failures.delete(req.ip);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `mc_super=${encodeURIComponent(makeCookie())}; Path=/_superadmin; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
    log(`super-admin: signed in from ${req.ip}`);
    res.json({ ok: true });
});
admin.post('/_superadmin/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'mc_super=; Path=/_superadmin; Max-Age=0'); res.json({ ok: true }); });
admin.use('/_superadmin/api', (req, res, next) => isSuper(req) ? next() : res.status(401).json({ error: 'Sign in first' }));

const view = t => {
    const e = engineOf(t.id);
    return {
        id: t.id, name: t.name, domains: t.domains, enabled: t.enabled, port: t.port, createdAt: t.createdAt,
        state: t.enabled ? e.state : 'suspended', restarts: e.restarts, pid: e.proc?.pid ?? null,
        memoryMb: e.proc ? memoryMb(e.proc.pid) : null, startedAt: e.proc ? e.startedAt : null, lastExit: e.lastExit ?? null
    };
};
admin.get('/_superadmin/api/status', (req, res) => res.json({
    version: VERSION, dataDir: DATA, scheme: SCHEME, behindProxy: TRUST_PROXY, gatewayMemoryMb: memoryMb(process.pid), tenants: tenants.map(view)
}));

function checkDomains(list, exceptId) {
    const domains = [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(cleanDomain).filter(Boolean))];
    for (const d of domains) {
        if (!validDomain(d)) throw new Error(`Not a valid domain: ${d}`);
        const other = tenants.find(t => t.id !== exceptId && t.domains.includes(d));
        if (other) throw new Error(`${d} already belongs to "${other.name}"`);
    }
    return domains;
}

admin.post('/_superadmin/api/tenants', (req, res) => {
    try {
        const id = String(req.body?.id || '').trim().toLowerCase();
        const name = String(req.body?.name || '').trim().slice(0, 60);
        if (!ID_RE.test(id)) throw new Error('The id is 2-31 lower-case letters, digits or dashes (e.g. "tph")');
        if (tenants.some(t => t.id === id) || fs.existsSync(tenantDir(id))) throw new Error(`The id "${id}" is already used`);
        if (!name) throw new Error('Give the community a name');
        const domains = checkDomains(req.body?.domains);
        const password = String(req.body?.adminPassword || '') || newPassword();
        if (password.length < 8) throw new Error('The admin password needs at least 8 characters');
        fs.mkdirSync(tenantDir(id), { recursive: true });
        writeBranding(id, name);
        const t = { id, name, domains, enabled: true, port: nextPort(), adminPassword: password, createdAt: new Date().toISOString() };
        tenants.push(t);
        saveRegistry();
        startEngine(t);
        log(`community "${id}" created (${domains.join(', ') || 'no domain yet'})`);
        res.json({ tenant: view(t), adminPassword: password });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.put('/_superadmin/api/tenants/:id', async (req, res) => {
    const t = tenants.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Community not found' });
    try {
        let restart = false;
        if (req.body?.name !== undefined) { const n = String(req.body.name).trim().slice(0, 60); if (!n) throw new Error('The name cannot be empty'); t.name = n; }
        if (req.body?.domains !== undefined) {
            const d = checkDomains(req.body.domains, t.id);
            restart = d[0] !== t.domains[0];          // the main domain is the public address of the engine
            t.domains = d;
        }
        if (typeof req.body?.enabled === 'boolean' && req.body.enabled !== t.enabled) {
            t.enabled = req.body.enabled;
            saveRegistry();
            if (t.enabled) startEngine(t); else await stopEngine(t.id);
            log(`community "${t.id}" ${t.enabled ? 'resumed' : 'suspended'}`);
        }
        saveRegistry();
        if (restart && t.enabled) await restartEngine(t);
        res.json({ tenant: view(t) });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.post('/_superadmin/api/tenants/:id/restart', async (req, res) => {
    const t = tenants.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Community not found' });
    if (!t.enabled) return res.status(400).json({ error: 'The community is suspended' });
    await restartEngine(t);
    res.json({ tenant: view(t) });
});

admin.post('/_superadmin/api/tenants/:id/admin-password', async (req, res) => {
    const t = tenants.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Community not found' });
    const password = String(req.body?.password || '') || newPassword();
    if (password.length < 8) return res.status(400).json({ error: 'At least 8 characters' });
    t.adminPassword = password;
    saveRegistry();
    if (t.enabled) await restartEngine(t);
    log(`community "${t.id}": admin password reset`);
    res.json({ adminPassword: password });
});

admin.get('/_superadmin/api/tenants/:id/log', async (req, res) => {
    const t = tenants.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Community not found' });
    try {
        const text = await fsp.readFile(path.join(tenantDir(t.id), 'logs', 'engine.log'), 'utf8');
        res.type('text/plain').send(text.split('\n').slice(-150).join('\n'));
    } catch { res.type('text/plain').send('(no log yet)'); }
});

/** Deleting archives the data (data/tenants-archive/<id>-<date>): nothing is destroyed. */
admin.delete('/_superadmin/api/tenants/:id', async (req, res) => {
    const t = tenants.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Community not found' });
    if (req.query.confirm !== t.id) return res.status(400).json({ error: 'Confirm with the id of the community' });
    await stopEngine(t.id);
    tenants = tenants.filter(x => x.id !== t.id);
    saveRegistry();
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archived = path.join(ARCHIVE_DIR, `${t.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (fs.existsSync(tenantDir(t.id))) fs.renameSync(tenantDir(t.id), archived);
    engines.delete(t.id);
    log(`community "${t.id}" removed (data archived in ${archived})`);
    res.json({ ok: true, archived });
});

// ---- global themes (shared by every community): the theme library of the platform, in data/shared
process.env.DATA_DIR = SHARED;          // lib/themes.js then works on data/shared/themes
process.env.ADMIN_PASSWORD ||= 'not-used-by-the-gateway';   // (lib/config.js would otherwise write one)
const themesLib = await import('./lib/themes.js');
const upload = multer({ dest: path.join(SHARED, 'tmp'), limits: { fileSize: 1024 * 1024 * 1024 } });
admin.get('/_superadmin/api/themes', async (req, res) => res.json(await themesLib.listThemes()));
admin.post('/_superadmin/api/themes', (req, res) => {
    upload.single('file')(req, res, async err => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        const zip = req.file.path + '.zip';
        try {
            fs.renameSync(req.file.path, zip);
            const installed = await themesLib.installThemeZip(zip, { overwrite: req.query.overwrite === '1' });
            log(`global themes installed: ${installed.join(', ')}`);
            res.json({ installed });
        } catch (e) { res.status(400).json({ error: e.message }); }
        finally { fs.rmSync(zip, { force: true }); }
    });
});
admin.delete('/_superadmin/api/themes/:name', async (req, res) => {
    // a community still using it keeps working only if it has its own copy: say which ones use it
    const users = [];
    for (const t of tenants) {
        try {
            const rooms = JSON.parse(fs.readFileSync(path.join(tenantDir(t.id), 'rooms.json'), 'utf8'));
            const own = fs.existsSync(path.join(tenantDir(t.id), 'themes', req.params.name, 'default.html'));
            if (!own && rooms.some(r => r.theme === req.params.name)) users.push(t.name);
        } catch { /* no shows */ }
    }
    if (users.length && req.query.force !== '1') return res.status(409).json({ error: `Used by: ${users.join(', ')}`, users });
    res.json({ ok: await themesLib.deleteTheme(req.params.name) });
});

// ---- the panel itself
admin.get('/_superadmin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'superadmin.html')));
admin.use('/static', express.static(path.join(ROOT, 'public'), { index: false }));
admin.get('/', (req, res) => notice(res, 404, 'Millionaire Show Control', `No community is published at ${hostOf(req) || 'this address'}.`));
admin.use((req, res) => notice(res, 404, 'Not found', 'Nothing here.'));

// ================================================================================================ server
const server = http.createServer((req, res) => {
    const t = byDomain().get(hostOf(req));
    if (t) proxyHttp(req, res, t); else admin(req, res);
});
server.on('upgrade', (req, socket, head) => {
    const t = byDomain().get(hostOf(req));
    if (t) proxyUpgrade(req, socket, head, t); else socket.destroy();
});
server.listen(PORT, HOST, () => {
    log(`Millionaire Show Control ${VERSION} - multi-tenant gateway on http://${HOST}:${PORT} (${tenants.length} communities)`);
    for (const t of tenants) startEngine(t);
});

async function shutdown() {
    log('stopping');
    server.close();
    await Promise.all(tenants.map(t => stopEngine(t.id)));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
