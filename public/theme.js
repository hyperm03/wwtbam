/* Light / dark mode of the control pages: "system" (default) follows the operating system. Loaded in <head>, before the page is drawn. */
(function () {
    var KEY = 'mc_theme';
    var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function choice() {
        try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
    }

    function apply() {
        var c = choice();
        var dark = c === 'dark' || (c === 'system' && media && media.matches);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    }

    apply();
    if (media) {
        var onChange = function () { if (choice() === 'system') { apply(); } };
        if (media.addEventListener) { media.addEventListener('change', onChange); } else if (media.addListener) { media.addListener(onChange); }
    }

    window.MCTheme = {
        get: choice,
        set: function (value) {
            try { localStorage.setItem(KEY, value); } catch (e) { /* private mode: only this page */ }
            apply();
        }
    };
})();
