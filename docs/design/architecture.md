# M0 — Kiến trúc cổng game LAN

> Đây là kiến trúc đích cho M1–M7. M0 chỉ ghi thiết kế; production vẫn chạy flow The Gang hiện tại.

## 1. Bản đồ code hiện tại

```text
server.js
  └─ src/httpServer.js
       ├─ Express static → public/index.html, public/js/*, public/css/*
       ├─ GET /api/rules, /api/network, /api/rooms/:code/qr
       └─ Socket.IO connection
            ├─ payload guard/rate limit
            └─ GameManager (src/gameEngine.js)
                 ├─ room lifecycle + seat/reconnect
                 ├─ The Gang state machine
                 ├─ private-state redaction
                 └─ JSON persistence → data/rooms.json

src/deck.js + src/handEvaluator.js + src/cardsData.js
  └─ bộ bài, đánh giá Poker, thẻ The Gang

public/js/app.js
  └─ socket client, lobby/waiting/table render
public/js/enhancements.js
  └─ reconnect, private UI, specialist/showdown/chat/history
public/js/table-layout.js
  └─ layout responsive bàn The Gang
```

### Đường đi dữ liệu hiện tại

1. `server.js` tạo `GameManager` với `data/rooms.json`.
2. `httpServer.js` nhận `create_room`, `join_room`, `resume_room` và các action The Gang.
3. `GameManager.access()` kiểm tra socket/room/host/phase; mutation cập nhật object room rồi `broadcast()`.
4. `buildStateFor(room, playerId)` lọc bài, chip log và state private trước khi gửi tới socket từng người.
5. `saveSoon()` ghi version 1 vào file tạm rồi rename.

Điểm cần bảo toàn: token khôi phục hiện nằm trong room object để tương thích The Gang; khi chuyển sang persistence mới phải hash token trong database nhưng vẫn có adapter xác minh token cũ trong thời gian chuyển tiếp.

## 2. Kiến trúc đích vừa đủ

```text
src/
  platform/
    gameRegistry.js       # metadata + capability, server-owned category
    roomService.js        # room, member, seat, host, ready, invite
    playerService.js      # profile, session, device binding
    walletService.js      # balance/reservation/ledger, không biết luật game
    missionService.js     # event đã xác nhận → progress/claim
    persistence/
      sqlite.js
      migrations/
      roomJsonAdapter.js
      backupRestore.js
    transport/
      httpRoutes.js
      socketProtocol.js
      stateRedactor.js
  games/
    gameModule.js         # contract chung
    the-gang/adapter.js    # bọc behavior GameManager hiện tại
    uno/
    tien-len/
    poker/
    sam-loc/
    phom/
    bang/
  shared/cards/            # chỉ công cụ dùng chung đã kiểm chứng

public/js/
  shell/                   # route, profile, category, errors
  components/              # room, seats, connection, chat
  games/                   # game-specific view/action
```

Không cần tạo toàn bộ cây thư mục ở M1. Thứ tự tách: `gameRegistry` → `roomService` adapter → `the-gang/adapter` → route shell → game modules. `GameManager` hiện tại có thể được bọc trước, rồi mới tách class khi test hồi quy đã có.

### Ranh giới trách nhiệm

| Thành phần | Được làm | Không được làm |
|---|---|---|
| Registry | Xác định game, category, version, capabilities, limits | Tin `category` do client gửi |
| Room service | Room, seat, host, ready, access, reconnect binding | Tính thắng/thua hoặc tự trừ ví |
| Game module | Rule state, legal action, private view, timeout, result, settlement proposal | Ghi trực tiếp wallet/SQL hoặc phát socket |
| Wallet service | Balance, reservation, ledger, idempotency và atomic settlement | Quyết định action game |
| Mission service | Tính progress từ event server đã commit, claim một lần | Nhận “đã thắng” do client tự khai |
| Transport | Validate envelope, auth, rate limit, map error/event | Chứa luật từng game |
| UI game | Render view được phép, gửi action ID/revision | Che dữ liệu bí mật bằng CSS để thay server redaction |

## 3. Game module contract

Mỗi module đăng ký một object tương đương:

