/* Millionaire Control - question builder import, AI generator, money tree settings */
(() => {
    'use strict';
    const { h, api, status, socket } = window.MC;
    const LEVELS = 15;
    const oneLine = s => String(s || '').replace(/\s*\n\s*/g, ' ');
    const clone = q => ({ category: q.category, text: q.text, answers: [...q.answers], correct: q.correct, comment: q.comment || '', uid: q.uid || '' });

    function modal(title, ...content) {
        const bg = h('div', { class: 'modal-bg' });
        const box = h('div', { class: 'modal', style: 'width:min(1180px,96vw);max-height:92vh;overflow:auto' },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, title),
                h('button', { onclick: () => bg.remove() }, 'Close')),
            ...content);
        bg.append(box);
        document.body.append(bg);
        return bg;
    }
    // A labelled field: the label lines up with the field (top), a hint goes in small print under the field
    const field = (label, control, hint) => h('label', { class: 'mc-field' },
        h('span', { class: 'mc-field-label' }, label),
        hint ? h('span', { class: 'mc-field-control' }, control, h('small', { class: 'muted' }, hint)) : h('span', { class: 'mc-field-control' }, control));

    function questionTable(rows) {
        return h('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' },
            h('thead', {}, h('tr', {}, ...rows.head.map(t => h('th', { style: 'text-align:left;border-bottom:1px solid var(--line);padding:4px' }, t)))),
            h('tbody', {}, ...rows.body.map(r => h('tr', { style: r.style || '' }, ...r.cells.map(c => h('td', { style: 'border-bottom:1px solid #eef0f5;padding:4px;vertical-align:top' }, c))))));
    }

    // ================================================================== question builder
    async function builderImport() {
        const room = window.MC.room();
        if (!room) return status('Choose a show first.', true);
        const settings = await api('GET', '/api/settings');
        const msg = h('span', { class: 'muted' });
        const setSelect = h('select');
        const preview = h('div');
        const saveStack = h('input', { type: 'checkbox', checked: window.MC.me().database, disabled: !window.MC.me().database });
        const actions = h('div', { class: 'row hidden' });
        let sets = [];

        const showSet = () => {
            const s = sets[setSelect.selectedIndex];
            if (!s) return;
            const body = [];
            for (let i = 0; i < LEVELS; i++) {
                for (const [list, label] of [[s.main, 'Main'], [s.sw, 'Replacement']]) {
                    const q = list[i];
                    if (!q.text) continue;
                    body.push({ cells: [i + 1, label, q.category, oneLine(q.text), ...q.answers.map((a, k) => k === q.correct ? h('b', {}, a) : a), q.comment || ''] });
                }
            }
            preview.replaceChildren(h('p', { class: 'muted' }, `${s.count} question(s)` + (s.invalid ? ` - ${s.invalid} incomplete (missing answers or correct answer): check them after importing` : '')),
                questionTable({ head: ['Level', 'Set', 'Category', 'Question', 'A', 'B', 'C', 'D', 'Host comment'], body }));
        };

        const load = async () => {
            msg.textContent = 'Loading from the question builder...';
            try {
                const data = await api('POST', '/api/builder/fetch', {});
                sets = data.sets;
                if (!sets.length) { msg.textContent = `Loaded ${data.url}, but no questions were recognised. Send the builder's JSON format to adapt the import.`; actions.classList.add('hidden'); preview.replaceChildren(); return; }
                setSelect.replaceChildren(...sets.map((s, i) => h('option', { value: i }, `${s.name} (${s.count})`)));
                msg.textContent = `Loaded ${data.url}: ${sets.length} set(s).`;
                actions.classList.remove('hidden');
                showSet();
            } catch (e) { msg.textContent = 'Error: ' + e.message; }
        };
        setSelect.addEventListener('change', showSet);

        const apply = async parts => {
            const s = sets[setSelect.selectedIndex];
            const r = window.MC.room();
            if (!s || !r) return;
            if (!confirm(`Replace the ${parts === 'both' ? 'main and replacement' : parts} questions of "${r.name}" with "${s.name}"?`)) return;
            const main = parts === 'replacement' ? r.questions.main.map(clone) : s.main.map(clone);
            const sw = parts === 'main' ? r.questions.sw.map(clone) : s.sw.map(clone);
            window.MC.applyQuestions(main, sw);
            if (saveStack.checked) {
                try { await api('POST', '/api/stacks', { name: `Builder · ${s.name}`, source: 'builder', roomId: r.id, main: s.main, sw: s.sw }); refreshStacks(); }
                catch (e) { status('Imported, but not saved as a stack: ' + e.message, true); }
            }
            status(`Imported "${s.name}" from the question builder and sent to the game.`);
            bg.remove();
        };
        actions.append(h('strong', {}, 'Import into this show:'),
            h('button', { class: 'primary', onclick: () => apply('both') }, 'Main + replacement'),
            h('button', { onclick: () => apply('main') }, 'Main only'),
            h('button', { onclick: () => apply('replacement') }, 'Replacement only'),
            h('label', {}, saveStack, 'also save it as a stack'));

        const bg = modal('Import from the question builder',
            h('p', { class: 'muted', style: 'margin:0' }, `Builder: ${settings.builder.baseUrl || '(not set)'}${settings.builder.path || ''}  ·  address and path are set in Admin → Connections.`),
            h('div', { class: 'row' }, h('button', { class: 'primary', onclick: load }, 'Load'), msg),
            h('div', { class: 'row' }, h('strong', {}, 'Set'), setSelect),
            actions, preview);
        if (settings.builder.baseUrl && settings.builder.path) load();
    }

    // ================================================================== AI generator
    async function aiGenerator() {
        const room = window.MC.room();
        if (!room) return status('Choose a show first.', true);
        const s = (await api('GET', '/api/settings')).ai;
        const engine = s.provider === 'ollama' ? `Ollama · ${s.ollamaModel || '(no model chosen)'} · ${s.ollamaUrl}` : `Google Gemini · ${s.geminiModel}${s.hasGeminiKey ? '' : ' · no API key yet'}`;

        const from = h('input', { type: 'number', min: 1, max: 15, value: 1, style: 'width:60px' });
        const to = h('input', { type: 'number', min: 1, max: 15, value: 15, style: 'width:60px' });
        const main = h('input', { type: 'checkbox', checked: true }), repl = h('input', { type: 'checkbox' });
        const onlyEmpty = h('input', { type: 'checkbox' }), shuffle = h('input', { type: 'checkbox', checked: true });
        const language = h('input', { type: 'text', value: s.language, list: 'aiLanguages', size: 16 });
        const languages = h('datalist', { id: 'aiLanguages' }, ...['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese'].map(l => h('option', { value: l })));
        const topic = h('input', { type: 'text', value: s.topic, size: 40, placeholder: 'General knowledge (leave empty for a mix)' });
        const extra = h('textarea', { rows: 2, style: 'width:100%', placeholder: 'e.g. questions about Italy, no sport, family-friendly...' });
        extra.value = s.extra || '';
        const msg = h('span', { class: 'muted' });
        const results = h('div');

        let generated = [];
        const generateButton = h('button', { class: 'primary' }, 'Generate');
        const cancelButton = h('button', { disabled: true, onclick: () => socket.emit('ai:cancel') }, 'Cancel');
        const onProgress = text => { msg.textContent = text; };

        generateButton.addEventListener('click', () => {
            generateButton.disabled = true; cancelButton.disabled = false;
            msg.textContent = 'Starting...';
            socket.on('ai:progress', onProgress);
            socket.emit('ai:generate', {
                from: Number(from.value), to: Number(to.value), main: main.checked, replacement: repl.checked,
                onlyEmpty: onlyEmpty.checked, shuffle: shuffle.checked, language: language.value, topic: topic.value, extra: extra.value
            }, res => {
                socket.off('ai:progress', onProgress);
                generateButton.disabled = false; cancelButton.disabled = true;
                if (res?.error) { msg.textContent = res.error; return; }
                generated = res.results;
                msg.textContent = generated.length
                    ? `${generated.length} question(s) generated${res.stackId ? ` and saved as stack #${res.stackId}` : ''}. Check them, then press "Apply ticked questions". Always check facts before the show.`
                    : 'Nothing to generate (all selected levels are already filled?).';
                if (res.stackId) refreshStacks();
                renderResults();
            });
        });

        function renderResults() {
            const boxes = generated.map(g => h('input', { type: 'checkbox', checked: !g.warnings.length }));
            results.replaceChildren(
                questionTable({
                    head: ['', 'Level', 'Set', 'Category', 'Question', 'A', 'B', 'C', 'D', 'Host comment', 'Notes'],
                    body: generated.map((g, i) => ({
                        class: g.warnings.length ? 'warn-row' : null,
                        cells: [boxes[i], g.level, g.replacement ? 'Replacement' : 'Main', g.question.category, g.question.text,
                            ...g.question.answers.map((a, k) => k === g.question.correct ? h('b', {}, a) : a), g.question.comment || '', g.warnings.join(', ')]
                    }))
                }),
                h('div', { class: 'row', style: 'margin-top:8px' },
                    h('button', { onclick: () => boxes.forEach(b => { b.checked = true; }) }, 'Tick all'),
                    h('button', { onclick: () => boxes.forEach(b => { b.checked = false; }) }, 'Untick all'),
                    h('button', {
                        class: 'primary', onclick: () => {
                            const chosen = generated.filter((_, i) => boxes[i].checked);
                            const r = window.MC.room();
                            if (!chosen.length || !r) return;
                            const replacing = chosen.filter(c => (c.replacement ? r.questions.sw : r.questions.main)[c.level - 1].text.trim()).length;
                            if (replacing && !confirm(`${replacing} existing question(s) will be replaced. Continue?`)) return;
                            const m = r.questions.main.map(clone), sw = r.questions.sw.map(clone);
                            for (const c of chosen) (c.replacement ? sw : m)[c.level - 1] = clone(c.question);
                            window.MC.applyQuestions(m, sw);
                            msg.textContent = `${chosen.length} question(s) applied, saved and sent to the game.`;
                        }
                    }, 'Apply ticked questions')));
        }

        modal('Generate questions with AI',
            h('p', { style: 'margin:0' }, h('strong', {}, 'Engine: '), engine, h('span', { class: 'muted' }, '  ·  set in Admin → Connections')),
            languages,
            h('div', { class: 'row' }, h('strong', {}, 'Levels'), 'from', from, 'to', to,
                h('label', {}, main, 'Main questions'), h('label', {}, repl, 'Replacement questions (Switch the Question)')),
            h('div', { class: 'row' }, h('label', {}, onlyEmpty, 'Only fill levels that are empty'), h('label', {}, shuffle, 'Shuffle the answer order')),
            field('Language', language), field('Topic', topic), field('Instructions', extra),
            h('p', { style: 'margin:0;color:var(--accent);font-weight:600' }, 'Difficulty:  1-5 easy (a kid could get it right)  ·  6-9 harder  ·  10-14 hard  ·  15 the hardest of all'),
            h('p', { class: 'muted', style: 'margin:0' }, 'Each question also gets a short background comment for the host screen. With MySQL connected, every generation is saved as a question stack.'),
            h('div', { class: 'row' }, generateButton, cancelButton, msg),
            results);
    }

    // ================================================================== import from a document
    async function fileImport() {
        const room = window.MC.room();
        if (!room) return status('Choose a show first.', true);
        const settings = await api('GET', '/api/settings');
        const engine = settings.ai.provider === 'ollama' ? `Ollama (${settings.ai.ollamaModel || 'no model'})` : `Gemini (${settings.ai.geminiModel})`;
        const input = h('input', { type: 'file', accept: '.docx,.doc,.pdf,.txt,.md,.rtf,.csv,.tsv,.xlsx,.json,.xml' });
        const msg = h('span', { class: 'muted' });
        const out = h('div');
        const saveStack = h('input', { type: 'checkbox', checked: window.MC.me().database, disabled: !window.MC.me().database });
        let items = [];

        const read = async useAi => {
            const file = input.files[0];
            if (!file) { msg.textContent = 'Choose a file first.'; return; }
            msg.textContent = useAi ? `Reading with ${engine}: this can take a minute...` : 'Reading...';
            const form = new FormData();
            form.append('file', file);
            try {
                const res = await fetch(`/api/import?room=${encodeURIComponent(room.id)}${useAi ? '&ai=1' : ''}`, { method: 'POST', body: form });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || res.statusText);
                items = data.items;
                msg.textContent = `${data.count} question(s) found in ${data.file} (${data.method}).` + (data.notes.length ? ' ' + data.notes.join(' ') : '') +
                    (!data.count && !useAi ? ' Try "Read it with AI instead".' : '');
                render(data);
            } catch (e) { msg.textContent = 'Error: ' + e.message; }
        };

        const targetOptions = () => [h('option', { value: '' }, 'Skip'),
            ...Array.from({ length: 15 }, (_, i) => h('option', { value: `main:${i + 1}` }, `Question ${i + 1}`)),
            ...Array.from({ length: 15 }, (_, i) => h('option', { value: `replacement:${i + 1}` }, `Replacement ${i + 1}`))];

        function render(data) {
            const rows = items.map(it => {
                const target = h('select', {}, ...targetOptions());
                target.value = it.target ? `${it.target.set}:${it.target.level}` : '';
                const correct = h('select', {}, ...(it.correctKnown ? [] : [h('option', { value: '' }, '?')]), ...'ABCD'.split('').map((l, i) => h('option', { value: i }, l)));
                correct.value = it.correctKnown ? String(it.question.correct) : '';
                it.ui = { target, correct };
                return h('tr', { class: it.warnings.length ? 'warn-row' : null },
                    h('td', {}, target), h('td', {}, it.question.category),
                    h('td', {}, it.question.text),
                    ...it.question.answers.map(a => h('td', {}, a)),
                    h('td', {}, correct), h('td', {}, it.question.comment), h('td', {}, it.warnings.join(', ')));
            });
            out.replaceChildren(
                items.length ? h('div', { style: 'max-height:55vh;overflow:auto' }, h('table', { class: 'grid' },
                    h('thead', {}, h('tr', {}, ...['Put into', 'Category', 'Question', 'A', 'B', 'C', 'D', 'Correct', 'Host comment', 'Check'].map(t => h('th', {}, t)))),
                    h('tbody', {}, ...rows))) : '',
                items.length ? h('div', { class: 'row', style: 'margin-top:8px' },
                    h('button', { class: 'primary', onclick: apply }, 'Apply to the show'),
                    h('label', {}, saveStack, 'also save them as a stack'),
                    h('button', { onclick: toBank, disabled: !window.MC.me().database, title: 'Adds every question with a known correct answer to the question bank (duplicates are recognised)' }, 'Send all to the question bank')) : '',
                h('details', {}, h('summary', { class: 'muted' }, 'Text read from the file'), h('pre', { style: 'white-space:pre-wrap;max-height:30vh;overflow:auto;font-size:12px' }, data.preview)));
        }

        async function toBank() {
            const ready = items.filter(it => it.ui.correct.value !== '');
            const skipped = items.length - ready.length;
            try {
                const res = await api('POST', '/api/bank/add', {
                    source: 'file', sourceRef: input.files[0]?.name || 'import',
                    items: ready.map(it => ({ question: { ...clone(it.question), correct: Number(it.ui.correct.value) }, difficulty: it.difficulty, difficultySource: 'file' }))
                });
                msg.textContent = `Question bank: ${res.added} added, ${res.duplicates} already there` + (skipped ? `, ${skipped} skipped (correct answer "?")` : '') + '.';
            } catch (e) { msg.textContent = 'Error: ' + e.message; }
        }

        async function apply() {
            const r = window.MC.room();
            const chosen = items.filter(it => it.ui.target.value);
            if (!chosen.length) { msg.textContent = 'Choose where to put at least one question.'; return; }
            const missing = chosen.filter(it => it.ui.correct.value === '');
            if (missing.length) { msg.textContent = `Choose the correct answer for ${missing.length} question(s) marked "?".`; return; }
            const slots = new Set();
            for (const it of chosen) {
                if (slots.has(it.ui.target.value)) { msg.textContent = 'Two questions are going into the same level: change one of them.'; return; }
                slots.add(it.ui.target.value);
            }
            const replacing = chosen.filter(it => { const [set, level] = it.ui.target.value.split(':'); return (set === 'replacement' ? r.questions.sw : r.questions.main)[level - 1].text.trim(); }).length;
            if (replacing && !confirm(`${replacing} existing question(s) will be replaced. Continue?`)) return;
            const main = r.questions.main.map(clone), sw = r.questions.sw.map(clone);
            for (const it of chosen) {
                const [set, level] = it.ui.target.value.split(':');
                (set === 'replacement' ? sw : main)[Number(level) - 1] = { ...clone(it.question), correct: Number(it.ui.correct.value) };
            }
            window.MC.applyQuestions(main, sw);
            if (saveStack.checked) {
                const stackMain = Array.from({ length: 15 }, () => ({ text: '' })), stackSw = Array.from({ length: 15 }, () => ({ text: '' }));
                for (const it of chosen) { const [set, level] = it.ui.target.value.split(':'); (set === 'replacement' ? stackSw : stackMain)[Number(level) - 1] = { ...clone(it.question), correct: Number(it.ui.correct.value) }; }
                try { await api('POST', '/api/stacks', { name: `File · ${input.files[0]?.name || 'import'}`, source: 'file', main: stackMain, sw: stackSw, roomId: r.id }); refreshStacks(); }
                catch (e) { status('Applied, but not saved as a stack: ' + e.message, true); }
            }
            msg.textContent = `${chosen.length} question(s) applied, saved and sent to the game.`;
        }

        modal('Import questions from a file',
            h('p', { class: 'muted', style: 'margin:0' }, 'Word (.docx, .doc), PDF, text (.txt, .md, .rtf), Excel (.xlsx), CSV, JSON and the themes\u2019 questions.xml.'),
            h('details', {}, h('summary', {}, 'Layouts understood automatically'),
                h('ul', { class: 'muted', style: 'margin:6px 0' },
                    h('li', {}, 'Numbered questions ("1.", "Q1)", "Domanda 1:") or lines ending with "?", then answers "A) ... B) ..." (also on one line).'),
                    h('li', {}, 'Correct answer: bold in Word, an asterisk or \u2713 after it, "(corretta)", a line "Risposta: B" / "Answer: Mars", or a key such as "1-B 2-C" at the end.'),
                    h('li', {}, 'Optional: "Livello 7" / "Level 7", a "Riserva" / "Replacement" heading, "Categoria:", "Commento:" / "Note:" for the host.'),
                    h('li', {}, 'Tables (Excel, CSV): columns such as Livello, Domanda, A, B, C, D, Risposta corretta, Categoria, Commento, Tipo (riserva).'))),
            h('div', { class: 'row' }, input,
                h('button', { class: 'primary', onclick: () => read(false) }, 'Read the file'),
                h('button', { onclick: () => read(true), title: 'For documents with an unusual layout: the AI extracts the questions without inventing anything' }, `Read it with AI instead (${engine})`)),
            msg, out);
    }

    // ================================================================== question stacks
    const SOURCE_LABEL = { gemini: 'Gemini', ollama: 'Ollama', builder: 'Stack builder', manual: 'Manual', xml: 'Theme XML', file: 'File' };

    async function refreshStacks() {
        const box = document.getElementById('stackList');
        if (!box) return;
        if (!window.MC.me().database) {
            box.replaceChildren(h('p', { class: 'muted' }, window.MC.me().role === 'admin'
                ? 'Question stacks need the MySQL database: configure it in Admin → Connections.'
                : 'Question stacks need the MySQL database: ask an administrator to configure it.'));
            return;
        }
        let list;
        try { list = await api('GET', '/api/stacks'); } catch (e) { box.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
        if (!list.length) { box.replaceChildren(h('p', { class: 'muted' }, 'No stacks yet.')); return; }
        box.replaceChildren(h('table', { class: 'grid' },
            h('thead', {}, h('tr', {}, ...['Name', 'Source', 'Main', 'Replacement', 'By', 'Updated', ''].map(t => h('th', {}, t)))),
            h('tbody', {}, ...list.map(st => h('tr', {},
                h('td', {}, st.name, st.notes ? h('div', { class: 'muted' }, st.notes) : ''),
                h('td', {}, h('span', { class: 'pill' }, SOURCE_LABEL[st.source] || st.source)),
                h('td', {}, Number(st.main_count || 0)), h('td', {}, Number(st.replacement_count || 0)),
                h('td', {}, st.created_by || ''), h('td', {}, String(st.updated_at || '').slice(0, 16)),
                h('td', { style: 'white-space:nowrap' },
                    h('button', { onclick: () => window.MCBank?.editStack(st.id) }, 'Edit'),
                    h('button', { class: 'primary', onclick: () => loadStack(st, 'both') }, 'Load'),
                    h('button', { onclick: () => loadStack(st, 'main') }, 'Main only'),
                    h('button', { onclick: () => loadStack(st, 'replacement') }, 'Replacement only'),
                    h('button', { onclick: () => renameStack(st) }, 'Rename'),
                    h('button', { class: 'danger', onclick: () => deleteStack(st) }, 'Delete')))))));
    }

    async function loadStack(st, parts) {
        const r = window.MC.room();
        if (!r) return status('Choose a show first.', true);
        if (!confirm(`Load "${st.name}" (${parts === 'both' ? 'main and replacement' : parts}) into "${r.name}"? The show's current questions are replaced.`)) return;
        const full = await api('GET', `/api/stacks/${st.id}`);
        const main = parts === 'replacement' ? r.questions.main.map(clone) : full.main.map(clone);
        const sw = parts === 'main' ? r.questions.sw.map(clone) : full.sw.map(clone);
        window.MC.applyQuestions(main, sw);
        status(`Stack "${st.name}" loaded into the show and sent to the game.`);
    }
    async function renameStack(st) {
        const name = prompt('New name of the stack:', st.name);
        if (!name) return;
        await api('PUT', `/api/stacks/${st.id}`, { name });
        refreshStacks();
    }
    async function deleteStack(st) {
        if (!confirm(`Delete the stack "${st.name}"? This cannot be undone.`)) return;
        await api('DELETE', `/api/stacks/${st.id}`);
        refreshStacks();
    }
    async function saveStack() {
        const r = window.MC.room();
        if (!r) return status('Choose a show first.', true);
        const name = prompt("Name of the new stack with this show's questions:", `${r.name} · ${new Date().toLocaleDateString()}`);
        if (!name) return;
        try { await api('POST', '/api/stacks', { name, source: 'manual', roomId: r.id }); status(`Saved as stack "${name}".`); refreshStacks(); }
        catch (e) { status(e.message, true); }
    }

    // ================================================================== money tree settings
    async function moneyTree(theme) {
        let c;
        try { c = await api('GET', `/api/themes/${encodeURIComponent(theme)}/money-tree`); }
        catch (e) { return status(e.message, true); }

        const amounts = [], previews = [], treeTexts = [], strapTexts = [];
        // flexible columns: the table always fits its half of the window
        const grid = h('div', { class: 'mt-grid' },
            h('b', {}, '#'), h('b', {}, 'Amount'), h('b', {}, 'Preview'), h('b', {}, 'Text: tree / win'), h('b', {}, 'Text: level strap'));
        for (let level = LEVELS; level >= 1; level--) {
            const i = level - 1;
            amounts[i] = h('input', { type: 'number', min: 0, step: 'any', value: c.amounts[i], style: 'text-align:right' });
            previews[i] = h('span', { class: 'mt-preview' });
            treeTexts[i] = h('input', { type: 'text', value: c.topPrizeTexts[i] });
            strapTexts[i] = h('input', { type: 'text', value: c.strapTexts[i] });
            grid.append(h('span', { style: level % 5 ? '' : 'font-weight:700' }, level), amounts[i], previews[i], treeTexts[i], strapTexts[i]);
        }

        const input = (value, size) => h('input', { type: 'text', value, size });
        const select = (options, value) => h('select', {}, ...options.map(o => h('option', { value: o, selected: o === value }, o)));
        const check = value => h('input', { type: 'checkbox', checked: value });
        const f = {
            localeCode: input(c.localeCode, 10), style: select(['currency', 'decimal'], c.style), currency: input(c.currency, 5),
            currencyDisplay: select(['symbol', 'narrowSymbol', 'code', 'name'], c.currencyDisplay),
            fractionDigits: h('input', { type: 'number', min: 0, max: 4, value: c.fractionDigits, style: 'width:60px' }),
            alwaysGroup: check(c.alwaysGroup), prefix: input(c.prefix, 8), suffix: input(c.suffix, 8),
            totalPrizeText: input(c.totalPrizeText, 24), millionaireText: input(c.millionaireText, 24),
            useTopPrizeText: check(c.useTopPrizeText), topPrizeFrom: h('input', { type: 'number', min: 1, max: 15, value: c.topPrizeFrom, style: 'width:60px' }),
            useStrapText: check(c.useStrapText), strapFrom: h('input', { type: 'number', min: 1, max: 15, value: c.strapFrom, style: 'width:60px' }),
            autoTopPrizeText: check(c.autoTopPrizeText), autoUpperCase: check(c.autoUpperCase), syncSecondary: check(c.syncSecondary)
        };
        // Clocked 2009 settings of the theme
        const cc = c.clocked || {};
        const ck = {
            banked: h('input', { type: 'number', min: 0, max: 405, value: cc.startingBankedTime ?? 0, style: 'width:80px' }),
            reduce: h('select', {}, h('option', { value: 'previous', selected: !cc.reduceAmountAfterTimeUp }, 'keeps the amount of the previous question'),
                h('option', { value: 'safe', selected: !!cc.reduceAmountAfterTimeUp }, 'drops to the safe level')),
            dd: h('input', { type: 'checkbox', checked: !!cc.replaceFFwithDD }),
            ate: h('input', { type: 'checkbox', checked: !!cc.replaceSTQwithATE }),
            unlock: h('input', { type: 'number', min: 1, max: 15, value: cc.lifelineUnlockLevel ?? 6, style: 'width:60px' }),
            ataIn: h('input', { type: 'checkbox', checked: !!cc.showATAResultsInAnswers })
        };
        const clockedBox = c.clocked ? h('div', { class: 'stack card' },
            h('strong', {}, 'Clocked settings'),
            field('Starting banked time', ck.banked, 'seconds, max 405 (6:45)'),
            field('When time runs out', ck.reduce),
            h('label', {}, ck.dd, 'Double Dip instead of 50:50'),
            h('label', {}, ck.ate, 'Ask the Expert instead of Switch the Question'),
            field('Unlocked from question', ck.unlock, 'Switch the Question / Ask the Expert (default 6)'),
            h('label', {}, ck.ataIn, 'Show the audience percentages inside the answers'),
            h('p', { class: 'muted', style: 'margin:0' }, 'The clock gives 15 s for questions 1-5, 30 s for 6-10, 45 s for 11-14; question 15 uses the banked time.')) : '';
        const presets = h('select', {}, h('option', { value: '' }, '(currency preset)'),
            ...[['en-GB', 'GBP', 'UK - Pounds'], ['en-US', 'USD', 'US - Dollars'], ['it-IT', 'EUR', 'Euro - Italy'], ['de-DE', 'EUR', 'Euro - Germany'], ['fr-FR', 'EUR', 'Euro - France']]
                .map(([l, cur, name]) => h('option', { value: `${l}|${cur}` }, `${name} (${l}, ${cur})`)));
        presets.addEventListener('change', () => {
            if (!presets.value) return;
            const [l, cur] = presets.value.split('|');
            f.localeCode.value = l; f.currency.value = cur; f.style.value = 'currency'; f.currencyDisplay.value = 'symbol';
            refresh();
        });
        const msg = h('span', { class: 'muted' });

        const collect = () => ({
            ...c,
            amounts: amounts.map(a => Number(a.value) || 0),
            localeCode: f.localeCode.value.trim(), style: f.style.value, currency: f.currency.value.trim().toUpperCase(),
            currencyDisplay: f.currencyDisplay.value, fractionDigits: Number(f.fractionDigits.value) || 0, alwaysGroup: f.alwaysGroup.checked,
            prefix: f.prefix.value, suffix: f.suffix.value, totalPrizeText: f.totalPrizeText.value, millionaireText: f.millionaireText.value,
            useTopPrizeText: f.useTopPrizeText.checked, topPrizeFrom: Number(f.topPrizeFrom.value) || 15, topPrizeTexts: treeTexts.map(t => t.value),
            useStrapText: f.useStrapText.checked, strapFrom: Number(f.strapFrom.value) || 15, strapTexts: strapTexts.map(t => t.value),
            autoTopPrizeText: f.autoTopPrizeText.checked, autoUpperCase: f.autoUpperCase.checked, syncSecondary: f.syncSecondary.checked,
            clocked: c.clocked ? {
                startingBankedTime: Number(ck.banked.value) || 0, reduceAmountAfterTimeUp: ck.reduce.value === 'safe',
                replaceFFwithDD: ck.dd.checked, replaceSTQwithATE: ck.ate.checked,
                lifelineUnlockLevel: Number(ck.unlock.value) || 6, showATAResultsInAnswers: ck.ataIn.checked
            } : null
        });

        let timer = null;
        async function refresh() {
            const cfg = collect();
            for (let i = 0; i < LEVELS; i++) {
                const tree = c.hasTopPrizeText && cfg.useTopPrizeText && i + 1 >= cfg.topPrizeFrom;
                const strap = c.hasTopPrizeText && cfg.useStrapText && i + 1 >= cfg.strapFrom;
                treeTexts[i].disabled = !tree; strapTexts[i].disabled = !strap;
                treeTexts[i].readOnly = strapTexts[i].readOnly = cfg.autoTopPrizeText;
                treeTexts[i].style.background = !tree ? 'var(--out)' : cfg.autoTopPrizeText ? 'var(--ok-row)' : 'var(--warn-row)';
                strapTexts[i].style.background = !strap ? 'var(--out)' : cfg.autoTopPrizeText ? 'var(--ok-row)' : 'var(--warn-row)';
            }
            try {
                const p = await api('POST', '/api/money-tree/preview', cfg);
                p.shown.forEach((t, i) => { previews[i].textContent = t + (p.shown[i] !== p.formatted[i] ? '  (text)' : ''); });
                if (cfg.autoTopPrizeText) p.topTexts.forEach((t, i) => { treeTexts[i].value = t; strapTexts[i].value = p.strapTexts[i]; });
                msg.textContent = '';
            } catch (e) { msg.textContent = e.message; }
        }
        const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };

        const save = async reload => {
            try {
                const r = await api('PUT', `/api/themes/${encodeURIComponent(theme)}/money-tree`, { config: collect(), reload });
                msg.textContent = reload ? `Saved to Variables.js; ${r.reloaded} show(s) reloaded.` : 'Saved to Variables.js (the shows show it after their next reload).';
                window.MC.themeChanged(theme);
            } catch (e) { msg.textContent = 'Could not save: ' + e.message; }
        };

        const bg = modal(`${c.clocked ? 'Money tree and Clocked settings' : 'Money tree'} - ${theme}`,
            h('div', { class: 'mt-layout' },
                h('div', { style: 'min-width:0' }, grid),
                h('div', { class: 'stack' },
                    field('Currency preset', presets), field('Locale code', f.localeCode, 'e.g. en-GB, it-IT'),
                    field('Style', f.style), field('Currency code', f.currency, 'ISO 4217'), field('Currency display', f.currencyDisplay),
                    field('Decimal places', f.fractionDigits),
                    h('label', {}, f.alwaysGroup, 'Always show the thousands separator (8.000 instead of 8000)'),
                    field('Text before amount', f.prefix), field('Text after amount', f.suffix),
                    field('Total prize text', f.totalPrizeText), field('Top prize text', f.millionaireText),
                    c.hasTopPrizeText ? h('div', { class: 'stack card' },
                        h('label', {}, f.useTopPrizeText, 'Money tree, win and total prize: show text from level', f.topPrizeFrom),
                        h('label', {}, f.useStrapText, 'Level strap (prize at stake): show text from level', f.strapFrom),
                        h('label', {}, f.autoTopPrizeText, 'Generate the text automatically from the amount, currency and language', f.autoUpperCase, 'UPPER CASE'),
                        h('p', { class: 'muted', style: 'margin:0' }, 'Where the game shows a text (e.g. "$1 MILLION"), the currency setting does not apply to it. The automatic text follows the theme: "1 MILIONE €" in Italian with euro.'))
                        : h('p', { class: 'muted' }, 'This theme has no top prize text settings.'),
                    h('label', {}, f.syncSecondary, "Use this currency for the game's second number format too"),
                    clockedBox,
                    c.secondary ? h('p', { class: 'muted', style: 'margin:0' }, `Second format in this theme: ${c.secondary}.`) : '',
                    h('p', { class: 'muted', style: 'margin:0' }, 'Levels 5, 10 and 15 are the milestones highlighted by the game. A backup of the original file is kept as Variables.js.bak.'),
                    h('div', { class: 'row' },
                        h('button', { onclick: () => save(false) }, 'Save'),
                        h('button', { class: 'primary', onclick: () => { if (confirm('Save and reload every show using this theme? A reload restarts the game.')) save(true); } }, 'Save and reload shows')),
                    msg)));
        bg.querySelectorAll('input, select').forEach(el => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', schedule));
        refresh();
    }

    document.getElementById('qeBuilder').addEventListener('click', builderImport);
    document.getElementById('qeFile').addEventListener('click', fileImport);
    document.getElementById('qeAi').addEventListener('click', aiGenerator);
    document.getElementById('stackSave').addEventListener('click', saveStack);
    document.getElementById('stackRefresh').addEventListener('click', refreshStacks);
    window.MCTools = { moneyTree, builderImport, aiGenerator, refreshStacks };
})();
