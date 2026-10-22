import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

test('browser: preparation, offline protection, privacy UI and real bridge checkpoint round trip', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwtbam-browser-'));
    const theme = path.join(temp, 'themes', 'fixture'); fs.mkdirSync(theme, { recursive: true });
    fs.copyFileSync('node_modules/jquery/dist/jquery.min.js', path.join(theme, 'jquery.js'));
    fs.writeFileSync(path.join(theme, 'default.html'), `<!doctype html><html><head><title>Adapter test fixture, not a game theme</title><script src="jquery.js"></script></head><body><div class="questionStrapDiv" style="opacity:0"><div class="questionTd"></div>${'ABCD'.split('').map(l => `<div id="answer${l}"><span class="letterP">${l}</span><span class="answerP"></span></div>`).join('')}</div><script>
    window.QuestionAndAnswer=function(){};
    window.GameVariables={PrizeAmounts:Array.from({length:15},(_,i)=>(i+1)*100),QuestionsAndAnswers:[],SwitchQuestionsAndAnswers:[],QuestionLevel:1,QuestionSequenceCounter:0,QuestionInProgress:false,CurrentTargetAnswer:'',CurrentCorrectAnswer:'',IsInCommercial:false,IsFFLifeLineUsed:false};
    window.setQuestion=function(sw){var g=GameVariables,q=(sw?g.SwitchQuestionsAndAnswers:g.QuestionsAndAnswers)[g.QuestionLevel-1];$('.questionTd').html(q.Question);'ABCD'.split('').forEach(function(l){$('#answer'+l+' .answerP').text(q['Answer'+l]);});$('.questionStrapDiv').css('opacity',1);g.QuestionInProgress=true;g.CurrentCorrectAnswer=q.CorrectAnswer;};
    window.ffLifeLineDisable=function(){GameVariables.IsFFLifeLineUsed=true;};
    $(document).on('keydown',function(e){if(e.keyCode===39){window.setQuestion(false);GameVariables.QuestionSequenceCounter=6;}if(e.keyCode===49){GameVariables.CurrentTargetAnswer='a';} });
    </script></body></html>`);
    const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATA_DIR: temp, HOST: '127.0.0.1', PORT: '0', ADMIN_PASSWORD: 'browser-test-password', PUBLIC_URL: '', OUTPUT_PUBLIC_URL: '', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_ANNOUNCEMENTS_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        let log = '';
        const base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Startup timeout')), 10000);
            child.stdout.on('data', chunk => { log += chunk; const m = log.match(/127.0.0.1:(\d+)/); if (m) { clearTimeout(timer); resolve('http://127.0.0.1:' + m[1]); } });
            child.stderr.on('data', chunk => { log += chunk; }); child.once('exit', () => { clearTimeout(timer); reject(new Error(log)); });
        });
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
        const login = await context.request.post(base + '/login', { form: { username: 'admin', password: 'browser-test-password' } }); assert.equal(login.status(), 200);
        const create = await context.request.post(base + '/api/rooms', { data: { name: 'Browser show' } }); const { id } = await create.json();
        assert.equal((await context.request.put(`${base}/api/rooms/${id}`, { data: { theme: 'fixture' } })).status(), 200);
        const page = await context.newPage(); await page.goto(base + '/control');
        assert.equal(new URL(page.url()).pathname, '/setup');
        await page.getByRole('heading', { name: 'Configura Millionaire' }).waitFor();
        await page.locator('[data-setting="PUBLIC_URL"]').waitFor();
        await page.getByRole('button', { name: 'Configura in seguito — solo prove', exact: true }).click();
        await page.waitForURL(base + '/home');
        await page.goto(base + '/control');
        await page.waitForFunction(() => window.MC?.room()?.id);
        await page.evaluate(() => {
            const main = Array.from({ length: 15 }, (_, i) => ({ text: 'Question ' + (i + 1), answers: ['Alpha', 'Bravo', 'Charlie', 'Delta'], correct: 0 }));
            window.MC.applyQuestions(main, main.map((q, i) => ({ ...q, text: 'Replacement ' + (i + 1) })));
        });
        await page.waitForFunction(() => document.querySelector('#statusMsg').textContent === 'Saved.');
        const output = await context.newPage();
        const url = await page.evaluate(() => MC.room().outputUrl);
        await output.goto(base + url + '&nooverlay=1');
        await output.waitForFunction(() => !!window.NetBridge);
        await page.waitForFunction(() => !!MC.state());
        await page.locator('[data-key="39"]').click();
        try { await page.waitForFunction(() => MC.state()?.inProgress === true, undefined, { timeout: 5000 }); }
        catch (error) {
            console.error({ browserErrors: errors, control: await page.evaluate(() => ({ status: document.querySelector('#statusMsg').textContent, state: MC.state(), recoveryPending: MC.room().recoveryPending })), game: await output.evaluate(() => ({ inProgress: GameVariables.QuestionInProgress, sequence: GameVariables.QuestionSequenceCounter, questions: GameVariables.QuestionsAndAnswers.length })) });
            throw error;
        }
        await output.waitForFunction(() => document.querySelector('.questionTd').textContent === 'Question 1');
        const result = await page.evaluate(async () => new Promise((resolve, reject) => MC.socket.timeout(5000).emit('cmd', { cmd: 'key', code: 49, id: crypto.randomUUID(), sentAt: Date.now() }, (e, r) => e ? reject(e) : resolve(r))));
        assert.equal(result.ok, true);
        await page.waitForFunction(() => MC.state()?.target === 'a');
        await output.reload(); await output.waitForFunction(() => !!window.NetBridge);
        await output.evaluate(() => { const send = chrome.webview.postMessage; window.__bridgeErrors = []; chrome.webview.postMessage = m => { if (m.type === 'error') window.__bridgeErrors.push(m.message); send(m); }; });
        await page.waitForFunction(() => MC.room()?.recoveryPending && MC.room()?.activeOutputReady);
        const restore = await context.request.post(`${base}/api/rooms/${id}/checkpoint/restore`); assert.equal(restore.status(), 200, JSON.stringify({ response: await restore.text(), errors: await output.evaluate(() => window.__bridgeErrors) }));
        await output.waitForFunction(() => GameVariables.CurrentTargetAnswer === 'a' && GameVariables.QuestionSequenceCounter === 6 && document.querySelector('.questionTd').textContent === 'Question 1');
        assert.equal(await output.locator('.questionStrapDiv').evaluate(el => getComputedStyle(el).opacity), '1');
        await page.locator('#liveTools').click(); await page.getByText('Question review', { exact: true }).waitFor();
        assert.equal(await page.locator('.modal tbody tr').count(), 30);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('[data-page="admin"]').click();
        await page.locator('[data-admin="installation"]').click();
        await page.locator('[data-setting="AUDIENCE_VOTE_SECONDS"]').fill('45');
        await page.locator('[data-setting="DISCORD_CLIENT_SECRET"]').fill('browser-only-setup-secret');
        await page.getByRole('button', { name: 'Salva impostazioni', exact: true }).click();
        await page.getByText('Impostazioni salvate e applicate. I segreti sono conservati cifrati sul server.').waitFor();
        assert.equal(await page.locator('[data-setting="DISCORD_CLIENT_SECRET"]').inputValue(), '');
        await page.reload();
        await page.waitForFunction(() => window.MC?.room()?.id);
        await page.locator('[data-page="admin"]').click();
        await page.locator('[data-admin="installation"]').click();
        await page.locator('[data-setting="AUDIENCE_VOTE_SECONDS"]').waitFor();
        assert.equal(await page.locator('[data-setting="AUDIENCE_VOTE_SECONDS"]').inputValue(), '45');
        assert.equal(await page.locator('[data-setting="DISCORD_CLIENT_SECRET"]').inputValue(), '');
        const offline = await page.evaluate(() => { MC.socket.disconnect(); MC.key(39); return MC.socket.sendBuffer.length; }); assert.equal(offline, 0);
        const mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 });
        await mobile.goto(base + '/account'); await mobile.getByText('Il login Discord deve essere configurato dal gestore.').waitFor();
        assert.equal(await mobile.locator('#discordForm').isVisible(), false);
        await mobile.goto(base + '/privacy'); await mobile.locator('#version').filter({ hasText: 'Versione:' }).waitFor();
        assert.ok(await mobile.getByRole('heading', { name: 'I tuoi diritti' }).isVisible());
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
