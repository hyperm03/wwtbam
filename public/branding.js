/* Applies the community's branding (multi-tenant platform): logo and name. Pages mark the places with
   data-brand-logo="<size>" and data-brand-name. window.BRAND holds the branding for the other scripts. */
(() => {
    const apply = b => {
        window.BRAND = b;
        document.querySelectorAll('img[data-brand-logo]').forEach(img => { img.src = `${b.logo}-${img.dataset.brandLogo || 128}.png`; img.alt = b.name; });
        document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = b.name; });
        document.dispatchEvent(new CustomEvent('branding', { detail: b }));
    };
    fetch('/api/branding', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(b => { if (b) apply(b); }).catch(() => { });
})();
