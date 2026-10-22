// Explicitly preloaded by the integration test process, never imported by the application.
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith('https://discord.com/api/')) return original(url, options);
    const body = new URLSearchParams(options.body);
    if (String(url).endsWith('/oauth2/token')) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.get('code_verifier') || '')) return new Response('{}', { status: 400 });
        return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer' });
    }
    if (String(url).endsWith('/oauth2/token/revoke')) return new Response('', { status: 200 });
    if (String(url).endsWith('/users/@me')) return Response.json({ id: '123456789012345678', username: 'must-not-be-stored', email: 'never-store@example.invalid', avatar: 'discard' });
    return new Response('{}', { status: 404 });
};
