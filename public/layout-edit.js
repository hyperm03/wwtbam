/* Layout editor: runs inside the preview (screen or console with sample data). Selection, drag, resize, nudge;
   the control panel holds the layout and the properties panel and talks to this page with postMessage. */
(() => {
    'use strict';
    const parentWin = window.parent;
    const send = msg => parentWin.postMessage(msg, location.origin);
    let rules = {}, selected = null, hovered = null, drag = null;

    // ------------------------------------------------------------------ layout -> CSS (same rules as the server)
    function cssFor(key, p) {
        const d = [];
        for (const k of ['left', 'top', 'width', 'height']) if (p[k] !== undefined) d.push(`${k}: ${p[k]}px`);
        if (p.fontFamily) d.push(`font-family: ${p.fontFamily.split(',').map(f => { f = f.trim().replace(/^['"]|['"]$/g, ''); return /^(serif|sans-serif|monospace)$/.test(f) ? f : `"${f}"`; }).join(', ')}`);
        if (p.fontSize !== undefined) d.push(`font-size: ${p.fontSize}px`);
        if (p.fontWeight) d.push(`font-weight: ${p.fontWeight}`);
        if (p.fontStyle) d.push(`font-style: ${p.fontStyle}`);
        if (p.textAlign) d.push(`text-align: ${p.textAlign}`, `justify-content: ${{ left: 'flex-start', center: 'center', right: 'flex-end' }[p.textAlign]}`);
        if (p.textTransform) d.push(`text-transform: ${p.textTransform}`);
        if (p.letterSpacing !== undefined) d.push(`letter-spacing: ${p.letterSpacing}px`);
        if (p.color) d.push(`color: ${p.color}`);
        if (p.backgroundColor) d.push(`background-color: ${p.backgroundColor}`);
        if (p.backgroundImage) d.push(p.backgroundImage === 'none' ? 'background-image: none' : `background-image: url("${p.backgroundImage}")`, ...(p.backgroundImage === 'none' ? [] : ['background-size: 100% 100%', 'background-repeat: no-repeat']));
        if (p.borderColor) d.push(`border-color: ${p.borderColor}`);
        if (p.borderRadius !== undefined) d.push(`border-radius: ${p.borderRadius}px`);
        if (p.opacity !== undefined) d.push(`opacity: ${p.opacity}`);
        if (p.zIndex !== undefined) d.push(`z-index: ${p.zIndex}`);
        if (p.hidden) d.push('display: none');
        return d.length ? `[data-edit="${key}"] { ${d.map(x => x + ' !important').join('; ')}; }` : '';
    }
    function applyRules() {
        // hidden elements stay visible (faded) in the editor, so that they can still be selected
        const css = Object.entries(rules).map(([k, p]) => cssFor(k, { ...p, hidden: undefined }) + (p.hidden ? `\n[data-edit="${k}"] { opacity: .25 !important; outline: 2px dashed #f55 !important; }` : '')).join('\n');
        document.getElementById('mc-layout').textContent = css;
        requestAnimationFrame(drawFrames);
    }

    // ------------------------------------------------------------------ frames
    const frame = document.createElement('div');
    const hoverFrame = document.createElement('div');
    const tag = document.createElement('div');
    const handle = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = `
        .mc-frame { position: fixed; pointer-events: none; z-index: 2147483000; box-sizing: border-box; }
        .mc-frame.sel { outline: 2px solid #ffb52e; box-shadow: 0 0 0 9999px rgba(0,0,0,.18); }
        .mc-frame.hover { outline: 1px dashed #7cc6ff; }
        .mc-group { position: fixed; pointer-events: none; z-index: 2147482999; outline: 1px solid rgba(255,181,46,.6); }
        .mc-tag { position: fixed; z-index: 2147483001; pointer-events: none; background: #ffb52e; color: #000; font: 600 12px Segoe UI, Arial; padding: 2px 6px; border-radius: 3px; white-space: nowrap; }
        .mc-handle { position: fixed; z-index: 2147483002; width: 14px; height: 14px; background: #ffb52e; border: 2px solid #000; border-radius: 3px; cursor: nwse-resize; }
        [data-edit] { cursor: pointer; }
        .mc-dragging, .mc-dragging * { cursor: grabbing !important; user-select: none !important; }`;
    document.head.append(style);
    frame.className = 'mc-frame sel'; hoverFrame.className = 'mc-frame hover'; tag.className = 'mc-tag'; handle.className = 'mc-handle';
    [frame, hoverFrame, tag, handle].forEach(e => { e.style.display = 'none'; document.body.append(e); });
    let groupFrames = [];

    const keyOf = el => el?.closest?.('[data-edit]');
    const labelOf = key => document.querySelector(`[data-edit="${key}"]`)?.getAttribute('data-edit-label') || key;
    const place = (box, r) => Object.assign(box.style, { display: '', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const movable = el => ['absolute', 'fixed'].includes(getComputedStyle(el).position);

    function drawFrames() {
        groupFrames.forEach(f => f.remove()); groupFrames = [];
        if (selected && document.contains(selected)) {
            const r = selected.getBoundingClientRect();
            place(frame, r);
            Object.assign(tag.style, { display: '', left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top - 20)}px` });
            tag.textContent = labelOf(selected.getAttribute('data-edit'));
            if (movable(selected)) Object.assign(handle.style, { display: '', left: `${r.right - 8}px`, top: `${r.bottom - 8}px` }); else handle.style.display = 'none';
            document.querySelectorAll(`[data-edit="${selected.getAttribute('data-edit')}"]`).forEach(el => {
                if (el === selected) return;
                const g = document.createElement('div'); g.className = 'mc-group'; place(g, el.getBoundingClientRect()); document.body.append(g); groupFrames.push(g);
            });
        } else { [frame, tag, handle].forEach(e => { e.style.display = 'none'; }); }
        if (hovered && hovered !== selected && document.contains(hovered)) place(hoverFrame, hovered.getBoundingClientRect()); else hoverFrame.style.display = 'none';
    }
    setInterval(drawFrames, 250);
    addEventListener('resize', drawFrames);

    // ------------------------------------------------------------------ selection
    function current(el) {
        const cs = getComputedStyle(el);
        const n = v => (v === 'auto' || v === '' ? null : Math.round(parseFloat(v) * 10) / 10);
        return {
            left: movable(el) ? n(cs.left) ?? el.offsetLeft : null, top: movable(el) ? n(cs.top) ?? el.offsetTop : null,
            width: el.offsetWidth, height: el.offsetHeight, fontFamily: cs.fontFamily, fontSize: n(cs.fontSize), fontWeight: cs.fontWeight,
            color: cs.color, backgroundColor: cs.backgroundColor, textAlign: cs.textAlign, opacity: Number(cs.opacity), zIndex: cs.zIndex
        };
    }
    function select(el) {
        selected = el;
        drawFrames();
        if (el) send({ type: 'selected', key: el.getAttribute('data-edit'), label: labelOf(el.getAttribute('data-edit')), movable: movable(el), current: current(el) });
    }
    function listElements() {
        const seen = new Map();
        document.querySelectorAll('[data-edit]').forEach(el => {
            const k = el.getAttribute('data-edit');
            if (!seen.has(k)) seen.set(k, { key: k, label: el.getAttribute('data-edit-label') || k, movable: movable(el), count: 0, visible: false });
            const e = seen.get(k); e.count++;
            if (el.offsetWidth || el.offsetHeight) e.visible = true;
        });
        return [...seen.values()];
    }
    let lastList = '';
    function announce(force) {
        const list = listElements(), key = JSON.stringify(list);
        if (force || key !== lastList) { lastList = key; send({ type: 'elements', elements: list }); }
    }
    setInterval(() => announce(false), 1000);

    // Clicks select (they never reach the page's own buttons and links)
    addEventListener('click', e => {
        if (e.target === handle) return;
        const el = keyOf(e.target);
        e.preventDefault(); e.stopImmediatePropagation();
        if (el) select(el);
    }, true);
    addEventListener('mousemove', e => { if (!drag) { hovered = keyOf(e.target); drawFrames(); } }, true);
    ['mousedown', 'touchstart', 'submit', 'keydown'].forEach(t => addEventListener(t, e => {
        if (t === 'keydown') return;
        if (t === 'mousedown' && (e.target === handle || keyOf(e.target) === selected)) return;   // drag handled below
        e.stopImmediatePropagation();
    }, true));

    // ------------------------------------------------------------------ drag, resize, nudge
    const scaleOf = el => { const r = el.getBoundingClientRect(); return el.offsetWidth ? r.width / el.offsetWidth : 1; };
    addEventListener('pointerdown', e => {
        if (!selected || !movable(selected)) return;
        const resizing = e.target === handle;
        if (!resizing && keyOf(e.target) !== selected) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const c = current(selected);
        drag = { resizing, x: e.clientX, y: e.clientY, left: c.left, top: c.top, width: c.width, height: c.height, scale: scaleOf(selected), moved: false };
        document.documentElement.classList.add('mc-dragging');
    }, true);
    addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = (e.clientX - drag.x) / drag.scale, dy = (e.clientY - drag.y) / drag.scale;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
        drag.moved = true;
        const key = selected.getAttribute('data-edit');
        const props = drag.resizing ? { width: Math.max(4, Math.round(drag.width + dx)), height: Math.max(4, Math.round(drag.height + dy)) }
            : { left: Math.round(drag.left + dx), top: Math.round(drag.top + dy) };
        rules[key] = { ...rules[key], ...props };
        applyRules();
        send({ type: 'change', key, props, live: true });
    }, true);
    addEventListener('pointerup', () => {
        if (!drag) return;
        if (drag.moved) send({ type: 'change-end', key: selected.getAttribute('data-edit') });
        drag = null;
        document.documentElement.classList.remove('mc-dragging');
        if (selected) select(selected);
    }, true);
    addEventListener('keydown', e => {
        if (!selected || !movable(selected) || !e.key.startsWith('Arrow')) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const step = e.shiftKey ? 10 : 1, c = current(selected), key = selected.getAttribute('data-edit');
        const props = { ArrowLeft: { left: c.left - step }, ArrowRight: { left: c.left + step }, ArrowUp: { top: c.top - step }, ArrowDown: { top: c.top + step } }[e.key];
        rules[key] = { ...rules[key], ...props };
        applyRules();
        send({ type: 'change', key, props });
        send({ type: 'change-end', key });
    }, true);

    // ------------------------------------------------------------------ messages from the control panel
    addEventListener('message', e => {
        if (e.origin !== location.origin) return;
        const m = e.data || {};
        if (m.type === 'rules') { rules = m.rules || {}; applyRules(); if (selected) select(selected); }
        if (m.type === 'select') { const el = document.querySelector(`[data-edit="${m.key}"]`); if (el) select(el); }
        if (m.type === 'state') setTimeout(() => { announce(true); if (selected) { const k = selected.getAttribute('data-edit'); select(document.querySelector(`[data-edit="${k}"]`)); } }, 100);
    });

    announce(true);
    send({ type: 'ready' });
})();
