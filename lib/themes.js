import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { config } from './config.js';
import { emptyQuestion } from './store.js';

const MAX_FILES = 20000;
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

export function safeThemeName(name) {
    return String(name || '').replace(/[^A-Za-z0-9 ._()+-]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 80);
}

export function themeDir(name) {
    const safe = safeThemeName(name);
    if (!safe) return null;
    // the community's own theme first, then the global one (multi-tenant platform)
    for (const root of [config.themesDir, config.sharedThemesDir]) {
        if (!root) continue;
        const dir = path.join(root, safe);
        if (fs.existsSync(path.join(dir, 'default.html'))) return dir;
    }
    return null;
}

/** A global theme (shared by every community) that this community has not replaced with its own. */
export function isGlobalTheme(name) {
    const safe = safeThemeName(name);
    return !!(safe && config.sharedThemesDir && !fs.existsSync(path.join(config.themesDir, safe, 'default.html')) &&
        fs.existsSync(path.join(config.sharedThemesDir, safe, 'default.html')));
}

/**
 * The folder of the community's own copy of a theme, made on the first change of a global theme (money tree,
 * questions...): a change never touches the global theme, so it never reaches the other communities.
 */
export function ownThemeDir(name) {
    const safe = safeThemeName(name);
    if (!safe) return null;
    if (isGlobalTheme(safe)) {
        fs.cpSync(path.join(config.sharedThemesDir, safe), path.join(config.themesDir, safe), { recursive: true });
    }
    return themeDir(safe);
}

/** Resolves a file inside a theme, refusing anything that would leave the theme folder. */
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ---------------------------------------------------------------------------------------------- shared fonts
// Fonts a theme asks for but does not ship are taken from here: the fonts bundled with the platform (public/fonts,
// e.g. Roadgeek 2014 for Clocked) and any font the owner adds to data/fonts (valid for every theme).
const FONT_EXT = /\.(ttf|otf|woff2?|eot)$/i;
const FONT_DIRS = [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts'), path.join(config.dataDir, 'fonts')];
try { fs.mkdirSync(FONT_DIRS[1], { recursive: true }); } catch { /* read-only data folder */ }
let fontLibrary = null, fontLibraryTime = 0;
function fontLibraryMap() {
    if (fontLibrary && Date.now() - fontLibraryTime < 60000) return fontLibrary;
    const map = new Map();
    const walk = (dir, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && depth < 3) walk(full, depth + 1);
            else if (e.isFile() && (FONT_EXT.test(e.name) || /\.svg$/i.test(e.name))) {
                // the owner's fonts (data/fonts, scanned last) take precedence over the bundled ones
                map.set(e.name.toLowerCase(), full);
            }
        }
    };
    FONT_DIRS.forEach(d => walk(d, 0));
    fontLibrary = map; fontLibraryTime = Date.now();
    return map;
}

/**
 * The file a theme page asks for: the exact path, else the same path ignoring upper/lower case (theme packs made on
 * Windows often differ in case, which Linux does not forgive), else - for fonts - a copy from the shared fonts.
 * Never outside the theme folder (or the shared fonts).
 */
