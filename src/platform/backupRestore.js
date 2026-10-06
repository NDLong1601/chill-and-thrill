'use strict';

// C04 standalone backup/restore. The server-stopped assertion is deliberately
// explicit until a live quiesce gate is integrated into the product.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ProfileStore } = require('./profileStore');

const FORMAT = 'chill-and-thrill-backup';
const FORMAT_VERSION = 1;
const PROFILE_SCHEMA_VERSION = 4;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANAGER_JSON_BYTES = 128 * 1024 * 1024;

const MANAGER_FILES = Object.freeze([
  { id: 'gang-uno112', sourceKey: 'gangUno112', filename: 'rooms.json', gameIds: ['the-gang', 'uno'], versions: [1, 2], authority: 'room-service-compatibility' },
  { id: 'uno-108', sourceKey: 'uno108', filename: 'rooms.uno.json', gameIds: ['uno'], versions: [1], authority: 'authoritative-json' },
  { id: 'tien-len', sourceKey: 'tienLen', filename: 'rooms.tien-len.json', gameIds: ['tien-len'], versions: [1], authority: 'sqlite-snapshot-with-json-export' },
  { id: 'poker-export', sourceKey: 'poker', filename: 'rooms.poker.json', gameIds: ['poker'], versions: [1], authority: 'sqlite-snapshot-with-json-export' },
  { id: 'sam-loc', sourceKey: 'samLoc', filename: 'rooms.sam-loc.json', gameIds: ['sam-loc'], versions: [1], authority: 'sqlite-snapshot-with-json-export' },
  { id: 'phom', sourceKey: 'phom', filename: 'rooms.phom.json', gameIds: ['phom'], versions: [1], authority: 'sqlite-snapshot-with-json-export' },
  { id: 'bang', sourceKey: 'bang', filename: 'rooms.bang.json', gameIds: ['bang'], versions: [1], authority: 'authoritative-json' },
]);

const PROFILE_FILENAME = 'profile-store.sqlite';
const CURRENCY_COLUMNS = Object.freeze({
  chip: ['available', 'reserved'],
  coin: ['coin_available', 'coin_reserved'],
  gem: ['gem_available', 'gem_reserved'],
});
const REQUIRED_TABLES = Object.freeze([
  'schema_migrations', 'profiles', 'sessions', 'rooms', 'room_members', 'matches', 'match_players',
  'match_snapshots', 'wallets', 'wallet_operations', 'wallet_ledger', 'reservations', 'game_snapshots',
  'tutorial_verifications',
]);

class BackupRestoreError extends Error {
  constructor(message, code = 'BACKUP_INVALID') { super(message); this.name = 'BackupRestoreError'; this.code = code; }
}

function fail(message, code) { throw new BackupRestoreError(message, code); }
function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function pathKey(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}

function isWithin(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectOverlap(left, right, code = 'PATH_OVERLAP') {
  if (isWithin(left, right) || isWithin(right, left)) fail(`Các đường dẫn nguồn và đích bị chồng lấn: ${left} · ${right}`, code);
}

function ensureNoSymlinkComponents(value, { allowMissingTail = false } = {}) {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingTail && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`Không hỗ trợ symlink/junction trong đường dẫn: ${current}`, 'SYMLINK_REJECTED');
    if (index < parts.length - 1 && !stat.isDirectory()) fail(`Thành phần đường dẫn không phải thư mục: ${current}`, 'PATH_INVALID');
  }
  return absolute;
}

function requireRegularFile(filePath, label) {
  ensureNoSymlinkComponents(filePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} không phải tệp thường: ${filePath}`, 'FILE_INVALID');
  return stat;
}

function requireDirectory(directory, label) {
  ensureNoSymlinkComponents(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} không phải thư mục thường: ${directory}`, 'DIRECTORY_INVALID');
  return stat;
}

function defaultSourcePaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '../..'));
  const dataDirectory = path.resolve(options.dataDirectory || path.join(projectRoot, 'data'));
  const storageFile = path.resolve(options.storageFile || (!options.dataDirectory && process.env.GANG_DATA_FILE) || path.join(dataDirectory, 'rooms.json'));
  const databaseFile = path.resolve(options.databaseFile || (!options.dataDirectory && (process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE)) || path.join(dataDirectory, 'chill-and-thrill.sqlite'));
  const parsed = path.parse(storageFile);
  const adjacent = suffix => path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext || '.json'}`);
  const overrides = options.managerFiles || {};
  const managerFiles = {};
  for (const spec of MANAGER_FILES) {
    const explicit = overrides[spec.sourceKey] || options[`${spec.sourceKey}File`];
    managerFiles[spec.sourceKey] = path.resolve(explicit || (spec.sourceKey === 'gangUno112' ? storageFile : adjacent(
      spec.sourceKey === 'uno108' ? 'uno' : spec.sourceKey === 'tienLen' ? 'tien-len' : spec.sourceKey === 'poker' ? 'poker' : spec.sourceKey === 'samLoc' ? 'sam-loc' : spec.sourceKey === 'phom' ? 'phom' : 'bang')));
  }
  return { projectRoot, dataDirectory, databaseFile, storageFile, managerFiles };
}

function sourceRecords(options = {}) {
  const paths = defaultSourcePaths(options);
  return [
    { id: 'profile-store', sourcePath: paths.databaseFile, relativePath: `payload/${PROFILE_FILENAME}`, kind: 'sqlite-profile-ledger', authority: 'authoritative' },
    ...MANAGER_FILES.map(spec => ({ id: spec.id, sourceKey: spec.sourceKey, sourcePath: paths.managerFiles[spec.sourceKey], relativePath: `payload/${spec.filename}`,
      kind: 'manager-json', gameIds: spec.gameIds, authority: spec.authority, versions: spec.versions })),
  ];
}

function hashFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read)); bytes += read;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest('hex'), sizeBytes: bytes };
}

function snapshotFile(filePath) {
  requireRegularFile(filePath, 'Nguồn backup');
  return hashFile(filePath);
}

function assertNoSourceTargetOverlap(records, targetDirectory) {
  for (const record of records) rejectOverlap(path.dirname(record.sourcePath), targetDirectory, 'PATH_OVERLAP');
}

function assertSourceSidecarsUnchanged(databaseFile, before) {
  const sidecars = [`${databaseFile}-wal`, `${databaseFile}-shm`, `${databaseFile}-journal`];
  const after = new Map();
  for (const sidecar of sidecars) {
    if (fs.existsSync(sidecar)) {
      requireRegularFile(sidecar, 'SQLite sidecar');
      after.set(pathKey(sidecar), hashFile(sidecar));
    }
  }
  if (before.size !== after.size) fail('SQLite sidecar đã xuất hiện hoặc biến mất trong khi backup; nguồn không đứng yên.', 'SOURCE_CHANGED');
  for (const [key, fingerprint] of before) {
    const current = after.get(key);
    if (!current || current.sha256 !== fingerprint.sha256 || current.sizeBytes !== fingerprint.sizeBytes) {
      fail('SQLite sidecar thay đổi trong khi backup; nguồn không đứng yên.', 'SOURCE_CHANGED');
    }
  }
}

function discardReadOnlySidecars(databaseFile, before) {
  const beforeKeys = new Set(before.keys());
  const created = [];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${databaseFile}${suffix}`;
    if (!fs.existsSync(sidecar) || beforeKeys.has(pathKey(sidecar))) continue;
    requireRegularFile(sidecar, 'SQLite sidecar');
    const stat = fs.statSync(sidecar);
    // SQLite can create a transient shared-memory index simply to read a
    // WAL-mode database. Keep any non-empty newly-created WAL/journal intact.
    if (suffix !== '-shm' && stat.size > 0) fail('Kết nối SQLite chỉ đọc tạo sidecar có dữ liệu mới; dừng backup để không thay đổi nguồn.', 'SOURCE_CHANGED');
    created.push(sidecar);
  }
  for (const sidecar of created) fs.unlinkSync(sidecar);
  assertSourceSidecarsUnchanged(databaseFile, before);
}

function currentSidecarFingerprints(databaseFile) {
  const result = new Map();
  for (const sidecar of [`${databaseFile}-wal`, `${databaseFile}-shm`, `${databaseFile}-journal`]) {
    if (!fs.existsSync(sidecar)) continue;
    requireRegularFile(sidecar, 'SQLite sidecar');
    result.set(pathKey(sidecar), hashFile(sidecar));
  }
  return result;
}

function copyStableFile(sourcePath, destinationPath, injectedCopy = fs.copyFileSync) {
  const before = snapshotFile(sourcePath);
  injectedCopy(sourcePath, destinationPath);
  const after = snapshotFile(sourcePath);
  const copied = snapshotFile(destinationPath);
  if (before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes || before.sha256 !== copied.sha256 || before.sizeBytes !== copied.sizeBytes) {
    fail(`Tệp nguồn đổi trong khi sao chép hoặc bản sao chưa đầy đủ: ${sourcePath}`, 'SOURCE_CHANGED');
  }
  return copied;
}

function parseManagerFile(filePath, spec) {
  const stat = requireRegularFile(filePath, `Tệp manager ${spec.id}`);
  if (stat.size > MAX_MANAGER_JSON_BYTES) fail(`Tệp manager vượt giới hạn an toàn: ${filePath}`, 'FILE_TOO_LARGE');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { fail(`JSON manager không đọc được (${spec.id}): ${error.message}`, 'MANAGER_JSON_INVALID'); }
  if (!isObject(saved) || !spec.versions.includes(saved.version) || !Array.isArray(saved.rooms)) {
    fail(`Thiếu version/rooms hợp lệ trong JSON manager ${spec.id}.`, 'MANAGER_SCHEMA_INVALID');
  }
  const rooms = new Map();
  for (const room of saved.rooms) {
    if (!isObject(room) || typeof room.code !== 'string' || !room.code.trim()) fail(`Room không có mã hợp lệ trong ${spec.id}.`, 'ROOM_SCHEMA_INVALID');
    const code = room.code.trim().toUpperCase();
    if (rooms.has(code)) fail(`Mã phòng lặp trong ${spec.id}: ${code}`, 'ROOM_DUPLICATE');
    rooms.set(code, room);
  }
  return { saved, rooms };
}

