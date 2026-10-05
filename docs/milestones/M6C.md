# M6C — BANG! bộ cơ bản

Hoàn thành ngày 05-10-2026.

## Kết quả

Đã thêm BANG! vào nhóm Giải trí như một game độc lập, 4–7 người, không dùng ví
đặt cược. Phòng có QR, mã ghế khôi phục, pause/reconnect/restart, hồ sơ/nhiệm
vụ dùng chung và UI mobile riêng tại `/bang`.

Phạm vi chốt là BANG! Fourth edition: 80 lá, 16 nhân vật và 7 vai; không có
mở rộng. Danh mục, nguồn nhà phát hành, chi tiết luật và các giả định hiển thị
trong [bang.md](../rules/bang.md).

## File chính

- `src/games/bang/bangDeck.js`: danh mục lá/nhân vật/vai và tiện ích rút kiểm tra.
- `src/games/bang/bangEngine.js`: lượt, khoảng cách, hàng đợi phản ứng, vai kín,
  trang bị, chết/thắng, khôi phục snapshot.
- `src/platform/multiGameManager.js`, `src/httpServer.js`, `src/platform/gameRegistry.js`:
  đăng ký game, routing, QR, state đồng bộ.
- `public/bang.html`, `public/js/bang.js`, `public/css/bang.css`: sảnh/bàn chơi.
- `test/bang.test.js`, `test/bang.integration.test.js`, `scripts/bang-browser-check.js`:
  unit, socket/HTTP và kiểm tra giao diện.

## Quyết định đáng chú ý

- Vai chỉ hiện Sheriff, vai của mình, người đã chết hoặc kết quả; bài chỉ có
  trong snapshot của chủ sở hữu. Server không tin giới hạn BANG!, mục tiêu,
  khoảng cách, phản ứng hay lá do browser tự khai.
- Khi có hiệu ứng cần trả lời, room lưu effect ID, người phải trả lời và phần
  chuỗi còn lại. Restart đặt bàn vào pause; chỉ tiếp tục khi mọi người khôi
  phục ghế, nên effect không bị thực hiện lại.
- Ván BANG! hợp lệ được ghi `matchId` một lần cho toàn bộ người chơi, gồm người
  bị loại sớm, đúng định nghĩa nhiệm vụ tham gia trận. Không có giao dịch ví.

## Cách chạy và kiểm tra

`npm start` rồi mở `/bang`; tạo bàn, đủ 4–7 người, sẵn sàng và bắt đầu. Dùng
`npm test` cho toàn bộ test; `npm run test:bang-browser` cho browser smoke test.
Lần bàn giao này đã chạy: `npm test` **85/85 pass**, `npm run test:bang-browser`
**pass**, và `git diff --check` **pass**. Cảnh báo Node 24 rằng `node:sqlite`
đang experimental là không gây lỗi.

## Hạn chế đã biết

Không xác minh thiết bị Wi‑Fi thật trong mốc này. Không có timeout tự động cho
phản ứng hoặc bot, vì các cơ chế đó cần chính sách xử lý bài kín riêng và nằm
ngoài phạm vi M6C.
