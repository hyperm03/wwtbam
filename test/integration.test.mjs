import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { io } from 'socket.io-client';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwtbam-integration-'));
let child, base, cookie, room, output, control;
const sockets = [];
const wait = (socket, event, predicate = () => true) => new Promise((resolve, reject) => {
    const handler = value => { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, handler); resolve(value); };
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error('Timeout: ' + event)); }, 5000);
    socket.on(event, handler);
});
const ack = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, value) => error ? reject(error) : resolve(value)));
function connect(query, credentials = cookie) {
    const socket = io(base, { query, autoConnect: false, transports: ['websocket'], extraHeaders: credentials ? { Cookie: credentials } : {} });
    sockets.push(socket); return socket;
}
async function request(route, method = 'GET', data, credentials = cookie) {
    return fetch(base + route, { method, redirect: 'manual', headers: { ...(credentials ? { Cookie: credentials } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
}
const cookies = response => response.headers.getSetCookie().map(s => s.split(';')[0]).filter(s => !s.endsWith('=')).join('; ');
async function staffLogin() {
    const response = await request('/login', 'POST', { username: 'admin', password: 'test-admin-password' }, '');
    assert.equal(response.status, 302); cookie = cookies(response);
}
async function oauthLogin() {
    const first = await request('/auth/discord', 'POST', { acknowledge: 'yes', adult: 'yes' }, '');
    assert.equal(first.status, 302);
    const location = new URL(first.headers.get('location'));
    assert.equal(location.searchParams.get('scope'), 'identify');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = location.searchParams.get('state'), browser = cookies(first);
    const callback = `/auth/discord/callback?code=local-test&state=${state}&iss=https%3A%2F%2Fdiscord.com`;
    const result = await request(callback, 'GET', undefined, browser);
    assert.equal(result.status, 302);
    assert.equal((await request(callback, 'GET', undefined, browser)).status, 400);
    return cookies(result);
}
const question = (i, replacement = false) => ({ text: `${replacement ? 'Replacement' : 'Main'} question ${i}`, answers: ['Alpha', 'Bravo', 'Charlie', 'Delta'], correct: replacement ? 1 : 0 });
const state = (level = 1, replacement = false) => ({ type: 'state', level, questionStep: 5, inProgress: true, correct: replacement ? 'b' : 'a', target: '', used: [false, false, false, false, false, false], out: [false, false, false, false], ataStep: 0, screen: { visible: true, isSwitch: replacement, text: question(level, replacement).text, answers: question(level, replacement).answers, shown: [true, true, true, true], locked: '', revealedCorrect: '' }, recovery: { version: 1, fields: {}, scene: [] } });
async function sendState(value) { const next = wait(control, 'state', s => s.level === value.level && s.screen.isSwitch === value.screen.isSwitch); output.emit('bridge', value); return next; }

test.before(async () => {
    child = spawn(process.execPath, ['--import', './test/fixtures/discord-fetch.mjs', 'server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: temp, ADMIN_PASSWORD: 'test-admin-password', PUBLIC_URL: 'https://quiz.example', OUTPUT_PUBLIC_URL: 'https://output.quiz.example', DISCORD_CLIENT_ID: '123456789012345679', DISCORD_CLIENT_SECRET: 'test-secret', PRIVACY_CONTROLLER_NAME: 'Test controller', PRIVACY_CONTACT_EMAIL: 'privacy@example.invalid', PRIVACY_HOSTING_REGION: 'Local test only', PRIVACY_REVIEWED: '1', DISCORD_GUILD_ID: '', DISCORD_ANNOUNCEMENTS_ENABLED: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 10000);
        child.stdout.on('data', chunk => { log += chunk; const found = log.match(/127.0.0.1:(\d+)/); if (found && found[1] !== '0') { base = `http://127.0.0.1:${found[1]}`; clearTimeout(timer); resolve(); } });
        child.stderr.on('data', chunk => { log += chunk; }); child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + log)); });
    });
    await staffLogin();
    room = (await (await request('/api/rooms', 'POST', { name: 'Integration show' })).json()).id;
    control = connect({ role: 'control' }); let w = wait(control, 'connect'); control.connect(); await w;
    w = wait(control, 'room'); control.emit('join', room); const info = await w;
    assert.equal((await ack(control, 'cmd', { cmd: 'setAll', main: Array.from({ length: 15 }, (_, i) => question(i + 1)), sw: Array.from({ length: 15 }, (_, i) => question(i + 1, true)) })).ok, true);
    output = connect({ role: 'output', room, token: info.outputToken }, ''); w = wait(output, 'connect'); output.connect(); await w;
    await sendState(state());
});
test.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(temp, { recursive: true, force: true });
});

