/* Millionaire Control - calendar of scheduled shows */
(() => {
    'use strict';
    const { h, api, status } = window.MC;
    const body = document.getElementById('scheduleBody');
    let view = 'upcoming';
    let editing = null;   // id of the event in the form, null = new

    const pad = n => String(n).padStart(2, '0');
    /** ISO (UTC) -> value of <input type="datetime-local"> in local time */
    const toLocalInput = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const fmt = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const STATE = { upcoming: ['scheduled', ''], live: ['LIVE', 'ok'], ended: ['ended', ''], cancelled: ['cancelled', 'bad'] };

    /** Draws the tab; `showId` = event to open in the form afterwards (e.g. the one just saved, with its invitation link). */
    async function open(showId = null) {
        let events, rooms;
        try { [events, rooms] = await Promise.all([api('GET', '/api/schedule'), api('GET', '/api/rooms')]); }
        catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message)); return; }

        // ------------------------------------------------------------------ form
        const f = {
            title: h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Saturday night show', style: 'width:100%' }),
            start: h('input', { type: 'datetime-local' }),
            duration: h('input', { type: 'number', min: 5, max: 1440, value: 90, style: 'width:90px' }),
            room: h('select', {}, h('option', { value: '__new__' }, '+ New show for this event'), h('option', { value: '' }, '(no show linked)'), ...rooms.map(r => h('option', { value: r.id }, r.name))),
            live: h('input', { type: 'checkbox', checked: true }),
            discordNotify: h('input', { type: 'checkbox' }),
            location: h('input', { type: 'text', maxlength: 120, style: 'width:100%' }),
            locationUrl: h('input', { type: 'url', style: 'width:100%' }),
            link: h('input', { type: 'url', placeholder: 'optional: e.g. a live stream link', style: 'width:100%' }),
            description: h('textarea', { rows: 3, maxlength: 2000, style: 'width:100%', placeholder: 'Notes about the show' })
        };
        const formTitle = h('h3', { style: 'margin:0' });
        const msg = h('span', { class: 'muted' });
        const invite = h('div', { class: 'row hidden' });
        const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => status(`${what} copied to the clipboard.`), () => prompt('Copy the link:', text));
        const showInvite = e => {
            invite.classList.toggle('hidden', !e?.inviteUrl);
            if (!e?.inviteUrl) return;
            invite.replaceChildren(h('strong', {}, 'Invitation link:'),
                h('input', { type: 'text', readonly: true, value: e.inviteUrl, style: 'flex:1;min-width:260px' }),
                h('button', { class: 'primary', onclick: () => copy(e.inviteUrl, 'Invitation link') }, 'Copy'),
                h('button', { onclick: () => window.open(e.inviteUrl, '_blank') }, 'Open'));
        };
        const cancelEdit = h('button', { onclick: () => fill(null) }, 'New event');

        function fill(e) {
            editing = e?.id ?? null;
            formTitle.textContent = e ? `Edit "${e.title}"` : 'New show on the calendar';
            f.title.value = e?.title ?? '';
            if (e) f.start.value = toLocalInput(e.start);
            else { const d = new Date(Date.now() + 86400000); d.setHours(21, 0, 0, 0); f.start.value = toLocalInput(d.toISOString()); }
            f.duration.value = e?.duration ?? 90;
            f.room.value = e ? (e.room ?? '') : '__new__';
            f.live.checked = e ? e.live !== false : true;
            f.discordNotify.checked = e?.discordNotify === true;
            f.location.value = e?.location ?? window.BRAND?.locationName ?? 'TPH Discord server';
            f.locationUrl.value = e?.locationUrl ?? window.BRAND?.locationUrl ?? 'https://discord.gg/QZMmsRTKrw';
            showInvite(e);
            f.link.value = e?.link ?? '';
            f.description.value = e?.description ?? '';
            cancelEdit.classList.toggle('hidden', !e);
            msg.textContent = '';
            if (e) formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async function save() {
            if (!f.start.value) { msg.textContent = 'Choose the date and time.'; return; }
            const createRoom = f.room.value === '__new__';
            const data = {
                title: f.title.value, start: new Date(f.start.value).toISOString(), duration: Number(f.duration.value),
                room: createRoom ? '' : f.room.value, createRoom, live: f.live.checked,
                discordNotify: window.MC.me().role === 'admin' ? f.discordNotify.checked : undefined,
                location: f.location.value, locationUrl: f.locationUrl.value, link: f.link.value, description: f.description.value
            };
            try {
                const saved = editing ? await api('PUT', `/api/schedule/${editing}`, data) : await api('POST', '/api/schedule', data);
                status(editing ? 'Event updated.' : `Event added to the calendar${saved.createdRoom ? ' and show created in the Shows section' : ''}. Share the invitation link!`);
                if (saved.createdRoom) await window.MC.reloadRooms(window.MC.room()?.id);
                await open(saved.id);
            } catch (e) { msg.textContent = e.message; }
        }

        const formCard = h('div', { class: 'card stack' },
            formTitle,
            h('div', { class: 'form-grid', style: 'grid-template-columns:170px minmax(0,560px)' },
                h('span', {}, 'Title'), f.title,
                h('span', {}, 'Date and time'), h('span', { class: 'row' }, f.start, h('span', { class: 'muted' }, 'your local time'), 'Duration', f.duration, 'min'),
                h('span', {}, 'Show'), h('span', { class: 'row' }, f.room, h('span', { class: 'muted' }, 'a new show is created in the Shows section and linked to the event')),
                h('span', {}, 'Live'), h('label', {}, f.live, 'live show (in diretta)'),
                h('span', {}, 'Discord reminders'), h('label', {}, f.discordNotify, 'opt in: 24h, 1h, start and anonymous final prize (configured bot required)'),
                h('span', {}, 'Where'), f.location,
                h('span', {}, 'Link of the place'), f.locationUrl,
                h('span', {}, 'Watch link'), f.link,
                h('span', {}, 'Description'), f.description),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), cancelEdit, msg),
            invite);
        f.discordNotify.disabled = window.MC.me().role !== 'admin';
        formCard.append(h('button', { disabled: window.MC.me().role !== 'admin', onclick: async () => {
            if (!editing) return status('Save the event first.', true);
            if (!confirm('Create or update this event in the configured Discord server?')) return;
            try { await api('POST', `/api/admin/discord-events/${editing}`, { enabled: f.discordNotify.checked, sync: true }); status('Discord event synchronized.'); }
            catch (e) { status(e.message, true); }
        } }, 'Synchronize scheduled Discord event'));
        fill(showId ? events.find(e => e.id === showId) ?? null : null);

        // ------------------------------------------------------------------ list
        const now = Date.now();
        const shown = events.filter(e => view === 'all' ? true
            : view === 'upcoming' ? (e.state === 'upcoming' || e.state === 'live' || (e.state === 'cancelled' && Date.parse(e.start) >= now))
                : (e.state === 'ended' || (e.state === 'cancelled' && Date.parse(e.start) < now)));
        if (view !== 'upcoming') shown.reverse();

        const tabs = h('div', { class: 'row' }, ...[['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']].map(([v, label]) =>
            h('button', { class: view === v ? 'primary' : '', onclick: () => { view = v; open(); } }, label)));

        const table = shown.length ? h('table', { class: 'grid' },
            h('thead', {}, h('tr', {}, ...['When', 'Event', 'Show', 'Status', 'Invitation', ''].map(t => h('th', {}, t)))),
            h('tbody', {}, ...shown.map(e => h('tr', {},
                h('td', { style: 'white-space:nowrap' }, fmt(e.start), h('div', { class: 'muted' }, `${e.duration} min`)),
                h('td', {}, h('b', {}, e.title), e.description ? h('div', { class: 'muted' }, e.description.slice(0, 120) + (e.description.length > 120 ? '...' : '')) : ''),
                h('td', {}, e.roomName || h('span', { class: 'muted' }, '-')),
                h('td', {}, h('span', { class: 'pill ' + STATE[e.state][1] }, STATE[e.state][0]), ' ', e.live !== false ? h('span', { class: 'pill bad', title: 'Live show' }, 'LIVE') : h('span', { class: 'pill' }, 'not live')),
                h('td', { style: 'white-space:nowrap' },
                    h('button', { title: e.inviteUrl, onclick: () => copy(e.inviteUrl, 'Invitation link') }, 'Copy link'),
                    h('button', { onclick: () => window.open(e.inviteUrl, '_blank') }, 'Open')),
                h('td', { style: 'white-space:nowrap' },
                    h('button', { onclick: () => fill(e) }, 'Edit'),
                    e.status === 'cancelled'
                        ? h('button', { onclick: async () => { await api('PUT', `/api/schedule/${e.id}`, { status: 'scheduled' }); open(); } }, 'Restore')
                        : h('button', { onclick: async () => { if (confirm(`Cancel "${e.title}"? It stays on the calendar marked as cancelled.`)) { await api('PUT', `/api/schedule/${e.id}`, { status: 'cancelled' }); open(); } } }, 'Cancel'),
                    h('button', { class: 'danger', onclick: async () => { if (confirm(`Delete "${e.title}" from the calendar?`)) { await api('DELETE', `/api/schedule/${e.id}`); open(); } } }, 'Delete'))))))
            : h('p', { class: 'muted' }, view === 'upcoming' ? 'No show scheduled.' : 'Nothing here.');

        body.replaceChildren(formCard, h('div', { class: 'card stack', style: 'margin-top:14px' }, tabs, table));
    }

    window.MCSchedule = { open };
})();
