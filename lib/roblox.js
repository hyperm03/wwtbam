import crypto from 'node:crypto';

/**
 * Link with a Roblox set (e.g. the TPH "Who Wants to Be a Millionaire?" studio).
 *
 * The Roblox game server cannot be called from outside, so it polls: every ~0.35 s it asks for the commands queued
 * for its show and runs them (press a button of the set, load a question, set a value...). Every in-game control
 * button is registered on a "button bus" inside the game, so the web control room presses the very same buttons the
 * set already has: lights, graphics, sounds and screens behave exactly as with a real click.
 *
 * Per show (room.roblox): { enabled, key, mapping: { event: [button paths] } }. Runtime: command queue, connected servers.
 */
const CQ = 'Workspace.QandASystem.QuestionControl';
// "lifeline:<n>" presses the LifeControl of the lifeline slot whose LifelineNumber is n (the set resolves it, so it
// works whatever slot the lifeline was put in). Types of the TPH sets: 1 50:50, 2 Phone a Friend, 3 Ask the Audience,
// 4 Ask the Host, 5 Double Dip, 6 Ask the Expert (with clock), 7 expert in the studio, 8 Switch the Question.
export const LIFELINE_TYPES = { 1: '50:50', 2: 'Phone a Friend', 3: 'Ask the Audience', 4: 'Ask the Host', 5: 'Double Dip', 6: 'Ask the Expert (clock)', 7: 'Expert in the studio', 8: 'Switch the Question' };

/** Events of the game, in the order shown in the control panel, with the default buttons of the TPH sets. */
export const ROBLOX_EVENTS = [
    ['question-on-screen', 'Question on screen (the question is loaded into the set first)', [`${CQ}.Controls.ShowQuestionAnswers`]],
    ['lock-a', 'Final answer A locked', [`${CQ}.Controls.AnswerA`]],
    ['lock-b', 'Final answer B locked', [`${CQ}.Controls.AnswerB`]],
    ['lock-c', 'Final answer C locked', [`${CQ}.Controls.AnswerC`]],
    ['lock-d', 'Final answer D locked', [`${CQ}.Controls.AnswerD`]],
    ['lock-withdrawn', 'Final answer cancelled', []],
    ['reveal-correct', 'Answer revealed: correct', [`${CQ}.Controls.ShowCorrect`]],
    ['reveal-wrong', 'Answer revealed: wrong', [`${CQ}.Controls.ShowCorrect`]],
    ['question-off-screen', 'Question taken off screen', [`${CQ}.Controls.HideQuestion`]],
    ['new-question-level', 'Now playing a new level', []],
    ['tree-show', 'Money tree on screen', [`${CQ}.Tree.ShowHideTree`]],
    ['tree-hide', 'Money tree hidden', [`${CQ}.Tree.ShowHideTree`]],
    ['walk-away', 'The contestant walks away', [`${CQ}.Tree.PlayerExit`]],
    ['game-over', 'Game over (G)', [`${CQ}.Cues.Closing`]],
    ['top-prize', 'Top prize won', [`${CQ}.Cues.AfterQ15Winner`]],
    ['commercial-on', 'Commercial break', [`${CQ}.Cues.CommercialTo`]],
    ['commercial-off', 'Back from the commercial break', [`${CQ}.Cues.Commercial From`]],
    ['lifelines-strap', 'Lifelines strap (L)', [`${CQ}.Lifelines.ShowHideLifelines`]],
    ['lifeline-ff', 'Lifeline: 50:50', ['lifeline:1', 'lifeline:1']],
    ['ata-start', 'Ask the Audience: started', ['lifeline:3']],
    ['ata-graph', 'Ask the Audience: graph on screen', []],
    ['ata-vote', 'Ask the Audience: voting', ['lifeline:3']],
    ['ata-results', 'Ask the Audience: results', ['lifeline:3']],
    ['ata-close', 'Ask the Audience: graph closed', ['lifeline:3']],
    ['paf-start', 'Phone a Friend: started', ['lifeline:2']],
    ['paf-call', 'Phone a Friend: the call', []],
    ['paf-clock', 'Phone a Friend: clock started', ['lifeline:2']],
    ['paf-end', 'Phone a Friend: call ended', ['lifeline:2']],
    ['stq-start', 'Switch the Question: started', ['lifeline:8']],
    ['stq-reveal-correct', 'Switch the Question: current correct answer revealed', ['lifeline:8']],
    ['stq-switch', 'Switch the Question: switch animation', ['lifeline:8']],
    ['stq-new-question', 'Switch the Question: new question on screen (loaded into the set first)', [`${CQ}.Controls.ShowQuestionAnswers`]],
    ['dd-start', 'Double Dip activated', []],
    ['dd-end', 'Double Dip finished', []],
    ['ate-start', 'Ask the Expert: started', ['lifeline:6']],
    ['ate-talk', 'Ask the Expert: the expert is talking (clock)', ['lifeline:6']],
    ['ate-end', 'Ask the Expert: finished', ['lifeline:6']],
    ['klaxon', 'Klaxon (K)', [`${CQ}.Cues.Klaxon`]],
    ['fff-intro', 'Fastest Finger: players introduced', [`${CQ}.FFF.MeetTheContestants`]],
    ['fff-question', 'Fastest Finger: question on screen', []],
    ['fff-items', 'Fastest Finger: the four items on air', [`${CQ}.FFF.ShowFFFQuestionAnswers`]],
    ['fff-order', 'Fastest Finger: next item of the correct order', [`${CQ}.FFF.RevealFFFOrder`]],
    ['fff-results', 'Fastest Finger: times revealed', [`${CQ}.FFF.RevealWhoGotIt`]],
    ['fff-winner', 'Fastest Finger: the winner on full screen', []]
];
const EVENT_IDS = new Set(ROBLOX_EVENTS.map(e => e[0]));
const defaultMapping = () => Object.fromEntries(ROBLOX_EVENTS.map(([id, , b]) => [id, [...b]]));

