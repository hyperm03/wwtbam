import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwtbam-core-'));
process.env.DATA_DIR = temp;
process.env.ADMIN_PASSWORD = 'test-password-only';
const sessions = await import('../lib/sessions.js');
const people = await import('../lib/participants.js');
const editorial = await import('../lib/editorial.js');
const { latencySummary, measuredAnswer, tiedSeats } = await import('../lib/fff-timing.js');
const { createDiscordClient } = await import('../lib/discord-client.js');
const { createBackup, restoreBackup } = await import('../lib/backup.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('sessions are opaque, purpose-bound, expire and revoke all account devices', () => {
    const first = sessions.createSession({ accountKey: 'person' }, 'participant');
    const staff = sessions.createSession({ accountKey: 'person', user: 'operator', role: 'operator' });
    assert.equal(sessions.findSession(first.token), null);
    assert.equal(sessions.findSession(first.token, 'participant').accountKey, 'person');
    assert.ok(!fs.readFileSync(path.join(temp, 'sessions.json'), 'utf8').includes(first.token));
    sessions.revokeAccount('person');
    assert.equal(sessions.findSession(staff.token), null);
    const expired = sessions.createSession({ user: 'expired' }, 'staff', -1);
    assert.equal(sessions.findSession(expired.token), null);
});
test('participant data exports, correction, erasure and inactive-account retention', () => {
    const key = people.accountKey('123456789012345678');
    people.upsertParticipant(key); people.setAlias(key, 'Nickname'); people.register(key, 'show', true);
    assert.equal(people.exportParticipant(key).account.alias, 'Nickname');
    assert.equal(people.isCheckedIn(key, 'show'), true);
    const saved = fs.readFileSync(path.join(temp, 'participants.json'), 'utf8');
    assert.ok(!saved.includes('123456789012345678'));
    people.deleteParticipant(key);
    assert.equal(people.participant(key), null);
    assert.equal(people.isCheckedIn(key, 'show'), false);
    people.upsertParticipant(key);
    people.purgeParticipants(Date.now() + 91 * 86400000);
    assert.equal(people.participant(key), null);
});
test('editorial approval is content-bound and freezing requires replacement coverage', () => {
    const q = { text: 'Which number is even?', answers: ['2', '3', '5', '7'], correct: 0 };
    const admin = { user: 'editor', role: 'admin' };
    assert.throws(() => editorial.reviewQuestion(q, { status: 'approved', sourceUrl: 'https://example.org' }, admin), /Verify/);
    editorial.reviewQuestion(q, { status: 'verified', sourceUrl: 'https://example.org' }, admin);
    editorial.reviewQuestion(q, { status: 'approved' }, admin);
    assert.equal(editorial.questionReview(q).status, 'approved');
    assert.equal(editorial.questionReview({ ...q, correct: 1 }).status, 'draft');
    assert.throws(() => editorial.freezeSet({ questions: { main: [q], sw: [{ ...q, text: 'unapproved' }] } }, admin), /Review all/);
    assert.throws(() => editorial.reviewQuestion({ ...q, answers: ['2', '2', '5', '7'] }, { status: 'verified' }, admin), /distinct/);
});
test('server-measured FFF time is bounded and uncertain results trigger a tie', () => {
    assert.equal(measuredAnswer(1000, [1000, 1000, 1000]).time, .9);
    assert.equal(latencySummary([]).unstable, true);
    assert.deepEqual(tiedSeats([{ seat: 1, time: 1, uncertaintyMs: 100, correct: true }, { seat: 2, time: 1.05, uncertaintyMs: 30, correct: true }]), [1, 2]);
});
test('Discord uses minimal scopes and ephemeral tokens, including on denied membership', async () => {
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push([url, options]);
        if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'ephemeral', refresh_token: 'ephemeral-refresh', token_type: 'Bearer' });
        if (url.endsWith('/users/@me')) return Response.json({ id: '123456789012345678', email: 'ignore', username: 'ignore' });
        return new Response('', { status: 200 });
    };
    const client = createDiscordClient({ clientId: 'test', clientSecret: 'test-secret', fetcher });
    assert.deepEqual(client.scopes, ['identify']);
    assert.deepEqual(await client.identity('one-use-code', 'https://quiz.example/auth/discord/callback', 'verifier'), { id: '123456789012345678', roles: [] });
    assert.equal(new URLSearchParams(calls[0][1].body).get('code_verifier'), 'verifier');
    assert.equal(calls.filter(([url]) => url.endsWith('/oauth2/token/revoke')).length, 2);
    const deniedCalls = [];
    const restricted = createDiscordClient({ clientId: 'test', clientSecret: 'secret', guildId: 'guild', roleIds: ['required'], fetcher: async (url, options) => {
        deniedCalls.push(url);
        if (url.endsWith('/member')) return Response.json({ roles: [] });
        return fetcher(url, options);
    } });
    await assert.rejects(restricted.identity('code', 'https://quiz.example/callback', 'verifier'), /roles/);
    assert.equal(deniedCalls.filter(url => url.endsWith('/oauth2/token/revoke')).length, 2);
});
test('encrypted backups authenticate before restore and omit participant identity stores', async () => {
    const source = path.join(temp, 'source'), restored = path.join(temp, 'restored'), archive = path.join(temp, 'game.enc');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'rooms.json'), '[{"id":"show"}]'); fs.writeFileSync(path.join(source, 'participants.json'), 'private'); fs.writeFileSync(path.join(source, 'session-secret.txt'), 'game-key');
    await createBackup(source, archive, 'sixteen-characters-minimum');
    await assert.rejects(restoreBackup(archive, restored, 'wrong-password-but-long-enough'));
    assert.equal(fs.existsSync(path.join(restored, 'rooms.json')), false);
    await restoreBackup(archive, restored, 'sixteen-characters-minimum');
    assert.equal(fs.readFileSync(path.join(restored, 'session-secret.txt'), 'utf8'), 'game-key');
    assert.equal(fs.existsSync(path.join(restored, 'participants.json')), false);
    await assert.rejects(restoreBackup(archive, restored, 'sixteen-characters-minimum'), /empty/);
});
test('Discord reminders are opt-in, deduplicated and never mention or publish participant identity', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-bot-only';
    process.env.DISCORD_GUILD_ID = '123456789012345678';
    process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = '123456789012345679';
    process.env.DISCORD_ANNOUNCEMENTS_ENABLED = '1';
    const original = globalThis.fetch, calls = [];
    globalThis.fetch = async (url, options) => { calls.push([url, JSON.parse(options.body)]); return Response.json({ id: '123456789012345680' }); };
    try {
        const { schedule } = await import('../lib/schedule.js');
        const notices = await import('../lib/notifications.js');
        const now = Date.now();
        const event = schedule.create({ title: 'Quiz night', start: new Date(now + 3600000).toISOString(), duration: 60, room: 'show', public: true, discordNotify: true }, 'admin');
        await notices.runReminders(now); await notices.runReminders(now);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0][1].allowed_mentions, { parse: [] });
        await notices.announceResult('show', '1000');
        assert.equal(calls.length, 2);
        assert.ok(calls[1][1].content.includes('1000'));
        await notices.syncDiscordEvent(event);
        assert.equal(calls[2][1].entity_type, 3);
    } finally { globalThis.fetch = original; process.env.DISCORD_ANNOUNCEMENTS_ENABLED = '0'; }
});
