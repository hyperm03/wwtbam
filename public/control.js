/* Millionaire Control - web control panel */
(() => {
    'use strict';

    // ------------------------------------------------------------------ helpers
    const $ = s => document.querySelector(s);
    const $$ = s => [...document.querySelectorAll(s)];
    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
        return el;
    }
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const oneLine = s => String(s || '').replace(/\s*\n\s*/g, ' ');
    const enc = p => p.split('/').map(encodeURIComponent).join('/');
    const status = (msg, warn) => { const m = $('#statusMsg'); m.textContent = msg; m.style.color = warn ? 'var(--red)' : ''; };
    async function api(method, url, body) {
        const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 401) { location.href = '/login?next=/control'; throw new Error('Not logged in'); }
        const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
        if (!res.ok) throw new Error(data?.error || res.statusText);
        return data;
    }

    // ------------------------------------------------------------------ constants
    const LIFELINES = [
        { id: 'ff', title: '50:50', key: 70, letter: 'F', steps: ['Remove two wrong answers'] },
        { id: 'paf', title: 'Phone a Friend', key: 80, letter: 'P', steps: ['Start (music)', 'The call: hide the question', 'Show the question, start the 30s clock', 'End the call early'] },
        { id: 'ata', title: 'Ask the Audience', key: 65, letter: 'A', steps: ['Start (music)', 'Show the graph', 'Start voting', 'Reveal the results', 'Close the graph'] },
        { id: 'stq', title: 'Switch the Question', key: 83, letter: 'S', steps: ['Show the lifeline icon', 'Reveal the current correct answer', 'Switch animation', 'Show the new question', 'Reveal answer A', 'Reveal answer B', 'Reveal answer C', 'Reveal answer D'] },
        { id: 'dd', title: 'Double Dip', key: 68, letter: 'D', steps: ['Activate Double Dip', 'Lock the first answer (buttons on the right)', 'Reveal the first answer', 'Lock the second answer (buttons on the right)', 'Reveal the second answer'] },
        { id: 'ate', title: 'Ask the Expert', key: 84, letter: 'T', steps: ['Start (the clock is paused)', 'Hide the clock, the expert on screen', 'The expert (music)', 'The expert is talking', 'End: back to the question'] }
    ];
    // Clocked 2009: Phone a Friend has a contact list and its own clock handling
    const PAF_CLOCKED_STEPS = ['Start (the clock is paused)', 'The call screen', 'Show the three friends', 'Choose the friend (Call buttons below)', 'Question back on screen, 30s call clock', 'End the call early', 'Question clock back on screen', 'Restart the question clock'];
    const KEYMAP = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, 0: 48, 1: 49, 2: 50, 3: 51, 4: 52, a: 65, b: 66, c: 67, d: 68, e: 69, f: 70, g: 71, k: 75, l: 76, m: 77, n: 78, p: 80, q: 81, s: 83, t: 84, u: 85, w: 87 };
    const SHOW_KEYS = [
        ['N  Name strap', 78, 'Show/hide the contestant name'], ['M  Prize at stake', 77, 'Show/hide the amount being played for'],
        ['L  Lifelines strap', 76, 'Show/hide the lifelines strap'], ['C  Commercial', 67, 'Commercial break (logo)'],
        ['U  Undo answer', 85, 'Undo the locked final answer'], ['W  Walk away', 87, 'The contestant walks away (each click advances)'],
        ['E  Rules music', 69, 'Rules explanation music'], ['Q  Resume music', 81, 'Resume music'], ['G  Game over', 71, 'Closing sequence'],
        ['K  Klaxon', 75, 'Klaxon: end of the show (stops the music)']
    ];

    // ------------------------------------------------------------------ state
    let me = { user: '', role: 'operator', database: false };
    let rooms = [], themes = [], room = null, state = null, tally = null, assets = null, assetsTheme = null, publicUrl = location.origin, outputPublicUrl = location.origin;
    let currentLL = 'ff', editLevel = 1, editSwitch = false;
    const liveLevel = () => clamp(state?.level || 1, 1, 15);
    const liveQuestion = () => room?.questions.main[liveLevel() - 1];
    const liveCorrect = () => state?.inProgress && state.correct?.length === 1 ? state.correct : 'abcd'[liveQuestion()?.correct ?? 0];
    const isUsed = i => !!state?.used?.[i];
    const isOut = i => !!(state?.inProgress && state?.out?.[i]);

    const socket = io({ query: { role: 'control' } });
    let desiredRoom = null;
    const emit = socket.emit.bind(socket);
    socket.emit = (event, ...args) => {
        if (!socket.connected) {
            status('Disconnected: no action was sent. Reconnect before continuing.', true);
            const ack = args[args.length - 1];
            if (typeof ack === 'function') ack({ ok: false, error: 'Disconnected' });
            return socket;
        }
        return emit(event, ...args);
    };
    let commandPending = false;
    const cmd = msg => {
        if (!socket.connected) return status('Disconnected: command rejected.', true);
        if (commandPending) return status('Waiting for the game to confirm the previous command.', true);
        commandPending = true;
        const id = crypto.randomUUID();
        status('Sending command…');
        socket.timeout(5000).emit('cmd', { ...msg, id, sentAt: Date.now() }, (error, result) => {
            commandPending = false;
            status(error ? 'No confirmation: check the output before retrying.' : result?.ok ? (result.saved ? 'Saved.' : 'Executed by the game.') : result?.error || 'Command refused', !!error || !result?.ok);
        });
    };
    const key = code => {
        if (!room) return;
        if ([71, 75, 87].includes(code) && room.mode === 'live' && !confirm('Send this closing command to the live game?')) return;
        cmd({ cmd: 'key', code });
    };

    // ------------------------------------------------------------------ rooms and themes (header)
    async function loadRooms(selectId) {
        rooms = await api('GET', '/api/rooms');
        const sel = $('#roomSelect');
        sel.replaceChildren(...rooms.map(r => h('option', { value: r.id, text: r.name })));
        const wanted = selectId || localStorage.getItem('mc_room');
        const target = rooms.find(r => r.id === wanted) || rooms[0];
        if (target) { sel.value = target.id; joinRoom(target.id); }
        else status('Create your first show with "+ New show".');
    }

    async function loadThemes() {
        themes = await api('GET', '/api/themes');
        const sel = $('#themeSelect');
        sel.replaceChildren(h('option', { value: '', text: '(choose a theme)' }), ...themes.map(t => h('option', { value: t.name, text: t.name + (t.format === 'clocked' ? '  (Clocked 2009)' : '') })));
        sel.value = room?.theme || '';
        renderThemes();
    }

    function joinRoom(id) {
        desiredRoom = id;
        localStorage.setItem('mc_room', id);
        state = null; tally = null;
        if (socket.connected) socket.emit('join', id);
    }

    $('#roomSelect').addEventListener('change', e => joinRoom(e.target.value));
    $('#newRoom').addEventListener('click', async () => {
        const name = prompt('Name of the new show:');
        if (!name) return;
        const { id } = await api('POST', '/api/rooms', { name });
        await loadRooms(id);
    });
    $('#themeSelect').addEventListener('change', async e => {
        if (!room || !e.target.value) return;
        if (state?.inProgress && !confirm('A question is in progress. Change theme and reload the output?')) { e.target.value = room.theme; return; }
        await api('PUT', `/api/rooms/${room.id}`, { theme: e.target.value });
        status(`Theme changed to ${e.target.value}: the output reloads with a clean cache.`);
    });
    $('#reloadOutput').addEventListener('click', () => { if (confirm('Reload the output? Recovery will require your confirmation.')) socket.emit('reload'); });
    $('#linksButton').addEventListener('click', showLinks);

    /** Link and password of the host or player screen, in the links window. */
    function screenBlock(kind) {
        const link = `${publicUrl}/${kind}/${encodeURIComponent(room.id)}`;
        const title = kind === 'host' ? 'Host screen' : 'Player screen';
        const enabled = !!room.screens?.[kind];
        const pass = h('input', { type: 'password', placeholder: enabled ? 'new password' : 'set a password to enable it', size: 22, autocomplete: 'new-password' });
        const info = h('span', { class: 'muted' }, enabled ? `enabled · ${room.screenViewers?.[kind] ?? 0} screen(s) connected` : 'disabled');
        const save = async value => {
            try {
                await api('PUT', `/api/rooms/${room.id}/screens`, { [kind]: value });
                info.textContent = value ? 'password saved: screens already open must sign in again' : 'disabled';
                pass.value = '';
            } catch (e) { info.textContent = e.message; }
        };
        return h('div', { class: 'stack', style: 'border-top:1px solid var(--line);padding-top:10px' },
            h('strong', {}, title + (kind === 'host' ? ' (question, correct answer, host comment, winnings boxes)' : ' (what the contestant sees)')),
            h('div', { class: 'row' },
                h('input', { type: 'text', readonly: true, value: link, style: 'flex:1' }),
                h('button', { onclick: () => navigator.clipboard?.writeText(link).then(() => status('Copied to the clipboard.')) }, 'Copy'),
                h('button', { onclick: () => window.open(link, '_blank') }, 'Open')),
            h('div', { class: 'row' }, pass,
                h('button', { class: 'primary', onclick: () => pass.value ? save(pass.value) : info.textContent = 'Type a password first' }, 'Set password'),
                enabled ? h('button', { class: 'danger', onclick: () => { if (confirm(`Disable the ${title.toLowerCase()}?`)) save(''); } }, 'Disable') : '',
                info));
    }

    function showLinks() {
        if (!room) return;
        // Output links always carry &bg=black (black background); change or remove it in OBS for a transparent output
        const outputLink = `${outputPublicUrl}/output/${encodeURIComponent(room.id)}?t=${encodeURIComponent(room.outputToken)}&bg=black`;
        const voteLink = `${publicUrl}/v/${encodeURIComponent(room.id)}`;
        const copy = text => navigator.clipboard?.writeText(text).then(() => status('Copied to the clipboard.'));
        const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) bg.remove(); } },
            h('div', { class: 'modal' },
                h('h2', { style: 'margin:0' }, room.name),
                h('strong', {}, 'Output (OBS browser source, 1920x1080)'),
                h('input', { type: 'text', readonly: true, value: outputLink }),
                h('div', { class: 'row' },
                    h('button', { onclick: () => copy(outputLink) }, 'Copy'),
                    h('button', { onclick: () => window.open(outputLink, '_blank') }, 'Open'),
                    h('button', { class: 'danger', onclick: async () => { if (confirm('Create a new output link? The current one stops working.')) { await api('POST', `/api/rooms/${room.id}/rotate-token`); bg.remove(); } } }, 'New secret link')),
                h('p', { class: 'muted', style: 'margin:0' }, 'Keep this link private: whoever has it can show the game output. The link carries &bg=black (black background); remove it, or change it to &bg=transparent, for a transparent output (no black page; the graphics of the theme stay).'),
                h('strong', {}, 'Audience keypad (phones)'),
                h('div', { class: 'row' },
                    h('img', { class: 'qr', src: `/api/rooms/${encodeURIComponent(room.id)}/vote-qr.svg`, alt: 'QR code' }),
                    h('div', { class: 'stack', style: 'flex:1' },
                        h('input', { type: 'text', readonly: true, value: voteLink }),
                        h('div', { class: 'row' },
                            h('button', { onclick: () => copy(voteLink) }, 'Copy'),
                            h('button', { onclick: () => window.open(voteLink, '_blank') }, 'Open'),
                            h('button', { onclick: () => window.open(`/api/rooms/${encodeURIComponent(room.id)}/vote-qr.svg`, '_blank') }, 'QR full size')))),
                ...['host', 'player'].map(kind => screenBlock(kind)),
                h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
                    h('button', { class: 'danger', onclick: async () => { if (confirm(`Delete the show "${room.name}"?`)) { await api('DELETE', `/api/rooms/${room.id}`); bg.remove(); localStorage.removeItem('mc_room'); room = null; await loadRooms(); } } }, 'Delete this show'),
                    h('button', { class: 'primary', onclick: () => bg.remove() }, 'Close'))));
        document.body.append(bg);
    }

    // ------------------------------------------------------------------ socket
    socket.on('connect', () => { socket.sendBuffer = []; status('Connected.'); if (desiredRoom || room) socket.emit('join', desiredRoom || room.id); });
    socket.on('disconnect', () => { commandPending = false; socket.sendBuffer = []; state = null; status('Connection lost. Commands are disabled until reconnection.', true); renderAll(); });
    socket.on('authError', () => { location.href = '/login?next=/control'; });
    socket.on('bridgeError', msg => status('Game: ' + msg, true));
    socket.on('room', async r => {
        if (!r) { room = null; return; }
        const themeChanged = r.theme !== room?.theme;
        room = r;
        $('#roomSelect').value = r.id;
        $('#themeSelect').value = r.theme || '';
        for (const [f, id] of [['first', '#cFirst'], ['last', '#cLast'], ['location', '#cLocation']])
            if (document.activeElement !== $(id)) $(id).value = r.contestant[f] || '';
        if (themeChanged) await loadAssets();
        renderAll();
        if (!isEditorFocused()) loadEditor();
        renderQuestionList();
        renderThemes();
    });
    socket.on('state', s => { state = s; renderAll(); renderQuestionList(); });
    socket.on('tally', t => { tally = t; lifelineCtx.ata?.renderTally(); renderLeds(); });

    /**
     * Font of the money tree: Copperplate Gothic Bold, from the theme's own Fonts folder when it has it
     * (e.g. CopperplateBold in Clocked), otherwise the copy installed on this computer.
     */
    function setTreeFont(theme) {
        let style = document.getElementById('treeFontFace');
        if (!style) { style = document.createElement('style'); style.id = 'treeFontFace'; document.head.append(style); }
        const base = theme ? `/preview/${encodeURIComponent(theme)}/Fonts/` : null;
        const files = base ? ['CopperplateBold.woff', 'CopperplateBold.ttf', 'CopperplateGothicBold.woff', 'CopperplateGothicBold.ttf']
            .map(f => `url("${base}${f}") format("${f.endsWith('.woff') ? 'woff' : 'truetype'}")`) : [];
        style.textContent = `@font-face { font-family: "MCTreeFont"; font-weight: normal; font-display: swap;
            src: ${[...files, 'local("Copperplate Gothic Bold")', 'local("CopperplateGothic-Bold")', 'local("Copperplate-Bold")'].join(', ')}; }`;
    }

    async function loadAssets() {
        assets = null; assetsTheme = room?.theme || null;
        setTreeFont(assetsTheme);
        if (!assetsTheme) return;
        try { assets = await api('GET', `/api/themes/${encodeURIComponent(assetsTheme)}/assets`); } catch { assets = null; }
        for (const ctx of Object.values(lifelineCtx)) ctx.iconKey = '';
    }
    const themeUrl = (theme, p) => `/preview/${encodeURIComponent(theme)}/${enc(p)}`;

    /** A lifeline drawn with the theme's own layers (only those visible at rest), crossed out when used. */
    function lifelineIcon(id, used, width, theme = assetsTheme, a = assets) {
        const el = h('span', { class: 'll-icon', style: `width:${width}px;height:${Math.round(width * 0.81)}px` });
        const def = a?.lifelines?.[id];
        if (!def || !def.layers.length) { el.classList.add('fallback'); el.title = id; return el; }
        for (const layer of def.layers) el.append(h('img', { src: themeUrl(theme, layer), alt: '' }));
        if (used && def.used) el.append(h('img', { src: themeUrl(theme, def.used), alt: '' }));
        return el;
    }

    // ------------------------------------------------------------------ show tab: static parts
    $$('.big-buttons [data-key]').forEach(b => b.addEventListener('click', () => key(Number(b.dataset.key))));
    $('#showKeys').append(...SHOW_KEYS.map(([text, code, tip]) =>
        h('button', { title: tip, class: code === 75 ? 'klaxon' : null, onclick: () => key(code) }, text)));
    $('#answers').append(...[0, 1, 2, 3].map(i =>
        h('button', { title: `Lock ${'ABCD'[i]} as the final answer (key ${i + 1})`, onclick: () => key(49 + i) }, h('b', {}, 'ABCD'[i] + ':'), h('span'))));
    $('#sendContestant').addEventListener('click', () => {
        socket.emit('contestant', { first: $('#cFirst').value, last: $('#cLast').value, location: $('#cLocation').value });
        status('Contestant sent.');
    });
    $('#highlightCorrect').addEventListener('change', renderAll);
    $('#treeClick').checked = localStorage.getItem('mc_treeClick') !== '0';
    $('#treeClick').addEventListener('change', e => { localStorage.setItem('mc_treeClick', e.target.checked ? '1' : '0'); renderTree(); });
    $('#editLive').addEventListener('click', () => openEditor(liveLevel(), false));
    $('#hostCommentToggle').addEventListener('click', () => { if (room) socket.emit('hostComment', !room.hostComment); });
    $$('#clockCard [data-key]').forEach(b => b.addEventListener('click', () => key(Number(b.dataset.key))));
    $('#cancelFinal').addEventListener('click', () => {
        if (!state?.target) return;
        key(85);   // the game's own undo: unlocks the answer, restarts the question music, question back in play
        status(`Final answer ${state.target.toUpperCase()} cancelled: the question is back in play.`);
    });
    const sendHostMessage = () => {
        const text = $('#hostMsgText').value.trim();
        if (!text || !room) return;
        socket.emit('hostMessage', text);
        $('#hostMsgText').value = '';
    };
    $('#hostMsgSend').addEventListener('click', sendHostMessage);
    $('#hostMsgText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendHostMessage(); } });
    $('#hostMsgClear').addEventListener('click', () => { if (room) socket.emit('hostMessage', ''); });

    document.addEventListener('keydown', e => {
        if (e.repeat) return;
        if (!$('#keyboardKeys').checked || e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target;
        if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
            (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(t.type))) return;
        if (!$('#page-show').classList.contains('active')) return;
        const code = KEYMAP[e.key.length === 1 ? e.key.toLowerCase() : e.key];
        if (!code) return;
        e.preventDefault();
        key(code);
    });

    // ------------------------------------------------------------------ lifelines
    const lifelineCtx = {};

    function buildLifelines() {
        for (const ll of LIFELINES) {
            const ctx = { ll, iconKey: '' };
            ctx.tab = h('button', { class: 'll-tab', onclick: () => { currentLL = ll.id; renderLifelines(); } });
            ctx.iconBox = h('span');
            ctx.stateEl = h('div', { class: 'state' });
            ctx.markBtn = h('button', { onclick: () => cmd({ cmd: 'lifelineUsed', id: ll.id, used: !isUsed(LIFELINES.indexOf(ll)) }) });
            ctx.hint = h('div', { class: 'hint' });
            ctx.stepItems = ll.steps.map(s => h('li', {}, s));
            ctx.body = h('div');
            const ping = h('button', { title: 'Makes the lifeline pulse on the money tree (the tree must be on screen)', onclick: () => state?.treeShowing ? key(ll.key) : hint(ctx, 'Show the money tree first (◀ Rules / Money tree), then ping the lifeline.') }, 'Ping');
            const next = h('button', { class: 'next-step primary', onclick: () => (ctx.onNext ? ctx.onNext() : defaultNext(ctx)) }, `Next step ▶   (key ${ll.letter})`);
            ctx.panel = h('div', { class: 'll-body hidden' },
                h('div', { class: 'll-state' }, ctx.iconBox, ctx.stateEl, ctx.markBtn, ping),
                h('div', {}, h('ol', { class: 'steps' }, ctx.stepItems), next, ctx.hint),
                ctx.body);
            BUILDERS[ll.id](ctx);
            lifelineCtx[ll.id] = ctx;
            $('#llTabs').append(ctx.tab);
            $('#llPanels').append(ctx.panel);
        }
    }

    function hint(ctx, text) { ctx.hint.textContent = text; if (text) status(text); }
    function defaultNext(ctx) {
        if (!state) return hint(ctx, 'The game is not connected yet.');
        if (state.treeShowing) return hint(ctx, 'The money tree is on screen: hide it first, or use "Ping".');
        if (!state.inProgress) return hint(ctx, 'There is no question in progress.');
        key(ctx.ll.key);
        hint(ctx, '');
    }

    const NEXT_STEP = {
        ff: (s, used) => s.inProgress && !used ? 0 : -1,
        paf: s => s.clocked ? (s.inProgress && s.pafStep >= 0 && s.pafStep <= 7 ? s.pafStep : -1) : (s.inProgress && s.pafStep < 4 ? s.pafStep : -1),
        ata: s => s.inProgress ? clamp(s.ataStep || 0, 0, 4) : -1,
        stq: s => s.inProgress ? clamp(s.stqStep || 0, 0, 7) : -1,
        ate: (s, used) => s.inProgress && (!used || (s.ateStep || 0) > 0) ? clamp(s.ateStep || 0, 0, 4) : -1,
        dd: (s, used) => {
            if (!s.inProgress) return -1;
            if (!s.ddActive) return used ? -1 : 0;
            const locked = !!s.target;
            return (s.ddStep || 0) <= 1 ? (locked ? 2 : 1) : (locked ? 4 : 3);
        }
    };

    const BUILDERS = {
        ate() { /* steps only: the game handles the expert */ },
        ff(ctx) {
            ctx.correctLabel = h('strong');
            ctx.random = h('input', { type: 'radio', name: 'ffMode', checked: true, onchange: () => ctx.update() });
            ctx.choose = h('input', { type: 'radio', name: 'ffMode', onchange: () => ctx.update() });
            ctx.boxes = [0, 1, 2, 3].map(() => h('input', {
                type: 'checkbox', onchange: e => { if (ctx.boxes.filter(b => b.checked).length > 2) e.target.checked = false; }
            }));
            ctx.labels = [0, 1, 2, 3].map(() => h('span'));
            ctx.body.append(h('div', { class: 'stack' }, ctx.correctLabel,
                h('label', {}, ctx.random, 'Random, like the game'),
                h('label', {}, ctx.choose, 'Choose the two wrong answers to remove:'),
                ...ctx.boxes.map((b, i) => h('label', { style: 'margin-left:22px' }, b, ctx.labels[i]))));
            ctx.onNext = () => {
                let pick = null;
                if (ctx.choose.checked) {
                    pick = ctx.boxes.map((b, i) => b.checked ? 'abcd'[i] : null).filter(Boolean);
                    if (pick.length !== 2) return hint(ctx, 'Tick exactly two wrong answers.');
                }
                cmd({ cmd: 'fiftyPick', pick });
                defaultNext(ctx);
            };
            ctx.update = () => {
                const q = liveQuestion(); if (!q) return;
                const c = clamp('abcd'.indexOf(liveCorrect()), 0, 3);
                ctx.correctLabel.textContent = `Correct answer: ${'ABCD'[c]}  -  ${q.answers[c]}`;
                ctx.boxes.forEach((b, i) => {
                    b.disabled = !ctx.choose.checked || i === c;
                    if (i === c) b.checked = false;
                    ctx.labels[i].textContent = `${'ABCD'[i]}:  ${q.answers[i]}${i === c ? '   (correct, always kept)' : ''}`;
                });
            };
        },
        paf(ctx) {
            ctx.clock = h('div', { class: 'clock' }, '30');
            ctx.body.append(h('div', { class: 'stack' }, h('strong', {}, 'Call clock (mirror of the one on screen)'), ctx.clock));
            // Clocked 2009: the three friends and the choice of who to call
            ctx.contactInputs = [0, 1, 2].map(() => ({ first: h('input', { type: 'text', placeholder: 'first name', size: 10 }), last: h('input', { type: 'text', placeholder: 'last name', size: 10 }), location: h('input', { type: 'text', placeholder: 'from', size: 10 }) }));
            ctx.callButtons = [0, 1, 2].map(i => h('button', { class: 'primary', disabled: true, onclick: () => key(49 + i) }, `Call ${i + 1}`));
            ctx.contactsBox = h('div', { class: 'stack hidden' },
                h('strong', {}, 'Friends on the list (Clocked)'),
                ...ctx.contactInputs.map((c, i) => h('div', { class: 'row' }, `${i + 1}.`, c.first, c.last, c.location, ctx.callButtons[i])),
                h('div', { class: 'row' }, h('button', {
                    onclick: () => socket.emit('pafContacts', ctx.contactInputs.map(c => ({ first: c.first.value, last: c.last.value, location: c.location.value })))
                }, 'Save the friends'), h('span', { class: 'muted' }, 'The "Call" buttons light up when the game asks which friend to call.')));
            ctx.body.append(ctx.contactsBox);
            ctx.contactsKey = '';
            ctx.prev = 0;
            ctx.update = () => {
                const clocked = !!state?.clocked;
                ctx.contactsBox.classList.toggle('hidden', !clocked);
                ctx.stepItems.forEach((li, k) => { li.textContent = clocked ? (PAF_CLOCKED_STEPS[k] ?? '') : (ctx.ll.steps[k] ?? ''); li.classList.toggle('hidden', !li.textContent); });
                if (clocked && ctx.stepItems.length < PAF_CLOCKED_STEPS.length) {
                    for (let k = ctx.stepItems.length; k < PAF_CLOCKED_STEPS.length; k++) { const li = h('li', {}, PAF_CLOCKED_STEPS[k]); ctx.stepItems.push(li); ctx.stepItems[0].parentNode.append(li); }
                }
                ctx.callButtons.forEach(b => { b.disabled = !state?.pafSelect; });
                const saved = room?.pafContacts || state?.pafContacts;
                const k = JSON.stringify(saved);
                if (saved && k !== ctx.contactsKey && !ctx.contactInputs.some(c => [c.first, c.last, c.location].includes(document.activeElement))) {
                    ctx.contactsKey = k;
                    saved.forEach((c, i) => { ctx.contactInputs[i].first.value = c.first; ctx.contactInputs[i].last.value = c.last; ctx.contactInputs[i].location.value = c.location; });
                }
                // The game's own call clock when it is on screen
                if (state?.pafClock) { ctx.clock.textContent = state.pafClock; ctx.clock.classList.toggle('low', Number(state.pafClock) <= 5); ctx.prev = state.pafStep; return; }
                if (clocked) { if (!state?.inProgress || state.pafStep === 0) { ctx.clock.textContent = '30'; ctx.clock.classList.remove('low'); } return; }
                const step = state?.pafStep || 0;
                if (step === 3 && ctx.prev !== 3) {
                    ctx.started = Date.now();
                    clearInterval(ctx.timer);
                    ctx.timer = setInterval(tick, 200);
                } else if (step !== 3 && ctx.timer) {
                    clearInterval(ctx.timer); ctx.timer = null;
                }
                if (step === 0 && !ctx.timer) { ctx.clock.textContent = '30'; ctx.clock.classList.remove('low'); }
                ctx.prev = step;
            };
            function tick() {
                const left = Math.max(0, 30 - Math.floor((Date.now() - ctx.started) / 1000));
                ctx.clock.textContent = left;
                ctx.clock.classList.toggle('low', left <= 5);
                if (!left) { clearInterval(ctx.timer); ctx.timer = null; }
            }
        },
        ata(ctx) {
            const radio = (value, text) => h('label', {}, h('input', { type: 'radio', name: 'ataSource', value, onchange: () => socket.emit('ata', { source: value }) }), text);
            ctx.sources = [radio('game', "The game's random percentages"), radio('manual', 'Manual'), radio('votes', 'Live audience votes')];
            ctx.ranges = [0, 1, 2, 3].map(i => h('input', { type: 'range', min: 0, max: 100, oninput: e => setManual(i, e.target.value) }));
            ctx.nums = [0, 1, 2, 3].map(i => h('input', { type: 'number', min: 0, max: 100, style: 'width:60px', oninput: e => setManual(i, e.target.value) }));
            ctx.answerLabels = [0, 1, 2, 3].map(() => h('span', { class: 'answer' }));
            ctx.sum = h('strong');
            ctx.tallyBars = [0, 1, 2, 3].map(() => h('div'));
            ctx.tallyText = [0, 1, 2, 3].map(() => h('span'));
            ctx.tallyInfo = h('span', { class: 'muted' });
            ctx.auto = h('input', { type: 'checkbox', onchange: e => socket.emit('ata', { autoVoting: e.target.checked }) });
            ctx.voteState = h('strong');

            const manual = h('div', { class: 'ata-grid' }, ...[0, 1, 2, 3].flatMap(i => [h('span', { class: 'letter' }, 'ABCD'[i]), ctx.answerLabels[i], ctx.ranges[i], ctx.nums[i]]));
            const live = h('div', { class: 'tally' }, ...[0, 1, 2, 3].flatMap(i => [h('span', { class: 'letter' }, 'ABCD'[i]), h('div', { class: 'bar' }, ctx.tallyBars[i]), ctx.tallyText[i]]));
            ctx.body.append(h('div', { class: 'stack' },
                h('div', { class: 'row' }, ...ctx.sources),
                manual,
                h('div', { class: 'row' }, ctx.sum,
                    h('button', { onclick: () => realistic() }, 'Realistic'),
                    h('button', { onclick: () => normalize() }, 'Make 100%'),
                    h('button', { onclick: () => sendManual([25, 25, 25, 25]) }, 'Even split')),
                h('div', { class: 'row' }, h('strong', {}, 'Audience keypad:'), ctx.voteState, ctx.tallyInfo),
                live,
                h('div', { class: 'row' },
                    h('label', {}, ctx.auto, 'Open voting automatically with "Start voting"'),
                    h('button', { onclick: () => socket.emit('voting', { open: true }) }, 'Open'),
                    h('button', { onclick: () => socket.emit('voting', { open: false }) }, 'Close'),
                    h('button', { onclick: () => socket.emit('voting', { reset: true }) }, 'Reset votes'),
                    h('button', { onclick: showLinks }, 'QR code'))));

            let manualTimer = null;
            function setManual(i, v) {
                const values = [...(room.ata.manual || [25, 25, 25, 25])];
                values[i] = clamp(Math.round(Number(v) || 0), 0, 100);
                sendManual(values);
            }
            function sendManual(values) {
                room.ata.manual = values;
                ctx.update();
                clearTimeout(manualTimer);
                manualTimer = setTimeout(() => socket.emit('ata', { manual: values }), 250);
            }
            function outs() { return [0, 1, 2, 3].map(isOut); }
            function realistic() {
                const correct = clamp('abcd'.indexOf(liveCorrect()), 0, 3);
                const o = outs();
                const others = [0, 1, 2, 3].filter(i => i !== correct && !o[i]);
                const values = [0, 0, 0, 0];
                const base = clamp(85 - (liveLevel() - 1) * 3.5, 30, 90);
                values[correct] = others.length ? Math.round(clamp(base + Math.floor(Math.random() * 21) - 12, 20, 95)) : 100;
                const rest = 100 - values[correct];
                const w = others.map(() => Math.random() + 0.15);
                const total = w.reduce((a, b) => a + b, 0);
                let assigned = 0;
                others.forEach((i, k) => { values[i] = Math.floor(rest * w[k] / total); assigned += values[i]; });
                values[correct] += rest - assigned;
                sendManual(values);
            }
            function normalize() {
                const o = outs();
                const v = [...room.ata.manual];
                const active = [0, 1, 2, 3].filter(i => !o[i]);
                [0, 1, 2, 3].filter(i => o[i]).forEach(i => { v[i] = 0; });
                const sum = active.reduce((s, i) => s + v[i], 0);
                active.forEach(i => { v[i] = sum ? Math.floor(v[i] * 100 / sum) : Math.floor(100 / active.length); });
                const largest = active.reduce((a, b) => v[b] > v[a] ? b : a, active[0]);
                v[largest] += 100 - active.reduce((s, i) => s + v[i], 0);
                sendManual(v);
            }

            ctx.update = () => {
                if (!room) return;
                const q = liveQuestion();
                ctx.sources.forEach(l => { const r = l.querySelector('input'); r.checked = r.value === room.ata.source; });
                const values = room.ata.manual || [25, 25, 25, 25];
                [0, 1, 2, 3].forEach(i => {
                    const out = isOut(i);
                    ctx.answerLabels[i].textContent = out ? '(removed)' : q?.answers[i] || '';
                    if (document.activeElement !== ctx.nums[i]) ctx.nums[i].value = values[i];
                    ctx.ranges[i].value = values[i];
                    ctx.ranges[i].disabled = ctx.nums[i].disabled = out;
                });
                const sum = values.reduce((a, b) => a + b, 0);
                ctx.sum.textContent = `Total: ${sum}%`;
                ctx.sum.style.color = sum === 100 ? '#15803d' : 'var(--red)';
                ctx.auto.checked = !!room.ata.autoVoting;
                ctx.renderTally();
            };
            ctx.renderTally = () => {
                const t = tally || { counts: [0, 0, 0, 0], total: 0, open: false, voters: 0 };
                const perc = t.percentages || [0, 0, 0, 0];
                [0, 1, 2, 3].forEach(i => {
                    ctx.tallyBars[i].style.width = perc[i] + '%';
                    ctx.tallyText[i].textContent = `${perc[i]}%  (${t.counts[i]})`;
                });
                ctx.voteState.textContent = t.open ? 'VOTING OPEN' : 'closed';
                ctx.voteState.style.color = t.open ? '#15803d' : 'var(--muted)';
                ctx.tallyInfo.textContent = `${t.total} vote(s), ${t.voters} phone(s) connected` +
                    (room?.ata.source === 'votes' && !t.total ? ' - with no votes the game uses random percentages' : '');
            };
        },
        stq(ctx) {
            ctx.current = h('div', { class: 'q-preview' });
            ctx.replacement = h('div', { class: 'q-preview' });
            ctx.body.append(h('div', { class: 'stack' },
                h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
                    h('div', {}, h('strong', {}, 'Current question'), ctx.current),
                    h('div', {}, h('strong', {}, 'Replacement question'), ctx.replacement)),
                h('div', { class: 'row' },
                    h('button', { onclick: () => openEditor(liveLevel(), true) }, 'Edit replacement...'),
                    h('button', { onclick: () => { cmd({ cmd: 'setQuestion', level: liveLevel(), isSwitch: true, question: room.questions.sw[liveLevel() - 1] }); hint(ctx, `Replacement for level ${liveLevel()} sent.`); } }, 'Send replacement to the game'))));
            const describe = (q, level, correct) => q ? [`Q${level}: ${oneLine(q.text) || '(empty)'}`,
                ...q.answers.map((a, i) => `${'ABCD'[i]}:  ${a}${'abcd'[i] === correct ? '     \u2713' : ''}`)].join('\n') : '';
            ctx.update = () => {
                if (!room) return;
                const l = liveLevel();
                ctx.current.textContent = describe(room.questions.main[l - 1], l, liveCorrect());
                const r = room.questions.sw[l - 1];
                ctx.replacement.textContent = describe(r, l, 'abcd'[r.correct]);
            };
        },
        dd(ctx) {
            ctx.buttons = [0, 1, 2, 3].map(i => h('button', { onclick: () => key(49 + i) }, h('b', {}, 'ABCD'[i] + ':'), h('span')));
            ctx.body.append(h('div', { class: 'stack' }, h('strong', {}, "Lock the contestant's answer (same as keys 1-4)"), h('div', { class: 'dd-grid answers' }, ctx.buttons)));
            ctx.onNext = () => {
                const n = state ? NEXT_STEP.dd(state, isUsed(4)) : -1;
                if (n === 1 || n === 3) return hint(ctx, "Lock the contestant's answer with the buttons on the right first.");
                defaultNext(ctx);
            };
            ctx.update = () => colorAnswers(ctx.buttons);
        }
    };

    /** Lifelines replaced by another in this theme (Double Dip for 50:50, Ask the Expert for Switch the Question) are not in play. */
    function inPlay(id) {
        if (id === 'ate') return !!state?.stqReplacedByAte;
        if (id === 'stq') return !state?.stqReplacedByAte;
        if (state?.clocked) {
            if (id === 'dd') return !!state.ffReplacedByDd;
            if (id === 'ff') return !state.ffReplacedByDd;
        }
        return true;
    }

    function renderLifelines() {
        const supported = LIFELINES.map((_, i) => state?.supported?.[i] ?? (LIFELINES[i].id !== 'ate'));
        if (!supported[LIFELINES.findIndex(l => l.id === currentLL)] || !inPlay(currentLL)) currentLL = LIFELINES.find((l, i) => supported[i] && inPlay(l.id))?.id || 'ff';
        LIFELINES.forEach((ll, i) => {
            const ctx = lifelineCtx[ll.id];
            const used = isUsed(i);
            ctx.tab.classList.toggle('hidden', !supported[i] || !inPlay(ll.id));
            ctx.tab.classList.toggle('active', ll.id === currentLL);
            ctx.panel.classList.toggle('hidden', ll.id !== currentLL);
            const iconKey = `${assetsTheme}|${used}`;
            if (ctx.iconKey !== iconKey) {
                ctx.iconKey = iconKey;
                ctx.tab.replaceChildren(lifelineIcon(ll.id, used, 48), ll.title, used ? h('span', { class: 'used-label' }, '(used)') : '');
                ctx.iconBox.replaceChildren(lifelineIcon(ll.id, used, 130));
            }
            ctx.stateEl.textContent = !state ? 'Not connected' : used ? 'USED' : 'AVAILABLE';
            ctx.stateEl.className = 'state ' + (!state ? 'muted' : used ? 'used' : 'available');
            ctx.markBtn.textContent = used ? 'Make available again' : 'Mark as used';
            const next = state ? NEXT_STEP[ll.id](state, used) : -1;
            ctx.stepItems.forEach((li, k) => {
                li.classList.toggle('next', k === next);
                li.classList.toggle('done', next < 0 ? used : k < next);
            });
            ctx.update?.();
        });
    }

    // ------------------------------------------------------------------ show tab: question, answers, status, tree
    function colorAnswers(buttons) {
        const q = liveQuestion();
        const correct = liveCorrect();
        const locked = state?.inProgress ? state.target : '';
        const highlight = $('#highlightCorrect').checked;
        buttons.forEach((b, i) => {
            const letter = 'abcd'[i];
            b.querySelector('span').textContent = q?.answers[i] || '';
            b.classList.toggle('out', isOut(i));
            b.classList.toggle('locked', locked === letter);
            b.classList.toggle('correct', highlight && correct === letter && !isOut(i));
        });
    }

    function renderQuestion() {
        const q = liveQuestion();
        $('#qHeader').textContent = `Question ${liveLevel()}` + (q?.category ? `   ·   ${q.category}` : '');
        $('#qText').textContent = q?.text ? oneLine(q.text) : '(empty question: fill it in on the Questions tab)';
        // Clocked 2009: question clock
        const ck = state?.clock;
        $('#clockCard').classList.toggle('hidden', !state?.clocked);
        if (state?.clocked) {
            const secs = $('#clockSeconds');
            secs.textContent = ck?.timeUp ? 'TIME UP' : (ck?.text || (ck?.seconds ?? '-'));
            secs.classList.toggle('low', !!ck && (ck.timeUp || (typeof ck.seconds === 'number' && ck.seconds <= 5 && ck.running)));
            $('#clockStatus').textContent = !ck ? '' : ck.timeUp ? 'Time is up' : ck.running ? 'running' : 'stopped' + (ck.tier ? `  ·  ${ck.tier} s for this level` : '  ·  question 15: gold clock with the banked time');
            $('#clockBanked').textContent = `Banked time: ${ck?.bankedText || '0:00'}${ck?.bankedShowing ? '  (on screen)' : ''}`;
        }
        // Cancel final answer: only while an answer is locked and not yet revealed
        $('#cancelFinal').disabled = !(state?.inProgress && state.target && state.questionStep === 6);
        const m = room.hostMessage;
        $('#hostMsgNow').textContent = m ? `On the host screen now: "${m.text}"  (${m.by}, ${String(m.at).slice(11, 16)})` : 'No message on the host screen.';
        $('#hostMsgNow').style.color = m ? 'var(--orange)' : '';
        $('#hostMsgSend').disabled = $('#hostMsgClear').disabled = !room.screens?.host;
        const banner = $('#endedBanner');
        banner.classList.toggle('hidden', room.status !== 'ended');
        if (room.status === 'ended') {
            banner.replaceChildren(h('strong', {}, `This show has ended${room.endedBy ? ' (' + room.endedBy + ', ' + String(room.endedAt).slice(0, 16).replace('T', ' ') + ')' : ''}. `),
                'Its log is kept. ', h('button', { onclick: async () => { await api('POST', `/api/rooms/${room.id}/reopen`); } }, 'Reopen the show'));
        }
        const t = $('#hostCommentToggle');
        t.textContent = `Host comment: ${room.hostComment ? 'ON' : 'OFF'}`;
        t.className = room.hostComment ? 'primary' : '';
        t.disabled = !room.screens?.host;
        t.title = room.screens?.host ? (q?.comment ? `Comment of this question: ${q.comment}` : 'This question has no host comment') : 'The host screen is not enabled for this show';
        colorAnswers([...$('#answers').children]);
    }

    function renderLeds() {
        const leds = [
            ['Mode: ' + (room?.mode === 'live' ? 'LIVE · questions frozen' : 'REHEARSAL'), room?.mode === 'live'],
            ['Host: ' + (room?.screenViewers?.host || 0) + ' · player: ' + (room?.screenViewers?.player || 0), !!room?.screenViewers?.host && !!room?.screenViewers?.player],
            ['Output connected' + (room?.outputs ? ` (${room.outputs})` : ''), !!room?.outputs && !!state],
            ['Question in progress', !!state?.inProgress],
            ['Money tree on screen', !!state?.treeShowing],
            ['Commercial break / logo', !!state?.commercial, true],
            ['Audience voting open', !!tally?.open, true],
            ['Audience: ' + ({ game: 'random', manual: 'manual %', votes: 'live votes' }[room?.ata.source] || '-'), room?.ata.source !== 'game' && !!state?.ataOverride]
        ];
        $('#leds').replaceChildren(...leds.map(([text, on, warn]) => h('div', {}, h('span', { class: `led${on ? ' on' : ''}${warn ? ' warn' : ''}` }), text)));
        $('#statusInfo').textContent = state ? `Level ${liveLevel()}/15 · ${state.commercial ? 'commercial break' : state.inProgress ? 'question in progress' : 'between questions'}` : 'Output not connected';
        const next = document.querySelector('[data-key="39"]');
        const sequence = ['Lower the lights', 'Show the question', 'Show answer A', 'Show answer B', 'Show answer C', 'Show answer D', 'Reveal the correct answer', 'Continue after the result'];
        next.textContent = state ? `${sequence[state.questionStep] || 'Advance the game'} ▶` : 'Waiting for output';
        document.querySelectorAll('[data-key]').forEach(button => { button.disabled = !socket.connected || !room?.activeOutput || !!room?.recoveryPending || room?.status === 'ended'; });
    }

    function renderTree() {
        const el = $('#tree');
        el.classList.toggle('no-click', !$('#treeClick').checked);
        el.style.backgroundImage = assets?.treeBackground ? `url("${themeUrl(assetsTheme, assets.treeBackground)}")` : '';

        const supported = LIFELINES.map((_, i) => state?.supported?.[i] ?? true);
        const order = assets?.order?.length ? assets.order : ['ff', 'dd', 'paf', 'ata', 'stq'];
        const strip = order.filter(id => {
            const i = LIFELINES.findIndex(l => l.id === id);
            if (i < 0 || !supported[i]) return false;
            if (id === 'ate' || id === 'stq') return inPlay(id);
            return id === 'dd' ? !!state?.ffReplacedByDd : !(id === 'ff' && state?.ffReplacedByDd);
        });
        const width = Math.floor((el.clientWidth - 20) / Math.max(4, strip.length));
        const rows = state?.tree?.rows;
        const count = rows?.length || state?.prizes?.length || 15;
        const highlight = state?.tree ? state.tree.highlight : 0;

        const children = [h('div', { class: 'strip' }, strip.map(id => lifelineIcon(id, isUsed(LIFELINES.findIndex(l => l.id === id)), width)))];
        for (let level = count; level >= 1; level--) {
            const row = rows?.[level - 1];
            const text = row?.t ?? state?.prizes?.[level - 1] ?? '';
            const div = h('div', { class: 'row-level', 'data-level': level }, h('span', { class: 'n' }, level), h('span', {}, text));
            div.style.color = row?.c || (level % 5 === 0 ? '#fff' : '#f99b1c');
            if (level === highlight) {
                div.classList.add('hl');
                if (state.tree.highlightColor) div.style.backgroundColor = state.tree.highlightColor;
                else if (assets?.follower) div.style.backgroundImage = `url("${themeUrl(assetsTheme, assets.follower)}")`;
                else div.style.backgroundColor = 'orange';
            }
            if (level === liveLevel()) div.classList.add('playing');
            div.addEventListener('click', () => restartFrom(level));
            children.push(div);
        }
        el.replaceChildren(...children);
    }

    function restartFrom(level) {
        if (!$('#treeClick').checked || !room) return;
        if (!state) return status('The output is not connected.', true);
        const q = oneLine(room.questions.main[level - 1]?.text).slice(0, 90);
        const msg = (state.inProgress ? `Question ${liveLevel()} is in progress.\n\nAbandon it and restart from question ${level}?` : `Restart the game from question ${level}?`) +
            `\n\nQuestion ${level}: ${q || '(empty)'}\n\nWhat is on screen is closed and the game waits for "Next". A lifeline already in progress counts as used.`;
        if (!confirm(msg)) return;
        cmd({ cmd: 'goToLevel', level });
        status(`Restarted from question ${level}: press Next to start it.`);
    }

    function renderAll() {
        if (!room) return;
        renderQuestion();
        renderLifelines();
        renderLeds();
        renderTree();
    }
    window.addEventListener('resize', () => renderTree());

    // ------------------------------------------------------------------ questions tab
    const qeFields = { category: $('#qeCategory'), text: $('#qeText'), answers: $$('[data-answer]'), correct: $$('[name=qeCorrect]'), comment: $('#qeComment') };
    const editSet = () => room.questions[editSwitch ? 'sw' : 'main'];
    const isEditorFocused = () => $('#page-questions').contains(document.activeElement) && document.activeElement.matches('input[type=text], textarea');

    function renderQuestionList() {
        if (!room) return;
        const list = editSet();
        $('#qList').replaceChildren(...list.map((q, i) => h('button', {
            class: [i + 1 === editLevel ? 'active' : '', i + 1 === liveLevel() ? 'live' : ''].join(' '),
            onclick: () => { editLevel = i + 1; loadEditor(); renderQuestionList(); }
        }, `${i + 1 === liveLevel() ? '>' : ' '}${String(i + 1).padStart(3)}. ${oneLine(q.text).slice(0, 30) || '(empty)'}`)));
    }

    function loadEditor() {
        if (!room) return;
        const q = editSet()[editLevel - 1];
        $('#qEditTitle').textContent = `${editSwitch ? 'Replacement question' : 'Question'} ${editLevel}` + (q.uid ? `  ·  ${q.uid}` : '');
        qeFields.category.value = q.category;
        qeFields.text.value = q.text;
        qeFields.answers.forEach((a, i) => { a.value = q.answers[i]; });
        qeFields.correct.forEach((r, i) => { r.checked = i === q.correct; });
        qeFields.comment.value = q.comment || '';
    }

    function openEditor(level, isSwitch) {
        editLevel = level;
        editSwitch = isSwitch;
        $('#editSwitch').checked = isSwitch;
        showPage('questions');
        loadEditor();
        renderQuestionList();
        qeFields.text.focus();
    }

    let saveTimer = null;
    function editorChanged() {
        const q = {
            category: qeFields.category.value,
            text: qeFields.text.value,
            answers: qeFields.answers.map(a => a.value),
            correct: Math.max(0, qeFields.correct.findIndex(r => r.checked)),
            comment: qeFields.comment.value,
            uid: editSet()[editLevel - 1]?.uid || ''
        };
        editSet()[editLevel - 1] = q;
        renderQuestionList();
        if (!editSwitch && editLevel === liveLevel()) renderAll();
        $('#qeSaved').textContent = 'Saving...';
        clearTimeout(saveTimer);
        const level = editLevel, isSwitch = editSwitch;
        saveTimer = setTimeout(() => {
            cmd({ cmd: 'setQuestion', level, isSwitch, question: q });
            $('#qeSaved').textContent = 'Saved and sent to the game';
        }, 600);
    }
    [qeFields.category, qeFields.text, qeFields.comment, ...qeFields.answers].forEach(el => el.addEventListener('input', editorChanged));
    qeFields.correct.forEach(r => r.addEventListener('change', editorChanged));
    $('#editSwitch').addEventListener('change', e => { editSwitch = e.target.checked; loadEditor(); renderQuestionList(); });
    $('#qeRedraw').addEventListener('click', () => {
        if (!state?.inProgress) return status('There is no question in progress to fix.', true);
        cmd({ cmd: 'redraw', isSwitch: editSwitch });
        status('Question on screen updated.');
    });
    $('#qeImport').addEventListener('click', async () => {
        if (!room?.theme) return status('Choose a theme first.', true);
        if (!confirm(`Replace all the questions of this show with those in the theme "${room.theme}"?`)) return;
        const q = await api('GET', `/api/rooms/${room.id}/theme-questions`);
        cmd({ cmd: 'setAll', main: q.main, sw: q.sw });
        room.questions = q;
        loadEditor(); renderQuestionList(); renderAll();
        status('Questions imported from the theme and sent to the game.');
    });
    $('#qeExport').addEventListener('click', async () => {
        if (!room?.theme) return status('Choose a theme first.', true);
        if (!confirm(`Write this show's questions into the XML files of the theme "${room.theme}"?`)) return;
        try { await api('POST', `/api/rooms/${room.id}/theme-questions`); status('Questions saved to the theme XML.'); }
        catch (e) { status('Could not save: ' + e.message, true); }
    });

    // ------------------------------------------------------------------ themes tab
    const themeAssetsCache = new Map();
    async function renderThemes() {
        const list = $('#themeList');
        list.replaceChildren(...themes.map(t => {
            const preview = h('div', { class: 'preview' });
            const card = h('div', { class: 'theme-card' + (t.name === room?.theme ? ' current' : '') }, preview,
                h('div', { class: 'body' },
                    h('span', { class: 'name' }, t.name, t.format === 'clocked' ? h('span', { class: 'pill', style: 'margin-left:6px', title: 'Question clock with banked time, Ask the Expert, Phone a Friend with three contacts' }, 'Clocked 2009') : ''),
                    h('button', { class: 'primary', disabled: !room || t.name === room?.theme, onclick: () => useTheme(t.name) }, t.name === room?.theme ? 'In use' : 'Use for this show'),
                    h('button', { onclick: () => window.MCTools?.moneyTree(t.name) }, t.format === 'clocked' ? 'Money tree & Clocked...' : 'Money tree...'),
                    h('span', { class: 'muted', style: 'font-size:12px' }, t.global ? 'Global theme of the platform' : t.uploadedBy ? `Uploaded by ${t.uploadedBy}` : 'Installed by an administrator'),
                    // administrators delete any theme of the community, operators the ones they uploaded; global themes nobody here
                    !t.global && (me.role === 'admin' || (t.uploadedBy && t.uploadedBy === me.user)) ? h('button', { class: 'danger', onclick: () => removeTheme(t.name) }, 'Delete') : ''));
            fillPreview(t.name, preview);
            return card;
        }));
    }
    async function fillPreview(name, el) {
        let a = themeAssetsCache.get(name);
        if (!a) {
            try { a = await api('GET', `/api/themes/${encodeURIComponent(name)}/assets`); } catch { return; }
            themeAssetsCache.set(name, a);
        }
        if (a.background) el.style.backgroundImage = `url("${themeUrl(name, a.background)}")`;
        if (a.logo) el.append(h('img', { class: 'logo', src: themeUrl(name, a.logo), alt: '' }));
        for (const id of a.order.filter(id => a.lifelines[id]?.layers.length)) el.append(lifelineIcon(id, false, 46, name, a));
    }
    async function useTheme(name) {
        if (!room) return;
        await api('PUT', `/api/rooms/${room.id}`, { theme: name });
        status(`Theme changed to ${name}: the output reloads with a clean cache.`);
    }
    async function removeTheme(name) {
        if (!confirm(`Delete the theme "${name}" from the server?`)) return;
        try { await api('DELETE', `/api/themes/${encodeURIComponent(name)}`); themeAssetsCache.delete(name); await loadThemes(); status(`Theme ${name} deleted.`); }
        catch (e) { status(e.message, true); }
    }
    $('#themeUpload').addEventListener('click', () => {
        const file = $('#themeFile').files[0];
        if (!file) return status('Choose a .zip file first.', true);
        const form = new FormData();
        form.append('file', file);
        const xhr = new XMLHttpRequest();
        const bar = $('#uploadProgress');
        bar.classList.remove('hidden');
        $('#themeUpload').disabled = true;
        xhr.upload.onprogress = e => { if (e.lengthComputable) { bar.value = e.loaded * 100 / e.total; $('#uploadStatus').textContent = `Uploading ${Math.round(bar.value)}%`; } };
        xhr.upload.onload = () => { $('#uploadStatus').textContent = 'Checking and installing...'; };
        xhr.onloadend = async () => {
            bar.classList.add('hidden');
            $('#themeUpload').disabled = false;
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
            if (xhr.status === 200 && data?.installed) {
                $('#uploadStatus').textContent = `Installed: ${data.installed.join(', ')}`;
                data.installed.forEach(n => themeAssetsCache.delete(n));
                await loadThemes();
            } else {
                $('#uploadStatus').textContent = 'Upload failed: ' + (data?.error || xhr.statusText || 'error');
            }
        };
        xhr.open('POST', '/api/themes' + ($('#themeOverwrite').checked ? '?overwrite=1' : ''));
        xhr.send(form);
    });

    // ------------------------------------------------------------------ pages
    function showPage(name) {
        $$('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.page === name));
        $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
        if (name === 'show') renderTree();
        if (name === 'admin') window.MCAdmin?.open();
        if (name === 'shows') window.MCShows?.open();
        if (name === 'bank') window.MCBank?.open();
        if (name === 'fff') window.MCFff?.open();
        if (name === 'layout') window.MCLayout?.open();
        if (name === 'roblox') window.MCRoblox?.open();
        if (name === 'questions') window.MCTools?.refreshStacks();
        if (name === 'schedule') window.MCSchedule?.open();
        if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    }
    $$('nav.tabs button').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
    // /control#bank, #shows... (links from the home page) open that tab; the address follows the tab
    const pageFromHash = () => {
        const name = location.hash.slice(1);
        const tab = $$('nav.tabs button').find(b => b.dataset.page === name && !b.classList.contains('hidden'));
        if (tab) showPage(name);
    };
    addEventListener('hashchange', pageFromHash);

    // ------------------------------------------------------------------ shared with control-tools.js
    window.MC = {
        h, api, status, socket, themeUrl,
        room: () => room,
        me: () => me,
        state: () => state,
        key: code => key(code),
        /** Makes a show the current one in the control panel and opens the Show tab. */
        selectRoom: async id => { await loadRooms(id); showPage('show'); },
        reloadRooms: id => loadRooms(id),
        /** Replaces the show's questions (both sets), saves them on the server and sends them to the game. */
        applyQuestions(main, sw) {
            if (!room) return;
            room.questions = { main, sw };
            cmd({ cmd: 'setAll', main, sw });
            loadEditor(); renderQuestionList(); renderAll();
        },
        themeChanged: name => { themeAssetsCache.delete(name); if (name === room?.theme) loadAssets().then(renderAll); }
    };

    // ------------------------------------------------------------------ light / dark mode
    const themeButtons = $$('#themeSwitch [data-theme-choice]');
    const showThemeChoice = () => themeButtons.forEach(b => b.classList.toggle('active', b.dataset.themeChoice === window.MCTheme?.get()));
    themeButtons.forEach(b => b.addEventListener('click', () => { window.MCTheme?.set(b.dataset.themeChoice); showThemeChoice(); }));
    showThemeChoice();

    // ------------------------------------------------------------------ start
    buildLifelines();
    (async () => {
        try {
            const cfg = await api('GET', '/api/config');
            publicUrl = cfg.publicUrl || location.origin;
            outputPublicUrl = cfg.outputPublicUrl || publicUrl;
            me = { user: cfg.user, role: cfg.role, database: cfg.database };
            $('#whoami').textContent = `${cfg.user} (${cfg.role})`;
            $('#adminTab').classList.toggle('hidden', cfg.role !== 'admin');
            $('#layoutTab').classList.toggle('hidden', cfg.role !== 'admin');
            // Every user can upload themes; operators replace and delete only the themes they uploaded
            $('#themeRules').textContent = cfg.role === 'admin'
                ? 'As an administrator you can replace and delete any theme.'
                : 'Only administrators can upload executable theme packs.';
            $('#themeUpload').disabled = cfg.role !== 'admin';
            await loadThemes();
            await loadRooms();
            pageFromHash();
        } catch (e) {
            status('Could not load: ' + e.message, true);
        }
    })();
})();