export function findThemeFile(root, relative) {
    const exact = resolveInside(root, relative);
    if (!exact) return null;
    if (isFile(exact)) return exact;

    let current = root;
    for (const part of String(relative).split(/[\\/]+/).filter(Boolean)) {
        let entries;
        try { entries = fs.readdirSync(current); } catch { current = null; break; }
        const match = entries.find(e => e.toLowerCase() === part.toLowerCase());
        if (!match) { current = null; break; }
        current = path.join(current, match);
    }
    if (current && isFile(current) && resolveInside(root, path.relative(root, current))) return current;

    const name = path.basename(String(relative)).toLowerCase();
    const inFontsFolder = /(^|[\\/])fonts[\\/]/i.test(String(relative));
    if (FONT_EXT.test(name) || (inFontsFolder && /\.svg$/i.test(name))) {
        const hit = fontLibraryMap().get(name);
        if (hit && isFile(hit)) return hit;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------- @font-face repairs
/**
 * In CSS an unquoted font name may not contain a word starting with a digit: "font-family: Roadgeek 2014 Series B"
 * is invalid, and the browser drops the whole @font-face (it only worked for the theme's author because the font was
 * installed on their computer). This returns the same declarations with the name quoted and the file paths made
 * relative to the theme page, to be added to the output. Cached until a stylesheet of the theme changes.
 */
const fontFixCache = new Map();
export function fontFaceFixes(themeDirPath) {
    const stylesDir = path.join(themeDirPath, 'Styles');
    let files = [];
    try { files = fs.readdirSync(stylesDir).filter(f => /\.css$/i.test(f)); } catch { return ''; }
    const stamp = files.map(f => { try { return f + fs.statSync(path.join(stylesDir, f)).mtimeMs; } catch { return f; } }).join('|');
    const cached = fontFixCache.get(themeDirPath);
    if (cached && cached.stamp === stamp) return cached.css;

    const rules = [];
    for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(path.join(stylesDir, f), 'utf8'); } catch { continue; }
        for (const block of text.match(/@font-face\s*{[^}]*}/gi) || []) {
            const family = (block.match(/font-family\s*:\s*([^;}]+)/i) || [])[1]?.trim();
            if (!family || /^['"]/.test(family) || !/(^|\s)\d/.test(family)) continue;
            const src = (block.match(/src\s*:\s*([^;}]+)/i) || [])[1];
            if (!src) continue;
            // url('../Fonts/x.ttf') is relative to Styles/: make it relative to the page (theme root)
            const fixedSrc = src.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
                if (/^(data:|https?:|\/)/i.test(u)) return m;
                const rel = path.posix.normalize(path.posix.join('Styles', u));
                return rel.startsWith('..') ? m : `url('${rel.replace(/'/g, "%27")}')`;
            });
            const extra = ['font-weight', 'font-style', 'font-stretch', 'unicode-range']
                .map(k => (block.match(new RegExp(k + '\\s*:\\s*([^;}]+)', 'i')) || [])[1]).map((v, i) => v ? ` ${['font-weight', 'font-style', 'font-stretch', 'unicode-range'][i]}: ${v.trim()};` : '').join('');
            rules.push(`@font-face { font-family: '${family.replace(/'/g, "\\'")}'; src: ${fixedSrc.trim()};${extra} }`);
        }
    }
    const css = rules.length ? `\n<style id="mc-font-fixes">\n${rules.join('\n')}\n</style>` : '';
    fontFixCache.set(themeDirPath, { stamp, css });
    return css;
}

export function resolveInside(root, relative) {
    const target = path.resolve(root, '.' + path.sep + String(relative || ''));
    return target === root || target.startsWith(root + path.sep) ? target : null;
}

export async function listThemes() {
    const themes = [];
    const seen = new Set();
    // the community's themes, then the global ones it has not replaced (multi-tenant platform)
    for (const [root, global] of [[config.themesDir, false], [config.sharedThemesDir, true]]) {
        if (!root) continue;
        let entries = [];
        try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || seen.has(e.name)) continue;
            const dir = path.join(root, e.name);
            if (!fs.existsSync(path.join(dir, 'default.html'))) continue;
            seen.add(e.name);
            const stat = await fsp.stat(dir);
            // Clocked 2009 (US): the question clock lives in Scripts/TimerControl.js
            const clocked = fs.existsSync(path.join(dir, 'Scripts', 'TimerControl.js'));
            themes.push({ name: e.name, updated: stat.mtime.toISOString(), format: clocked ? 'clocked' : 'classic', uploadedBy: global ? null : owners[e.name]?.by ?? null, global });
        }
    }
    return themes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------------------------- who uploaded each theme