function validateManifestShape(manifest, { allowCreating = false } = {}) {
  if (!isObject(manifest) || manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) {
    fail('Định dạng hoặc phiên bản manifest không được hỗ trợ.', 'MANIFEST_VERSION_UNKNOWN');
  }
  if (manifest.state !== 'complete' && !(allowCreating && manifest.state === 'complete')) fail('Bundle chưa được đánh dấu hoàn tất.', 'ARCHIVE_PARTIAL');
  if (!isObject(manifest.consistency) || manifest.consistency.mode !== 'server-stopped' || manifest.consistency.liveGateIntegrated !== false) {
    fail('Manifest không chứng minh chế độ server-stopped đã được dùng.', 'CONSISTENCY_MODE_INVALID');
  }
  if (!isObject(manifest.application) || manifest.application.profileSchemaVersion !== PROFILE_SCHEMA_VERSION) {
    const version = manifest?.application?.profileSchemaVersion;
    fail(`Schema ProfileStore ${version ?? 'không rõ'} chưa được hỗ trợ bởi bộ phục hồi này.`, 'PROFILE_SCHEMA_UNKNOWN');
  }
  if (!Array.isArray(manifest.files)) fail('Manifest thiếu danh sách files.', 'MANIFEST_INVALID');
  const expected = new Map([[`payload/${PROFILE_FILENAME}`, 'profile-store']]);
  for (const spec of MANAGER_FILES) expected.set(`payload/${spec.filename}`, spec.id);
  const seenPaths = new Set(); const seenIds = new Set();
  for (const file of manifest.files) {
    if (!isObject(file) || typeof file.path !== 'string' || typeof file.id !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      fail('Manifest có thông tin file/checksum không hợp lệ.', 'MANIFEST_INVALID');
    }
    const normalized = file.path.replaceAll('\\', '/');
    if (path.isAbsolute(file.path) || path.win32.isAbsolute(file.path) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
      fail(`Đường dẫn manifest không an toàn: ${file.path}`, 'PATH_TRAVERSAL');
    }
    if (normalized !== file.path || !expected.has(normalized) || expected.get(normalized) !== file.id) fail(`File manifest lạ hoặc sai vị trí: ${file.path}`, 'MANIFEST_FILE_UNKNOWN');
    if (seenPaths.has(normalized) || seenIds.has(file.id)) fail('Manifest lặp file hoặc id.', 'MANIFEST_DUPLICATE');
    seenPaths.add(normalized); seenIds.add(file.id);
  }
  if (seenPaths.size !== expected.size || [...expected.keys()].some(file => !seenPaths.has(file))) fail('Manifest thiếu file bắt buộc.', 'REQUIRED_FILE_MISSING');
  const sourceSchema = manifest.application.profileSchemaVersion;
  if (sourceSchema > PROFILE_SCHEMA_VERSION) fail(`Schema tương lai ${sourceSchema} chưa được hỗ trợ.`, 'PROFILE_SCHEMA_UNKNOWN');
  return true;
}

function readManifest(bundleDirectory) {
  const manifestPath = path.join(bundleDirectory, 'manifest.json');
  const stat = requireRegularFile(manifestPath, 'Manifest');
  if (stat.size > MAX_MANIFEST_BYTES) fail('Manifest vượt giới hạn kích thước.', 'MANIFEST_TOO_LARGE');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { fail(`Manifest JSON không đọc được: ${error.message}`, 'MANIFEST_INVALID'); }
  validateManifestShape(manifest);
  return manifest;
}

function assertDirectoryInventory(root, allowedFiles) {
  const allowedPaths = allowedFiles.map(value => path.join(root, ...value.replaceAll('\\', '/').split('/')));
  const allowed = new Set(allowedPaths.map(pathKey));
  const expectedPayloadDirectory = pathKey(path.join(root, 'payload'));
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail(`Symlink không được phép trong bundle: ${full}`, 'SYMLINK_REJECTED');
      if (stat.isDirectory()) {
        if (pathKey(full) !== expectedPayloadDirectory) fail(`Thư mục thừa/không hợp lệ trong bundle: ${full}`, 'ARCHIVE_PARTIAL');
        walk(full);
      }
      else if (!stat.isFile() || !allowed.has(pathKey(full))) fail(`Tệp thừa hoặc không hợp lệ trong bundle: ${full}`, 'ARCHIVE_PARTIAL');
    }
  };
  walk(root);
  for (const file of allowedPaths) if (!fs.existsSync(file)) fail(`Thiếu tệp trong bundle: ${file}`, 'REQUIRED_FILE_MISSING');
}

function checkFileChecksums(root, manifest, { stripPayload = false } = {}) {
  for (const record of manifest.files) {
    const relative = stripPayload ? record.path.slice('payload/'.length) : record.path;
    const filePath = path.join(root, ...relative.split('/'));
    requireRegularFile(filePath, `Tệp bundle ${record.id}`);
    const actual = hashFile(filePath);
    if (actual.sha256 !== record.sha256 || actual.sizeBytes !== record.sizeBytes) fail(`Checksum/kích thước không khớp: ${record.path}`, 'CHECKSUM_MISMATCH');
  }
}

function sumSafe(current, value, label) {
  const total = current + value;
  if (!Number.isSafeInteger(total)) fail(`Tổng vượt giới hạn số nguyên an toàn: ${label}`, 'BALANCE_OVERFLOW');
  return total;
}

