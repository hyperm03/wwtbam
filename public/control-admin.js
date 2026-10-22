/* Millionaire Control - administration: connections, users, system log, info */
(() => {
    'use strict';
    const { h, api, status } = window.MC;
    const body = document.getElementById('adminBody');
    let section = 'connections';

    document.querySelectorAll('nav.subtabs button').forEach(b => b.addEventListener('click', () => {
        section = b.dataset.admin;
        document.querySelectorAll('nav.subtabs button').forEach(x => x.classList.toggle('active', x === b));
        open();
    }));

    const row = (label, control, hint) => [h('span', {}, label), hint ? h('span', { class: 'row' }, control, h('span', { class: 'muted' }, hint)) : control];
    const pill = (ok, text) => h('span', { class: 'pill ' + (ok ? 'ok' : 'bad') }, text);

    function open() {
        if (window.MC.me().role !== 'admin') { body.replaceChildren(h('p', { class: 'error' }, 'Administrators only.')); return; }
        ({ installation: () => window.MCInstallation.mount(body), connections, users, logs, about })[section]();
    }

    // ================================================================== connections
    async function connections() {
        const [settings, st] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/admin/status')]);
        if (section !== 'connections') return;
        const m = settings.mysql, ai = settings.ai, b = settings.builder;

        // ---- MySQL
        const my = {
            enabled: h('input', { type: 'checkbox', checked: m.enabled }),
            host: h('input', { type: 'text', value: m.host }),
            port: h('input', { type: 'number', value: m.port, style: 'width:100px' }),
            user: h('input', { type: 'text', value: m.user, autocomplete: 'off' }),
            password: h('input', { type: 'password', placeholder: m.hasPassword ? '(saved - leave empty to keep it)' : '', autocomplete: 'new-password' }),
            database: h('input', { type: 'text', value: m.database })
        };
        const myStatus = h('span');
        const setMyStatus = s => myStatus.replaceChildren(s.connected ? pill(true, 'connected') : pill(false, s.error ? 'not connected: ' + s.error : 'not connected'));
        setMyStatus(st.database);
        const myValues = () => ({ enabled: my.enabled.checked, host: my.host.value, port: Number(my.port.value), user: my.user.value, password: my.password.value || undefined, database: my.database.value });

        // ---- AI engines
        const provider = ['gemini', 'ollama'].map(p => h('input', { type: 'radio', name: 'admProvider', value: p, checked: ai.provider === p }));
        const geminiKey = h('input', { type: 'password', placeholder: ai.hasGeminiKey ? '(saved - leave empty to keep it)' : 'paste your API key', autocomplete: 'new-password' });
        const clearKey = h('input', { type: 'checkbox' });
        const geminiModel = h('input', { type: 'text', value: ai.geminiModel, list: 'admGeminiModels' });
        const ollamaUrl = h('input', { type: 'text', value: ai.ollamaUrl });
        const ollamaModel = h('input', { type: 'text', value: ai.ollamaModel, list: 'admOllamaModels' });
        const geminiList = h('datalist', { id: 'admGeminiModels' }), ollamaList = h('datalist', { id: 'admOllamaModels' });
        const aiMsg = h('span', { class: 'muted' });
        const aiValues = () => ({
            provider: provider.find(r => r.checked).value, geminiKey: geminiKey.value || undefined, clearGeminiKey: clearKey.checked,
            geminiModel: geminiModel.value, ollamaUrl: ollamaUrl.value, ollamaModel: ollamaModel.value
        });
        const saveAi = async () => { await api('PUT', '/api/settings', { ai: aiValues() }); geminiKey.value = ''; clearKey.checked = false; };
        const loadModels = async p => {
            aiMsg.textContent = 'Connecting...';
            try {
                await saveAi();
                const { models } = await api('POST', '/api/ai/models', { provider: p });
                (p === 'gemini' ? geminiList : ollamaList).replaceChildren(...models.map(x => h('option', { value: x })));
                const input = p === 'gemini' ? geminiModel : ollamaModel;
                if (models.length && !models.includes(input.value)) input.value = models[0];
                aiMsg.textContent = models.length ? `Connected: ${models.length} model(s).` : 'Connected, but no models were found.';
            } catch (e) { aiMsg.textContent = 'Could not connect: ' + e.message; }
        };

        // ---- question builder
        const bUrl = h('input', { type: 'text', value: b.baseUrl, placeholder: 'http://127.0.0.1:13400' });
        const bPath = h('input', { type: 'text', value: b.path, placeholder: 'e.g. /api/questions' });
        const bToken = h('input', { type: 'password', placeholder: b.hasToken ? '(saved - leave empty to keep it)' : '(optional)', autocomplete: 'new-password' });
        const bMsg = h('span', { class: 'muted' });

        body.replaceChildren(
            h('div', { class: 'card stack' },
                h('h3', {}, 'MySQL / MariaDB'),
                h('p', { class: 'muted', style: 'margin:0' }, 'Users, question stacks and the system log. The tables are created automatically on the first connection.'),
                h('div', { class: 'form-grid' },
                    ...row('Use MySQL', h('label', {}, my.enabled, 'enabled')),
                    ...row('Host', my.host, 'on this server: 127.0.0.1'), ...row('Port', my.port, 'e.g. 3450'),
                    ...row('User', my.user), ...row('Password', my.password), ...row('Database', my.database, 'must already exist')),
                h('div', { class: 'row' },
                    h('button', {
                        onclick: async () => {
                            myStatus.replaceChildren(h('span', { class: 'muted' }, 'Testing...'));
                            const r = await api('POST', '/api/admin/mysql/test', myValues());
                            myStatus.replaceChildren(r.ok ? pill(true, `works · ${r.version}`) : pill(false, r.error));
                        }
                    }, 'Test'),
                    h('button', {
                        class: 'primary', onclick: async () => {
                            myStatus.replaceChildren(h('span', { class: 'muted' }, 'Connecting...'));
                            const r = await api('PUT', '/api/admin/mysql', myValues());
                            my.password.value = '';
                            setMyStatus({ connected: r.ok, error: r.error });
                            status(r.ok ? 'MySQL connected: sign out and in again to use the database users.' : 'MySQL not connected.', !r.ok);
                        }
                    }, 'Save and connect'),
                    myStatus)),

            h('div', { class: 'card stack', style: 'margin-top:14px' },
                h('h3', {}, 'AI engines'),
                h('div', { class: 'form-grid' },
                    ...row('Default engine', h('span', { class: 'row' }, ...provider.map((r, i) => h('label', {}, r, i ? 'Ollama (local)' : 'Google Gemini')))),
                    ...row('Gemini API key', geminiKey, h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Get a key')),
                    ...row('', h('label', {}, clearKey, 'remove the saved key')),
                    ...row('Gemini model', h('span', { class: 'row' }, geminiModel, h('button', { onclick: () => loadModels('gemini') }, 'Load models'))),
                    ...row('Ollama server', ollamaUrl, 'e.g. localhost:11434'),
                    ...row('Ollama model', h('span', { class: 'row' }, ollamaModel, h('button', { onclick: () => loadModels('ollama') }, 'Load models')))),
                geminiList, ollamaList,
                h('p', { class: 'muted', style: 'margin:0' }, 'The Gemini key is stored encrypted on the server and never sent back to the browser.'),
                h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { await saveAi(); aiMsg.textContent = 'Saved.'; } }, 'Save'), aiMsg)),

            h('div', { class: 'card stack', style: 'margin-top:14px' },
                h('h3', {}, 'Question builder'),
                h('div', { class: 'form-grid' },
                    ...row('Address', bUrl, 'on this server: http://127.0.0.1:13400'),
                    ...row('Path', bPath, 'the page that returns the questions as JSON'),
                    ...row('Access token', bToken)),
                h('div', { class: 'row' },
                    h('button', {
                        class: 'primary', onclick: async () => {
                            await api('PUT', '/api/settings', { builder: { baseUrl: bUrl.value, path: bPath.value, token: bToken.value || undefined } });
                            bToken.value = '';
                            try { const d = await api('POST', '/api/builder/fetch', {}); bMsg.textContent = `Saved. ${d.url}: ${d.sets.length} set(s) recognised.`; }
                            catch (e) { bMsg.textContent = 'Saved, but: ' + e.message; }
                        }
                    }, 'Save and test'), bMsg)));
    }

    // ================================================================== users
    async function users() {
        let data;
        try { data = await api('GET', '/api/admin/users'); }
        catch (e) {
            body.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'User accounts are stored in MySQL: connect the database in Connections first.'),
                h('p', { class: 'muted' }, `Until then only the built-in "admin" account (the ADMIN_PASSWORD of the service) can sign in. Detail: ${e.message}`)));
            return;
        }
        const name = h('input', { type: 'text', placeholder: 'user name', autocomplete: 'off' });
        const pass = h('input', { type: 'password', placeholder: 'password (min. 8)', autocomplete: 'new-password' });
        const role = h('select', {}, h('option', { value: 'operator' }, 'Operator (runs the shows)'), h('option', { value: 'admin' }, 'Administrator'));
        const msg = h('span', { class: 'muted' });
        const act = async (fn, ok) => { try { await fn(); status(ok); users(); } catch (e) { status(e.message, true); } };

        body.replaceChildren(
            h('div', { class: 'card stack' },
                h('h3', {}, 'New user'),
                h('div', { class: 'row' }, name, pass, role,
                    h('button', { class: 'primary', onclick: () => act(() => api('POST', '/api/admin/users', { username: name.value, password: pass.value, role: role.value }), `User ${name.value} created.`) }, 'Create'), msg),
                h('p', { class: 'muted', style: 'margin:0' }, 'Operators use the control panel, questions, stacks and the AI generator. Administrators also manage connections, users, the system log and theme packs.')),
            h('div', { class: 'card', style: 'margin-top:14px' },
                h('table', { class: 'grid' },
                    h('thead', {}, h('tr', {}, ...['User', 'Role', 'Status', 'Created', 'Last sign-in', ''].map(t => h('th', {}, t)))),
                    h('tbody', {},
                        h('tr', {}, h('td', {}, h('b', {}, data.builtin)), h('td', {}, 'Administrator'), h('td', {}, pill(true, 'always active')),
                            h('td', { colspan: 3, class: 'muted' }, 'Built-in account: its password is ADMIN_PASSWORD in the systemd service. It works even without MySQL.')),
                        ...data.users.map(u => {
                            const roleSel = h('select', { onchange: e => act(() => api('PUT', `/api/admin/users/${u.id}`, { role: e.target.value }), `Role of ${u.username} changed.`) },
                                h('option', { value: 'operator', selected: u.role !== 'admin' }, 'Operator'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'Administrator'));
                            return h('tr', {},
                                h('td', {}, u.username), h('td', {}, roleSel),
                                h('td', {}, u.active ? pill(true, 'active') : pill(false, 'disabled')),
                                h('td', {}, String(u.created_at || '').slice(0, 16)), h('td', {}, String(u.last_login || '-').slice(0, 16)),
                                h('td', { style: 'white-space:nowrap' },
                                    h('button', { onclick: () => act(() => api('PUT', `/api/admin/users/${u.id}`, { active: !u.active }), `${u.username} ${u.active ? 'disabled' : 'enabled'}.`) }, u.active ? 'Disable' : 'Enable'),
                                    h('button', { onclick: () => { const p = prompt(`New password for ${u.username} (min. 8 characters):`); if (p) act(() => api('PUT', `/api/admin/users/${u.id}`, { password: p }), 'Password changed.'); } }, 'Reset password'),
                                    h('button', { class: 'danger', onclick: () => { if (confirm(`Delete ${u.username}?`)) act(() => api('DELETE', `/api/admin/users/${u.id}`), `${u.username} deleted.`); } }, 'Delete')));
                        })))));
    }

    // ================================================================== system log
    async function logs() {
        const action = h('input', { type: 'text', placeholder: 'action (e.g. login.failed)', size: 20 });
        const user = h('input', { type: 'text', placeholder: 'user', size: 12 });
        const room = h('input', { type: 'text', placeholder: 'show', size: 14 });
        const limit = h('select', {}, ...[100, 300, 1000].map(n => h('option', { value: n, selected: n === 300 }, `last ${n}`)));
        const table = h('div');
        const load = async () => {
            const q = new URLSearchParams({ action: action.value, user: user.value, room: room.value, limit: limit.value });
            try {
                const r = await api('GET', '/api/admin/logs?' + q);
                table.replaceChildren(
                    h('p', { class: 'muted' }, r.source === 'mysql' ? `${r.logs.length} entries from MySQL.` : `${r.logs.length} entries from data/system.log (MySQL not connected).`),
                    h('div', { style: 'max-height:65vh;overflow:auto' }, h('table', { class: 'grid' },
                        h('thead', {}, h('tr', {}, ...['Time', 'User', 'Show', 'Action', 'Details', 'IP'].map(t => h('th', {}, t)))),
                        h('tbody', {}, ...r.logs.map(l => h('tr', { class: /failed/.test(l.action) ? 'bad-row' : null },
                            h('td', { style: 'white-space:nowrap' }, String(l.ts).replace('T', ' ').slice(0, 19)), h('td', {}, l.username || ''), h('td', {}, l.room || ''),
                            h('td', {}, h('code', {}, l.action)), h('td', { style: 'max-width:520px;word-break:break-word' }, l.details || ''), h('td', {}, l.ip || '')))))));
            } catch (e) { table.replaceChildren(h('p', { class: 'error' }, e.message)); }
        };
        body.replaceChildren(h('div', { class: 'card stack' },
            h('div', { class: 'row' }, action, user, room, limit, h('button', { class: 'primary', onclick: load }, 'Refresh')), table));
        load();
    }

    // ================================================================== info / about
    function about() {
        body.replaceChildren(h('div', { class: 'about' },
            h('h2', {}, "\u201CWho Wants to Be a Millionaire?\u201D Show control system"),
            h('div', { class: 'version' }, 'Version 1.0'),
            h('div', { class: 'credits' },
                h('div', {}, h('b', {}, 'Designed by: '), 'Mattia Rozzi'),
                h('div', {}, h('b', {}, 'Game engine by: '), 'kuby64')),
            h('p', { class: 'legal' }, "The format \u2018Who Wants to Be a Millionaire?\u2019, its logo, multimedia elements and trademarks are owned and controlled by Sony Pictures Television. " +
                'This software is solely made for fun and entertainment purposes with non-profit scope. No actual cash prizes shown or mentioned during gameplay are awarded.')));
    }

    window.MCAdmin = { open };
})();
