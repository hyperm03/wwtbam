import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { config, installation } from './lib/config.js';
import { requireAuth, requireAdmin, getSession, authenticate, setSessionCookie, clearSessionCookie, loginAllowed, recordFailure, parseCookies, setScreenCookie, screenAuthorized, BUILTIN_ADMIN } from './lib/auth.js';
import { db, users, stacks, logEvent, readLogs, hashPassword, verifyPassword, ROLES } from './lib/db.js';
import { store, saveRooms, flushRooms, cleanQuestion } from './lib/store.js';
import { listThemes, installThemeZip, deleteTheme, themeDir, resolveInside, findThemeFile, fontFaceFixes, readThemeQuestions, writeThemeQuestions, themeOwner, setThemeOwner, isGlobalTheme, ownThemeDir } from './lib/themes.js';
import { branding, publicBranding } from './lib/branding.js';
import { platformSettings } from './lib/settings.js';
import { listModels } from './lib/ai.js';
import { fetchFromBuilder } from './lib/builder.js';
import { variablesPath, loadMoneyTree, cleanMoneyTree, previewMoneyTree, saveMoneyTree } from './lib/variables.js';
import { listShowEvents, showStats, clearShowEvents, EVENT_TYPES } from './lib/showlog.js';
import { schedule, eventState, DEFAULT_LOCATION } from './lib/schedule.js';
import { importDocument, extract, ACCEPTED as IMPORT_TYPES } from './lib/importer.js';
import { fffQuestions } from './lib/fff.js';
import { layoutStore, TARGETS as LAYOUT_TARGETS, ASSET_DIR as LAYOUT_ASSETS } from './lib/layouts.js';
import { roblox } from './lib/roblox.js';
import { addToBank, bankStats, listBank, getBankQuestion, updateBankQuestion, deleteBankQuestions, releaseBankQuestions, buildStacks, swapSlot, autoFillSlot, candidates } from './lib/bank.js';
import { themeAssets } from './lib/assets.js';
import { builtInKlaxon } from './lib/klaxon.js';
import { attachShows, outputUrl } from './lib/shows.js';
import { attachDiscordAuth } from './lib/discord-auth.js';
import { revokeUser } from './lib/sessions.js';
import { attachOperations } from './lib/operations.js';
import { attachSetup, setupRequired } from './lib/setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');
const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, allowRequest: (req, done) => {
    const origin = req.headers.origin;
    const allowed = config.publicUrl || `http://${req.headers.host}`;
    const query = new URL(req.url, 'http://local').searchParams;
    const output = query.get('role') === 'output';
    const onOutputHost = config.outputPublicUrl && req.headers.host === new URL(config.outputPublicUrl).host;
    done(null, onOutputHost ? output && (!origin || origin === config.outputPublicUrl) : !origin || origin === allowed);
} });
const shows = attachShows(io);

