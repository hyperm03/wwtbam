import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Layouts of the platform's own screens, edited with the Layout editor and valid for the whole installation:
 *   host   - host screen        player - player screen        ff - Fastest Finger console
 * A layout is a set of corrections per element (data-edit name): position, size, text style, colours, picture,
 * visibility... stored in data/layouts.json (the pages themselves are never changed, so updates keep them) and
 * turned into CSS sent live to every open screen and console.
 */
export const TARGETS = ['host', 'player', 'ff'];
const FILE = path.join(config.dataDir, 'layouts.json');
export const ASSET_DIR = path.join(config.dataDir, 'layout-assets');
fs.mkdirSync(ASSET_DIR, { recursive: true });

let layouts = { host: {}, player: {}, ff: {} };
try { layouts = { ...layouts, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first start */ }

function persist() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(layouts, null, 1));
    fs.renameSync(tmp, FILE);
}

// ---------------------------------------------------------------------------------------------- validation
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : undefined; };
const colour = v => (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/i.test(v.trim()) ? v.trim() : undefined);
const font = v => (typeof v === 'string' && /^[\w\s.,'"-]{1,120}$/.test(v) ? v.trim() : undefined);
const asset = v => (typeof v === 'string' && /^\/layout-assets\/[a-f0-9]{16,64}\.(png|jpe?g|gif|webp|svg)$/i.test(v) ? v : undefined);

/** Only known properties with safe values are kept (the CSS is built from them, never copied as text). */
function cleanProps(p) {
    const out = {
        left: num(p.left, -4000, 6000), top: num(p.top, -4000, 6000), width: num(p.width, 0, 6000), height: num(p.height, 0, 6000),
        fontFamily: font(p.fontFamily), fontSize: num(p.fontSize, 4, 400),
        fontWeight: ['normal', 'bold', '300', '400', '500', '600', '700', '800', '900'].includes(String(p.fontWeight)) ? String(p.fontWeight) : undefined,
        fontStyle: ['normal', 'italic'].includes(p.fontStyle) ? p.fontStyle : undefined,
        textAlign: ['left', 'center', 'right'].includes(p.textAlign) ? p.textAlign : undefined,
        textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'].includes(p.textTransform) ? p.textTransform : undefined,
        letterSpacing: num(p.letterSpacing, -20, 50),
        color: colour(p.color), backgroundColor: colour(p.backgroundColor), borderColor: colour(p.borderColor),
        borderRadius: num(p.borderRadius, 0, 2000),
        backgroundImage: p.backgroundImage === 'none' ? 'none' : asset(p.backgroundImage),
        opacity: num(p.opacity, 0, 1), zIndex: num(p.zIndex, -100, 1000),
        hidden: p.hidden === true ? true : undefined
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

const KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;

// ---------------------------------------------------------------------------------------------- CSS
function cssFor(key, p) {
    const sel = `[data-edit="${key}"]`;
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
    return d.length ? `${sel} { ${d.map(x => x + ' !important').join('; ')}; }` : '';
}

export const layoutStore = {
    get: target => layouts[target] ?? {},
    all: () => layouts,

    set(target, rules) {
        if (!TARGETS.includes(target)) throw new Error('Unknown screen');
        const clean = {};
        for (const [key, props] of Object.entries(rules || {})) {
            if (!KEY_RE.test(key) || !props || typeof props !== 'object') continue;
            const p = cleanProps(props);
            if (Object.keys(p).length) clean[key] = p;
        }
        layouts[target] = clean;
        persist();
        return clean;
    },

    css(target) {
        return Object.entries(layouts[target] ?? {}).map(([k, p]) => cssFor(k, p)).filter(Boolean).join('\n');
    },

    /** A picture uploaded in the editor: stored by content hash, served at /layout-assets/<hash>.<ext>. */
    saveAsset(buffer, originalName) {
        const ext = (path.extname(originalName).toLowerCase().replace('.jpeg', '.jpg')) || '.png';
        if (!['.png', '.jpg', '.gif', '.webp', '.svg'].includes(ext)) throw new Error('Use a PNG, JPG, GIF, WebP or SVG picture');
        if (ext === '.svg' && /<script|on\w+\s*=/i.test(buffer.toString('utf8'))) throw new Error('SVG pictures with scripts are not allowed');
        const name = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32) + ext;
        fs.writeFileSync(path.join(ASSET_DIR, name), buffer);
        return `/layout-assets/${name}`;
    }
};
