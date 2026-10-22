import fs from 'node:fs';
import { createBackup, restoreBackup } from '../lib/backup.js';

const [operation, source, destination, keyFile] = process.argv.slice(2);
if (!['create', 'restore'].includes(operation) || !source || !destination || !keyFile) {
    console.error('Usage: node scripts/backup.mjs create|restore SOURCE DESTINATION PASSPHRASE_FILE'); process.exit(1);
}
try {
    const password = fs.readFileSync(keyFile, 'utf8').trim();
    await (operation === 'create' ? createBackup : restoreBackup)(source, destination, password);
    console.log(operation === 'create' ? 'Encrypted game backup created.' : 'Verified game backup restored into an empty directory.');
} catch (error) { console.error('Backup operation failed: ' + error.message); process.exitCode = 1; }
