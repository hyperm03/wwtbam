import { emptyQuestion } from './store.js';

/**
 * Question builder integration. The request is made by the server (no CORS issues, the builder can stay on
 * 127.0.0.1:13400) and only to the configured builder address.
 *
 * The JSON is recognised automatically: a list of questions, { questions: [...] }, separate main/replacement lists,
 * or several named sets. Each question may use common field names (question/text/q, answers array or a-d or
 * option objects, correct as letter/index/text/flag, level/number...). Tell the author of this platform the exact
 * builder format to make the mapping exact.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const LEVELS = 15;

export async function fetchFromBuilder(builder, pathOverride) {
    if (!builder.baseUrl) throw new Error('Set the question builder address first');
    const base = new URL(builder.baseUrl.endsWith('/') ? builder.baseUrl : builder.baseUrl + '/');
    const rel = String(pathOverride ?? builder.path ?? '').replace(/^\/+/, '');
    const url = new URL(rel, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin)
        throw new Error('The path must stay on the question builder address');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const headers = { Accept: 'application/json' };
        if (builder.token) headers.Authorization = `Bearer ${builder.token}`;
        const res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error('The builder answer is too large');
        if (!res.ok) throw new Error(`The builder returned ${res.status} ${res.statusText}`);
        let json;
        try { json = JSON.parse(text); } catch { throw new Error('The builder did not return JSON (check the path)'); }
        return { url: url.href, sets: normalize(json) };
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('The question builder did not answer within 15 seconds');
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------------------------- recognition

const pick = (o, names) => { for (const n of names) { if (o?.[n] !== undefined && o[n] !== null) return o[n]; } return undefined; };
const QUESTION_KEYS = ['question', 'text', 'q', 'prompt', 'domanda', 'title'];
const LIST_KEYS = ['questions', 'items', 'data', 'results', 'domande'];

function looksLikeQuestion(o) {
    return o && typeof o === 'object' && !Array.isArray(o) && typeof pick(o, QUESTION_KEYS) === 'string';
}

function isReplacement(o) {
    const v = pick(o, ['replacement', 'isReplacement', 'switch', 'isSwitch', 'reserve', 'riserva']);
    if (typeof v === 'boolean') return v;
    const type = String(pick(o, ['type', 'set', 'kind', 'role']) ?? '').toLowerCase();
    return /replace|switch|stq|reserve|riserva/.test(type);
}

function toQuestion(o) {
    const q = emptyQuestion();
    q.text = String(pick(o, QUESTION_KEYS) ?? '').trim();
    q.category = String(pick(o, ['category', 'categoria', 'topic', 'subject', 'tag']) ?? '').trim();
    q.comment = String(pick(o, ['comment', 'comments', 'notes', 'note', 'hostNotes', 'host_notes', 'commento', 'explanation']) ?? '').trim();

    let answers = pick(o, ['answers', 'options', 'choices', 'risposte']);
    let correct = -1;
    if (Array.isArray(answers)) {
        answers = answers.slice(0, 4).map((a, i) => {
            if (a && typeof a === 'object') {
                if (a.correct === true || a.isCorrect === true || a.right === true) correct = i;
                return String(pick(a, ['text', 'answer', 'value', 'label']) ?? '');
            }
            return String(a ?? '');
        });
    } else {
        answers = ['a', 'b', 'c', 'd'].map(l => String(pick(o, [l, l.toUpperCase(), 'answer' + l.toUpperCase(), 'answer_' + l]) ?? ''));
    }
    while (answers.length < 4) answers.push('');
    q.answers = answers.map(a => a.trim());

    if (correct < 0) {
        const c = pick(o, ['correct', 'correctAnswer', 'correct_answer', 'answer', 'right', 'solution', 'corretta']);
        if (typeof c === 'number') correct = c >= 0 && c <= 3 ? c : c >= 1 && c <= 4 ? c - 1 : -1;
        else if (typeof c === 'string') {
            const s = c.trim();
            if (/^[a-d]$/i.test(s)) correct = 'abcd'.indexOf(s.toLowerCase());
            else if (/^[0-3]$/.test(s)) correct = Number(s);
            else correct = q.answers.findIndex(a => a.toLowerCase() === s.toLowerCase());
        }
    }
    q.correct = correct >= 0 ? correct : 0;
    q.valid = !!q.text && q.answers.every(Boolean) && correct >= 0;
    return q;
}

function levelOf(o) {
    const v = Number(pick(o, ['level', 'number', 'livello', 'index', 'position', 'order']));
    return Number.isInteger(v) && v >= 1 && v <= LEVELS ? v : null;
}

/** Places the questions of one set into 15 main and 15 replacement slots. */
function buildSet(name, items, forceReplacement) {
    const main = Array.from({ length: LEVELS }, emptyQuestion);
    const sw = Array.from({ length: LEVELS }, emptyQuestion);
    const next = { main: 0, sw: 0 };
    let count = 0, invalid = 0;
    for (const o of items) {
        if (!looksLikeQuestion(o)) continue;
        const q = toQuestion(o);
        if (!q.valid) invalid++;
        delete q.valid;
        const target = forceReplacement || isReplacement(o) ? 'sw' : 'main';
        const list = target === 'sw' ? sw : main;
        let level = levelOf(o);
        if (!level || list[level - 1].text) {
            while (next[target] < LEVELS && list[next[target]].text) next[target]++;
            level = next[target] < LEVELS ? next[target] + 1 : null;
        }
        if (!level) continue;
        list[level - 1] = q;
        count++;
    }
    return { name, main, sw, count, invalid };
}

export function normalize(json) {
    const sets = [];
    const visit = (value, name) => {
        if (Array.isArray(value)) {
            if (value.some(looksLikeQuestion)) { sets.push(buildSet(name, value, false)); return; }
            value.forEach((v, i) => visit(v, v?.name || v?.title || `${name} ${i + 1}`));
            return;
        }
        if (!value || typeof value !== 'object') return;
        // { main: [...], replacement|switch: [...] }
        const mainList = pick(value, ['main', 'questions', 'domande']);
        const swList = pick(value, ['replacement', 'replacements', 'switch', 'switchQuestions', 'reserve', 'riserva']);
        if (Array.isArray(mainList) && mainList.some(looksLikeQuestion)) {
            const set = buildSet(value.name || value.title || name, mainList, false);
            if (Array.isArray(swList)) {
                const extra = buildSet('', swList, true);
                set.sw = extra.sw;
                set.count += extra.count;
                set.invalid += extra.invalid;
            }
            sets.push(set);
            return;
        }
        for (const k of LIST_KEYS) if (Array.isArray(value[k])) return visit(value[k], value.name || name);
        for (const k of ['sets', 'games', 'packs', 'quizzes', 'rounds']) if (Array.isArray(value[k])) return visit(value[k], name);
        for (const [k, v] of Object.entries(value)) if (v && typeof v === 'object') visit(v, k);
    };
    visit(json, 'Questions');
    return sets.filter(s => s.count > 0).slice(0, 100);
}
