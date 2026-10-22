/* Millionaire Control - question bank, stack builder and stack slot editor */
(() => {
    'use strict';
    const { h, api, status, socket } = window.MC;
    const body = document.getElementById('bankBody');
    const DSRC = { file: 'file', manual: 'manual', ai: 'AI' };
    let filters = { q: '', status: '', difficulty: '', unrated: '', page: 1 };
    let selectedUids = new Set();

    const isAdmin = () => window.MC.me().role === 'admin';
    const diffBadge = q => q.difficulty
        ? h('span', {}, String(q.difficulty), h('span', { class: `dsrc ${q.difficultySource}` }, DSRC[q.difficultySource] || q.difficultySource))
        : h('span', { class: 'muted' }, 'not rated');
    const statusText = q => q.status === 'used'
        ? h('span', { class: 'status-used', title: `${q.usedCount}× on air` }, `used · ${q.usedRoom || ''}${q.usedGame ? ' game ' + q.usedGame : ''} · ${String(q.usedAt || '').slice(0, 16)}`)
        : q.status === 'stack' ? h('span', { class: 'status-stack' }, `in ${q.stackName || 'a stack'}`) : h('span', { class: 'muted' }, 'available');

    function modal(title, ...content) {
        const bg = h('div', { class: 'modal-bg' });
        bg.append(h('div', { class: 'modal', style: 'width:min(1180px,96vw);max-height:92vh;overflow:auto' },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, title), h('button', { onclick: () => bg.remove() }, 'Close')),
            ...content));
        document.body.append(bg);
        return bg;
    }

    // ================================================================== page
    async function open() {
        if (!window.MC.me().database) {
            body.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'The question bank needs the MySQL database.'),
                h('p', { class: 'muted' }, isAdmin() ? 'Connect it in Admin → Connections.' : 'Ask an administrator to connect it.')));
            return;
        }
        body.replaceChildren(
            h('div', { id: 'bankStats' }),
            h('div', { class: 'tools-grid', style: 'margin-top:12px' }, importCard(), generateCard(), rateCard(), buildCard(), randomCard()),
            h('div', { class: 'card', style: 'margin-top:12px' }, h('div', { id: 'bankTable' })));
        refresh();
    }

    async function refresh() { await Promise.all([renderStats(), renderTable()]); }

    async function renderStats() {
        const box = document.getElementById('bankStats');
        if (!box) return;
        let s;
        try { s = await api('GET', '/api/bank/stats'); } catch (e) { box.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
        const max = Math.max(1, ...s.availableByDifficulty);
        box.replaceChildren(h('div', { class: 'card' },
            h('div', { class: 'stats' },
                h('div', { class: 'stat' }, h('b', {}, s.total), 'questions in the bank'),
                h('div', { class: 'stat' }, h('b', {}, s.byStatus.available), 'available'),
                h('div', { class: 'stat' }, h('b', {}, s.byStatus.stack), 'in stacks'),
                h('div', { class: 'stat' }, h('b', { class: 'status-used' }, s.byStatus.used), 'used on air'),
                h('div', { class: 'stat' }, h('b', {}, s.unrated), 'without difficulty'),
                h('div', { class: 'stat' }, h('b', {}, s.possibleStacks), 'more stacks possible')),
            h('p', { class: 'muted', style: 'margin:10px 0 0' }, 'Available questions by difficulty' +
                (Object.keys(s.ratedBy).length ? `  ·  rated from: ${Object.entries(s.ratedBy).map(([k, v]) => `${DSRC[k] || k} ${v}`).join(', ')}` : '')),
            h('div', { class: 'histo' }, ...s.availableByDifficulty.map(n => h('div', { style: `height:${Math.round(n / max * 100)}%`, title: `${n} available` }, h('span', {}, n)))),
            h('div', { class: 'histo-labels' }, ...Array.from({ length: 15 }, (_, i) => h('span', {}, i + 1)))));
    }

    // ================================================================== tools
    function progressUi() {
        const msg = h('span', { class: 'muted' });
        const cancel = h('button', { class: 'hidden', onclick: () => socket.emit('bank:cancel') }, 'Cancel');
        return { msg, cancel };
    }

    function runTask(event, payload, ui, done) {
        const onProgress = t => { ui.msg.textContent = t; };
        socket.on('bank:progress', onProgress);
        ui.cancel.classList.remove('hidden');
        ui.msg.textContent = 'Starting...';
        socket.emit(event, payload, res => {
            socket.off('bank:progress', onProgress);
            ui.cancel.classList.add('hidden');
            if (res?.error) ui.msg.textContent = res.error;
            else done(res.result);
            refresh();
        });
    }

    function importCard() {
        const file = h('input', { type: 'file', accept: '.docx,.doc,.pdf,.txt,.md,.rtf,.csv,.tsv,.xlsx,.json,.xml' });
        const useAi = h('input', { type: 'checkbox' });
        const msg = h('span', { class: 'muted' });
        const go = async () => {
            if (!file.files[0]) { msg.textContent = 'Choose a file first.'; return; }
            msg.textContent = useAi.checked ? 'Reading with AI: this can take a while...' : 'Importing...';
            const form = new FormData();
            form.append('file', file.files[0]);
            try {
                const res = await fetch('/api/bank/import' + (useAi.checked ? '?ai=1' : ''), { method: 'POST', body: form });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || res.statusText);
                msg.textContent = `${d.found} found (${d.method}): ${d.added} added, ${d.duplicates} already in the bank` +
                    (d.incomplete ? `, ${d.incomplete} skipped (no correct answer or missing answers)` : '') + `. ${d.rated} with a difficulty from the file.`;
                refresh();
            } catch (e) { msg.textContent = 'Error: ' + e.message; }
        };
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, '1 · Import a file'),
            h('p', { class: 'muted', style: 'margin:0' }, 'Any size: Word, PDF, text, Excel, CSV, JSON. Duplicates are recognised; the difficulty is kept where the file states it (a Difficoltà/Livello column or line).'),
            file, h('label', {}, useAi, 'read it with AI (unusual layouts)'),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Import into the bank'), msg));
    }

    function generateCard() {
        // Every level: N questions for each of the 15 levels; One level: N questions all for one level (e.g. 10 for Q15)
        const mode = h('select', {}, h('option', { value: 'all' }, 'Every level'), h('option', { value: 'one' }, 'One level'));
        const perLevel = h('input', { type: 'number', min: 1, max: 50, value: 2, style: 'width:60px' });
        const allBox = h('span', { class: 'row' }, perLevel, 'per level (×15)');
        const count = h('input', { type: 'number', min: 1, max: 100, value: 10, style: 'width:64px' });
        const level = h('select', {}, ...Array.from({ length: 15 }, (_, i) => h('option', { value: i + 1, selected: i === 14 }, `question ${i + 1}`)));
        const oneBox = h('span', { class: 'row hidden' }, count, 'questions for', level);
        mode.addEventListener('change', () => { allBox.classList.toggle('hidden', mode.value !== 'all'); oneBox.classList.toggle('hidden', mode.value !== 'one'); });
        const language = h('input', { type: 'text', value: 'Italian', size: 12 });
        const topic = h('input', { type: 'text', placeholder: 'topic (optional)', size: 20 });
        const ui = progressUi();
        const go = () => {
            const one = mode.value === 'one';
            const opts = one ? { level: Number(level.value), count: Number(count.value) } : { perLevel: Number(perLevel.value) };
            runTask('bank:generate', { ...opts, language: language.value, topic: topic.value }, ui, r => {
                ui.msg.textContent = (r.level ? `${r.added} new question(s) for question ${r.level}` : `${r.added} new question(s)`) + ` added with ${r.engine}` +
                    (r.duplicates ? ` (${r.duplicates} duplicates ignored)` : '') + (r.level && r.added + r.duplicates < r.asked ? ` - the model wrote ${r.added + r.duplicates} of ${r.asked}` : '') + '.';
            });
        };
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, '2 · Generate with AI'),
            h('p', { class: 'muted', style: 'margin:0' }, 'New questions straight into the bank, already rated with the level they were written for. "One level" writes many questions for a single level (e.g. 10 for question 15), each on a different subject, without repeating the ones of that level already in the bank. The engine is set in Admin → Connections.'),
            h('div', { class: 'row' }, mode, allBox, oneBox, language, topic),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Generate'), ui.cancel, ui.msg));
    }

    function rateCard() {
        const includeAi = h('input', { type: 'checkbox' });
        const ui = progressUi();
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, '3 · Rate the difficulty'),
            h('p', { class: 'muted', style: 'margin:0' }, 'The AI rates the questions that have no difficulty (1-15), 40 at a time. Difficulties from files or set by hand are never changed.'),
            h('label', {}, includeAi, 'also re-rate the ones rated by AI before'),
            h('div', { class: 'row' }, h('button', {
                class: 'primary', onclick: () => runTask('bank:rate', { includeAi: includeAi.checked }, ui,
                    r => { ui.msg.textContent = `${r.rated} of ${r.total} question(s) rated.`; })
            }, 'Rate with AI'), ui.cancel, ui.msg));
    }

    function buildCard() {
        const count = h('input', { type: 'number', min: 0, value: 0, style: 'width:70px' });
        const prefix = h('input', { type: 'text', value: 'Stack', size: 12 });
        const repl = h('input', { type: 'checkbox', checked: true });
        const tol = h('select', {}, h('option', { value: 0 }, 'exact level'), h('option', { value: 1 }, '±1 level'), h('option', { value: 2 }, '±2 levels'));
        const msg = h('span', { class: 'muted' });
        const go = async () => {
            msg.textContent = 'Building...';
            try {
                const r = await api('POST', '/api/bank/build', { count: Number(count.value), prefix: prefix.value, replacements: repl.checked, maxDeviation: Number(tol.value) });
                msg.textContent = r.created.length
                    ? `${r.created.length} stack(s) created: ${r.created.map(c => c.name).join(', ')}.` + (r.shortageAtLevel ? ` Stopped: no more questions for level ${r.shortageAtLevel}.` : '')
                    : `No stack created: not enough available questions for level ${r.shortageAtLevel}.`;
                refresh();
                window.MCTools?.refreshStacks();
            } catch (e) { msg.textContent = 'Error: ' + e.message; }
        };
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, '4 · Build stacks'),
            h('p', { class: 'muted', style: 'margin:0' }, 'Stacks of 15 (level 1 to 15) from the available, rated questions, with varied subjects. Each question goes into one stack only. Rename and edit them in the Questions tab.'),
            h('div', { class: 'row' }, 'How many', count, h('span', { class: 'muted' }, '(0 = as many as possible)'), 'Name', prefix),
            h('div', { class: 'row' }, h('label', {}, repl, 'fill the replacement questions automatically'), 'Tolerance', tol),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Build stacks'), msg));
    }

    function randomCard() {
        const set = h('select', {}, h('option', { value: 'main' }, 'Main game (15 questions)'), h('option', { value: 'replacement' }, 'Replacement questions (15)'), h('option', { value: 'both' }, 'Main game + replacements'));
        const name = h('input', { type: 'text', placeholder: 'name (optional)', size: 18 });
        const tol = h('select', {}, h('option', { value: 0 }, 'exact level'), h('option', { value: 1 }, '±1 level'), h('option', { value: 2 }, '±2 levels'));
        const msg = h('span', { class: 'muted' });
        const go = async () => {
            msg.textContent = 'Picking...';
            try {
                const r = await api('POST', '/api/bank/random-stack', { set: set.value, name: name.value, maxDeviation: Number(tol.value) });
                msg.textContent = `"${r.name}" created (${r.main} main, ${r.replacements} replacement).`;
                name.value = '';
                refresh();
                window.MCTools?.refreshStacks();
                editStack(r.id);
            } catch (e) { msg.textContent = e.message; }
        };
        return h('div', { class: 'card stack' },
            h('h3', { style: 'margin:0' }, '5 · Random stack'),
            h('p', { class: 'muted', style: 'margin:0' }, 'Picks at random one available question for each difficulty level 1-15 and makes a stack of it, then opens it so you can check or change any slot.'),
            h('div', { class: 'row' }, set, name, tol),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Pick at random'), msg));
    }

    // ================================================================== table
    async function renderTable() {
        const box = document.getElementById('bankTable');
        if (!box) return;
        let data;
        try { data = await api('GET', '/api/bank/questions?' + new URLSearchParams({ ...filters, pageSize: 50 })); }
        catch (e) { box.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
        selectedUids = new Set([...selectedUids].filter(u => data.questions.some(q => q.uid === u)));

        const search = h('input', { type: 'text', placeholder: 'search text, category or Q-000123', size: 30, value: filters.q });
        let timer = null;
        search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { filters = { ...filters, q: search.value, page: 1 }; renderTable(); }, 350); });
        const sel = (key, options) => {
            const s = h('select', { onchange: e => { filters = { ...filters, [key]: e.target.value, page: 1 }; renderTable(); } }, ...options.map(([v, t]) => h('option', { value: v }, t)));
            s.value = filters[key];
            return s;
        };
        const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
        const boxes = data.questions.map(q => {
            const c = h('input', { type: 'checkbox', checked: selectedUids.has(q.uid) });
            c.addEventListener('change', () => { c.checked ? selectedUids.add(q.uid) : selectedUids.delete(q.uid); });
            return c;
        });
        const diffSelect = q => {
            const s = h('select', { title: 'Set the difficulty by hand' }, h('option', { value: '' }, '-'), ...Array.from({ length: 15 }, (_, i) => h('option', { value: i + 1 }, i + 1)));
            s.value = q.difficulty ?? '';
            s.addEventListener('change', async () => { await api('PUT', `/api/bank/questions/${q.uid}`, { difficulty: s.value === '' ? null : Number(s.value) }); refresh(); });
            return s;
        };
        const bulk = async (label, url, extra = {}) => {
            if (!selectedUids.size) { status('Tick some questions first.', true); return; }
            if (!confirm(`${label}: ${selectedUids.size} question(s)?`)) return;
            try { await api('POST', url, { uids: [...selectedUids], ...extra }); selectedUids.clear(); refresh(); window.MCTools?.refreshStacks(); }
            catch (e) { status(e.message, true); }
        };

        box.replaceChildren(
            h('div', { class: 'row' }, search,
                sel('status', [['', 'All'], ['available', 'Available'], ['stack', 'In a stack'], ['used', 'Used on air']]),
                sel('difficulty', [['', 'Any difficulty'], ...Array.from({ length: 15 }, (_, i) => [String(i + 1), `Level ${i + 1}`])]),
                sel('unrated', [['', 'Rated or not'], ['1', 'Not rated only']]),
                h('span', { class: 'muted' }, `${data.total} question(s)`)),
            h('div', { class: 'row', style: 'margin:8px 0' },
                h('button', { onclick: () => { data.questions.forEach((q, i) => { selectedUids.add(q.uid); boxes[i].checked = true; }); } }, 'Tick this page'),
                h('button', { onclick: () => bulk('Take out of their stack', '/api/bank/release') }, 'Take out of stack'),
                isAdmin() ? h('button', { onclick: () => bulk('Mark as not used (available again)', '/api/bank/release', { clearUsed: true }) }, 'Mark as not used') : '',
                isAdmin() ? h('button', { class: 'danger', onclick: () => bulk('Delete from the bank', '/api/bank/delete') }, 'Delete') : ''),
            h('div', { style: 'max-height:60vh;overflow:auto' }, h('table', { class: 'grid' },
                h('thead', {}, h('tr', {}, ...['', 'ID', 'Difficulty', 'Category', 'Question', 'Correct answer', 'Status', ''].map(t => h('th', {}, t)))),
                h('tbody', {}, ...data.questions.map((q, i) => h('tr', {},
                    h('td', {}, boxes[i]), h('td', { style: 'white-space:nowrap' }, h('code', {}, q.uid)),
                    h('td', { style: 'white-space:nowrap' }, diffSelect(q), q.difficultySource ? h('span', { class: `dsrc ${q.difficultySource}` }, DSRC[q.difficultySource]) : ''),
                    h('td', {}, q.category),
                    h('td', { title: q.answers.map((a, k) => `${'ABCD'[k]}: ${a}`).join('\n') }, q.text),
                    h('td', {}, `${'ABCD'[q.correct]}: ${q.answers[q.correct] ?? ''}`),
                    h('td', {}, statusText(q)),
                    h('td', {}, h('button', { onclick: () => editQuestion(q.uid) }, 'Edit'))))))),
            h('div', { class: 'row', style: 'margin-top:8px' },
                h('button', { disabled: filters.page <= 1, onclick: () => { filters.page--; renderTable(); } }, '◀'),
                h('span', {}, `page ${filters.page} of ${pages}`),
                h('button', { disabled: filters.page >= pages, onclick: () => { filters.page++; renderTable(); } }, '▶')));
    }

    async function editQuestion(uid) {
        const q = await api('GET', `/api/bank/questions/${uid}`);
        const text = h('textarea', { rows: 3, style: 'width:100%' }); text.value = q.text;
        const answers = q.answers.map(a => h('input', { type: 'text', value: a, style: 'width:100%' }));
        const correct = h('select', {}, ...'ABCD'.split('').map((l, i) => h('option', { value: i }, l))); correct.value = q.correct;
        const category = h('input', { type: 'text', value: q.category });
        const comment = h('textarea', { rows: 2, style: 'width:100%' }); comment.value = q.comment;
        const difficulty = h('select', {}, h('option', { value: '' }, 'not rated'), ...Array.from({ length: 15 }, (_, i) => h('option', { value: i + 1 }, i + 1)));
        difficulty.value = q.difficulty ?? '';
        const msg = h('span', { class: 'muted' });
        const bg = modal(`${q.uid} · ${q.status === 'used' ? 'used on air' : q.status === 'stack' ? 'in ' + q.stackName : 'available'}`,
            h('div', { class: 'form-grid', style: 'grid-template-columns:140px 1fr' },
                h('span', {}, 'Question'), text,
                ...answers.flatMap((a, i) => [h('span', {}, 'ABCD'[i]), a]),
                h('span', {}, 'Correct'), correct, h('span', {}, 'Category'), category, h('span', {}, 'Host comment'), comment,
                h('span', {}, 'Difficulty'), h('span', { class: 'row' }, difficulty, q.difficultySource ? h('span', { class: `dsrc ${q.difficultySource}` }, `now: ${DSRC[q.difficultySource]}`) : '')),
            h('p', { class: 'muted' }, `Source: ${q.source}${q.sourceRef ? ' · ' + q.sourceRef : ''} · added ${String(q.createdAt).slice(0, 16)}${q.createdBy ? ' by ' + q.createdBy : ''}` +
                (q.usedCount ? ` · on air ${q.usedCount}× (last: ${q.usedRoom}, ${String(q.usedAt).slice(0, 16)})` : '')),
            h('div', { class: 'row' }, h('button', {
                class: 'primary', onclick: async () => {
                    try {
                        const patch = { text: text.value, answers: answers.map(a => a.value), correct: Number(correct.value), category: category.value, comment: comment.value };
                        if (String(difficulty.value) !== String(q.difficulty ?? '')) patch.difficulty = difficulty.value === '' ? null : Number(difficulty.value);
                        await api('PUT', `/api/bank/questions/${uid}`, patch);
                        bg.remove(); refresh();
                    } catch (e) { msg.textContent = e.message; }
                }
            }, 'Save'), msg));
        const source = h('input', { type: 'url', value: q.editorial?.sourceUrl || '', placeholder: 'Verifiable HTTPS source' });
        const review = value => async () => {
            try { const result = await api('POST', `/api/bank/questions/${uid}/review`, { status: value, sourceUrl: source.value }); msg.textContent = 'Saved question: ' + result.status; }
            catch (e) { msg.textContent = e.message; }
        };
        bg.querySelector('.modal').append(h('div', { class: 'card stack' }, h('strong', {}, 'Editorial review of the saved version: ' + (q.editorial?.status || 'draft')), h('p', {}, 'Save content changes before reviewing. Any change requires new verification and approval.'), source,
            h('div', { class: 'row' }, h('button', { onclick: review('verified') }, 'Verify'), h('button', { onclick: review('approved') }, 'Approve (admin)'))));
    }

    // ================================================================== stack slot editor
    async function editStack(id) {
        const content = h('div');
        const bg = modal('Stack', content);
        const title = bg.querySelector('h2');
        const render = async () => {
            const st = await api('GET', `/api/stacks/${id}`);
            title.textContent = `${st.name}  ·  ${st.kind === 'builder' ? 'built from the bank' : st.source}`;
            const row = (set, i, q) => h('tr', {},
                h('td', {}, set === 'main' ? `Q${i + 1}` : `R${i + 1}`),
                h('td', { style: 'white-space:nowrap' }, q.uid ? h('code', {}, q.uid) : h('span', { class: 'muted' }, 'empty')),
                h('td', {}, q.text ? diffBadge(q) : ''),
                h('td', {}, q.category || ''),
                h('td', {}, q.text || '', q.bankStatus === 'used' ? h('span', { class: 'status-used' }, '  (already used on air)') : ''),
                h('td', {}, q.text ? `${'ABCD'[q.correct]}: ${q.answers[q.correct]}` : ''),
                h('td', { style: 'white-space:nowrap' },
                    h('button', { onclick: () => pick(id, set, i + 1, render) }, 'Change...'),
                    h('button', { onclick: async () => { try { await api('POST', `/api/stacks/${id}/slot`, { set, level: i + 1, auto: true }); render(); } catch (e) { status(e.message, true); } } }, 'Auto'),
                    q.uid ? h('button', { onclick: async () => { await api('POST', `/api/stacks/${id}/slot`, { set, level: i + 1, uid: null }); render(); } }, 'Empty') : ''));
            content.replaceChildren(
                h('p', { class: 'muted', style: 'margin:0' }, '"Change" picks a question from the bank (same difficulty first), "Auto" chooses one for you, "Empty" puts the question back in the bank as available.'),
                h('table', { class: 'grid' },
                    h('thead', {}, h('tr', {}, ...['Slot', 'ID', 'Difficulty', 'Category', 'Question', 'Correct answer', ''].map(t => h('th', {}, t)))),
                    h('tbody', {},
                        ...st.main.map((q, i) => row('main', i, q)),
                        h('tr', {}, h('td', { colspan: 7, style: 'background:var(--hover);font-weight:700' }, 'Replacement questions (Switch the Question)')),
                        ...st.sw.map((q, i) => row('replacement', i, q)))));
            window.MCTools?.refreshStacks();
        };
        render();
    }

    async function pick(stackId, set, level, done) {
        const search = h('input', { type: 'text', placeholder: 'search', size: 24 });
        const list = h('div');
        const bg = modal(`Choose a question for ${set === 'main' ? 'question' : 'replacement'} ${level}`, h('div', { class: 'row' }, search), list);
        const load = async () => {
            const items = await api('GET', `/api/bank/candidates?${new URLSearchParams({ level, q: search.value })}`);
            list.replaceChildren(items.length ? h('table', { class: 'grid' },
                h('thead', {}, h('tr', {}, ...['ID', 'Difficulty', 'Category', 'Question', 'Correct answer', ''].map(t => h('th', {}, t)))),
                h('tbody', {}, ...items.map(q => h('tr', {},
                    h('td', {}, h('code', {}, q.uid)), h('td', {}, diffBadge(q)), h('td', {}, q.category), h('td', {}, q.text),
                    h('td', {}, `${'ABCD'[q.correct]}: ${q.answers[q.correct]}`),
                    h('td', {}, h('button', { class: 'primary', onclick: async () => { try { await api('POST', `/api/stacks/${stackId}/slot`, { set, level, uid: q.uid }); bg.remove(); done(); } catch (e) { status(e.message, true); } } }, 'Use')))))) :
                h('p', { class: 'muted' }, 'No available question: import or generate more in the Question bank.'));
        };
        let t = null;
        search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
        load();
    }

    window.MCBank = { open, editStack };
})();