function validateLedger(store) {
  const db = store.db;
  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id').all().map(row => row.id);
  const wallets = db.prepare('SELECT * FROM wallets ORDER BY profile_id').all();
  if (profiles.length !== wallets.length) fail('Số hồ sơ và ví không khớp.', 'ACCOUNT_LEDGER_MISMATCH');
  const byProfile = new Map(wallets.map(wallet => [wallet.profile_id, wallet]));
  for (const profileId of profiles) if (!byProfile.has(profileId)) fail(`Hồ sơ thiếu ví: ${profileId}`, 'ACCOUNT_LEDGER_MISMATCH');

  const ledger = new Map();
  for (const row of db.prepare(`SELECT profile_id, currency, SUM(available_delta) AS available, SUM(reserved_delta) AS reserved
    FROM wallet_ledger GROUP BY profile_id, currency`).all()) {
    if (!CURRENCY_COLUMNS[row.currency] || !byProfile.has(row.profile_id)) fail('Ledger tham chiếu hồ sơ hoặc tiền tệ không hợp lệ.', 'ACCOUNT_LEDGER_MISMATCH');
    ledger.set(`${row.profile_id}\0${row.currency}`, { available: row.available || 0, reserved: row.reserved || 0 });
  }

  const heldTotals = new Map();
  for (const reservation of db.prepare('SELECT id, profile_id, room_code, match_id, amount, status, currency, operation_key FROM reservations').all()) {
    if (!byProfile.has(reservation.profile_id) || !CURRENCY_COLUMNS[reservation.currency] || !Number.isSafeInteger(reservation.amount) || reservation.amount <= 0 ||
      !['HELD', 'RELEASED', 'SETTLED'].includes(reservation.status)) fail(`Reservation không hợp lệ: ${reservation.id}`, 'RESERVATION_INVALID');
    if (reservation.status === 'HELD') {
      const key = `${reservation.profile_id}\0${reservation.currency}`;
      heldTotals.set(key, sumSafe(heldTotals.get(key) || 0, reservation.amount, key));
    }
  }

  for (const [profileId, wallet] of byProfile) {
    for (const [currency, [availableColumn, reservedColumn]] of Object.entries(CURRENCY_COLUMNS)) {
      const actualAvailable = wallet[availableColumn], actualReserved = wallet[reservedColumn];
      if (!Number.isSafeInteger(actualAvailable) || !Number.isSafeInteger(actualReserved) || actualAvailable < 0 || actualReserved < 0) {
        fail(`Số dư ví không hợp lệ: ${profileId}/${currency}`, 'ACCOUNT_LEDGER_MISMATCH');
      }
      const sums = ledger.get(`${profileId}\0${currency}`) || { available: 0, reserved: 0 };
      if (sums.available !== actualAvailable || sums.reserved !== actualReserved) fail(`Ví và ledger lệch: ${profileId}/${currency}`, 'ACCOUNT_LEDGER_MISMATCH');
      if ((heldTotals.get(`${profileId}\0${currency}`) || 0) !== actualReserved) fail(`Ví reserved và tổng HELD lệch: ${profileId}/${currency}`, 'HOLD_BALANCE_MISMATCH');
    }
  }
  return { profiles: profiles.length, wallets: wallets.length, ledgerRows: db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count,
    heldReservations: db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'HELD'").get().count };
}

function activePhase(phase) { return !['CLOSED', 'CANCELLED'].includes(String(phase || '').toUpperCase()); }

function validateRoomAndHoldReferences(store, parsedManagers) {
  const db = store.db;
  const allRooms = new Map();
  const globalRoomCodes = new Map();
  const roomByGame = new Map();
  for (const spec of MANAGER_FILES) {
    const parsed = parsedManagers.get(spec.id);
    for (const [code, room] of parsed?.rooms || []) {
      const gameId = spec.id === 'gang-uno112' ? (room.gameId || 'the-gang') : spec.id === 'uno-108' ? 'uno-108' : spec.gameIds[0];
      const key = `${gameId}\0${code}`;
      if (allRooms.has(key)) fail(`Room lặp trong các manager JSON: ${gameId}/${code}`, 'ROOM_DUPLICATE');
      if (globalRoomCodes.has(code)) fail(`Mã phòng trùng giữa các manager JSON: ${code}`, 'ROOM_DUPLICATE');
      allRooms.set(key, room);
      globalRoomCodes.set(code, gameId);
      if (!roomByGame.has(gameId)) roomByGame.set(gameId, new Map());
      roomByGame.get(gameId).set(code, room);
    }
  }

  const snapshotRows = db.prepare('SELECT game_id AS gameId, room_code AS roomCode, state_json AS stateJson, closed_at AS closedAt FROM game_snapshots').all();
  const casualSnapshots = new Map(snapshotRows.filter(row => ['the-gang', 'uno-local', 'uno-108', 'bang'].includes(row.gameId))
    .map(row => [`${row.gameId}\0${row.roomCode}`, row]));
  const databaseRooms = db.prepare('SELECT room_code AS roomCode, game_id AS gameId, phase, state_json AS stateJson FROM rooms').all();
  for (const row of databaseRooms) {
    if (activePhase(row.phase) && ['the-gang', 'uno'].includes(row.gameId)) {
      const fileRoom = roomByGame.get(row.gameId)?.get(String(row.roomCode).toUpperCase());
      const recovery = row.gameId === 'the-gang' ? casualSnapshots.get(`the-gang\0${row.roomCode}`)
        : casualSnapshots.get(`uno-local\0${row.roomCode}`) || casualSnapshots.get(`uno-108\0${row.roomCode}`);
      if (!fileRoom && !recovery) fail(`Room SQLite ${row.gameId}/${row.roomCode} thiếu trong rooms.json.`, 'ROOM_REFERENCE_MISSING');
    }
    if (!row.stateJson) continue;
    let room;
    try { room = JSON.parse(row.stateJson); } catch { fail(`Room mirror SQLite JSON hỏng: ${row.gameId}/${row.roomCode}`, 'ROOM_REFERENCE_INVALID'); }
    if (!isObject(room) || room.code !== row.roomCode) fail(`Room mirror không khớp mã: ${row.gameId}/${row.roomCode}`, 'ROOM_REFERENCE_INVALID');
  }

  const snapshots = new Map();
  for (const row of snapshotRows) {
    if (row.closedAt || !row.stateJson) continue;
    let room;
    try { room = JSON.parse(row.stateJson); } catch { fail(`Game snapshot JSON hỏng: ${row.gameId}/${row.roomCode}`, 'ROOM_REFERENCE_INVALID'); }
    if (!isObject(room) || room.code !== row.roomCode) fail(`Game snapshot sai room code: ${row.gameId}/${row.roomCode}`, 'ROOM_REFERENCE_INVALID');
    snapshots.set(`${row.gameId}\0${row.roomCode}`, room);
  }

  const holdAudit = store.auditFixedGameHolds({ legacyRooms: [] });
  const inconsistent = holdAudit.filter(item => item.needsAttention);
  if (inconsistent.length) fail(`Có ${inconsistent.length} nhóm HELD coin chưa khớp snapshot/room của A01.`, 'HOLD_REFERENCE_MISMATCH');

  const held = db.prepare("SELECT id AS reservationId, operation_key AS operationKey, profile_id AS profileId, room_code AS roomCode, match_id AS matchId, amount, currency FROM reservations WHERE status = 'HELD'").all();
  const reservationRows = new Map(db.prepare('SELECT id AS reservationId, operation_key AS operationKey, profile_id AS profileId, room_code AS roomCode, match_id AS matchId, amount, status, currency FROM reservations').all()
    .map(row => [row.reservationId, row]));
  for (const [key, room] of snapshots) {
    if (!key.startsWith('poker\0')) continue;
    for (const seat of room.players || []) {
      if (!Number.isSafeInteger(seat.stack) || seat.stack < 0 || !Array.isArray(seat.reservations)) fail(`Poker stack/reservation list không hợp lệ: ${room.code}/${seat.id}`, 'HOLD_REFERENCE_MISMATCH');
      if (seat.stack > 0 && !seat.reservations.length) fail(`Poker stack không gắn với reservation: ${room.code}/${seat.id}`, 'HOLD_REFERENCE_MISMATCH');
      for (const reference of seat.reservations) {
        const row = reservationRows.get(reference.reservationId);
        if (!row || row.status !== 'HELD' || row.currency !== 'chip' || row.roomCode !== room.code || row.profileId !== seat.profileId ||
          row.amount !== reference.amount || reference.profileId !== seat.profileId) {
          fail(`Poker snapshot tham chiếu reservation không còn HELD: ${room.code}/${seat.id}`, 'HOLD_REFERENCE_MISMATCH');
        }
      }
    }
  }
  for (const item of held) {
    if (item.operationKey.startsWith('poker:')) {
      if (item.currency !== 'chip') fail(`Poker hold sai đơn vị: ${item.reservationId}`, 'HOLD_REFERENCE_MISMATCH');
      const room = snapshots.get(`poker\0${item.roomCode}`);
      if (!room || room.phase === 'CLOSED') fail(`Poker hold thiếu snapshot mở: ${item.roomCode}`, 'HOLD_REFERENCE_MISMATCH');
      const player = room.players?.find(seat => seat.profileId === item.profileId && Array.isArray(seat.reservations) &&
        seat.reservations.some(reference => reference.reservationId === item.reservationId && reference.profileId === item.profileId && reference.amount === item.amount));
      if (!player) fail(`Poker hold không có ghế/stack tham chiếu: ${item.reservationId}`, 'HOLD_REFERENCE_MISMATCH');
    } else if (item.operationKey.startsWith('tien-len:reserve:') || item.operationKey.startsWith('sam-loc:reserve:') || item.operationKey.startsWith('phom:reserve:')) {
      if (item.currency !== 'coin') fail(`Hold coin game sai đơn vị: ${item.reservationId}`, 'HOLD_REFERENCE_MISMATCH');
      const gameId = item.operationKey.startsWith('tien-len:') ? 'tien-len' : item.operationKey.startsWith('sam-loc:') ? 'sam-loc' : 'phom';
      const room = snapshots.get(`${gameId}\0${item.roomCode}`);
      const matchingHold = room?.reservations?.some(reference => reference.reservationId === item.reservationId && reference.profileId === item.profileId && reference.amount === item.amount);
      if (!room || room.phase === 'CLOSED' || room.matchId !== item.matchId || !matchingHold) {
        fail(`Hold coin không được bảo đảm bởi snapshot authoritative ${gameId}/${item.roomCode}: ${item.reservationId}`, 'HOLD_REFERENCE_MISMATCH');
      }
    } else {
      fail(`Có HELD reservation không thuộc game được hỗ trợ: ${item.operationKey}`, 'HOLD_REFERENCE_UNKNOWN');
    }
  }
  return { activeSqliteRooms: databaseRooms.filter(row => activePhase(row.phase)).length, activeGameSnapshots: snapshots.size,
    auditedCoinHoldGroups: holdAudit.length, pokerHeldReservations: held.filter(row => row.operationKey.startsWith('poker:')).length };
}

function validateDatabase(databasePath, manifest = null) {
  requireRegularFile(databasePath, 'ProfileStore backup');
  let store;
  try { store = new ProfileStore({ databaseFile: databasePath, readOnly: true }); }
  catch (error) { fail(`Không thể mở ProfileStore chỉ đọc: ${error.message}`, 'SQLITE_OPEN_FAILED'); }
  try {
    const schemaVersion = store.schemaVersion();
    if (schemaVersion > PROFILE_SCHEMA_VERSION) fail(`Schema ProfileStore tương lai ${schemaVersion} chưa được hỗ trợ.`, 'PROFILE_SCHEMA_UNKNOWN');
    if (schemaVersion !== PROFILE_SCHEMA_VERSION) fail(`Cần ProfileStore schema v${PROFILE_SCHEMA_VERSION}; nhận được ${schemaVersion}.`, 'PROFILE_SCHEMA_UNSUPPORTED');
    if (manifest && manifest.application.profileSchemaVersion !== schemaVersion) fail('Schema trong manifest không khớp SQLite.', 'PROFILE_SCHEMA_MISMATCH');
    const integrity = store.integrityCheck();
    if (integrity !== 'ok') fail(`PRAGMA integrity_check: ${integrity}`, 'SQLITE_INTEGRITY_FAILED');
    const missing = REQUIRED_TABLES.filter(table => {
      try { store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(); return false; }
      catch { return true; }
    });
    if (missing.length) fail(`ProfileStore thiếu bảng bắt buộc: ${missing.join(', ')}`, 'PROFILE_SCHEMA_INCOMPLETE');
    const foreignKeys = store.db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) fail(`PRAGMA foreign_key_check phát hiện ${foreignKeys.length} vi phạm.`, 'SQLITE_FOREIGN_KEY_FAILED');
    return { schemaVersion, integrity, ...validateLedger(store) };
  } finally { store.close(); }
}

