import { store, saveRooms, cleanQuestion, toDto } from './store.js';
import { getSession, screenAuthorized } from './auth.js';
import { db, stacks, logEvent } from './db.js';
import { ensureUids, markUsed, rateWithAi, generateIntoBank } from './bank.js';
import { createFff } from './fffround.js';
import { layoutStore } from './layouts.js';
import { roblox } from './roblox.js';
import { themeAssets } from './assets.js';
import { showEvent, onShowEvent, KEY_NAMES, LIFELINE_NAMES, LIFELINE_IDS } from './showlog.js';
import { platformSettings } from './settings.js';
import { engineFor, generate } from './ai.js';
import crypto from 'node:crypto';
import { config, installation } from './config.js';
import { sessionEvents } from './sessions.js';
import { getParticipantSession, isCheckedIn } from './discord-auth.js';
import { participantEvents } from './participants.js';
import { checkpoint, loadCheckpoint, deleteCheckpoint } from './checkpoints.js';
import { announceResult } from './notifications.js';

/** Commands the control panel may send to the game (the bridge's command set). */
const GAME_COMMANDS = new Set(['key', 'setQuestion', 'setAll', 'redraw', 'fiftyPick', 'lifelineUsed', 'goToLevel']);

/** In-memory data of each show: last game state and audience votes. */
const runtime = new Map();
function rt(id) {
    let r = runtime.get(id);
    if (!r) {
        r = { state: null, voting: { open: false, auto: false, session: 0, votes: new Map() }, ataTimer: null, voterKey: '', activeOutput: null, pendingCommands: new Map(), recoveryPending: !!loadCheckpoint(id) };
        runtime.set(id, r);
    }
    return r;
}

export function outputUrl(room) {
    return `${config.outputPublicUrl}/o/${encodeURIComponent(room.id)}/${room.loadId}/default.html?t=${encodeURIComponent(room.outputToken)}`;
}

/** Largest-remainder percentages over the answers still in play. */
export function percentages(counts, out = []) {
    const active = [0, 1, 2, 3].filter(i => !out[i]);
    const total = active.reduce((s, i) => s + counts[i], 0);
    if (!total) return null;
    const raw = [0, 0, 0, 0];
    active.forEach(i => { raw[i] = counts[i] * 100 / total; });
    const result = raw.map(Math.floor);
    let rest = 100 - result.reduce((a, b) => a + b, 0);
    for (const i of [...active].sort((a, b) => (raw[b] - result[b]) - (raw[a] - result[a]))) {
        if (rest <= 0) break;
        result[i]++;
        rest--;
    }
    return result;
}

