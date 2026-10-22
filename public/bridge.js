/*
 * NetBridge.js - bridge between the .NET control panel and the HTML5 game (Project Rave 2007_Blue).
 * The app injects it after default.html has loaded: the game files are never modified by it.
 *
 * Commands received (chrome.webview.postMessage from .NET):
 *   { cmd: "key", code: 39 }                                     simulate a game keyboard key
 *   { cmd: "setAll", main: [...], sw: [...] }                    replace every question (main + switch)
 *   { cmd: "setQuestion", level: 5, isSwitch: false, q: {...} }  replace a single question
 *   { cmd: "redraw", isSwitch: false }                           redraw the question currently on screen
 *   { cmd: "ata", perc: [a,b,c,d] | null, live: true }           Ask the Audience percentages (null = game random)
 *   { cmd: "fiftyPick", pick: ["a","c"] | null }                 wrong answers the next 50:50 removes (null = random)
 *   { cmd: "lifelineUsed", id: "paf", used: true }               mark a lifeline as used / available again (ff paf ata stq dd ate)
 *   { cmd: "pafContacts", contacts: [{first,last,location} x3] }   Clocked: the three Phone a Friend contacts
 *   { cmd: "fff", action: "setup"|"results"|"end", ... }          Fastest Finger First round (question, players, times, winner)
 *   { cmd: "contestant", first: "", last: "", location: "" }     contestant name strap
 *   { cmd: "goToLevel", level: 7 }                               abandon what is on screen and restart from question 7
 *   { cmd: "klaxonConfig", url: "..." }                          fallback klaxon for a theme without its own audio function
 *
 * Messages sent to .NET: { type: "state", ... } whenever the state changes, { type: "error", message }.
 */