```js
const game = {
  metadata: {
    gameId: 'uno', category: 'casual', version: 1,
    minPlayers: 2, maxPlayers: 4, status: 'playable',
    usesWallet: false, supportsResume: true
  },
  validateConfig(config) {},
  createMatch({ room, members, seed }) {},
  getAvailableActions({ match, seatId, now }) {},
  applyAction({ match, seatId, action, now }) {
    return { nextMatch, events, result: null, settlement: null };
  },
  onTimeout({ match, seatId, now }) {},
  onDisconnect({ match, seatId, now }) {},
  visibleState({ match, profileId, seatId }) {},
  resultView({ result, profileId }) {},
  proposeSettlement({ result, walletPolicy }) {}
};
```

`createMatch` phải khởi tạo state đầy đủ và server seed; `applyAction` là pure-ish mutation trong transaction của repository. `settlement` chỉ là đề xuất có danh sách delta/reservation; wallet service mới xác minh và ghi.

### Action envelope

```json
{
  "actionId": "uuid-v4",
  "roomCode": "ABCD",
  "matchId": "uuid-v4",
  "seatId": "uuid-v4",
  "expectedRevision": 42,
  "type": "play_card",
  "payload": { "cardId": "red-7" }
}
```

- `actionId` chống gửi lại; unique theo match hoặc toàn hệ thống.
- `expectedRevision` chống action từ UI cũ. Revision không khớp trả state mới + mã `STALE_REVISION`, không áp dụng lại.
- `matchId` chống gửi action cũ sang trận kế tiếp.
- Server lấy `seatId/profileId` từ session; không tin giá trị tùy ý trong payload.

### Phản hồi action

```json
{
  "ok": false,
  "error": { "code": "NOT_YOUR_TURN", "message": "Chưa tới lượt bạn.", "retryable": true },
  "state": { "revision": 43 }
}
```