export function attachShows(io) {
    const toOutputs = id => io.to('out:' + id);
    const toControls = id => io.to('ctl:' + id);
    const toVoters = id => io.to('vote:' + id);
    const outputCount = id => io.sockets.adapter.rooms.get('out:' + id)?.size ?? 0;

    const sendPrimary = (id, command) => {
        const active = rt(id).activeOutput;
        if (active) io.to(active).emit('cmd', command);
    };
    sessionEvents.on('revoked', id => io.in('session:' + id).disconnectSockets(true));
    participantEvents.on('deleted', key => {
        fff.forgetAccount(key);
        for (const [id, r] of runtime) {
            const identity = voterIdentity(key, id, r.voting.session);
            if (r.voting.votes.delete(identity)) {
                const room = store.get(id);
                if (room) { toControls(id).emit('tally', tally(room)); scheduleAta(room); }
            }
        }
    });
    participantEvents.on('export', (key, data) => { data.fastestFinger = fff.exportAccount(key); });
    function voterIdentity(key, room, session) {
        return crypto.createHmac('sha256', config.sessionSecret).update(`vote:${room}:${session}:${key}`).digest('hex');
    }
    // ------------------------------------------------------------------ show log
    onShowEvent((roomId, event) => io.to('log:' + roomId).emit('showEvent', event));
    /** Records an event in the show's own log, tagged with the current game and level. */
    const ev = (room, type, message, extra = {}) => showEvent(room.id, {
        type, message, game: room.game || 0, level: rt(room.id).state?.level ?? null, ...extra
    });

    function newGame(room, reason) {
        room.game = (room.game || 0) + 1;
        rt(room.id).gameEnded = false;
        saveRooms();
        ev(room, 'game', `Game ${room.game} started (${reason})`, { data: { contestant: room.contestant } });
    }

    /** A question went on air: it gets its unique ID if it had none, and is marked as used in the question bank. */
    async function markAired(room, isSwitch, level) {
        if (!db.enabled || room.mode !== 'live') return;
        const q = room.questions[isSwitch ? 'sw' : 'main'][level - 1];
        if (!q?.text?.trim()) return;
        try {
            let uid = q.uid;
            if (!uid) {
                [uid] = await ensureUids([q], { source: 'show', sourceRef: room.name });
                if (uid) { q.uid = uid; saveRooms(); broadcastRoom(room); }
            }
            if (uid) {
                await markUsed(uid, room.id, room.game || 0);
                ev(room, 'game', `Question ${uid} marked as used in the question bank`, { level, data: { uid } });
            }
        } catch { /* the show goes on */ }
    }

    /**
     * Sets the contestant's name (or alias) and hometown, from the control panel or the player screen:
     * saved, sent to the game's name strap, and a new game starts in the show log when the name changes.
     */
    function setContestant(room, c, source) {
        const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
        const before = `${room.contestant?.first ?? ''} ${room.contestant?.last ?? ''}`.trim();
        room.contestant = { first: clean(c?.first, 60), last: clean(c?.last, 60), location: clean(c?.location, 80) };
        saveRooms();
        const name = `${room.contestant.first} ${room.contestant.last}`.trim();
        if (name && name !== before) newGame(room, `new contestant ${name} (${source})`);
        toOutputs(room.id).emit('cmd', { cmd: 'contestant', ...room.contestant });
        roblox.queue(room, { type: 'value', path: 'Workspace.QandASystem.QuestionControl.Values.ContestantName', value: name });
        broadcastRoom(room);
        return { name, before };
    }

    // ------------------------------------------------------------------ Roblox set
    /** The question of a level, loaded into the set before its buttons show it. */
    function robloxQuestion(room, level, isSwitch) {
        const q = room.questions[isSwitch ? 'sw' : 'main'][level - 1];
        if (!q?.text) return;
        const correct = 'ABCD'[q.correct] ?? 'A';
        // 50:50: the two answers the set removes (the control room's choice, else two wrong ones at random)
        let fifty = Array.isArray(room.fiftyPick) && room.fiftyPick.length === 2 ? room.fiftyPick.map(l => String(l).toUpperCase()) : null;
        if (!fifty) fifty = 'ABCD'.split('').filter(l => l !== correct).sort(() => Math.random() - 0.5).slice(0, 2);
        roblox.queue(room, { type: 'question', level, isSwitch, text: q.text, answers: q.answers, correct, fifty: fifty.sort().join('') });
    }

    /** Every moment of the game becomes an event for the Roblox set (the buttons mapped to it are pressed there). */
    function robloxChanges(room, prev, s) {
        if (!room.roblox?.enabled || !prev) return;
        const e = (id, extra) => roblox.event(room, id, extra);
        const sc = s.screen ?? {}, pc = prev.screen ?? {}, L = s.level;
        if (prev.commercial !== s.commercial) e(s.commercial ? 'commercial-on' : 'commercial-off');
        if (prev.treeShowing !== s.treeShowing) e(s.treeShowing ? 'tree-show' : 'tree-hide');
        if (prev.level !== L) e('new-question-level', { level: L });
        const newQuestion = sc.visible && !pc.visible, switched = sc.visible && pc.visible && sc.isSwitch && !pc.isSwitch;
        if (newQuestion || switched) {
            robloxQuestion(room, L, !!sc.isSwitch);
            e(switched ? 'stq-new-question' : 'question-on-screen', { level: L });
        }
        if (!sc.visible && pc.visible) e('question-off-screen');
        if (sc.locked && sc.locked !== pc.locked) e('lock-' + sc.locked);
        if (!sc.locked && pc.locked && sc.visible && !sc.revealedCorrect) e('lock-withdrawn');
        if (sc.revealedCorrect && !pc.revealedCorrect) {
            const locked = sc.locked || pc.locked;
            const right = !locked || locked === sc.revealedCorrect;
            e(right ? 'reveal-correct' : 'reveal-wrong', { level: L });
            if (right && L >= (s.prizes?.length || 15)) e('top-prize');
        }
        if (s.walkAway && !prev.walkAway) e('walk-away');
        if (s.used?.[0] && !prev.used?.[0]) e('lifeline-ff');
        if (s.ataStep !== prev.ataStep) { const id = { 1: 'ata-start', 2: 'ata-graph', 3: 'ata-vote', 4: 'ata-results', 0: 'ata-close' }[s.ataStep]; if (id) e(id); }
        if (s.pafStep !== prev.pafStep) {
            const id = (s.clocked ? { 1: 'paf-start', 2: 'paf-call', 5: 'paf-clock', 6: 'paf-end' } : { 1: 'paf-start', 2: 'paf-call', 3: 'paf-clock', 4: 'paf-end' })[s.pafStep];
            if (id) e(id);
        }
        if (s.stqStep !== prev.stqStep) { const id = { 1: 'stq-start', 2: 'stq-reveal-correct', 3: 'stq-switch' }[s.stqStep]; if (id) e(id); }
        if (s.ddActive !== prev.ddActive) e(s.ddActive ? 'dd-start' : 'dd-end');
        if (s.ateStep !== prev.ateStep) { const id = { 1: 'ate-start', 3: 'ate-talk', 4: 'ate-end' }[s.ateStep]; if (id) e(id); }
        // Fastest Finger (the step counter is the step about to be played)
        const fs = s.fff, fp = prev.fff;
        if (fs?.active && fs.step !== fp?.step) {
            if (fs.step === 1 && !(fp?.active && fp.step >= 1)) e('fff-intro');
            else if (fs.step === 13) e('fff-question');
            else if (fs.step === 15) e('fff-items');
            else if (fs.step >= 19 && fs.step <= 22) e('fff-order', { item: fs.step - 18 });
            else if (fs.step === 24) e('fff-results');
            else if (fs.step === 26) e('fff-winner');
        }
    }

    /** Turns the difference between two game states into readable gameplay events. */
    function describeChanges(room, prev, s) {
        const r = rt(room.id);
        const game = (message, data) => ev(room, 'game', message, { level: s.level ?? null, data });
        const sc = s.screen ?? {}, pc = prev?.screen ?? {};
        const L = s.level;
        if (!prev) { game(`Output connected: question ${L}, ${s.inProgress ? 'question in progress' : 'between questions'}`); return; }

        if (prev.commercial !== s.commercial) game(s.commercial ? 'Commercial break (logo)' : 'Back from the commercial break');
        if (prev.treeShowing !== s.treeShowing) game(s.treeShowing ? 'Money tree on screen' : 'Money tree hidden');
        if (prev.level !== L) game(`Now playing question ${L}` + (s.boxes ? `: ${s.boxes.tick} for a right answer, ${s.boxes.cash} already won, ${s.boxes.cross} guaranteed` : ''), s.boxes);

        if (sc.visible && !pc.visible) {
            if (!room.game || r.gameEnded) newGame(room, 'first question on screen');
            game(`Question ${L}${sc.isSwitch ? ' (replacement)' : ''} on screen: ${sc.text}`, { answers: sc.answers, correct: s.correct, isSwitch: sc.isSwitch });
            markAired(room, !!sc.isSwitch, L);
        } else if (sc.visible && pc.visible && sc.isSwitch && !pc.isSwitch) {
            game(`Replacement question ${L} on screen: ${sc.text}`, { answers: sc.answers, correct: s.correct });
            markAired(room, true, L);
        }
        if (!sc.visible && pc.visible) game(`Question ${prev.level} taken off screen`);

        (sc.shown || []).forEach((on, i) => {
            if (on && !pc.shown?.[i] && sc.visible) game(`Answer ${'ABCD'[i]} revealed: ${sc.answers[i]}`);
        });
        const out = (s.out || []).map((o, i) => o && !prev.out?.[i] ? 'ABCD'[i] : null).filter(Boolean);
        if (out.length && s.inProgress) game(`Answer${out.length > 1 ? 's' : ''} ${out.join(' and ')} removed`);

        if (sc.locked && sc.locked !== pc.locked) game(`Final answer ${sc.locked.toUpperCase()} locked: ${sc.answers?.['abcd'.indexOf(sc.locked)] ?? ''}`);
        if (!sc.locked && pc.locked && sc.visible && !sc.revealedCorrect) game(`Final answer ${pc.locked.toUpperCase()} withdrawn`);

        if (sc.revealedCorrect && !pc.revealedCorrect) {
            const c = sc.revealedCorrect, locked = sc.locked || pc.locked;
            const text = sc.answers?.['abcd'.indexOf(c)] ?? '';
            if (s.clock?.timeUp && !locked) {
                game(`TIME UP: the correct answer was ${c.toUpperCase()} (${text})`, { correct: c });
                r.gameEnded = true;
            } else if (!locked || locked === c) {
                game(`CORRECT: ${c.toUpperCase()} (${text}) - question ${L} won`, { answer: c });
                if (L >= (s.prizes?.length || 15)) { r.gameEnded = true; game('The contestant won the top prize'); }
            } else {
                game(`WRONG: ${locked.toUpperCase()} locked, the correct answer was ${c.toUpperCase()} (${text})`, { locked, correct: c });
                r.gameEnded = true;
            }
        }
        if (s.boxes?.winnings && s.boxes.winnings !== prev.boxes?.winnings) game(`Winnings: ${s.boxes.winnings}`);
        if (s.walkAway && !prev.walkAway && !r.gameEnded) {
            game(`The contestant walks away with ${s.boxes?.winnings || s.boxes?.cash || ''}`.trim());
            r.gameEnded = true;
        }

        (s.used || []).forEach((u, i) => {
            if (u && !prev.used?.[i]) game(`Lifeline used: ${LIFELINE_NAMES[i]}`);
            if (!u && prev.used?.[i]) game(`Lifeline available again: ${LIFELINE_NAMES[i]}`);
        });
        if (s.ataStep !== prev.ataStep) {
            const p = s.ataPercents || [];
            const text = { 1: 'Ask the Audience: started', 2: 'Ask the Audience: graph on screen', 3: 'Ask the Audience: voting',
                4: `Ask the Audience results: ${'ABCD'.split('').map((l, i) => `${l} ${p[i] ?? 0}%`).join(' · ')}`, 0: 'Ask the Audience: graph closed' }[s.ataStep];
            if (text) game(text, s.ataStep === 4 ? { percentages: p } : null);
        }
        if (s.pafStep !== prev.pafStep) {
            const text = (s.clocked
                ? { 1: 'Phone a Friend: started (clock paused)', 2: 'Phone a Friend: the call screen', 3: 'Phone a Friend: choosing the friend to call', 5: 'Phone a Friend: 30-second call clock started', 6: 'Phone a Friend: call ended early', 7: 'Phone a Friend: question clock back on screen' }
                : { 1: 'Phone a Friend: started', 2: 'Phone a Friend: the call', 3: 'Phone a Friend: 30-second clock started', 4: 'Phone a Friend: call ended early' })[s.pafStep];
            if (text) game(text);
        }
        if (s.stqStep !== prev.stqStep && s.stqStep === 1) game('Switch the Question: started');
        if (s.ddActive !== prev.ddActive) game(s.ddActive ? 'Double Dip activated' : 'Double Dip finished');

        // Clocked 2009: question clock, banked time, Ask the Expert, Phone a Friend contact
        const ck = s.clock, pk = prev.clock;
        if (ck && pk) {
            if (ck.running && !pk.running) game(`Clock running: ${ck.text || ck.seconds}${ck.gold ? ' (gold clock, banked time)' : ' s'}`);
            if (!ck.running && pk.running && !ck.timeUp) game(`Clock stopped at ${ck.text || ck.seconds}`);
            if (ck.timeUp && !pk.timeUp) { game(`TIME UP on question ${L}`); r.gameEnded = true; }
            if (ck.banked !== pk.banked) game(`Banked time: ${ck.bankedText || ck.banked + ' s'} (${ck.banked > pk.banked ? '+' : ''}${ck.banked - pk.banked} s)`);
        }
        if (s.ateStep !== prev.ateStep) {
            const text = { 1: 'Ask the Expert: started (clock paused)', 2: 'Ask the Expert: the expert on screen', 3: 'Ask the Expert: the expert is talking', 4: 'Ask the Expert: finished' }[s.ateStep];
            if (text) game(text);
        }
        if (prev.pafSelect && !s.pafSelect && s.pafContacts) {
            game('Phone a Friend: the friend to call was chosen');
        }
    }
    const voterCount = id => io.sockets.adapter.rooms.get('vote:' + id)?.size ?? 0;

    function counts(room) {
        const c = [0, 0, 0, 0];
        for (const v of rt(room.id).voting.votes.values()) c[v]++;
        return c;
    }

    function tally(room) {
        const r = rt(room.id);
        const c = !r.voting.open && r.voting.lastTally ? r.voting.lastTally.counts : counts(room);
        return {
            open: r.voting.open, auto: r.voting.auto, counts: c, total: c.reduce((a, b) => a + b, 0),
            percentages: percentages(c, r.state?.out), voters: voterCount(room.id)
        };
    }

    /** What the phones show: open/closed, the answers of the question being played, removed answers. */
    function voterView(room) {
        const r = rt(room.id);
        const level = Math.min(15, Math.max(1, r.state?.level || 1));
        const q = room.questions[r.state?.screen?.isSwitch ? 'sw' : 'main'][level - 1];
        return { question: r.voting.open ? q.text : '', round: `${room.id}:${r.voting.roundId || ''}`, closesAt: r.voting.closesAt || null, serverNow: Date.now(), open: r.voting.open, session: r.voting.session, level, answers: r.voting.open ? q.answers : ['', '', '', ''], out: r.state?.out ?? [false, false, false, false], show: room.name };
    }

    function pushVoterView(room, force) {
        const view = voterView(room);
        const key = JSON.stringify(view);
        const r = rt(room.id);
        if (!force && key === r.voterKey) return;
        r.voterKey = key;
        toVoters(room.id).emit('voting', view);
    }

    function ataCommand(room) {
        const source = room.ata.source;
        let perc = null;
        if (source === 'manual') perc = room.ata.manual;
        else if (source === 'votes') perc = percentages(tally(room).counts, rt(room.id).state?.out);
        return { cmd: 'ata', perc, live: true };
    }

    /** Live votes → graph, throttled; the bridge applies them during voting and re-animates if already revealed. */
    function scheduleAta(room) {
        const r = rt(room.id);
        if (room.ata.source !== 'votes' || r.ataTimer) return;
        r.ataTimer = setTimeout(() => {
            r.ataTimer = null;
            toOutputs(room.id).emit('cmd', ataCommand(room));
        }, 400);
    }

    function setVoting(room, open, auto) {
        const r = rt(room.id);
        if (open && !r.voting.open) {
            r.voting.votes.clear();
            r.voting.lastTally = null;
            r.voting.session++;
            r.voting.roundId = crypto.randomBytes(16).toString('hex');
            const seconds = Math.min(180, Math.max(5, Number(installation.get('AUDIENCE_VOTE_SECONDS')) || 30));
            r.voting.closesAt = Date.now() + seconds * 1000;
            r.voting.timer = setTimeout(() => setVoting(room, false, false), seconds * 1000); r.voting.timer.unref();
        }
        const wasOpen = r.voting.open;
        if (!open && wasOpen) r.voting.lastTally = tally(room);
        r.voting.open = open;
        if (!open) { clearTimeout(r.voting.timer); r.voting.closesAt = null; }
        r.voting.auto = !!auto && open;
        if (open && !wasOpen) ev(room, 'audience', `Audience voting opened${auto ? ' (automatically)' : ''}`);
        if (!open && wasOpen) {
            const t = r.voting.lastTally || tally(room);
            ev(room, 'audience', `Audience voting closed: ${t.total} vote(s)` + (t.percentages ? ' - ' + 'ABCD'.split('').map((l, i) => `${l} ${t.percentages[i]}%`).join(' · ') : ''), { data: t });
        }
        // Close with anonymous totals only. Individual choices are not retained after the turn.
        if (!open && wasOpen) r.voting.votes.clear();
        pushVoterView(room, true);
        toControls(room.id).emit('tally', tally(room));
        if (room.ata.source === 'votes') scheduleAta(room);
    }

    // ------------------------------------------------------------------ Fastest Finger First
    const fff = createFff({
        io, ev, logEvent, setContestant, toOutputs, toControls, saveRooms,
        stateOf: id => rt(id).state,
        onPrepared: (room, q) => roblox.queue(room, { type: 'fff', text: q.text, answers: q.answers, order: q.order })
    });

    function initialCommands(room) {
        const cmds = [
            { cmd: 'setAll', main: room.questions.main.map(toDto), sw: room.questions.sw.map(toDto) },
            // K plays the theme's own game_over.mp3 (see the bridge); this is only a fallback for themes without it
            { cmd: 'klaxonConfig', url: '/static/klaxon.wav' },
            ...(room.pafContacts ? [{ cmd: 'pafContacts', contacts: room.pafContacts }] : []),
            ataCommand(room),
            { cmd: 'fiftyPick', pick: room.fiftyPick }
        ];
        const c = room.contestant;
        if (c.first || c.last || c.location) cmds.push({ cmd: 'contestant', ...c });
        // A Fastest Finger round in progress survives a reload of the output
        cmds.push(...fff.initialCommands(room));
        return cmds;
    }

    function onState(room, s) {
        const r = rt(room.id);
        const previous = r.state;
        r.state = s;
        if (previous && (previous.level !== s.level || previous.screen?.isSwitch !== s.screen?.isSwitch)) {
            if (r.voting.open) setVoting(room, false, false);
            r.voting.lastTally = null;
        }
        const changedPhase = !previous || previous.level !== s.level || previous.target !== s.target || previous.questionStep !== s.questionStep || previous.screen?.isSwitch !== s.screen?.isSwitch || JSON.stringify(previous.used) !== JSON.stringify(s.used);
        checkpoint(room, s, changedPhase);
        toControls(room.id).emit('state', s);
        pushScreens(room);
        try { describeChanges(room, previous, s); } catch { /* the log must never break the show */ }
        try { fff.onState(room, previous, s); } catch { /* ignore */ }
        try { robloxChanges(room, previous, s); } catch { /* the set must never break the show */ }

        // Audience voting follows the game: open while the Ask the Audience graph is in its "voting" step
        if (room.ata.autoVoting) {
            if (s.ataStep === 3 && previous?.ataStep !== 3 && !r.voting.open) setVoting(room, true, true);
            else if (s.ataStep !== 3 && r.voting.open && r.voting.auto) setVoting(room, false, false);
        }
        if (!previous || previous.level !== s.level || previous.screen?.isSwitch !== s.screen?.isSwitch || JSON.stringify(previous.out) !== JSON.stringify(s.out)) pushVoterView(room);
    }

    // ------------------------------------------------------------------ host and player screens

    /**
     * What a screen shows. The player screen gets only what the audience can see (no correct answer before the
     * game reveals it, no host comments, no host boxes): filtered here, so nothing leaks to the browser.
     */
    function screenPayload(room, kind) {
        const s = rt(room.id).state;
        const assets = themeAssets(room.theme);
        const sc = s?.screen ?? null;
        const level = Math.min(15, Math.max(1, s?.level || 1));
        // The question of the current level (the replacement one once it is on screen), for the host comment
        const question = room.questions[sc?.visible && sc.isSwitch ? 'sw' : 'main'][level - 1] ?? null;
        const base = {
            kind, show: room.name, connected: !!s, level,
            question: sc?.visible ? {
                text: sc.text, answers: sc.answers, shown: sc.shown, locked: sc.locked,
                correct: sc.revealedCorrect || '',
                revealed: sc.revealedCorrect || ''
            } : null,
            tree: s?.tree ?? null, prizes: s?.prizes ?? [],
            lifelines: { order: assets?.order ?? [], supported: s?.supported ?? [], used: s?.used ?? [], ffReplacedByDd: !!s?.ffReplacedByDd, stqReplacedByAte: !!s?.stqReplacedByAte },
            contestant: room.contestant,
            // "TOTAL PRIZE WON" only while the contestant walks away, with the amount taken home
            winnings: s?.walkAway && s?.boxes ? { label: s.boxes.winningsLabel, value: s.boxes.winnings || s.boxes.cash } : null,
            // Clocked 2009: the question clock and the banked time, on both screens
            clock: s?.clock && (s.clock.showing || s.clock.running || s.clock.timeUp) ? {
                text: s.clock.text, seconds: s.clock.seconds, running: s.clock.running, gold: s.clock.gold,
                timeUp: s.clock.timeUp, banked: s.clock.bankedText
            } : null,
            // Ask the Audience results and the Phone a Friend clock, while they are on air (both screens)
            lifeline: lifelineDisplay(s),
            ended: room.status === 'ended'
        };
        if (kind !== 'host') return base;
        // Host only: the comment when the operator switches it on, and the correct answer once the final answer is locked
        const locked = sc?.visible ? sc.locked : '';
        return {
            ...base,
            message: room.hostMessage?.text ? room.hostMessage : null,
            comment: room.hostComment ? (question?.comment ?? '') : '',
            category: room.hostComment ? (question?.category ?? '') : '',
            boxes: s?.boxes ?? null,
            finalAnswer: locked && s?.correct ? { correct: s.correct, right: locked === s.correct } : null
        };
    }

    function lifelineDisplay(s) {
        if (!s?.inProgress) return null;
        if (s.ataStep === 4) {
            const answers = s.screen?.answers ?? ['', '', '', ''];
            return {
                kind: 'ata',
                rows: [0, 1, 2, 3].map(i => ({ letter: 'ABCD'[i], answer: answers[i], percent: Number(s.ataPercents?.[i]) || 0, out: !!s.out?.[i] }))
            };
        }
        if (s.pafClock) return { kind: 'paf', seconds: s.pafClock };
        return null;
    }

    function pushScreens(room) {
        for (const kind of ['host', 'player']) io.to(`scr:${room.id}:${kind}`).emit('screen', screenPayload(room, kind));
    }

    function roomInfo(room) {
        // never sent to the control panels: the screen password hashes and the Roblox key
        const { screens, roblox: rbx, ...rest } = room;
        return {
            ...rest, activeOutput: rt(room.id).activeOutput, activeOutputReady: !!io.sockets.sockets.get(rt(room.id).activeOutput)?.data.ready, outputConnections: [...(io.sockets.adapter.rooms.get('out:' + room.id) || [])].map(id => ({ id, active: id === rt(room.id).activeOutput })), recoveryPending: rt(room.id).recoveryPending, outputUrl: outputUrl(room), outputs: outputCount(room.id), roblox: { enabled: !!rbx?.enabled },
            screens: { host: !!screens?.host, player: !!screens?.player, ff: !!screens?.ff },
            screenViewers: { host: io.sockets.adapter.rooms.get(`scr:${room.id}:host`)?.size ?? 0, player: io.sockets.adapter.rooms.get(`scr:${room.id}:player`)?.size ?? 0 }
        };
    }

    function broadcastRoom(room) {
        toControls(room.id).emit('room', roomInfo(room));
        pushScreens(room);
    }

    function reloadOutputs(room) {
        const r = rt(room.id);
        if (r.state) checkpoint(room, r.state, true);
        r.recoveryPending = !!loadCheckpoint(room.id);
        r.state = null;
        toOutputs(room.id).emit('reload', outputUrl(room));
        broadcastRoom(room);
    }

    io.on('connection', socket => {
        const { role, room: roomId, token } = socket.handshake.query;
        const room = store.get(String(roomId || ''));

        // ------------------------------------------------------------------ output (the theme page)
        if (role === 'output') {
            if (!room || token !== room.outputToken) { socket.emit('fatal', 'Invalid show or output link'); socket.disconnect(true); return; }
            if (room.status === 'ended') { socket.emit('fatal', 'This show has ended'); socket.disconnect(true); return; }
            socket.join('out:' + room.id);
            const r = rt(room.id);
            if (!r.activeOutput) r.activeOutput = socket.id;
            socket.emit('authority', { active: r.activeOutput === socket.id, id: socket.id });
            socket.data.ready = false;
            broadcastRoom(room);
            ev(room, 'screen', `Game output connected (${outputCount(room.id)} open)`);

            socket.on('bridge', m => {
                if (!m || typeof m !== 'object') return;
                if (rt(room.id).activeOutput !== socket.id) return;
                if (m.type === 'commandAck') {
                    const pending = rt(room.id).pendingCommands.get(m.id);
                    if (pending) { clearTimeout(pending.timer); rt(room.id).pendingCommands.delete(m.id); pending.reply(m.error ? { ok: false, error: 'The game could not execute the command' } : { ok: true, id: m.id }); }
                    return;
                }
                if (m.type === 'state') {
                    if (!Number.isInteger(m.level) || m.level < 1 || m.level > 15 || JSON.stringify(m).length > 800000 || (m.screen && (!Array.isArray(m.screen.answers) || m.screen.answers.length !== 4))) return;
                    if (!socket.data.ready) {
                        socket.data.ready = true;
                        for (const c of initialCommands(room)) socket.emit('cmd', c);
                        broadcastRoom(room);
                    }
                    if (!rt(room.id).recoveryPending) onState(room, m);
                } else if (m.type === 'error') {
                    toControls(room.id).emit('bridgeError', String(m.message ?? '').slice(0, 300));
                }
            });
            socket.on('disconnect', () => {
                const r = rt(room.id);
                if (r.activeOutput === socket.id) {
                    if (r.state) checkpoint(room, r.state, true);
                    r.activeOutput = null; r.recoveryPending = !!loadCheckpoint(room.id);
                    for (const pending of r.pendingCommands.values()) { clearTimeout(pending.timer); pending.reply({ ok: false, error: 'Output disconnected; execution is uncertain. Check the game before retrying.' }); }
                    r.pendingCommands.clear();
                }
                broadcastRoom(room); ev(room, 'screen', `Game output disconnected (${outputCount(room.id)} open)`);
            });
            return;
        }

        const person = getParticipantSession(socket.handshake.headers.cookie);
        if (person) {
            socket.join('session:' + person.id);
            const expiry = setTimeout(() => socket.disconnect(true), Math.max(1, person.exp - Date.now())); expiry.unref();
            socket.on('disconnect', () => clearTimeout(expiry));
        }
        if (room?.mode === 'live' && ['voter', 'console', 'screen'].includes(role) && (role !== 'screen' || socket.handshake.query.kind !== 'host')) {
            if (!person || !isCheckedIn(person.accountKey, room.id)) { socket.emit('fatal', 'Sign in with Discord and check in to this show from /account'); socket.disconnect(true); return; }
            socket.data.accountKey = person.accountKey;
        }
        // ------------------------------------------------------------------ Fastest Finger console
        if (role === 'console') {
            if (!room) { socket.emit('fatal', 'This show does not exist'); socket.disconnect(true); return; }
            if (room.status === 'ended') { socket.emit('ended', 'This show has ended'); socket.disconnect(true); return; }
            if (!screenAuthorized(socket.handshake.headers.cookie, room.id, 'ff', room.screens?.ff)) {
                socket.emit('fatal', 'Not authorised: open the console link again and enter the password');
                socket.disconnect(true);
                return;
            }
            socket.join('layout:ff');
            socket.emit('layout', layoutStore.css('ff'));
            fff.attachConsole(socket, room);
            return;
        }

        // ------------------------------------------------------------------ host / player screen
        if (role === 'screen') {
            const kind = socket.handshake.query.kind === 'host' ? 'host' : 'player';
            if (room?.status === 'ended') { socket.emit('ended', 'This show has ended'); socket.disconnect(true); return; }
            if (!room || !screenAuthorized(socket.handshake.headers.cookie, room.id, kind, room.screens?.[kind])) {
                socket.emit('fatal', 'Not authorised: open the screen link again and enter the password');
                socket.disconnect(true);
                return;
            }
            socket.join(`scr:${room.id}:${kind}`);
            socket.join('layout:' + kind);
            socket.emit('layout', layoutStore.css(kind));
            socket.emit('screen', screenPayload(room, kind));
            if (kind === 'player') {
                // The contestant types their own name (or alias) and hometown on the player screen
                socket.on('contestant', (c, ack) => {
                    const reply = typeof ack === 'function' ? ack : () => { };
                    if (room.status === 'ended') return reply({ error: 'This show has ended' });
                    const first = String(c?.first ?? '').trim(), last = String(c?.last ?? '').trim();
                    if (!first && !last) return reply({ error: 'Enter a name or an alias' });
                    const { name } = setContestant(room, c, 'player screen');
                    const where = room.contestant.location ? ' - ' + room.contestant.location : '';
                    ev(room, 'screen', `Contestant entered on the player screen: ${name}${where}`);
                    logEvent('screen.player.contestant', { room: room.id, details: room.contestant, ip: socket.handshake.address });
                    reply({ ok: true, contestant: room.contestant });
                });
            }
            toControls(room.id).emit('room', roomInfo(room));
            ev(room, 'screen', `${kind === 'host' ? 'Host' : 'Player'} screen connected`);
            socket.on('disconnect', () => { toControls(room.id).emit('room', roomInfo(room)); ev(room, 'screen', `${kind === 'host' ? 'Host' : 'Player'} screen disconnected`); });
            return;
        }

        // ------------------------------------------------------------------ audience keypad
        if (role === 'voter') {
            if (!room) { socket.emit('fatal', 'This show does not exist'); socket.disconnect(true); return; }
            if (room.status === 'ended') { socket.emit('fatal', 'This show has ended. Thank you for playing!'); socket.disconnect(true); return; }
            socket.join('vote:' + room.id);
            socket.emit('voting', voterView(room));
            toControls(room.id).emit('tally', tally(room));

            socket.on('vote', (payload, ack) => {
                const reply = typeof ack === 'function' ? ack : () => { };
                const r = rt(room.id);
                const suppliedLetter = String(payload?.letter ?? '').toLowerCase();
                const letter = /^[abcd]$/.test(suppliedLetter) ? 'abcd'.indexOf(suppliedLetter) : -1;
                if (room.mode === 'live' && (!getParticipantSession(socket.handshake.headers.cookie) || !isCheckedIn(person.accountKey, room.id))) return reply({ ok: false, reason: 'unauthorized' });
                if (payload?.round !== `${room.id}:${r.voting.roundId}`) return reply({ ok: false, reason: 'stale' });
                const device = person ? voterIdentity(person.accountKey, room.id, r.voting.session) : String(payload?.device ?? '').slice(0, 64);
                if (!r.voting.open) return reply({ ok: false, reason: 'closed' });
                if (letter < 0 || !device) return reply({ ok: false, reason: 'invalid' });
                if (r.state?.out?.[letter]) return reply({ ok: false, reason: 'removed' });
                // One vote per device and per connection in each voting session
                if (r.voting.votes.has(device) || socket.data.votedSession === r.voting.session)
                    return reply({ ok: false, reason: 'already', letter: 'ABCD'[r.voting.votes.get(device) ?? letter] });
                r.voting.votes.set(device, letter);
                socket.data.votedSession = r.voting.session;
                reply({ ok: true, letter: 'ABCD'[letter] });
                /* No per-account vote or device identifier is written to the show log. */
                toControls(room.id).emit('tally', tally(room));
                scheduleAta(room);
            });
            socket.on('disconnect', () => toControls(room.id).emit('tally', tally(room)));
            return;
        }

        // ------------------------------------------------------------------ control panel
        if (role === 'control') {
            const session = getSession(socket.handshake.headers.cookie);
            if (!session) { socket.emit('authError'); socket.disconnect(true); return; }
            socket.join('session:' + session.id);
            const expiry = setTimeout(() => socket.disconnect(true), Math.max(1, session.exp - Date.now())); expiry.unref();
            socket.on('disconnect', () => clearTimeout(expiry));
            socket.use((packet, next) => {
                if (!getSession(socket.handshake.headers.cookie)) { socket.disconnect(true); return; }
                next();
            });
            const ip = socket.handshake.address;
            const log = (action, details) => logEvent(action, { user: session.user, room: current?.id ?? null, details, ip });
            const act = (message, data) => { if (current) ev(current, 'control', message, { user: session.user, data }); };

            // Show management page: follow the log of any show live
            let watching = null;
            socket.on('log:watch', id => {
                if (watching) socket.leave('log:' + watching);
                watching = store.get(String(id || '')) ? String(id) : null;
                if (watching) socket.join('log:' + watching);
            });
            let current = null;
            const joined = () => current && store.get(current.id) ? current : null;
            // Fastest Finger dashboard (seats, rounds, results)
            fff.attachControl(socket, { session, joined, act });

            socket.on('join', id => {
                if (current) socket.leave('ctl:' + current.id);
                current = store.get(String(id || '')) ?? null;
                if (!current) return socket.emit('room', null);
                socket.join('ctl:' + current.id);
                socket.emit('room', roomInfo(current));
                socket.emit('tally', tally(current));
                if (rt(current.id).state) socket.emit('state', rt(current.id).state);
            });

            socket.on('cmd', (msg, ack) => {
                const reply = typeof ack === 'function' ? ack : () => {};
                const room = joined();
                if (!room || !msg || !GAME_COMMANDS.has(msg.cmd)) return reply({ ok: false, error: 'Invalid command or show' });
                const r = rt(room.id);
                const editing = ['setQuestion', 'setAll'].includes(msg.cmd);
                if (!editing && r.pendingCommands.size) return reply({ ok: false, error: 'Wait for the output to confirm the pending command' });
                if (editing && room.frozen) return reply({ ok: false, error: 'The approved show is frozen. Return to rehearsal to edit.' });
                if (!editing && (r.recoveryPending || !r.activeOutput)) return reply({ ok: false, error: r.recoveryPending ? 'Restore the checkpoint or explicitly discard it before continuing' : 'No active output' });
                if (!editing && (typeof msg.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(msg.id) || !Number.isFinite(msg.sentAt) || Math.abs(Date.now() - msg.sentAt) > 5000)) return reply({ ok: false, error: 'Expired or invalid command. Check the game and try again.' });
                socket.data.seenCommands ??= new Map();
                for (const [id, at] of socket.data.seenCommands) if (Date.now() - at > 60000) socket.data.seenCommands.delete(id);
                if (!editing && socket.data.seenCommands.has(msg.id)) return reply({ ok: false, error: 'Duplicate command rejected' });
                if (!editing) socket.data.seenCommands.set(msg.id, Date.now());
                if (room.status === 'ended' && msg.cmd !== 'setQuestion' && msg.cmd !== 'setAll') {
                    socket.emit('bridgeError', 'This show has ended: reopen it from the Shows page to control it again');
                    return;
                }
                // Keep the show's own copy of what changes
                if (msg.cmd === 'setQuestion') {
                    const level = Number(msg.level);
                    if (!Number.isInteger(level) || !(level >= 1 && level <= 15)) return reply({ ok: false, error: 'Invalid level' });
                    const q = cleanQuestion(msg.question);
                    room.questions[msg.isSwitch ? 'sw' : 'main'][level - 1] = q;
                    saveRooms();
                    act(`Edited ${msg.isSwitch ? 'replacement ' : ''}question ${level}: ${q.text.slice(0, 120)}`, { question: q });
                    toOutputs(room.id).emit('cmd', { cmd: 'setQuestion', level, isSwitch: !!msg.isSwitch, q: toDto(q) });
                    socket.to('ctl:' + room.id).emit('room', roomInfo(room));
                    pushVoterView(room);
                    reply({ ok: true, saved: true });
                    return;
                }
                if (msg.cmd === 'setAll') {
                    const clean = list => Array.from({ length: 15 }, (_, i) => cleanQuestion(list?.[i]));
                    if (msg.main) room.questions.main = clean(msg.main);
                    if (msg.sw) room.questions.sw = clean(msg.sw);
                    saveRooms();
                    log('questions.replaceAll', { source: msg.source || 'panel' });
                    act(`Replaced all the questions (${msg.source || 'control panel'})`);
                    toOutputs(room.id).emit('cmd', { cmd: 'setAll', main: room.questions.main.map(toDto), sw: room.questions.sw.map(toDto) });
                    socket.to('ctl:' + room.id).emit('room', roomInfo(room));
                    pushVoterView(room, true);
                    reply({ ok: true, saved: true });
                    return;
                }
                if (msg.cmd === 'fiftyPick') {
                    room.fiftyPick = Array.isArray(msg.pick) && msg.pick.length === 2 ? msg.pick.map(l => String(l).toLowerCase().slice(0, 1)) : null;
                    saveRooms();
                    act(room.fiftyPick ? `50:50 set to remove ${room.fiftyPick.join(' and ').toUpperCase()}` : '50:50 set to random');
                    toOutputs(room.id).emit('cmd', { cmd: 'fiftyPick', pick: room.fiftyPick });
                    reply({ ok: true, saved: true });
                    return;
                }
                if (msg.cmd === 'key' && Number(msg.code) === 37) {
                    const refused = fff.beforeKey37(room);
                    if (refused) { socket.emit('bridgeError', refused); return reply({ ok: false, error: refused }); }
                }
                const forward = { ...msg };
                if (msg.cmd === 'key') forward.code = Number(msg.code) | 0;
                if (msg.cmd === 'goToLevel') forward.level = Math.min(15, Math.max(1, Number(msg.level) | 0));
                if (msg.cmd === 'goToLevel') log('show.goToLevel', { level: forward.level });
                if (msg.cmd === 'key') {
                    const live = rt(room.id).state;
                    if (live?.pafSelect && forward.code >= 49 && forward.code <= 51) {
                        const c = live.pafContacts?.[forward.code - 49];
                        act(`Phone a Friend: calling ${c ? `${c.first} ${c.last}`.trim() || `friend ${forward.code - 48}` : `friend ${forward.code - 48}`}`);
                    } else act(`Pressed ${KEY_NAMES[forward.code] || 'key ' + forward.code}`);
                }
                if (msg.cmd === 'goToLevel') act(`Restarted the game from question ${forward.level}`);
                if (msg.cmd === 'lifelineUsed') act(`${LIFELINE_NAMES[LIFELINE_IDS.indexOf(msg.id)] || msg.id} marked as ${msg.used ? 'used' : 'available'}`);
                if (msg.cmd === 'redraw') act('Question on screen rewritten (fix on screen)');
                if (msg.cmd === 'lifelineUsed') log('show.lifelineUsed', { id: msg.id, used: !!msg.used });
                if (msg.cmd === 'key' && forward.code === 75) log('show.klaxon');
                if (msg.cmd === 'key') { const id = { 75: 'klaxon', 71: 'game-over', 76: 'lifelines-strap' }[forward.code]; if (id) roblox.event(room, id); }
                if (msg.cmd === 'key' && forward.code === 71) log('show.gameOver');
                const timer = setTimeout(() => {
                    r.pendingCommands.delete(msg.id);
                    reply({ ok: false, error: 'No game confirmation. Check the output before retrying.' });
                }, 4000); timer.unref();
                r.pendingCommands.set(msg.id, { reply, timer });
                sendPrimary(room.id, forward);
            });

            socket.on('contestant', c => {
                const room = joined();
                if (!room) return;
                const { name } = setContestant(room, c, 'control panel');
                log('show.contestant', room.contestant);
                act(`Contestant: ${name || '(no name)'}${room.contestant.location ? ' - ' + room.contestant.location : ''}`);
            });

            socket.on('hostMessage', text => {
                const room = joined();
                if (!room) return;
                const clean = String(text ?? '').trim().slice(0, 500);
                const previous = room.hostMessage?.text;
                room.hostMessage = clean ? { text: clean, by: session.user, at: new Date().toISOString() } : null;
                saveRooms();
                if (clean) { act(`Message to the host: ${clean}`); log('show.hostMessage', { text: clean }); }
                else if (previous) { act('Message to the host cleared'); log('show.hostMessage.clear', { previous }); }
                broadcastRoom(room);
            });

            socket.on('pafContacts', list => {
                const room = joined();
                if (!room || !Array.isArray(list)) return;
                const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
                room.pafContacts = [0, 1, 2].map(i => ({ first: clean(list[i]?.first, 40), last: clean(list[i]?.last, 40), location: clean(list[i]?.location, 60) }));
                saveRooms();
                act(`Phone a Friend contacts: ${room.pafContacts.map(c => `${c.first} ${c.last}`.trim() || '-').join(', ')}`);
                toOutputs(room.id).emit('cmd', { cmd: 'pafContacts', contacts: room.pafContacts });
                broadcastRoom(room);
            });

            socket.on('hostComment', on => {
                const room = joined();
                if (!room) return;
                room.hostComment = !!on;
                saveRooms();
                act(`Host comment ${room.hostComment ? 'shown' : 'hidden'} on the host screen`);
                broadcastRoom(room);
            });

            socket.on('ata', a => {
                const room = joined();
                if (!room) return;
                if (['game', 'manual', 'votes'].includes(a?.source)) room.ata.source = a.source;
                if (Array.isArray(a?.manual) && a.manual.length === 4) room.ata.manual = a.manual.map(v => Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
                if (typeof a?.autoVoting === 'boolean') room.ata.autoVoting = a.autoVoting;
                saveRooms();
                if (a?.source) act(`Ask the Audience percentages from: ${{ game: "the game's random ones", manual: 'manual values', votes: 'live audience votes' }[room.ata.source]}`);
                if (a?.manual) act(`Manual audience percentages: ${room.ata.manual.map((v, i) => `${'ABCD'[i]} ${v}%`).join(' · ')}`);
                if (typeof a?.autoVoting === 'boolean') act(`Automatic audience voting ${a.autoVoting ? 'on' : 'off'}`);
                toOutputs(room.id).emit('cmd', ataCommand(room));
                broadcastRoom(room);
            });

            socket.on('voting', v => {
                const room = joined();
                if (!room) return;
                if (v?.reset) { rt(room.id).voting.votes.clear(); rt(room.id).voting.lastTally = null; rt(room.id).voting.session++; rt(room.id).voting.roundId = crypto.randomBytes(16).toString('hex'); act('Audience votes reset'); }
                if (typeof v?.open === 'boolean') act(v.open ? 'Opened audience voting' : 'Closed audience voting');
                if (typeof v?.open === 'boolean') setVoting(room, v.open, false);
                else { toControls(room.id).emit('tally', tally(room)); pushVoterView(room, true); scheduleAta(room); }
            });

            // ------------------------------------------------------------------ AI question generator
            let aiRun = null;
            socket.on('ai:cancel', () => aiRun?.abort());
            socket.on('ai:generate', async (opts, ack) => {
                const reply = typeof ack === 'function' ? ack : () => { };
                const room = joined();
                if (!room) return reply({ error: 'Choose a show first' });
                if (aiRun) return reply({ error: 'A generation is already running' });
                const from = Math.min(15, Math.max(1, Number(opts?.from) || 1));
                const to = Math.min(15, Math.max(from, Number(opts?.to) || 15));
                const main = opts?.main !== false, replacement = !!opts?.replacement;
                if (!main && !replacement) return reply({ error: 'Tick main and/or replacement questions' });

                const ai = platformSettings.get().ai;
                let engine;
                try { engine = engineFor(ai); } catch (e) { return reply({ error: e.message }); }

                const skipMain = new Set(), skipReplacement = new Set();
                if (opts?.onlyEmpty) room.questions.main.forEach((q, i) => { if (q.text.trim()) skipMain.add(i + 1); });
                if (opts?.onlyEmpty) room.questions.sw.forEach((q, i) => { if (q.text.trim()) skipReplacement.add(i + 1); });
                const avoid = [];
                for (let level = 1; level <= 15; level++) {
                    const inRange = level >= from && level <= to;
                    if (!(inRange && main && !skipMain.has(level))) avoid.push(room.questions.main[level - 1].text);
                    if (!(inRange && replacement && !skipReplacement.has(level))) avoid.push(room.questions.sw[level - 1].text);
                }

                aiRun = new AbortController();
                try {
                    const results = await generate(engine, {
                        from, to, main, replacement,
                        language: String(opts?.language || ai.language || 'English').slice(0, 40),
                        topic: String(opts?.topic ?? ai.topic ?? '').slice(0, 300),
                        extra: String(opts?.extra ?? ai.extra ?? '').slice(0, 2000),
                        skipMain, skipReplacement, avoid
                    }, { shuffle: opts?.shuffle !== false, signal: aiRun.signal, progress: text => socket.emit('ai:progress', text) });
                    let stackId = null;
                    if (db.enabled && results.length) {
                        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                        try {
                            stackId = await stacks.save({
                                name: `${engine.name} · levels ${from}-${to} · ${stamp}`, source: ai.provider, user: session.user,
                                notes: [opts?.topic ?? ai.topic, opts?.language || ai.language].filter(Boolean).join(' · '),
                                kind: 'ai',
                                slots: results.map(r => ({ level: r.level, replacement: r.replacement, question: r.question, difficulty: r.level, difficultySource: 'ai' }))
                            });
                        } catch { /* the questions are still returned */ }
                    }
                    log('ai.generate', { engine: engine.name, from, to, main, replacement, count: results.length, stackId });
                    act(`Generated ${results.length} question(s) with ${engine.name} (levels ${from}-${to})${stackId ? `, saved as stack #${stackId}` : ''}`);
                    reply({ results, stackId });
                } catch (e) {
                    reply({ error: aiRun.signal.aborted ? 'Generation cancelled' : e.message });
                } finally {
                    aiRun = null;
                }
            });
            socket.on('disconnect', () => aiRun?.abort());

            // ------------------------------------------------------------------ question bank: long AI tasks
            let bankRun = null;
            socket.on('bank:cancel', () => bankRun?.abort());
            socket.on('disconnect', () => bankRun?.abort());
            const bankTask = async (name, work, ack) => {
                const reply = typeof ack === 'function' ? ack : () => { };
                if (!db.enabled) return reply({ error: 'The question bank needs the MySQL database (Admin → Connections)' });
                if (bankRun) return reply({ error: 'Another question bank task is already running' });
                bankRun = new AbortController();
                try {
                    const result = await work(bankRun.signal, text => socket.emit('bank:progress', text));
                    logEvent(name, { user: session.user, details: result, ip });
                    reply({ result });
                } catch (e) {
                    reply({ error: bankRun.signal.aborted ? 'Cancelled' : e.message });
                } finally {
                    bankRun = null;
                }
            };
            socket.on('bank:rate', (opts, ack) => bankTask('bank.rate', (signal, progress) =>
                rateWithAi(platformSettings.get().ai, { includeAi: !!opts?.includeAi, signal, progress }), ack));
            socket.on('bank:generate', (opts, ack) => bankTask('bank.generate', (signal, progress) =>
                generateIntoBank(platformSettings.get().ai, {
                    perLevel: Math.min(50, Math.max(1, Number(opts?.perLevel) || 1)),
                    // one level only: `count` questions all for that level (e.g. 10 for question 15)
                    level: Number(opts?.level) >= 1 && Number(opts?.level) <= 15 ? Math.round(Number(opts.level)) : null,
                    count: Math.min(100, Math.max(1, Math.round(Number(opts?.count) || 10))),
                    language: String(opts?.language || platformSettings.get().ai.language || 'English').slice(0, 40),
                    topic: String(opts?.topic ?? '').slice(0, 300), extra: String(opts?.extra ?? '').slice(0, 2000),
                    user: session.user, signal, progress
                }), ack));

            socket.on('reload', () => {
                const room = joined();
                if (!room) return;
                if (room.mode === 'live') { socket.emit('bridgeError', 'Return to rehearsal before reloading the output'); return; }
                room.loadId++;
                saveRooms();
                log('show.reloadOutput');
                act('Reloaded the game output (clean cache)');
                reloadOutputs(room);
            });
        }
    });

    return {
        flushCheckpoints() { for (const [id, r] of runtime) { const room = store.get(id); if (room && r.state && !r.recoveryPending) checkpoint(room, r.state, true); } },
        /** A room's theme or output link changed: every output reloads (fresh URL = no cached files). */
        reload(room) {
            room.loadId++;
            saveRooms();
            reloadOutputs(room);
        },
        checkpointInfo(id) {
            const saved = loadCheckpoint(id);
            return saved ? { savedAt: saved.savedAt, level: saved.state?.level, pending: rt(id).recoveryPending } : null;
        },
        restoreCheckpoint(room, saved) {
            const r = rt(room.id);
            if (!r.activeOutput || !io.sockets.sockets.get(r.activeOutput)?.data.ready) throw new Error('Wait for the output to finish loading before restoring');
            if (saved.state?.fff?.active || saved.state?.ataStep || saved.state?.pafStep || saved.state?.stqStep || saved.state?.ddActive || saved.state?.ateStep) throw new Error('Checkpoint is inside a timed round or lifeline. Return to rehearsal and restart from a safe question.');
            if (!saved.state?.recovery || saved.state.recovery.version !== 1) throw new Error('This checkpoint predates recovery support');
            return new Promise((resolve, reject) => {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => { r.pendingCommands.delete(id); reject(new Error('Recovery not confirmed by the output. Verify the screen before continuing.')); }, 4000); timer.unref();
                r.pendingCommands.set(id, { timer, reply: result => {
                    if (!result.ok) return reject(new Error(result.error));
                    r.recoveryPending = false;
                    room.game = saved.game; saveRooms(); broadcastRoom(room); resolve();
                } });
                sendPrimary(room.id, { cmd: 'restore', state: saved.state, id });
            });
        },
        resetForMode(room) {
            const r = rt(room.id);
            setVoting(room, false, false);
            r.state = null; r.recoveryPending = false;
            deleteCheckpoint(room.id);
            for (const key of ['vote:' + room.id, 'ffc:' + room.id, `scr:${room.id}:player`]) io.in(key).disconnectSockets(true);
            toOutputs(room.id).emit('reload', outputUrl(room));
        },
        takeover(room, id) {
            if (typeof id !== 'string' || !io.sockets.adapter.rooms.get('out:' + room.id)?.has(id)) throw new Error('Choose a connected output');
            const r = rt(room.id);
            r.activeOutput = id; r.recoveryPending = !!loadCheckpoint(room.id);
            for (const output of io.sockets.adapter.rooms.get('out:' + room.id) || []) io.to(output).emit('authority', { active: output === id, id: output });
            for (const cmd of initialCommands(room)) io.to(id).emit('cmd', cmd);
            broadcastRoom(room);
        },
        discardCheckpoint(room) { deleteCheckpoint(room.id); rt(room.id).recoveryPending = false; broadcastRoom(room); },
        broadcastRoom,
        pushScreens,
        event: (room, type, message, extra) => ev(room, type, message, extra),
        /** A layout was saved in the Layout editor: every open screen / console of that kind applies it at once. */
        broadcastLayout: target => io.to('layout:' + target).emit('layout', layoutStore.css(target)),
        /** A button pressed by hand in the Roblox set (reported by the set): into the show log. */
        robloxPressed: (room, path, player) => ev(room, 'control', `Roblox set: ${player || 'someone'} pressed ${String(path).replace(/^Workspace\./, '')}`, { user: player || null }),
        /** Ends a show: marked as ended, voting closed, output, screens and phones sent away. The log is kept. */
        endShow(room, user) {
            const r = rt(room.id);
            if (room.mode === 'live') announceResult(room.id, r.state?.boxes?.winnings || '').catch(() => {});
            if (r.voting.open) setVoting(room, false, false);
            room.status = 'ended';
            room.endedAt = new Date().toISOString();
            room.endedBy = user;
            room.hostMessage = null;
            saveRooms();
            ev(room, 'show', `Show ended by ${user}`, { user });
            toOutputs(room.id).emit('fatal', 'This show has ended');
            io.to(`scr:${room.id}:host`).emit('ended', 'This show has ended');
            io.to(`scr:${room.id}:player`).emit('ended', 'This show has ended');
            toVoters(room.id).emit('fatal', 'This show has ended. Thank you for playing!');
            for (const key of ['out:' + room.id, `scr:${room.id}:host`, `scr:${room.id}:player`, 'vote:' + room.id]) io.in(key).disconnectSockets(true);
            r.state = null;
            broadcastRoom(room);
        },
        reopenShow(room, user) {
            room.status = 'active';
            room.endedAt = null;
            room.endedBy = null;
            saveRooms();
            ev(room, 'show', `Show reopened by ${user}`, { user });
            broadcastRoom(room);
        },
        /** Live status of a show for the management page. */
        summary(id) {
            const s = rt(id).state;
            const size = key => io.sockets.adapter.rooms.get(key)?.size ?? 0;
            return {
                outputs: outputCount(id), host: size(`scr:${id}:host`), player: size(`scr:${id}:player`), phones: voterCount(id),
                level: s?.level ?? null, inProgress: !!s?.inProgress, winnings: s?.boxes?.winnings ?? null
            };
        },
        dropRoom(id) {
            toOutputs(id).emit('fatal', 'This show has been deleted');
            for (const key of ['out:' + id, 'ctl:' + id, 'vote:' + id, 'ffc:' + id, `scr:${id}:host`, `scr:${id}:player`]) io.in(key).disconnectSockets(true);
            deleteCheckpoint(id);
            runtime.delete(id);
        }
    };
}
