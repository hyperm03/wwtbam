// Confidential-client authorization-code flow. No implicit grant, email scope, persistent OAuth tokens or refresh grants.
export function createDiscordClient({ clientId, clientSecret, guildId = '', roleIds = [], fetcher = fetch }) {
    const api = 'https://discord.com/api/v10';
    const request = async (url, options) => {
        const res = await fetcher(url, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!res.ok) throw new Error('Discord authorization is unavailable');
        return res.json();
    };
    return {
        scopes: guildId ? ['identify', 'guilds.members.read'] : ['identify'],
        async identity(code, redirectUri, verifier) {
            let token, refreshToken;
            try {
                const result = await request(api + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }) });
                token = result.access_token; refreshToken = result.refresh_token;
                if (!token || result.token_type?.toLowerCase() !== 'bearer') throw new Error('Invalid Discord response');
                const auth = { headers: { Authorization: 'Bearer ' + token } };
                const user = await request(api + '/users/@me', auth);
                if (!/^\d{17,20}$/.test(user.id)) throw new Error('Invalid Discord identity');
                let roles = [];
                if (guildId) {
                    const member = await request(api + '/users/@me/guilds/' + guildId + '/member', auth);
                    roles = Array.isArray(member.roles) ? member.roles : [];
                    if (roleIds.length && !roleIds.some(id => roles.includes(id))) throw new Error('Your Discord roles do not allow participation');
                }
                // Discard username, avatar, locale, email and all other provider fields.
                return { id: user.id, roles };
            } finally {
                // Revoke both grants even when membership checks fail. A network failure does not justify storing tokens.
                for (const [value, hint] of [[token, 'access_token'], [refreshToken, 'refresh_token']]) if (value) {
                    try {
                        await fetcher(api + '/oauth2/token/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: value, token_type_hint: hint }) });
                    } catch { /* token expires at Discord; no local token is retained */ }
                }
            }
        }
    };
}
