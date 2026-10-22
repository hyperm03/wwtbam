import crypto from 'node:crypto';
import { config } from './config.js';
import { db, users, verifyPassword } from './db.js';
import { createSession, findSession, revokeSession, revokeAccount } from './sessions.js';

/**
 * Sessions are signed cookies (HMAC-SHA256) carrying the user name, role and expiry.
 * - The built-in "admin" account uses ADMIN_PASSWORD and always works, even without MySQL (no lock-out).
 * - Every other account lives in the MySQL "users" table (scrypt hashes), roles "admin" or "operator".
 * - Host and player screens have their own per-show cookies, invalidated when the screen password changes.
 */
const cookieName = () => config.publicUrl.startsWith('https://') ? '__Host-mc_session' : 'mc_session';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
export const BUILTIN_ADMIN = 'admin';

const sign = value => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');

function signed(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${sign(body)}`;
}

function unsign(value) {
    if (!value) return null;
    const [body, sig] = String(value).split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return data.exp > Date.now() ? data : null;
    } catch {
        return null;
    }
}

export function parseCookies(header = '') {
    const out = {};
    for (const part of String(header).split(';')) {
        const i = part.indexOf('=');
        if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookies are not credentials */ } }
    }
    return out;
}

/** { user, role } of the control panel session, or null. */
export function getSession(cookieHeader) {
    return findSession(parseCookies(cookieHeader)[cookieName()]);
}
export const isAuthenticated = cookieHeader => !!getSession(cookieHeader);

export function setSessionCookie(res, session, secure) {
    secure ||= config.publicUrl.startsWith('https://');
    const row = createSession(session, 'staff', session.accountKey ? 15 * 60000 : 8 * 3600000);
    res.append('Set-Cookie', `${cookieName()}=${row.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((row.exp - Date.now()) / 1000)}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res, cookieHeader) {
    const session = getSession(cookieHeader);
    if (session?.accountKey) revokeAccount(session.accountKey);
    else if (session) revokeSession(session.id);
    res.append('Set-Cookie', `${cookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.publicUrl.startsWith('https://') ? '; Secure' : ''}`);
}

function builtinPasswordMatches(candidate) {
    const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
}

/** Checks the credentials: built-in admin first, then the MySQL users. Returns { user, role } or null. */
export async function authenticate(username, password) {
    const name = String(username ?? '').trim();
    if (!name || !password) return null;
    if (name === BUILTIN_ADMIN && builtinPasswordMatches(password)) return { user: BUILTIN_ADMIN, role: 'admin' };
    if (!db.enabled) return null;
    try {
        const u = await users.find(name);
        if (!u || !u.active || !(await verifyPassword(password, u.password_hash))) return null;
        users.touch(u.id).catch(() => { });
        return { user: u.username, role: u.role === 'admin' ? 'admin' : 'operator' };
    } catch {
        return null;
    }
}

// Brute-force protection: 10 failed attempts per IP per 15 minutes (login and screen passwords)
const failures = new Map();
export function loginAllowed(ip) {
    const e = failures.get(ip);
    if (!e) return true;
    if (Date.now() - e.first > 15 * 60 * 1000) { failures.delete(ip); return true; }
    return e.count < 10;
}
export function recordFailure(ip) {
    const e = failures.get(ip) ?? { count: 0, first: Date.now() };
    e.count++;
    failures.set(ip, e);
}

/** Express middleware: sets req.session; API calls get 401, pages go to the login page. */
export function requireAuth(req, res, next) {
    const session = getSession(req.headers.cookie);
    if (session) { req.session = session; return next(); }
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

export function requireAdmin(req, res, next) {
    const session = getSession(req.headers.cookie);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    if (session.role !== 'admin') return res.status(403).json({ error: 'Administrators only' });
    req.session = session;
    next();
}

// ---------------------------------------------------------------------------------------------- host / player screens

/** A short fingerprint of the stored password hash: changing the password invalidates every screen cookie. */
const fingerprint = hash => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 12);
const screenCookieName = (room, kind) => `mc_${kind}_${room.replace(/[^a-z0-9-]/g, '')}`;

export function setScreenCookie(res, room, kind, passwordHash, secure) {
    const value = signed({ room, kind, fp: fingerprint(passwordHash), exp: Date.now() + MAX_AGE_MS });
    res.append('Set-Cookie', `${screenCookieName(room, kind)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`);
}

export function screenAuthorized(cookieHeader, room, kind, passwordHash) {
    if (!passwordHash) return false;
    const data = unsign(parseCookies(cookieHeader)[screenCookieName(room, kind)]);
    return !!data && data.room === room && data.kind === kind && data.fp === fingerprint(passwordHash);
}
