import { branding } from './branding.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Calendar of scheduled show events, shown on the public home page and managed from the control panel.
 * Stored in data/schedule.json (works with or without MySQL).
 *
 * An event: { id, slug (invitation code of the public page /e/<slug>), title, start (ISO, UTC), duration (minutes),
 *             room (linked show id or ''), description, link (optional, e.g. a stream), live (live show or not),
 *             location + locationUrl (default: the TPH Discord server), status, createdBy, updatedAt }
 * status: 'scheduled' | 'cancelled' (live / ended are worked out from the time and the linked show).
 */
const FILE = path.join(config.dataDir, 'schedule.json');
// Where the shows take place, unless an event says otherwise
// the default place of the events follows the community's branding (TPH on a single installation)
export const DEFAULT_LOCATION = { get name() { return branding().locationName; }, get url() { return branding().locationUrl; } };

/** Invitation code of the public event page /e/<code>: random, so the page is reachable only through the link. */
const newSlug = () => crypto.randomBytes(8).toString('base64url');

let events = [];
try { events = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first start */ }
// Events created before invitations existed get their code now
if (events.some(e => !e.slug)) {
    for (const e of events) {
        e.slug ||= newSlug();
        e.location ??= DEFAULT_LOCATION.name;
        e.locationUrl ??= DEFAULT_LOCATION.url;
        e.live ??= true;
    }
    fs.writeFileSync(FILE, JSON.stringify(events, null, 2));
}

function persist() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(events, null, 2));
    fs.renameSync(tmp, FILE);
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function clean(input, previous = {}) {
    const start = new Date(input.start ?? previous.start);
    if (Number.isNaN(start.getTime())) throw new Error('Enter a valid date and time');
    const title = str(input.title ?? previous.title, 120);
    if (!title) throw new Error('Enter a title');
    const url = v => { let u = str(v, 400); if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u; return u; };
    const link = url(input.link ?? previous.link ?? '');
    return {
        title,
        start: start.toISOString(),
        duration: Math.min(24 * 60, Math.max(5, Math.round(Number(input.duration ?? previous.duration) || 60))),
        room: str(input.room ?? previous.room ?? '', 64),
        description: str(input.description ?? previous.description ?? '', 2000),
        link,
        // Live show (in diretta) or not
        live: input.live !== undefined ? !!input.live : previous.live !== false,
        location: str(input.location ?? previous.location ?? DEFAULT_LOCATION.name, 120),
        locationUrl: url(input.locationUrl ?? previous.locationUrl ?? DEFAULT_LOCATION.url),
        public: input.public !== undefined ? !!input.public : previous.public !== false,
        discordNotify: input.discordNotify !== undefined ? input.discordNotify === true : previous.discordNotify === true,
        status: ['scheduled', 'cancelled'].includes(input.status) ? input.status : (previous.status || 'scheduled')
    };
}

export const schedule = {
    list: () => [...events].sort((a, b) => a.start.localeCompare(b.start)),
    get: id => events.find(e => e.id === id) ?? null,
    bySlug: slug => events.find(e => e.slug === slug) ?? null,

    create(input, user) {
        const e = { id: crypto.randomBytes(6).toString('hex'), slug: newSlug(), ...clean(input), createdBy: user, updatedAt: new Date().toISOString() };
        events.push(e);
        persist();
        return e;
    },

    update(id, input, user) {
        const i = events.findIndex(e => e.id === id);
        if (i < 0) throw new Error('Event not found');
        events[i] = { ...events[i], ...clean(input, events[i]), updatedBy: user, updatedAt: new Date().toISOString() };
        persist();
        return events[i];
    },

    remove(id) {
        const before = events.length;
        events = events.filter(e => e.id !== id);
        if (events.length !== before) persist();
        return events.length !== before;
    },

    /** When a show is deleted its events stay in the calendar, without the link. */
    unlinkRoom(roomId) {
        let changed = false;
        for (const e of events) if (e.room === roomId) { e.room = ''; changed = true; }
        if (changed) persist();
    }
};

/**
 * Where an event stands now: 'cancelled', 'live' (the linked show is on air, or no linked show and within its time),
 * 'ended', or 'upcoming'.
 */
export function eventState(e, liveRooms) {
    if (e.status === 'cancelled') return 'cancelled';
    const now = Date.now(), start = Date.parse(e.start), end = start + e.duration * 60000;
    if (e.room && liveRooms.has(e.room) && now >= start - 30 * 60000 && now <= end + 3 * 3600000) return 'live';
    if (!e.room && now >= start && now <= end) return 'live';
    if (now > end) return 'ended';
    return 'upcoming';
}