const noStore = res => res.setHeader('Cache-Control', 'no-store, max-age=0');
const baseUrl = req => config.publicUrl || `${req.protocol}://${req.get('host')}`;
const secure = req => req.secure;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const onOutputHost = config.outputPublicUrl && req.get('host') === new URL(config.outputPublicUrl).host;
    const themePath = req.path.startsWith('/o/') || req.path.startsWith('/output/');
    if (onOutputHost && !themePath && !['/static/output-shim.js', '/static/bridge.js', '/static/klaxon.wav'].includes(req.path)) return res.sendStatus(404);
    if (config.outputPublicUrl && themePath && !onOutputHost) {
        if (req.method !== 'GET') return res.sendStatus(404);
        return res.redirect(config.outputPublicUrl + req.originalUrl);
    }
    if (['/account', '/privacy', '/login', '/setup'].includes(req.path)) res.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com");
    if (req.path.startsWith('/auth/') || req.path.startsWith('/participant/') || req.path.startsWith('/api/')) noStore(res);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const allowed = config.publicUrl || `${req.protocol}://${req.get('host')}`;
        if ((req.headers.origin && req.headers.origin !== allowed) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request refused' });
    }
    next();
});
// Every start gets a build number: the pages ask for their /static files with ?v=<build>, so browsers and proxies
// (e.g. Nginx Proxy Manager "Cache Assets") always load the files of the version that is running.
const BUILD = Date.now().toString(36);
const pageCache = new Map();
function sendPage(res, name) {
    noStore(res);
    let html = pageCache.get(name);
    if (!html) {
        html = fs.readFileSync(path.join(pub, name), 'utf8').replace(/((?:src|href)=")(\/static\/[^"?#]+)(")/g, `$1$2?v=${BUILD}$3`);
        pageCache.set(name, html);
    }
    res.type('html').send(html);
}

app.get('/favicon.ico', (req, res) => res.sendFile(path.join(pub, 'brand', 'favicon.ico')));
// Custom graphics of the host / player screens (e.g. another Q4ALoz.jpg) go in data/screens: they take precedence
// over the built-in ones and survive updates of the program
const customScreens = path.join(config.dataDir, 'screens');
try { fs.mkdirSync(customScreens, { recursive: true }); } catch { /* read-only data folder */ }
// Pictures uploaded in the Layout editor (plain graphics, by content hash)
app.use('/layout-assets', express.static(LAYOUT_ASSETS, { index: false, maxAge: '30d', immutable: true }));
app.use('/static/screens', express.static(customScreens, { index: false, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/static', express.static(pub, { index: false, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/static/klaxon.wav', (req, res) => {
    res.type('audio/wav').send(builtInKlaxon());
});

// ---------------------------------------------------------------------------------------------- login

app.get('/login', (req, res) => sendPage(res, 'login.html'));
attachDiscordAuth(app, sendPage);
attachSetup(app, sendPage);

app.post('/login', async (req, res) => {
    const ip = req.ip;
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/home';
    if (!loginAllowed(ip)) return res.redirect('/login?error=locked');
    const session = await authenticate(req.body.username, req.body.password);
    if (!session) {
        recordFailure(ip);
        logEvent('login.failed', { user: String(req.body.username || '').slice(0, 64), ip });
        return res.redirect('/login?error=1&next=' + encodeURIComponent(next));
    }
    setSessionCookie(res, session, secure(req));
    logEvent('login', { user: session.user, ip, details: { role: session.role } });
    res.redirect(setupRequired(session) ? '/setup' : next);
});

app.post('/logout', (req, res) => {
    const session = getSession(req.headers.cookie);
    if (session) logEvent('logout', { user: session.user, ip: req.ip });
    clearSessionCookie(res, req.headers.cookie);
    res.redirect('/login');
});

// The address of the site opens the staff home page (or the login page first)
app.get('/', (req, res) => { noStore(res); res.redirect(getSession(req.headers.cookie) ? '/home' : '/login'); });
app.get('/home', requireAuth, (req, res) => setupRequired(req.session) ? res.redirect('/setup') : sendPage(res, 'home.html'));

/** Shows on air now: output connected and not ended. */
function liveRooms() {
    return new Set(store.list().filter(r => r.status !== 'ended' && shows.summary(r.id).outputs > 0).map(r => r.id));
}

app.get('/control', requireAuth, (req, res) => setupRequired(req.session) ? res.redirect('/setup') : sendPage(res, 'control.html'));

// ---------------------------------------------------------------------------------------------- branding
/** Name, logo and defaults of the community (public: used by the login page, the invitations...). */
app.get('/api/branding', (req, res) => { res.set('Cache-Control', 'no-cache'); res.json(publicBranding()); });

// ---------------------------------------------------------------------------------------------- Fastest Finger client app
/** Shows whose Fastest Finger consoles are on (a password is set): only id and name, for the FFF client app. */
app.get('/api/ff-public/shows', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(store.list().filter(r => r.screens?.ff && r.status !== 'ended').map(r => ({ id: r.id, name: r.name })));
});

// ---------------------------------------------------------------------------------------------- Roblox set (called by the game)
/** The Roblox game server authenticates with the show's secret key (header X-Roblox-Key). */
function robloxRoom(req, res) {
    const room = store.get(req.params.room);
    if (!room || !roblox.authorised(room, req.get('X-Roblox-Key'))) { res.status(403).json({ error: 'Not authorised: check the show id and the key, and that the Roblox link is on' }); return null; }
    return room;
}
app.post('/roblox-link/:room/hello', (req, res) => {
    const room = robloxRoom(req, res); if (!room) return;
    roblox.hello(room, req.body || {});
    shows.event(room, 'screen', `Roblox set connected (place ${req.body?.placeId ?? '?'}, ${Array.isArray(req.body?.buttons) ? req.body.buttons.length : 0} buttons)`);
    res.json({ ok: true, show: room.name });
});
app.get('/roblox-link/:room/poll', (req, res) => {
    const room = robloxRoom(req, res); if (!room) return;
    res.set('Cache-Control', 'no-store');
    res.json(roblox.poll(room, req.query.since, { jobId: String(req.query.job || 'studio'), placeId: req.query.place, players: Number(req.query.players) || 0 }));
});
app.post('/roblox-link/:room/report', (req, res) => {
    const room = robloxRoom(req, res); if (!room) return;
    const b = req.body || {};
    if (b.type === 'pressed' && b.path) shows.robloxPressed(room, String(b.path).slice(0, 300), String(b.player || '').slice(0, 60));
    res.json({ ok: true });
});

/** Layout editor preview: the screen or console with sample data, editable (administrators). */
app.get('/layout-preview/:target', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).send('Administrators only');
    if (!LAYOUT_TARGETS.includes(req.params.target)) return res.sendStatus(404);
    sendPage(res, req.params.target === 'ff' ? 'ff.html' : 'screen.html');
});

// ---------------------------------------------------------------------------------------------- font bridges for the output
/**
 * Some themes use font names they never declare, relying on fonts installed on the author's computer:
 * - Clocked: "Arial Narrow" (gold clock of question 15, banked time) and "DIN" (audience percentages);
 * - 2002_Classic: "Conduit ITC" (audience percentages).
 * These rules link those names to the files already in the theme's Fonts folder. The installed font, when there is
 * one, still comes first (local), so a computer that has it shows exactly the same thing; a missing file is simply
 * skipped by the browser. Relative URLs resolve against the theme page (/o/<show>/<load>/Fonts/...).
 */
const FONT_BRIDGES = `
<style id="mc-font-bridges">
@font-face { font-family: 'Arial Narrow'; font-weight: normal; src: local('Arial Narrow'), local('ArialNarrow'), url('Fonts/ARIALN.TTF') format('truetype'); }
@font-face { font-family: 'Arial Narrow'; font-weight: bold; src: local('Arial Narrow Bold'), local('ArialNarrow-Bold'), url('Fonts/ARIALNB.TTF') format('truetype'); }
@font-face { font-family: 'DIN'; src: local('DIN'), local('DIN Pro'), url('Fonts/din_pro_bold.ttf') format('truetype'); }
@font-face { font-family: 'Conduit ITC'; src: local('Conduit ITC'), local('ConduitITC'), url('Fonts/ITC%20Conduit.ttf') format('truetype'), url('Fonts/Conduit.woff') format('woff'), url('Fonts/Conduit.ttf') format('truetype'); }
</style>`;

// ---------------------------------------------------------------------------------------------- public event pages (invitations)

const htmlEscape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inviteUrl = (req, e) => `${baseUrl(req)}/e/${e.slug}`;

/** What anyone with the invitation link may see: no internal data (no output links, tokens or show ids). */
function publicEvent(e) {
    const state = eventState(e, liveRooms());
    const room = e.room ? store.get(e.room) : null;
    return {
        title: e.title, start: e.start, duration: e.duration, description: e.description, live: e.live !== false,
        location: e.location || DEFAULT_LOCATION.name, locationUrl: e.locationUrl || DEFAULT_LOCATION.url, link: e.link || null, state,
        // While the show is on air the audience can vote from the invitation page
        vote: state === 'live' && room && room.status !== 'ended' ? `/v/${encodeURIComponent(room.id)}` : null
    };
}

/** "Add to my calendar" (iCalendar), for Google, Apple and Outlook calendars. */
app.get('/e/:slug.ics', (req, res) => {
    const e = schedule.bySlug(req.params.slug);
    if (!e) return res.sendStatus(404);
    const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const text = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
    const end = new Date(Date.parse(e.start) + e.duration * 60000);
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TPH//Millionaire Show//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT', `UID:${e.slug}@tph-millionaire`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(end)}`,
        `SUMMARY:${text(e.title)}`, `DESCRIPTION:${text([e.description, e.locationUrl, inviteUrl(req, e)].filter(Boolean).join('\n\n'))}`,
        `LOCATION:${text(e.location || DEFAULT_LOCATION.name)}`, `URL:${inviteUrl(req, e)}`,
        ...(e.status === 'cancelled' ? ['STATUS:CANCELLED'] : []),
        'END:VEVENT', 'END:VCALENDAR'
    ];
    res.type('text/calendar').setHeader('Content-Disposition', `attachment; filename="${e.slug}.ics"`);
    res.send(lines.join('\r\n'));
});