Mã lỗi tối thiểu: `AUTH_REQUIRED`, `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `SEAT_TAKEN`, `GAME_NOT_PLAYABLE`, `INVALID_CONFIG`, `NOT_READY`, `MATCH_NOT_FOUND`, `STALE_REVISION`, `DUPLICATE_ACTION`, `NOT_YOUR_TURN`, `INVALID_ACTION`, `INSUFFICIENT_CHIPS`, `WALLET_CONFLICT`, `GAME_PAUSED`, `PLAYER_DISCONNECTED`, `INTERNAL_ERROR`. Message tiếng Việt do transport map theo code; client không tự đoán lỗi bằng text.

## 4. Kết nối và event mạng

### HTTP

| Route | Mục đích | Ghi chú |
|---|---|---|
| `/`, `/play/*`, `/games/*`, `/rooms/*`, `/missions`, `/profile` | App shell/deep link | Cần fallback `index.html` khi M1 bật route thật |
| `GET /api/registry` | Danh mục game | Server-owned metadata, versioned |
| `GET /api/rooms/:code` | Thông tin public tối thiểu | Không trả private state hoặc token |
| `GET /api/rooms/:code/qr` | QR link mời | Giữ allow-list origin như `httpServer.js` hiện tại |
| `GET /api/profile`, `/api/wallet`, `/api/missions` | Read model | Auth bằng session, không dùng tên |

### Socket events

Event mới giữ namespace rõ ràng; trong giai đoạn chuyển tiếp có bridge tới tên cũ:

| Client → server | Server kiểm tra | Server → client |
|---|---|---|
| `room:create` | registry/config/profile | `room:created`, `room:error` |
| `room:join` | code, status, capacity | `room:joined`, `room:state` |
| `room:resume` | hashed token/session/seat | `room:resumed`, `room:error` |
| `room:ready` | seat + waiting phase | `room:state` |
| `game:action` | action envelope + revision | `game:state`, `game:action_result` |
| `game:request_state` | access | `game:state` |
| `wallet:updated` | server after commit | per-profile wallet view |
| `mission:updated` | server event/claim | per-profile mission view |
| `room:presence` | socket connect/disconnect | filtered presence |

Event state luôn bao gồm `roomCode`, `gameId`, `matchId`, `revision`, phase/status và `serverTime`. Chỉ broadcast state đã redact riêng từng profile. Một room được serialize mutation theo thứ tự; ví được khóa theo profile/reservation để hai room không tiêu cùng số dư.

## 5. Public/private boundary

| Dữ liệu | Public theo room | Chỉ seat/profile tương ứng | Không gửi client |
|---|---|---|---|
| Tên/avatar/ghế/kết nối/ready | Có | — | token/session secret |
| Game/variant/config/phase/revision | Có nếu luật cho phép | — | seed ngẫu nhiên |
| Bài chung, discard công khai, lượt | Có | — | bộ bài chưa chia |
| Bài trên tay | Không, chỉ số lượng/back | Chủ seat | Bài đối thủ chưa reveal |
| Vai ẩn BANG! | Không | Nếu chính sách cho phép chủ vai | Vai, mục tiêu hoặc deck chưa reveal |
| Wallet `available/reserved` | Không mặc định | Chủ profile | Số dư người khác, token |
| Chip xếp hạng The Gang | Mức cần thiết theo luật | State riêng có lọc | Lịch sử chip khi challenge che |
| Ledger/mission detail | Không | Profile/administrator | Dữ liệu profile khác |

`stateRedactor` là server module độc lập, có test kiểm tra không xuất hiện card/role/token khác người. Không dùng `display:none`, blur hoặc mã hóa trong JavaScript client để bảo vệ bí mật.

## 6. Room lifecycle và reconnect

```text
DISCOVERED → WAITING → STARTING → PLAYING → RESULT ─┐
     ↑          │          │          └→ CANCELLED   │
     └──────────┴──────────┴─────────────────────────┘
                         PLAYING → GAME_OVER → CLOSED
```

- `WAITING`: join/leave/ready; đổi game không hợp lệ, đổi game = room mới.
- `STARTING`: server re-check registry, players, profile lock, wallet requirement; lỗi thì trở lại waiting.
- `PLAYING`: disconnect không tự hoàn tiền; module chọn pause/timeout/leave-after-match.
- `RESULT`: settlement đã commit; cho “chơi tiếp” tạo match mới, room giữ nguyên.
- `CLOSED`: chỉ sau khi reservations đã released/settled và snapshot cuối đã backup.

Khi socket disconnect, `roomService` đánh dấu seat `disconnectedAt`, giữ `sessionId`/seat lock trong grace period và phát presence. Reconnect xác minh token hash, bind socket mới rồi cấp view theo profile. Nếu hai socket cùng token, socket cũ hoặc socket mới phải bị thu hồi theo chính sách một controller; mặc định từ chối socket thứ hai.

Restart server đọc snapshot cuối có `committedRevision`. Snapshot chỉ được xem là khôi phục được nếu wallet reservation/ledger cùng transaction marker. Nếu không đối soát được, khóa match/room và báo quản trị, không tự suy đoán chip.

## 7. Tính toàn vẹn chip

Chip The Gang là `gameState`/rank chip, không đi qua `walletService`. Chip kinh tế có ba lớp:

```text
wallet.available  → reservation (giữ cho room/match)
reservation       → stack/pot (game private state + ledger marker)
stack/pot         → wallet.available (settlement)
```

Mọi thay đổi chip phải nằm trong một transaction repository gồm action receipt, match snapshot, reservation/ledger và mission event nếu có. Invariant:

- số nguyên, không âm;
- một reservation không thuộc hai match;
- `available + reserved + in_game` khớp sổ theo profile;
- mỗi delta có idempotency key;
- tổng chip không đổi trong thanh toán giữa người chơi, chỉ tăng từ reward/admin entry có audit.

## 8. Timeout, disconnect và quyền riêng tư theo game

Game module trả `timeoutPolicy` trong config. Không dùng hành vi “bỏ lượt” chung:

- The Gang: pause khi thiếu seat đang kết nối, giữ bài/chip.
- Game theo lượt: chờ grace period, sau đó hành động timeout chỉ khi variant đã chốt.
- Poker: có thể auto-check nếu hợp lệ, auto-fold khi phải call; phải ghi rõ trong variant.
- BANG!: vai ẩn vẫn nằm server; disconnect không được tự reveal vai.

Timeout là action do server tạo với `actionId`/revision riêng, ghi log như action người chơi và có thể replay trong test.

## 9. Lộ trình tách code an toàn

1. Viết contract và registry read-only; không đổi UI hiện tại.
2. Bọc `GameManager` bằng `the-gang/adapter`; giữ event cũ và thêm contract tests.
3. Đưa room/seat/reconnect vào service chung bằng adapter JSON.
4. Thêm shell route/category/detail; route legacy tiếp tục chạy.
5. Thêm UNO không chia sẻ state với The Gang; sau đó mới bật SQLite/wallet.
6. Chỉ khi transaction/reconnect có test mới thêm game Kịch tính và payment proposal.

Rủi ro chính là `src/gameEngine.js` đang gộp room lifecycle và luật; tách một lần dễ làm hỏng private redaction, host transfer hoặc deck progress. Vì vậy mỗi bước phải giữ test hiện có 32 case và bổ sung test boundary trước khi xóa code cũ.