test('authorization, CSRF, safe cookie parsing and privacy pages', async () => {
    assert.equal((await request('/api/rooms', 'GET', undefined, '')).status, 401);
    assert.equal((await fetch(base + '/api/rooms', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"name":"bad"}' })).status, 403);
    assert.equal((await request('/api/rooms', 'GET', undefined, 'mc_session=%E0%A4%A')).status, 401);
    assert.equal((await request('/privacy', 'GET', undefined, '')).status, 200);
    assert.equal((await request('/auth/discord', 'POST', {}, '')).status, 400);
    const isolatedStatus = await new Promise((resolve, reject) => {
        const req = http.get(base + '/participant/me', { headers: { Host: 'output.quiz.example', Cookie: cookie } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject);
    });
    assert.equal(isolatedStatus, 404);
});
test('first-run setup is administrator-only and stored settings immediately update Discord and privacy', async () => {
    assert.equal((await request('/setup', 'GET', undefined, '')).status, 302);
    assert.equal((await request('/api/admin/installation', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/control')).headers.get('location'), '/setup');
    const before = await (await request('/api/admin/installation')).json();
    assert.equal(before.needsSetup, true);
    const result = await request('/api/admin/installation', 'PUT', { values: { DISCORD_CLIENT_ID: '123456789012345680', DISCORD_CLIENT_SECRET: 'configured-in-application', PRIVACY_CONTACT_EMAIL: 'updated@example.invalid' }, complete: true });
    assert.equal(result.status, 200);
    const settings = await result.json();
    assert.equal(settings.needsSetup, false);
    assert.ok(!JSON.stringify(settings).includes('configured-in-application'));
    assert.equal((await request('/control')).status, 200);
    const status = await (await request('/auth/discord/status', 'GET', undefined, '')).json();
    assert.equal(status.enabled, true);
    assert.equal(status.privacy.contact, 'updated@example.invalid');
    const authorization = await request('/auth/discord', 'POST', { acknowledge: 'yes', adult: 'yes' }, '');
    assert.equal(new URL(authorization.headers.get('location')).searchParams.get('client_id'), '123456789012345680');
    assert.ok(!fs.readFileSync(path.join(temp, 'installation.json'), 'utf8').includes('configured-in-application'));
});
test('replacement questions, round binding and closed-vote totals without retained identities', async () => {
    const voter = connect({ role: 'voter', room }, ''); let w = wait(voter, 'voting'); voter.connect(); const hidden = await w;
    assert.deepEqual(hidden.answers, ['', '', '', '']);
    w = wait(voter, 'voting', v => v.open); control.emit('voting', { open: true }); const round = await w;
    assert.equal((await ack(voter, 'vote', { device: 'one', letter: '', round: round.round })).reason, 'invalid');
    assert.equal((await ack(voter, 'vote', { device: 'one', letter: 'A', round: 'stale' })).reason, 'stale');
    assert.equal((await ack(voter, 'vote', { device: 'one', letter: 'A', round: round.round })).ok, true);
    assert.equal((await ack(voter, 'vote', { device: 'one', letter: 'B', round: round.round })).reason, 'already');
    await sendState(state(1, true));
    w = wait(voter, 'voting', v => v.open); control.emit('voting', { open: true }); const changed = await w;
    assert.equal(changed.question, 'Replacement question 1');
    assert.equal((await ack(voter, 'vote', { device: 'one', letter: 'B', round: changed.round })).ok, true);
    w = wait(control, 'tally', t => !t.open); control.emit('voting', { open: false }); assert.equal((await w).total, 1);
    voter.disconnect();
});
test('one primary output, explicit takeover, command confirmations and duplicate protection', async () => {
    const roomInfo = wait(control, 'room'); control.emit('join', room); const info = await roomInfo;
    const standby = connect({ role: 'output', room, token: info.outputToken }, ''); let w = wait(standby, 'authority'); standby.connect(); assert.equal((await w).active, false);
    standby.emit('bridge', state(8));
    w = wait(control, 'room'); control.emit('join', room); assert.equal((await w).activeOutput, output.id);
    const id = crypto.randomUUID();
    const command = wait(output, 'cmd', c => c.id === id);
    const result = ack(control, 'cmd', { cmd: 'key', code: 39, id, sentAt: Date.now() }); await command;
    output.emit('bridge', { type: 'commandAck', id }); assert.equal((await result).ok, true);
    assert.equal((await ack(control, 'cmd', { cmd: 'key', code: 39, id, sentAt: Date.now() })).ok, false);
    assert.equal((await ack(control, 'cmd', { cmd: 'key', code: 39, id: crypto.randomUUID(), sentAt: Date.now() - 10000 })).ok, false);
    standby.disconnect();
});
test('checkpoint restoration waits for output acknowledgement', async () => {
    let w = wait(output, 'cmd', c => c.cmd === 'restore');
    const response = request(`/api/rooms/${room}/checkpoint/restore`, 'POST'); const restore = await w;
    assert.equal(restore.state.screen.isSwitch, true);
    output.emit('bridge', { type: 'commandAck', id: restore.id });
    assert.equal((await response).status, 200);
    await sendState(state(1, true));
});
test('editorial freeze is enforced on the socket and Discord activation does not grant staff access', async () => {
    const participantCookie = await oauthLogin();
    assert.equal((await request('/api/rooms', 'GET', undefined, participantCookie)).status, 401);
    assert.equal((await request('/participant/me', 'PUT', { alias: 'Player' }, participantCookie)).status, 200);
    const raw = fs.readFileSync(path.join(temp, 'participants.json'), 'utf8');
    assert.ok(!raw.includes('must-not-be-stored') && !raw.includes('123456789012345678') && !raw.includes('test-access'));
    for (const set of ['main', 'sw']) for (let level = 1; level <= 15; level++) {
        assert.equal((await request(`/api/rooms/${room}/reviews/${set}/${level}`, 'POST', { status: 'verified', sourceUrl: 'https://example.org/source' })).status, 200);
        assert.equal((await request(`/api/rooms/${room}/reviews/${set}/${level}`, 'POST', { status: 'approved' })).status, 200);
    }
    assert.equal((await request(`/api/rooms/${room}/freeze`, 'POST')).status, 200);
    assert.equal((await ack(control, 'cmd', { cmd: 'setAll', main: [question(100)] })).ok, false);
    fs.mkdirSync(path.join(temp, 'themes', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'themes', 'fixture', 'default.html'), '<!doctype html><title>Protocol test fixture only</title>');
    assert.equal((await request(`/api/rooms/${room}`, 'PUT', { theme: 'fixture' })).status, 200);
    assert.equal((await request(`/api/rooms/${room}/mode`, 'POST', { mode: 'live' })).status, 200);
    await sendState(state());
    assert.equal((await request(`/participant/rooms/${room}/register`, 'POST', { checkIn: true }, participantCookie)).status, 200);
    const secondCookie = await oauthLogin();
    const one = connect({ role: 'voter', room }, participantCookie); let w = wait(one, 'voting'); one.connect(); await w;
    const two = connect({ role: 'voter', room }, secondCookie); w = wait(two, 'voting'); two.connect(); await w;
    w = wait(one, 'voting', v => v.open); control.emit('voting', { open: true }); const vote = await w;
    assert.equal((await ack(one, 'vote', { device: 'first-browser', letter: 'A', round: vote.round })).ok, true);
    assert.equal((await ack(two, 'vote', { device: 'different-browser', letter: 'B', round: vote.round })).reason, 'already');
    assert.equal((await request(`/api/rooms/${room}`, 'PUT', { theme: 'fixture' })).status, 409);
    assert.equal((await request('/participant/export', 'GET', undefined, participantCookie)).status, 200);
    assert.equal((await request('/participant/me', 'DELETE', undefined, participantCookie)).status, 200);
    assert.equal((await request('/participant/me', 'GET', undefined, participantCookie)).status, 401);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'participants.json'), 'utf8')).accounts, {});
});
test('logout disconnects an already authenticated control socket', async () => {
    const disconnected = wait(control, 'disconnect');
    assert.equal((await request('/logout', 'POST')).status, 302); await disconnected;
    assert.equal((await request('/api/rooms')).status, 401);
});