(function () {
    if (window.NetBridge) { return; }
    var wv = window.chrome && window.chrome.webview;
    if (!wv || !window.GameVariables) { return; }

    var GV = window.GameVariables;
    var LETTERS = ['A', 'B', 'C', 'D'];

    // ---------------------------------------------------------------- output is display only
    // Real keyboard, mouse, touch and wheel input on the output page never reaches the game: the game is
    // controlled only by the control panel. The panel's own key presses are simulated by the bridge (not
    // "trusted" browser events), so they still go through. Elements marked data-mc-allow (e.g. the web
    // output's "click to enable sound" overlay) stay clickable.
    if (!window.__mcInputLocked) {
        window.__mcInputLocked = true;
        var lockInput = function (e) {
            if (!e.isTrusted) { return; }
            if (e.target && e.target.closest && e.target.closest('[data-mc-allow]')) { return; }
            e.stopImmediatePropagation();
            if (e.cancelable) { e.preventDefault(); }
        };
        ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick',
         'wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup'].forEach(function (type) {
            window.addEventListener(type, lockInput, { capture: true, passive: false });
        });
    }
    // 'ate' (Ask the Expert, Clocked 2009) comes last so the positions of the others never change
    var LIFELINES = ['ff', 'paf', 'ata', 'stq', 'dd', 'ate'];

    // Clocked 2009 (US): question timer with banked time, Ask the Expert, Phone a Friend with three contacts
    var CLOCKED = typeof window.startTimer === 'function' && typeof window.checkTierTimer === 'function' && 'TimerPaused' in GV;
    var NB = window.NetBridge = { ataOverride: null, fiftyPick: null, used: {} };

    // Centre the fixed 1920x1080 scene when the window has a different aspect ratio. The page stays transparent when
    // the host asked for it (OBS browser source: no black behind the graphics, for chroma / luma keying).
    if (!(window.__MC && window.__MC.transparent)) { document.documentElement.style.background = 'black'; }
    document.body.style.margin = '0 auto';

    function toQA(q) {
        var qa = new QuestionAndAnswer();
        qa.Category = q.category || '';
        qa.Question = String(q.text || '').split('++++').join('<br />');
        qa.AnswerA = q.a || '';
        qa.AnswerB = q.b || '';
        qa.AnswerC = q.c || '';
        qa.AnswerD = q.d || '';
        qa.CorrectAnswer = String(q.correct || 'a').toLowerCase();
        return qa;
    }

    // ---------------------------------------------------------------- lifelines used

    // Which lifelines this theme really has (e.g. most themes have no Double Dip)
    var supported = LIFELINES.map(function (id) { return typeof window[id + 'LifeLineDisable'] === 'function'; });

    LIFELINES.forEach(function (id) {
        NB.used[id] = !!GV['Is' + id.toUpperCase() + 'LifeLineUsed'];
        var name = id + 'LifeLineDisable';
        var original = window[name];
        window[name] = function () {
            NB.used[id] = true;
            if (typeof original === 'function') { return original.apply(this, arguments); }
        };
    });

    function restoreLifeline(id) {
        NB.used[id] = false;
        GV['Is' + id.toUpperCase() + 'LifeLineUsed'] = false;
        $('.' + id + 'LifeLine .lifelineUsedImg, .' + id + 'StrapLifeLine .lifelineUsedStrapImg').css('opacity', 0);
        $('.' + id + 'LifeLine .lifelineFillRedTreeImg, .' + id + 'StrapLifeLine .lifelineFillRedStrapImg').css('opacity', 0);
        if (typeof GV[id + 'LifeLineSequenceCounter'] === 'number') { GV[id + 'LifeLineSequenceCounter'] = 0; }
    }

    // ---------------------------------------------------------------- 50:50 with a chosen pair

    var originalFifty = window.ffRemoveTwoWrongAnswers;
    window.ffRemoveTwoWrongAnswers = function () {
        var pick = NB.fiftyPick;
        NB.fiftyPick = null;
        var valid = pick && pick.length === 2 && pick[0] !== pick[1] &&
            pick.indexOf(GV.CurrentCorrectAnswer) < 0;
        if (!valid) { return originalFifty(); }
        if (GV.AnswerAIsOut || GV.AnswerBIsOut || GV.AnswerCIsOut || GV.AnswerDIsOut) { return; }

        window.ffLifeLineDisable();
        pick.forEach(function (letter) {
            var L = String(letter).toUpperCase();
            $('#answer' + L + ' .letterP, #answer' + L + ' .answerP, #answer' + L + ' .diagonalImg').css('opacity', 0);
            GV['Answer' + L + 'IsOut'] = true;
        });
    };

    // ---------------------------------------------------------------- Ask the Audience

    function applyAta() {
        var p = NB.ataOverride;
        if (!p) { return; }
        for (var i = 0; i < 4; i++) {
            var L = LETTERS[i];
            var v = Math.round(Number(p[i]) || 0);
            GV['Answer' + L + 'Percent'] = GV['Answer' + L + 'IsOut'] ? 0 : Math.max(0, Math.min(100, v));
        }
    }

    var originalGenerate = window.generateGraphPercentanges;
    window.generateGraphPercentanges = function () {
        if (NB.ataOverride) {
            applyAta();
        } else if (typeof originalGenerate === 'function') {
            originalGenerate();
        }
    };

    // ---------------------------------------------------------------- Klaxon (key K, end of the show)

    // If the theme's own keyboard handler already handles K (keyCode 75), leave it alone
    var nativeKlaxon = false;
    try {
        var events = $._data(document, 'events');
        ((events && events.keydown) || []).forEach(function (h) {
            if (/keyCode\s*===?\s*75\b/.test(String(h.handler))) { nativeKlaxon = true; }
        });
    } catch (e) { /* no jQuery event data: assume no native klaxon */ }

    NB.klaxonUrl = null;
    NB.klaxonAudio = null;

    function stopGameSounds() {
        ['GeneralSound', 'LifelineActiveSound', 'LifelinePassiveSound', 'LongActiveSound',
         'LongPassiveSound', 'ShortActiveSound', 'ShortPassiveSound'].forEach(function (name) {
            var audio = GV[name];
            if (audio && typeof audio.pause === 'function') { try { audio.pause(); } catch (e) { } }
        });
    }

    // The klaxon is the theme's own sound: every theme plays Sounds/game_over.mp3 through its startGeneralSound()
    // at the start of its "G" closing sequence, then stops the bed and lifeline music half a second later.
    // K does exactly that (without the rest of the closing sequence). The URL from the host is only a fallback
    // for a theme without that audio function.
    function playKlaxon() {
        if (typeof window.startGeneralSound === 'function') {
            window.startGeneralSound('game_over.mp3');
            if (typeof window.stopLongPassiveSound === 'function') { setTimeout(window.stopLongPassiveSound, 500); }
            if (typeof window.stopLifelineActiveSound === 'function') { setTimeout(window.stopLifelineActiveSound, 500); }
            return;
        }
        if (!NB.klaxonUrl) {
            wv.postMessage({ type: 'error', message: 'this theme has no klaxon sound' });
            return;
        }
        stopGameSounds();
        if (NB.klaxonAudio) { try { NB.klaxonAudio.pause(); } catch (e) { } }
        NB.klaxonAudio = new Audio(NB.klaxonUrl);
        var playing = NB.klaxonAudio.play();
        if (playing && playing.catch) {
            playing.catch(function (err) { wv.postMessage({ type: 'error', message: 'klaxon: ' + err }); });
        }
    }

    if (!nativeKlaxon) {
        // Bound with jQuery so both real key presses and the panel's simulated ones reach it
        $(document).on('keydown', function (e) { if (e.keyCode === 75) { playKlaxon(); } });
    }

    // ---------------------------------------------------------------- restart from a given question

    function call(name) {
        if (typeof window[name] !== 'function') { return; }
        try { window[name].apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { /* keep going */ }
    }

    /// Text the game uses for an amount already won (top prize text where the theme uses it)
    function wonText(index) {
        if (index < 0) { return formatPrize(0); }
        if (GV.UseTopPrizeText && GV.TopPrizeText && index + 1 >= (GV.TopPrizeQuestionNumber || 99)) { return GV.TopPrizeText[index]; }
        return formatPrize(GV.PrizeAmounts[index]);
    }

    function goToLevel(level) {
        var count = (GV.PrizeAmounts || []).length || 15;
        level = Math.max(1, Math.min(count, Math.round(level) || 1));
        var previous = GV.QuestionLevel || 1;

        // Silence, klaxon included
        stopGameSounds();
        if (NB.klaxonAudio) { try { NB.klaxonAudio.pause(); } catch (e) { } }

        // Lifelines in progress: close their graphics; one that had already started counts as used
        if (GV.ataLifeLineSequenceCounter >= 2) { call('slideOutATAGraph'); }
        if (GV.ataLifeLineSequenceCounter > 0) { call('ataLifeLineDisable'); }
        GV.ataLifeLineSequenceCounter = 0;
        if (GV.pafLifeLineSequenceCounter >= 3) {
            clearTimeout(GV.PAFClockTimeout);
            call('pafHideClock');                 // also marks it used; it restarts the bed music, stopped again below
            setTimeout(stopGameSounds, 800);
        } else if (GV.pafLifeLineSequenceCounter > 0) {
            call('pafLifeLineDisable');
            GV.pafLifeLineSequenceCounter = 0;
        }
        if (GV.stqLifeLineSequenceCounter > 0) { call('stqLifeLineDisable'); GV.stqLifeLineSequenceCounter = 0; }
        if (GV.IsDDLifeLineActive) { GV.IsDDLifeLineActive = false; GV.ddLifeLineSequenceCounter = 0; }
        call('hideLifeLineCentered');

        // Everything on screen for the current question
        call('hideQuestionAndAnswerStraps');
        call('resetAnswerStraps');
        if (GV.IsLevelStrapShowing) { call('hideLevelStrap'); GV.IsLevelStrapShowing = false; }
        if (GV.IsLifeLineStrapShowing) { call('slideLifeLineStrapOut'); GV.IsLifeLineStrapShowing = false; }
        call('hideAmountWon');
        call('hideMillionaireTitleStrap');
        if (GV.IsTotalPrizeMoneyShowing) { call('hideTotalPrizeMoneyStrap'); GV.IsTotalPrizeMoneyShowing = false; }

        // Game state: between questions, the next "Next" press starts question <level> (lights down first)
        GV.QuestionLevel = level;
        GV.QuestionInProgress = false;
        GV.QuestionSequenceCounter = 0;
        GV.CurrentTargetAnswer = '';
        GV.CurrentCorrectAnswer = '';
        GV.CannotLockInFinalAnswer = false;
        GV.IsWalkingAway = false;
        GV.walkAwaySequenceCounter = 0;
        GV.commericalSequenceCounter = 0;
        GV.RevealAnswerCounter = 0;
        GV.AnswerAIsOut = GV.AnswerBIsOut = GV.AnswerCIsOut = GV.AnswerDIsOut = false;
        GV.FirstTierBackgroundSoundPlaying = false;

        call('setLevelOnMoneyTree', level);
        var unlock = GV.STQUnlockedLevel;
        if (typeof unlock === 'number') {
            // The lifeline unlocked from question <unlock>: Switch the Question, or Ask the Expert when it replaces it (Clocked)
            var late = GV.ReplaceSTQwithATE && typeof window.ateLifeLineSlideIn === 'function' ? 'ate' : 'stq';
            if (previous < unlock && level >= unlock) { call(late + 'LifeLineSlideIn'); }
            else if (previous >= unlock && level < unlock) { call(late + 'LifeLineSlideOut'); }
        }
        try { $('.totalPrizeMoneyWonDiv').html(wonText(level - 2)); } catch (e) { }

        if (CLOCKED) {
            // Question clock back to rest: stopped, hidden, ready for the tier of the new level
            ['pauseTimer', 'stopTimerSound', 'hideTimer', 'resetTimer'].forEach(function (f) { call(f); });
            if (GV.IsBankedTimeShowing) { call('hideBankedTime'); GV.IsBankedTimeShowing = false; }
            GV.TimerPaused = true;
            GV.TimerReady = false;
            GV.CannotShowTimerBeforeQuestion = true;
            GV.IsTimerShowingBeforeQuestion = false;
            GV.BankedTimeToggleLock = false;
            GV.CanSelectPafContact = false;
            GV.ateLifeLineSequenceCounter = GV.IsATELifeLineUsed ? GV.ateLifeLineSequenceCounter : 0;
        }
    }

    // ---------------------------------------------------------------- Clocked: question clock

    /** The question clock as the game shows it: seconds left (gold "m:ss" clock at question 15), banked time. */
    function readClock() {
        var level = GV.QuestionLevel;
        var gold = level === 15;
        var left = null;
        try { left = gold ? (typeof totalTime !== 'undefined' ? totalTime : null) : (typeof seconds !== 'undefined' ? seconds : null); } catch (e) { }
        var seq = GV.QuestionSequenceCounter;
        return {
            running: GV.TimerPaused === false,
            seconds: typeof left === 'number' ? left : null,
            text: $.trim($(gold ? '.timerSecondsGoldDiv' : '.timerSecondsDiv').first().text() || ''),
            gold: gold,
            tier: level <= 5 ? 15 : level <= 10 ? 30 : level <= 14 ? 45 : null,
            banked: Number(GV.BankedTime) || 0,
            bankedText: $.trim($('.timerSecondsBankedDiv').first().text() || ''),
            bankedShowing: !!GV.IsBankedTimeShowing,
            showing: !!GV.TimerReady || !!GV.IsTimerShowingBeforeQuestion || (!!GV.QuestionInProgress && seq !== 0 && seq !== 1),
            // Time ran out: the game jumps to step 10 (reveal) then 11 (end) with no final answer locked
            timeUp: (seq === 10 || seq === 11) && !GV.CurrentTargetAnswer && !!GV.IsWalkingAway
        };
    }

    /**
     * Clocked shows the category of every question on the money tree. It reads them once at start-up from the theme's
     * questions.xml into the global allCategories and draws them with renderCategoryTreeTable(): here they follow the
     * questions sent by the control panel. Only the text of the existing rows changes, so their on-screen state
     * (current level lit, others dimmed, hidden) is kept. Themes without the category table are not affected.
     */
    function syncCategories() {
        var list = GV.QuestionsAndAnswers || [];
        var cats = [];
        for (var i = 0; i < 15; i++) { cats.push(list[i] && list[i].Category ? String(list[i].Category) : ''); }
        try {
            if (typeof allCategories !== 'undefined' && Array.isArray(allCategories)) {
                allCategories.length = 0;
                Array.prototype.push.apply(allCategories, cats);
            }
        } catch (e) { }
        cats.forEach(function (c, i) { $('#categoryTr' + (i + 1) + ' .moneyTreeCategoryTd').text(c); });
    }

    function pafContactsList() {
        var keys = ['One', 'Two', 'Three'];
        return keys.map(function (k) {
            return { first: GV['Paf' + k + 'FirstName'] || '', last: GV['Paf' + k + 'LastName'] || '', location: GV['Paf' + k + 'Location'] || '' };
        });
    }

    // ---------------------------------------------------------------- commands

    function pressKey(code) {
        var ev = $.Event('keydown');
        ev.keyCode = code;
        ev.which = code;
        $(document).trigger(ev);
    }

    var handlers = {
        restore: function (m) {
            var saved = m.state, recovery = saved && saved.recovery;
            if (!recovery || recovery.version !== 1 || saved.fff && saved.fff.active) { throw new Error('Unsupported checkpoint'); }
            goToLevel(saved.level);
            Object.keys(recovery.fields || {}).forEach(function (name) {
                var value = recovery.fields[name];
                if (Object.prototype.hasOwnProperty.call(GV, name) && !/Timeout|Interval|SoundPlaying|__proto__|constructor|prototype/i.test(name) &&
                    (typeof value === 'boolean' || typeof value === 'number' && isFinite(value) || typeof value === 'string' && value.length < 2000)) { GV[name] = value; }
            });
            if (saved.inProgress) { window.setQuestion(!!saved.screen.isSwitch); }
            // Reapply the saved variables after setQuestion, which can reset target and sequence counters.
            ['QuestionSequenceCounter', 'CurrentTargetAnswer', 'CurrentCorrectAnswer', 'QuestionInProgress'].forEach(function (name) {
                if (Object.prototype.hasOwnProperty.call(recovery.fields, name)) { GV[name] = recovery.fields[name]; }
            });
            NB.onScreenSwitch = !!(saved.screen && saved.screen.isSwitch);
            LIFELINES.forEach(function (id, i) { handlers.lifelineUsed({ id: id, used: !!saved.used[i] }); });
            (recovery.scene || []).slice(0, 2500).forEach(function (entry) {
                var node = document.body;
                if (!Array.isArray(entry.path) || entry.path.length > 30) { return; }
                entry.path.forEach(function (index) { node = node && Number.isInteger(index) && index >= 0 ? node.children[index] : null; });
                if (!node || node.tagName !== entry.tag) { return; }
                if (/^(0(?:\.\d+)?|1(?:\.0+)?)$/.test(entry.opacity)) { node.style.opacity = entry.opacity; }
                if (/^(none|block|inline|inline-block|flex|grid|table|table-row|table-cell|table-row-group)$/.test(entry.display)) { node.style.display = entry.display; }
                if (/^(none|matrix(?:3d)?\([-\d., e]+\))$/.test(entry.transform)) { node.style.transform = entry.transform; }
            });
            (recovery.text || []).forEach(function (entry) {
                if (/^\.(timerSeconds(?:Gold|Banked)?Div|totalPrizeMoneyWonDiv)$/.test(entry.selector)) { $(entry.selector).text(String(entry.value).slice(0, 100)); }
            });
            if (CLOCKED) {
                call('pauseTimer');
                GV.TimerPaused = true;
                if (typeof seconds !== 'undefined' && saved.clock && typeof saved.clock.seconds === 'number') { seconds = saved.clock.seconds; }
                if (typeof totalTime !== 'undefined' && saved.clock && typeof saved.clock.seconds === 'number') { totalTime = saved.clock.seconds; }
            }
            stopGameSounds();
            NB.recovered = true;
        },
        key: function (m) {
            pressKey(Number(m.code));
            // Fastest Finger with fewer than 10 players: after the last one is introduced, go straight on
            if (Number(m.code) === 37 && GV.IsPlayingFasestFinger && NB.fffCount < 10 &&
                GV.FastestFingerSequenceCounter >= NB.fffCount && GV.FastestFingerSequenceCounter < 10) {
                GV.FastestFingerSequenceCounter = 10;
            }
        },
        fff: function (m) {
            var esc = function (t) { return $('<div>').text(String(t == null ? '' : t)).html(); };
            if (m.action === 'setup') {
                // A Fastest Finger round (or tie-breaker): question, correct order and the players of this round
                var q = m.question || {}, players = m.players || [], order = String(q.order || 'ABCD');
                NB.fffCount = players.length;
                call('hideTheFastestFingerWinner');
                clearTimeout(GV.ShowWinnerTimeout);
                call('hideFastestFingerQuestionAndAnswers');
                call('hideFastestFingerAnswerTree');
                $('.fastestFingerContestantsDiv').css('opacity', 0);
                // The full-screen background of the players list (left on if the previous round was cancelled)
                $('#stageBackgroundImg').css('opacity', 0);
                GV.IsPlayingFasestFinger = true;
                // Tie-breaker: no introductions, straight to the question
                GV.FastestFingerSequenceCounter = m.tieBreak ? 11 : 0;
                GV.RevealFastestFingerContestantCounter = 0;
                GV.FastestFingerRevealAnswerCounter = 0;
                GV.RevealFastestFingerWinnersCounter = 0;
                GV.FastestFingerContestants = players.map(function (p) { return { FirstName: p.first || '', LastName: p.last || '', Location: p.location || '' }; });
                GV.FastestFingerContestantTimes = []; GV.FastestFingerContestantWinners = [];
                for (var i = 0; i < 10; i++) {
                    GV.FastestFingerContestantTimes.push('');
                    GV.FastestFingerContestantWinners.push(false);
                    var row = $('#fastestContestant' + (i + 1));
                    row.css('display', i < players.length ? '' : 'none');
                    // Back to how the theme draws a fresh row: correct-answer fills off, time strap (Clocked) folded
                    row.find('.fastestTimeCorrectFillImg, .fastestNameCorrectFillImg').css('opacity', 0);
                    row.find('.fastestContestantTimeDiv').removeAttr('style');
                    row.css('transform', '');
                    row.find('.fastestContestantNameP, .fastestContestantTimeP').removeClass('animate');
                    // The time is emptied, not hidden: classic themes hide and show it themselves, Clocked never does
                    row.find('.fastestContestantTimeP').html('').css('opacity', '');
                    if (i < players.length) { row.find('.fastestContestantNameP').html(esc(((players[i].first || '') + ' ' + (players[i].last || '')).trim())).css('color', '#FFFFFF'); }
                }
                GV.FastestFingerConstestantWinner = 1;
                // Nothing left over from the previous round on the winner screen (OlgaV2 uses its own time element)
                $('#fastestContestant .fastestContestantNameP, #fastestContestant .fastestContestantTimeP, #fastestContestant .fastestContestantWinnerTimeP').html('');
                // The question and the four items, in the question and answer straps
                $('.questionTd').html(esc(q.text));
                ['A', 'B', 'C', 'D'].forEach(function (L, k) { $('#answer' + L + ' .answerP').html(esc((q.answers || [])[k])); });
                // The correct order, for the order tree
                $('.fastestFingerTreeQuestionP').html(esc(q.text));
                for (var n = 0; n < 4; n++) {
                    var letter = order.charAt(n), idx = 'ABCD'.indexOf(letter);
                    $('#fastestAnswerOrder' + (n + 1) + ' .fastestTreeLetterP').html(letter + ':');
                    $('#fastestAnswerOrder' + (n + 1) + ' .fastestTreeAnswerP').html(esc((q.answers || [])[idx]));
                }
            } else if (m.action === 'results') {
                // Times of every player (seconds), who answered correctly, and the fastest (1-based row)
                for (var r = 0; r < 10; r++) {
                    GV.FastestFingerContestantTimes[r] = m.times && m.times[r] != null ? m.times[r] : '';
                    GV.FastestFingerContestantWinners[r] = !!(m.correct && m.correct[r]);
                }
                GV.FastestFingerConstestantWinner = m.winner || 1;
            } else if (m.action === 'end') {
                clearTimeout(GV.ShowWinnerTimeout);
                call('hideTheFastestFingerWinner');
                call('hideFastestFingerQuestionAndAnswers');
                call('hideFastestFingerAnswerTree');
                $('.fastestFingerContestantsDiv').css('opacity', 0);
                $('#stageBackgroundImg').css('opacity', 0);
                GV.IsPlayingFasestFinger = false;
                GV.FastestFingerSequenceCounter = 0;
            }
        },
        setAll: function (m) {
            (m.main || []).forEach(function (q, i) { GV.QuestionsAndAnswers[i] = toQA(q); });
            (m.sw || []).forEach(function (q, i) { GV.SwitchQuestionsAndAnswers[i] = toQA(q); });
            syncCategories();
        },
        setQuestion: function (m) {
            var list = m.isSwitch ? GV.SwitchQuestionsAndAnswers : GV.QuestionsAndAnswers;
            list[Number(m.level) - 1] = toQA(m.q);
            if (!m.isSwitch) { syncCategories(); }
        },
        redraw: function (m) {
            if (GV.QuestionInProgress) { window.setQuestion(!!m.isSwitch); }
        },
        ata: function (m) {
            NB.ataOverride = m.perc ? m.perc.slice(0, 4) : null;
            if (!NB.ataOverride) { return; }
            // 3 = voting (percentages generated but hidden): replace them
            // 4 = results on screen: replace them and animate the graph again
            if (GV.ataLifeLineSequenceCounter === 3) {
                applyAta();
            } else if (GV.ataLifeLineSequenceCounter === 4 && m.live !== false) {
                applyAta();
                window.revealGraphPercentages();
            }
        },
        fiftyPick: function (m) {
            NB.fiftyPick = m.pick ? m.pick.map(function (l) { return String(l).toLowerCase(); }) : null;
        },
        lifelineUsed: function (m) {
            if (LIFELINES.indexOf(m.id) < 0) { return; }
            if (m.used) { window[m.id + 'LifeLineDisable'](); }
            else { restoreLifeline(m.id); }
        },
        goToLevel: function (m) {
            goToLevel(Number(m.level));
        },
        klaxonConfig: function (m) {
            NB.klaxonUrl = m.url || null;
        },
        pafContacts: function (m) {
            // Clocked: the three friends listed on the Phone a Friend screen
            if (!Array.isArray(m.contacts)) { return; }
            var esc = function (t) { return $('<div>').text(String(t || '')).html(); };
            ['One', 'Two', 'Three'].forEach(function (k, i) {
                var c = m.contacts[i] || {};
                GV['Paf' + k + 'FirstName'] = String(c.first || '');
                GV['Paf' + k + 'LastName'] = String(c.last || '');
                GV['Paf' + k + 'Location'] = String(c.location || '');
                if (GV['Paf' + k + 'FirstName'] !== '') {
                    $('#pafContactDetails' + (i + 1)).html(esc(c.first) + ' ' + esc(c.last) + '<br>' + esc(c.location));
                }
            });
        },
        contestant: function (m) {
            GV.ContestantFirstName = m.first || '';
            GV.ContestantLastName = m.last || '';
            GV.ContestantLocation = m.location || '';
            var full = (GV.ContestantFirstName + ' ' + GV.ContestantLastName).trim();
            $('.contestantNameAndLocationDiv .contestantNameP').html(full);
            $('.contestantNameAndLocationDiv .contestantLocationP').html(GV.ContestantLocation);
            $('.millionaireWinnerNameDiv').html(full);
        }
    };

    // ---------------------------------------------------------------- state

    // Amount formatted with the theme's main number format (currency and locale from Variables.js)
    function formatPrize(v) {
        try {
            return (GV.NumberPrefix || '') +
                new Intl.NumberFormat(GV.LocaleCode || 'en', GV.FormatOptions).format(v)
                    .replace(GV.ReplaceCharacterBefore || '', GV.ReplaceCharacterAfter || '').trim() +
                (GV.NumberSuffix || '');
        } catch (e) {
            return String(v);
        }
    }

    // ---------------------------------------------------------------- automatic top prize text

    // gameVariables.AutoTopPrizeText = true (written by the panel's Money tree settings) makes the text shown
    // instead of the top amounts ("$1 MILLION") follow the theme's own amount, currency and language.
    // Keep in sync with MoneyTreeWindow.AutoTextFunction.
    function autoTopPrizeText(amount, locale, opts, prefix, suffix, upper) {
        var words = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 2 }).format(amount);
        var text = words;
        if (opts && opts.style === 'currency' && opts.currency) {
            var parts = new Intl.NumberFormat(locale, { style: 'currency', currency: opts.currency, currencyDisplay: opts.currencyDisplay || 'symbol' }).formatToParts(amount);
            var ci = -1, ni = -1;
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].type === 'currency' && ci < 0) { ci = i; }
                if (parts[i].type === 'integer' && ni < 0) { ni = i; }
            }
            if (ci >= 0) {
                var gap = ci < ni ? parts[ci + 1] : parts[ci - 1];
                var space = gap && gap.type === 'literal' ? gap.value : '';
                text = ci < ni ? parts[ci].value + space + words : words + space + parts[ci].value;
            }
        }
        text = (prefix || '') + text + (suffix || '');
        return upper === false ? text : text.toLocaleUpperCase(locale);
    }

    function applyAutoTopPrizeText() {
        if (GV.AutoTopPrizeText !== true || !GV.PrizeAmounts) { return; }
        var upper = GV.AutoTopPrizeTextUpperCase !== false;
        function textFor(i) {
            try { return autoTopPrizeText(GV.PrizeAmounts[i], GV.LocaleCode || 'en', GV.FormatOptions, GV.NumberPrefix, GV.NumberSuffix, upper); }
            catch (e) { return null; }
        }
        var n = GV.PrizeAmounts.length;
        for (var i = Math.max(0, (GV.TopPrizeQuestionNumber || n) - 1); i < n && GV.TopPrizeText; i++) {
            var t = textFor(i);
            if (t === null) { continue; }
            GV.TopPrizeText[i] = t;
            // The tree was drawn by init() before the bridge: update those rows in place
            if (GV.UseTopPrizeText) { $('#moneyTreeTr' + (i + 1) + ' td').last().html(t); }
        }
        for (var j = Math.max(0, (GV.TopPrizeLevelStrapQuestionNumber || n) - 1); j < n && GV.TopPrizeLevelStrapText; j++) {
            var s = textFor(j);
            if (s !== null) { GV.TopPrizeLevelStrapText[j] = s; }
        }
    }
    try { applyAutoTopPrizeText(); } catch (e) { /* theme without top prize text settings */ }

    // Money tree amounts exactly as the game drew them on screen (top prize formats included);
    // computed from the main format only when the tree cannot be read
    function readTreeFromScreen() {
        try {
            var texts = [];
            for (var level = 1; level <= (GV.PrizeAmounts || []).length; level++) {
                var cell = $('#moneyTreeTr' + level + ' td').last();
                var text = cell && cell.text ? $.trim(cell.text()) : '';
                if (!text) { return null; }
                texts.push(text);
            }
            return texts.length ? texts : null;
        } catch (e) {
            return null;
        }
    }
    var prizeTexts = readTreeFromScreen() || (GV.PrizeAmounts || []).map(formatPrize);

    // Init.js writes the starting "total prize" with a hard-coded "$": rewrite it in the theme's currency
    try {
        if (!GV.IsTotalPrizeMoneyShowing) {
            var startLevel = GV.QuestionLevel || 1;
            $('.totalPrizeMoneyWonDiv').html(formatPrize(startLevel >= 2 ? GV.PrizeAmounts[startLevel - 2] : 0));
        }
    } catch (e) { /* strap not present in this theme */ }

    // The money tree as the game shows it right now: text and colour of every level, and which row is
    // highlighted (image bar, coloured row or the separate highlight table, depending on the theme)
    function isTransparent(color) {
        return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);
    }
    function readTree() {
        try {
            var count = (GV.PrizeAmounts || []).length;
            var rows = [], highlight = 0, highlightColor = null;
            for (var level = 1; level <= count; level++) {
                var tr = document.getElementById('moneyTreeTr' + level);
                if (!tr) { return null; }
                var cells = tr.getElementsByTagName('td');
                if (!cells.length) { return null; }
                var amount = cells[cells.length - 1];
                var style = window.getComputedStyle(amount);
                // Text painted with a gradient clipped to the letters (e.g. the gold milestones of Clocked): the
                // text colour is transparent and the gradient is not a highlight. Shown as gold in the panel.
                var clipped = /text/.test(style.webkitBackgroundClip || '') || /text/.test(style.backgroundClip || '');
                rows.push({ t: $.trim(amount.textContent || ''), c: clipped || isTransparent(style.color) ? '#f7c948' : style.color });

                if (highlight) { continue; }
                var marker = document.querySelector('#currentLevelTr' + level + ' .moneyTreeCurrentLevelTd');
                if (marker && parseFloat(window.getComputedStyle(marker).opacity) > 0.5) {
                    highlight = level;
                    // Clocked marks the current level with a dark brown lozenge
                    if (CLOCKED) { highlightColor = '#564425'; }
                } else if (clipped) {
                    continue;
                } else if (style.backgroundImage && style.backgroundImage !== 'none') {
                    highlight = level;
                } else if (!isTransparent(style.backgroundColor)) {
                    highlight = level;
                    highlightColor = style.backgroundColor;
                }
            }
            return { rows: rows, highlight: highlight, highlightColor: highlightColor };
        } catch (e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- host and player screens

    // Which question is on screen (setQuestion(true) = the Switch the Question replacement)
    NB.onScreenSwitch = false;
    var originalSetQuestion = window.setQuestion;
    if (typeof originalSetQuestion === 'function') {
        window.setQuestion = function (isSwitch) {
            NB.onScreenSwitch = !!isSwitch;
            return originalSetQuestion.apply(this, arguments);
        };
    }

    function visible(selector) {
        var el = document.querySelector(selector);
        if (!el) { return false; }
        var o = parseFloat(window.getComputedStyle(el).opacity);
        return !(o < 0.5) && window.getComputedStyle(el).display !== 'none';
    }

    /** The question exactly as the audience sees it: text, answers already revealed, locked and revealed-correct answer. */
    function readScreen() {
        try {
            var strap = visible('.questionStrapDiv') && !!GV.QuestionInProgress;
            var q = document.querySelector('.questionTd');
            var text = q ? $.trim(q.innerText || q.textContent || '') : '';
            var answers = [], shown = [];
            for (var i = 0; i < 4; i++) {
                var L = LETTERS[i];
                var a = document.querySelector('#answer' + L + ' .answerP');
                answers.push(a ? $.trim(a.textContent || '') : '');
                shown.push(strap && !GV['Answer' + L + 'IsOut'] && visible('#answer' + L + ' .answerP'));
            }
            var seq = GV.QuestionSequenceCounter;
            var revealed = strap && (seq === 7 || seq === 9 || (CLOCKED && seq === 11)) ? (GV.CurrentCorrectAnswer || '') : '';
            return { visible: strap, isSwitch: NB.onScreenSwitch, text: strap ? text : '', answers: answers, shown: shown,
                     locked: strap ? (GV.CurrentTargetAnswer || '') : '', revealedCorrect: revealed };
        } catch (e) {
            return null;
        }
    }

    /**
     * Host screen boxes for the question being played (L): Away = questions left including this one,
     * cash = amount already won (L-1), tick = amount for a right answer (L), cross = safe level kept on a wrong
     * answer (last milestone below L), drop = what a wrong answer loses (cash - cross).
     */
    var MILESTONES = [5, 10];
    function hostBoxes() {
        try {
            var amounts = GV.PrizeAmounts || [];
            var n = amounts.length || 15;
            var L = Math.max(1, Math.min(n, GV.QuestionLevel || 1));
            var amount = function (level) { return level >= 1 ? Number(amounts[level - 1]) || 0 : 0; };
            var text = function (level) { return level >= 1 ? wonText(level - 1) : formatPrize(0); };
            var safe = 0;
            MILESTONES.forEach(function (m) { if (m < L) { safe = m; } });
            return {
                away: n - L + 1,
                cash: text(L - 1),
                tick: text(L),
                cross: text(safe),
                drop: formatPrize(Math.max(0, amount(L - 1) - amount(safe))),
                winningsLabel: GV.TotalPrizeText || 'TOTAL PRIZE WON',
                winnings: $.trim($('.totalPrizeMoneyWonDiv').first().text() || '')
            };
        } catch (e) {
            return null;
        }
    }

    var lastState = '';
    var recoveryCache = null, recoveryAt = 0, sceneBaseline = {};
    function captureRecovery(force) {
        if (!force && recoveryCache && Date.now() - recoveryAt < 1000) { return recoveryCache; }
        var fields = {};
        Object.keys(GV).forEach(function (name) {
            var value = GV[name];
            if (!/Timeout|Interval|SoundPlaying|password|secret|token|url|__proto__|constructor|prototype/i.test(name) &&
                (typeof value === 'boolean' || typeof value === 'number' && isFinite(value) || typeof value === 'string' && value.length < 2000)) { fields[name] = value; }
        });
        var scene = [];
        function walk(node, path) {
            if (scene.length >= 2500 || path.length > 30 || ['SCRIPT', 'STYLE', 'LINK'].indexOf(node.tagName) >= 0) { return; }
            var style = window.getComputedStyle(node);
            var entry = { path: path, tag: node.tagName, opacity: style.opacity, display: style.display, transform: style.transform };
            var key = path.join('.'), signature = JSON.stringify([entry.opacity, entry.display, entry.transform]);
            if (sceneBaseline[key] === undefined) { sceneBaseline[key] = signature; }
            if (sceneBaseline[key] !== signature) { scene.push(entry); }
            Array.prototype.forEach.call(node.children, function (child, index) { walk(child, path.concat(index)); });
        }
        walk(document.body, []);
        recoveryCache = { version: 1, fields: fields, scene: scene, text: ['.timerSecondsDiv', '.timerSecondsGoldDiv', '.timerSecondsBankedDiv', '.totalPrizeMoneyWonDiv'].map(function (selector) { return { selector: selector, value: $(selector).first().text() }; }) };
        recoveryAt = Date.now(); return recoveryCache;
    }
    function snapshot() {
        return {
            type: 'state',
            recovery: captureRecovery(false),
            level: GV.QuestionLevel,
            inProgress: !!GV.QuestionInProgress,
            correct: GV.CurrentCorrectAnswer || '',
            target: GV.CurrentTargetAnswer || '',
            questionStep: GV.QuestionSequenceCounter,
            ataStep: GV.ataLifeLineSequenceCounter,
            pafStep: GV.pafLifeLineSequenceCounter,
            stqStep: GV.stqLifeLineSequenceCounter,
            ddStep: GV.ddLifeLineSequenceCounter,
            ddActive: !!GV.IsDDLifeLineActive,
            out: [!!GV.AnswerAIsOut, !!GV.AnswerBIsOut, !!GV.AnswerCIsOut, !!GV.AnswerDIsOut],
            used: LIFELINES.map(function (id) { return !!NB.used[id]; }),
            treeShowing: !!GV.IsMoneyTreeShowing,
            commercial: !!GV.IsInCommercial,
            ataOverride: !!NB.ataOverride,
            fiftyPick: NB.fiftyPick,
            ffReplacedByDd: !!GV.ReplaceFFwithDD,
            stqReplacedByAte: !!GV.ReplaceSTQwithATE,
            ateStep: GV.ateLifeLineSequenceCounter || 0,
            clocked: CLOCKED,
            // Fastest Finger First: on or off, and the step of its sequence (key left arrow)
            fff: { active: !!GV.IsPlayingFasestFinger, step: GV.FastestFingerSequenceCounter || 0 },
            clock: CLOCKED ? readClock() : null,
            pafSelect: CLOCKED && !!GV.CanSelectPafContact,
            pafContacts: CLOCKED ? pafContactsList() : null,
            // True only during the walk-away sequence (W), not after a wrong answer or a time-up
            walkAway: !!GV.IsWalkingAway && (GV.walkAwaySequenceCounter || 0) > 0,
            nativeKlaxon: nativeKlaxon,
            supported: supported,
            tree: readTree(),
            screen: readScreen(),
            ataPercents: [GV.AnswerAPercent, GV.AnswerBPercent, GV.AnswerCPercent, GV.AnswerDPercent].map(function (v) { return Number(v) || 0; }),
            walkingAway: !!GV.IsWalkingAway,
            // Seconds left on the Phone a Friend clock, as the game shows them (only while the clock runs)
            // (Clocked: the call clock runs at step 5, after the contact is chosen; classic themes: step 3)
            pafClock: GV.pafLifeLineSequenceCounter === (CLOCKED ? 5 : 3) ? $.trim($('.pafClockTimeDiv').first().text() || '') : '',
            boxes: hostBoxes(),
            prizes: prizeTexts
        };
    }
    function pushState(force) {
        var s = snapshot();
        var json = JSON.stringify(s);
        if (force || json !== lastState) {
            lastState = json;
            wv.postMessage(s);
        }
    }

    // Lets the host ask for a full state push (the web platform does it after a reconnection)
    NB.pushState = pushState;

    wv.addEventListener('message', function (e) {
        var m = e.data;
        if (!m || !handlers[m.cmd]) { return; }
        var error = null;
        try {
            handlers[m.cmd](m);
        } catch (err) {
            error = String(err && err.message || err);
            wv.postMessage({ type: 'error', message: String(err && err.message || err) });
        }
        if (m.id) { wv.postMessage({ type: 'commandAck', id: m.id, error: error }); }
        captureRecovery(true);
        pushState(true);
    });

    setInterval(pushState, 200);
    pushState(true);
})();
