import fs from 'node:fs';
import path from 'node:path';

/**
 * Money tree settings stored in a theme's Scripts/Variables.js (port of the desktop VariablesFile):
 * only the specific assignments are edited; comments, other settings, line endings and the BOM stay as they are.
 */
const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const BOOL = '(?:true|false)';
const ARR = String.raw`\[(?:\s*` + STR + String.raw`\s*,?)*\s*\]`;
const LEVELS = 15;

export function variablesPath(themeDir) {
    return path.join(themeDir, 'Scripts', 'Variables.js');
}

function read(file) {
    const buf = fs.readFileSync(file);
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return { text: buf.subarray(bom ? 3 : 0).toString('utf8'), bom };
}

function write(file, text, bom) {
    const body = Buffer.from(text, 'utf8');
    fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
}

const jsString = v => JSON.stringify(String(v ?? ''));
const topRe = (name, value) => new RegExp(String.raw`(gameVariables\.` + name + String.raw`\s*=\s*)(` + value + ')');
const readTopString = (js, name) => { const m = js.match(topRe(name, STR)); return m ? JSON.parse(m[2]) : null; };
const readTopBool = (js, name) => js.match(topRe(name, BOOL))?.[2] === 'true';
const readTopInt = (js, name) => { const m = js.match(topRe(name, String.raw`\d+`)); return m ? Number(m[2]) : null; };
const readTopArray = (js, name) => {
    const m = js.match(topRe(name, ARR));
    const out = Array(LEVELS).fill('');
    if (m) [...m[2].matchAll(new RegExp(STR, 'g'))].slice(0, LEVELS).forEach((x, i) => { out[i] = JSON.parse(x[0]); });
    return out;
};

function replaceTop(js, name, value, replacement, required = true) {
    const re = topRe(name, value);
    if (!re.test(js)) {
        if (required) throw new Error(`${name} not found in Variables.js`);
        return js;
    }
    return js.replace(re, (_, lead) => lead + replacement);
}

function block(js, name) {
    const m = new RegExp(String.raw`(gameVariables\.` + name + String.raw`\s*=\s*\{)([\s\S]*?)(\}\s*;)`).exec(js);
    return m ? { start: m.index + m[1].length, body: m[2] } : null;
}
const readProp = (body, name) => { const m = body?.match(new RegExp(String.raw`\b` + name + String.raw`\s*:\s*(` + STR + ')')); return m ? JSON.parse(m[1]) : null; };
function replaceProp(body, name, value, replacement, required = true) {
    const re = new RegExp(String.raw`(\b` + name + String.raw`\s*:\s*)(` + value + ')');
    if (!re.test(body)) {
        if (required) throw new Error(`FormatOptions.${name} not found in Variables.js`);
        return body;
    }
    return body.replace(re, (_, lead) => lead + replacement);
}

/** Sets a boolean, or adds it on its own line right after the line assigning `after` (same indentation and line endings). */
function setOrAddBool(js, name, value, after, comment) {
    const existing = topRe(name, BOOL);
    if (existing.test(js)) return js.replace(existing, (_, lead) => lead + value);
    const anchor = new RegExp(String.raw`^([ \t]*)gameVariables\.` + after + String.raw`\s*=.*$`, 'm').exec(js);
    if (!anchor) return js;
    const nl = js.includes('\r\n') ? '\r\n' : '\n';
    let end = anchor.index + anchor[0].length;
    if (js[end - 1] === '\r') end--;
    return js.slice(0, end) + `${nl}${anchor[1]}gameVariables.${name} = ${value};\t\t/* ${comment} */` + js.slice(end);
}

