/* Millionaire Control - show management and the detailed log of every show */
(() => {
    'use strict';
    const { h, api, status, socket } = window.MC;
    const TYPES = { show: 'Show', control: 'Control', game: 'Gameplay', audience: 'Audience', screen: 'Screens' };
    let selected = null;         // show whose log is open
    let events = [];             // loaded events, newest first
    let filters = { game: '', types: new Set(Object.keys(TYPES)), q: '' };
    let follow = true;

    const fmtTime = ts => String(ts || '').replace('T', ' ').replace('Z', '').slice(0, 19);

    // ================================================================== list of shows
    async function open() {
        const box = document.getElementById('showsList');
        let list;
        try { list = await api('GET', '/api/shows'); } catch (e) { box.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
        if (!list.length) { box.replaceChildren(h('p', { class: 'muted' }, 'No shows yet: create one with "+ New show".')); return; }
        box.replaceChildren(h('table', { class: 'grid' },
            h('thead', {}, h('tr', {}, ...['Show', 'Status', 'Theme', 'Created', 'Games', 'Log', 'Live now', ''].map(t => h('th', {}, t)))),
            h('tbody', {}, ...list.map(s => {
                const live = s.live;
                const on = live.outputs > 0;
                const liveText = on
                    ? `output ${live.outputs}` + (live.host ? ` · host ${live.host}` : '') + (live.player ? ` · player ${live.player}` : '') +
                      (live.phones ? ` · ${live.phones} phone(s)` : '') + (live.level ? ` · question ${live.level}${live.inProgress ? ' in progress' : ''}` : '')
                    : 'output not connected';
                return h('tr', { style: selected === s.id ? 'background:var(--accent-soft)' : '' },
                    h('td', {}, h('b', {}, s.name), h('div', { class: 'muted' }, s.id)),
                    h('td', {}, s.status === 'ended'
                        ? h('span', {}, h('span', { class: 'pill bad' }, 'ended'), h('div', { class: 'muted' }, `${fmtTime(s.endedAt).slice(0, 16)}${s.endedBy ? ' · ' + s.endedBy : ''}`))
                        : h('span', { class: 'pill ok' }, on ? 'running' : 'open')),
                    h('td', {}, s.theme || h('span', { class: 'muted' }, '(none)')),
                    h('td', {}, fmtTime(s.createdAt).slice(0, 16), h('div', { class: 'muted' }, s.createdBy ? `by ${s.createdBy}` : '')),
                    h('td', {}, String(s.games || 0)),
                    h('td', {}, `${s.log.events} event(s)`, h('div', { class: 'muted' }, s.log.last ? `last ${fmtTime(s.log.last).slice(0, 16)}` : '')),
                    h('td', {}, h('span', { class: 'live-dot' + (on ? ' on' : '') }), liveText),
                    h('td', { style: 'white-space:nowrap' },
                        h('button', { class: 'primary', onclick: () => window.MC.selectRoom(s.id) }, 'Open'),
                        h('button', { onclick: () => openLog(s) }, 'Log'),
                        s.status === 'ended'
                            ? h('button', { onclick: async () => { await api('POST', `/api/rooms/${s.id}/reopen`); open(); } }, 'Reopen')
                            : h('button', { class: 'danger', onclick: () => endShow(s) }, 'End show'),
                        h('button', { onclick: () => rename(s) }, 'Rename'),
                        h('button', { class: 'danger', onclick: () => remove(s) }, 'Delete')));
            }))));
        if (selected) {
            const s = list.find(x => x.id === selected);
            if (s) renderHeader(s);
        }
    }

    async function endShow(s) {
        if (!confirm(`End the show "${s.name}"?\n\nIt is recorded as ended; the game output, the host and player screens and the audience phones are closed. The log is kept, and the show can be reopened later.`)) return;
        try { await api('POST', `/api/rooms/${s.id}/end`); status(`Show "${s.name}" ended.`); } catch (e) { status(e.message, true); }
        open();
    }

    async function rename(s) {
        const name = prompt('New name of the show:', s.name);
        if (!name) return;
        await api('PUT', `/api/rooms/${s.id}`, { name });
        await window.MC.reloadRooms(window.MC.room()?.id);
        open();
    }

    async function remove(s) {
        if (!confirm(`Delete the show "${s.name}"? Its log is kept and can still be exported.`)) return;
        await api('DELETE', `/api/rooms/${s.id}`);
        if (window.MC.room()?.id === s.id) localStorage.removeItem('mc_room');
        await window.MC.reloadRooms();
        open();
    }

    document.getElementById('showsRefresh').addEventListener('click', open);
    document.getElementById('showsNew').addEventListener('click', async () => {
        const name = prompt('Name of the new show:');
        if (!name) return;
        const { id } = await api('POST', '/api/rooms', { name });
        await window.MC.reloadRooms(id);
        open();
    });

    // ================================================================== log of one show
    let current = null;
    function renderHeader(s) {
        current = s;
        const head = document.getElementById('showLogHead');
        if (head) head.textContent = `${s.name}  ·  ${s.log.events} event(s)  ·  ${s.games || 0} game(s)  ·  created ${fmtTime(s.createdAt).slice(0, 16)}${s.createdBy ? ' by ' + s.createdBy : ''}`;
    }

    async function openLog(s) {
        selected = s.id;
        events = [];
        filters = { game: '', types: new Set(Object.keys(TYPES)), q: '' };
        socket.emit('log:watch', s.id);
        const card = document.getElementById('showLogCard');
        const gameSel = h('select', { onchange: e => { filters.game = e.target.value; reload(); } },
            h('option', { value: '' }, 'All games'), ...Array.from({ length: s.games || 0 }, (_, i) => h('option', { value: i + 1 }, `Game ${i + 1}`)),
            h('option', { value: '0' }, 'Before the first game'));
        const typeBoxes = Object.entries(TYPES).map(([t, label]) => h('label', {},
            h('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked ? filters.types.add(t) : filters.types.delete(t); reload(); } }),
            h('span', { class: `ev-type ev-${t}` }, label)));
        const search = h('input', { type: 'text', placeholder: 'search text or user', size: 22 });
        let searchTimer = null;
        search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = search.value; reload(); }, 300); });
        const followBox = h('input', { type: 'checkbox', checked: follow, onchange: e => { follow = e.target.checked; } });
        const exp = format => { const q = new URLSearchParams({ format, game: filters.game, types: [...filters.types].join(','), q: filters.q }); window.location.href = `/api/shows/${s.id}/export?${q}`; };

        card.replaceChildren(
            h('div', { class: 'row', style: 'justify-content:space-between' },
                h('h3', { style: 'margin:0' }, 'Show log'),
                h('div', { class: 'row' },
                    h('button', { onclick: () => exp('csv') }, 'Export CSV'),
                    h('button', { onclick: () => exp('json') }, 'Export JSON'),
                    window.MC.me().role === 'admin' ? h('button', { class: 'danger', onclick: () => clearLog(s) }, 'Clear log') : '')),
            h('div', { id: 'showLogHead', class: 'muted' }),
            h('div', { class: 'row' }, gameSel, ...typeBoxes, search, h('label', {}, followBox, 'live')),
            h('div', { id: 'showLogTable', style: 'max-height:62vh;overflow:auto' }),
            h('div', { class: 'row' }, h('button', { id: 'showLogMore', onclick: loadMore }, 'Load older events')));
        renderHeader(s);
        await reload();
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        open();
    }

    async function fetchEvents(before) {
        const q = new URLSearchParams({ game: filters.game, types: [...filters.types].join(','), q: filters.q, limit: 300 });
        if (before) q.set('before', before);
        return (await api('GET', `/api/shows/${selected}/events?${q}`)).events;
    }

    async function reload() {
        if (!selected) return;
        events = await fetchEvents();
        renderEvents();
    }

    async function loadMore() {
        if (!events.length) return;
        const older = await fetchEvents(events[events.length - 1].id);
        events.push(...older);
        renderEvents();
        if (!older.length) status('No older events.');
    }

    function row(e, isNew) {
        let data = null;
        try { data = e.data ? JSON.parse(e.data) : null; } catch { data = e.data; }
        const tr = h('tr', { class: (isNew ? 'ev-new ' : '') + (/^Game \d+ started/.test(e.message) ? 'game-start' : '') },
            h('td', { style: 'white-space:nowrap' }, fmtTime(e.ts).slice(11)),
            h('td', {}, e.game ? String(e.game) : '-'),
            h('td', {}, e.level ?? ''),
            h('td', {}, h('span', { class: `ev-type ev-${e.type}` }, TYPES[e.type] || e.type)),
            h('td', {}, e.username || ''),
            h('td', {}, e.message, data ? h('details', {}, h('summary', { class: 'muted' }, 'details'), h('pre', { style: 'white-space:pre-wrap;margin:4px 0;font-size:12px' }, JSON.stringify(data, null, 2))) : ''));
        tr.title = fmtTime(e.ts);
        return tr;
    }

    function renderEvents() {
        const box = document.getElementById('showLogTable');
        if (!box) return;
        if (!events.length) { box.replaceChildren(h('p', { class: 'muted' }, 'No events with these filters.')); return; }
        box.replaceChildren(h('table', { class: 'grid' },
            h('thead', {}, h('tr', {}, ...['Time', 'Game', 'Q', 'Type', 'User', 'Event'].map(t => h('th', {}, t)))),
            h('tbody', { id: 'showLogBody' }, ...events.map(e => row(e, false)))));
    }

    // Live: new events of the show being viewed appear at the top
    socket.on('showEvent', e => {
        if (e.room !== selected || !follow) return;
        if (filters.game !== '' && String(e.game) !== String(filters.game)) return;
        if (!filters.types.has(e.type)) return;
        if (filters.q && !`${e.message} ${e.username || ''}`.toLowerCase().includes(filters.q.toLowerCase())) return;
        events.unshift(e);
        const body = document.getElementById('showLogBody');
        if (body) body.prepend(row(e, true)); else renderEvents();
        if (current) { current.log.events++; if (/^Game (\d+) started/.test(e.message)) current.games = Number(e.message.match(/^Game (\d+)/)[1]); renderHeader(current); }
    });
    socket.on('connect', () => { if (selected) socket.emit('log:watch', selected); });

    async function clearLog(s) {
        if (!confirm(`Delete the whole log of "${s.name}"? This cannot be undone: export it first if you need it.`)) return;
        await api('DELETE', `/api/shows/${s.id}/events`);
        await reload();
        open();
    }

    window.MCShows = { open };
})();
