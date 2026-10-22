/*
 * Output page adapter: the theme page gets the same bridge as the desktop app (bridge.js = NetBridge.js).
 * Here the WebView2 channel (window.chrome.webview) is emulated over Socket.IO, so the bridge runs unchanged.
 * It also scales the fixed 1920x1080 scene to the window and, outside OBS, asks for one click to enable sound.
 */
// Output is display only: real keyboard/mouse/touch input never reaches the game (the control panel drives it).
// Installed here, before the theme finishes loading; the bridge installs the same lock (it skips a second copy).
(function () {
    if (window.__mcInputLocked) { return; }
    window.__mcInputLocked = true;
    var lock = function (e) {
        if (!e.isTrusted) { return; }
        if (e.target && e.target.closest && e.target.closest('[data-mc-allow]')) { return; }
        e.stopImmediatePropagation();
        if (e.cancelable) { e.preventDefault(); }
    };
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick',
     'wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup'].forEach(function (type) {
        window.addEventListener(type, lock, { capture: true, passive: false });
    });
})();

(function () {
    var cfg = window.__MC || {};
    var listeners = [];

    // ------------------------------------------------------------------ transparent background (default)
    // The game output is transparent by default: no black page behind the theme's graphics (every graphic of the
    // theme stays, backgrounds included), so it can be keyed or layered in OBS, vMix and the like.
    // ?bg=black gives the classic black background instead (e.g. to preview it in a normal browser, where a
    // transparent page looks white).
    var bg = (location.search.match(/[?&]bg=(transparent|black)/) || [])[1];
    var transparent = bg !== 'black';
    cfg.transparent = transparent;
    window.__MC = cfg;
    document.documentElement.setAttribute('data-mc-transparent', transparent ? 'yes' : 'no');
    if (transparent) {
        var style = document.createElement('style');
        // Only the black page and the black colour behind the logo: every picture of the theme (backgrounds of the
        // Fastest Finger, the logo screen, the lifelines panel...) is part of its graphics and stays.
        style.textContent = 'html, body, .logoContainerDiv { background-color: transparent !important; } html, body { background: transparent !important; }';
        (document.head || document.documentElement).appendChild(style);
    }
    // ------------------------------------------------------------------ ?sound=off: a silent output
    // For shows whose music and sounds come from elsewhere (e.g. the Roblox set): every sound of the theme is muted.
    var soundOff = /[?&]sound=off/.test(location.search);
    if (soundOff) {
        var realPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            try { this.volume = 0; } catch (e) { /* ignore */ }
            return realPlay.apply(this, arguments);
        };
    }

    // ------------------------------------------------------------------ ?start=tree: start clean, ready for the money tree
    // The themes start in the commercial break with the logo on screen (key C takes it away with the "hello" music).
    // Here the output starts with nothing on screen and out of the commercial, silently: the first press of the
    // left arrow starts the rules and the opening money tree.
    if (/[?&]start=tree/.test(location.search)) {
        window.addEventListener('load', function () {
            var tries = 0;
            var timer = setInterval(function () {
                var G = window.GameVariables, $ = window.jQuery;
                if (G && $ && document.querySelector('.logoContainerDiv')) {
                    clearInterval(timer);
                    if (G.IsInCommercial) {
                        G.IsInCommercial = false;
                        G.IsLogoShowing = false;
                        $('.logoContainerDiv').stop(true, true).css('opacity', 0);
                    }
                } else if (++tries > 100) {
                    clearInterval(timer);
                }
            }, 100);
        });
    }

    /** Keeps the output options (bg, nooverlay) when the server sends the page to a new address (reload, theme change). */
    function keepOptions(url) {
        var keep = (location.search.match(/[?&](bg|nooverlay|start|sound)=[^&]*/g) || []).map(function (p) { return p.slice(1); });
        return keep.length ? url + (url.indexOf('?') < 0 ? '?' : '&') + keep.join('&') : url;
    }
    var socket = io({ query: { role: 'output', room: cfg.room, token: cfg.token } });
    socket.on('authority', function (m) {
        var old = document.getElementById('mc-standby'); if (old) { old.remove(); }
        if (!m.active) { var notice = banner('Standby output\nThe control room must explicitly activate this window.', true); notice.id = 'mc-standby'; }
        else if (window.NetBridge && window.NetBridge.pushState) { window.NetBridge.pushState(true); }
    });

    window.chrome = window.chrome || {};
    window.chrome.webview = {
        postMessage: function (m) { if (socket.connected) { socket.emit('bridge', m); } },
        addEventListener: function (type, fn) { if (type === 'message') { listeners.push(fn); } }
    };

    socket.on('cmd', function (m) {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i]({ data: m }); } catch (e) { /* the bridge reports its own errors */ }
        }
    });
    socket.on('reload', function (url) { location.replace(keepOptions(url)); });
    socket.on('fatal', function (msg) { banner(msg, true); });
    socket.on('disconnect', function () { socket.sendBuffer = []; });
    socket.on('connect', function () {
        // After a reconnection the server treats this page as new: push the full state so it re-sends everything
        if (window.NetBridge && window.NetBridge.pushState) { window.NetBridge.pushState(true); }
    });

    // ------------------------------------------------------------------ scale the 1920x1080 scene to the window

    function fit() {
        var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
        var b = document.body;
        if (!b) { return; }
        document.documentElement.style.overflow = 'hidden';
        document.documentElement.style.background = transparent ? 'transparent' : 'black';
        b.style.position = 'absolute';
        b.style.margin = '0';
        b.style.transformOrigin = '0 0';
        b.style.transform = 'scale(' + s + ')';
        b.style.left = Math.max(0, (window.innerWidth - 1920 * s) / 2) + 'px';
        b.style.top = Math.max(0, (window.innerHeight - 1080 * s) / 2) + 'px';
    }
    window.addEventListener('resize', fit);

    // ------------------------------------------------------------------ bridge, after the theme's own init()

    window.addEventListener('load', function () {
        setTimeout(function () {
            var s = document.createElement('script');
            s.src = '/static/bridge.js?v=' + Date.now();
            s.onload = function () { setTimeout(fit, 0); };
            document.body.appendChild(s);
            fit();
        }, 50);
    });

    // ------------------------------------------------------------------ sound unlock (not needed in OBS)

    function banner(text, fatal) {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
            'background:rgba(0,0,20,.72);color:#fff;font:600 28px/1.4 Segoe UI,Arial,sans-serif;text-align:center;cursor:pointer;padding:40px;white-space:pre-line';
        d.textContent = text;
        d.setAttribute('data-mc-allow', '');   // the only clickable thing on the output page
        if (!fatal) { d.addEventListener('click', function () { d.remove(); }); }
        // On <html>, not <body>: the body is scaled with a transform, which would move a fixed element
        document.documentElement.appendChild(d);
        return d;
    }

    if (!soundOff && !/OBS/i.test(navigator.userAgent) && !/[?&]nooverlay=1/.test(location.search)) {
        window.addEventListener('load', function () {
            banner('Click anywhere to start the output\n(browsers only play sound after a click - not needed in OBS)', false);
        });
    }
})();
