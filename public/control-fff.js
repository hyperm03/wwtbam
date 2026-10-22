/* Millionaire Control - Fastest Finger First dashboard: consoles, seats, rounds, tie-breakers and questions */
(() => {
    'use strict';
    const { h, api, status, socket } = window.MC;
    const body = document.getElementById('fffBody');
    let data = null;          // dashboard from the server
    let questions = [];
    let qFilter = '';
    let tick = null;

    const fullName = n => n ? `${n.first} ${n.last}`.trim() : '';
    const send = (event, payload) => new Promise(resolve => socket.emit(event, payload, res => { if (res?.error) status(res.error, true); resolve(res); }));
    const isActive = () => document.getElementById('page-fff')?.classList.contains('active');

    /** What the next press of ← does on the theme's Fastest Finger sequence. */
    function stepLabel(step, players) {
        if (step < 10) return step < players ? `Introduce player ${step + 1} of ${players}` : 'Hide the name strap';
        return {
            10: 'Hide the name strap', 11: 'Music: read the question', 12: 'Question on screen', 13: 'Three stabs',
            14: 'THE FOUR ITEMS ON AIR - the consoles open', 15: 'Hide the question and the items', 16: 'Music: the correct order',
            17: 'Show the correct order panel', 18: 'Correct order: 1st item', 19: 'Correct order: 2nd item', 20: 'Correct order: 3rd item',
            21: 'Correct order: 4th item', 22: 'Show the players', 23: 'Reveal the times and the correct answers', 24: 'Flash the fastest',
            25: 'The winner on full screen (becomes the contestant)', 26: 'Hide the winner', 27: 'Music: hello - end of the Fastest Finger'
        }[step] ?? 'End';
    }

    socket.on('fff', d => { data = d; if (isActive()) render(); });
    // The show arrives (or changes) after the tab was opened, e.g. when the page opens straight on /control#fff
    let shownRoom = null;
    socket.on('room', r => {
        if (!isActive()) return;
        if (r?.id !== shownRoom) { shownRoom = r?.id; open(); } else if (data) render();
    });

    async function open() {
        if (!window.MC.room()) { body.replaceChildren(h('p', { class: 'muted' }, 'Loading the show...')); return; }
        shownRoom = window.MC.room().id;
        await send('fff:get', {});
        await loadQuestions();
        render();
        clearInterval(tick);
        tick = setInterval(() => { if (isActive() && data?.round?.phase === 'open') renderCountdown(); }, 200);
    }

    async function loadQuestions() {
        try { questions = await api('GET', '/api/fff/questions'); } catch (e) { questions = []; status(e.message, true); }
    }

    // ================================================================== rendering
    function render() {
        const room = window.MC.room();
        if (!room || !data) return;
        body.replaceChildren(consolesCard(room), seatsCard(), roundCard(), questionsCard());
    }

    // ------------------------------------------------------------------ consoles: password and links
    function consolesCard(room) {
        const base = `${location.origin}/ff/${encodeURIComponent(room.id)}`;
        const enabled = !!room.screens?.ff;
        const pass = h('input', { type: 'password', placeholder: enabled ? 'new password' : 'set a password to enable the consoles', size: 24, autocomplete: 'new-password' });
        const copy = text => navigator.clipboard?.writeText(text).then(() => status('Copied to the clipboard.'), () => prompt('Copy:', text));
        const seatLinks = h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
            ...Array.from({ length: 10 }, (_, i) => h('button', { title: `${base}?seat=${i + 1}`, onclick: () => copy(`${base}?seat=${i + 1}`) }, `Seat ${i + 1}`)));
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, 'Consoles'),
            h('div', { class: 'row' }, pass,
                h('button', {
                    class: 'primary', onclick: async () => {
                        if (!pass.value) return status('Type a password first.', true);
                        try { await api('PUT', `/api/rooms/${room.id}/screens`, { ff: pass.value }); pass.value = ''; status('Console password saved.'); }
                        catch (e) { status(e.message, true); }
                    }
                }, 'Set password'),
                enabled ? h('span', { class: 'pill ok' }, 'enabled') : h('span', { class: 'pill bad' }, 'disabled')),
            h('div', { class: 'row' }, h('strong', {}, 'Remote players:'), h('input', { type: 'text', readonly: true, value: base, style: 'flex:1;min-width:260px' }),
                h('button', { onclick: () => copy(base) }, 'Copy'), h('button', { onclick: () => window.open(base, '_blank') }, 'Open')),
            h('div', { class: 'stack' }, h('strong', {}, 'Physical consoles (tablets / touch PCs), one link per seat:'), seatLinks,
                h('span', { class: 'muted' }, 'Open the seat link on the device once: it stays on that seat, full screen and awake. Remote players take the first free seat and keep it if they reconnect.')));
    }

    // ------------------------------------------------------------------ seats
    function seatsCard() {
        const round = data.round;
        const inRound = n => round && ['ready', 'open', 'closed'].includes(round.phase) && round.players.some(p => p.n === n);
        const connected = data.seats.filter(s => s.connected && s.name);
        const selectFirst = count => send('fff:select', { seats: data.seats.map(s => s.connected && s.name && connected.indexOf(s) < count) });
        return h('div', { class: 'card stack', style: 'margin-top:14px' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
                h('h3', { style: 'margin:0' }, `Seats · ${data.seats.filter(s => s.selected && s.connected && s.name).length} will play`),
                h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Quick choice:'),
                    h('button', { onclick: () => send('fff:select', { seats: data.seats.map(s => s.connected && !!s.name) }) }, 'All connected'),
                    ...[3, 4, 5, 6, 8, 10].map(n => h('button', { onclick: () => selectFirst(n), disabled: connected.length < n }, `First ${n}`)),
                    h('button', { onclick: () => send('fff:select', { seats: data.seats.map(() => false) }) }, 'None'))),
            h('div', { class: 'fff-seats' }, ...data.seats.map(s => {
                const play = h('input', { type: 'checkbox', checked: s.selected, onchange: e => send('fff:seat', { seat: s.n, selected: e.target.checked }) });
                const answered = round?.players.find(p => p.n === s.n)?.answered;
                return h('div', { class: 'fff-seat' + (s.connected ? ' on' : '') + (inRound(s.n) ? ' playing' : '') },
                    h('div', { class: 'row', style: 'justify-content:space-between' },
                        h('b', {}, `Seat ${s.n}`),
                        h('span', { class: 'live-dot' + (s.connected ? ' on' : ''), title: s.connected ? 'connected' : 'not connected' })),
                    h('div', { class: 'fff-name', title: 'Click to set the name', onclick: () => rename(s) }, fullName(s.name) || h('span', { class: 'muted' }, s.connected ? '(no name yet)' : 'free')),
                    h('div', { class: 'muted' }, s.name?.location || '\u00a0'),
                    h('div', { class: 'muted' }, s.connected ? `${s.kiosk ? 'console' : 'remote'} · ${s.rtt} ms` : (s.taken ? 'reserved (offline)' : '\u00a0')),
                    h('div', { class: 'row', style: 'justify-content:space-between' },
                        h('label', {}, play, 'plays'),
                        answered ? h('span', { class: 'pill ok' }, 'answered') : '',
                        s.taken ? h('button', { onclick: () => { if (confirm(`Free seat ${s.n}? Its device is disconnected.`)) send('fff:seat', { seat: s.n, release: true }); } }, 'Free') : ''));
            })));
    }

    async function rename(s) {
        const first = prompt(`Seat ${s.n} - name or alias:`, s.name?.first ?? '');
        if (first == null) return;
        const last = prompt('Surname (optional):', s.name?.last ?? '');
        if (last == null) return;
        const location = prompt('From:', s.name?.location ?? '');
        if (location == null) return;
        await send('fff:seat', { seat: s.n, name: { first, last, location } });
    }

    // ------------------------------------------------------------------ round
    function roundCard() {
        const round = data.round;
        const game = window.MC.state?.();
        const step = game?.fff?.step ?? 0, active = !!game?.fff?.active;
        const unused = questions.filter(q => !q.used);
        const pick = h('select', {}, h('option', { value: '' }, `Random unused question (${unused.length} left)`),
            ...unused.map(q => h('option', { value: q.uid }, `${q.uid} · ${q.text.slice(0, 70)}`)));
        const limit = h('input', { type: 'number', min: 5, max: 60, value: data.limitSec, style: 'width:70px', onchange: e => send('fff:limit', { seconds: Number(e.target.value) }) });

        const card = h('div', { class: 'card stack', style: 'margin-top:14px' }, h('h3', { style: 'margin:0' }, 'Round'));
        const busy = round && ['ready', 'open'].includes(round.phase);

        if (!busy) {
            card.append(h('div', { class: 'row' }, pick, 'Time limit', limit, 's',
                h('button', { class: 'primary', onclick: () => send('fff:prepare', { uid: pick.value || null }) }, 'Prepare the round'),
                h('span', { class: 'muted' }, 'The players: seats ticked "plays", connected and with a name.')));
        }

        if (round) {
            const q = round.question;
            card.append(h('div', { class: 'fff-q' },
                h('div', {}, h('b', {}, `${q.uid}${round.tieBreak ? ' · TIE-BREAKER' : round.replay ? ' · new question' : ''}: `), q.text),
                h('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap' }, ...q.answers.map((a, i) => h('span', {}, h('b', {}, 'ABCD'[i] + ': '), a))),
                h('div', {}, h('b', {}, 'Correct order: '), q.order.split('').join(' '))));

            // The theme's sequence (key ←)
            if (busy || (round.phase === 'closed' && active)) {
                card.append(h('div', { class: 'row' },
                    h('button', { class: 'primary fff-next', onclick: () => window.MC.key(37) }, `\u2190  Next: ${active ? stepLabel(step, round.players.length) : '(waiting for the output)'}`),
                    round.phase === 'open' ? h('button', { onclick: () => send('fff:close', {}) }, 'Close the answers now') : '',
                    h('button', { class: 'danger', onclick: () => { if (confirm('Cancel this round? The graphics are cleared.')) send('fff:cancel', {}); } }, 'Cancel the round')));
            }
            if (round.phase === 'open') card.append(h('div', { id: 'fffCountdown', class: 'fff-countdown' }));

            card.append(h('table', { class: 'grid' },
                h('thead', {}, h('tr', {}, ...['Seat', 'Player', 'Order', 'Time', ''].map(t => h('th', {}, t)))),
                h('tbody', {}, ...(round.results ? round.results.rows : round.players.map(p => ({ seat: p.n, name: fullName(data.seats[p.n - 1].name), answered: p.answered }))).map(r =>
                    h('tr', { class: round.results?.winner === r.seat ? 'fff-winner' : round.results?.tie.includes(r.seat) ? 'warn-row' : '' },
                        h('td', {}, r.seat), h('td', {}, r.name),
                        h('td', {}, r.order ? r.order.split('').join(' ') : (round.results ? '-' : (r.answered ? 'locked' : '...'))),
                        h('td', {}, r.time != null ? `${r.time.toFixed(2)} s` : ''),
                        h('td', {}, round.results ? (r.correct ? h('span', { class: 'pill ok' }, 'correct') : h('span', { class: 'pill bad' }, r.order ? 'wrong' : 'no answer')) : ''))))));

            const res = round.results;
            if (res) {
                if (res.winner) {
                    const w = data.seats[res.winner - 1];
                    card.append(h('div', { class: 'row fff-banner ok' }, `Winner: seat ${res.winner} - ${fullName(w.name)}`,
                        round.applied ? h('span', { class: 'pill ok' }, 'is now the contestant')
                            : h('button', { onclick: () => send('fff:winner', { seat: res.winner }) }, 'Make them the contestant now'),
                        h('span', { class: 'muted' }, 'It happens automatically when the winner is shown on full screen.')));
                } else if (res.tie.length) {
                    card.append(h('div', { class: 'row fff-banner warn' }, `Tie between seats ${res.tie.join(', ')}: reveal the times, then`,
                        h('button', { class: 'primary', onclick: () => send('fff:prepare', { tieBreak: true, uid: pick.value || null }) }, 'Start the tie-breaker'),
                        h('span', { class: 'muted' }, 'only the tied players, with another question')));
                } else if (res.noneCorrect) {
                    card.append(h('div', { class: 'row fff-banner warn' }, 'Nobody answered correctly.',
                        h('button', { class: 'primary', onclick: () => send('fff:prepare', { replay: true, uid: pick.value || null }) }, 'New question for the same players')));
                }
                if (!busy) card.append(h('div', { class: 'row' }, h('button', { onclick: () => send('fff:cancel', {}) }, 'End the Fastest Finger (clear the graphics)')));
            }
        }
        if (data.history.length) {
            card.append(h('details', {}, h('summary', { class: 'muted' }, `Earlier rounds (${data.history.length})`),
                h('ul', {}, ...data.history.slice().reverse().map(x => h('li', {}, `${String(x.at).slice(11, 19)} · ${x.uid}${x.tieBreak ? ' (tie-breaker)' : ''} · ${x.players} players · ${x.winner ? 'winner ' + x.winner : x.tie ? 'tie' : 'no winner'}`)))));
        }
        return card;
    }

    function renderCountdown() {
        const el = document.getElementById('fffCountdown');
        const r = data?.round;
        if (!el || !r?.goAt) return;
        const left = Math.max(0, r.goAt + data.limitSec * 1000 - Date.now());
        el.textContent = `${(left / 1000).toFixed(1)} s left · ${r.players.filter(p => p.answered).length} of ${r.players.length} answered`;
    }

    // ------------------------------------------------------------------ questions
    function questionsCard() {
        const f = qFilter.toLowerCase();
        const list = questions.filter(q => !f || q.text.toLowerCase().includes(f) || q.uid.toLowerCase().includes(f) || q.answers.some(a => a.toLowerCase().includes(f)));
        const search = h('input', { type: 'text', placeholder: 'search', value: qFilter, size: 22 });
        search.addEventListener('input', () => { qFilter = search.value; const pos = search.selectionStart; render(); const s = body.querySelector('.fff-search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } });
        search.classList.add('fff-search');
        const file = h('input', { type: 'file', accept: '.csv,.tsv,.xlsx' });
        const importMsg = h('span', { class: 'muted' });
        return h('div', { class: 'card stack', style: 'margin-top:14px' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
                h('h3', { style: 'margin:0' }, `Fastest Finger questions · ${questions.filter(q => !q.used).length} unused of ${questions.length}`),
                h('div', { class: 'row' }, search, h('button', { class: 'primary', onclick: () => editQuestion(null) }, '+ New question'))),
            h('div', { class: 'row' }, file,
                h('button', {
                    onclick: async () => {
                        if (!file.files[0]) return (importMsg.textContent = 'Choose a file first.');
                        const form = new FormData(); form.append('file', file.files[0]);
                        const res = await fetch('/api/fff/import', { method: 'POST', body: form });
                        const d = await res.json();
                        importMsg.textContent = res.ok ? `${d.added} added, ${d.skipped} already there${d.invalid ? `, ${d.invalid} not valid` : ''}.` : d.error;
                        await loadQuestions(); render();
                    }
                }, 'Import CSV / Excel'), importMsg,
                h('span', { class: 'muted' }, 'Columns: Domanda, A, B, C, D, Ordine corretto (e.g. BDAC)')),
            h('div', { style: 'max-height:50vh;overflow:auto' }, h('table', { class: 'grid' },
                h('thead', {}, h('tr', {}, ...['ID', 'Question', 'Items', 'Order', 'Status', ''].map(t => h('th', {}, t)))),
                h('tbody', {}, ...list.map(q => h('tr', {},
                    h('td', {}, h('code', {}, q.uid)), h('td', {}, q.text),
                    h('td', { class: 'muted' }, q.answers.map((a, i) => `${'ABCD'[i]}: ${a}`).join(' · ')),
                    h('td', { style: 'white-space:nowrap' }, h('b', {}, q.order.split('').join(' '))),
                    h('td', {}, q.used ? h('span', { class: 'status-used', title: q.usedAt ? `on air ${String(q.usedAt).slice(0, 16)} (${q.usedRoom})` : '' }, 'used') : h('span', { class: 'muted' }, 'unused')),
                    h('td', { style: 'white-space:nowrap' },
                        h('button', { onclick: () => editQuestion(q) }, 'Edit'),
                        q.used ? h('button', { onclick: async () => { await api('PUT', `/api/fff/questions/${q.uid}`, { used: false }); await loadQuestions(); render(); } }, 'Unused again') : '',
                        h('button', { class: 'danger', onclick: async () => { if (confirm(`Delete ${q.uid}?`)) { await api('DELETE', `/api/fff/questions/${q.uid}`); await loadQuestions(); render(); } } }, 'Delete'))))))));
    }

    function editQuestion(q) {
        const text = h('textarea', { rows: 2, style: 'width:100%' }); text.value = q?.text ?? '';
        const answers = [0, 1, 2, 3].map(i => h('input', { type: 'text', value: q?.answers[i] ?? '', style: 'width:100%' }));
        const order = h('input', { type: 'text', value: q?.order ?? '', maxlength: 7, placeholder: 'e.g. BDAC', style: 'width:120px;text-transform:uppercase' });
        const msg = h('span', { class: 'muted' });
        const bg = h('div', { class: 'modal-bg' });
        bg.append(h('div', { class: 'modal', style: 'width:min(700px,94vw)' },
            h('h2', { style: 'margin:0 0 10px' }, q ? `Edit ${q.uid}` : 'New Fastest Finger question'),
            h('div', { class: 'form-grid', style: 'grid-template-columns:120px 1fr' },
                h('span', {}, 'Question'), text, ...answers.flatMap((a, i) => [h('span', {}, 'ABCD'[i]), a]),
                h('span', {}, 'Correct order'), h('span', { class: 'row' }, order, h('span', { class: 'muted' }, 'the four letters in the right order'))),
            h('div', { class: 'row', style: 'margin-top:12px' },
                h('button', {
                    class: 'primary', onclick: async () => {
                        const payload = { text: text.value, answers: answers.map(a => a.value), order: order.value };
                        try { q ? await api('PUT', `/api/fff/questions/${q.uid}`, payload) : await api('POST', '/api/fff/questions', payload); bg.remove(); await loadQuestions(); render(); }
                        catch (e) { msg.textContent = e.message; }
                    }
                }, 'Save'),
                h('button', { onclick: () => bg.remove() }, 'Cancel'), msg)));
        document.body.append(bg);
    }

    window.MCFff = { open };
})();
