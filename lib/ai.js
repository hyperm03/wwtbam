/**
 * AI question writer (port of the desktop QuestionWriter): Google Gemini or a local Ollama server,
 * JSON answers constrained by a schema, batches of five levels with one retry for skipped questions,
 * answers shuffled so the correct one is not always in the same place.
 */
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
export const QUESTION_MAX = 120;
export const ANSWER_MAX = 35;
const PER_REQUEST = 5;

export function difficulty(level) {
    if (level <= 5) return 'EASY: a child could answer it and get it right';
    if (level <= 9) return 'HARDER: needs good general knowledge';
    if (level <= 14) return 'HARD: only a well-read contestant would know it';
    return 'THE HARDEST OF THEM ALL: obscure but fair, precise and verifiable';
}

export const SCHEMA = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    level: { type: 'integer' },
                    set: { type: 'string', enum: ['main', 'replacement'] },
                    category: { type: 'string' },
                    question: { type: 'string' },
                    answers: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
                    correct: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                    comment: { type: 'string' }
                },
                required: ['level', 'set', 'category', 'question', 'answers', 'correct']
            }
        }
    },
    required: ['questions']
};

export const systemPrompt = language => `You write questions for the TV quiz show "Who Wants to Be a Millionaire?".
Every question has four answers (A, B, C, D) and exactly one of them is unambiguously correct.

Difficulty ladder (difficulty must rise steadily from level to level):
- Levels 1-5: ${difficulty(1)}.
- Levels 6-9: ${difficulty(6)}.
- Levels 10-14: ${difficulty(10)}.
- Level 15: ${difficulty(15)}.

Rules:
- Facts must be accurate and must not change over time: avoid "current" office holders, recent records, prices or anything time-sensitive.
- The three wrong answers must be plausible and of the same kind as the correct one, but clearly wrong for someone who knows the answer.
- The question text is at most ${QUESTION_MAX} characters and each answer at most ${ANSWER_MAX} characters: they must fit on the TV graphics.
- Never use "All of the above", "None of the above" or answers that overlap.
- Vary the subjects: never two questions on the same fact or topic.
- The position of the correct answer must vary across A, B, C and D.
- "category" is a short subject label (one or two words).
- "comment" is one short sentence of background for the host (read on the host screen only, never shown to the contestant).
- Write the questions, answers and categories in ${language}.
- Reply with JSON only, matching the requested schema.`;

export function userPrompt(req, slots, avoid) {
    const lines = [req.topic?.trim() ? `Topic: ${req.topic.trim()}` : 'Topic: general knowledge (mix of subjects).'];
    if (req.extra?.trim()) lines.push('Additional instructions: ' + req.extra.trim());
    const sameLevel = slots.length > 1 && slots.every(s => s.level === slots[0].level && !s.replacement);
    if (sameLevel) {
        // many questions for one level (e.g. 10 questions for question 15)
        lines.push('', `Write exactly ${slots.length} different questions, all for level ${slots[0].level} (set "main"): ${difficulty(slots[0].level)}.`,
            'Every question on a different subject and a different kind of fact; same difficulty for all of them.');
    } else lines.push('', `Write exactly these ${slots.length} questions (one object each):`);
    if (!sameLevel) for (const s of slots)
        lines.push(`- level ${s.level}, set "${s.replacement ? 'replacement' : 'main'}": ${difficulty(s.level)}` +
            (s.replacement ? ' (a different subject from the main question of this level)' : ''));
    const list = [...new Set(avoid.filter(a => a && a.trim()))].slice(0, 60);
    if (list.length) {
        lines.push('', 'Do not repeat or rephrase any of these existing questions:');
        for (const a of list) lines.push('- ' + a.replace(/\s*\n\s*/g, ' '));
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------- engines

async function readJson(res, engine) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const detail = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : text.slice(0, 300));
        throw new Error(`${engine} returned ${res.status}: ${detail}`);
    }
    if (!json) throw new Error(`${engine} returned a response that is not JSON`);
    return json;
}

