# M0 — Dữ liệu, SQLite và chuyển đổi từ `rooms.json`

> Phác thảo schema, chưa tạo database và chưa chạy migration production. Tên cột/kiểu có thể điều chỉnh khi chọn driver SQLite, nhưng các invariant và ranh giới transaction là bắt buộc.

## 1. Nguyên tắc lưu trữ

- SQLite là nguồn sự thật cho profile, room/match, wallet, reservation, ledger và mission khi M3 bật.
- Mỗi thay đổi làm ảnh hưởng chip và kết quả match phải commit nguyên tử cùng marker revision.
- Snapshot game có thể chứa JSON riêng của module để không ép schema chung biết luật từng game; dữ liệu private vẫn nằm server.
- Không lưu session token dạng rõ. Client giữ token/credential cục bộ; database chỉ lưu hash + thời hạn + seat binding.
- Không reset hoặc ghi đè `data/rooms.json` trong M0.

## 2. SQLite schema phác thảo

Các khóa dùng UUID text; chip dùng `INTEGER`. Thời gian lưu UTC ISO/epoch thống nhất, hiển thị theo `Asia/Ho_Chi_Minh` ở server/UI.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','locked','deleted'))
);

CREATE TABLE player_sessions (
  session_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  seat_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX player_sessions_profile_idx ON player_sessions(profile_id);

CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  game_version INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('casual','thrill')),
  rule_variant TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','starting','playing','result','game_over','closed','expired')),
  host_seat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  seat_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  seat_number INTEGER NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0,1)),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1)),
  presence TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (presence IN ('connected','disconnected','left','removed')),
  joined_at TEXT NOT NULL,
  disconnected_at TEXT,
  reconnect_deadline TEXT,
  left_at TEXT,
  PRIMARY KEY (room_id, seat_id),
  UNIQUE (room_id, seat_number)
);
CREATE INDEX room_members_profile_idx ON room_members(profile_id);

CREATE TABLE matches (
  match_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  game_id TEXT NOT NULL,
  game_version INTEGER NOT NULL,
  rule_variant TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','playing','result','cancelled','game_over')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_turn_seat_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_json TEXT
);
CREATE INDEX matches_room_idx ON matches(room_id, started_at);

CREATE TABLE match_snapshots (
  match_id TEXT NOT NULL REFERENCES matches(match_id),
  revision INTEGER NOT NULL,
  public_state_json TEXT NOT NULL,
  server_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, revision)
);

