import path from 'node:path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import ExcelJS from 'exceljs';
import { normalize as normalizeJson } from './builder.js';
import { engineFor } from './ai.js';

/**
 * Question importer from documents: Word (.docx, .doc), PDF, text (.txt, .md, .rtf), spreadsheets (.xlsx, .csv, .tsv),
 * JSON (question builder formats) and XML (the themes' questions.xml).
 *
 * Tables are read by column names. Free text is read by a pattern parser that understands the usual quiz layouts;
 * in Word files a bold answer counts as the correct one. For messy documents the configured AI engine can
 * extract the questions instead (it is told never to invent anything).
 */
export const ACCEPTED = ['.docx', '.doc', '.pdf', '.txt', '.md', '.text', '.rtf', '.csv', '.tsv', '.xlsx', '.json', '.xml'];
const LETTERS = 'ABCD';
const MAX_AI_CHARS = 60000;

// ---------------------------------------------------------------------------------------------- reading the file

function decodeText(buf) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    // Not valid UTF-8 (typical of old Windows files): fall back to Latin-1 / Windows-1252
    return text.includes('\uFFFD') ? buf.toString('latin1') : text;
}

/** Minimal RTF to text: paragraphs, escaped characters (\'hh, \uN), control words and hidden groups removed. */
function rtfToText(rtf) {
    return rtf
        .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
        .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, '')
        .replace(/\\par[d]?\b ?|\\line\b ?/g, '\n')
        .replace(/\\tab\b ?/g, '\t')
        .replace(/\\'([0-9a-f]{2})/gi, (_, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'))
        .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
        .replace(/\\[a-z]+-?\d* ?/gi, '')
        .replace(/[{}]/g, '')
        .replace(/\\([\\{}])/g, '$1');
}

/** Word .docx as text, with bold runs kept as **...** so that a bold answer can mark the correct one. */
async function docxToText(buf) {
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    return html
        .replace(/<\/(p|h\d|li|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/t[dh]>/gi, '\t')
        .replace(/<(strong|b)>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\*\*\s*\*\*/g, '');
}

/** PDF text with Mozilla's pdf.js: lines are rebuilt from the text items (end-of-line flags and vertical position). */
async function pdfToText(buf) {
    const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        let text = '', lastY = null;
        for (const it of content.items) {
            const y = it.transform?.[5];
            if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
            text += it.str;
            if (it.hasEOL) text += '\n';
            if (y !== undefined) lastY = y;
        }
        pages.push(text);
    }
    await doc.destroy();
    return pages.join('\n');
}

function parseCsv(text, sep) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === sep) { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
}

async function xlsxRows(buf) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const rows = [];
    ws?.eachRow({ includeEmpty: false }, r => {
        const values = [];
        r.eachCell({ includeEmpty: true }, (cell, col) => {
            const v = cell.value;
            values[col - 1] = v == null ? '' : typeof v === 'object' ? (v.text ?? v.result ?? v.richText?.map(t => t.text).join('') ?? String(v)) : String(v);
        });
        rows.push(Array.from(values, v => v ?? ''));
    });
    return rows;
}

/** Plain text of any accepted file (for the preview and the AI). */
export async function extract(buf, filename) {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.docx': return { kind: 'text', text: await docxToText(buf) };
        case '.doc': return { kind: 'text', text: (await new WordExtractor().extract(buf)).getBody() };
        case '.pdf': return { kind: 'text', text: await pdfToText(buf) };
        case '.rtf': return { kind: 'text', text: rtfToText(decodeText(buf)) };
        case '.xlsx': return { kind: 'table', rows: await xlsxRows(buf) };
        case '.csv': case '.tsv': {
            const text = decodeText(buf);
            const first = text.split(/\r?\n/)[0] || '';
            const sep = ext === '.tsv' || first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
            return { kind: 'table', rows: parseCsv(text, sep) };
        }
        case '.json': return { kind: 'json', text: decodeText(buf) };
        case '.xml': return { kind: 'xml', text: decodeText(buf) };
        case '.txt': case '.md': case '.text': return { kind: 'text', text: decodeText(buf) };
        default: throw new Error(`Unsupported file type ${ext || '(none)'}: use ${ACCEPTED.join(', ')}`);
    }
}

const tableToText = rows => rows.map(r => r.join('\t')).join('\n');

