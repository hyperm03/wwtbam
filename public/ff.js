/* Fastest Finger console: the contestant puts A, B, C and D in order and confirms. Remote device or physical console (?seat=N). */
(() => {
    'use strict';
    const $ = s => document.getElementById(s);
    // /ff/<show>, or /layout-preview/ff (Layout editor: sample data, no show)
    const preview = location.pathname.split('/')[1] === 'layout-preview';
    const room = preview ? '' : decodeURIComponent(location.pathname.split('/')[2] || '');
    const params = new URLSearchParams(location.search);
    const seatParam = params.get('seat');
    const kiosk = !!seatParam;

    // The same device keeps its seat when it reconnects
    let clientId = null;
    try { clientId = localStorage.getItem('mc_ff_client'); if (!clientId) { clientId = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('mc_ff_client', clientId); } } catch { clientId = Math.random().toString(36).slice(2); }

    let view = null, order = [], shownAt = null, lastPhase = null, sending = false, timeTimer = null;

    // In the Layout editor preview there is no show: a stand-in for the connection, and sample data
    const socket = preview ? { on() { }, emit(e, m, cb) { if (typeof cb === 'function') cb({ ok: true }); } }
        : io({ query: { role: 'console', room, clientId, ...(kiosk ? { seat: seatParam } : {}) } });
    socket.on('layout', css => { document.getElementById('mc-layout').textContent = css || ''; });
    // The name is remembered on the device and sent again after a reconnection (e.g. a restart of the server)
    const NAME_KEY = 'mc_ff_name_' + room + (kiosk ? '_seat' + seatParam : '');
    const savedName = () => { try { return JSON.parse(localStorage.getItem(NAME_KEY) || 'null'); } catch { return null; } };
    socket.on('connect', () => {
        $('net').classList.add('on');
        const n = savedName();
        if (n && (n.first || n.last)) socket.emit('ff:name', n, () => { });
    });
    socket.on('disconnect', () => { socket.sendBuffer = []; $('net').classList.remove('on'); sending = false; document.querySelectorAll('.keys button').forEach(b => { b.disabled = true; }); setStrap('Connection lost: reconnecting...'); });
    socket.on('ff:ping', m => socket.emit('ff:pong', m));
    socket.on('ff:full', () => setStrap('All 10 seats are taken: ask the control room'));
    socket.on('ff:released', () => setStrap('This seat was freed by the control room'));
    socket.on('fatal', message => {
        if (String(message).includes('Sign in with Discord')) location.replace(`/account?room=${encodeURIComponent(room)}&next=${encodeURIComponent(location.pathname)}`);
        else setStrap(esc(String(message || 'Access denied. Open the console link again.')));
    });
    socket.on('ended', () => setStrap('This show has ended.'));
    socket.on('ff:view', v => {
        view = v;
        if (v.name) { try { localStorage.setItem(NAME_KEY, JSON.stringify(v.name)); } catch { /* private mode */ } }
        render();
    });

    // ------------------------------------------------------------------ rendering
    function setStrap(html) { $('strap').innerHTML = html; }
    const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const letters = o => o.map(l => `<b>${l}</b>`).join(' ');

    function render() {
        const v = view;
        $('seatLabel').textContent = `Seat ${v.seat}${v.kiosk ? '' : ' · remote'}`;
        const n = v.name;
        $('who').textContent = n ? [`${n.first} ${n.last}`.trim(), n.location].filter(Boolean).join(' - ') : 'Tap here to enter your name';
        if (!n && !savedName() && $('nameForm').hidden && v.phase !== 'open') openNameForm();

        // A new answering phase: start this console's own clock when the items are drawn
        if (v.phase === 'open' && lastPhase !== 'open' && lastPhase !== 'locked') {
            order = [];
            requestAnimationFrame(() => { shownAt = performance.now(); });
        }
        if (v.phase !== 'open') { clearInterval(timeTimer); $('timebar').style.visibility = 'hidden'; }
        if (v.phase === 'open' && lastPhase !== 'open') startTimeBar(v.remainingMs, v.limitSec);
        lastPhase = v.phase;

        const q = $('question');
        q.classList.toggle('dim', false);
        q.textContent = v.text || '';

        const showItems = ['open', 'locked', 'closed', 'result'].includes(v.phase);
        renderItems(showItems ? v.answers : null, v);

        const canType = v.phase === 'open';
        document.querySelectorAll('.keys .letter').forEach(b => { b.disabled = !canType || order.includes(b.dataset.l); });
        $('del').disabled = !canType || !order.length;
        $('go').disabled = !canType || order.length !== 4 || sending;

        switch (v.phase) {
            case 'idle': setStrap(`Seat ${v.seat} · waiting for the<br>Fastest Finger round`); q.textContent = ''; break;
            case 'notPlaying': setStrap(v.tieBreak ? 'Tie-breaker in progress' : 'You are not playing this round'); q.textContent = ''; break;
            case 'ready': setStrap(v.tieBreak ? 'Tie-breaker!<br>Get ready' : 'Get ready!'); q.textContent = ''; break;
            case 'question': setStrap('Listen to the question...'); break;
            case 'open':
                setStrap(order.length === 4
                    ? `${letters(order)} <span class="ok">OK</span><br>Press &#10004; to confirm`
                    : `Order A B C D<br>${order.length ? letters(order) + ' ' : ''}${'<b>_</b> '.repeat(4 - order.length)}`);
                break;
            case 'locked': setStrap(`Answer locked<br>${letters(v.mine.order.split(''))}`); break;
            case 'closed': setStrap(v.mine ? `Answer locked: ${letters(v.mine.order.split(''))}<br>Waiting for the results` : 'Time is up<br>Waiting for the results'); break;
            case 'result': {
                const r = v.result;
                if (!r || !v.mine) setStrap('No answer given');
                else if (r.winner) setStrap(`You are the fastest!<br><b>${r.time.toFixed(2)} s</b>`);
                else if (r.tie) setStrap(`Tie at ${r.time.toFixed(2)} s<br>Tie-breaker!`);
                else if (r.correct) setStrap(`Correct in ${r.time.toFixed(2)} s`);
                else setStrap(`Wrong order<br>Correct: ${letters((r.correctOrder || '').split(''))}`);
                break;
            }
        }
    }

    function renderItems(answers, v) {
        const box = $('items');
        if (!answers) { box.replaceChildren(); return; }
        const shownOrder = v.phase === 'open' ? order : (v.mine?.order || '').split('');
        const correctOrder = v.phase === 'result' ? (v.result?.correctOrder || '') : '';
        box.replaceChildren(...'ABCD'.split('').map((L, i) => {
            const pos = shownOrder.indexOf(L);
            const item = document.createElement('div');
            item.className = 'item' + (pos >= 0 ? ' picked' : '') + (correctOrder && v.result?.correct ? ' correct' : '');
            item.innerHTML = `<div class="badge" data-edit="badge" data-edit-label="Letter badges">${L}</div><div class="lozenge" data-edit="lozenge" data-edit-label="Item lozenges (border)"><div class="face" data-edit="lozenge-inside" data-edit-label="Item lozenges (inside and text)">${esc(answers[i])}</div></div><div class="pos" data-edit="position" data-edit-label="Order number">${pos + 1}</div>`;
            item.addEventListener('click', () => press(L));
            return item;
        }));
    }

    function startTimeBar(remainingMs, limitSec) {
        const bar = $('timebar'), fill = bar.firstElementChild;
        bar.style.visibility = 'visible';
        const end = performance.now() + (remainingMs ?? limitSec * 1000), total = limitSec * 1000;
        clearInterval(timeTimer);
        timeTimer = setInterval(() => {
            const left = Math.max(0, end - performance.now());
            fill.style.transform = `scaleX(${left / total})`;
            if (!left) clearInterval(timeTimer);
        }, 50);
    }

    // ------------------------------------------------------------------ input
    function press(letter) {
        if (view?.phase !== 'open' || order.includes(letter) || order.length >= 4) return;
        order.push(letter);
        if (navigator.vibrate) navigator.vibrate(15);
        render();
    }
    function backspace() {
        if (view?.phase !== 'open' || !order.length) return;
        order.pop();
        render();
    }
    function confirm() {
        if (view?.phase !== 'open' || order.length !== 4 || sending || !socket.connected) return;
        const elapsed = shownAt != null ? performance.now() - shownAt : null;
        sending = true;
        render();
        socket.timeout(4000).emit('ff:answer', { order: order.join(''), elapsed, roundId: view.roundId }, (error, res) => {
            sending = false;
            if (error) { setStrap('Answer not confirmed. Check your connection.'); return; }
            if (res?.error) setStrap(esc(res.error));
            if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
        });
    }

    document.querySelectorAll('.keys .letter').forEach(b => b.addEventListener('click', () => press(b.dataset.l)));
    $('del').addEventListener('click', backspace);
    $('go').addEventListener('click', confirm);
    addEventListener('keydown', e => {
        if (!$('nameForm').hidden) return;
        const k = e.key.toUpperCase();
        if ('ABCD'.includes(k) && k.length === 1) press(k);
        else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
        else if (e.key === 'Enter') confirm();
    });

    // ------------------------------------------------------------------ name
    const overlay = $('nameForm'), form = overlay.querySelector('form'), msg = overlay.querySelector('.msg');
    const field = n => form.querySelector(`[name="${n}"]`);
    function openNameForm() {
        const n = view?.name || {};
        field('first').value = n.first || ''; field('last').value = n.last || ''; field('location').value = n.location || '';
        msg.textContent = '';
        overlay.hidden = false;
        setTimeout(() => field('first').focus(), 50);
    }
    $('who').addEventListener('click', () => { if (view && !['open', 'locked'].includes(view.phase)) openNameForm(); });
    overlay.querySelector('[data-close]').addEventListener('click', () => { overlay.hidden = true; });
    form.addEventListener('submit', e => {
        e.preventDefault();
        socket.emit('ff:name', { first: field('first').value, last: field('last').value, location: field('location').value }, res => {
            if (res?.error) { msg.textContent = res.error; return; }
            overlay.hidden = true;
        });
    });

    // ------------------------------------------------------------------ physical consoles: full screen, screen always on
    $('fullscreen').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => { });
    });
    let wakeLock = null;
    async function keepAwake() {
        try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not supported */ }
    }
    if (kiosk) { keepAwake(); document.addEventListener('visibilitychange', keepAwake); }
    document.addEventListener('contextmenu', e => e.preventDefault());

    if (preview) {
        const sample = state => ({
            seat: 3, kiosk: true, name: { first: 'Mattia', last: 'Rozzi', location: 'Milano' }, limitSec: 20, remainingMs: 14000,
            phase: { open: 'open', locked: 'locked', result: 'result', idle: 'idle', question: 'question' }[state] || 'open',
            text: state === 'idle' ? '' : 'Put these planets in order, starting with the closest to the Sun',
            answers: ['Earth', 'Mercury', 'Mars', 'Venus'],
            mine: ['locked', 'result'].includes(state) ? { order: 'BDAC', time: 4.37 } : null,
            result: state === 'result' ? { correct: true, time: 4.37, order: 'BDAC', winner: true, tie: false, correctOrder: 'BDAC' } : null
        });
        lastPhase = null; view = sample(new URLSearchParams(location.search).get('state') || 'open'); render();
        addEventListener('message', e => {
            if (e.origin !== location.origin) return;
            if (e.data?.type === 'state') { lastPhase = null; view = sample(e.data.state); render(); }
        });
        const editor = document.createElement('script');
        editor.src = '/static/layout-edit.js';
        document.body.append(editor);
    }
})();
