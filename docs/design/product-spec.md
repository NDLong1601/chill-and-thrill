# M0 — Đặc tả sản phẩm cổng game LAN

> Trạng thái: thiết kế và prototype, chưa bật tính năng production.
>
> Phạm vi của tài liệu này là tạo nền đủ cụ thể để triển khai M1–M7 từ code hiện có. Prototype dùng dữ liệu minh họa cố định, không đại diện cho phòng thật, ví thật hoặc kết quả thật.

## 1. Phạm vi và nguyên tắc

The Gang được mở rộng thành một cổng game chạy trên một máy chủ trong LAN. Người chơi dùng điện thoại, máy tính bảng hoặc máy tính cùng WiFi. Server là nguồn sự thật cho phòng, luật, bài/vai, kết quả và chip.

Trong M0 chỉ làm khảo sát, đặc tả, schema phác thảo và prototype. Không thêm route production, không đổi protocol Socket.IO hiện tại, không migrate `data/rooms.json`, không tạo ví/nhiệm vụ thật.

### Phạm vi sản phẩm

| Nhóm | Game ID | Trạng thái thiết kế M0 | Dự kiến mốc chạy thật |
|---|---|---|---|
| Giải trí | `the-gang` | Đang chạy trong code hiện có | M1, adapter bảo toàn luật |
| Giải trí | `uno` | Thiết kế | M2 |
| Giải trí | `bang` | Có trong danh mục, chưa chốt luật | M6C |
| Kịch tính | `poker` | Có evaluator bài, chưa có vòng cược | M5 |
| Kịch tính | `tien-len` | Đề xuất Tiến lên miền Nam | M4 |
| Kịch tính | `sam-loc` | Chưa chốt biến thể | M6A |
| Kịch tính | `phom` | Chưa chốt biến thể | M6B |

`casual` và `thrill` là category của sản phẩm, không phải luật hoặc mode của game. `gameId` là định danh ổn định của một game. `ruleVariant`/`difficulty` là cấu hình riêng của game. Một phòng chỉ có một `gameId`; đổi game là tạo phòng mới.

### Ngoài phạm vi

- Bot, matchmaking Internet, cloud sync, tài khoản email và nạp/rút tiền.
- Chuyển chip trực tiếp giữa người chơi.
- Công bố luật chính thức của UNO, BANG!, Tiến lên, Sâm lốc hoặc Phỏm khi chưa chốt phiên bản.
- Cho rằng prototype hoặc browser check là kiểm tra thiết bị thật.

## 2. Cơ sở thực tế từ code hiện tại

| Điểm đã kiểm tra | Bằng chứng | Hệ quả thiết kế |
|---|---|---|
| Entry point | `server.js` gọi `createGameServer()` và lưu JSON qua `GANG_DATA_FILE` | Giữ Node.js/Express/Socket.IO; thêm platform layer từng bước |
| HTTP/Socket | `src/httpServer.js` phục vụ toàn bộ `public`, `/api/rules`, `/api/network`, QR và các event Socket.IO | Route trang mới có thể dùng fallback HTML; event chung cần adapter |
| Phòng và luật | `src/gameEngine.js` chứa `GameManager`, trạng thái phòng, state machine The Gang và reconnect | Tách `roomService` khỏi `the-gang` nhưng giữ behavior qua adapter |
| Bài | `src/deck.js`, `src/handEvaluator.js` | Chỉ tái dùng cho game có cùng bộ bài sau khi kiểm tra luật |
| UI | `public/index.html` có `screen-lobby`, `screen-waiting`, `screen-game`; `public/js/app.js`, `enhancements.js`, `table-layout.js` render và gửi event | Dùng shell chung, không bê toàn bộ bàn The Gang sang game khác |
| Persistence | `data/rooms.json`, version 1; ghi file tạm rồi rename | Chỉ dùng cho The Gang trong chuyển tiếp; ví phải đi cùng transaction SQLite |
| Test | `test/game.test.js`, `test/integration.test.js`, `scripts/browser-check.js` | Mỗi mốc giữ hồi quy The Gang và thêm test engine/transport riêng |

### Hiện trạng baseline

- `npm test`: **32/32 pass**, chạy trước khi tạo tài liệu M0.
- `npm run test:browser`: Playwright khởi chạy nhưng **fail** tại `scripts/browser-check.js:255`, timeout 8 giây khi chờ toast sau mô phỏng từ chối fullscreen. Đây là kết quả baseline của ứng dụng hiện tại; M0 không sửa vì không thuộc phạm vi nghiệp vụ/prototype.
- Không có `AGENTS.md` trong dự án và chưa có `docs/milestones` trước M0.
- Khi khảo sát M0, Git root của bản nguồn nằm ở thư mục cha. Sau khi hợp nhất, thư mục làm việc và Git root hiện tại là `C:\Users\PC\Documents\chill-and-thrill`; chi tiết phiên bản đang chạy nằm trong `docs/migrations/M0-M3-merge.md`.

## 3. Mô hình người chơi, phòng và game

### Danh tính độc lập