const runtime = new Map();
const R = roomId => {
    if (!runtime.has(roomId)) runtime.set(roomId, { queue: [], nextId: 1, servers: new Map(), buttons: [], lastPoll: 0 });
    return runtime.get(roomId);
};

export const roblox = {
    events: ROBLOX_EVENTS,
    lifelineTypes: LIFELINE_TYPES,

    /** Settings of a show (created on first use). */
    config(room) {
        room.roblox ??= { enabled: false, key: crypto.randomBytes(18).toString('base64url'), mapping: defaultMapping(), custom: false };
        // A show that never changed its mapping always follows the current defaults (they improve with new sets)
        room.roblox.mapping = room.roblox.custom ? { ...defaultMapping(), ...room.roblox.mapping } : defaultMapping();
        return room.roblox;
    },
    newKey(room) { this.config(room).key = crypto.randomBytes(18).toString('base64url'); },
    setMapping(room, mapping) {
        const clean = {};
        for (const [id, list] of Object.entries(mapping || {})) {
            if (!EVENT_IDS.has(id) || !Array.isArray(list)) continue;
            clean[id] = list.map(p => String(p).slice(0, 300)).filter(p => /^[\w .\-()#&'+,!/:]+$/.test(p)).slice(0, 10);
        }
        const c = this.config(room);
        c.mapping = { ...defaultMapping(), ...clean };
        c.custom = true;
    },
    resetMapping(room) { const c = this.config(room); c.mapping = defaultMapping(); c.custom = false; },
    authorised(room, key) {
        const c = room?.roblox;
        if (!c?.enabled || !key) return false;
        const a = Buffer.from(String(key)), b = Buffer.from(c.key);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    // ------------------------------------------------------------------ commands for the set
    queue(room, cmd) {
        if (!room.roblox?.enabled) return;
        const r = R(room.id);
        r.queue.push({ id: r.nextId++, at: Date.now(), ...cmd });
        if (r.queue.length > 300) r.queue.splice(0, r.queue.length - 300);
    },
    /** A game event: the buttons mapped to it are pressed in the set, in order. */
    event(room, id, extra = {}) {
        if (!room.roblox?.enabled || !EVENT_IDS.has(id)) return;
        for (const path of this.config(room).mapping[id] || []) this.queue(room, { type: 'press', path, event: id, ...extra });
    },
    press(room, path) { this.queue(room, { type: 'press', path, event: 'manual' }); },
    /** Commands newer than `since` (the set sends the last id it ran). A new server starts from the newest. */
    poll(room, since, server) {
        const r = R(room.id);
        r.lastPoll = Date.now();
        const s = r.servers.get(server.jobId) ?? { firstSeen: Date.now() };
        r.servers.set(server.jobId, { ...s, ...server, lastSeen: Date.now() });
        const from = Number(since);
        if (!Number.isFinite(from) || from < 0) return { commands: [], last: r.nextId - 1 };
        return { commands: r.queue.filter(c => c.id > from && Date.now() - c.at < 30000), last: r.nextId - 1 };
    },
    hello(room, info) {
        const r = R(room.id);
        if (Array.isArray(info.buttons)) r.buttons = info.buttons.map(String).filter(Boolean).slice(0, 2000).sort();
        r.servers.set(String(info.jobId), { placeId: info.placeId, jobId: String(info.jobId), players: info.players ?? 0, firstSeen: Date.now(), lastSeen: Date.now() });
    },
    status(room) {
        const r = R(room.id), now = Date.now();
        for (const [id, s] of r.servers) if (now - s.lastSeen > 60000) r.servers.delete(id);
        return {
            servers: [...r.servers.values()].map(s => ({ jobId: s.jobId, placeId: s.placeId, players: s.players, online: now - s.lastSeen < 5000, lastSeen: s.lastSeen })),
            buttons: r.buttons, queued: r.queue.length
        };
    }
};