export function loadMoneyTree(file) {
    const { text: js } = read(file);
    const amountsMatch = js.match(/gameVariables\.PrizeAmounts\s*=\s*\[([^\]]*)\]/);
    if (!amountsMatch) throw new Error('PrizeAmounts not found in Variables.js');
    const amounts = amountsMatch[1].split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
    const fo = block(js, 'FormatOptions');
    const so = block(js, 'SecondaryFormatOptions');
    const flags = ['Tree', 'LevelStrap', 'Win', 'TPM'].filter(f => new RegExp(String.raw`gameVariables\.SecondaryNumberFormat` + f + String.raw`\s*=\s*true`).test(js));
    const hasTop = /gameVariables\.UseTopPrizeText\s*=/.test(js);

    return {
        amounts: Array.from({ length: LEVELS }, (_, i) => amounts[i] ?? 0),
        localeCode: readTopString(js, 'LocaleCode') ?? 'en',
        style: readProp(fo?.body, 'style') ?? 'currency',
        currency: readProp(fo?.body, 'currency') ?? 'USD',
        currencyDisplay: readProp(fo?.body, 'currencyDisplay') ?? 'symbol',
        fractionDigits: Number(fo?.body.match(/\bminimumFractionDigits\s*:\s*(\d+)/)?.[1] ?? 0),
        alwaysGroup: readProp(fo?.body, 'useGrouping') === 'always',
        prefix: readTopString(js, 'NumberPrefix') ?? '',
        suffix: readTopString(js, 'NumberSuffix') ?? '',
        totalPrizeText: readTopString(js, 'TotalPrizeText') ?? '',
        millionaireText: readTopString(js, 'MillionaireText') ?? '',
        syncSecondary: true,
        secondary: so ? `${readProp(so.body, 'style') ?? '?'}, ${readProp(so.body, 'currency') ?? '?'}, ${readTopString(js, 'SecondaryLocaleCode') ?? '?'}` +
            (flags.length ? `  (enabled for: ${flags.join(', ')})` : '') : '',
        hasTopPrizeText: hasTop,
        useTopPrizeText: hasTop && readTopBool(js, 'UseTopPrizeText'),
        topPrizeFrom: readTopInt(js, 'TopPrizeQuestionNumber') ?? 15,
        topPrizeTexts: readTopArray(js, 'TopPrizeText'),
        useStrapText: hasTop && readTopBool(js, 'UseTopPrizeLevelStrapText'),
        strapFrom: readTopInt(js, 'TopPrizeLevelStrapQuestionNumber') ?? 15,
        strapTexts: readTopArray(js, 'TopPrizeLevelStrapText'),
        autoTopPrizeText: readTopBool(js, 'AutoTopPrizeText'),
        autoUpperCase: !/gameVariables\.AutoTopPrizeTextUpperCase\s*=\s*false/.test(js),
        // Clocked 2009 settings (only in Clocked themes)
        clocked: /gameVariables\.StartingBankedTime\s*=/.test(js) ? {
            startingBankedTime: readTopInt(js, 'StartingBankedTime') ?? 0,
            reduceAmountAfterTimeUp: readTopBool(js, 'ReduceAmountAfterTimeUp'),
            replaceFFwithDD: readTopBool(js, 'ReplaceFFwithDD'),
            replaceSTQwithATE: readTopBool(js, 'ReplaceSTQwithATE'),
            lifelineUnlockLevel: readTopInt(js, 'STQUnlockedLevel') ?? 6,
            showATAResultsInAnswers: readTopBool(js, 'ShowATAResultsInAnswers')
        } : null
    };
}