// ---------------------------------------------------------------------------------------------- result model

/** "7", "facile", "hard"... → 1-15 (words map to the middle of their band). */
export function difficultyFrom(value) {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v) return null;
    const n = Number.parseInt(v, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 15) return n;
    if (/molto difficil|very hard|expert|estrem/.test(v)) return 14;
    if (/difficil|hard|dura/.test(v)) return 12;
    if (/medi|medium|intermed|normal/.test(v)) return 8;
    if (/facil|easy|semplic/.test(v)) return 3;
    return null;
}

function item({ number = null, level = null, set = null, category = '', text = '', answers = [], correct = -1, comment = '', difficulty = null }) {
    const a = answers.slice(0, 4).map(x => String(x ?? '').trim());
    while (a.length < 4) a.push('');
    const warnings = [];
    if (!text.trim()) warnings.push('no question text');
    if (a.some(x => !x)) warnings.push('missing answers');
    if (correct < 0) warnings.push('correct answer not indicated');
    if (text.length > 120) warnings.push(`question is ${text.length} chars`);
    return {
        number, level: Number.isInteger(level) && level >= 1 && level <= 15 ? level : null, set,
        // Difficulty stated in the file (a difficulty column or line, otherwise the level the question is written for)
        difficulty: difficultyFrom(difficulty) ?? (Number.isInteger(level) && level >= 1 && level <= 15 ? level : null),
        question: { category: category.trim(), text: text.trim(), answers: a, correct: correct >= 0 ? correct : 0, comment: comment.trim() },
        correctKnown: correct >= 0, warnings
    };
}

function correctFrom(value, answers) {
    const v = String(value ?? '').trim();
    if (!v) return -1;
    if (/^[A-Da-d]$/.test(v)) return LETTERS.indexOf(v.toUpperCase());
    if (/^[1-4]$/.test(v)) return Number(v) - 1;
    const m = v.match(/^([A-Da-d])[\s).:\-]/);
    if (m) return LETTERS.indexOf(m[1].toUpperCase());
    return answers.findIndex(a => a && a.trim().toLowerCase() === v.toLowerCase());
}

const setFrom = v => /repl|riserv|switch|swap|cambio|reserve/i.test(String(v ?? '')) ? 'replacement' : /main|princip|normal/i.test(String(v ?? '')) ? 'main' : null;

// ---------------------------------------------------------------------------------------------- tables

const HEADER = {
    level: /^(level|livello|lvl|#|n\.?|num(ber|ero)?|q#)$/i,
    text: /^(question|domanda|text|testo|q)$/i,
    a: /^(a|answer ?a|risposta ?a|option ?a|opzione ?a)$/i,
    b: /^(b|answer ?b|risposta ?b|option ?b|opzione ?b)$/i,
    c: /^(c|answer ?c|risposta ?c|option ?c|opzione ?c)$/i,
    d: /^(d|answer ?d|risposta ?d|option ?d|opzione ?d)$/i,
    correct: /^(correct|correct answer|answer|risposta|risposta corretta|corretta|soluzione|solution|key|right)$/i,
    category: /^(category|categoria|topic|argomento|subject)$/i,
    comment: /^(comment|commento|notes?|nota|host|conduttore|explanation|spiegazione)$/i,
    set: /^(set|type|tipo|riserva|replacement|switch)$/i,
    difficulty: /^(difficulty|difficoltà|difficolta|diff|livello di difficoltà)$/i
};

function parseTable(rows) {
    if (!rows.length) return [];
    const header = rows[0].map(c => String(c).trim());
    const col = {};
    header.forEach((hname, i) => { for (const [k, re] of Object.entries(HEADER)) if (col[k] === undefined && re.test(hname)) col[k] = i; });
    const hasHeader = col.text !== undefined;
    // Without a header: question, A, B, C, D, correct, category, comment
    const map = hasHeader ? col : { text: 0, a: 1, b: 2, c: 3, d: 4, correct: 5, category: 6, comment: 7 };
    return rows.slice(hasHeader ? 1 : 0).map((r, i) => {
        const get = k => map[k] === undefined ? '' : String(r[map[k]] ?? '').trim();
        const answers = ['a', 'b', 'c', 'd'].map(get);
        return item({
            number: i + 1, level: Number.parseInt(get('level'), 10) || null, set: setFrom(get('set')),
            category: get('category'), text: get('text'), answers, correct: correctFrom(get('correct'), answers), comment: get('comment'),
            difficulty: get('difficulty')
        });
    }).filter(x => x.question.text);
}

// ---------------------------------------------------------------------------------------------- free text

const MARK_RE = /(\s*(\*+|✓|✔|☑|\(x\)|\[x\]|\((correct|corretta|giusta|right)\)|<-+|<=+|→ *correct)\s*)/gi;
const ANSWER_RE = /^\(?([A-Da-d])\s*[).\]:\-–]\s*(.+)$/;
const KEY_LINE_RE = /^(?:correct(?: answer)?|answer|risposta(?: corretta| esatta| giusta)?|soluzione|solution|key|corretta|esatta)\s*[:=\-–]\s*(.+)$/i;
const CATEGORY_RE = /^(?:category|categoria|topic|argomento|subject)\s*[:\-–]\s*(.+)$/i;
const COMMENT_RE = /^(?:comment|commento|notes?|nota|host notes?|note per il conduttore|conduttore|explanation|spiegazione|curiosità|trivia)\s*[:\-–]\s*(.+)$/i;
const LEVEL_RE = /^(?:level|livello|lvl)\s*(\d{1,2})\b[\s:.\-–]*(.*)$/i;
const DIFFICULTY_RE = /^(?:difficulty|difficoltà|difficolta)\s*[:\-–]\s*(.+)$/i;
const QUESTION_RE = /^(?:(?:q|d|domanda|question|n\.?)\s*)?(\d{1,3})\s*[).:\-–]\s*(.+)$/i;
const KEY_ENTRY_RE = /(\d{1,3})\s*[).:=\-–]?\s*([A-Da-d])(?![A-Za-z])/g;

