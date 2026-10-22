import { store, saveRooms } from './store.js';
import { requireAdmin } from './auth.js';
import { discordEnabled } from './discord-auth.js';
import { registrations } from './participants.js';
import { reviewQuestion, reviewSet, freezeSet, setDigest } from './editorial.js';
import { loadCheckpoint } from './checkpoints.js';
import { themeDir } from './themes.js';
import { getBankQuestion } from './bank.js';
import { schedule } from './schedule.js';
import { notificationStatus, syncDiscordEvent } from './notifications.js';

export function attachOperations(app, { shows, io }) {
    app.get('/api/admin/discord-notifications', requireAdmin, (req, res) => res.json(notificationStatus()));
    app.post('/api/admin/discord-events/:id', requireAdmin, async (req, res) => {
        const event = schedule.get(req.params.id);
        if (!event) return res.sendStatus(404);
        try {
            schedule.update(event.id, { discordNotify: req.body?.enabled === true }, req.session.user);
            if (req.body?.sync === true) await syncDiscordEvent(schedule.get(event.id));
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    const roomOf = (req, res) => {
        const room = store.get(req.params.id);
        if (!room) res.status(404).json({ error: 'Show not found' });
        return room;
    };
    app.get('/api/rooms/:id/preflight', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        const summary = shows.summary(room.id), rows = reviewSet(room);
        res.json({ mode: room.mode || 'rehearsal', frozen: room.frozen || null, checks: [
            { name: 'Theme installed', passed: !!themeDir(room.theme) },
            { name: 'Main and replacement questions approved', passed: rows.every(row => !row.issues.length) },
            { name: 'Discord and privacy configured', passed: discordEnabled() },
            { name: 'Output connected', passed: summary.outputs > 0 },
            { name: 'Host screen enabled', passed: !!room.screens?.host, optional: true },
            { name: 'Player screen enabled', passed: !!room.screens?.player, optional: true }
        ], questions: rows, checkpoint: shows.checkpointInfo(room.id) });
    });
    app.get('/api/rooms/:id/reviews', (req, res) => { const room = roomOf(req, res); if (room) res.json(reviewSet(room)); });
    app.post('/api/rooms/:id/reviews/:set/:level', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        if (room.frozen) return res.status(409).json({ error: 'Unfreeze the rehearsal before reviewing questions' });
        const level = Number(req.params.level);
        const q = ['main', 'sw'].includes(req.params.set) && Number.isInteger(level) && room.questions[req.params.set][level - 1];
        if (!q) return res.status(400).json({ error: 'Invalid question slot' });
        try { res.json(reviewQuestion(q, req.body || {}, req.session)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/bank/questions/:uid/review', async (req, res) => {
        try {
            const q = await getBankQuestion(req.params.uid);
            if (!q) return res.sendStatus(404);
            res.json(reviewQuestion(q, req.body || {}, req.session));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/rooms/:id/freeze', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        try { const frozen = freezeSet(room, req.session); saveRooms(); shows.broadcastRoom(room); res.json(frozen); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/rooms/:id/mode', requireAdmin, (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        if (!['live', 'rehearsal'].includes(req.body?.mode)) return res.status(400).json({ error: 'Choose live or rehearsal' });
        try {
            if (req.body.mode === 'live') {
                if (!discordEnabled()) throw new Error('Configure Discord and the privacy notice before going live');
                if (!themeDir(room.theme)) throw new Error('Choose an installed theme');
                freezeSet(room, req.session);
            } else room.frozen = null;
            room.mode = req.body.mode;
            shows.resetForMode(room);
            saveRooms(); shows.broadcastRoom(room); res.json({ ok: true, mode: room.mode });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/rooms/:id/rehearsal-copy', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        const copy = store.create(room.name + ' (rehearsal)', req.session.user);
        copy.theme = room.theme; copy.questions = structuredClone(room.questions);
        copy.mode = 'rehearsal'; saveRooms(); res.json({ id: copy.id });
    });
    app.get('/api/rooms/:id/registrations', (req, res) => { const room = roomOf(req, res); if (room) res.json(registrations(room.id)); });
    app.post('/api/rooms/:id/checkpoint/restore', async (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        const saved = loadCheckpoint(room.id);
        if (!saved || saved.theme !== room.theme || saved.questionsVersion !== setDigest(room) || saved.mode !== room.mode) return res.status(409).json({ error: 'No compatible checkpoint. Theme, mode and questions must match.' });
        try { await shows.restoreCheckpoint(room, saved); res.json({ ok: true, savedAt: saved.savedAt, paused: true }); }
        catch (e) { res.status(409).json({ error: e.message }); }
    });
    app.post('/api/rooms/:id/checkpoint/discard', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        if (room.mode === 'live') return res.status(409).json({ error: 'Return to rehearsal before discarding recovery data' });
        shows.discardCheckpoint(room); res.json({ ok: true });
    });
    app.post('/api/rooms/:id/output/takeover', (req, res) => {
        const room = roomOf(req, res); if (!room) return;
        try { shows.takeover(room, req.body?.socketId); res.json({ ok: true }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
}