| ID | Đại diện | Vòng đời | Không được dùng thay cho |
|---|---|---|---|
| `profileId` | Hồ sơ bền vững, ví, nhiệm vụ, thống kê | Nhiều phòng/nhiều thiết bị theo chính sách ghép hồ sơ | Socket hoặc ghế |
| `seatId` | Ghế của profile trong một room/match | Một room; giữ qua reconnect | Hồ sơ toàn cục |
| `socketId` | Kết nối Socket.IO hiện tại | Có thể đổi sau reload/mất WiFi | Quyền sở hữu lâu dài |
| `sessionToken` | Bí mật khôi phục một ghế | Có hạn/thu hồi; lưu hash server | Mật khẩu hoặc profile ID |
| `roomCode` | Mã mời 4–6 ký tự của phòng | Tới khi phòng hết hạn | Game ID |
| `matchId` | Một trận/vòng đời kết quả | Tạo mới khi bắt đầu trận | Room |
| `revision` | Phiên bản trạng thái server | Tăng sau mỗi mutation commit | Timestamp client |

Tên trùng không được tự động gộp hồ sơ. Một profile chỉ điều khiển một ghế có chip trong bản đầu; mở tab thứ hai chỉ được xem trạng thái hoặc bị từ chối điều khiển.

### Danh mục game đề xuất

Metadata tối thiểu:

```js
{
  gameId: 'tien-len', category: 'thrill', version: 1,
  title: 'Tiến lên', status: 'design', minPlayers: 2, maxPlayers: 4,
  ruleVariants: [{ id: 'south-v1', title: 'Tiến lên miền Nam · local v1' }],
  usesWallet: true, supportsResume: true
}
```

Server suy ra `category` từ registry theo `gameId`; client không thể gửi game Kịch tính giả để bỏ qua điều kiện chip. `status` chỉ cho tạo phòng khi là `playable`. Game `coming_soon` vẫn hiện trong danh mục nhưng nút tạo bị khóa.

## 4. Thông tin và luồng sử dụng

### Mở trang chủ

1. Tải `/`, hiển thị logo cổng, hai category và ô nhập mã phòng.
2. Nếu có session room hợp lệ, hiển thị “Tiếp tục phòng ABCD”; không tự động vào bàn khi chưa xác nhận.
3. Nếu `?room=ABCD`, giữ tương thích link cũ: ưu tiên kiểm tra mã phòng và đưa tới màn xác nhận phòng. Nếu có token ghế hợp lệ thì đề xuất khôi phục; không gửi token lên URL mới.
4. Mã không tồn tại/hết hạn hiển thị lỗi có hướng dẫn quay lại, không tạo phòng ngầm.

### Chọn chế độ và game

- Home → `/play/casual` hoặc `/play/thrill`.
- Category → `/games/:gameId`.
- Detail hiển thị luật nhanh, số người, variant, tình trạng phát hành, các phòng đang mở nếu server cho phép public listing.
- Không có thời lượng ước tính nếu chưa có dữ liệu đủ tin cậy.

### Tạo và vào phòng

1. Người dùng chọn game, variant, tên hiển thị, avatar và cấu hình được phép.
2. Server kiểm tra registry, giới hạn người, điều kiện ví và tạo `room` gắn với một `gameId`.
3. Host nhận `roomCode`, link/QR; người khác vào bằng mã, link hoặc QR.
4. Link mời đi thẳng đến phòng, không buộc chọn lại category/game.
5. Phòng chờ hiển thị ghế, kết nối, sẵn sàng, host, luật, hành vi disconnect và trạng thái chip. Đổi luật/cấu hình hủy ready của cả phòng.
6. Host bắt đầu khi đủ người và server kiểm tra lại snapshot cấu hình, số dư, khoản giữ.

### Sẵn sàng, chơi, kết quả, chơi tiếp

`READY` là trạng thái của seat trong room, không phải hồ sơ. Tất cả ready chỉ là điều kiện bắt đầu; server vẫn kiểm tra lần cuối.

- `PLAYING`: game module tạo match state, action được server xác thực, state riêng người được lọc rồi mới phát.
- `RESULT`: lưu kết quả một lần, cập nhật nhiệm vụ từ event server, trả/giải phóng chip theo transaction.
- “Chơi tiếp” giữ room và player seats, tạo match mới; “phòng mới” mới được dùng để đổi game.
- “Rời phòng” giữa ván không tự xóa nghĩa vụ chip; chính sách từng game quyết định hủy, chờ hoặc rời sau ván.

### Nhiệm vụ, profile, hết chip

- `/missions` hiển thị nhiệm vụ một lần/ngày, tiến độ server xác nhận, phần thưởng và nút nhận idempotent.
- `/profile` hiển thị tên/avatar, `available`, `reserved`, lịch sử giao dịch và thống kê; không gộp chip xếp hạng The Gang vào ví.
- Hết chip không chặn `/play/casual`; người chơi vẫn chơi The Gang/UNO và làm nhiệm vụ. Kịch tính hiển thị số chip thiếu và đường về nhiệm vụ, không tự cấp chip vô hạn.

