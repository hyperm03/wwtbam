import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config, installation } from './config.js';
import { readJson, writeJson } from './durable.js';
import { revokeAccount } from './sessions.js';

export const participantEvents = new EventEmitter();
const file = path.join(config.dataDir, 'participants.json');
const data = readJson(file, { accounts: {}, registrations: {} });
const persist = () => writeJson(file, data);
export const privacy = {
    get controller() { return installation.get('PRIVACY_CONTROLLER_NAME'); },
    get contact() { return installation.get('PRIVACY_CONTACT_EMAIL'); },
    get region() { return installation.get('PRIVACY_HOSTING_REGION'); },
    get policyVersion() { return installation.get('PRIVACY_POLICY_VERSION'); },
    get retentionDays() { return Math.min(90, Math.max(1, Number(installation.get('PARTICIPANT_RETENTION_DAYS')) || 30)); },
    get minAge() { return Math.max(18, Number(installation.get('PARTICIPANT_MIN_AGE')) || 18); },
    get reviewed() { return installation.get('PRIVACY_REVIEWED') === '1'; }
};
export const privacyReady = () => privacy.reviewed && !!privacy.controller.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(privacy.contact) && !!privacy.region.trim();
export const accountKey = discordId => crypto.createHmac('sha256', config.sessionSecret).update('discord-account:' + discordId).digest('hex');

export function upsertParticipant(key) {
    const now = new Date().toISOString();
    data.accounts[key] = { alias: '', createdAt: now, ...data.accounts[key], lastSeenAt: now, policyVersion: privacy.policyVersion, acknowledgedAt: now };
    persist();
    return { ...data.accounts[key] };
}
export const participant = key => data.accounts[key] ? { ...data.accounts[key] } : null;
export function setAlias(key, value) {
    if (!data.accounts[key]) throw new Error('Account not found');
    const alias = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (!alias) throw new Error('Choose a nickname; your real name is not required');
    data.accounts[key].alias = alias; persist();
    return { ...data.accounts[key] };
}
export function register(key, room, checkedIn = false) {
    const person = participant(key);
    if (!person?.alias) throw new Error('Choose a nickname first');
    data.registrations[room] ??= {};
    const before = data.registrations[room][key];
    data.registrations[room][key] = { registeredAt: before?.registeredAt || new Date().toISOString(), checkedInAt: checkedIn ? new Date().toISOString() : before?.checkedInAt || null };
    persist(); return data.registrations[room][key];
}
export const isCheckedIn = (key, room) => !!data.registrations[room]?.[key]?.checkedInAt;
export function unregister(key, room) { if (data.registrations[room]) delete data.registrations[room][key]; persist(); }
export function registrations(room) {
    return Object.entries(data.registrations[room] || {}).filter(([key]) => data.accounts[key]).map(([key, r]) => ({ reference: key.slice(0, 16), alias: data.accounts[key].alias, ...r }));
}
export function exportParticipant(key) {
    const result = { account: participant(key), registrations: Object.fromEntries(Object.entries(data.registrations).filter(([, rows]) => rows[key]).map(([room, rows]) => [room, rows[key]])) };
    participantEvents.emit('export', key, result); return result;
}
export function deleteParticipant(key) {
    delete data.accounts[key];
    for (const rows of Object.values(data.registrations)) delete rows[key];
    revokeAccount(key); persist(); participantEvents.emit('deleted', key);
}
export function purgeParticipants(now = Date.now()) {
    const cutoff = now - privacy.retentionDays * 86400000;
    for (const [key, person] of Object.entries(data.accounts)) if (!Number.isFinite(Date.parse(person.lastSeenAt)) || Date.parse(person.lastSeenAt) < cutoff) deleteParticipant(key);
    return Object.keys(data.accounts).length;
}
purgeParticipants();
setInterval(purgeParticipants, 3600000).unref();
installation.events.on('changed', names => { if (names.includes('PARTICIPANT_RETENTION_DAYS')) purgeParticipants(); });
