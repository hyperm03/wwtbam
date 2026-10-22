(() => {
    const { h, api, status } = window.MC;
    const action = fn => async () => { try { await fn(); } catch (e) { status(e.message, true); alert(e.message); } };
    document.getElementById('liveTools').onclick = action(async () => {
        const room = window.MC.room();
        if (!room) throw new Error('Choose a show first');
        const content = h('div', { class: 'stack' });
        const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal', style: 'width:min(1100px,96vw);max-height:92vh;overflow:auto' },
            h('div', { class: 'row' }, h('h2', {}, 'Preparation & recovery'), h('button', { onclick: () => bg.remove() }, 'Close')), content));
        document.body.append(bg);
        async function refresh() {
            const state = await api('GET', `/api/rooms/${room.id}/preflight`);
            content.replaceChildren(
                h('strong', {}, state.mode === 'live' ? 'LIVE — approved questions are frozen' : 'REHEARSAL — does not consume questions in the bank'),
                h('ul', {}, ...state.checks.map(c => h('li', {}, `${c.passed ? '✓' : '○'} ${c.name}${c.optional ? ' (optional)' : ''}`))),
                h('div', { class: 'row' },
                    h('button', { onclick: action(async () => { const copy = await api('POST', `/api/rooms/${room.id}/rehearsal-copy`); bg.remove(); window.MC.selectRoom(copy.id); }) }, 'Create separate rehearsal'),
                    h('button', { onclick: action(async () => { await api('POST', `/api/rooms/${room.id}/freeze`); await refresh(); }) }, 'Freeze approved questions'),
                    h('button', { class: 'primary', onclick: action(async () => {
                        const mode = state.mode === 'live' ? 'rehearsal' : 'live';
                        if (!confirm(mode === 'live' ? 'Go live with this approved set? Participant access will require Discord and check-in.' : 'Return to rehearsal? This resets voting and output and unlocks editing.')) return;
                        await api('POST', `/api/rooms/${room.id}/mode`, { mode }); await refresh();
                    }) }, state.mode === 'live' ? 'Return to rehearsal' : 'Go live')),
                h('h3', {}, 'Recovery'),
                h('p', {}, state.checkpoint ? `Checkpoint: ${state.checkpoint.savedAt} · question ${state.checkpoint.level}` : 'No checkpoint yet'),
                h('div', { class: 'row' },
                    h('button', { disabled: !state.checkpoint, onclick: action(async () => { if (!confirm('Restore this checkpoint with the clock paused and sounds stopped? Verify the output before continuing. Timed lifelines and Fastest Finger need a new round.')) return; await api('POST', `/api/rooms/${room.id}/checkpoint/restore`); status('Recovery confirmed by the output. Verify the picture and resume explicitly.'); await refresh(); }) }, 'Restore paused'),
                    h('button', { disabled: state.mode === 'live' || !state.checkpoint, onclick: action(async () => { if (confirm('Discard recovery data and continue from the current rehearsal output?')) { await api('POST', `/api/rooms/${room.id}/checkpoint/discard`); await refresh(); } }) }, 'Discard checkpoint in rehearsal')),
                h('h3', {}, 'Connected outputs'),
                h('div', {}, ...(window.MC.room()?.outputConnections || []).map(output => h('div', { class: 'row' }, h('span', {}, output.id + (output.active ? ' — ACTIVE' : ' — standby')), output.active ? '' : h('button', { onclick: action(async () => { if (!confirm('Activate this output? Restore the checkpoint before resuming.')) return; await api('POST', `/api/rooms/${room.id}/output/takeover`, { socketId: output.id }); await refresh(); }) }, 'Activate')))),
                h('h3', {}, 'Question review'),
                h('p', {}, 'Any content change creates a new draft. Verify the source, then approve. Main and replacement sets must both be approved for a live show.'),
                h('table', {}, h('thead', {}, h('tr', {}, ...['Slot', 'Status / issues', 'Source (HTTPS)', 'Expiry', 'Actions'].map(t => h('th', {}, t)))),
                    h('tbody', {}, ...state.questions.map(row => {
                        const source = h('input', { type: 'url', value: row.review.sourceUrl || '', placeholder: 'https://…', style: 'width:240px' });
                        const expiry = h('input', { type: 'date', value: row.review.expiresAt?.slice(0, 10) || '' });
                        const review = value => action(async () => { await api('POST', `/api/rooms/${room.id}/reviews/${row.set}/${row.level}`, { status: value, sourceUrl: source.value, expiresAt: expiry.value ? expiry.value + 'T23:59:59Z' : '' }); await refresh(); });
                        return h('tr', {}, h('td', {}, `${row.set === 'sw' ? 'Replacement' : 'Main'} ${row.level}`), h('td', {}, row.review.status, h('div', { class: 'muted' }, row.issues.join(' · '))), h('td', {}, source), h('td', {}, expiry), h('td', {}, ...['draft', 'verified', 'approved'].map(value => h('button', { disabled: !!state.frozen, onclick: review(value) }, value))));
                    }))));
            const regs = await api('GET', `/api/rooms/${room.id}/registrations`);
            content.append(h('h3', {}, 'Participant registrations'), h('ul', {}, ...regs.map(r => h('li', {}, `${r.alias} — ${r.checkedInAt ? 'checked in' : 'registered'}`))));
        }
        await refresh();
    });
})();
