/* Host and player screens: rendered from what the server sends (the player never receives hidden data). */
(() => {
    'use strict';
    // /host/<show>, /player/<show>, or /layout-preview/<host|player>?room=<show> (Layout editor, sample data)
    const parts = location.pathname.split('/');
    const preview = parts[1] === 'layout-preview';
    const kind = preview ? parts[2] : parts[1];
    const room = preview ? (new URLSearchParams(location.search).get('room') || '') : decodeURIComponent(parts[2] || '');
    const $ = s => document.querySelector(s);
    const stage = $('#stage');
    document.body.classList.add(kind === 'host' ? 'host' : 'player');
    const bgOption = (location.search.match(/[?&]bg=(transparent|black)/) || [])[1];
    const inObs = typeof window.obsstudio !== 'undefined' || /OBS/i.test(navigator.userAgent);
    if (bgOption ? bgOption === 'transparent' : inObs) document.documentElement.classList.add('transparent');
    document.title = (kind === 'host' ? 'Host screen' : 'Player screen');

    // ------------------------------------------------------------------ Conduit ITC from the show's theme
    (() => {
        const base = `/screen-font/${encodeURIComponent(room)}/`;
        const files = [['Conduit.woff', 'woff'], ['Conduit.ttf', 'truetype'], ['ITC%20Conduit.ttf', 'truetype'], ['ConduitITCPro-Medium.ttf', 'truetype'], ['Conduit.otf', 'opentype']];
        const style = document.createElement('style');
        style.textContent = `@font-face { font-family: "MCConduit"; font-display: swap; src: local("Conduit ITC"), local("ConduitITC"), local("ITC Conduit"), ${files.map(([f, t]) => `url("${base}${f}") format("${t}")`).join(', ')}; }`;
        document.head.append(style);
    })();

    // ------------------------------------------------------------------ fit the overlays and texts to the lozenge picture
    /**
     * Measures the question/answers picture actually in use (whatever its design): the three connecting lines,
     * the tips of every lozenge, their height and the slant of their tips. The orange/green overlays, the answer
     * texts and the question are then placed on those lozenges. If the picture cannot be measured, the built-in
     * positions stay. Lines and borders are recognised as bright blue-dominant pixels (cyan, light blue...).
     */
    function fitToLozenges() {
        const qa = $('#qa');
        const m = (getComputedStyle(qa).backgroundImage || '').match(/url\(["']?([^"')]+)/);
        if (!m) return;
        const img = new Image();
        img.onload = () => {
            try {
                const W = img.naturalWidth, H = img.naturalHeight;
                const c = document.createElement('canvas'); c.width = W; c.height = H;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                const d = ctx.getImageData(0, 0, W, H).data;
                const blue = (x, y) => { const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2]; return b > 110 && b >= r + 25 && (0.3 * r + 0.59 * g + 0.11 * b) > 70; };
                // 1) the three connecting lines, at the far left of the picture
                const strip = Math.max(6, Math.round(W * 0.03)), rows = [];
                for (let y = 0; y < H; y++) { let n = 0; for (let x = 2; x < strip; x++) if (blue(x, y)) n++; if (n >= (strip - 2) * 0.7) rows.push(y); }
                const groups = [];
                for (const y of rows) { const g = groups[groups.length - 1]; if (g && y - g[g.length - 1] <= 3) g.push(y); else groups.push([y]); }
                const centers = groups.map(g => Math.round((g[0] + g[g.length - 1]) / 2));
                if (centers.length !== 3) return;
                const runs = y => { const out = []; let s = null; for (let x = 0; x < W; x++) { const b = blue(x, y); if (b && s === null) s = x; if (!b && s !== null) { out.push([s, x - 1]); s = null; } } if (s !== null) out.push([s, W - 1]); return out; };
                const vext = (x, yc) => { let up = yc, dn = yc; while (up > 0 && !blue(x, up)) up--; while (dn < H - 1 && !blue(x, dn)) dn++; return [up, dn]; };
                const slant = (x1, x2, top) => { for (let x = x1; x < x1 + (x2 - x1) / 3; x++) if (blue(x, Math.min(H - 1, top + 2))) return (x - x1) / (x2 - x1); return 0.075; };
                const sx = 1920 / W, sy = 432 / H;
                const place = (el, x1, x2, y1, y2) => Object.assign(el.style, { left: `${x1 * sx}px`, width: `${(x2 - x1) * sx}px`, top: `${y1 * sy}px`, height: `${(y2 - y1 + 1) * sy}px` });
                // 2) the question lozenge
                const rq = runs(centers[0]);
                if (rq.length >= 2) {
                    const x1 = rq[0][1], x2 = rq[rq.length - 1][0], [y1, y2] = vext(Math.round((x1 + x2) / 2), centers[0]);
                    const w = x2 - x1, h = y2 - y1;
                    place($('#question'), x1 + w * 0.07, x2 - w * 0.07, y1 + h * 0.1, y2 - h * 0.1);
                }
                // 3) the answer lozenges: [left tip, junction] and [junction, right tip] on each row
                [['A', 'B', centers[1]], ['C', 'D', centers[2]]].forEach(([L, R, yc]) => {
                    const r = runs(yc);
                    const mid = r.slice(1, -1).filter(t => Math.abs((t[0] + t[1]) / 2 - W / 2) < W * 0.12);
                    if (r.length < 2 || !mid.length) return;
                    const left = [r[0][1], Math.min(...mid.map(t => t[0]))], right = [Math.max(...mid.map(t => t[1])), r[r.length - 1][0]];
                    [[L, left], [R, right]].forEach(([letter, [x1, x2]]) => {
                        const [y1, y2] = vext(Math.round((x1 + x2) / 2), yc);
                        const el = $('#ans' + letter), w = x2 - x1;
                        place(el, x1, x2, y1, y2);
                        el.querySelector('.over').style.setProperty('--slant', `${(slant(x1, x2, y1) * 100).toFixed(2)}%`);
                        const txt = el.querySelector('.txt');
                        Object.assign(txt.style, { left: `${w * 0.155 * sx}px`, width: `${w * 0.78 * sx}px` });
                    });
                });
                document.documentElement.setAttribute('data-lozenges', 'measured');
            } catch { /* keep the built-in positions */ }
        };
        img.src = m[1];
    }
    fitToLozenges();

    const ICONS = { ff: ['5050', '5050X'], paf: ['PAF', 'PAFX'], ata: ['ATA', 'ATAX'], stq: ['SWI', 'SWIX'], dd: ['DDP', 'DDPX'], ate: ['TWM', 'TWMX'] };
    const IDS = ['ff', 'paf', 'ata', 'stq', 'dd', 'ate'];

    // ------------------------------------------------------------------ scale the 1920x1080 stage to the window
    function fit() {
        const s = Math.min(innerWidth / 1920, innerHeight / 1080);
        stage.style.transform = `scale(${s})`;
        stage.style.left = Math.max(0, (innerWidth - 1920 * s) / 2) + 'px';
        stage.style.top = Math.max(0, (innerHeight - 1080 * s) / 2) + 'px';
    }
    addEventListener('resize', fit);
    fit();

    /** Shrinks the text until it fits its box (long questions and amounts). */
    function fitText(el, max, min) {
        let size = max;
        el.style.fontSize = size + 'px';
        while (size > min && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
            size -= 2;
            el.style.fontSize = size + 'px';
        }
    }

    // ------------------------------------------------------------------ rendering
    function renderQuestion(p) {
        const q = p.question;
        const box = $('#question');
        box.replaceChildren();
        if (q) {
            box.textContent = q.text;
        } else if (p.winnings?.value) {
            // No question on screen: the contestant's current winnings, labelled with the theme's own text
            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = p.winnings.label;
            box.append(label, document.createTextNode(p.winnings.value));
        }
        box.style.display = 'flex';
        box.style.flexDirection = q ? 'row' : 'column';
        fitText(box, q ? 52 : 50, 26);

        'ABCD'.split('').forEach((L, i) => {
            const el = $('#ans' + L);
            const letter = L.toLowerCase();
            // Both screens show an answer only when it appears on the game output
            const shown = !!q && q.shown[i];
            const txt = el.querySelector('.txt');
            txt.textContent = shown && q ? q.answers[i] : '';
            fitText(txt, 44, 22);
            const revealed = !!q && q.revealed === letter;
            const locked = !!q && q.locked === letter && !revealed;
            el.classList.toggle('locked', locked);
            el.classList.toggle('revealed', revealed);
            el.querySelector('.over').style.backgroundImage = `url(/static/screens/QLoz${L}${revealed ? 'Ans' : 'Sel'}.jpg)`;
        });
    }

    function renderBoxes(p) {
        const b = p.boxes;
        const set = (id, text) => { const s = $(id + ' span'); s.textContent = text ?? ''; fitText(s, 46, 22); };
        set('#boxAway', b ? `Away:${b.away}` : '');
        set('#boxCash', b?.cash);
        set('#boxTick', b?.tick);
        set('#boxCross', b?.cross);
        set('#boxDrop', b?.drop);
        // Correct answer, only once the final answer is locked: green if right, red with the correct letter if wrong
        const box = $('#boxAnswer');
        const f = p.finalAnswer;
        box.hidden = !f;
        box.classList.toggle('right', !!f?.right);
        box.classList.toggle('wrong', !!f && !f.right);
        box.textContent = f && !f.right ? f.correct.toUpperCase() : '';
    }

    function renderTree(p) {
        const l = p.lifelines;
        const order = (l.order?.length ? l.order : ['ff', 'dd', 'paf', 'ata', 'stq']).filter(id => {
            const i = IDS.indexOf(id);
            if (i < 0 || l.supported?.[i] === false) return false;
            if (id === 'ate') return !!l.stqReplacedByAte;
            if (id === 'stq') return !l.stqReplacedByAte;
            return id === 'dd' ? l.ffReplacedByDd : !(id === 'ff' && l.ffReplacedByDd);
        });
        $('#lifelines').replaceChildren(...order.map(id => {
            const img = document.createElement('img');
            img.src = `/static/screens/${ICONS[id][l.used?.[IDS.indexOf(id)] ? 1 : 0]}.jpg`;
            img.alt = id;
            return img;
        }));

        const rows = p.tree?.rows;
        const count = rows?.length || p.prizes.length || 15;
        const levels = [];
        for (let level = count; level >= 1; level--) {
            const div = document.createElement('div');
            div.className = 'lvl';
            if (level % 5 === 0) div.classList.add('milestone');
            if (p.tree && level === p.tree.highlight) div.classList.add('hl');
            if (level === p.level) div.classList.add('playing');
            const n = document.createElement('span'); n.className = 'n'; n.textContent = level;
            const a = document.createElement('span'); a.textContent = rows?.[level - 1]?.t ?? p.prizes[level - 1] ?? '';
            div.append(n, a);
            levels.push(div);
        }
        $('#levels').replaceChildren(...levels);
    }

    function renderLifeline(p) {
        const box = $('#lifeline');
        const l = p.lifeline;
        box.hidden = !l;
        if (kind === 'host') $('#comment').hidden = !!l;   // the results / clock take the comment area while on air
        if (!l) return;
        if (l.kind === 'ata') {
            box.replaceChildren(...l.rows.map(r => {
                const row = document.createElement('div');
                row.className = 'ata-row' + (r.out ? ' out' : '');
                const letter = document.createElement('b'); letter.textContent = r.letter;
                const answer = document.createElement('span'); answer.textContent = r.out ? '' : r.answer;
                const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = r.out ? '-' : `${r.percent}%`;
                row.append(letter, answer, pct);
                return row;
            }));
        } else if (l.kind === 'paf') {
            const wrap = document.createElement('div'); wrap.className = 'paf';
            const label = document.createElement('span'); label.className = 'label'; label.textContent = 'PHONE A FRIEND';
            const secs = document.createElement('span'); secs.className = 'secs' + (Number(l.seconds) <= 5 ? ' low' : ''); secs.textContent = l.seconds;
            wrap.append(label, secs);
            box.replaceChildren(wrap);
        }
    }

    /** Clocked 2009: seconds left (gold m:ss clock at question 15), TIME UP, and the banked time. */
    function renderClock(p) {
        const box = $('#clock');
        const c = p.clock;
        box.hidden = !c;
        if (!c) return;
        box.querySelector('.secs').textContent = c.timeUp ? 'TIME UP' : (c.text || (c.seconds ?? ''));
        box.querySelector('.banked').innerHTML = '';
        if (c.banked && !c.gold) {
            const l1 = document.createElement('div'); l1.textContent = 'BANKED';
            const l2 = document.createElement('div'); l2.textContent = c.banked;
            box.querySelector('.banked').append(l1, l2);
        }
        box.classList.toggle('gold', !!c.gold);
        box.classList.toggle('timeup', !!c.timeUp);
        box.classList.toggle('stopped', !c.running && !c.timeUp);
        box.classList.toggle('low', !c.timeUp && c.running && typeof c.seconds === 'number' && c.seconds <= 5);
    }

    function renderMessage(p) {
        const box = $('#message');
        box.hidden = !p.message;
        const text = box.querySelector('.text');
        if (p.message && text.textContent !== p.message.text) {
            text.textContent = p.message.text;
            box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';   // replay the entrance for a new message
            fitText(text, 40, 22);
        }
    }

    function renderBottom(p) {
        const c = p.contestant || {};
        const name = [c.first, c.last].filter(Boolean).join(' ');
        $('#contestant').textContent = [name, c.location].filter(Boolean).join(' - ');
        fitText($('#contestant'), 50, 24);
        if (kind === 'host') {
            const box = $('#comment');
            box.replaceChildren();
            if (p.comment || p.category) {
                if (p.category) { const cat = document.createElement('span'); cat.className = 'category'; cat.textContent = p.category; box.append(cat); }
                box.append(document.createTextNode(p.comment || ''));
            }
            fitText(box, 38, 20);
        }
    }

    function render(p) {
        renderQuestion(p);
        if (kind === 'host') renderBoxes(p);
        renderTree(p);
        renderBottom(p);
        renderLifeline(p);
        renderClock(p);
        if (kind === 'host') renderMessage(p);
    }

    // ------------------------------------------------------------------ layout (Layout editor)
    const applyLayout = css => { $('#mc-layout').textContent = css || ''; };

    // ------------------------------------------------------------------ preview for the Layout editor: sample data, no show
    if (preview) {
        const amounts = ['100 €', '200 €', '300 €', '500 €', '1.000 €', '2.000 €', '4.000 €', '8.000 €', '16.000 €', '32.000 €', '64.000 €', '125.000 €', '250.000 €', '500.000 €', '1 MILIONE €'];
        const sample = state => ({
            kind, show: 'Preview', connected: true, level: 8, prizes: amounts,
            question: state === 'idle' || state === 'walk' ? null : {
                text: 'Which planet of the solar system is known as the Red Planet?', answers: ['Venus', 'Mars', 'Jupiter', 'Saturn'],
                shown: [true, true, true, true], locked: ['locked', 'correct'].includes(state) ? 'b' : '', correct: state === 'correct' ? 'b' : '', revealed: state === 'correct' ? 'b' : ''
            },
            tree: { rows: amounts.map(t => ({ t })), highlight: 7 },
            lifelines: { order: ['ff', 'paf', 'ata', 'stq'], supported: [true, true, true, true, false, false], used: [false, true, false, false] },
            contestant: { first: 'Mattia', last: 'Rozzi', location: 'Milano' },
            winnings: state === 'walk' ? { label: 'TOTAL PRIZE WON', value: '8.000 €' } : null,
            lifeline: state === 'ata' ? { kind: 'ata', rows: ['Venus', 'Mars', 'Jupiter', 'Saturn'].map((a, i) => ({ letter: 'ABCD'[i], answer: a, percent: [8, 71, 13, 8][i], out: false })) }
                : state === 'paf' ? { kind: 'paf', seconds: '23' } : null,
            clock: { text: '27', seconds: 27, running: true, gold: false, timeUp: false, banked: '1:05' },
            message: { text: 'Commercial break in 2 minutes', by: 'control', at: '' },
            comment: 'Mars looks red because of the iron oxide on its surface.', category: 'Space',
            boxes: { away: 8, cash: '4.000 €', tick: '8.000 €', cross: '1.000 €', drop: '3.000 €' },
            finalAnswer: ['locked', 'correct'].includes(state) ? { correct: 'b', right: true } : null
        });
        render(sample(new URLSearchParams(location.search).get('state') || 'game'));
        addEventListener('message', e => {
            if (e.origin !== location.origin) return;
            if (e.data?.type === 'state') render(sample(e.data.state));
        });
        const editor = document.createElement('script');
        editor.src = '/static/layout-edit.js' + (document.currentScript?.src.match(/\?v=[^&]+/)?.[0] ?? '');
        document.body.append(editor);
        return;
    }

    // ------------------------------------------------------------------ connection
    const socket = io({ query: { role: 'screen', room, kind } });
    let lastPayload = null;
    socket.on('screen', p => { lastPayload = p; render(p); });
    socket.on('layout', applyLayout);

    // ------------------------------------------------------------------ player: the contestant enters their name
    // The button appears when the mouse moves or the screen is touched and hides again after a few seconds; never in OBS
    // (transparent capture) or with ?noedit=1.
    if (kind === 'player' && !document.documentElement.classList.contains('transparent') && !/[?&]noedit=1/.test(location.search)) {
        const button = $('#nameButton'), overlay = $('#nameForm'), form = overlay.querySelector('form'), msg = overlay.querySelector('.msg');
        const field = n => form.querySelector(`[name="${n}"]`);
        button.hidden = false;
        let hideTimer = null;
        const wake = () => {
            if (!overlay.hidden) return;
            button.classList.add('show');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => button.classList.remove('show'), 4000);
        };
        ['mousemove', 'touchstart', 'keydown'].forEach(t => addEventListener(t, wake, { passive: true }));
        const close = () => { overlay.hidden = true; };
        button.addEventListener('click', () => {
            const c = lastPayload?.contestant || {};
            field('first').value = c.first || ''; field('last').value = c.last || ''; field('location').value = c.location || '';
            msg.textContent = '';
            overlay.hidden = false;
            button.classList.remove('show');
            field('first').focus();
        });
        overlay.querySelector('[data-close]').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        form.addEventListener('submit', e => {
            e.preventDefault();
            msg.textContent = 'Saving...';
            socket.emit('contestant', { first: field('first').value, last: field('last').value, location: field('location').value }, res => {
                if (res?.error) { msg.textContent = res.error; return; }
                msg.textContent = 'Saved!';
                setTimeout(close, 700);
            });
        });
    }
    socket.on('fatal', message => {
        if (String(message).includes('Sign in with Discord')) location.replace(`/account?room=${encodeURIComponent(room)}&next=${encodeURIComponent(location.pathname)}`);
        else { $('#offline').textContent = String(message || 'Access denied. Open the screen link again.'); $('#offline').classList.add('on'); }
    });
    socket.on('ended', () => { $('#offline').textContent = 'This show has ended.'; $('#offline').classList.add('on'); });
    socket.on('disconnect', () => $('#offline').classList.add('on'));
    socket.on('connect', () => $('#offline').classList.remove('on'));
})();
