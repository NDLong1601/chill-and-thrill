# C07 — Kênh khán giả chỉ xem

Ngày: 06/10/2026.

## Đã thêm

- `src/platform/spectatorProjection.js` dựng projection bằng allowlist riêng cho The Gang, UNO 112, UNO 108, Tiến lên, Sâm lốc, Phỏm, Poker và BANG!. Projection không sao chép object state của engine. Mọi seat ID được đổi thành `seat-n`; chỉ chọn mặt bài từ vùng board đã đánh/bỏ/lật công khai. Bài Poker chỉ hiện trong showdown đã kết thúc. BANG! chỉ công khai vai Sheriff, vai đã lộ khi bị loại và toàn bộ vai ở RESULT.
- `src/platform/spectatorService.js` quản lý watcher bằng registry giới hạn theo bàn/toàn server, nối vào channel `spectator:<code>`, dọn khi rời/ngắt kết nối và chặn thao tác game/profile trong lúc socket đang xem. Viewer không được gắn vào room chơi hay `playerRoom`; module không đọc token ghế/hồ sơ và không ghi `socket.data`.
- Hook theo dõi `game_state` gửi tới ghế. Các manager transaction của coin đệm event cho tới commit; Poker dùng `afterCommit`. Hook chỉ dựng/gửi projection khi event đó thực sự được phát và bỏ qua thời điểm `coinTransactionDepth`/`mutationDepth` còn mở. Lỗi snapshot/ledger đã được fault-inject trên manager thật.
- `src/platform/spectatorService.js` cũng cung cấp `attachSpectatorSupport(app, io, gm)`, POST `/api/spectators/:code/state` (không cache, chỉ đọc) và trang `/spectate/:code`. Phòng không tồn tại và sai mật khẩu cùng trả một phản hồi; mật khẩu dùng `verifyPassword` hiện hữu.
- `public/spectator.html`, `public/js/spectator.js`, `public/css/spectator.css` tạo giao diện riêng. Client không nạp profile token, chỉ dùng event `spectator:*`, luôn ghi rõ chế độ chỉ xem; chỉ bàn WAITING mới hướng người xem sang luồng vào ghế thông thường.

## Xác minh

`node --test test/spectatorProjection.test.js test/spectatorService.test.js` — **15/15 đạt**. Bộ này gồm allowlist cho đủ 8 biến thể/game, dữ liệu đánh dấu nằm trong bài/role/token/profile ID và trường tương lai, luật lộ vai BANG!, showdown Poker, thẻ đã công khai, mật khẩu/phòng mời, channel/giới hạn watcher/disconnect, chuyển vai, page/API thật trên server tạm, và rollback snapshot coin/Poker không phát state sai hoặc ghi thêm ledger.

Fixture tích hợp tạo database/phòng trong thư mục tạm của hệ điều hành. Kiểm tra localhost cần chạy ngoài sandbox vì sandbox chặn bind loopback và rename room file tạm.

## Cổng tích hợp

Đã mount `attachSpectatorSupport` một lần trong `src/httpServer.js`, expose `spectators` và đóng service cùng server. Portal có nút “Xem với tư cách khán giả” theo mã phòng; client riêng không dùng token hồ sơ. Các test tích hợp dùng service đã mount trên production server.

## Nghiệm thu product — 06/10/2026 08:55 Asia/Saigon

- Service/projection đạt **17/17**, gồm last-seat leave đóng phòng và tạo phòng thật với cùng mã mà watcher cũ không nhận state mới, rollback coin/Poker không phát state sai và giữ mặt số/ký hiệu công khai của UNO 108.
- `npm run test:spectator-browser` đạt **8/8 bàn** trên production server, Socket.IO và SQLite tạm: The Gang, UNO 112, UNO 108, Tiến lên, Poker, Sâm lốc, Phỏm, BANG!.
- Kiểm tra nút portal, mật khẩu sai/đúng, state sau bắt đầu ván, chặn sáu nhóm thao tác game/profile, không nhận `game_state`, không lộ profile/seat token/bài kín. Đếm hồ sơ, ví, ledger, operation, reservation và match trước/sau xem để chứng minh không tạo dữ liệu người chơi.
- Khán giả của phòng có mật khẩu tự nối lại sau ngắt transport; mật khẩu chỉ giữ trong bộ nhớ của trang, xóa khi rời/phòng đóng. Kiểm tra layout 320/390/844/1280 px, không tràn ngang, không lỗi JavaScript và không request ra ngoài.
- Log: `test-results/resume-c07-product-20261006.log`, `test-results/resume-c07-lifecycle-20261006.log`; ảnh `test-results/spectator-C07-product-mobile.png` đã xem. Sau xem ảnh đã chỉnh logo, tên phase/màu và mặt bài UNO; chạy lại 17/17 và product tám bàn đều đạt.

Điện thoại/WiFi thật chưa được kiểm tra; viewport và ngắt transport ở đây là mô phỏng có kiểm soát.