/** Validates what the control panel sends. */
export function cleanMoneyTree(c) {
    const s = (v, max = 80) => String(v ?? '').slice(0, max);
    const texts = a => Array.from({ length: LEVELS }, (_, i) => s(a?.[i], 60));
    const amounts = Array.from({ length: LEVELS }, (_, i) => Math.max(0, Number(c?.amounts?.[i]) || 0));
    const out = {
        amounts,
        localeCode: s(c?.localeCode, 20).trim() || 'en',
        style: c?.style === 'decimal' ? 'decimal' : 'currency',
        currency: s(c?.currency, 3).toUpperCase(),
        currencyDisplay: ['symbol', 'narrowSymbol', 'code', 'name'].includes(c?.currencyDisplay) ? c.currencyDisplay : 'symbol',
        fractionDigits: Math.min(4, Math.max(0, Math.round(Number(c?.fractionDigits) || 0))),
        alwaysGroup: !!c?.alwaysGroup,
        prefix: s(c?.prefix, 20), suffix: s(c?.suffix, 20),
        totalPrizeText: s(c?.totalPrizeText), millionaireText: s(c?.millionaireText),
        syncSecondary: c?.syncSecondary !== false,
        hasTopPrizeText: !!c?.hasTopPrizeText,
        useTopPrizeText: !!c?.useTopPrizeText,
        topPrizeFrom: Math.min(LEVELS, Math.max(1, Math.round(Number(c?.topPrizeFrom) || LEVELS))),
        topPrizeTexts: texts(c?.topPrizeTexts),
        useStrapText: !!c?.useStrapText,
        strapFrom: Math.min(LEVELS, Math.max(1, Math.round(Number(c?.strapFrom) || LEVELS))),
        strapTexts: texts(c?.strapTexts),
        autoTopPrizeText: !!c?.autoTopPrizeText,
        autoUpperCase: c?.autoUpperCase !== false,
        clocked: c?.clocked ? {
            // The game allows at most 405 seconds (6:45) of banked time
            startingBankedTime: Math.min(405, Math.max(0, Math.round(Number(c.clocked.startingBankedTime) || 0))),
            reduceAmountAfterTimeUp: !!c.clocked.reduceAmountAfterTimeUp,
            replaceFFwithDD: !!c.clocked.replaceFFwithDD,
            replaceSTQwithATE: !!c.clocked.replaceSTQwithATE,
            lifelineUnlockLevel: Math.min(15, Math.max(1, Math.round(Number(c.clocked.lifelineUnlockLevel) || 6))),
            showATAResultsInAnswers: !!c.clocked.showATAResultsInAnswers
        } : null
    };
    if (out.style === 'currency' && !/^[A-Z]{3}$/.test(out.currency)) throw new Error('Enter a three-letter currency code (e.g. EUR)');
    try { new Intl.NumberFormat(out.localeCode); } catch { throw new Error(`Invalid locale code: ${out.localeCode}`); }
    return out;
}

export const formatOptions = c => ({
    style: c.style, currency: c.currency, currencyDisplay: c.currencyDisplay,
    minimumFractionDigits: c.fractionDigits, useGrouping: c.alwaysGroup ? 'always' : 'auto'
});

/** Same function as in the bridge: number in words + currency, in the theme's language ("$1 MILLION", "1 MILIONE €"). */
export function autoTopPrizeText(amount, locale, opts, prefix, suffix, upper) {
    const words = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 2 }).format(amount);
    let text = words;
    if (opts?.style === 'currency' && opts.currency) {
        const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: opts.currency, currencyDisplay: opts.currencyDisplay || 'symbol' }).formatToParts(amount);
        const ci = parts.findIndex(p => p.type === 'currency');
        const ni = parts.findIndex(p => p.type === 'integer');
        if (ci >= 0) {
            const gap = ci < ni ? parts[ci + 1] : parts[ci - 1];
            const space = gap?.type === 'literal' ? gap.value : '';
            text = ci < ni ? parts[ci].value + space + words : words + space + parts[ci].value;
        }
    }
    text = (prefix || '') + text + (suffix || '');
    return upper === false ? text : text.toLocaleUpperCase(locale);
}

/** Preview: formatted amounts and, where they apply, the texts shown instead (automatic ones computed here). */
export function previewMoneyTree(c) {
    const opts = formatOptions(c);
    const fmt = new Intl.NumberFormat(c.localeCode, opts);
    const formatted = c.amounts.map(a => c.prefix + fmt.format(a) + c.suffix);
    const auto = c.autoTopPrizeText ? c.amounts.map(a => autoTopPrizeText(a, c.localeCode, opts, c.prefix, c.suffix, c.autoUpperCase)) : null;
    const topTexts = c.topPrizeTexts.map((t, i) => auto && i + 1 >= c.topPrizeFrom ? auto[i] : t);
    const strapTexts = c.strapTexts.map((t, i) => auto && i + 1 >= c.strapFrom ? auto[i] : t);
    const shown = formatted.map((f, i) => c.hasTopPrizeText && c.useTopPrizeText && i + 1 >= c.topPrizeFrom ? topTexts[i] : f);
    return { formatted, shown, topTexts, strapTexts };
}

