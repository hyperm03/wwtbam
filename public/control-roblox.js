/* Millionaire Control - link with the Roblox set: status, buttons of the set, events -> buttons */
(() => {
    'use strict';
    const { h, api, status } = window.MC;
    const body = document.getElementById('robloxBody');
    let data = null, filter = '', timer = null, dirty = null;
    const isAdmin = () => window.MC.me().role === 'admin';
    const short = p => String(p).replace(/^Workspace\./, '');
    // "lifeline:3" = the LifeControl of the slot holding that lifeline (resolved by the set)
    const pretty = p => { const m = /^lifeline:(\d+)$/.exec(p); return m ? `Lifeline slot: ${data?.lifelineTypes?.[m[1]] ?? 'type ' + m[1]}` : short(p).split('.').slice(-2).join(' / '); };
    const isVirtual = p => /^lifeline:\d+$/.test(p);
    const active = () => document.getElementById('page-roblox')?.classList.contains('active');

    async function load() {
        const room = window.MC.room();
        if (!room) { body.replaceChildren(h('p', { class: 'muted' }, 'Choose a show first.')); return; }
        try { data = await api('GET', `/api/rooms/${room.id}/roblox`); } catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
        if (!dirty) dirty = null;
        render();
    }
    async function open() {
        await load();
        clearInterval(timer);
        timer = setInterval(async () => {
            if (!active()) return;
            const room = window.MC.room(); if (!room || !data) return;
            try { const d = await api('GET', `/api/rooms/${room.id}/roblox`); data.status = d.status; renderStatus(); } catch { /* ignore */ }
        }, 3000);
    }
    const save = async patch => {
        try { const r = await api('PUT', `/api/rooms/${window.MC.room().id}/roblox`, patch); Object.assign(data, r); render(); }
        catch (e) { status(e.message, true); }
    };

    // ================================================================== page
    function render() {
        const room = window.MC.room();
        body.replaceChildren(
            linkCard(room),
            h('div', { class: 'roblox-grid' }, buttonsCard(room), mappingCard()));
        renderStatus();
    }

    function renderStatus() {
        const box = document.getElementById('robloxStatus');
        if (!box || !data) return;
        const online = data.status.servers.filter(s => s.online);
        box.replaceChildren(
            data.enabled ? (online.length ? h('span', { class: 'pill ok' }, `connected · ${online.length} server${online.length > 1 ? 's' : ''}`) : h('span', { class: 'pill bad' }, 'waiting for the set')) : h('span', { class: 'pill' }, 'off'),
            ...online.map(s => h('span', { class: 'muted' }, ` place ${s.placeId ?? '?'} · ${s.players} player(s) · ${s.jobId === 'studio' ? 'Studio' : 'server ' + String(s.jobId).slice(0, 8)}`)),
            h('span', { class: 'muted' }, ` · ${data.status.buttons.length} buttons known`));
    }

    // ------------------------------------------------------------------ link
    function linkCard(room) {
        const dl = f => h('a', { class: 'button-link', href: `/api/rooms/${room.id}/roblox/${f}` }, f);
        return h('div', { class: 'card stack' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
                h('h3', { style: 'margin:0' }, 'Roblox set'),
                h('div', { id: 'robloxStatus', class: 'row' })),
            isAdmin() ? h('div', { class: 'row' },
                h('label', {}, h('input', { type: 'checkbox', checked: data.enabled, onchange: e => save({ enabled: e.target.checked }) }), 'Link this show to the Roblox set'),
                h('span', { class: 'muted' }, 'Show id:'), h('code', {}, room.id),
                h('span', { class: 'muted' }, 'Key:'), h('code', {}, data.key ? data.key.slice(0, 6) + '…' : ''),
                h('button', { onclick: () => navigator.clipboard?.writeText(data.key).then(() => status('Key copied.')) }, 'Copy key'),
                h('button', { onclick: () => { if (confirm('Create a new key? The set must get the new MillionaireLink script.')) save({ newKey: true }); } }, 'New key')) : '',
            (() => {
                // The game graphics over the Roblox stream: OBS browser source, transparent, silent (the set plays
                // the music), starting with nothing on screen, ready for the opening money tree
                const overlay = `${data.baseUrl}/output/${encodeURIComponent(room.id)}?t=${encodeURIComponent(room.outputToken || '')}&bg=transparent&start=tree&sound=off`;
                return h('div', { class: 'stack' },
                    h('div', { class: 'row' }, h('strong', {}, 'OBS overlay for the Roblox stream:'),
                        h('input', { type: 'text', readonly: true, value: overlay, style: 'flex:1;min-width:300px' }),
                        h('button', { onclick: () => navigator.clipboard?.writeText(overlay).then(() => status('Overlay link copied.'), () => prompt('Copy:', overlay)) }, 'Copy')),
                    h('span', { class: 'muted' }, 'In OBS: the Roblox game capture below, this link as a browser source (1920x1080) above it. Transparent, silent (music and sounds come from the set), it starts with nothing on screen, ready for the opening money tree (left arrow). Keep it private.'));
            })(),
            isAdmin() ? h('details', {},
                h('summary', {}, 'Install in the Roblox set (once)'),
                h('ol', { class: 'stack', style: 'margin:8px 0' },
                    h('li', {}, 'Save a copy of your place.'),
                    h('li', {}, 'Download the scripts: ', dl('MillionaireButtons.lua'), ' (ModuleScript), ', dl('MillionaireLink.lua'), ' (Script, already set for this show), ', dl('Install.lua'), ', ', dl('Uninstall.lua'), '.'),
                    h('li', {}, 'In ServerScriptService create a ModuleScript named MillionaireButtons and a Script named MillionaireLink, and paste the two files into them.'),
                    h('li', {}, 'Link the buttons of the set, in one of two ways. Recommended: the Studio plugin ', dl('MillionairePlugin.lua'), ' - insert a Script, paste the file, right-click it > Save as Local Plugin, delete the Script; then Plugins tab > Millionaire Show Control > "Link the set" (and "Check" to see what is missing). Or: View > Command Bar, paste the single line of Install.lua and press Enter. The original scripts are kept in ServerStorage/MillionaireBackup.'),
                    h('li', {}, 'Game Settings > Security: turn on "Allow HTTP Requests". Publish, or press Play in Studio: this page shows "connected".'))) : '');
    }

    // ------------------------------------------------------------------ buttons of the set
    function buttonsCard(room) {
        const all = data.status.buttons;
        const f = filter.toLowerCase();
        const list = all.filter(p => !f || p.toLowerCase().includes(f));
        const groups = {};
        for (const p of list) { const parts = short(p).split('.'); const g = parts.slice(0, -1).join(' / ') || '(set)'; (groups[g] ??= []).push(p); }
        const search = h('input', { type: 'text', placeholder: 'search a button', value: filter, size: 24, class: 'rbx-search' });
        search.addEventListener('input', () => { filter = search.value; const pos = search.selectionStart; render(); const s = body.querySelector('.rbx-search'); s?.focus(); s?.setSelectionRange(pos, pos); });
        const mapped = new Set(Object.values(data.mapping).flat());
        return h('div', { class: 'card stack' },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { style: 'margin:0' }, `Buttons of the set (${all.length})`), search),
            all.length ? '' : h('p', { class: 'muted' }, 'The set sends its buttons when it connects.'),
            h('div', { class: 'rbx-buttons' }, ...Object.entries(groups).map(([g, items]) => h('details', { open: !!f || Object.keys(groups).length < 6 },
                h('summary', {}, `${g} (${items.length})`),
                h('div', { class: 'rbx-chips' }, ...items.map(p => h('button', {
                    class: 'rbx-btn' + (mapped.has(p) ? ' mapped' : ''), title: `${short(p)}${mapped.has(p) ? ' - used by a game event' : ''}\nClick to press it in the set`,
                    disabled: !data.enabled,
                    onclick: async () => { try { await api('POST', `/api/rooms/${room.id}/roblox/press`, { path: p }); status(`Pressed ${short(p).split('.').pop()} in the set.`); } catch (e) { status(e.message, true); } }
                }, short(p).split('.').pop())))))));
    }

    // ------------------------------------------------------------------ events -> buttons
    function mappingCard() {
        const mapping = dirty ?? data.mapping;
        const options = h('datalist', { id: 'rbxButtons' },
            ...Object.entries(data.lifelineTypes || {}).map(([n, label]) => h('option', { value: `lifeline:${n}` }, `Lifeline slot: ${label}`)),
            ...data.status.buttons.map(p => h('option', { value: short(p) })));
        const edit = (id, list) => { dirty = { ...mapping, [id]: list }; render(); };
        return h('div', { class: 'card stack' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
                h('h3', { style: 'margin:0' }, 'Game events → buttons of the set'),
                isAdmin() ? h('div', { class: 'row' },
                    dirty ? h('button', { class: 'primary', onclick: async () => { await save({ mapping: dirty }); dirty = null; render(); status('Mapping saved.'); } }, 'Save the mapping') : '',
                    dirty ? h('button', { onclick: () => { dirty = null; render(); } }, 'Discard') : '',
                    h('button', { onclick: () => { if (confirm('Back to the default mapping of the TPH set?')) { dirty = null; save({ resetMapping: true }); } } }, 'Defaults')) : ''),
            h('p', { class: 'muted', style: 'margin:0' }, 'When a moment of the game happens in the control room, these buttons are pressed in the set, in order: the set then plays its own lights, graphics and sounds. Before "Question on screen" the question of the control room is loaded into the set.'),
            options,
            h('div', { class: 'rbx-map' }, ...data.events.map(ev => {
                const list = mapping[ev.id] || [];
                const add = h('input', { type: 'text', list: 'rbxButtons', placeholder: '+ add a button', size: 26, disabled: !isAdmin() });
                add.addEventListener('change', () => {
                    const v = add.value.trim(); if (!v) return;
                    const full = isVirtual(v) ? v : data.status.buttons.find(p => short(p) === v) || (v.startsWith('Workspace.') ? v : 'Workspace.' + v);
                    edit(ev.id, [...list, full]);
                });
                return h('div', { class: 'rbx-map-row' },
                    h('span', {}, ev.label),
                    h('span', { class: 'row', style: 'flex-wrap:wrap;gap:4px' },
                        ...list.map((p, i) => h('span', { class: 'pill' + (data.status.buttons.length && !isVirtual(p) && !data.status.buttons.includes(p) ? ' bad' : ''), title: data.status.buttons.length && !isVirtual(p) && !data.status.buttons.includes(p) ? 'The set has no button with this name' : (isVirtual(p) ? 'The LifeControl of the slot that holds this lifeline' : short(p)) },
                            pretty(p),
                            isAdmin() ? h('button', { class: 'pill-x', onclick: () => edit(ev.id, list.filter((_, k) => k !== i)) }, '×') : '')),
                        isAdmin() ? add : (list.length ? '' : h('span', { class: 'muted' }, '-'))));
            })));
    }

    window.MC.socket.on('room', () => { if (active() && data && !dirty) load(); });
    window.MCRoblox = { open };
})();