function validatePayload(directory, manifest = null) {
  const parsedManagers = new Map();
  const degradedExports = [];
  for (const spec of MANAGER_FILES) {
    const filePath = path.join(directory, spec.filename);
    if (['tien-len', 'poker-export', 'sam-loc', 'phom'].includes(spec.id)) {
      // These files are exports. A valid committed SQL snapshot is the
      // recovery authority; an export's stale phase does not invalidate it.
      try { parsedManagers.set(spec.id, parseManagerFile(filePath, spec)); }
      catch (error) {
        if (!['MANAGER_JSON_INVALID', 'MANAGER_SCHEMA_INVALID', 'ROOM_SCHEMA_INVALID', 'ROOM_DUPLICATE'].includes(error.code)) throw error;
        degradedExports.push({ id: spec.id, reason: error.code });
        parsedManagers.set(spec.id, null);
      }
    } else parsedManagers.set(spec.id, parseManagerFile(filePath, spec));
  }
  const database = validateDatabase(path.join(directory, PROFILE_FILENAME), manifest);
  let holdReport;
  let store;
  try { store = new ProfileStore({ databaseFile: path.join(directory, PROFILE_FILENAME), readOnly: true }); }
  catch (error) { fail(`Không thể xác minh room/hold chỉ đọc: ${error.message}`, 'SQLITE_OPEN_FAILED'); }
  try {
    for (const degraded of degradedExports) {
      const gameId = degraded.id === 'poker-export' ? 'poker' : degraded.id;
      const rows = store.db.prepare('SELECT room_code FROM game_snapshots WHERE game_id = ?').all(gameId);
      if (!rows.length) fail(`Export ${degraded.id} hỏng nhưng không có snapshot SQLite ${gameId} để phục hồi thay thế.`, 'EXPORT_CORRUPT_WITHOUT_AUTHORITY');
    }
    holdReport = validateRoomAndHoldReferences(store, parsedManagers);
  }
  finally { store.close(); }
  return { database, ...holdReport, degradedExports,
    managerRooms: Object.fromEntries([...parsedManagers].map(([id, parsed]) => [id, parsed?.rooms.size ?? null])) };
}

