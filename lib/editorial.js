import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './durable.js';

const file = path.join(config.dataDir, 'question-reviews.json');
const reviews = readJson(file, {});
export const questionDigest = q => crypto.createHash('sha256').update(JSON.stringify([q.text, q.answers, q.correct, q.category || '', q.comment || ''])).digest('hex');
export function questionProblems(q) {
    const problems = [];
    if (!q?.text?.trim()) problems.push('Missing question');
    if (!Array.isArray(q?.answers) || q.answers.length !== 4 || q.answers.some(a => !String(a).trim())) problems.push('Four nonempty answers are required');
    if (Array.isArray(q?.answers) && new Set(q.answers.map(a => String(a).trim().toLocaleLowerCase())).size !== 4) problems.push('Answers must be distinct');
    if (!Number.isInteger(q?.correct) || q.correct < 0 || q.correct > 3) problems.push('Choose the correct answer');
    if (q?.text?.length > 280 || q?.answers?.some(a => String(a).length > 90)) problems.push('Text may overflow the theme: shorten it before approval');
    return problems;
}
export const questionReview = q => ({ status: 'draft', sourceUrl: '', ...reviews[questionDigest(q)] });
export function reviewQuestion(q, input, actor) {
    const hash = questionDigest(q), before = questionReview(q);
    const status = input.status || 'draft';
    if (!['draft', 'verified', 'approved'].includes(status)) throw new Error('Invalid review status');
    const sourceUrl = String(input.sourceUrl ?? before.sourceUrl).trim().slice(0, 1000);
    let expiresAt = input.expiresAt === '' ? null : input.expiresAt ?? before.expiresAt ?? null;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('Invalid expiry date');
    if (expiresAt) expiresAt = new Date(expiresAt).toISOString();
    const problems = questionProblems(q);
    if (status !== 'draft' && problems.length) throw new Error(problems.join('; '));
    if (status !== 'draft' && !/^https:\/\//i.test(sourceUrl)) throw new Error('A verifiable HTTPS source is required');
    if (status === 'approved' && actor.role !== 'admin') throw new Error('Only administrators can approve questions');
    if (status === 'approved' && before.status !== 'verified' && before.status !== 'approved') throw new Error('Verify the question before approving it');
    if (status !== 'draft' && expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error('The question has expired');
    reviews[hash] = { status, sourceUrl, expiresAt, author: before.author || actor.user, reviewer: status === 'draft' ? null : actor.user, reviewedAt: new Date().toISOString() };
    writeJson(file, reviews); return reviews[hash];
}
export function reviewSet(room) {
    const seen = new Set();
    return ['main', 'sw'].flatMap(set => room.questions[set].map((q, index) => {
        const issues = questionProblems(q), hash = questionDigest(q), review = questionReview(q);
        if (seen.has(hash)) issues.push('Duplicate question in this show');
        seen.add(hash);
        if (review.status !== 'approved') issues.push('Not approved');
        if (review.expiresAt && Date.parse(review.expiresAt) <= Date.now()) issues.push('Approval expired');
        return { set, level: index + 1, digest: hash, review, issues };
    }));
}
export const setDigest = room => crypto.createHash('sha256').update(JSON.stringify(room.questions)).digest('hex');
export function freezeSet(room, actor) {
    const issues = reviewSet(room).filter(row => row.issues.length);
    if (issues.length) throw new Error(`Review all main and replacement questions first (${issues.length} slots need attention)`);
    room.frozen = { version: setDigest(room), at: new Date().toISOString(), by: actor.user };
    return room.frozen;
}