function stripMarks(s) {
    let marked = false;
    let t = s;
    if (/^\*\*[\s\S]+\*\*$/.test(t.trim())) { marked = true; t = t.trim().slice(2, -2); }
    const cleaned = t.replace(MARK_RE, m => { marked = true; return ' '; }).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    return { text: cleaned, marked };
}

/** Splits "A) one B) two C) three D) four" written on a single line. */
function splitInlineAnswers(line) {
    const parts = line.split(/\s+(?=\(?[B-D]\s*[).\]:]\s)/);
    return parts.length === 4 && ANSWER_RE.test(parts[0]) ? parts : [line];
}

function parseText(text) {
    const lines = text.replace(/\r/g, '').split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean)
        .flatMap(splitInlineAnswers);
    const out = [];
    let cur = null, level = null, set = null, category = '';
    const keyByNumber = new Map();

    const finish = () => {
        if (cur && cur.text) out.push(cur);
        cur = null;
    };

    for (const raw of lines) {
        // Bold in Word: a whole bold answer "**B) Roma**" becomes "B) **Roma**" (the answer, marked); other bold lines lose the markers
        const line = raw.replace(/^\*\*(.+?)\*\*$/, (m, inner) => {
            const a = inner.match(ANSWER_RE);
            return a ? `${a[1]}) **${a[2]}**` : inner;
        });
        if (/^(replacement|riserva|domande di riserva|switch|cambio domanda)\b/i.test(line) && line.length < 60) { finish(); set = 'replacement'; continue; }
        if (/^(main|domande principali|principali)\b/i.test(line) && line.length < 60) { finish(); set = 'main'; continue; }
        let m;
        if ((m = line.match(LEVEL_RE)) && Number(m[1]) <= 15 && !(cur && cur.answers.length < 4 && m[2])) {
            finish(); level = Number(m[1]);
            if (m[2] && m[2].length > 3) cur = { number: null, level, set, category, text: m[2], answers: [], correct: -1, comment: '' };
            continue;
        }
        if ((m = line.match(CATEGORY_RE))) { if (cur && cur.answers.length) cur.category = m[1]; else category = m[1]; if (cur && !cur.answers.length) cur.category = m[1]; continue; }
        if ((m = line.match(COMMENT_RE)) && cur) { cur.comment = (cur.comment ? cur.comment + ' ' : '') + m[1]; continue; }
        if ((m = line.match(DIFFICULTY_RE)) && cur) { cur.difficulty = m[1]; continue; }
        if ((m = line.match(KEY_LINE_RE)) && cur) {
            const v = stripMarks(m[1]).text;
            const c = correctFrom(v, cur.answers.map(a => a.text));
            if (c >= 0) cur.correct = c;
            continue;
        }
        // "1-B 2-C 3-A" answer keys (usually at the end of the document), with or without an "Answer key:" label
        const keyText = line.replace(/^(answer key|answers|key|correct answers|soluzioni|risposte( corrette| esatte)?|chiave)\s*[:\-–]\s*/i, '');
        const entries = [...keyText.matchAll(KEY_ENTRY_RE)];
        if (entries.length && keyText.replace(KEY_ENTRY_RE, '').replace(/[\s,;|]/g, '') === '' && (entries.length > 1 || keyText !== line || (cur && cur.answers.length === 4))) {
            for (const e of entries) keyByNumber.set(Number(e[1]), LETTERS.indexOf(e[2].toUpperCase()));
            continue;
        }
        if ((m = line.match(ANSWER_RE)) && cur && cur.answers.length < 4 && LETTERS.indexOf(m[1].toUpperCase()) === cur.answers.length) {
            const { text: t, marked } = stripMarks(m[2]);
            if (marked) cur.correct = cur.answers.length;
            cur.answers.push({ text: t });
            continue;
        }
        if ((m = line.match(QUESTION_RE)) && !(cur && cur.answers.length > 0 && cur.answers.length < 2 && !/[?？]\s*$/.test(line))) {
            finish();
            cur = { number: Number(m[1]), level, set, category, text: stripMarks(m[2]).text, answers: [], correct: -1, comment: '' };
            level = null;
            continue;
        }
        if (cur && cur.answers.length === 0) { cur.text += ' ' + stripMarks(line).text; continue; }
        if (!cur || cur.answers.length === 4) {
            // An unnumbered question: a line ending with "?" (or any line followed by answers)
            if (/[?？]\s*$/.test(line) || !cur) {
                finish();
                const label = line.replace(/^(?:q|d|domanda|question)\s*[:.\-–]\s*/i, '');
                cur = { number: null, level, set, category, text: stripMarks(label).text, answers: [], correct: -1, comment: '' };
                level = null;
            }
            else if (cur) cur.comment = (cur.comment ? cur.comment + ' ' : '') + line;
        }
    }
    finish();

    return out.filter(q => q.answers.length >= 2).map((q, i) => {
        const answers = q.answers.map(a => a.text);
        let correct = q.correct;
        if (correct < 0 && q.number != null && keyByNumber.has(q.number)) correct = keyByNumber.get(q.number);
        return item({ number: q.number ?? i + 1, level: q.level, set: q.set, category: q.category, text: q.text, answers, correct, comment: q.comment, difficulty: q.difficulty });
    });
}

