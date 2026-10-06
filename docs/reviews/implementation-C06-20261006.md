# C06 — Launcher Windows một lần bấm

Ngày: 06/10/2026. Phạm vi: thêm launcher độc lập; không sửa package aliases hoặc tệp server/UI dùng chung.

## Đã thêm

- `launch-chill-and-thrill.cmd` mở PowerShell helper ẩn; helper mở Node launcher ẩn và trình duyệt hiển thị. Cửa sổ launcher có start/stop, trạng thái, địa chỉ IPv4, QR, vị trí file dữ liệu, mở thư mục, backup và restore.
- `src/platform/launcherLifecycle.js` quản lý riêng một child process qua IPC. Start lặp khi đang khởi động bị từ chối; yêu cầu start khi đã chạy trả trạng thái `alreadyRunning`. Stop chỉ được xác nhận sau cả ACK `game.close()` và sự kiện child exit. Timeout hiển thị lỗi, giữ process để thử lại và không gọi `kill`/`taskkill`.
- `scripts/launcher-game-child.js` tạo game server bằng `createGameServer()`, ưu tiên `GANG_DATABASE_FILE`, alias `GANG_DB_FILE`, rồi đường dẫn mặc định; đọc `GANG_DATA_FILE` cho JSON phòng. Process con đóng server và SQLite qua IPC. Cổng game bind như server LAN hiện tại; lỗi cổng bận được trả về UI mà không dừng process bên ngoài.
- `src/platform/launcherControlServer.js` và `scripts/launcher-control.js` phục vụ bảng điều khiển chỉ trên `127.0.0.1`. Phiên chủ máy cần capability ngẫu nhiên dùng một lần, đổi thành cookie `HttpOnly`/`SameSite=Strict` và CSRF token. Secret không nằm trong query string; giao diện admin C05 chỉ nhận liên kết `/admin` và tiếp tục yêu cầu `CHILL_ADMIN_SECRET` riêng.
- UI liệt kê thư mục SQLite, file phòng và manager JSON; nút mở thư mục dùng File Explorer. Backup gọi C04 sau khi tiến trình launcher đã đóng sạch/thoát; restore gọi C04 và tạo thư mục mới, không thay dữ liệu đang dùng.
- `scripts/fixtures/launcher-child-fixture.js` và `test/launcherLifecycle.test.js` kiểm thử tiến trình fixture, không tự động nạp game server.
- Runbook cho vận hành ở `docs/runbooks/launcher-c06.md`.

## Kiểm tra đã chạy

| Lệnh | Kết quả | Phạm vi |
|---|---|---|
| `node --test test/launcherLifecycle.test.js` | 6/6 đạt | Start đồng thời/already-running, ACK + exit, xung đột cổng fixture, stop timeout/retry, capability/session/CSRF, C04 backup/restore trong temp và từ chối backup chưa dừng an toàn |
| `node scripts/launcher-ui-check.js` | Đạt sau chỉnh logo | Playwright desktop + 390×844 mobile; QR/IP, đường dẫn, start/stop, backup/restore, mở thư mục, admin link, logo không tràn, không có page error; API được mock và không mở socket |
| `node --check` trên launcher modules, runner, UI JS và test | Đạt | Cú pháp JavaScript |
| Windows PowerShell Parser trên `scripts/launcher-start.ps1` | Đạt | Cú pháp PowerShell; không chạy helper hoặc mở server |
| `scripts/launcher-product-check.js` (coordinator QA) | Đạt theo `test-results/automation-c06-product-20261006.log` | Game child thật với `PORT=0` và SQLite/room files trong temp; stop khi socket đang kết nối, backup C04, restore thư mục mới, restart và xác minh token/ghế/ledger/holds; không dùng data production |
| `scripts/launcher-control-product-check.js` (coordinator QA) | Đạt theo `test-results/automation-c06-control-product-20261006.log` | Chrome → control HTTP loopback → child thật trên temp; capability/cookie/refresh, QR PNG, backup chờ ACK + exit khi server chạy, restore mới, mở folder whitelist, viewport 320/390/844 và 0 lỗi trang |

Test C04 của suite tạo SQLite/JSON trong `%TEMP%`, xác minh manifest/checksum, giữ nguyên hash và inventory nguồn, rồi phục hồi sang folder mới. Product checks tích hợp của coordinator chạy code game thật nhưng chỉ với `PORT=0`, `GANG_DATA_FILE` và `GANG_DATABASE_FILE` trỏ tới temp; không dùng database hoặc room file người chơi.

## Giới hạn và tích hợp

- Sandbox từ chối kết nối TCP loopback bằng `EACCES`; lifecycle suite vì vậy kiểm tra handler bằng HTTP request/response harness gọi trực tiếp. Coordinator product check riêng đã vượt qua luồng browser → control HTTP → child trên dữ liệu temp ở môi trường tích hợp.
- Chưa nhấp đúp `.cmd` hoặc thử QR trên mạng thật. Headless browser kiểm tra layout/các thao tác ở desktop và viewport 320/390/844, nhưng không xác nhận cửa sổ PowerShell ẩn, Windows Firewall, router hoặc điện thoại thật.
- C06 link `/admin` không chứa secret. Router C05 đã được mount; browser check xác minh đích `/admin`, nhưng không tự nhập secret hoặc kiểm thử phiên đăng nhập C05.
- Không sửa `package.json`, `server.js`, `src/httpServer.js`, API admin C05, cơ sở dữ liệu sản phẩm, các game/room/profile/UNO hoặc các thay đổi đã có trong working tree.