CREATE TABLE action_receipts (
  action_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(match_id),
  seat_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  committed_revision INTEGER,
  action_type TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX action_receipts_match_idx ON action_receipts(match_id, created_at);

CREATE TABLE wallets (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id),
  available_chips INTEGER NOT NULL DEFAULT 0 CHECK (available_chips >= 0),
  reserved_chips INTEGER NOT NULL DEFAULT 0 CHECK (reserved_chips >= 0),
  in_game_chips INTEGER NOT NULL DEFAULT 0 CHECK (in_game_chips >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE chip_reservations (
  reservation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  match_id TEXT REFERENCES matches(match_id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('buy_in','max_loss','table_fee')),
  status TEXT NOT NULL CHECK (status IN ('held','partially_used','released','settled','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX reservations_profile_idx ON chip_reservations(profile_id, status);

CREATE TABLE wallet_entries (
  entry_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  reservation_id TEXT REFERENCES chip_reservations(reservation_id),
  match_id TEXT REFERENCES matches(match_id),
  action_id TEXT REFERENCES action_receipts(action_id),
  kind TEXT NOT NULL CHECK (kind IN ('grant','buy_in','bet','pot_win','settlement','release','admin_adjustment','refund')),
  delta INTEGER NOT NULL,
  available_after INTEGER NOT NULL CHECK (available_after >= 0),
  reserved_after INTEGER NOT NULL CHECK (reserved_after >= 0),
  in_game_after INTEGER NOT NULL CHECK (in_game_after >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX wallet_entries_profile_idx ON wallet_entries(profile_id, created_at);

CREATE TABLE mission_definitions (
  mission_id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('once','daily')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  reward_chips INTEGER NOT NULL CHECK (reward_chips >= 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mission_progress (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  mission_id TEXT NOT NULL REFERENCES mission_definitions(mission_id),
  period_key TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
  target INTEGER NOT NULL CHECK (target > 0),
  completed_at TEXT,
  PRIMARY KEY (profile_id, mission_id, period_key)
);

CREATE TABLE mission_claims (
  claim_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  mission_id TEXT NOT NULL REFERENCES mission_definitions(mission_id),
  period_key TEXT NOT NULL,
  wallet_entry_id TEXT NOT NULL REFERENCES wallet_entries(entry_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL,
  UNIQUE (profile_id, mission_id, period_key)
);
```

`server_state_json` là dữ liệu có thể cần khôi phục, không trả thẳng cho client. Với game có bí mật, `public_state_json` là template/filter hoặc được tạo theo profile khi đọc; không dùng một JSON public chứa bài mọi người rồi trông chờ client che bằng CSS.

## 3. Ranh giới transaction

### Tạo room và seat

Transaction A:

1. Xác minh profile/session và registry.
2. Insert `rooms`, `room_members`, `player_sessions` seat binding.
3. Commit, rồi phát `room:created`/`room:state`.

Nếu phát socket thất bại sau commit, client reconnect đọc room theo session; không rollback chỉ vì một socket chưa nhận được event.

### Bắt đầu match và giữ chip

Transaction B:

1. Lock room/members và tất cả wallet liên quan theo thứ tự `profile_id` ổn định.
2. Kiểm tra ready, game config, `available_chips`, không có reservation xung đột.
3. Insert match + snapshot revision 0.
4. Insert `chip_reservations` và `wallet_entries` với idempotency key.
5. Update `wallets` version/balances và room status.
6. Commit; sau đó phát state riêng.

Nếu một profile thiếu chip hoặc transaction conflict, rollback toàn bộ; không có trạng thái “đã giữ chip nhưng chưa có match”.

### Action và snapshot

Transaction C:

1. Lock match; tìm `action_receipts.action_id`.
2. Nếu đã committed, trả lại response cũ (`DUPLICATE_ACTION` hoặc success idempotent), không áp dụng lần hai.
3. Kiểm tra `expected_revision = matches.revision`, quyền seat và legal action.
4. Chạy game module; nếu có settlement proposal, wallet service kiểm tra invariant trong cùng transaction.
5. Insert receipt, snapshot revision + 1, update match/room, wallet entries và event mission.
6. Commit rồi gửi `game:state` đã lọc theo profile.

### Kết thúc match

Transaction D:

- Đánh dấu `matches.status=result/game_over`, ghi `result_json` và final snapshot.
- Tính settlement từ kết quả server; chuyển reservation → stack/pot → `available` theo ruleset.
- Ghi ledger cho từng profile, đảm bảo idempotency theo `matchId:result`.
- Tạo event nội bộ `match_completed`; cập nhật `mission_progress` một lần.
- Commit rồi phát kết quả và wallet/mission view.

### Claim nhiệm vụ

Transaction E: lock progress → kiểm tra completed và `mission_claims` → insert wallet grant + claim với cùng idempotency key → update available → commit. Bấm “Nhận” nhiều lần chỉ trả claim hiện có.

## 4. Phân biệt các loại chip

| Số dư | Ý nghĩa | Hiển thị |
|---|---|---|
| `available_chips` | Có thể dùng ở game Kịch tính hoặc reward tiếp theo | Profile/wallet |
| `reserved_chips` | Đã giữ cho room/match, chưa thuộc pot | Profile + room của chính người chơi |
| `in_game_chips` | Stack/pot đang do match quản lý | Match/seat riêng |
| The Gang rank chip | Số 1..N để xếp bài trong luật The Gang | Game state; không ở wallets |

Trong M3, các game đơn giản có thể chỉ dùng `max_loss` reservation. Poker chỉ cho bổ sung stack giữa các ván. Không cho phép profile dùng cùng reservation ở hai room.

## 5. Ánh xạ từ `data/rooms.json` version 1

Room hiện tại do `GameManager` lưu có những trường quan trọng: `code`, `phase`, `matchId`, `mode`, giới hạn két/báo động, `players`, bài/chip/thẻ/challenges, `score`, `history`, `matches`, `deckProgress`, log/chat và `updatedAt`.

| JSON hiện tại | Schema mới | Cách xử lý |
|---|---|---|
| `room.code` | `rooms.room_code` | Giữ nguyên mã, tạo `room_id` mới ổn định |
| `mode` | `game_id=the-gang`, `rule_variant=mode` | Không để `mode` làm category |
| `players[].id` | `room_members.seat_id` + profile mapping | Không gộp theo tên; tạo profile/import map cần xác nhận |
| `players[].token` | `player_sessions.token_hash` | Chỉ hash token trong migration; cho phép token legacy qua adapter tạm thời |
| `socketId`, `connected` | `presence`, `disconnected_at` | Luôn khởi tạo disconnected khi server restart |
| `players[].chips` | Match private state | Không đưa vào wallet; giữ là rank chip The Gang |
| `privateCards`, deck/challenges | `match_snapshots.server_state_json` | Mã hóa file/permission tùy lớp bảo vệ, không public API |
| `history`, `matches` | `matches` + `result_json` hoặc bảng history sau | Giữ timestamp gốc, đánh dấu `source=rooms-json-v1` nếu cần audit |
| `updatedAt` | `rooms.updated_at` | Kiểm tra TTL 12 giờ tương thích hiện tại |
| log/chat | `room_events` bổ sung ở migration sau nếu cần | Không cần chặn M3 nếu lịch sử không yêu cầu query |

Migration phải đặt `source_version=1` trong metadata/backup và có mapping report: số room, seat, match, record lỗi. Room có JSON lỗi không được ghi đè hoặc bỏ qua im lặng.

## 6. Quy trình backup, khôi phục và rollback

### Trước migration

1. Dừng server hoặc vào maintenance để không có write đồng thời.
2. Copy nguyên file `data/rooms.json` sang thư mục backup có timestamp và checksum; không đổi file nguồn.
3. Parse read-only, kiểm tra version, số room, token, player count, JSON private và `updatedAt`.
4. Tạo database mới bên cạnh file cũ; import trong transaction theo từng batch có report.

### Sau migration

1. So khớp room/seat/match/history counts và một mẫu private-state bằng token hợp lệ.
2. Khởi động code adapter ở chế độ read-only/dual-read; không bật ví trước khi reconnect và snapshot pass.
3. Backup database trước mỗi schema migration; WAL checkpoint sau khi backup.
4. Chỉ chuyển source of truth sau khi có smoke test create/join/resume/restart.

### Khôi phục

- Tắt writer, giữ bản database hỏng để forensic, restore backup cùng `schema_migrations` tương ứng.
- Chạy integrity check (`PRAGMA integrity_check`, foreign keys) và đối soát ledger trước khi mở room.
- Nếu room chưa có đủ dữ liệu để xác định settlement, khóa room đó; không tự chia lại hoặc cấp bù.

### Rollback

Rollback code chỉ được phép về phiên bản hiểu cùng schema. Nếu cần quay về JSON adapter, xuất một snapshot compatibility có version rõ ràng; không chạy code cũ trực tiếp lên database mới. Không có rollback nào tự xóa ledger hoặc giảm số chip để “khớp” trạng thái cũ.

## 7. Kiểm tra dữ liệu bắt buộc ở M3/M7

- Migration chạy lại không nhân đôi profile, reservation, ledger hoặc mission claim.
- Restart giữa từng điểm trước/sau commit không tạo chip âm hoặc cấp thưởng hai lần.
- Reconnect trả đúng seat/private view sau restart.
- Tổng `available + reserved + in_game` và ledger đối soát được cho mỗi profile.
- Dữ liệu The Gang rank chip không xuất hiện trong wallet entries.
- Backup restore mở lại được phòng chưa hết hạn và từ chối token đã thu hồi.
