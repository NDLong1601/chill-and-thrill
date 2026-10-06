# Triển khai A02 — Poker reconnect

Ngày: 06/10/2026.

Poker chỉ tạm dừng hand khi một ghế còn `inHand`, chưa fold và mất kết nối. Ghế ngồi ngoài và ghế đã fold không giữ hand hoặc đồng hồ ở trạng thái pause. Ghế all-in vẫn cần reconnect cho đến khi hand kết thúc vì còn quyền nhận pot/showdown; khi mọi người còn khả năng hành động đã all-in, engine vẫn tự chạy board và chốt kết quả theo luồng sẵn có.

Điều kiện chờ reconnect hiện được dùng cho bind/resume, kiểm tra thao tác, disconnect, legal actions và đồng hồ Poker. Khi người cần chờ kết nối lại, hand mở tiếp và đồng hồ khôi phục deadline từ thời gian còn lại. Thông báo lỗi nêu tên ghế đang cần kết nối lại.

Tệp đổi trong phạm vi A02:

- `src/games/poker/pokerEngine.js`
- `test/audit-a02-reconnect.test.js`
- `docs/reviews/implementation-A02-20261006.md`

Kiểm thử đã chạy:

- `node --test test/audit-a02-reconnect.test.js test/poker.test.js test/poker.integration.test.js` — 11/11 đạt.
- `npm run test:poker-browser` — đạt.
- `npm test` — 140/147 đạt. Bảy lỗi nằm ngoài A02: sáu kỳ vọng trong `test/review-regressions.test.js` cho hoàn phòng hết hạn/lỗi commit của Tiến lên, Sâm lốc và Phỏm; một kiểm thử nhãn pair legacy trong `test/tienLen.test.js`. Chúng thuộc phạm vi engine/transaction đang được xử lý song song; không có lỗi Poker trong lượt chạy toàn bộ.

Các fixture regression A02 dùng socket, ví và phòng giả trong bộ nhớ. Poker integration tạo database và phòng trong thư mục tạm. Browser smoke test dùng database trong bộ nhớ. Chưa kiểm thử mạng Wi-Fi hoặc thiết bị thật; UI không thay đổi trong phạm vi này.