export function saveMoneyTree(file, c) {
    const { text: original, bom } = read(file);
    const backup = file + '.bak';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

    // Automatic texts are also written into the arrays, so the theme shows them even without this platform
    const preview = previewMoneyTree(c);
    let js = original;
    js = replaceTop(js, 'PrizeAmounts', String.raw`\[[^\]]*\]`, '[' + c.amounts.map(a => String(Number(a))).join(',') + ']');
    js = replaceTop(js, 'LocaleCode', STR, jsString(c.localeCode));
    js = replaceTop(js, 'NumberPrefix', STR, jsString(c.prefix));
    js = replaceTop(js, 'NumberSuffix', STR, jsString(c.suffix));
    js = replaceTop(js, 'TotalPrizeText', STR, jsString(c.totalPrizeText));
    js = replaceTop(js, 'MillionaireText', STR, jsString(c.millionaireText));

    const fo = block(js, 'FormatOptions');
    if (!fo) throw new Error('FormatOptions not found in Variables.js');
    let body = fo.body;
    body = replaceProp(body, 'style', STR, jsString(c.style));
    body = replaceProp(body, 'currency', STR, jsString(c.currency));
    body = replaceProp(body, 'currencyDisplay', STR, jsString(c.currencyDisplay));
    body = replaceProp(body, 'minimumFractionDigits', NUM, String(c.fractionDigits));
    const grouping = new RegExp(String.raw`(\buseGrouping\s*:\s*)(?:` + STR + '|true|false)');
    if (grouping.test(body)) body = body.replace(grouping, (_, lead) => lead + jsString(c.alwaysGroup ? 'always' : 'auto'));
    else if (c.alwaysGroup) body = (js.includes('\r\n') ? '\r\n' : '\n') + '\t\tuseGrouping: "always",\t\t/* Added by Millionaire Web: always show the thousands separator. */' + body;
    js = js.slice(0, fo.start) + body + js.slice(fo.start + fo.body.length);

    if (c.hasTopPrizeText) {
        js = replaceTop(js, 'UseTopPrizeText', BOOL, String(c.useTopPrizeText), false);
        js = replaceTop(js, 'TopPrizeQuestionNumber', NUM, String(c.topPrizeFrom), false);
        js = replaceTop(js, 'TopPrizeText', ARR, '[' + preview.topTexts.map(jsString).join(',') + ']', false);
        js = replaceTop(js, 'UseTopPrizeLevelStrapText', BOOL, String(c.useStrapText), false);
        js = replaceTop(js, 'TopPrizeLevelStrapQuestionNumber', NUM, String(c.strapFrom), false);
        js = replaceTop(js, 'TopPrizeLevelStrapText', ARR, '[' + preview.strapTexts.map(jsString).join(',') + ']', false);
        js = setOrAddBool(js, 'AutoTopPrizeText', c.autoTopPrizeText, 'TopPrizeLevelStrapText',
            'Added by Millionaire Web: generate the top prize text from the amount, currency and language.');
        js = setOrAddBool(js, 'AutoTopPrizeTextUpperCase', c.autoUpperCase, 'AutoTopPrizeText',
            'Added by Millionaire Web: automatic top prize text in upper case.');
    }

    if (c.clocked) {
        js = replaceTop(js, 'StartingBankedTime', NUM, String(c.clocked.startingBankedTime), false);
        js = replaceTop(js, 'ReduceAmountAfterTimeUp', BOOL, String(c.clocked.reduceAmountAfterTimeUp), false);
        js = replaceTop(js, 'ReplaceFFwithDD', BOOL, String(c.clocked.replaceFFwithDD), false);
        js = replaceTop(js, 'ReplaceSTQwithATE', BOOL, String(c.clocked.replaceSTQwithATE), false);
        js = replaceTop(js, 'STQUnlockedLevel', NUM, String(c.clocked.lifelineUnlockLevel), false);
        js = replaceTop(js, 'ShowATAResultsInAnswers', BOOL, String(c.clocked.showATAResultsInAnswers), false);
    }

    if (c.syncSecondary) {
        // Same currency and locale for the game's second number format; its style, prefix and suffix stay as the theme set them
        js = replaceTop(js, 'SecondaryLocaleCode', STR, jsString(c.localeCode), false);
        const so = block(js, 'SecondaryFormatOptions');
        if (so) {
            let b2 = so.body;
            b2 = replaceProp(b2, 'currency', STR, jsString(c.currency), false);
            b2 = replaceProp(b2, 'currencyDisplay', STR, jsString(c.currencyDisplay), false);
            b2 = replaceProp(b2, 'minimumFractionDigits', NUM, String(c.fractionDigits), false);
            js = js.slice(0, so.start) + b2 + js.slice(so.start + so.body.length);
        }
    }

    write(file, js, bom);
}