/** The invitation page, with the Open Graph tags that make Discord show a preview card of the event. */
app.get('/e/:slug', (req, res) => {
    const e = schedule.bySlug(req.params.slug);
    noStore(res);
    if (!e) return res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Event not found</title><body style="font:20px Segoe UI,Arial;background:#1d0b3a;color:#fff;display:flex;align-items:center;justify-content:center;height:90vh">This invitation does not exist (any more).</body>');
    const when = new Date(e.start).toUTCString().replace(':00 GMT', ' UTC');
    const summary = `${e.status === 'cancelled' ? 'CANCELLED - ' : ''}${e.live !== false ? 'LIVE · ' : ''}${when} · ${e.location || DEFAULT_LOCATION.name}` +
        (e.description ? ` - ${e.description.slice(0, 200)}` : '');
    let html = pageCache.get('event.html');
    if (!html) {
        html = fs.readFileSync(path.join(pub, 'event.html'), 'utf8').replace(/((?:src|href)=")(\/static\/[^"?#]+)(")/g, `$1$2?v=${BUILD}$3`);
        pageCache.set('event.html', html);
    }
    const b = branding();
    html = html.replaceAll('/static/brand/tph-circle', b.logo)
        .replaceAll('Join the TPH Discord server', htmlEscape(b.joinLabel))
        .replaceAll('https://discord.gg/QZMmsRTKrw', htmlEscape(b.locationUrl || '#'))
        .replaceAll('TPH Discord server', htmlEscape(b.locationName))
        .replaceAll('TPH presents', htmlEscape(b.presents))
        .replaceAll('a TPH fan event', htmlEscape(b.footer))
        .replaceAll('TPH', htmlEscape(b.name));
    res.type('html').send(html
        .replaceAll('{{TITLE}}', htmlEscape(e.title))
        .replaceAll('{{SUMMARY}}', htmlEscape(summary))
        .replaceAll('{{URL}}', htmlEscape(inviteUrl(req, e)))
        .replaceAll('{{IMAGE}}', htmlEscape(`${baseUrl(req)}${branding().logo}-512.png`))
        .replaceAll('{{SLUG}}', htmlEscape(e.slug)));
});

app.get('/api/event/:slug', (req, res) => {
    noStore(res);
    const e = schedule.bySlug(req.params.slug);
    if (!e) return res.status(404).json({ error: 'This invitation does not exist' });
    res.json({ ...publicEvent(e), now: new Date().toISOString() });
});

// ---------------------------------------------------------------------------------------------- audience keypad

app.get('/v/:room', (req, res) => {
    noStore(res);
    if (!store.get(req.params.room)) return res.status(404).send('This show does not exist.');
    sendPage(res, 'vote.html');
});

app.get('/api/rooms/:id/vote-qr.svg', async (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    const svg = await QRCode.toString(`${baseUrl(req)}/v/${encodeURIComponent(room.id)}`, { type: 'svg', margin: 1, width: 320 });
    noStore(res);
    res.type('image/svg+xml').send(svg);
});

// ---------------------------------------------------------------------------------------------- host and player screens

const SCREEN_PAGES = { host: 'screen.html', player: 'screen.html', ff: 'ff.html' };
for (const kind of ['host', 'player', 'ff']) {
    app.get(`/${kind}/:room`, (req, res) => {
        noStore(res);
        const room = store.get(req.params.room);
        if (!room) return res.status(404).send('This show does not exist.');
        if (room.status === 'ended') return res.status(410).send(`<body style="background:#000;color:#fff;font:600 32px Segoe UI,Arial;display:flex;align-items:center;justify-content:center;height:90vh">${room.name}: this show has ended.</body>`);
        if (!room.screens?.[kind]) return sendPage(res, 'screen-login.html');
        sendPage(res, screenAuthorized(req.headers.cookie, room.id, kind, room.screens[kind]) ? SCREEN_PAGES[kind] : 'screen-login.html');
    });

    app.post(`/${kind}/:room/login`, async (req, res) => {
        const room = store.get(req.params.room);
        if (!room) return res.sendStatus(404);
        // A physical Fastest Finger console keeps its seat (?seat=N) through the sign-in
        const seat = Number(req.query.seat);
        const back = `/${kind}/${encodeURIComponent(room.id)}` + (kind === 'ff' && seat >= 1 && seat <= 10 ? `?seat=${seat}` : '');
        if (!room.screens?.[kind]) return res.redirect(back + (back.includes('?') ? '&' : '?') + 'error=disabled');
        if (!loginAllowed(req.ip)) return res.redirect(back + (back.includes('?') ? '&' : '?') + 'error=locked');
        if (!(await verifyPassword(req.body.password, room.screens[kind]))) {
            recordFailure(req.ip);
            logEvent(`screen.${kind}.failed`, { room: room.id, ip: req.ip });
            shows.event(room, 'screen', `Wrong ${kind} screen password from ${req.ip}`);
            return res.redirect(back + (back.includes('?') ? '&' : '?') + 'error=1');
        }
        setScreenCookie(res, room.id, kind, room.screens[kind], secure(req));
        logEvent(`screen.${kind}.open`, { room: room.id, ip: req.ip });
        shows.event(room, 'screen', `${{ host: 'Host screen', player: 'Player screen', ff: 'Fastest Finger console' }[kind]} signed in from ${req.ip}`);
        res.redirect(back);
    });
}

/** Fonts of the show's theme (e.g. Conduit ITC) for the host / player screens and the consoles. */
app.get('/screen-font/:room/:file', (req, res) => {
    const room = store.get(req.params.room);
    if (!room?.theme) return res.sendStatus(404);
    const allowed = ['host', 'player', 'ff'].some(k => screenAuthorized(req.headers.cookie, room.id, k, room.screens?.[k])) || getSession(req.headers.cookie);
    if (!allowed) return res.sendStatus(403);
    if (!/\.(ttf|otf|woff2?|eot)$/i.test(req.params.file)) return res.sendStatus(404);
    const dir = themeDir(room.theme);
    const file = dir && findThemeFile(dir, 'Fonts/' + req.params.file);
    if (!file) return res.sendStatus(404);
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

app.get('/screen-status/:room/:kind', (req, res) => {
    const room = store.get(req.params.room);
    res.json({ exists: !!room, enabled: !!room?.screens?.[req.params.kind], show: room?.name ?? '' });
});

// ---------------------------------------------------------------------------------------------- game output

/** Stable link for OBS: always forwards to the current load of the show's theme. */
app.get('/output/:room', (req, res) => {
    const room = store.get(req.params.room);
    if (!room || req.query.t !== room.outputToken) return res.status(403).send('Invalid output link.');
    noStore(res);
    const options = ['bg', 'nooverlay', 'start', 'sound'].filter(k => /^[a-z0-9]{1,12}$/i.test(String(req.query[k] ?? ''))).map(k => `&${k}=${req.query[k]}`).join('');
    res.redirect(outputUrl(room) + options);
});

/**
 * Theme files, under a path that changes at every load (/o/<room>/<loadId>/...) and are never cached.
 * default.html gets the bridge injected; the output token is kept in a cookie scoped to this show's path so that
 * the theme's own requests (scripts, images, questions.xml) are authorised too.
 */
app.get('/o/:room/:load/*', (req, res) => {
    const room = store.get(req.params.room);
    if (!room) return res.sendStatus(404);
    const dir = themeDir(room.theme);
    if (!dir) return res.status(404).send('This show has no theme yet: choose one in the control panel.');

    const file = req.params[0] || 'default.html';
    const cookieName = 'mc_out_' + room.id.replace(/[^a-z0-9-]/g, '');
    const tokenOk = req.query.t === room.outputToken || parseCookies(req.headers.cookie)[cookieName] === room.outputToken;
    if (!tokenOk) return res.status(403).send('Invalid output link.');
    noStore(res);

    if (file === 'default.html') {
        if (String(req.params.load) !== String(room.loadId)) {
            const options = ['bg', 'nooverlay', 'start', 'sound'].filter(k => /^[a-z0-9]{1,12}$/i.test(String(req.query[k] ?? ''))).map(k => `&${k}=${req.query[k]}`).join('');
            return res.redirect(outputUrl(room) + options);
        }
        res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(room.outputToken)}; Path=/o/${encodeURIComponent(room.id)}/; HttpOnly; SameSite=Lax`);
        res.setHeader('Clear-Site-Data', '"cache"');
        let html = fs.readFileSync(path.join(dir, 'default.html'), 'utf8');
        const inject = FONT_BRIDGES + fontFaceFixes(dir) + `\n<script>window.__MC=${JSON.stringify({ room: room.id, token: room.outputToken })};</script>` +
            `\n<script src="/socket.io/socket.io.js"></script>\n<script src="/static/output-shim.js?v=${BUILD}"></script>\n`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, inject + '</body>') : html + inject;
        return res.type('html').send(html);
    }

    // Exact file, else the same name ignoring case, else (fonts) the shared fonts
    const target = findThemeFile(dir, file);
    if (!target) return res.sendStatus(404);
    res.sendFile(target, { dotfiles: 'deny', headers: { 'Cache-Control': 'no-store, max-age=0' } });
});

// ---------------------------------------------------------------------------------------------- API (control panel)

app.use('/api', requireAuth);
app.use('/api/schedule', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.body?.discordNotify !== undefined && req.session.role !== 'admin') return res.status(403).json({ error: 'Only administrators can enable Discord announcements' });
    next();
});
attachOperations(app, { shows, io });

app.get('/api/config', (req, res) => res.json({
    publicUrl: baseUrl(req), outputPublicUrl: config.outputPublicUrl || baseUrl(req), maxUploadMb: config.maxUploadMb, builder: !!config.builderUrl,
    user: req.session.user, role: req.session.role, database: db.enabled
}));

const audit = (req, action, details, room = null) => logEvent(action, { user: req.session?.user, room, details, ip: req.ip });

// ---------------------------------------------------------------------------------------------- admin: connections, users, logs

app.use('/api/admin', requireAdmin);

app.get('/api/admin/status', (req, res) => res.json({ database: { connected: db.enabled, error: db.lastError } }));

app.post('/api/admin/mysql/test', async (req, res) => {
    const saved = platformSettings.get().mysql;
    const m = { ...saved, ...req.body, password: req.body?.password || saved.password };
    res.json(await db.test(m));
});

app.put('/api/admin/mysql', async (req, res) => {
    platformSettings.update({ mysql: req.body || {} });
    const result = await db.connect();
    audit(req, 'admin.mysql', { enabled: platformSettings.get().mysql.enabled, connected: result.ok });
    res.json({ ...result, settings: platformSettings.public().mysql });
});

app.get('/api/admin/users', async (req, res) => {
    try { res.json({ builtin: BUILTIN_ADMIN, users: await users.list() }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

const validUser = name => /^[A-Za-z0-9._-]{3,64}$/.test(name || '');
app.post('/api/admin/users', async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!validUser(username) || username === BUILTIN_ADMIN) return res.status(400).json({ error: 'User name: 3-64 letters, numbers, dot, dash or underscore (not "admin")' });
    if (String(password || '').length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters' });
    try {
        await users.create(username, password, ROLES.includes(role) ? role : 'operator');
        audit(req, 'admin.user.create', { username, role });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: /Duplicate/i.test(e.message) ? 'A user with this name already exists' : e.message });
    }
});

app.put('/api/admin/users/:id', async (req, res) => {
    const { password, role, active } = req.body || {};
    if (password && String(password).length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters' });
    try {
        const before = (await users.list()).find(u => Number(u.id) === Number(req.params.id));
        await users.update(Number(req.params.id), { password, role: ROLES.includes(role) ? role : undefined, active });
        if (before) revokeUser(before.username);
        audit(req, 'admin.user.update', { id: Number(req.params.id), role, active, password: password ? 'changed' : undefined });
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const before = (await users.list()).find(u => Number(u.id) === Number(req.params.id));
        await users.remove(Number(req.params.id));
        if (before) revokeUser(before.username);
        audit(req, 'admin.user.delete', { id: Number(req.params.id) });
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/logs', async (req, res) => {
    try { res.json({ source: db.enabled ? 'mysql' : 'file', logs: await readLogs(req.query) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------------------------- question stacks

const stackError = (res, e) => res.status(db.enabled ? 400 : 503).json({ error: e.message });

app.get('/api/stacks', async (req, res) => {
    try { res.json(await stacks.list()); } catch (e) { stackError(res, e); }
});
app.get('/api/stacks/:id', async (req, res) => {
    try { const s = await stacks.get(Number(req.params.id)); s ? res.json(s) : res.sendStatus(404); } catch (e) { stackError(res, e); }
});
/** Saves a show's questions (or the given ones) as a new stack. */
app.post('/api/stacks', async (req, res) => {
    try {
        const { name, source, roomId, main, sw } = req.body || {};
        const room = roomId ? store.get(roomId) : null;
        const m = main ?? room?.questions.main ?? [], r = sw ?? room?.questions.sw ?? [];
        const slots = [...m.map((q, i) => ({ level: i + 1, replacement: false, question: q })), ...r.map((q, i) => ({ level: i + 1, replacement: true, question: q }))];
        const id = await stacks.save({ name: String(name || room?.name || 'Stack'), source: ['manual', 'builder', 'xml', 'gemini', 'ollama', 'file'].includes(source) ? source : 'manual', user: req.session.user, slots });
        audit(req, 'stack.save', { id, name, source }, roomId || null);
        res.json({ id });
    } catch (e) { stackError(res, e); }
});
app.put('/api/stacks/:id', async (req, res) => {
    try {
        if (req.body?.name) await stacks.rename(Number(req.params.id), req.body.name);
        audit(req, 'stack.rename', { id: Number(req.params.id), name: req.body?.name });
        res.json({ ok: true });
    } catch (e) { stackError(res, e); }
});
app.delete('/api/stacks/:id', async (req, res) => {
    try {
        await stacks.remove(Number(req.params.id));
        audit(req, 'stack.delete', { id: Number(req.params.id) });
        res.json({ ok: true });
    } catch (e) { stackError(res, e); }
});

// ---------------------------------------------------------------------------------------------- import questions from documents

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
app.post('/api/import', (req, res) => {
    importUpload.single('file')(req, res, async err => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 25 MB' : err.message });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        // Browsers send UTF-8 file names; multer reads them as Latin-1
        const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        if (!IMPORT_TYPES.includes(path.extname(name).toLowerCase())) return res.status(400).json({ error: `Unsupported file: use ${IMPORT_TYPES.join(', ')}` });
        try {
            const useAi = req.query.ai === '1';
            const result = await importDocument(req.file.buffer, name, { useAi, ai: platformSettings.get().ai, signal: AbortSignal.timeout(10 * 60 * 1000) });
            audit(req, 'import.file', { file: name, method: result.method, count: result.count }, req.query.room || null);
            const room = store.get(String(req.query.room || ''));
            if (room) shows.event(room, 'control', `Read ${result.count} question(s) from the file ${name} (${result.method})`, { user: req.session.user });
            res.json(result);
        } catch (e) {
            res.status(400).json({ error: e.name === 'TimeoutError' ? 'The AI did not finish within 10 minutes' : e.message });
        }
    });
});

// ---------------------------------------------------------------------------------------------- question bank and stack builder

const bankError = (res, e) => res.status(db.enabled ? 400 : 503).json({ error: db.enabled ? e.message : 'The question bank needs the MySQL database (Admin → Connections)' });
const uidList = v => (Array.isArray(v) ? v : []).map(String).filter(u => /^Q-\d{6,}$/.test(u)).slice(0, 5000);

app.get('/api/bank/stats', async (req, res) => { try { res.json(await bankStats()); } catch (e) { bankError(res, e); } });
app.get('/api/bank/questions', async (req, res) => { try { res.json(await listBank(req.query)); } catch (e) { bankError(res, e); } });
app.get('/api/bank/questions/:uid', async (req, res) => {
    try { const q = await getBankQuestion(req.params.uid); q ? res.json(q) : res.sendStatus(404); } catch (e) { bankError(res, e); }
});
app.put('/api/bank/questions/:uid', async (req, res) => {
    try {
        const q = await updateBankQuestion(req.params.uid, req.body || {});
        audit(req, 'bank.edit', { uid: req.params.uid, fields: Object.keys(req.body || {}) });
        res.json(q);
    } catch (e) { bankError(res, e); }
});
app.post('/api/bank/delete', requireAdmin, async (req, res) => {
    try {
        const n = await deleteBankQuestions(uidList(req.body?.uids));
        audit(req, 'bank.delete', { count: n });
        res.json({ deleted: n });
    } catch (e) { bankError(res, e); }
});
/** Out of their stack; "clearUsed" (administrators) also makes used questions available again, e.g. for a rerun. */
app.post('/api/bank/release', async (req, res) => {
    if (req.body?.clearUsed && req.session.role !== 'admin') return res.status(403).json({ error: 'Only administrators can clear the "used" mark' });
    try {
        const n = await releaseBankQuestions(uidList(req.body?.uids), { clearUsed: !!req.body?.clearUsed });
        audit(req, 'bank.release', { count: n, clearUsed: !!req.body?.clearUsed });
        res.json({ released: n });
    } catch (e) { bankError(res, e); }
});
/** Questions sent from the file importer (or anywhere else) into the bank. */
app.post('/api/bank/add', async (req, res) => {
    try {
        const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 20000);
        const r = await addToBank(items, { source: String(req.body?.source || 'file').slice(0, 24), sourceRef: String(req.body?.sourceRef || '').slice(0, 200) || null, user: req.session.user });
        audit(req, 'bank.add', { added: r.added, duplicates: r.duplicates, source: req.body?.source });
        res.json({ added: r.added, duplicates: r.duplicates, skipped: r.skipped });
    } catch (e) { bankError(res, e); }
});
/** A whole document straight into the bank (difficulty kept where the file states it). */
app.post('/api/bank/import', (req, res) => {
    importUpload.single('file')(req, res, async err => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 25 MB' : err.message });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        if (!IMPORT_TYPES.includes(path.extname(name).toLowerCase())) return res.status(400).json({ error: `Unsupported file: use ${IMPORT_TYPES.join(', ')}` });
        try {
            const doc = await importDocument(req.file.buffer, name, { useAi: req.query.ai === '1', ai: platformSettings.get().ai, signal: AbortSignal.timeout(20 * 60 * 1000) });
            const complete = doc.items.filter(it => it.correctKnown && it.question.answers.every(Boolean));
            const r = await addToBank(complete.map(it => ({ question: it.question, difficulty: it.difficulty, difficultySource: 'file' })),
                { source: 'file', sourceRef: name, user: req.session.user });
            audit(req, 'bank.import', { file: name, method: doc.method, found: doc.count, added: r.added, duplicates: r.duplicates });
            res.json({
                file: name, method: doc.method, found: doc.count, added: r.added, duplicates: r.duplicates,
                incomplete: doc.count - complete.length, rated: complete.filter(it => it.difficulty).length, notes: doc.notes
            });
        } catch (e) {
            res.status(400).json({ error: e.name === 'TimeoutError' ? 'The import did not finish within 20 minutes' : e.message });
        }
    });
});
app.post('/api/bank/build', async (req, res) => {
    try {
        const r = await buildStacks({
            count: Math.max(0, Number(req.body?.count) || 0),
            prefix: String(req.body?.prefix || 'Stack').trim().slice(0, 60) || 'Stack',
            replacements: req.body?.replacements !== false,
            maxDeviation: Math.min(2, Math.max(0, Number(req.body?.maxDeviation) || 0)),
            user: req.session.user
        });
        audit(req, 'bank.build', { created: r.created.length, shortageAtLevel: r.shortageAtLevel });
        res.json(r);
    } catch (e) { bankError(res, e); }
});
/** One stack picked at random: one available question per difficulty level (main game, replacements or both). */
app.post('/api/bank/random-stack', async (req, res) => {
    const only = ['main', 'replacement', 'both'].includes(req.body?.set) ? req.body.set : 'main';
    try {
        const r = await buildStacks({
            count: 1, only, name: String(req.body?.name || '').trim() || null, prefix: 'Stack',
            replacements: only === 'both', maxDeviation: Math.min(2, Math.max(0, Number(req.body?.maxDeviation) || 0)), user: req.session.user
        });
        audit(req, 'bank.randomStack', { set: only, created: r.created[0]?.id ?? null, shortageAtLevel: r.shortageAtLevel });
        if (!r.created.length) return res.status(400).json({ error: `Not enough available questions for difficulty level ${r.shortageAtLevel}: import, generate or rate more, or allow a tolerance.` });
        res.json(r.created[0]);
    } catch (e) { bankError(res, e); }
});

app.get('/api/bank/candidates', async (req, res) => {
    try { res.json(await candidates(Number(req.query.level) || 1, { q: String(req.query.q || '') })); } catch (e) { bankError(res, e); }
});
/** Stack slot: put a given bank question (uid), fill it automatically (auto) or empty it (uid null). */
app.post('/api/stacks/:id/slot', async (req, res) => {
    const id = Number(req.params.id), set = req.body?.set === 'replacement' ? 'replacement' : 'main', level = Number(req.body?.level);
    if (!(level >= 1 && level <= 15)) return res.status(400).json({ error: 'Invalid level' });
    try {
        let uid = null;
        if (req.body?.auto) uid = await autoFillSlot(id, set, level);
        else { uid = req.body?.uid || null; await swapSlot(id, set, level, uid); }
        audit(req, 'stack.slot', { id, set, level, uid, auto: !!req.body?.auto });
        res.json({ uid });
    } catch (e) { bankError(res, e); }
});

// ---------------------------------------------------------------------------------------------- Fastest Finger questions

app.get('/api/fff/questions', (req, res) => res.json(fffQuestions.list()));
app.post('/api/fff/questions', (req, res) => {
    try { const q = fffQuestions.create(req.body || {}, req.session.user); audit(req, 'fff.question.create', { uid: q.uid }); res.json(q); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/fff/questions/:uid', (req, res) => {
    try {
        if (typeof req.body?.used === 'boolean' && Object.keys(req.body).length === 1) {
            fffQuestions.setUsed(req.params.uid, req.body.used);
            audit(req, 'fff.question.used', { uid: req.params.uid, used: req.body.used });
            return res.json(fffQuestions.get(req.params.uid));
        }
        const q = fffQuestions.update(req.params.uid, req.body || {});
        audit(req, 'fff.question.update', { uid: q.uid });
        res.json(q);
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/fff/questions/:uid', (req, res) => {
    fffQuestions.remove(req.params.uid);
    audit(req, 'fff.question.delete', { uid: req.params.uid });
    res.json({ ok: true });
});
/** CSV or Excel: Domanda/Question, A, B, C, D, Ordine corretto/Order (e.g. BDAC). */
app.post('/api/fff/import', (req, res) => {
    importUpload.single('file')(req, res, async err => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 25 MB' : err.message });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        try {
            const data = await extract(req.file.buffer, name);
            if (data.kind !== 'table') throw new Error('Use a CSV or Excel file with the columns Domanda, A, B, C, D, Ordine corretto');
            const r = fffQuestions.importRows(data.rows, req.session.user);
            audit(req, 'fff.import', { file: name, ...r });
            res.json(r);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
});

// ---------------------------------------------------------------------------------------------- Layout editor

app.get('/api/layouts', (req, res) => res.json(Object.fromEntries(LAYOUT_TARGETS.map(t => [t, layoutStore.get(t)]))));
app.put('/api/layouts/:target', requireAdmin, (req, res) => {
    if (!LAYOUT_TARGETS.includes(req.params.target)) return res.sendStatus(404);
    try {
        const rules = layoutStore.set(req.params.target, req.body?.rules);
        shows.broadcastLayout(req.params.target);
        if (req.body?.log) audit(req, 'layout.save', { target: req.params.target, elements: Object.keys(rules).length });
        res.json({ rules, css: layoutStore.css(req.params.target) });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/layouts/:target/css', (req, res) => {
    if (!LAYOUT_TARGETS.includes(req.params.target)) return res.sendStatus(404);
    res.type('text/css').send(layoutStore.css(req.params.target));
});
app.post('/api/layouts/asset', requireAdmin, (req, res) => {
    importUpload.single('file')(req, res, err => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The picture is larger than 25 MB' : err.message });
        if (!req.file) return res.status(400).json({ error: 'No picture received' });
        try { res.json({ url: layoutStore.saveAsset(req.file.buffer, Buffer.from(req.file.originalname, 'latin1').toString('utf8')) }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
});

// ---------------------------------------------------------------------------------------------- Roblox set (control panel)

app.get('/api/rooms/:id/roblox', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    const cfg = roblox.config(room);
    res.json({ enabled: cfg.enabled, key: req.session.role === 'admin' ? cfg.key : null, mapping: cfg.mapping, custom: !!cfg.custom, lifelineTypes: roblox.lifelineTypes, events: roblox.events.map(([id, label]) => ({ id, label })), status: roblox.status(room), baseUrl: baseUrl(req) });
});
app.put('/api/rooms/:id/roblox', requireAdmin, (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') roblox.config(room).enabled = b.enabled;
    if (b.newKey) roblox.newKey(room);
    if (b.resetMapping) roblox.resetMapping(room);
    if (b.mapping) roblox.setMapping(room, b.mapping);
    saveRooms();
    audit(req, 'roblox.settings', { enabled: room.roblox.enabled, newKey: !!b.newKey, mapping: !!b.mapping }, room.id);
    res.json({ enabled: room.roblox.enabled, key: room.roblox.key, mapping: room.roblox.mapping });
});
app.post('/api/rooms/:id/roblox/press', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    if (!room.roblox?.enabled) return res.status(400).json({ error: 'The Roblox link of this show is off' });
    roblox.press(room, String(req.body?.path || '').slice(0, 300));
    shows.event(room, 'control', `Roblox set: pressed ${String(req.body?.path).replace(/^Workspace\./, '')} from the control room`, { user: req.session.user });
    res.json({ ok: true });
});
/** The Luau scripts for the set, the link one already configured for this show. */
app.get('/api/rooms/:id/roblox/:file', requireAdmin, (req, res) => {
    const room = store.get(req.params.id);
    // Install / Uninstall: one-line versions for Studio's command bar (it may keep only the first line of a pasted text)
    const files = { 'MillionaireLink.lua': 'MillionaireLink.lua', 'MillionaireButtons.lua': 'MillionaireButtons.lua', 'Install.lua': 'Install.oneline.lua', 'Uninstall.lua': 'Uninstall.oneline.lua', 'Install-commented.lua': 'Install.lua', 'Uninstall-commented.lua': 'Uninstall.lua', 'MillionairePlugin.lua': 'MillionairePlugin.lua' };
    if (!room || !files[req.params.file]) return res.sendStatus(404);
    let text = fs.readFileSync(path.join(pub, 'roblox', files[req.params.file]), 'utf8');
    if (req.params.file === 'MillionaireLink.lua') {
        const cfg = roblox.config(room);
        text = text.replace('{{BASE_URL}}', baseUrl(req)).replace('{{SHOW_ID}}', room.id).replace('{{KEY}}', cfg.key);
    }
    res.type('text/plain').setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`);
    res.send(text);
});

// ---------------------------------------------------------------------------------------------- show management

app.get('/api/shows', async (req, res) => {
    let stats = {};
    try { stats = await showStats(); } catch { /* no log yet */ }
    res.json(store.list().map(r => ({
        id: r.id, name: r.name, theme: r.theme, createdAt: r.createdAt, createdBy: r.createdBy, games: r.game || 0,
        status: r.status || 'active', endedAt: r.endedAt || null, endedBy: r.endedBy || null,
        screens: { host: !!r.screens?.host, player: !!r.screens?.player },
        log: stats[r.id] ?? { events: 0, games: 0, last: null },
        live: shows.summary(r.id)
    })));
});

app.get('/api/shows/:id/events', async (req, res) => {
    try { res.json({ types: EVENT_TYPES, events: await listShowEvents(req.params.id, req.query) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

/** The whole log of a show (oldest first), as CSV for spreadsheets or JSON. */
app.get('/api/shows/:id/export', async (req, res) => {
    const events = (await listShowEvents(req.params.id, { ...req.query, limit: 20000 })).reverse();
    const name = `show-${req.params.id.replace(/[^a-z0-9-]/g, '')}-log`;
    audit(req, 'show.export', { format: req.query.format }, req.params.id);
    if (req.query.format === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="${name}.json"`);
        return res.json(events);
    }
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['id,time,game,level,type,user,message,data', ...events.map(e =>
        [e.id, e.ts, e.game, e.level ?? '', e.type, e.username ?? '', e.message, e.data ?? ''].map(cell).join(','))].join('\r\n');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.type('text/csv').send('\ufeff' + csv);
});

app.post('/api/rooms/:id/end', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    if (room.status === 'ended') return res.status(400).json({ error: 'This show has already ended' });
    shows.endShow(room, req.session.user);
    audit(req, 'room.end', null, room.id);
    res.json({ ok: true });
});

app.post('/api/rooms/:id/reopen', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    shows.reopenShow(room, req.session.user);
    audit(req, 'room.reopen', null, room.id);
    res.json({ ok: true });
});

app.delete('/api/shows/:id/events', requireAdmin, async (req, res) => {
    await clearShowEvents(req.params.id);
    audit(req, 'show.clearLog', null, req.params.id);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------- calendar of shows

app.get('/api/schedule', (req, res) => {
    const live = liveRooms();
    res.json(schedule.list().map(e => ({ ...e, state: eventState(e, live), roomName: e.room ? store.get(e.room)?.name ?? null : null, inviteUrl: inviteUrl(req, e) })));
});
app.post('/api/schedule', (req, res) => {
    try {
        const input = { ...(req.body || {}) };
        let created = null;
        // "New show for this event": the show is created in the Shows section and linked to the event
        if (input.createRoom) {
            if (!String(input.title || '').trim()) throw new Error('Enter a title');
            created = store.create(input.title, req.session.user);
            input.room = created.id;
            audit(req, 'room.create', { name: created.name, from: 'calendar' }, created.id);
        }
        const e = schedule.create(input, req.session.user);
        if (created) {
            shows.event(created, 'show', `Show "${created.name}" created by ${req.session.user} from the calendar`, { user: req.session.user });
            shows.broadcastRoom(created);
        }
        audit(req, 'schedule.create', { id: e.id, title: e.title, start: e.start }, e.room || null);
        const room = e.room ? store.get(e.room) : null;
        if (room) shows.event(room, 'show', `Scheduled on the calendar: "${e.title}", ${e.start.slice(0, 16).replace('T', ' ')} UTC${e.live !== false ? ' (live)' : ''}`, { user: req.session.user });
        res.json({ ...e, inviteUrl: inviteUrl(req, e), createdRoom: created?.id ?? null });
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/schedule/:id', (req, res) => {
    try {
        const e = schedule.update(req.params.id, req.body || {}, req.session.user);
        audit(req, 'schedule.update', { id: e.id, title: e.title, start: e.start, status: e.status }, e.room || null);
        const room = e.room ? store.get(e.room) : null;
        if (room) shows.event(room, 'show', `Calendar event "${e.title}" ${e.status === 'cancelled' ? 'cancelled' : 'updated: ' + e.start.slice(0, 16).replace('T', ' ') + ' UTC'}`, { user: req.session.user });
        res.json({ ...e, inviteUrl: inviteUrl(req, e) });
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/schedule/:id', (req, res) => {
    const e = schedule.get(req.params.id);
    if (!e) return res.sendStatus(404);
    schedule.remove(e.id);
    audit(req, 'schedule.delete', { id: e.id, title: e.title }, e.room || null);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------- screen passwords

app.put('/api/rooms/:id/screens', async (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    room.screens ??= { host: '', player: '', ff: '' };
    for (const kind of ['host', 'player', 'ff']) {
        const value = req.body?.[kind];
        if (value === undefined || value === null) continue;
        if (value === '') room.screens[kind] = '';
        else if (String(value).length < 4) return res.status(400).json({ error: 'Screen passwords need at least 4 characters' });
        else room.screens[kind] = await hashPassword(String(value));
        io.in(kind === 'ff' ? 'ffc:' + room.id : `scr:${room.id}:${kind}`).disconnectSockets(true);
        audit(req, `screen.${kind}.password`, { enabled: !!room.screens[kind] }, room.id);
        shows.event(room, 'show', `${{ host: 'Host screen', player: 'Player screen', ff: 'Fastest Finger consoles' }[kind]} ${room.screens[kind] ? 'password set' : 'disabled'}`, { user: req.session.user });
    }
    saveRooms();
    shows.broadcastRoom(room);
    res.json({ ok: true, screens: { host: !!room.screens.host, player: !!room.screens.player, ff: !!room.screens.ff } });
});

app.get('/api/rooms', (req, res) => res.json(store.list().map(r => ({ id: r.id, name: r.name, theme: r.theme }))));

app.post('/api/rooms', (req, res) => {
    const room = store.create(req.body?.name, req.session.user);
    audit(req, 'room.create', { name: room.name }, room.id);
    shows.event(room, 'show', `Show "${room.name}" created by ${req.session.user}`, { user: req.session.user });
    res.json({ id: room.id });
});

app.put('/api/rooms/:id', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    if (room.mode === 'live' && (req.body.theme !== undefined || req.body.name !== undefined)) return res.status(409).json({ error: 'Return to rehearsal before changing show configuration' });
    if (typeof req.body.name === 'string' && req.body.name.trim() && req.body.name.trim() !== room.name) {
        const old = room.name;
        room.name = req.body.name.trim().slice(0, 60);
        shows.event(room, 'show', `Renamed from "${old}" to "${room.name}"`, { user: req.session.user });
    }
    let reload = false;
    if (typeof req.body.theme === 'string' && req.body.theme !== room.theme) {
        if (!themeDir(req.body.theme)) return res.status(400).json({ error: 'Unknown theme' });
        shows.event(room, 'show', `Theme changed${room.theme ? ` from ${room.theme}` : ''} to ${req.body.theme}`, { user: req.session.user });
        room.theme = req.body.theme;
        reload = true;
    }
    saveRooms();
    audit(req, 'room.update', { name: room.name, theme: room.theme }, room.id);
    if (reload) shows.reload(room); else shows.broadcastRoom(room);
    res.json({ ok: true });
});

app.delete('/api/rooms/:id', (req, res) => {
    if (!store.get(req.params.id)) return res.sendStatus(404);
    shows.event(store.get(req.params.id), 'show', `Show deleted by ${req.session.user}`, { user: req.session.user });
    shows.dropRoom(req.params.id);
    store.remove(req.params.id);
    schedule.unlinkRoom(req.params.id);
    audit(req, 'room.delete', null, req.params.id);
    res.json({ ok: true });
});

app.post('/api/rooms/:id/rotate-token', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    if (room.mode === 'live') return res.status(409).json({ error: 'Return to rehearsal before rotating the output link' });
    store.rotateToken(room);
    shows.event(room, 'show', 'New secret output link created (the old one no longer works)', { user: req.session.user });
    shows.reload(room);
    res.json({ ok: true });
});

/** The questions stored in the theme's own XML files (to import them into the show). */
app.get('/api/rooms/:id/theme-questions', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    res.json({ main: readThemeQuestions(room.theme, 'questions.xml'), sw: readThemeQuestions(room.theme, 'switchQuestions.xml') });
});

/** Saves the show's questions into the theme's XML files. */
app.post('/api/rooms/:id/theme-questions', (req, res) => {
    const room = store.get(req.params.id);
    if (!room) return res.sendStatus(404);
    try {
        writeThemeQuestions(room.theme, 'questions.xml', room.questions.main.map(cleanQuestion));
        writeThemeQuestions(room.theme, 'switchQuestions.xml', room.questions.sw.map(cleanQuestion));
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------------------------- settings, AI, builder

app.get('/api/settings', (req, res) => res.json(platformSettings.public()));
app.put('/api/settings', requireAdmin, (req, res) => {
    const out = platformSettings.update(req.body || {});
    audit(req, 'admin.settings', { sections: Object.keys(req.body || {}) });
    res.json(out);
});

app.post('/api/ai/models', async (req, res) => {
    const saved = platformSettings.get().ai;
    const ai = { ...saved, ...req.body, geminiKey: req.body?.geminiKey || saved.geminiKey };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try { res.json({ models: await listModels(ai, controller.signal) }); }
    catch (e) { res.status(400).json({ error: e.name === 'AbortError' ? 'No answer within 20 seconds' : e.message }); }
    finally { clearTimeout(timer); }
});

app.post('/api/builder/fetch', async (req, res) => {
    try {
        const data = await fetchFromBuilder(platformSettings.get().builder, req.body?.path);
        audit(req, 'builder.fetch', { url: data.url, sets: data.sets.length });
        res.json(data);
    }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------------------------- money tree (Variables.js)

function variablesOf(name, forWriting = false) {
    // a change to a global theme goes to the community's own copy of it
    const dir = forWriting ? ownThemeDir(name) : themeDir(name);
    const file = dir && variablesPath(dir);
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error('Scripts/Variables.js not found in this theme'), { status: 404 });
    return file;
}

app.get('/api/themes/:name/money-tree', (req, res) => {
    try { res.json(loadMoneyTree(variablesOf(req.params.name))); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.post('/api/money-tree/preview', (req, res) => {
    try { res.json(previewMoneyTree(cleanMoneyTree(req.body))); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/themes/:name/money-tree', (req, res) => {
    try {
        const file = variablesOf(req.params.name, true);
        saveMoneyTree(file, cleanMoneyTree(req.body?.config));
        audit(req, 'theme.moneyTree', { theme: req.params.name, reload: !!req.body?.reload });
        for (const room of store.list()) if (room.theme === req.params.name) shows.event(room, 'show', `Money tree settings of ${req.params.name} saved`, { user: req.session.user });
        let reloaded = 0;
        if (req.body?.reload) for (const room of store.list()) if (room.theme === req.params.name) { shows.reload(room); reloaded++; }
        res.json({ ok: true, reloaded });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.get('/api/themes', async (req, res) => res.json(await listThemes()));

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
/** Administrators manage every theme; operators the themes they uploaded. */
// global themes (multi-tenant platform) are managed only by the platform administrator, in the super-admin panel
const mayManageTheme = (req, name) => !isGlobalTheme(name) && (req.session.role === 'admin' || themeOwner(name)?.by === req.session.user);

// Every signed-in user (operators too) can upload themes; replacing / deleting follows mayManageTheme
app.post('/api/themes', requireAdmin, (req, res) => {
    upload.single('file')(req, res, async err => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${config.maxUploadMb} MB` : err.message });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        if (!/\.zip$/i.test(req.file.originalname)) {
            fs.rm(req.file.path, { force: true }, () => { });
            return res.status(400).json({ error: 'Upload a .zip file' });
        }
        try {
            const renamed = path.join(config.tmpDir, path.basename(req.file.originalname).replace(/[^A-Za-z0-9 ._()+-]/g, '_'));
            fs.renameSync(req.file.path, renamed);
            const installed = await installThemeZip(renamed, { overwrite: req.query.overwrite === '1', mayReplace: name => mayManageTheme(req, name) });
            // a new theme belongs to who uploaded it; a replaced theme keeps its original owner
            for (const name of installed) if (!themeOwner(name)) setThemeOwner(name, req.session.user);
            audit(req, 'theme.upload', { file: req.file.originalname, installed, replace: req.query.overwrite === '1', role: req.session.role });
            // Shows using a replaced theme reload with the new files
            for (const room of store.list()) if (installed.includes(room.theme)) shows.reload(room);
            res.json({ installed });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
});

app.delete('/api/themes/:name', async (req, res) => {
    if (isGlobalTheme(req.params.name)) return res.status(403).json({ error: 'This is a global theme, managed by the administrator of the platform: it cannot be deleted here' });
    if (!mayManageTheme(req, req.params.name)) return res.status(403).json({ error: 'Only an administrator, or who uploaded it, can delete this theme' });
    const inUse = store.list().filter(r => r.theme === req.params.name).map(r => r.name);
    if (inUse.length) return res.status(409).json({ error: `In use by: ${inUse.join(', ')}` });
    const ok = await deleteTheme(req.params.name);
    audit(req, 'theme.delete', { name: req.params.name });
    res.json({ ok });
});

app.get('/api/themes/:name/assets', (req, res) => {
    const assets = themeAssets(req.params.name);
    if (!assets) return res.sendStatus(404);
    res.json(assets);
});

/** Theme files for the control panel (lifeline icons, money tree background, previews). */
app.get('/preview/:theme/*', requireAuth, (req, res) => {
    const dir = themeDir(req.params.theme);
    const target = dir && findThemeFile(dir, req.params[0]);
    if (!target) return res.sendStatus(404);
    if (/\.(html?|svg|xml)$/i.test(target)) res.set({ 'Content-Disposition': 'attachment', 'Content-Security-Policy': "sandbox; default-src 'none'" });
    res.sendFile(target, { dotfiles: 'deny', headers: { 'Cache-Control': 'private, max-age=300' } });
});

// ---------------------------------------------------------------------------------------------- start

db.connect().then(r => {
    if (r.ok) console.log('MySQL connected');
    else if (r.error) console.log('MySQL not connected: ' + r.error);
});

server.listen(config.port, config.host, () => {
    console.log(`Millionaire web platform on http://${config.host}:${server.address().port}`);
    if (config.generatedPassword) console.log('Administrator password generated in the protected data/admin-password.txt file.');
    if (installation.needsSetup()) console.log('First installation: sign in as administrator to open the setup wizard at /setup.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    shows.flushCheckpoints(); flushRooms();
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 400 ? 400 : 500).json({ error: 'The operation could not be completed' });
});