// ---------------------------------------------------------------------------------------------- XML / JSON

function parseXml(xml) {
    const blocks = [...xml.matchAll(/<question\b[^>]*>([\s\S]*?)<\/question>/gi)].map(m => m[1]);
    const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
    return blocks.map((b, i) => {
        const tag = t => { const m = b.match(new RegExp(`<${t}\\b([^>]*)>([\\s\\S]*?)</${t}>`, 'i')); return m ? { attrs: m[1], text: decode(m[2]) } : null; };
        let correct = -1;
        const answers = ['a', 'b', 'c', 'd'].map((l, k) => { const a = tag(l); if (a && /correct\s*=\s*["']yes["']/i.test(a.attrs)) correct = k; return a?.text ?? ''; });
        return item({ number: i + 1, category: tag('category')?.text ?? '', text: (tag('text')?.text ?? '').replace(/\+\+\+\+/g, ' '), answers, correct, comment: tag('comment')?.text ?? '' });
    });
}

function parseJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('The JSON file is not valid: ' + e.message); }
    const out = [];
    for (const set of normalizeJson(data)) {
        set.main.forEach((q, i) => { if (q.text) out.push(item({ number: out.length + 1, level: i + 1, set: 'main', ...q })); });
        set.sw.forEach((q, i) => { if (q.text) out.push(item({ number: out.length + 1, level: i + 1, set: 'replacement', ...q })); });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------- AI extraction

const EXTRACT_SCHEMA = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    level: { type: 'integer' },
                    set: { type: 'string', enum: ['main', 'replacement', 'unknown'] },
                    category: { type: 'string' },
                    question: { type: 'string' },
                    answers: { type: 'array', items: { type: 'string' } },
                    correct: { type: 'string', enum: ['A', 'B', 'C', 'D', '?'] },
                    comment: { type: 'string' }
                },
                required: ['question', 'answers', 'correct']
            }
        }
    },
    required: ['questions']
};