// data/theme-owners.json: { "<theme>": { by, at } }. Operators may replace or delete only the themes they uploaded;
// themes without an owner (installed before, or by hand) are for administrators only.
const OWNERS_FILE = path.join(config.dataDir, 'theme-owners.json');
let owners = {};
try { owners = JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8')); } catch { /* none yet */ }
function saveOwners() {
    const tmp = OWNERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(owners, null, 1));
    fs.renameSync(tmp, OWNERS_FILE);
}
export const themeOwner = name => owners[name] ?? null;
export function setThemeOwner(name, user) { owners[name] = { by: user, at: new Date().toISOString() }; saveOwners(); }
function forgetThemeOwner(name) { if (owners[name]) { delete owners[name]; saveOwners(); } }

export async function deleteTheme(name) {
    // only the community's own themes: a global theme is managed by the platform administrator
    const safe = safeThemeName(name);
    const dir = safe && path.join(config.themesDir, safe);
    if (!dir || !fs.existsSync(path.join(dir, 'default.html'))) return false;
    await fsp.rm(dir, { recursive: true, force: true });
    forgetThemeOwner(name);
    return true;
}

// ---------------------------------------------------------------------------------------------- upload

function openZip(file) {
    return new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => err ? reject(err) : resolve(zip)));
}

/**
 * Extracts an uploaded zip into a temporary folder with strict checks (no absolute paths, no "..",
 * no symlinks, size and file-count limits), then installs every folder that contains a default.html
 * as a theme. A zip may hold one theme or a whole pack of themes.
 */
export async function installThemeZip(zipPath, { overwrite = false, mayReplace = () => true } = {}) {
    const work = path.join(config.tmpDir, 'extract-' + crypto.randomBytes(6).toString('hex'));
    await fsp.mkdir(work, { recursive: true });
    const maxBytes = config.maxUploadMb * 1024 * 1024 * 4; // uncompressed limit
    let total = 0, files = 0;

    try {
        const zip = await openZip(zipPath);
        await new Promise((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', entry => {
                const name = entry.fileName.replace(/\\/g, '/');
                const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (mode === 0o120000) { zip.readEntry(); return; } // symlink: skipped
                if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
                    zip.close(); reject(new Error(`Unsafe path in zip: ${name}`)); return;
                }
                if (name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store')) { zip.readEntry(); return; }

                const target = path.join(work, name);
                if (!target.startsWith(work + path.sep)) { zip.close(); reject(new Error(`Unsafe path in zip: ${name}`)); return; }
                if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }

                if (++files > MAX_FILES) { zip.close(); reject(new Error('Too many files in the zip')); return; }
                total += entry.uncompressedSize;
                if (total > maxBytes) { zip.close(); reject(new Error('The zip is too large once extracted')); return; }

                fs.mkdirSync(path.dirname(target), { recursive: true });
                zip.openReadStream(entry, (err, stream) => {
                    if (err) { reject(err); return; }
                    const out = fs.createWriteStream(target);
                    stream.on('error', reject);
                    out.on('error', reject);
                    out.on('finish', () => zip.readEntry());
                    stream.pipe(out);
                });
            });
            zip.readEntry();
        });

        // Every folder with a default.html is a theme (the zip root itself included)
        const found = [];
        const walk = async (dir, depth) => {
            if (fs.existsSync(path.join(dir, 'default.html'))) { found.push(dir); return; }
            if (depth > 6) return;
            for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
                if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
            }
        };
        await walk(work, 0);
        if (found.length === 0) throw new Error('No theme found: the zip must contain a folder with default.html');

        // Replacing: every theme of the pack that already exists must be replaceable by this user, checked before
        // anything is installed (so a pack is never installed halfway)
        if (overwrite) {
            const refused = found.map(dir => safeThemeName(dir === work ? path.parse(zipPath).name : path.basename(dir)) || 'theme')
                .filter(name => fs.existsSync(path.join(config.themesDir, name)) && !mayReplace(name));
            if (refused.length) throw new Error(`Only an administrator, or who uploaded it, can replace: ${refused.join(', ')}. Upload without "Replace" to add a copy.`);
        }
        const installed = [];
        for (const dir of found) {
            let name = safeThemeName(dir === work ? path.parse(zipPath).name : path.basename(dir)) || 'theme';
            let dest = path.join(config.themesDir, name);
            if (fs.existsSync(dest)) {
                if (overwrite) await fsp.rm(dest, { recursive: true, force: true });
                else {
                    let n = 2;
                    while (fs.existsSync(path.join(config.themesDir, `${name} (${n})`))) n++;
                    name = `${name} (${n})`;
                    dest = path.join(config.themesDir, name);
                }
            }
            await fsp.rename(dir, dest);
            installed.push(name);
        }
        return installed;
    } finally {
        await fsp.rm(work, { recursive: true, force: true }).catch(() => { });
        await fsp.rm(zipPath, { force: true }).catch(() => { });
    }
}

