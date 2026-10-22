/* Millionaire Control - Layout editor: host screen, player screen and Fastest Finger console, for the whole platform */
(() => {
    'use strict';
    const { h, api, status } = window.MC;
    const body = document.getElementById('layoutBody');
    const TARGETS = { host: 'Host screen', player: 'Player screen', ff: 'Fastest Finger console' };
    const STATES = {
        host: [['game', 'Question and answers'], ['locked', 'Final answer locked'], ['correct', 'Correct answer revealed'], ['ata', 'Ask the Audience results'], ['paf', 'Phone a Friend clock'], ['walk', 'Walk away (winnings)'], ['idle', 'Between questions']],
        ff: [['open', 'Answering'], ['locked', 'Answer locked'], ['result', 'Result (winner)'], ['question', 'Question only'], ['idle', 'Waiting for a round']]
    };
    STATES.player = STATES.host;
    const DEVICES = [['1280x800', 'Tablet (landscape)'], ['1920x1080', 'PC / touch screen'], ['800x1280', 'Tablet (portrait)'], ['390x844', 'Phone']];
    const FONTS = ['MCConduit', 'Conduit ITC', 'Copperplate Gothic Bold', 'Roadgeek 2014 Series D', 'Roadgeek 2014 Series EEM', 'Segoe UI', 'Arial', 'Arial Narrow', 'Verdana', 'Georgia', 'Times New Roman'];

    let target = 'host', state = 'game', device = '1280x800';
    let layouts = { host: {}, player: {}, ff: {} };
    const undo = { host: [], player: [], ff: [] }, redo = { host: [], player: [], ff: [] };
    let elements = [], sel = null, frame = null, saveTimer = null, loaded = false;
    const rules = () => layouts[target];

    // ================================================================== loading and saving
    async function open() {
        if (window.MC.me().role !== 'admin') { body.replaceChildren(h('p', { class: 'error' }, 'Administrators only.')); return; }
        if (!loaded) { layouts = { ...layouts, ...(await api('GET', '/api/layouts')) }; loaded = true; }
        render();
    }

    const msg = h('span', { class: 'muted' });
    function save(logIt = false) {
        clearTimeout(saveTimer);
        msg.textContent = 'Saving...';
        saveTimer = setTimeout(async () => {
            try {
                const r = await api('PUT', `/api/layouts/${target}`, { rules: rules(), log: logIt });
                layouts[target] = r.rules;
                msg.textContent = 'Saved - applied live to the open screens';
            } catch (e) { msg.textContent = 'Not saved: ' + e.message; }
        }, 400);
    }
    function snapshot() { undo[target].push(JSON.stringify(rules())); if (undo[target].length > 200) undo[target].shift(); redo[target] = []; }
    function setRules(next, logIt) { layouts[target] = next; post({ type: 'rules', rules: next }); save(logIt); renderProps(); renderList(); }
    const post = m => frame?.contentWindow?.postMessage(m, location.origin);

    // ================================================================== messages from the preview
    let dragSnap = null;
    addEventListener('message', e => {
        if (e.origin !== location.origin || e.source !== frame?.contentWindow) return;
        const m = e.data || {};
        if (m.type === 'ready') post({ type: 'rules', rules: rules() });
        if (m.type === 'elements') { elements = m.elements; renderList(); }
        if (m.type === 'selected') { sel = m; renderProps(); renderList(); }
        if (m.type === 'change') {
            if (!dragSnap) { dragSnap = JSON.stringify(rules()); }
            layouts[target] = { ...rules(), [m.key]: { ...rules()[m.key], ...m.props } };
            if (sel?.key === m.key) renderProps();
        }
        if (m.type === 'change-end') {
            if (dragSnap) { undo[target].push(dragSnap); redo[target] = []; dragSnap = null; }
            save(true);
        }
    });

    // ================================================================== page
    function render() {
        const targetSel = h('select', { onchange: e => { target = e.target.value; state = STATES[target][0][0]; sel = null; render(); } },
            ...Object.entries(TARGETS).map(([k, v]) => h('option', { value: k, selected: k === target }, v)));
        const stateSel = h('select', { onchange: e => { state = e.target.value; post({ type: 'state', state }); } },
            ...STATES[target].map(([k, v]) => h('option', { value: k, selected: k === state }, v)));
        const deviceSel = target === 'ff' ? h('select', { onchange: e => { device = e.target.value; render(); } }, ...DEVICES.map(([k, v]) => h('option', { value: k, selected: k === device }, v))) : '';
        const importFile = h('input', { type: 'file', accept: '.json', class: 'hidden', onchange: importLayouts });

        const room = window.MC.room();
        const src = `/layout-preview/${target}?state=${state}${room ? '&room=' + encodeURIComponent(room.id) : ''}`;
        const [w, hgt] = target === 'ff' ? device.split('x').map(Number) : [1920, 1080];
        frame = h('iframe', { src, class: 'layout-frame', style: `width:${w}px;height:${hgt}px` });
        const viewport = h('div', { class: 'layout-viewport' }, frame);
        // fit the preview into the available space
        requestAnimationFrame(() => {
            const avail = viewport.clientWidth - 4, scale = Math.min(1, avail / w, (window.innerHeight * 0.72) / hgt);
            frame.style.transform = `scale(${scale})`;
            viewport.style.height = `${hgt * scale + 4}px`;
        });

        body.replaceChildren(
            h('div', { class: 'card stack' },
                h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' },
                    h('div', { class: 'row' }, h('strong', {}, 'Screen'), targetSel, h('strong', {}, 'Moment'), stateSel, deviceSel),
                    h('div', { class: 'row' },
                        h('button', { title: 'Undo (Ctrl+Z)', onclick: doUndo }, '↶ Undo'), h('button', { title: 'Redo (Ctrl+Y)', onclick: doRedo }, '↷ Redo'),
                        h('button', { onclick: exportLayouts }, 'Export'), h('button', { onclick: () => importFile.click() }, 'Import'), importFile,
                        h('button', { class: 'danger', onclick: () => { if (confirm(`Reset the whole ${TARGETS[target].toLowerCase()} to the original layout?`)) { snapshot(); setRules({}, true); } } }, 'Reset all'))),
                h('p', { class: 'muted', style: 'margin:0' }, 'Click an element to select it, drag it to move it, use the orange handle to resize it, the arrow keys to nudge it (Shift = 10 px). Changes are saved and applied live to every open screen and console. One layout for the whole platform.'),
                msg),
            h('div', { class: 'layout-grid' },
                h('div', { class: 'card layout-list', id: 'layoutList' }),
                viewport,
                h('div', { class: 'card layout-props', id: 'layoutProps' })));
        renderList(); renderProps();
    }

    function renderList() {
        const box = document.getElementById('layoutList');
        if (!box) return;
        box.replaceChildren(h('strong', {}, 'Elements'), ...elements.map(e => h('div', {
            class: 'layout-item' + (sel?.key === e.key ? ' active' : '') + (rules()[e.key] ? ' changed' : '') + (e.visible ? '' : ' faded'),
            title: rules()[e.key] ? 'Changed' : 'Original', onclick: () => post({ type: 'select', key: e.key })
        }, e.label, e.count > 1 ? h('span', { class: 'muted' }, ` ×${e.count}`) : '', rules()[e.key]?.hidden ? h('span', { class: 'pill bad' }, 'hidden') : '')));
    }

    // ================================================================== properties of the selected element
    function renderProps() {
        const box = document.getElementById('layoutProps');
        if (!box) return;
        if (!sel) { box.replaceChildren(h('p', { class: 'muted' }, 'Select an element in the preview or in the list.')); return; }
        const r = rules()[sel.key] || {}, cur = sel.current || {};
        const setProp = (k, v) => {
            snapshot();
            const next = { ...r };
            if (v === '' || v === null || v === undefined) delete next[k]; else next[k] = v;
            const all = { ...rules() };
            if (Object.keys(next).length) all[sel.key] = next; else delete all[sel.key];
            setRules(all, true);
        };
        const numInput = (k, placeholder, step = 1) => {
            const i = h('input', { type: 'number', step, value: r[k] ?? '', placeholder: placeholder ?? '', style: 'width:90px' });
            i.addEventListener('change', () => setProp(k, i.value === '' ? '' : Number(i.value)));
            return i;
        };
        const colourInput = k => {
            const text = h('input', { type: 'text', value: r[k] ?? '', placeholder: cur[k] || '', style: 'width:130px' });
            const pick = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(r[k] || '') ? r[k] : '#ffffff' });
            text.addEventListener('change', () => setProp(k, text.value.trim()));
            pick.addEventListener('input', () => { text.value = pick.value; });
            pick.addEventListener('change', () => setProp(k, pick.value));
            return h('span', { class: 'row' }, pick, text);
        };
        const selectInput = (k, options) => {
            const s = h('select', { onchange: e => setProp(k, e.target.value) }, h('option', { value: '' }, '(original)'), ...options.map(o => h('option', { value: o, selected: r[k] === o }, o)));
            return s;
        };
        const fontInput = h('input', { type: 'text', list: 'layoutFonts', value: r.fontFamily ?? '', placeholder: (cur.fontFamily || '').split(',')[0], style: 'width:220px' });
        fontInput.addEventListener('change', () => setProp('fontFamily', fontInput.value.trim()));
        const upload = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
        upload.addEventListener('change', async () => {
            if (!upload.files[0]) return;
            const form = new FormData(); form.append('file', upload.files[0]);
            const res = await fetch('/api/layouts/asset', { method: 'POST', body: form });
            const d = await res.json();
            if (!res.ok) return status(d.error, true);
            setProp('backgroundImage', d.url);
        });
        const row = (label, ...c) => [h('span', {}, label), h('span', { class: 'row' }, ...c)];

        box.replaceChildren(
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', {}, sel.label), Object.keys(r).length ? h('span', { class: 'pill' }, 'changed') : h('span', { class: 'muted' }, 'original')),
            h('datalist', { id: 'layoutFonts' }, ...FONTS.map(f => h('option', { value: f }))),
            h('div', { class: 'layout-form' },
                ...(sel.movable ? [...row('Position', 'x', numInput('left', cur.left), 'y', numInput('top', cur.top))] : []),
                ...row('Size', 'w', numInput('width', cur.width), 'h', numInput('height', cur.height)),
                ...row('Font', fontInput),
                ...row('Text size', numInput('fontSize', cur.fontSize), 'px'),
                ...row('Weight', selectInput('fontWeight', ['normal', 'bold', '300', '500', '600', '800', '900'])),
                ...row('Style', selectInput('fontStyle', ['normal', 'italic']), selectInput('textTransform', ['none', 'uppercase', 'lowercase', 'capitalize'])),
                ...row('Align', selectInput('textAlign', ['left', 'center', 'right'])),
                ...row('Spacing', numInput('letterSpacing', '', 0.5), 'px'),
                ...row('Text colour', colourInput('color')),
                ...row('Background', colourInput('backgroundColor')),
                ...row('Picture', h('button', { onclick: () => upload.click() }, 'Upload...'), upload,
                    h('button', { onclick: () => setProp('backgroundImage', 'none') }, 'None'),
                    r.backgroundImage ? h('button', { onclick: () => setProp('backgroundImage', '') }, 'Original') : ''),
                ...row('Border colour', colourInput('borderColor')),
                ...row('Corners', numInput('borderRadius', ''), 'px'),
                ...row('Opacity', numInput('opacity', cur.opacity, 0.05), '0 - 1'),
                ...row('Layer', numInput('zIndex', cur.zIndex === 'auto' ? '' : cur.zIndex)),
                ...row('Visible', h('label', {}, h('input', { type: 'checkbox', checked: !r.hidden, onchange: e => setProp('hidden', e.target.checked ? '' : true) }), 'shown on the screen'))),
            h('div', { class: 'row', style: 'margin-top:10px' },
                h('button', { class: 'danger', disabled: !Object.keys(r).length, onclick: () => { snapshot(); const all = { ...rules() }; delete all[sel.key]; setRules(all, true); } }, 'Back to the original')));
    }

    // ================================================================== undo / redo, export / import
    function doUndo() { const prev = undo[target].pop(); if (prev == null) return; redo[target].push(JSON.stringify(rules())); setRules(JSON.parse(prev), true); }
    function doRedo() { const next = redo[target].pop(); if (next == null) return; undo[target].push(JSON.stringify(rules())); setRules(JSON.parse(next), true); }
    addEventListener('keydown', e => {
        if (!document.getElementById('page-layout')?.classList.contains('active') || !(e.ctrlKey || e.metaKey)) return;
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
        if (e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
    });
    function exportLayouts() {
        const blob = new Blob([JSON.stringify({ format: 'millionaire-layouts', version: 1, layouts }, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: 'layouts.json' }); document.body.append(a); a.click(); a.remove();
    }
    async function importLayouts(e) {
        const file = e.target.files[0]; if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = data.layouts || data;
            if (!confirm('Replace the layouts of this platform with the ones in the file? (Pictures uploaded on another server must be uploaded again.)')) return;
            for (const t of Object.keys(TARGETS)) if (incoming[t]) layouts[t] = (await api('PUT', `/api/layouts/${t}`, { rules: incoming[t], log: true })).rules;
            status('Layouts imported.');
            render();
        } catch (err) { status('Not a valid layout file: ' + err.message, true); }
        e.target.value = '';
    }

    // The show arrives after the tab was opened (e.g. straight on /control#layout): reload the preview with it,
    // so that the screens use the fonts of its theme
    window.MC.socket.on('room', r => {
        if (document.getElementById('page-layout')?.classList.contains('active') && r?.id && frame && !frame.src.includes('room=')) render();
    });

    window.MCLayout = { open };
})();
