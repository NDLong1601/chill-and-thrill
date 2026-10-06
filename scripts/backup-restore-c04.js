'use strict';

const path = require('node:path');
const { restoreBackup } = require('../src/platform/backupRestore');

function usage() {
  return `C04 restore into a new directory\n\n` +
    `node scripts/backup-restore-c04.js <backup-directory> [--output <new-directory>]\n\n` +
    `When --output is omitted, a timestamped sibling directory is created.\n` +
    `The command never targets the project's data directory or overwrites an existing directory.\n`;
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h') return { help: true };
  const backupDirectory = args.shift();
  if (!backupDirectory || backupDirectory.startsWith('--')) throw new Error('Cần chỉ định thư mục backup.');
  let outputDirectory;
  while (args.length) {
    const option = args.shift();
    if (option !== '--output') throw new Error(`Tùy chọn không hợp lệ: ${option}`);
    outputDirectory = args.shift();
    if (!outputDirectory || outputDirectory.startsWith('--')) throw new Error('Thiếu đường dẫn cho --output.');
  }
  return { backupDirectory: path.resolve(backupDirectory), outputDirectory: outputDirectory && path.resolve(outputDirectory) };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); process.exit(0); }
  const result = restoreBackup(options);
  console.log(`Bundle checksum, schema, balances, ledger, rooms và holds đã xác minh.`);
  console.log(`Dữ liệu phục hồi mới: ${result.directory}`);
  console.log(`PowerShell cấu hình để chạy fixture phục hồi:`);
  console.log(`  $env:GANG_DATABASE_FILE = '${result.databaseFile.replaceAll("'", "''")}'`);
  console.log(`  $env:GANG_DATA_FILE = '${result.storageFile.replaceAll("'", "''")}'`);
  console.log(`Chưa khởi chạy máy chủ và chưa ghi vào data/.`);
} catch (error) {
  console.error(`Restore thất bại${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
}