function buildManifest(fileRecords, details, createdAt = new Date().toISOString()) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    state: 'complete',
    createdAt,
    consistency: {
      mode: 'server-stopped',
      liveGateIntegrated: false,
      operatorAssertion: 'The server was stopped cleanly before this backup began.',
      sqliteSnapshotMethod: 'VACUUM INTO through a read-only SQLite connection; the source database is not opened writable.',
    },
    application: { profileSchemaVersion: details.database.schemaVersion, profileStoreAuthority: 'one-shared-ledger-and-snapshot-database' },
    validation: details,
    files: fileRecords,
  };
}

function assertNewDestination(destination, { protectedDirectories = [], overlapWith = [] } = {}) {
  const resolved = path.resolve(destination);
  if (!path.basename(resolved) || path.basename(resolved) === '.' || path.basename(resolved) === '..') fail('Đường dẫn đích không hợp lệ.', 'PATH_INVALID');
  ensureNoSymlinkComponents(path.dirname(resolved));
  try {
    const existing = fs.lstatSync(resolved);
    if (existing.isSymbolicLink()) fail(`Đích là symlink/junction: ${resolved}`, 'SYMLINK_REJECTED');
    fail(`Thư mục đích đã tồn tại; chỉ tạo vào thư mục mới: ${resolved}`, 'DESTINATION_EXISTS');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const protectedDirectory of protectedDirectories.filter(Boolean)) {
    if (isWithin(protectedDirectory, resolved)) fail(`Không ghi vào thư mục dữ liệu đang dùng: ${resolved}`, 'PROTECTED_DATA_PATH');
  }
  for (const source of overlapWith) rejectOverlap(source, resolved, 'PATH_OVERLAP');
  return resolved;
}

