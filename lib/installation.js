import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJson, writeJson } from './durable.js';

// Only application settings are writable here. Process paths, ports, proxy trust and cryptographic keys
// remain deployment settings: changing them in a running web request would be unsafe.
export const installationFields = [
    { name: 'PUBLIC_URL', label: 'Indirizzo pubblico della regia', group: 'Sito', kind: 'origin', hint: 'Per esempio https://quiz.example.com' },
    { name: 'OUTPUT_PUBLIC_URL', label: 'Indirizzo pubblico dell’output', group: 'Sito', kind: 'origin', hint: 'Hostname diverso dalla regia, con HTTPS per il login Discord.' },
    { name: 'DISCORD_LOGIN_ENABLED', label: 'Abilita il login Discord', group: 'Discord', kind: 'boolean', fallback: '1' },
    { name: 'DISCORD_CLIENT_ID', label: 'Client ID Discord', group: 'Discord', kind: 'id' },
    { name: 'DISCORD_CLIENT_SECRET', label: 'Client Secret Discord', group: 'Discord', kind: 'secret' },
    { name: 'DISCORD_GUILD_ID', label: 'ID del server Discord', group: 'Discord', kind: 'id', hint: 'Facoltativo: limita l’accesso ai membri del server.' },
    { name: 'DISCORD_ALLOWED_ROLE_IDS', label: 'Ruoli ammessi a partecipare', group: 'Discord', kind: 'ids', hint: 'ID separati da virgole; richiede l’ID del server.' },
    { name: 'DISCORD_OPERATOR_ROLE_IDS', label: 'Ruoli degli operatori', group: 'Discord', kind: 'ids' },
    { name: 'DISCORD_ADMIN_ROLE_IDS', label: 'Ruoli degli amministratori', group: 'Discord', kind: 'ids' },
    { name: 'PRIVACY_CONTROLLER_NAME', label: 'Titolare del servizio', group: 'Privacy', kind: 'text' },
    { name: 'PRIVACY_CONTACT_EMAIL', label: 'Email per le richieste privacy', group: 'Privacy', kind: 'email' },
    { name: 'PRIVACY_HOSTING_REGION', label: 'Hosting, Paesi e trasferimenti', group: 'Privacy', kind: 'textarea', hint: 'Indica fornitori, localizzazione e garanzie applicabili ai trasferimenti.' },
    { name: 'PRIVACY_POLICY_VERSION', label: 'Versione dell’informativa', group: 'Privacy', kind: 'text', fallback: '2026-10-22' },
    { name: 'PARTICIPANT_RETENTION_DAYS', label: 'Elimina account inattivi dopo (giorni)', group: 'Privacy', kind: 'number', fallback: '30', min: 1, max: 90 },
    { name: 'PARTICIPANT_MIN_AGE', label: 'Età minima dei partecipanti', group: 'Privacy', kind: 'number', fallback: '18', min: 18, max: 120 },
    { name: 'PRIVACY_REVIEWED', label: 'Ho verificato l’informativa e le condizioni effettive del servizio', group: 'Privacy', kind: 'boolean', fallback: '0' },
    { name: 'DISCORD_ANNOUNCEMENTS_ENABLED', label: 'Abilita gli annunci con il bot', group: 'Annunci', kind: 'boolean', fallback: '0' },
    { name: 'DISCORD_BOT_TOKEN', label: 'Token del bot Discord', group: 'Annunci', kind: 'secret' },
    { name: 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', label: 'ID del canale degli annunci', group: 'Annunci', kind: 'id' },
    { name: 'AUDIENCE_VOTE_SECONDS', label: 'Durata del voto pubblico (secondi)', group: 'Gioco', kind: 'number', fallback: '30', min: 5, max: 180 }
];
const fields = new Map(installationFields.map(field => [field.name, field]));

export function createInstallation({ dataDir, sessionSecret, environment = process.env }) {
    const file = path.join(dataDir, 'installation.json');
    const key = crypto.createHash('sha256').update('mc-installation:' + sessionSecret).digest();
    const seal = value => {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    };
    const open = value => {
        const bytes = Buffer.from(value, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    };
    const saved = readJson(file, { version: 1, values: {}, completedAt: null });
    if (saved.version !== 1 || !saved.values || typeof saved.values !== 'object') throw new Error('Invalid installation settings');
    let values = {};
    for (const [name, value] of Object.entries(saved.values)) {
        const field = fields.get(name);
        if (field) values[name] = field.kind === 'secret' ? open(value) : value;
    }
    let completedAt = saved.completedAt || null, revision = 0;
    const events = new EventEmitter();
    const valueOf = (name, candidate = values) => {
        const field = fields.get(name);
        if (!field) throw new Error('Unsupported application setting');
        return String(Object.hasOwn(candidate, name) ? candidate[name] : environment[name] ?? field.fallback ?? '');
    };
    const requirements = candidate => {
        const get = name => valueOf(name, candidate), missing = [];
        if (get('DISCORD_LOGIN_ENABLED') === '1') {
            for (const name of ['PUBLIC_URL', 'OUTPUT_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'PRIVACY_CONTROLLER_NAME', 'PRIVACY_CONTACT_EMAIL', 'PRIVACY_HOSTING_REGION']) if (!get(name).trim()) missing.push(fields.get(name).label);
            for (const name of ['PUBLIC_URL', 'OUTPUT_PUBLIC_URL']) if (get(name) && !get(name).startsWith('https://')) missing.push(fields.get(name).label + ': è richiesto HTTPS');
            if (get('PRIVACY_REVIEWED') !== '1') missing.push('Verifica dell’informativa privacy');
        }
        if (get('DISCORD_ANNOUNCEMENTS_ENABLED') === '1') for (const name of ['PUBLIC_URL', 'DISCORD_GUILD_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID']) if (!get(name)) missing.push(fields.get(name).label);
        return missing;
    };
    return {
        events,
        get: name => valueOf(name),
        needsSetup: () => !completedAt,
        public() {
            return {
                needsSetup: !completedAt, completedAt, revision,
                missing: requirements(values),
                fields: installationFields.map(field => ({ ...field,
                    value: field.kind === 'secret' ? '' : valueOf(field.name),
                    configured: !!valueOf(field.name),
                    source: Object.hasOwn(values, field.name) ? 'app' : environment[field.name] !== undefined ? 'environment' : 'default'
                }))
            };
        },
        update(patch = {}) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings');
            const candidate = { ...values };
            if (patch.values !== undefined && (!patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values))) throw new Error('Invalid settings');
            for (const [name, input] of Object.entries(patch.values || {})) {
                const field = fields.get(name);
                if (!field) throw new Error('Unsupported application setting');
                if (typeof input !== 'string' && typeof input !== 'boolean' && typeof input !== 'number') throw new Error('Invalid value: ' + field.label);
                let value = typeof input === 'boolean' ? (input ? '1' : '0') : String(input).trim();
                if (value.length > (field.kind === 'textarea' ? 4000 : 2000)) throw new Error('Value too long: ' + field.label);
                if (field.kind === 'secret' && !value) continue; // blank means keep; clearing is explicit
                if (field.kind === 'boolean' && !['0', '1'].includes(value)) throw new Error('Invalid choice: ' + field.label);
                if (field.kind === 'number' && (!/^\d+$/.test(value) || Number(value) < field.min || Number(value) > field.max)) throw new Error(`${field.label}: ${field.min}–${field.max}`);
                if (value && field.kind === 'id' && !/^\d{17,20}$/.test(value)) throw new Error('Invalid Discord ID: ' + field.label);
                if (value && field.kind === 'ids') {
                    const ids = value.split(',').map(id => id.trim());
                    if (!ids.every(id => /^\d{17,20}$/.test(id))) throw new Error('Invalid Discord role IDs: ' + field.label);
                    value = [...new Set(ids)].join(',');
                }
                if (value && field.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Invalid privacy contact email');
                if (value && field.kind === 'origin') {
                    try {
                        const url = new URL(value);
                        value = value.replace(/\/+$/, '');
                        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error();
                    } catch { throw new Error(field.label + ': inserisci un’origine HTTP(S), senza percorso o credenziali'); }
                }
                candidate[name] = value;
            }
            for (const option of ['clearSecrets', 'resetToEnvironment']) {
                if (patch[option] !== undefined && !Array.isArray(patch[option])) throw new Error('Invalid settings action');
                for (const name of patch[option] || []) {
                    if (!fields.has(name) || (option === 'clearSecrets' && fields.get(name).kind !== 'secret')) throw new Error('Unsupported settings action');
                    if (option === 'clearSecrets') candidate[name] = ''; else delete candidate[name];
                }
            }
            const get = name => valueOf(name, candidate);
            if (get('PUBLIC_URL') && get('OUTPUT_PUBLIC_URL') && new URL(get('PUBLIC_URL')).hostname === new URL(get('OUTPUT_PUBLIC_URL')).hostname) throw new Error('Regia e output devono avere hostname differenti');
            if (['DISCORD_ALLOWED_ROLE_IDS', 'DISCORD_OPERATOR_ROLE_IDS', 'DISCORD_ADMIN_ROLE_IDS'].some(name => get(name)) && !get('DISCORD_GUILD_ID')) throw new Error('I ruoli Discord richiedono l’ID del server');
            const missing = requirements(candidate);
            if (patch.complete === true && missing.length) throw new Error('Completa: ' + missing.join('; '));
            const changed = installationFields.filter(field => valueOf(field.name) !== get(field.name)).map(field => field.name);
            const nextCompleted = patch.complete === true ? new Date().toISOString() : completedAt;
            const encoded = Object.fromEntries(Object.entries(candidate).map(([name, value]) => [name, fields.get(name).kind === 'secret' ? seal(value) : value]));
            writeJson(file, { version: 1, values: encoded, completedAt: nextCompleted });
            values = candidate; completedAt = nextCompleted; revision++;
            events.emit('changed', changed);
            return this.public();
        }
    };
}
