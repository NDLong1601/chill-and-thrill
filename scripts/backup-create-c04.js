'use strict';

const path = require('node:path');
const { createBackup } = require('../src/platform/backupRestore');

function usage() {
  return `C04 stopped-server backup\n\n` +
    `node scripts/backup-create-c04.js --server-stopped --output <new-directory> [options]\n\n` +
    `Options:\n` +
    `  --data-dir <path>       Source data directory (default: <project>\\data)\n` +
    `  --database <path>       ProfileStore SQLite path\n` +
    `  --rooms <path>          Gang / UNO 112 manager file\n` +
    `  --uno108 <path>         UNO 108 manager file\n` +
    `  --tien-len <path>       Tiến lên JSON export\n` +
    `  --poker <path>          Poker JSON export\n` +
    `  --sam-loc <path>        Sâm lốc JSON export\n` +
    `  --phom <path>           Phỏm JSON export\n` +
    `  --bang <path>           BANG! manager file\n`;
}

function parseArgs(argv) {
  const options = {};
  const values = {
    '--output': 'outputDirectory', '--data-dir': 'dataDirectory', '--database': 'databaseFile', '--rooms': 'storageFile',
    '--uno108': 'uno108File', '--tien-len': 'tienLenFile', '--poker': 'pokerFile', '--sam-loc': 'samLocFile', '--phom': 'phomFile', '--bang': 'bangFile',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--server-stopped') { options.serverStopped = true; continue; }
    if (!values[arg]) throw new Error(`Tùy chọn không hợp lệ: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Thiếu giá trị cho ${arg}`);
    options[values[arg]] = value;
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); process.exit(0); }
  if (!options.outputDirectory) throw new Error('Cần --output và một thư mục chưa tồn tại.');
  if (!options.serverStopped) throw new Error('Cần --server-stopped sau khi đã dừng máy chủ sạch.');
  if (options.dataDirectory) options.dataDirectory = path.resolve(options.dataDirectory);
  if (options.databaseFile) options.databaseFile = path.resolve(options.databaseFile);
  if (options.storageFile) options.storageFile = path.resolve(options.storageFile);
  const fileFlags = { uno108: 'uno108File', tienLen: 'tienLenFile', poker: 'pokerFile', samLoc: 'samLocFile', phom: 'phomFile', bang: 'bangFile' };
  for (const [key, optionName] of Object.entries(fileFlags)) if (options[optionName]) (options.managerFiles ||= {})[key] = path.resolve(options[optionName]);
  options.outputDirectory = path.resolve(options.outputDirectory);
  const result = createBackup(options);
  console.log(`Backup C04 đã xác minh: ${result.directory}`);
  console.log(`ProfileStore schema: ${result.validation.database.schemaVersion}; hồ sơ: ${result.validation.database.profiles}; HELD: ${result.validation.database.heldReservations}`);
  if (result.validation.degradedExports.length) console.warn(`Export JSON lỗi nhưng SQLite snapshot tiếp tục là authority: ${result.validation.degradedExports.map(item => item.id).join(', ')}`);
  console.log('Chế độ: server-stopped assertion. Live quiesce/freeze gate chưa được tích hợp.');
} catch (error) {
  console.error(`Backup thất bại${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
}
