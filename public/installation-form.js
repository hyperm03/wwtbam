(() => {
    'use strict';
    function element(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        return node;
    }
    async function request(method, body) {
        const response = await fetch('/api/admin/installation', { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        if (response.status === 401) { location.assign('/login?next=/setup'); throw new Error('Accedi come amministratore.'); }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Impossibile salvare la configurazione.');
        return result;
    }
    const explanations = {
        Sito: 'Indica i due indirizzi HTTPS che userai per regia e output. DNS e certificati vanno configurati sul tuo hosting. Se li cambi, dovrai accedere di nuovo al nuovo indirizzo.',
        Discord: 'Crea l’applicazione nel Discord Developer Portal. I ruoli sono facoltativi; i partecipanti non ricevono permessi di regia automaticamente.',
        Privacy: 'Completa i dati del gestore e verifica l’informativa per il tuo servizio. La configurazione non è una certificazione di conformità. Il percorso corrente è riservato agli adulti.',
        Annunci: 'Integrazione facoltativa, separata dal login. Gli annunci richiedono anche l’attivazione per ciascun evento del calendario.',
        Gioco: 'Personalizza il tempo a disposizione del pubblico per votare.'
    };
    async function mount(container, { wizard = false } = {}) {
        container.replaceChildren(element('p', {}, 'Caricamento configurazione…'));
        try {
            let data = await request('GET'), currentStep = 0;
            function render(message = '') {
                const controls = new Map(), clearing = new Map(), groups = [...new Set(data.fields.map(f => f.group))];
                const form = element('form', { class: 'card stack', novalidate: true });
                const notice = element('p', { role: 'status', 'aria-live': 'polite' }, message);
                const missing = element('ul', {}, ...data.missing.map(label => element('li', {}, label)));
                const progress = element('p', { class: 'muted' });
                const panels = groups.map((group, index) => {
                    const panel = element('fieldset', { style: 'border:1px solid var(--line);padding:18px;border-radius:10px', 'data-group': group }, element('legend', {}, group), element('p', {}, explanations[group]));
                    for (const field of data.fields.filter(item => item.group === group)) {
                        const id = 'setting-' + field.name;
                        const attrs = { id, name: field.name, 'data-setting': field.name, style: field.kind === 'boolean' ? '' : 'width:100%', autocomplete: field.kind === 'secret' ? 'new-password' : 'off' };
                        const input = field.kind === 'textarea' ? element('textarea', { ...attrs, rows: 3 }) : element('input', { ...attrs, type: field.kind === 'secret' ? 'password' : field.kind === 'boolean' ? 'checkbox' : field.kind === 'number' ? 'number' : field.kind === 'email' ? 'email' : 'text', ...(field.kind === 'number' ? { min: field.min, max: field.max } : {}) });
                        if (field.kind === 'boolean') input.checked = field.value === '1'; else input.value = field.value;
                        controls.set(field.name, input);
                        panel.append(element('label', { for: id, style: 'display:block;margin:14px 0 4px' }, field.label), input);
                        if (field.hint) panel.append(element('p', { class: 'muted', style: 'margin:4px 0' }, field.hint));
                        if (field.kind === 'secret') {
                            input.placeholder = field.configured ? 'Già configurato: lascia vuoto per mantenerlo' : 'Inserisci il segreto';
                            const clear = element('input', { type: 'checkbox', 'data-clear': field.name }); clearing.set(field.name, clear);
                            panel.append(element('p', { class: 'muted' }, field.configured ? 'Segreto configurato. Il valore non viene mostrato.' : 'Nessun segreto configurato.'), element('label', {}, clear, ' Rimuovi il segreto salvato'));
                        } else if (field.source === 'environment') panel.append(element('small', { class: 'muted' }, 'Precompilato dall’ambiente del servizio.'));
                    }
                    return panel;
                });
                const updateSteps = () => {
                    panels.forEach((panel, index) => { panel.hidden = wizard && index !== currentStep; });
                    progress.textContent = wizard ? `Passaggio ${currentStep + 1} di ${groups.length}: ${groups[currentStep]}` : '';
                    previous.disabled = currentStep === 0; next.disabled = currentStep === groups.length - 1;
                };
                const previous = element('button', { type: 'button', onclick: () => { currentStep--; updateSteps(); } }, 'Indietro');
                const next = element('button', { type: 'button', onclick: () => { currentStep++; updateSteps(); } }, 'Avanti');
                const nav = element('div', { class: 'row', hidden: !wizard }, previous, next);
                const actions = element('div', { class: 'row' });
                async function save(complete, rehearsal = false) {
                    notice.textContent = 'Salvataggio…';
                    actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
                    try {
                        const values = rehearsal ? { DISCORD_LOGIN_ENABLED: false, DISCORD_ANNOUNCEMENTS_ENABLED: false } : Object.fromEntries(data.fields.map(field => [field.name, field.kind === 'boolean' ? controls.get(field.name).checked : controls.get(field.name).value]));
                        const clearSecrets = rehearsal ? [] : [...clearing].filter(([, input]) => input.checked).map(([name]) => name);
                        data = await request('PUT', { values, clearSecrets, complete });
                        // Rebuild from the redacted server response: typed secrets leave the DOM after saving.
                        if (data.originChanged) {
                            container.replaceChildren(element('p', { role: 'status' }, 'Configurazione salvata. Gli indirizzi sono cambiati: accedi nuovamente alla regia. Non è necessario riavviare il programma.'), element('a', { href: data.nextUrl, class: 'primary' }, 'Apri la regia configurata'));
                        } else if (wizard && complete) location.assign('/home');
                        else render('Impostazioni salvate e applicate. I segreti sono conservati cifrati sul server.');
                    } catch (error) {
                        notice.textContent = error.message;
                        actions.querySelectorAll('button').forEach(button => { button.disabled = false; });
                    }
                }
                actions.append(element('button', { type: 'button', onclick: () => save(false) }, 'Salva bozza'), element('button', { type: 'submit', class: 'primary' }, wizard ? 'Completa configurazione' : 'Salva impostazioni'));
                if (wizard) actions.append(element('button', { type: 'button', onclick: () => save(true, true) }, 'Configura in seguito — solo prove'));
                form.addEventListener('submit', event => { event.preventDefault(); save(true); });
                form.append(notice, element('p', {}, data.needsSetup ? 'Prima installazione: completa i campi oppure continua con le sole prove.' : 'Configurazione già inizializzata. Puoi modificare i valori qui.'), progress, ...panels, nav,
                    element('details', {}, element('summary', {}, data.missing.length ? 'Dati ancora necessari per le integrazioni abilitate' : 'Configurazione completa'), missing),
                    element('p', { id: 'callbackHint', class: 'muted' }), actions,
                    element('p', { class: 'muted' }, 'Campi segreti vuoti: mantieni il valore attuale. Le impostazioni salvate nell’app hanno precedenza sulle variabili del servizio.'));
                container.replaceChildren(form); updateSteps();
                const callbackHint = form.querySelector('#callbackHint');
                const updateCallback = () => { callbackHint.textContent = 'Callback da registrare in Discord: ' + (controls.get('PUBLIC_URL').value.replace(/\/+$/, '') || '(indirizzo della regia)') + '/auth/discord/callback'; };
                controls.get('PUBLIC_URL').addEventListener('input', updateCallback); updateCallback();
                for (const name of ['PRIVACY_CONTROLLER_NAME', 'PRIVACY_CONTACT_EMAIL', 'PRIVACY_HOSTING_REGION', 'PRIVACY_POLICY_VERSION', 'PARTICIPANT_MIN_AGE', 'PARTICIPANT_RETENTION_DAYS']) controls.get(name).addEventListener('input', () => { controls.get('PRIVACY_REVIEWED').checked = false; });
            }
            render();
        } catch (error) { container.replaceChildren(element('p', { role: 'alert' }, error.message)); }
    }
    window.MCInstallation = { mount };
    const container = document.getElementById('installation');
    if (container) mount(container, { wizard: true });
})();
