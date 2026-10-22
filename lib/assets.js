import fs from 'node:fs';
import path from 'node:path';
import { themeDir } from './themes.js';

/**
 * Which images a theme really uses (same rules as the desktop app, verified on the stock themes):
 * - lifelines: the <img> layers of each lifeline's money tree block in default.html, keeping only the layers
 *   visible at rest according to the theme's CSS and inline styles (opacity 0 / display none / visibility hidden,
 *   also through hidden containers); the "used" cross is kept apart;
 * - money tree background and current-level bar: from the theme's CSS, then the stock file names.
 * Paths are relative to the theme folder, with forward slashes.
 */
const LIFELINES = ['ff', 'paf', 'ata', 'stq', 'dd', 'ate'];
const cache = new Map();

export function themeAssets(theme) {
    const dir = themeDir(theme);
    if (!dir) return null;
    const stamp = fs.statSync(path.join(dir, 'default.html')).mtimeMs;
    const hit = cache.get(dir);
    if (hit && hit.stamp === stamp) return hit.value;
    const value = analyse(dir);
    cache.set(dir, { stamp, value });
    return value;
}

function listCss(dir) {
    const out = [];
    const walk = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory() && depth < 4) walk(full, depth + 1);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.css')) out.push(full);
        }
    };
    walk(dir, 0);
    return out.sort();
}

function attr(tag, name) {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? (m[1] ?? m[2]) : null;
}

function normalize(src) {
    let s = src.split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch { /* keep */ }
    return s.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
}

function analyse(dir) {
    const report = [];
    const cssFiles = listCss(dir);
    const rules = [];
    const cssTexts = [];
    for (const file of cssFiles) {
        const text = fs.readFileSync(file, 'utf8');
        cssTexts.push({ file, text });
        const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            for (const sel of m[1].split(',')) {
                const last = sel.trim().split(/[\s>+~]+/).pop();
                if (!last || last.includes(':')) continue;
                rules.push({ last, body: m[2] });
            }
        }
    }

    const apply = (body, st) => {
        for (const m of body.matchAll(/(?<![\w-])(opacity|display|visibility)\s*:\s*([^;]+)/gi)) {
            const v = m[2].replace('!important', '').trim().toLowerCase();
            const p = m[1].toLowerCase();
            if (p === 'opacity') { const n = parseFloat(v); if (!Number.isNaN(n)) st.opacity = v.endsWith('%') ? n / 100 : n; }
            else st[p] = v;
        }
    };
    const hidden = tag => {
        const classes = (attr(tag, 'class') || '').split(/\s+/).filter(Boolean);
        const st = {};
        for (const r of rules) {
            if (classes.some(c => new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(r.last))) apply(r.body, st);
        }
        apply(attr(tag, 'style') || '', st);
        return (st.opacity !== undefined && st.opacity <= 0.01) || st.display === 'none' || st.visibility === 'hidden';
    };

    const html = fs.readFileSync(path.join(dir, 'default.html'), 'utf8');
    const holders = [...html.matchAll(/<div\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi)]
        .map(m => ({ start: m.index, end: m.index + m[0].length, id: LIFELINES.find(id => new RegExp(`(^|\\s)${id}LifeLine(\\s|$)`).test(m[1])) }))
        .filter(h => h.id);

    const blockEnd = start => {
        let depth = 1;
        const re = /<div\b|<\/div\s*>/gi;
        re.lastIndex = start;
        let m;
        while ((m = re.exec(html))) {
            depth += m[0].startsWith('</') ? -1 : 1;
            if (depth === 0) return m.index;
        }
        return html.length;
    };

    const lifelines = {};
    const order = [];
    holders.forEach((h, i) => {
        if (lifelines[h.id]) return;
        order.push(h.id);
        const end = Math.min(blockEnd(h.end), i + 1 < holders.length ? holders[i + 1].start : html.length);
        const block = html.slice(h.end, end);
        const layers = [];
        let used = null;
        const stack = [];
        for (const t of block.matchAll(/<div\b[^>]*>|<\/div\s*>|<img\b[^>]*>/gi)) {
            const tag = t[0];
            if (tag.startsWith('</')) { stack.pop(); continue; }
            if (/^<div/i.test(tag)) { stack.push(hidden(tag)); continue; }
            const src = attr(tag, 'src');
            const cls = attr(tag, 'class') || '';
            if (!src) continue;
            const p = normalize(src);
            if (/used/i.test(cls)) { used = p; continue; }
            if (stack.some(Boolean) || hidden(tag)) { report.push(`[${h.id}] skipped hidden layer ${p}`); continue; }
            layers.push(p);
        }
        lifelines[h.id] = { layers, used };
        report.push(`[${h.id}] layers: ${layers.join(' + ') || '(none)'}`);
    });

    const cssBackground = cls => {
        const rule = new RegExp(`(^|[},\\s])\\.${cls}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'g');
        for (const { file, text } of cssTexts) {
            for (const m of text.matchAll(rule)) {
                const u = m[3].match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
                if (!u) continue;
                const full = path.resolve(path.dirname(file), normalize(u[1]));
                if (full.startsWith(dir + path.sep)) return path.relative(dir, full).replace(/\\/g, '/');
            }
        }
        return null;
    };
    const existing = rel => rel && fs.existsSync(path.join(dir, rel)) ? rel : null;

    return {
        lifelines,
        order,
        treeBackground: existing(cssBackground('moneyTreeDiv')) || existing('Images/money_tree_background.png'),
        follower: existing(cssBackground('moneyTreeCurrentLevelTd')) || existing('Images/follower.png'),
        logo: existing('Images/logo.png'),
        background: existing('Images/Millionaire_Background.png') || existing('Images/background.png'),
        report
    };
}