const EXTRACT_PROMPT = `You extract multiple-choice quiz questions from a document for the TV quiz "Who Wants to Be a Millionaire?".
Rules:
- Copy the questions and answers exactly as written, in their original language. Never invent, complete or correct anything.
- Each question has up to four answers, in the order A, B, C, D.
- "correct" is the letter of the answer the document marks as correct (answer key, "Risposta: B", bold, asterisk, tick...). If the document does not say which one is correct, use "?". Never guess.
- "level" is the question number in the money ladder (1-15) only if the document states it, otherwise 0.
- "set" is "replacement" for spare / switch / riserva questions, "main" when stated, otherwise "unknown".
- "comment" is any explanation or note for the host that the document gives for that question, otherwise empty.
- Reply with JSON only, matching the schema.`;

async function extractWithAi(text, ai, signal) {
    const engine = engineFor(ai);
    const clipped = text.length > MAX_AI_CHARS ? text.slice(0, MAX_AI_CHARS) : text;
    const answer = await engine.complete(EXTRACT_PROMPT, 'Document:\n"""\n' + clipped + '\n"""', signal, EXTRACT_SCHEMA);
    let data;
    try { data = JSON.parse(String(answer).replace(/^```(json)?\s*|\s*```$/g, '')); } catch (e) { throw new Error("The AI answer was not valid JSON: " + e.message); }
    const items = (data.questions ?? []).map((d, i) => item({
        number: i + 1, level: Number(d.level) || null, set: d.set === 'unknown' ? null : d.set,
        category: String(d.category ?? ''), text: String(d.question ?? ''), answers: Array.isArray(d.answers) ? d.answers.map(String) : [],
        correct: 'ABCD'.indexOf(String(d.correct ?? '?').toUpperCase()), comment: String(d.comment ?? '')
    }));
    return { items, engine: engine.name, truncated: text.length > MAX_AI_CHARS };
}

// ---------------------------------------------------------------------------------------------- entry point

/**
 * Reads a document and returns the questions found, each with a suggested target slot:
 * the level stated in the file, otherwise the next free level (main first, then replacement).
 */
export async function importDocument(buf, filename, { useAi = false, ai = null, signal } = {}) {
    const data = await extract(buf, filename);
    const text = data.kind === 'table' ? tableToText(data.rows) : data.text;
    let items, method, notes = [];

    if (useAi) {
        if (!ai) throw new Error('No AI engine configured (Admin → Connections)');
        const r = await extractWithAi(text, ai, signal);
        items = r.items;
        method = `AI (${r.engine})`;
        if (r.truncated) notes.push(`Only the first ${MAX_AI_CHARS} characters of the document were sent to the AI.`);
    } else if (data.kind === 'table') { items = parseTable(data.rows); method = 'table columns'; }
    else if (data.kind === 'json') { items = parseJson(data.text); method = 'JSON'; }
    else if (data.kind === 'xml') { items = parseXml(data.text); method = 'questions XML'; }
    else { items = parseText(data.text); method = 'text patterns'; }

    // Suggested targets: stated level and set first, then the free slots in order
    const taken = { main: new Set(), replacement: new Set() };
    for (const it of items) {
        if (it.level && !taken[it.set || 'main'].has(it.level)) { it.target = { set: it.set || 'main', level: it.level }; taken[it.target.set].add(it.level); }
    }
    for (const it of items) {
        if (it.target) continue;
        const sets = it.set ? [it.set] : ['main', 'replacement'];
        for (const s of sets) {
            const free = Array.from({ length: 15 }, (_, i) => i + 1).find(l => !taken[s].has(l));
            if (free) { it.target = { set: s, level: free }; taken[s].add(free); break; }
        }
        it.target ??= null;
    }

    return { file: filename, method, notes, count: items.length, preview: text.slice(0, 4000), items };
}
