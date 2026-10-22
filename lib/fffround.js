import crypto from 'node:crypto';
import { fffQuestions } from './fff.js';
import { latencySummary, measuredAnswer, tiedSeats } from './fff-timing.js';

/**
 * Fastest Finger First rounds: 10 seats (physical consoles fixed to a seat, or remote players), the players chosen
 * for the round, answers opened on air at the same moment on every console, fair times, results, tie-breakers and
 * the winner handed over as the show's contestant.
 *
 * Timing: each console measures its own time from the moment it shows the four items (no network jitter). The
 * server checks it against its own clock minus the console's round-trip time, measured every 2 seconds, so a
 * console cannot claim to be faster than the server saw it (beyond ~60 ms of jitter).
 */
const SEATS = 10;
const PING_MS = 2000;

export function createFff({ io, ev, logEvent, setContestant, toOutputs, toControls, stateOf, saveRooms, onPrepared = () => { } }) {
    const runtime = new Map();
    const R = roomId => {
        if (!runtime.has(roomId)) {
            runtime.set(roomId, {
                seats: Array.from({ length: SEATS }, (_, i) => ({ n: i + 1, clientId: null, sockets: new Set(), name: null, kiosk: false, rtts: [], selected: true })),
                round: null, limitSec: 20, lastTie: null, history: []
            });
        }
        return runtime.get(roomId);
    };

    const fullName = p => `${p?.first ?? ''} ${p?.last ?? ''}`.trim();
    const median = list => { if (!list.length) return 0; const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const seatOf = (roomId, n) => R(roomId).seats[n - 1];

    // ------------------------------------------------------------------ ping (round-trip time of every console)
    setInterval(() => {
        for (const [roomId] of runtime) for (const socketId of io.sockets.adapter.rooms.get('ffc:' + roomId) || []) {
            const socket = io.sockets.sockets.get(socketId);
            if (!socket) continue;
            const nonce = crypto.randomBytes(16).toString('hex');
            socket.data.ping = { nonce, at: performance.now() };
            socket.volatile.emit('ff:ping', { nonce });
        }
    }, PING_MS).unref();

    // ------------------------------------------------------------------ views
    function consoleView(room, seat) {
        const f = R(room.id), round = f.round, step = stateOf(room.id)?.fff?.step ?? 0;
        const view = { seat: seat.n, kiosk: seat.kiosk, name: seat.name, limitSec: f.limitSec, now: Date.now() };
        if (!round) return { ...view, phase: 'idle' };
        const playing = round.players.includes(seat.n);
        if (!playing) return { ...view, phase: 'notPlaying', tieBreak: round.tieBreak };
        const mine = round.answers[seat.n] ?? null;
        const q = round.question;
        const questionOnAir = round.phase !== 'ready' || step >= 13;
        const base = { ...view, roundId: round.id, tieBreak: round.tieBreak, text: questionOnAir ? q.text : '', mine: mine ? { order: mine.order, time: mine.time } : null };
        if (round.phase === 'ready') return { ...base, phase: questionOnAir ? 'question' : 'ready' };
        if (round.phase === 'open') return { ...base, phase: mine ? 'locked' : 'open', answers: q.answers, remainingMs: Math.max(0, round.goAt + f.limitSec * 1000 - Date.now()) };
        // closed: the personal result once the times are revealed on air (the step counter is the NEXT step: 24 means
        // step 23 "reveal the times" has been played) or the round is over
        const revealed = step >= 24 || !stateOf(room.id)?.fff?.active || round.done;
        const res = round.results?.rows.find(r => r.seat === seat.n);
        return {
            ...base, phase: revealed ? 'result' : 'closed', answers: q.answers,
            result: revealed && res ? { correct: res.correct, time: res.time, order: res.order, winner: round.results.winner === seat.n, tie: round.results.tie.includes(seat.n), correctOrder: q.order } : null
        };
    }

    function dashboard(room) {
        const f = R(room.id), round = f.round;
        return {
            limitSec: f.limitSec,
            seats: f.seats.map(s => ({ n: s.n, connected: s.sockets.size > 0, name: s.name, kiosk: s.kiosk, rtt: Math.round(median(s.rtts)), network: latencySummary(s.rtts), selected: s.selected, taken: !!s.clientId })),
            round: round && {
                id: round.id, phase: round.phase, tieBreak: round.tieBreak, replay: round.replay, done: !!round.done, question: round.question,
                players: round.players.map(n => ({ n, name: seatOf(room.id, n).name, answered: !!round.answers[n], connected: seatOf(room.id, n).sockets.size > 0 })),
                results: round.results, applied: !!round.applied, goAt: round.goAt ?? null, remainingMs: round.phase === 'open' ? Math.max(0, round.goAt + f.limitSec * 1000 - Date.now()) : null
            },
            questions: { total: fffQuestions.list().length, unused: fffQuestions.list().filter(q => !q.used).length },
            history: f.history.slice(-10)
        };
    }

    function push(room) {
        const f = R(room.id);
        for (const seat of f.seats) for (const id of seat.sockets) io.to(id).emit('ff:view', consoleView(room, seat));
        toControls(room.id).emit('fff', dashboard(room));
    }

    // ------------------------------------------------------------------ output (the theme's Fastest Finger graphics)
    function setupCommand(room) {
        const round = R(room.id).round;
        return {
            cmd: 'fff', action: 'setup', tieBreak: round.tieBreak || round.replay,
            question: { text: round.question.text, answers: round.question.answers, order: round.question.order },
            players: round.players.map(n => seatOf(room.id, n).name || { first: `Player ${n}`, last: '', location: '' })
        };
    }
    function resultsCommand(room) {
        const round = R(room.id).round, res = round.results;
        const rows = round.players.map(n => res.rows.find(r => r.seat === n));
        const winnerSeat = res.winner ?? res.tie[0] ?? null;
        return {
            cmd: 'fff', action: 'results',
            times: rows.map(r => (r && r.time != null ? r.time.toFixed(2) : '')),
            correct: rows.map(r => !!r?.correct),
            winner: winnerSeat ? round.players.indexOf(winnerSeat) + 1 : 1
        };
    }
    /** When the output (re)loads during a round. */
    function initialCommands(room) {
        const round = R(room.id).round;
        if (!round || round.done) return [];
        return [setupCommand(room), ...(round.results ? [resultsCommand(room)] : [])];
    }

    // ------------------------------------------------------------------ round life cycle
    function prepare(room, { uid = null, players, tieBreak = false, replay = false, user }) {
        const f = R(room.id);
        if (f.round && ['ready', 'open'].includes(f.round.phase)) throw new Error('A round is already in progress: cancel it first');
        const exclude = f.round?.question?.uid ? [f.round.question.uid] : [];
        const q = uid ? fffQuestions.get(uid) : fffQuestions.randomUnused(exclude);
        if (!q) throw new Error(uid ? 'Question not found' : 'No unused Fastest Finger question left: add or import some');
        const list = [...new Set(players)].filter(n => n >= 1 && n <= SEATS).sort((a, b) => a - b);
        if (!list.length) throw new Error('No player for this round: choose the seats (connected, with a name)');
        const missing = list.filter(n => !seatOf(room.id, n).name);
        if (missing.length) throw new Error(`Seat ${missing.join(', ')} has no name yet`);
        f.round = { id: crypto.randomBytes(4).toString('hex'), question: { uid: q.uid, text: q.text, answers: q.answers, order: q.order }, players: list, phase: 'ready', tieBreak, replay, answers: {}, results: null };
        toOutputs(room.id).emit('cmd', setupCommand(room));
        try { onPrepared(room, f.round.question); } catch { /* ignore */ }
        const who = list.map(n => `${n}. ${fullName(seatOf(room.id, n).name)}`).join(', ');
        ev(room, 'game', `Fastest Finger${tieBreak ? ' TIE-BREAKER' : replay ? ' (new question)' : ''} prepared: ${q.uid} "${q.text}" - ${list.length} player(s): ${who}`, { user, data: { uid: q.uid, order: q.order, players: list } });
        push(room);
    }

    function open(room) {
        const f = R(room.id), round = f.round;
        if (!round || round.phase !== 'ready') return;
        round.phase = 'open';
        round.goAt = Date.now();
        round.goMono = performance.now();
        if (room.mode === 'live') fffQuestions.setUsed(round.question.uid, true, room.id);
        ev(room, 'game', `Fastest Finger: the four items are on air, ${f.limitSec} seconds to answer`);
        clearTimeout(round.timer);
        round.timer = setTimeout(() => close(room, 'time is up'), f.limitSec * 1000 + 400);
        push(room);
    }

    function answer(room, seatNo, order, clientElapsed) {
        const f = R(room.id), round = f.round;
        if (!round || round.phase !== 'open') return { error: 'Answers are closed' };
        if (!round.players.includes(seatNo)) return { error: 'You are not playing this round' };
        if (round.answers[seatNo]) return { error: 'Your answer is already locked' };
        const clean = String(order || '').toUpperCase();
        if (!/^[ABCD]{4}$/.test(clean) || new Set(clean).size !== 4) return { error: 'Use A, B, C and D once each' };
        const serverElapsed = performance.now() - round.goMono;
        if (serverElapsed > f.limitSec * 1000 + 400) return { error: 'Time is up' };
        const rtt = median(seatOf(room.id, seatNo).rtts);
        const { time, uncertaintyMs, unstable } = measuredAnswer(serverElapsed, seatOf(room.id, seatNo).rtts);
        round.answers[seatNo] = { order: clean, time, uncertaintyMs, unstable, serverElapsed, rtt: Math.round(rtt) };
        const correct = clean === round.question.order;
        ev(room, 'game', `Fastest Finger: seat ${seatNo} (${fullName(seatOf(room.id, seatNo).name)}) answered ${clean.split('').join(' ')} in ${time.toFixed(2)} s - ${correct ? 'correct' : 'wrong'}`, { data: { seat: seatNo, order: clean, time, rtt: Math.round(rtt) } });
        push(room);
        if (round.players.every(n => round.answers[n])) close(room, 'everyone answered');
        return { ok: true, time };
    }

    function close(room, why) {
        const f = R(room.id), round = f.round;
        if (!round || round.phase !== 'open') return;
        clearTimeout(round.timer);
        round.phase = 'closed';
        const rows = round.players.map(n => {
            const a = round.answers[n];
            return { seat: n, name: fullName(seatOf(room.id, n).name), order: a?.order ?? null, time: a?.time ?? null, uncertaintyMs: a?.uncertaintyMs, unstable: a?.unstable, correct: !!a && a.order === round.question.order };
        });
        const correct = rows.filter(r => r.correct).sort((a, b) => a.time - b.time);
        const tied = tiedSeats(rows);
        round.results = {
            rows: rows.sort((a, b) => (b.correct - a.correct) || ((a.time ?? 999) - (b.time ?? 999))),
            winner: tied.length === 1 ? tied[0] : null, tie: tied.length > 1 ? tied : [], noneCorrect: !correct.length
        };
        toOutputs(room.id).emit('cmd', resultsCommand(room));
        const r = round.results;
        const summary = r.winner ? `winner: seat ${r.winner} (${fullName(seatOf(room.id, r.winner).name)}) in ${correct[0].time.toFixed(2)} s`
            : r.tie.length ? `TIE at ${correct[0].time.toFixed(2)} s between seats ${r.tie.join(' and ')}: a tie-breaker is needed`
                : 'nobody answered correctly: a new question is needed';
        ev(room, 'game', `Fastest Finger closed (${why}): ${correct.length} correct of ${rows.length} - ${summary}`, { data: r });
        f.lastTie = r.tie.length ? r.tie : null;
        f.history.push({ at: new Date().toISOString(), uid: round.question.uid, tieBreak: round.tieBreak, players: round.players.length, winner: r.winner ? fullName(seatOf(room.id, r.winner).name) : null, tie: r.tie.length > 0 });
        push(room);
    }

    /** The winner becomes the show's contestant (automatically when the game shows the winner, or by hand). */
    function applyWinner(room, seatNo, user = null) {
        const round = R(room.id).round;
        const seat = seatOf(room.id, seatNo);
        if (!round || !seat?.name) return;
        round.applied = true;
        round.done = true;
        setContestant(room, seat.name, 'Fastest Finger');
        ev(room, 'game', `Fastest Finger winner: ${fullName(seat.name)}${seat.name.location ? ' - ' + seat.name.location : ''} is the contestant`, { user });
        push(room);
    }

    function cancel(room, user) {
        const f = R(room.id);
        if (!f.round) return;
        clearTimeout(f.round.timer);
        const was = f.round;
        f.round = null;
        toOutputs(room.id).emit('cmd', { cmd: 'fff', action: 'end' });
        ev(room, 'control', `Fastest Finger round ${was.done ? 'closed' : 'cancelled'}`, { user });
        push(room);
    }

    // ------------------------------------------------------------------ hooks from shows.js
    /**
     * Control pressed the Fastest Finger key (the step counter is the step about to be played):
     * - step 14: the four items go on air, so the answers open now;
     * - step 15 or later while answers are still open: the question leaves the screen, so the answers close now
     *   (the times always reach the graphics before they are revealed);
     * - steps 24-25 (flash the fastest, winner on full screen) without a single winner: refused, with a message.
     * Returns an error message when the key must not be sent to the output.
     */
    function beforeKey37(room) {
        const round = R(room.id).round;
        const s = stateOf(room.id);
        if (!round || !s?.fff?.active) return null;
        const step = s.fff.step;
        if (round.phase === 'ready' && step === 14) open(room);
        else if (round.phase === 'open' && step >= 15) close(room, 'the question left the screen');
        if ((step === 24 || step === 25) && round.phase === 'closed' && !round.results?.winner) {
            return round.results?.tie.length
                ? 'Tie: there is no single winner to show. Start the tie-breaker from the Fastest Finger tab.'
                : 'Nobody answered correctly: there is no winner to show. Use "New question for the same players".';
        }
        if (step >= 15 && round.phase === 'ready') return 'The four items have not been on air yet for this round.';
        return null;
    }

    function onState(room, prev, s) {
        const round = R(room.id).round;
        if (!round) return;
        if (prev?.fff?.step !== s?.fff?.step || prev?.fff?.active !== s?.fff?.active) {
            // The winner is on screen (step 25 done): hand over as the contestant
            if (s.fff.active && s.fff.step >= 26 && round.results?.winner && !round.applied) applyWinner(room, round.results.winner);
            push(room);
        }
    }

    // ------------------------------------------------------------------ sockets
    function attachConsole(socket, room) {
        const f = R(room.id);
        const clientId = socket.data.accountKey || String(socket.handshake.query.clientId || '').slice(0, 64) || crypto.randomBytes(8).toString('hex');
        const wanted = room.mode === 'live' ? NaN : Number(socket.handshake.query.seat);
        let seat = null;
        if (wanted >= 1 && wanted <= SEATS) {
            // Physical console: fixed to its seat (it replaces any previous device on that seat)
            seat = f.seats[wanted - 1];
            if (seat.clientId !== clientId) { seat.name = seat.kiosk ? seat.name : null; }
            seat.clientId = clientId;
            seat.kiosk = true;
        } else {
            // Remote player: the seat already held by this device, else the first free one
            seat = f.seats.find(s => s.clientId === clientId) ?? f.seats.find(s => !s.clientId);
            if (!seat) { socket.emit('ff:full'); socket.disconnect(true); return; }
            seat.clientId = clientId;
        }
        seat.sockets.add(socket.id);
        socket.join('ffc:' + room.id);
        ev(room, 'screen', `Fastest Finger console connected on seat ${seat.n} (${seat.kiosk ? 'physical console' : 'remote'})`);
        push(room);

        socket.on('ff:pong', m => {
            const ping = socket.data.ping;
            if (!ping || m?.nonce !== ping.nonce) return;
            delete socket.data.ping;
            const rtt = performance.now() - ping.at;
            if (rtt >= 0 && rtt < 5000) { seat.rtts.push(rtt); if (seat.rtts.length > 7) seat.rtts.shift(); }
        });
        socket.on('ff:name', (c, ack) => {
            const reply = typeof ack === 'function' ? ack : () => { };
            const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
            const name = { first: clean(c?.first, 60), last: clean(c?.last, 60), location: clean(c?.location, 80) };
            if (!name.first && !name.last) return reply({ error: 'Enter a name or an alias' });
            const round = f.round;
            if (round && round.players.includes(seat.n) && round.phase === 'open') return reply({ error: 'Not during the round' });
            seat.name = name;
            ev(room, 'screen', `Fastest Finger seat ${seat.n}: ${fullName(name)}${name.location ? ' - ' + name.location : ''}`);
            reply({ ok: true });
            push(room);
        });
        socket.on('ff:answer', (m, ack) => {
            const reply = typeof ack === 'function' ? ack : () => { };
            if (!m?.roundId || m.roundId !== R(room.id).round?.id) return reply({ error: 'This answer belongs to an expired round' });
            reply(answer(room, seat.n, m?.order, Number(m?.elapsed)));
        });
        socket.on('disconnect', () => {
            seat.sockets.delete(socket.id);
            ev(room, 'screen', `Fastest Finger console disconnected from seat ${seat.n}`);
            push(room);
        });
        socket.emit('ff:view', consoleView(room, seat));
    }

    function attachControl(socket, { session, joined, act }) {
        const handle = (event, fn) => socket.on(event, async (m, ack) => {
            const reply = typeof ack === 'function' ? ack : () => { };
            const room = joined();
            if (!room) return reply({ error: 'Choose a show first' });
            try { await fn(room, m || {}); reply({ ok: true }); } catch (e) { reply({ error: e.message }); }
        });
        handle('fff:get', room => socket.emit('fff', dashboard(room)));
        handle('fff:seat', (room, m) => {
            const seat = seatOf(room.id, Number(m.seat));
            if (!seat) throw new Error('Invalid seat');
            if (typeof m.selected === 'boolean') seat.selected = m.selected;
            if (m.name) {
                const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
                seat.name = { first: clean(m.name.first, 60), last: clean(m.name.last, 60), location: clean(m.name.location, 80) };
                act(`Fastest Finger seat ${seat.n} named ${fullName(seat.name)}`);
            }
            if (m.release) {
                for (const id of seat.sockets) io.sockets.sockets.get(id)?.emit('ff:released');
                for (const id of [...seat.sockets]) io.sockets.sockets.get(id)?.disconnect(true);
                seat.sockets.clear(); seat.clientId = null; seat.name = null; seat.kiosk = false; seat.rtts = [];
                act(`Fastest Finger seat ${seat.n} freed`);
            }
            push(room);
        });
        handle('fff:select', (room, m) => {
            R(room.id).seats.forEach((s, i) => { s.selected = !!m.seats?.[i]; });
            push(room);
        });
        handle('fff:limit', (room, m) => {
            R(room.id).limitSec = Math.min(60, Math.max(5, Math.round(Number(m.seconds) || 20)));
            push(room);
        });
        handle('fff:prepare', (room, m) => {
            const f = R(room.id);
            if (m.tieBreak && !f.lastTie) throw new Error('There is no tie to break');
            const players = m.tieBreak ? f.lastTie
                : m.replay ? (f.round?.players ?? [])
                    : f.seats.filter(s => s.selected && s.sockets.size > 0 && s.name).map(s => s.n);
            if (f.round && !['ready', 'open'].includes(f.round.phase)) f.round = null;
            prepare(room, { uid: m.uid || null, players, tieBreak: !!m.tieBreak, replay: !!m.replay, user: session.user });
        });
        handle('fff:close', room => close(room, 'closed by the control room'));
        handle('fff:winner', (room, m) => applyWinner(room, Number(m.seat), session.user));
        handle('fff:cancel', room => cancel(room, session.user));
    }

    function exportAccount(key) {
        return [...runtime].flatMap(([id, f]) => f.seats.filter(s => s.clientId === key).map(s => ({ show: id, seat: s.n, name: s.name, answer: f.round?.answers[s.n] || null })));
    }
    function forgetAccount(key) {
        for (const [id, f] of runtime) {
            const room = { id };
            for (const seat of f.seats.filter(s => s.clientId === key)) {
                const name = fullName(seat.name);
                for (const socketId of seat.sockets) io.sockets.sockets.get(socketId)?.disconnect(true);
                seat.sockets.clear(); seat.clientId = null; seat.name = null; seat.rtts = [];
                if (f.round) {
                    delete f.round.answers[seat.n]; f.round.players = f.round.players.filter(n => n !== seat.n);
                    if (f.round.results) {
                        f.round.results.rows = f.round.results.rows.filter(row => row.seat !== seat.n);
                        f.round.results.tie = f.round.results.tie.filter(n => n !== seat.n);
                        if (f.round.results.winner === seat.n) f.round.results.winner = null;
                    }
                }
                for (const item of f.history) if (item.winner === name) item.winner = null;
            }
            push(room);
        }
    }
    return { attachConsole, attachControl, beforeKey37, onState, initialCommands, dashboard, push, exportAccount, forgetAccount };
}
