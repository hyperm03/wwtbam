(() => {
    const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
    const status = text => { $('status').textContent = text; };
    async function request(path, method = 'GET', body) {
        const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
        if (!response.ok) { const e = await response.json(); throw new Error(e.error || 'Operazione non riuscita'); }
        return response.json();
    }
    const run = fn => async event => { event?.preventDefault(); try { await fn(); } catch (e) { status(e.message); } };
    async function load() {
        const settings = await request('/auth/discord/status');
        $('next').value = params.get('next') || '/account';
        $('ageLabel').textContent = `Ho almeno ${settings.privacy.minAge} anni.`;
        let data;
        try { data = await request('/participant/me'); } catch { /* not signed in */ }
        $('discordForm').hidden = !!data || !settings.enabled;
        $('profile').hidden = !data;
        if (!data) { status(settings.enabled ? 'Accedi per iscriverti, fare check-in e votare.' : 'Il login Discord deve essere configurato dal gestore.'); return; }
        $('alias').value = data.account.alias;
        $('registrations').replaceChildren(...Object.entries(data.registrations).map(([room, r]) => {
            const li = document.createElement('li'); li.textContent = `${room}: ${r.checkedInAt ? 'check-in effettuato' : 'iscritto'} `;
            const cancel = document.createElement('button'); cancel.textContent = 'Annulla iscrizione'; cancel.onclick = run(async () => { await request(`/participant/rooms/${encodeURIComponent(room)}/register`, 'DELETE'); await load(); }); li.append(cancel); return li;
        }));
        const room = params.get('room');
        $('registration').replaceChildren();
        if (room && /^[a-z0-9-]+$/.test(room)) {
            for (const [label, checkIn] of [['Iscrivimi', false], ['Effettua check-in', true]]) {
                const b = document.createElement('button'); b.textContent = label; b.onclick = run(async () => { await request(`/participant/rooms/${room}/register`, 'POST', { checkIn }); status('Iscrizione aggiornata.'); await load(); }); $('registration').append(b);
            }
            const next = params.get('next');
            if (next && /^\/(?:v|ff|player)\/[a-z0-9-]+$/.test(next)) { const a = document.createElement('a'); a.href = next; a.textContent = 'Torna allo show'; $('registration').append(a); }
        }
    }
    $('aliasForm').onsubmit = run(async () => { await request('/participant/me', 'PUT', { alias: $('alias').value }); status('Soprannome aggiornato.'); });
    $('logout').onclick = run(async () => { await request('/participant/logout', 'POST'); location.replace('/account'); });
    $('delete').onclick = run(async () => { if (!confirm('Eliminare account locale, iscrizioni e sessioni? Il tuo account Discord resterà attivo.')) return; await request('/participant/me', 'DELETE'); location.replace('/account'); });
    load().catch(e => status(e.message));
})();
