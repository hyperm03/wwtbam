import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Branding of the community this platform serves: name, logo, invitation texts, default place of the events.
 * Read from data/branding.json (written by the super-admin panel of the multi-tenant platform, editable later by
 * the community). Without that file everything stays TPH, as on a single installation.
 */
export const TPH = {
    name: 'TPH',
    logo: '/static/brand/tph-circle',                  // + -64/-128/-256/-512.png
    presents: 'TPH presents',
    locationName: 'TPH Discord server',
    locationUrl: 'https://discord.gg/QZMmsRTKrw',
    joinLabel: 'Join the TPH Discord server',
    footer: 'a TPH fan event'
};

const FILE = path.join(config.dataDir, 'branding.json');
let cache = null, stamp = -1;

export function branding() {
    let mtime = 0;
    try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* no file: TPH */ }
    if (cache && mtime === stamp) return cache;
    let custom = {};
    if (mtime) { try { custom = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { custom = {}; } }
    const clean = Object.fromEntries(Object.entries(custom).filter(([k, v]) => k in TPH && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)]));
    // only local paths for the logo
    if (clean.logo && !/^\/(static|branding-assets)\/[\w\-/.]+$/.test(clean.logo)) delete clean.logo;
    if (clean.locationUrl && !/^https?:\/\//i.test(clean.locationUrl)) clean.locationUrl = '';
    cache = { ...TPH, ...clean };
    stamp = mtime;
    return cache;
}

export const publicBranding = () => ({ ...branding(), tenant: config.tenantId });
