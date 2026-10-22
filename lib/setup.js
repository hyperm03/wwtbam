import { config, installation } from './config.js';
import { requireAuth, requireAdmin } from './auth.js';

export const setupRequired = session => session?.role === 'admin' && installation.needsSetup();

export function attachSetup(app, sendPage) {
    app.get('/setup', requireAuth, requireAdmin, (req, res) => sendPage(res, 'setup.html'));
    app.get('/api/admin/installation', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(installation.public()));
    app.put('/api/admin/installation', requireAdmin, (req, res) => {
        const hasSecret = ['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'].some(name => req.body?.values?.[name]);
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
        if (hasSecret && !req.secure && !local) return res.status(400).json({ error: 'Usa HTTPS per salvare i segreti, oppure configura dal computer locale del server.' });
        const beforeOrigin = config.publicUrl, beforeOutput = config.outputPublicUrl;
        try {
            const result = installation.update(req.body);
            const originChanged = beforeOrigin !== config.publicUrl || beforeOutput !== config.outputPublicUrl;
            res.set('Cache-Control', 'no-store').json({ ...result, originChanged,
                nextUrl: originChanged ? (config.publicUrl || '') + '/setup' : '/home' });
        } catch (error) {
            // Validation errors contain field labels, never the submitted secret values.
            res.status(400).json({ error: error.message });
        }
    });
}
