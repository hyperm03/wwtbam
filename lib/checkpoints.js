import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './durable.js';
import { setDigest } from './editorial.js';

const dir = path.join(config.dataDir, 'checkpoints');
const file = id => path.join(dir, id.replace(/[^a-z0-9-]/g, '') + '.json');
const lastSaved = new Map();
export function checkpoint(room, state, force = false) {
    if (!force && Date.now() - (lastSaved.get(room.id) || 0) < 1000) return;
    writeJson(file(room.id), { version: 1, theme: room.theme, questionsVersion: setDigest(room), mode: room.mode, game: room.game, savedAt: new Date().toISOString(), state });
    lastSaved.set(room.id, Date.now());
}
export const loadCheckpoint = id => readJson(file(id), null);
export function deleteCheckpoint(id) { fs.rmSync(file(id), { force: true }); lastSaved.delete(id); }
