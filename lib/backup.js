import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const MAGIC = Buffer.from('WWTBAM01');
const excluded = ['participants.json', 'sessions.json', 'backups', 'tmp', 'system.log', 'showlogs', 'discord-notifications.json'];
const keyFor = (password, salt) => scrypt(password, salt, 32);
function requirePassword(password) { if (typeof password !== 'string' || password.length < 16) throw new Error('Use a backup passphrase with at least 16 characters'); }

export async function createBackup(source, destination, password) {
    requirePassword(password);
    if (fs.existsSync(destination) || fs.existsSync(destination + '.tmp')) throw new Error('Backup destination already exists');
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), header = Buffer.concat([MAGIC, salt, iv]);
    const cipher = crypto.createCipheriv('aes-256-gcm', await keyFor(password, salt), iv); cipher.setAAD(header);
    const tmp = destination + '.tmp';
    fs.writeFileSync(tmp, header, { mode: 0o600, flag: 'wx' });
    const child = spawn('tar', ['-C', source, ...excluded.map(name => '--exclude=' + name), '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Archive failed; stop the application and retry'))); });
    // Drain diagnostics without printing paths or accidental secret-bearing filenames.
    child.stderr.resume();
    try {
        await Promise.all([pipeline(child.stdout, cipher, fs.createWriteStream(tmp, { flags: 'a', mode: 0o600 })), exited]);
        fs.appendFileSync(tmp, cipher.getAuthTag()); fs.renameSync(tmp, destination);
    } catch (error) { child.kill(); fs.rmSync(tmp, { force: true }); throw error; }
}

export async function restoreBackup(archive, destination, password) {
    requirePassword(password);
    if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)) throw new Error('Restore only into a new, empty directory');
    const stat = fs.statSync(archive);
    if (stat.size < 52) throw new Error('Invalid backup');
    const fd = fs.openSync(archive, 'r'), header = Buffer.alloc(36), tag = Buffer.alloc(16);
    try { fs.readSync(fd, header, 0, 36, 0); fs.readSync(fd, tag, 0, 16, stat.size - 16); } finally { fs.closeSync(fd); }
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Unsupported backup');
    const decipher = crypto.createDecipheriv('aes-256-gcm', await keyFor(password, header.subarray(8, 24)), header.subarray(24));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wwtbam-restore-')); fs.chmodSync(temporary, 0o700);
    const tar = path.join(temporary, 'verified.tar');
    try {
        // Verify authentication before invoking any archive parser or extracting files.
        await pipeline(fs.createReadStream(archive, { start: 36, end: stat.size - 17 }), decipher, fs.createWriteStream(tar, { mode: 0o600 }));
        const entries = execFileSync('tar', ['--quoting-style=escape', '-tf', tar], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
        const details = execFileSync('tar', ['--quoting-style=escape', '-tvf', tar], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
        if (entries.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) || details.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Unsafe archive entry');
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '--keep-old-files', '-C', destination, '-xf', tar], { stdio: 'pipe' });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