### Mất kết nối và reload

- Mất socket: giữ ghế, bài/vai, stack, reservation và deadline; không phát private state cho người khác.
- Reconnect dùng session token gắn với seat; server từ chối nếu seat đang được điều khiển bởi socket khác.
- Reload giữ URL route và session client; gọi `room:resume`, nhận snapshot lọc theo profile.
- Back/forward điều hướng qua router client; route room cũ xác minh lại quyền. Phòng hết hạn chuyển sang lỗi có mã và link về home.
- Hồ sơ chưa tạo: mở wizard tạo profile local trước khi vào game cần identity bền vững; không dùng tên làm khóa.

## 5. Route contract

| Route | Mục đích | Reload | Back/forward | Trạng thái lỗi |
|---|---|---|---|---|
| `/` | Home, join nhanh, tiếp tục phòng | Không mất profile/session local | Trở về home, không tự join lại | Network/offline, session hết hạn |
| `/play/casual` | Danh mục Giải trí | Tải lại danh mục từ registry | Giữ category | Registry lỗi → skeleton rồi retry |
| `/play/thrill` | Danh mục Kịch tính, chip entry | Không tạo reservation khi chỉ xem | Giữ category | Thiếu chip hiển thị rõ |
| `/games/:gameId` | Chi tiết luật/config | Nếu game không tồn tại → 404 mềm | Quay category | `coming_soon` không có CTA tạo |
| `/rooms/:code` | Xác nhận, vào hoặc khôi phục room | Gọi resume/join lại có kiểm tra | Không mất mã mời | Sai mã, hết hạn, đầy, khác game |
| `/missions` | Nhiệm vụ và claim | Đọc lại progress server | Giữ filter | Offline chỉ xem cache, không claim |
| `/profile` | Hồ sơ, ví, lịch sử | Đọc lại wallet/profile | Giữ tab | Chưa tạo → create profile |

`/?room=ABCD` là alias legacy của `/rooms/ABCD`; không xóa ngay trong M1. Khi server chưa hỗ trợ route deep link, Express cần fallback `index.html` trước khi bật các route production; prototype không phụ thuộc backend này.

## 6. Thiết kế UI prototype

File [prototype.html](prototype.html) là bản thiết kế độc lập, mở trực tiếp bằng trình duyệt. Nó có nhãn “Prototype · dữ liệu minh họa”, không gọi network/backend và chỉ mô phỏng:

`home → category → game detail → create room → waiting room`.

Prototype thể hiện trong một shell thống nhất:

- Giải trí: nền xanh đêm, vàng ấm, thẻ mềm, chữ “Chơi cùng bạn bè”.
- Kịch tính: nền than/đỏ rượu, vàng kim, số chip/reservation và nhịp điệu “đấu trí”.
- Mobile portrait: home/category/detail/waiting dùng được, không bắt xoay. Landscape thu gọn header và grid nhưng vẫn giữ CTA.
- Desktop: hai cột hero, danh mục game và panel trạng thái.
- Nút chính có vùng chạm tối thiểu 44px; các trạng thái được minh họa gồm loading, rỗng, lỗi, offline, thiếu chip và game sắp có.

Prototype không mô phỏng bài bí mật, vai ẩn, thanh toán hay kết quả thật; các panel đó chỉ ghi rõ “sẽ do server cung cấp” để tránh biến dữ liệu giả thành hành vi production.

## 7. Mặc định thiết kế để bắt đầu M1

1. Giữ Express/Socket.IO, JavaScript module thuần và UI hiện có; chưa đưa framework mới vào.
2. Tạo `gameRegistry` và adapter The Gang trước khi thêm game mới.
3. Phòng có một game; không đổi game trong phòng.
4. `modeId` The Gang hiện tại được di chuyển thành `ruleVariant/difficulty`, không còn đại diện category.
5. SQLite chỉ bật cùng ví/nhiệm vụ ở M3; trước đó JSON adapter chỉ phục vụ tương thích The Gang.
6. Các game Kịch tính dùng ví local, số nguyên không âm, reservation và ledger; không có tiền thật.
7. Game chưa có engine không được gắn `playable`; không thay bằng dữ liệu giả trong production.

## 8. Quyết định còn mở

- Tên thương hiệu cổng game và icon cuối.
- Cho phép public room listing hay chỉ link/mã trong LAN.
- Cách ghép profile sang thiết bị thứ hai (PIN local, mã QR một lần hay chỉ session).
- Phiên bản luật/variant cụ thể của UNO, BANG!, Tiến lên, Sâm lốc và Phỏm.
- Mức giữ chip tối đa cho từng game và chính sách hủy bàn khi không thể tính cận trên.
- Có cho phép khán giả hay không; mặc định M0 là không.
- Route server-side fallback và chiến lược build asset khi M1 bắt đầu.

Các mục trên không chặn việc dựng platform contract, adapter The Gang và prototype. Chỉ quyết định chúng trước khi bật game hoặc kinh tế tương ứng.