export function normalizeOllamaUrl(url) {
    let u = String(url || '').trim().replace(/\/+$/, '') || 'http://localhost:11434';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u;
}

const stripModel = m => String(m || '').trim().replace(/^models\//i, '');

export function engineFor(ai) {
    if (ai.provider === 'ollama') {
        if (!ai.ollamaModel) throw new Error('Choose an Ollama model ("Load models" lists the installed ones)');
        const base = normalizeOllamaUrl(ai.ollamaUrl);
        return {
            name: `Ollama (${ai.ollamaModel})`,
            async complete(system, user, signal, schema = SCHEMA) {
                const res = await fetch(`${base}/api/chat`, {
                    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: ai.ollamaModel, stream: false, format: schema,
                        messages: [{ role: 'system', content: system }, { role: 'user', content: user + '\n\nJSON schema of the reply:\n' + JSON.stringify(schema) }],
                        options: { temperature: 0.8 }
                    })
                });
                const json = await readJson(res, 'Ollama');
                const text = json?.message?.content;
                if (!text?.trim()) throw new Error('Ollama returned an empty answer');
                return text;
            }
        };
    }
    if (!ai.geminiKey) throw new Error('Enter the Gemini API key');
    const model = stripModel(ai.geminiModel) || 'gemini-2.5-flash';
    return {
        name: `Gemini (${model})`,
        async complete(system, user, signal, schema = SCHEMA) {
            const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.geminiKey },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: system }] },
                    contents: [{ role: 'user', parts: [{ text: user }] }],
                    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: schema === SCHEMA ? 0.9 : 0.1 }
                })
            });
            const json = await readJson(res, 'Gemini');
            const cand = json?.candidates?.[0];
            if (!cand) throw new Error(`Gemini did not answer (${json?.promptFeedback?.blockReason ?? 'no answer'})`);
            const text = (cand.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
            if (!text) throw new Error(`Gemini returned no text (finish reason: ${cand.finishReason})`);
            return text;
        }
    };
}

export async function listModels(ai, signal) {
    if (ai.provider === 'ollama') {
        const json = await readJson(await fetch(`${normalizeOllamaUrl(ai.ollamaUrl)}/api/tags`, { signal }), 'Ollama');
        return (json.models ?? []).map(m => m.name).filter(Boolean).sort();
    }
    if (!ai.geminiKey) throw new Error('Enter the Gemini API key first');
    const json = await readJson(await fetch(`${GEMINI}/models?pageSize=1000`, { signal, headers: { 'x-goog-api-key': ai.geminiKey } }), 'Gemini');
    return (json.models ?? [])
        .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(m => stripModel(m.name)).filter(n => n.startsWith('gemini')).sort();
}

// ---------------------------------------------------------------------------------------------- parsing and generation

export function parseAnswer(text, shuffle) {
    let json = String(text).trim();
    if (json.startsWith('```')) {
        const start = json.indexOf('\n'), end = json.lastIndexOf('```');
        if (start > 0 && end > start) json = json.slice(start + 1, end);
    }
    let data;
    try { data = JSON.parse(json); } catch (e) { throw new Error("The model's answer was not valid JSON: " + e.message); }

    const out = [];
    for (const d of data?.questions ?? []) {
        const answers = (Array.isArray(d.answers) ? d.answers : []).map(a => String(a ?? '').trim());
        const correct = 'ABCD'.indexOf(String(d.correct ?? '').trim().toUpperCase().charAt(0));
        const question = String(d.question ?? '').trim();
        if (!question || answers.length !== 4 || answers.some(a => !a) || correct < 0) continue;

        const q = { category: String(d.category ?? '').trim(), text: question, answers, correct, comment: String(d.comment ?? '').trim().slice(0, 1000) };
        if (shuffle) {
            const order = [0, 1, 2, 3];
            for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
            q.answers = order.map(i => answers[i]);
            q.correct = order.indexOf(correct);
        }
        const warnings = [];
        if (q.text.length > QUESTION_MAX) warnings.push(`question is ${q.text.length} chars`);
        if (q.answers.some(a => a.length > ANSWER_MAX)) warnings.push('long answer');
        if (new Set(q.answers.map(a => a.toLowerCase())).size < 4) warnings.push('duplicate answers');
        out.push({ level: Number(d.level) || 0, replacement: String(d.set).toLowerCase() === 'replacement', question: q, warnings });
    }
    return out;
}

