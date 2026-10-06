# C05 — Bảng điều khiển chủ máy LAN

Ngày: 06/10/2026. Trạng thái: **HOÀN TẤT tích hợp và QA trên dữ liệu tạm**. Đã mount vào `createGameServer`, kiểm tra gate tám biến thể và thao tác trên bàn đang chơi bằng Socket.IO/HTTP thật; trang admin cũng được kiểm tra bằng trình duyệt với API thật.

## Phần đã chuẩn bị

- `src/platform/adminService.js` xác thực secret cấu hình tối thiểu 32 byte bằng SHA-256 digest và `timingSafeEqual`. Secret không được nhận qua query string, profile token, cookie hay public bootstrap.
- `src/platform/adminRouter.js` cung cấp API quản trị riêng: `GET /status`, `GET /network-qr/:index.svg`, `POST /maintenance`. API chỉ chấp nhận kết nối loopback và Bearer secret; thay đổi maintenance bắt buộc có `Origin` cùng origin. Phản hồi có `Cache-Control: no-store`.
- Status lấy storage bằng `getStatus({ ignorePending: true })`; API projection chỉ trả loại/schema/integrity, cảnh báo đã lọc và số liệu tổng hợp của đối soát. Phòng được allowlist thành mã phòng, game/variant, phase, số người/ghế đang kết nối, giới hạn ghế và visibility. Không trả token, profile ID, password hash, socket ID, số dư, bài hoặc trạng thái kín. QR được dựng server-side từ địa chỉ nội bộ đã xác minh; không cần dịch vụ ngoài.
- Maintenance gate chỉ bọc `createRoom` ở các entrypoint được truyền vào installer. Các lời gọi khác như join, resume, recovery, action, settlement và leave được giữ nguyên. Thao tác có operation ID để chống gửi lặp; server tạo action receipt. Bảng không mở công cụ cấp, sửa hay xóa tiền, nên hiện không có endpoint tài chính cần receipt.
- `public/admin.html`, `public/css/admin.css`, `public/js/admin.js` tạo trang responsive tại `/admin.html`. Secret chỉ nằm trong biến của trang khi đang mở, không lưu local/session storage; fetch bỏ credentials/cookie và chỉ gọi API cùng origin. Giao diện hiển thị IP/QR, phòng, số kết nối, storage, maintenance và action receipts.
- Không thêm nút backup/restore live. Runbook C04 yêu cầu dừng server và công cụ không có quiesce gate.

## Tích hợp server

`src/httpServer.js` khởi tạo `AdminService` sau khi đã có `gm`, `io`, `diagnostics` và hàm `port()`. Router được mount ở `/api/admin`; UI có thêm alias `/admin` bên cạnh `/admin.html`. Maintenance gate bọc cả `gm.createRoom` và `roomService.createRoom`, và được tháo trước khi manager đóng:

```js
const { AdminService } = require('./platform/adminService');
const { createAdminRouter } = require('./platform/adminRouter');

const adminService = new AdminService({
  adminSecret: process.env.CHILL_ADMIN_SECRET,
  gm,
  io,
  storageDiagnostics: diagnostics,
  getNetworkAddresses: () => networkUrls(port()),
});
const restoreAdminCreateGate = adminService.installRoomCreationGate([
  { target: gm, method: 'createRoom' },
  { target: roomService, method: 'createRoom' },
]);
app.use('/api/admin', createAdminRouter(adminService));
```

Trang có thể mở bằng `http://localhost:<port>/admin` hoặc `/admin.html` trên chính máy chủ. API từ máy khác trong LAN trả 404; người chơi khác vẫn quét QR tới địa chỉ LAN để vào portal.

Biến cấu hình canonical, đồng bộ với launcher C06 là `CHILL_ADMIN_SECRET`; option module là `adminSecret`. Sinh giá trị mạnh bên ngoài repo, ví dụ `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`, rồi cấu hình secret trong môi trường của tiến trình trước khi chạy server. Nếu thiếu hoặc dưới 32 byte thì mọi API quản trị từ chối xác thực, maintenance mặc định tắt. Không lưu secret trong source, URL, HTML hay profile storage.

## Kiểm tra

- `node --test test/adminService.test.js test/adminRouter.integration.test.js` — **10/10 đạt** trong QA loopback thông thường của coordinator (`test-results/automation-c05-node-20261006.log`). Các ca gồm auth/query token, local-only, same-origin, replay/conflict, QR, không có route tiền, allowlist/private data, storage `ignorePending`, và bảo toàn luồng phòng đang chạy khi gate chỉ chặn create.
- `test/adminServer.integration.test.js` — thêm hai bài kiểm tra server Socket.IO/HTTP thật với SQLite và các file phòng riêng trong thư mục tạm. Bao phủ tám biến thể, entrypoint legacy và `RoomService`, auth/origin/query/QR, không bootstrap ví khi create bị chặn, maintenance tắt sau restart, join/resume/action/settlement/leave trên bàn đang chạy, và ledger không đổi khi bật maintenance. Bài Tiến lên chỉ ép hình dạng tay cuối trong fixture tạm; action thắng và settlement vẫn đi qua manager thật.
- `node scripts/admin-lan-browser-check.js` — **đạt** trên viewport 320×740, 390×844, 844×390 và 1280×900 (`test-results/automation-c05-browser-20261006.log`); maintenance receipt cập nhật đúng, không tràn ngang, không page error, không có request ngoài.
- `node --check` cho hai module, hai test, JS giao diện và browser harness — đạt.
- Coordinator chạy `node --test test/adminService.test.js test/adminRouter.integration.test.js test/adminServer.integration.test.js`: **12/12 đạt**, không skip (`test-results/automation-c05-product-20261006.log`). Fixture chờ host ready trước khi gửi guest ready, rồi vẫn yêu cầu tất cả ready trước start. Sau settlement, test đối chiếu từng reservation SQL `SETTLED` và coin reserved bằng 0; receipt lịch sử của phòng được giữ đúng.
- `node scripts/admin-product-browser-check.js`: **đạt** với server, QR và Socket.IO thật (`test-results/automation-c05-product-browser-20261006.log`). Profile token bị từ chối; owner secret mở dashboard; QR nội bộ render; phòng invite chỉ hiện metadata; bật maintenance có receipt, create bị chặn nhưng join phòng cũ được; tắt maintenance/sign-out/xóa secret, bốn viewport và không page error. Receipt UUID thật từng làm tràn trang ở 320px; CSS đã cho metadata xuống dòng, test dùng biên nhận thật đã đạt. Screenshot `test-results/admin-C05-product-20261006.png`.
- Trong sandbox của chat này, service unit đạt 6/6 và browser check chạy được; HTTP/router và server socket tests không kết nối loopback, nhận `EACCES 127.0.0.1`, còn ghi room JSON tạm nhận `EPERM` khi rename. Không đổi approval policy hoặc chạy lệnh ngoài sandbox.
- Full suite cuối thuộc V01 sau khi các tính năng còn lại tích hợp và nhả file. Không coi các checkpoint scoped này là nghiệm thu toàn audit.

Tất cả fixture dùng bộ nhớ hoặc SQLite/room files tạm và listener loopback ephemeral; không mở dữ liệu người chơi. Backend đã nhả cho C01; không commit/push/deploy. Điện thoại, QR scan và WiFi thật chưa được kiểm tra.