function makeStage(destination) {
  const parent = path.dirname(destination);
  requireDirectory(parent, 'Thư mục cha đích');
  const stage = `${destination}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(stage, { mode: 0o700 });
  return stage;
}

function cleanupStage(stage) {
  if (!stage) return;
  try {
    const stat = fs.lstatSync(stage);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(stage, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function createBackup(options = {}) {
  if (options.serverStopped !== true) fail('Backup yêu cầu xác nhận --server-stopped; chưa có live quiesce gate tích hợp.', 'SERVER_STOP_CONFIRMATION_REQUIRED');
  if (!options.outputDirectory) fail('Cần chỉ định thư mục output backup mới.', 'OUTPUT_REQUIRED');
  const records = sourceRecords(options);
  const output = assertNewDestination(options.outputDirectory, { overlapWith: records.map(record => path.dirname(record.sourcePath)) });
  const sourceFingerprints = new Map();
  for (const record of records) {
    const stat = requireRegularFile(record.sourcePath, `Nguồn bắt buộc ${record.id}`);
    if (stat.size > MAX_MANAGER_JSON_BYTES && record.kind === 'manager-json') fail(`JSON manager vượt giới hạn: ${record.sourcePath}`, 'FILE_TOO_LARGE');
    if (fs.existsSync(`${record.sourcePath}.tmp`)) fail(`Còn tệp ghi tạm; hãy kiểm tra lần dừng server: ${record.sourcePath}.tmp`, 'SOURCE_INCOMPLETE');
    sourceFingerprints.set(record.id, snapshotFile(record.sourcePath));
  }
  const sidecarsBefore = currentSidecarFingerprints(records[0].sourcePath);
  const parent = path.dirname(output);
  requireDirectory(parent, 'Thư mục cha backup');
  const stage = makeStage(output);
  let published = false;
  let finalCreated = false;
  try {
    const payload = path.join(stage, 'payload');
    fs.mkdirSync(payload, { mode: 0o700 });
    const copiedFiles = [];
    const sourceDatabase = records[0].sourcePath;
    const targetDatabase = path.join(payload, PROFILE_FILENAME);
    let sourceSchema;
    try {
      const sourceDb = new DatabaseSync(sourceDatabase, { readOnly: true });
      try {
        sourceSchema = sourceDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null;
        if (sourceSchema > PROFILE_SCHEMA_VERSION) fail(`Schema ProfileStore tương lai ${sourceSchema} chưa được hỗ trợ.`, 'PROFILE_SCHEMA_UNKNOWN');
        if (sourceSchema !== PROFILE_SCHEMA_VERSION) fail(`Cần ProfileStore schema v${PROFILE_SCHEMA_VERSION}; nhận được ${sourceSchema}.`, 'PROFILE_SCHEMA_UNSUPPORTED');
        const integrity = Object.values(sourceDb.prepare('PRAGMA integrity_check').get() || {})[0];
        if (integrity !== 'ok') fail(`SQLite nguồn không toàn vẹn: ${integrity}`, 'SQLITE_INTEGRITY_FAILED');
        sourceDb.exec(`VACUUM INTO ${sqlString(targetDatabase)}`);
      } finally { sourceDb.close(); }
    } finally { discardReadOnlySidecars(sourceDatabase, sidecarsBefore); }
    const databaseFingerprint = snapshotFile(targetDatabase);
    copiedFiles.push({ id: 'profile-store', path: `payload/${PROFILE_FILENAME}`, sizeBytes: databaseFingerprint.sizeBytes, sha256: databaseFingerprint.sha256,
      kind: 'sqlite-profile-ledger', authority: 'authoritative' });

    for (const record of records.slice(1)) {
      const spec = MANAGER_FILES.find(item => item.id === record.id);
      const target = path.join(payload, spec.filename);
      const fingerprint = copyStableFile(record.sourcePath, target, options.copyFile || fs.copyFileSync);
      copiedFiles.push({ id: record.id, path: record.relativePath, sizeBytes: fingerprint.sizeBytes, sha256: fingerprint.sha256,
        kind: record.kind, gameIds: record.gameIds, authority: record.authority });
    }

    for (const record of records) {
      const before = sourceFingerprints.get(record.id), after = snapshotFile(record.sourcePath);
      if (before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes) fail(`Nguồn đổi trong lúc backup: ${record.sourcePath}`, 'SOURCE_CHANGED');
    }
    const payloadValidation = validatePayload(payload);
    if (payloadValidation.database.schemaVersion !== sourceSchema) fail('Schema nguồn và bản SQLite backup không khớp.', 'PROFILE_SCHEMA_MISMATCH');
    const manifest = buildManifest(copiedFiles, payloadValidation, options.createdAt || new Date().toISOString());
    validateManifestShape(manifest, { allowCreating: true });
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assertDirectoryInventory(stage, ['manifest.json', ...manifest.files.map(file => file.path)]);
    checkFileChecksums(stage, manifest);
    // Windows may not allow directory renames in managed locations. Publish
    // files into a new directory and create manifest.json last as the commit
    // marker; an interrupted copy is therefore always rejected as partial.
    fs.mkdirSync(output, { mode: 0o700 });
    finalCreated = true;
    for (const record of manifest.files) {
      const relative = record.path.split('/');
      const target = path.join(output, ...relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      copyStableFile(path.join(stage, ...relative), target);
    }
    for (const record of manifest.files) {
      const target = path.join(output, ...record.path.split('/'));
      const fingerprint = hashFile(target);
      if (fingerprint.sha256 !== record.sha256 || fingerprint.sizeBytes !== record.sizeBytes) fail(`Checksum khi publish không khớp: ${record.id}`, 'CHECKSUM_MISMATCH');
    }
    fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    verifyBackup(output);
    published = true;
    return { directory: output, manifest, validation: payloadValidation };
  } finally {
    if (!published) { cleanupStage(stage); if (finalCreated) cleanupStage(output); }
    else cleanupStage(stage);
  }
}

function verifyBackup(bundleDirectory) {
  const bundle = path.resolve(bundleDirectory);
  requireDirectory(bundle, 'Backup bundle');
  if (/\.partial(?:-|$)/i.test(path.basename(bundle))) fail('Không phục hồi archive .partial.', 'ARCHIVE_PARTIAL');
  const manifest = readManifest(bundle);
  const allowed = ['manifest.json', ...manifest.files.map(file => file.path)];
  assertDirectoryInventory(bundle, allowed);
  checkFileChecksums(bundle, manifest);
  const payload = path.join(bundle, 'payload');
  const validation = validatePayload(payload, manifest);
  return { bundle, manifest, validation };
}

function defaultRestoreDirectory(bundleDirectory, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(path.dirname(path.resolve(bundleDirectory)), `${path.basename(path.resolve(bundleDirectory))}-restored-${stamp}`);
}

function restoreBackup(options = {}) {
  if (!options.backupDirectory) fail('Cần chỉ định thư mục backup.', 'BACKUP_REQUIRED');
  const verified = verifyBackup(options.backupDirectory);
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '../..'));
  const defaultDb = options.databaseFile || process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE || path.join(projectRoot, 'data', 'chill-and-thrill.sqlite');
  const defaultRooms = options.storageFile || process.env.GANG_DATA_FILE || path.join(projectRoot, 'data', 'rooms.json');
  const protectedDirectories = [path.join(projectRoot, 'data'), path.dirname(path.resolve(defaultDb)), path.dirname(path.resolve(defaultRooms)), ...(options.protectedDirectories || [])];
  const requestedDestination = options.outputDirectory || defaultRestoreDirectory(verified.bundle, options.now || new Date());
  const destination = assertNewDestination(requestedDestination, { protectedDirectories, overlapWith: [verified.bundle] });
  const parent = path.dirname(destination);
  requireDirectory(parent, 'Thư mục cha phục hồi');
  const stage = makeStage(destination);
  let published = false;
  let finalCreated = false;
  try {
    for (const record of verified.manifest.files) {
      const relative = record.path.slice('payload/'.length);
      const source = path.join(verified.bundle, ...record.path.split('/'));
      const target = path.join(stage, relative);
      copyStableFile(source, target, options.copyFile || fs.copyFileSync);
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(verified.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const validation = validatePayload(stage, verified.manifest);
    for (const record of verified.manifest.files) {
      const fingerprint = hashFile(path.join(stage, record.path.slice('payload/'.length)));
      if (fingerprint.sha256 !== record.sha256 || fingerprint.sizeBytes !== record.sizeBytes) fail(`Checksum sau phục hồi không khớp: ${record.id}`, 'CHECKSUM_MISMATCH');
    }
    fs.mkdirSync(destination, { mode: 0o700 });
    finalCreated = true;
    for (const record of verified.manifest.files) {
      const relative = record.path.slice('payload/'.length);
      copyStableFile(path.join(stage, relative), path.join(destination, relative));
    }
    const finalValidation = validatePayload(destination, verified.manifest);
    for (const record of verified.manifest.files) {
      const relative = record.path.slice('payload/'.length);
      const fingerprint = hashFile(path.join(destination, relative));
      if (fingerprint.sha256 !== record.sha256 || fingerprint.sizeBytes !== record.sizeBytes) fail(`Checksum khi publish không khớp: ${record.id}`, 'CHECKSUM_MISMATCH');
    }
    fs.writeFileSync(path.join(destination, 'backup-manifest.json'), `${JSON.stringify(verified.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    published = true;
    return { directory: destination, databaseFile: path.join(destination, PROFILE_FILENAME), storageFile: path.join(destination, 'rooms.json'),
      manifest: verified.manifest, validation: finalValidation || validation };
  } finally {
    if (!published) { cleanupStage(stage); if (finalCreated) cleanupStage(destination); }
    else cleanupStage(stage);
  }
}

module.exports = {
  BackupRestoreError,
  FORMAT,
  FORMAT_VERSION,
  PROFILE_SCHEMA_VERSION,
  MANAGER_FILES,
  defaultSourcePaths,
  defaultRestoreDirectory,
  createBackup,
  verifyBackup,
  restoreBackup,
  validatePayload,
};