/**
 * req: { from, to, main, replacement, language, topic, extra, skipMain:Set, skipReplacement:Set, avoid:[] }
 * progress(text) is called before every request; signal cancels.
 */
/**
 * `count` questions for one level (e.g. 10 for question 15), in batches of five, never repeating a question of
 * `avoid` or of this run. Stops when the model twice in a row returns nothing usable.
 * req: { level, count, language, topic, extra, avoid:[] }
 */
export async function generateForLevel(engine, req, { shuffle = true, progress = () => { }, signal } = {}) {
    const results = [];
    const avoid = [...req.avoid];
    const seen = new Set(avoid.map(t => t.trim().toLowerCase()));
    let misses = 0;
    while (results.length < req.count) {
        if (signal?.aborted) throw new Error('Generation cancelled');
        const n = Math.min(PER_REQUEST, req.count - results.length);
        progress(`Level ${req.level}: questions ${results.length + 1}-${results.length + n} of ${req.count}  ·  ${engine.name}`);
        const slots = Array.from({ length: n }, () => ({ level: req.level, replacement: false }));
        const parsed = parseAnswer(await engine.complete(systemPrompt(req.language || 'English'), userPrompt(req, slots, avoid), signal), shuffle);
        let got = 0;
        for (const q of parsed) {
            const key = q.question.text.trim().toLowerCase();
            if (got >= n || !key || seen.has(key)) continue;
            seen.add(key);
            avoid.push(q.question.text);
            results.push({ ...q, level: req.level, replacement: false });
            got++;
        }
        if (got) misses = 0;
        else if (++misses >= 2) {
            progress(`The model returned no new questions twice in a row: stopped at ${results.length} of ${req.count}.`);
            break;
        }
    }
    return results;
}

export async function generate(engine, req, { shuffle = true, progress = () => { }, signal } = {}) {
    const slots = [];
    for (let level = req.from; level <= req.to; level++) {
        if (req.main && !req.skipMain.has(level)) slots.push({ level, replacement: false });
        if (req.replacement && !req.skipReplacement.has(level)) slots.push({ level, replacement: true });
    }
    const batches = [];
    for (const s of slots) {
        const b = Math.floor((s.level - req.from) / PER_REQUEST);
        (batches[b] ??= []).push(s);
    }
    const results = [];
    const avoid = [...req.avoid];
    const list = batches.filter(Boolean);

    for (let b = 0; b < list.length; b++) {
        let pending = [...list[b]];
        for (let attempt = 1; attempt <= 2 && pending.length; attempt++) {
            if (signal?.aborted) throw new Error('Generation cancelled');
            progress(`Batch ${b + 1} of ${list.length}: levels ${Math.min(...pending.map(p => p.level))}-${Math.max(...pending.map(p => p.level))}` +
                (attempt > 1 ? ' (retrying skipped questions)' : '') + `  ·  ${engine.name}`);
            const parsed = parseAnswer(await engine.complete(systemPrompt(req.language || 'English'), userPrompt(req, pending, avoid), signal), shuffle);
            for (const slot of [...pending]) {
                const i = parsed.findIndex(q => q.level === slot.level && q.replacement === slot.replacement);
                const j = i >= 0 ? i : parsed.findIndex(q => q.level === slot.level);
                if (j < 0) continue;
                const [match] = parsed.splice(j, 1);
                results.push({ ...match, level: slot.level, replacement: slot.replacement });
                avoid.push(match.question.text);
                pending = pending.filter(p => p !== slot);
            }
        }
        if (pending.length) progress(`The model skipped ${pending.length} question(s) in batch ${b + 1}; generate them again if needed.`);
    }
    return results.sort((a, b) => a.level - b.level || Number(a.replacement) - Number(b.replacement));
}
