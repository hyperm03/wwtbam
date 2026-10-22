import crypto from 'node:crypto';
import { config, installation } from './config.js';
import { createDiscordClient } from './discord-client.js';
import { parseCookies, setSessionCookie, loginAllowed, recordFailure } from './auth.js';
import { createSession, findSession, revokeSession, revokeAccount, revokeUser } from './sessions.js';
import { privacy, privacyReady, accountKey, upsertParticipant, participant, setAlias, exportParticipant, deleteParticipant, register, unregister, isCheckedIn } from './participants.js';
import { store } from './store.js';

const list = value => String(value || '').split(',').map(x => x.trim()).filter(x => /^\d{17,20}$/.test(x));
function discordSettings() {
    const get = name => installation.get(name);
    return { clientId: get('DISCORD_CLIENT_ID'), clientSecret: get('DISCORD_CLIENT_SECRET'), guildId: get('DISCORD_GUILD_ID'),
        roleIds: list(get('DISCORD_ALLOWED_ROLE_IDS')), operatorRoles: list(get('DISCORD_OPERATOR_ROLE_IDS')), adminRoles: list(get('DISCORD_ADMIN_ROLE_IDS')),
        validRoleSettings: ['DISCORD_ALLOWED_ROLE_IDS', 'DISCORD_OPERATOR_ROLE_IDS', 'DISCORD_ADMIN_ROLE_IDS'].every(name => !get(name) || get(name).split(',').every(value => /^\d{17,20}$/.test(value.trim()))) };
}
const discordClient = () => createDiscordClient(discordSettings());
const pending = new Map();
const secure = () => config.publicUrl.startsWith('https://');
const cookieName = name => secure() && !name.startsWith('__Host-') ? '__Host-' + name : name;
const cookie = (res, name, value, age) => res.append('Set-Cookie', `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure() ? '; Secure' : ''}`);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const isolatedOrigins = () => {
    try { const app = new URL(config.publicUrl), output = new URL(config.outputPublicUrl); return app.protocol === 'https:' && output.protocol === 'https:' && app.hostname !== output.hostname && app.origin === config.publicUrl && output.origin === config.outputPublicUrl; }
    catch { return false; }
};
export const discordEnabled = () => {
    const { clientId, clientSecret, guildId, operatorRoles, adminRoles, roleIds, validRoleSettings } = discordSettings();
    return installation.get('DISCORD_LOGIN_ENABLED') === '1' && privacyReady() && isolatedOrigins() && validRoleSettings && /^\d{17,20}$/.test(clientId) && !!clientSecret && (!guildId || /^\d{17,20}$/.test(guildId)) && (!(operatorRoles.length || adminRoles.length || roleIds.length) || !!guildId);
};
installation.events.on('changed', names => { if (names.length) pending.clear(); });

