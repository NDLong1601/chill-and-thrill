'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const repairSafe = args.includes('--refund-safe');
const dbArg = args.find(arg => !arg.startsWith('--'));
const databaseFile = path.resolve(dbArg || process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE || path.join(root, 'data', 'chill-and-thrill.sqlite'));
const folder = path.dirname(databaseFile), base = path.basename(databaseFile).replace(/\.sqlite(?:3)?$/i, '');
const legacyFiles = {
  'tien-len': path.join(folder, `${base}.tien-len.json`),
  'sam-loc': path.join(folder, `${base}.sam-loc.json`),
  phom: path.join(folder, `${base}.phom.json`),
};
for (const arg of args) {
  const match = /^--(tien-len|sam-loc|phom)-json=(.+)$/.exec(arg);
  if (match) legacyFiles[match[1]] = path.resolve(match[2]);
}

function readLegacyRooms() {
  const rooms = [];
  for (const [gameId, file] of Object.entries(legacyFiles)) {
    if (!fs.existsSync(file)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.rooms)) throw new Error('invalid room export');
      rooms.push(...saved.rooms.map(room => ({ ...room, gameId })));
    } catch (error) {
      console.error(`Cannot read legacy ${gameId} rooms ${file}: ${error.message}`);
    }
  }
  return rooms;
}

let store;
try {
  store = new ProfileStore({ databaseFile, readOnly: !repairSafe });
  const report = store.auditFixedGameHolds({ legacyRooms: readLegacyRooms(), repairSafe });
  const summary = report.map(({ holds, ...item }) => item);
  process.stdout.write(`${JSON.stringify({ databaseFile, mode: repairSafe ? 'refund-safe' : 'read-only', heldGroups: report.length, discrepancies: summary }, null, 2)}\n`);
  if (report.some(item => item.needsAttention)) process.exitCode = 2;
} catch (error) {
  console.error(`A01 audit failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  store?.close();
}
