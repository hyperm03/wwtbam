import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstallation } from '../lib/installation.js';

function fixture(environment = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwtbam-installation-'));
    const options = { dataDir, sessionSecret: 'test-key-not-a-production-credential', environment };
    return { options, store: createInstallation(options), cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}
const live = {
    PUBLIC_URL: 'https://quiz.example', OUTPUT_PUBLIC_URL: 'https://output.quiz.example',
    DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'local-test-secret',
    PRIVACY_CONTROLLER_NAME: 'Test controller', PRIVACY_CONTACT_EMAIL: 'privacy@example.invalid',
    PRIVACY_HOSTING_REGION: 'Local test only', PRIVACY_REVIEWED: '1'
};
test('first install prompts for missing settings and explicit rehearsal postpones Discord', () => {
    const { store, cleanup } = fixture();
    try {
        assert.equal(store.needsSetup(), true);
        assert.ok(store.public().missing.includes('Client ID Discord'));
        assert.throws(() => store.update({ complete: true }), /Completa/);
        assert.equal(store.needsSetup(), true);
        store.update({ values: { DISCORD_LOGIN_ENABLED: false }, complete: true });
        assert.equal(store.needsSetup(), false);
        assert.equal(store.get('DISCORD_LOGIN_ENABLED'), '0');
    } finally { cleanup(); }
});
test('settings survive restart; secrets are encrypted and never returned by the settings API model', () => {
    const { options, store, cleanup } = fixture();
    try {
        store.update({ values: live, complete: true });
        const publicText = JSON.stringify(store.public());
        assert.ok(!publicText.includes(live.DISCORD_CLIENT_SECRET));
        assert.ok(!fs.readFileSync(path.join(options.dataDir, 'installation.json'), 'utf8').includes(live.DISCORD_CLIENT_SECRET));
        const restored = createInstallation(options);
        assert.equal(restored.get('DISCORD_CLIENT_SECRET'), live.DISCORD_CLIENT_SECRET);
        assert.equal(restored.needsSetup(), false);
        restored.update({ values: { DISCORD_CLIENT_SECRET: '' } });
        assert.equal(restored.get('DISCORD_CLIENT_SECRET'), live.DISCORD_CLIENT_SECRET);
        restored.update({ clearSecrets: ['DISCORD_CLIENT_SECRET'] });
        assert.equal(restored.get('DISCORD_CLIENT_SECRET'), '');
        assert.throws(() => createInstallation({ ...options, sessionSecret: 'wrong-key' }));
    } finally { cleanup(); }
});
test('environment prefill, application overrides and explicit reset preserve the source of each value', () => {
    const { store, cleanup } = fixture(live);
    try {
        assert.equal(store.public().fields.find(f => f.name === 'DISCORD_CLIENT_SECRET').source, 'environment');
        assert.equal(store.public().fields.find(f => f.name === 'DISCORD_CLIENT_SECRET').value, '');
        store.update({ values: { DISCORD_CLIENT_ID: '123456789012345679' } });
        assert.equal(store.get('DISCORD_CLIENT_ID'), '123456789012345679');
        store.update({ resetToEnvironment: ['DISCORD_CLIENT_ID'] });
        assert.equal(store.get('DISCORD_CLIENT_ID'), live.DISCORD_CLIENT_ID);
    } finally { cleanup(); }
});
test('invalid settings cannot replace valid settings or change deployment keys', () => {
    const { store, cleanup } = fixture(live);
    try {
        assert.throws(() => store.update({ values: { PORT: 80 } }), /Unsupported/);
        assert.throws(() => store.update({ values: { PUBLIC_URL: 'https://quiz.example/a-path' } }), /origine/);
        assert.throws(() => store.update({ values: { OUTPUT_PUBLIC_URL: 'https://quiz.example' } }), /hostname/);
        assert.throws(() => store.update({ values: { DISCORD_ADMIN_ROLE_IDS: 'not-an-id' } }), /role/);
        assert.throws(() => store.update({ values: { PARTICIPANT_MIN_AGE: 12 } }), /18/);
        assert.equal(store.get('OUTPUT_PUBLIC_URL'), live.OUTPUT_PUBLIC_URL);
        assert.equal(store.needsSetup(), true);
    } finally { cleanup(); }
});