export function getParticipantSession(header) {
    const session = findSession(parseCookies(header)[cookieName('mc_participant')], 'participant');
    return session && participant(session.accountKey) ? session : null;
}
export function requireParticipant(req, res, next) {
    req.participant = getParticipantSession(req.headers.cookie);
    if (!req.participant) return res.status(401).json({ error: 'Sign in with Discord', login: '/account' });
    next();
}
const safeNext = value => typeof value === 'string' && /^\/(?:account(?:\?|$)|home$|v\/[a-z0-9-]+$|ff\/[a-z0-9-]+$|player\/[a-z0-9-]+$)/.test(value) ? value : '/account';
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function attachDiscordAuth(app, sendPage) {
    app.get('/privacy', (req, res) => sendPage(res, 'privacy.html'));
    app.get('/account', (req, res) => sendPage(res, 'account.html'));
    app.get('/auth/discord/status', (req, res) => {
        res.set('Cache-Control', 'no-store').json({ enabled: discordEnabled(), privacy, scopes: discordClient().scopes, membershipRequired: !!discordSettings().guildId });
    });
    app.post('/auth/discord', (req, res) => {
        if (!discordEnabled()) return res.status(503).json({ error: 'Discord login is not enabled: the operator must complete the privacy and OAuth settings' });
        if (req.body?.acknowledge !== 'yes' || req.body?.adult !== 'yes') return res.status(400).json({ error: `Read the privacy notice and confirm you are at least ${privacy.minAge}. No date of birth is collected.` });
        if (!loginAllowed(req.ip)) return res.status(429).send('Try again later');
        for (const [id, row] of pending) if (row.exp < Date.now()) pending.delete(id);
        if (pending.size >= 1000) return res.status(503).send('Try again later');
        const state = crypto.randomBytes(32).toString('base64url');
        const browser = crypto.randomBytes(32).toString('base64url');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        pending.set(hash(state), { browser: hash(browser), verifier, revision: installation.public().revision, exp: Date.now() + 300000, next: safeNext(req.body.next) });
        cookie(res, 'mc_oauth', browser, 300);
        const { clientId } = discordSettings();
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({ client_id: clientId, redirect_uri: config.publicUrl + '/auth/discord/callback', response_type: 'code', scope: discordClient().scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent' });
        res.set('Cache-Control', 'no-store').redirect(url.href);
    });
    app.get('/auth/discord/callback', asyncRoute(async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const row = pending.get(hash(state)); pending.delete(hash(state));
        const browser = parseCookies(req.headers.cookie)[cookieName('mc_oauth')] || '';
        cookie(res, 'mc_oauth', '', 0);
        if (!discordEnabled() || !row || row.exp < Date.now() || !browser || !crypto.timingSafeEqual(Buffer.from(row.browser), Buffer.from(hash(browser)))) return res.status(400).send('Invalid or expired login. Start again from /account.');
        if (req.query.iss !== 'https://discord.com') return res.status(400).send('Invalid authorization issuer');
        if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 2048) return res.redirect('/account?error=denied');
        try {
            const identity = await discordClient().identity(req.query.code, config.publicUrl + '/auth/discord/callback', row.verifier);
            if (row.revision !== installation.public().revision) throw new Error('Configuration changed; authenticate again');
            const key = accountKey(identity.id);
            upsertParticipant(key);
            const old = getParticipantSession(req.headers.cookie); if (old) revokeSession(old.id);
            const session = createSession({ accountKey: key }, 'participant', 12 * 3600000);
            cookie(res, 'mc_participant', session.token, 12 * 3600);
            const { adminRoles, operatorRoles } = discordSettings();
            const role = adminRoles.some(id => identity.roles.includes(id)) ? 'admin' : operatorRoles.some(id => identity.roles.includes(id)) ? 'operator' : null;
            revokeUser('discord-' + key.slice(0, 16));
            if (role) setSessionCookie(res, { user: 'discord-' + key.slice(0, 16), accountKey: key, role }, true);
            res.redirect(row.next === '/home' && !role ? '/account' : row.next);
        } catch {
            recordFailure(req.ip);
            // Provider payloads, codes, IDs and tokens never enter URLs or logs.
            res.redirect('/account?error=authorization');
        }
    }));
    app.get('/participant/me', requireParticipant, (req, res) => res.set('Cache-Control', 'no-store').json(exportParticipant(req.participant.accountKey)));
    app.put('/participant/me', requireParticipant, (req, res) => {
        try { res.json(setAlias(req.participant.accountKey, req.body?.alias)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.get('/participant/export', requireParticipant, (req, res) => res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="my-millionaire-data.json"' }).json(exportParticipant(req.participant.accountKey)));
    app.delete('/participant/me', requireParticipant, (req, res) => {
        deleteParticipant(req.participant.accountKey); cookie(res, 'mc_participant', '', 0); cookie(res, 'mc_session', '', 0);
        res.json({ ok: true });
    });
    app.post('/participant/logout', requireParticipant, (req, res) => {
        revokeAccount(req.participant.accountKey); cookie(res, 'mc_participant', '', 0); cookie(res, 'mc_session', '', 0); res.json({ ok: true });
    });
    app.post('/participant/rooms/:id/register', requireParticipant, (req, res) => {
        const room = store.get(req.params.id);
        if (!room || room.status === 'ended' || room.mode === 'rehearsal') return res.sendStatus(404);
        try { res.json(register(req.participant.accountKey, room.id, req.body?.checkIn === true)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/participant/rooms/:id/register', requireParticipant, (req, res) => { unregister(req.participant.accountKey, req.params.id); res.json({ ok: true }); });
}

export { isCheckedIn };