// ---------------------------------------------------------------------------------------------- questions XML

function decodeXml(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

function encodeXml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Reads Questions/questions.xml or switchQuestions.xml of a theme (the game's own format). */
export function readThemeQuestions(theme, file) {
    const dir = themeDir(theme);
    const result = Array.from({ length: 15 }, emptyQuestion);
    if (!dir) return result;
    const full = path.join(dir, 'Questions', file);
    if (!fs.existsSync(full)) return result;

    const xml = fs.readFileSync(full, 'utf8');
    const blocks = [...xml.matchAll(/<question\b[^>]*>([\s\S]*?)<\/question>/gi)].map(m => m[1]);
    blocks.slice(0, 15).forEach((b, i) => {
        const tag = t => { const m = b.match(new RegExp(`<${t}\\b([^>]*)>([\\s\\S]*?)</${t}>`, 'i')); return m ? { attrs: m[1], text: decodeXml(m[2]).trim() } : null; };
        const q = emptyQuestion();
        q.category = tag('category')?.text ?? '';
        q.text = (tag('text')?.text ?? '').replace(/\+\+\+\+/g, '\n');
        ['a', 'b', 'c', 'd'].forEach((l, k) => {
            const a = tag(l);
            q.answers[k] = a?.text ?? '';
            if (a && /correct\s*=\s*["']yes["']/i.test(a.attrs)) q.correct = k;
        });
        result[i] = q;
    });
    return result;
}

/** Writes the questions back into the theme, keeping everything else (e.g. the Fastest Finger block). */
export function writeThemeQuestions(theme, file, questions) {
    const dir = ownThemeDir(theme);
    if (!dir) throw new Error('Theme not found');
    const full = path.join(dir, 'Questions', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    let xml = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '<questions>\n</questions>\n';
    xml = xml.replace(/\s*<question\b[^>]*>[\s\S]*?<\/question>/gi, '');
    const body = questions.map(q =>
        `\n\t<question>\n\t\t<category>${encodeXml(q.category)}</category>\n\t\t<text>${encodeXml(q.text.replace(/\r?\n/g, '++++'))}</text>\n` +
        ['a', 'b', 'c', 'd'].map((l, k) => `\t\t<${l} correct="${k === q.correct ? 'yes' : 'no'}">${encodeXml(q.answers[k])}</${l}>`).join('\n') +
        `\n\t</question>`).join('');
    xml = /<questions\b[^>]*>/i.test(xml) ? xml.replace(/(<questions\b[^>]*>)/i, `$1${body}`) : `<questions>${body}\n</questions>\n`;
    fs.writeFileSync(full, xml);
}

// ---------------------------------------------------------------------------------------------- klaxon

/** A klaxon/hooter/siren sound shipped with the theme, as a URL relative to default.html. */
export function findThemeKlaxon(theme) {
    const dir = themeDir(theme);
    if (!dir) return null;
    const sounds = path.join(dir, 'Sounds');
    if (!fs.existsSync(sounds)) return null;
    const file = fs.readdirSync(sounds).find(f =>
        AUDIO_EXT.has(path.extname(f).toLowerCase()) && /klaxon|hooter|siren/i.test(f));
    return file ? 'Sounds/' + encodeURIComponent(file) : null;
}
