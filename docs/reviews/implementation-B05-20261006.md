# B05 — Hướng dẫn tình huống và tutorial được xác minh

Trạng thái: hoàn tất, đã tích hợp store/API/trang hướng dẫn và gợi ý trong bàn của cả tám biến thể; kiểm thử phạm vi B02/B03/B05 đạt.

## Hành vi

- Hướng dẫn 7 game và 2 biến thể UNO; liên kết luật đúng cho từng bản UNO.
- Bài luyện UNO 112 chọn màu Wild, Poker check và Phỏm hạ bộ dùng validator hiện có ở server. Client không tự quyết định đã hoàn tất.
- Phiên có owner, nonce, phiên bản, thứ tự/revision và mã thao tác; sai mục tiêu không chuyển bài. Phiên luyện dở hết hạn sau 15 phút; khởi động lại máy chủ cần bắt đầu lại bài dở.
- Xác minh hoàn thành lưu SQLite theo hồ sơ/phiên bản. Nhận 200 coin một lần, cùng một operation key qua tutorial API và mission API. Không tính vào 3 nhiệm vụ ngày/450 coin; ván thường và mission_progress cũ không thay thế xác minh.
- Thưởng chưa nhận vẫn có thể nhận sau nhiều ngày và restart. Lỗi commit rollback cả biên nhận lẫn coin; A07 vẫn bảo vệ sức chứa thanh toán ván đang chơi.
- Giao diện có lỗi dễ đọc, bắt đầu lại khi phiên hết hạn, trạng thái đã hoàn thành/đã nhận sau reload và mã thao tác chạy trên HTTP LAN.
- Module gợi ý đọc state công khai thực của từng game, không suy từ tay bài đối thủ. Hai UNO dùng trường/action khác nhau; gợi ý UNO 112 được giới hạn theo availableActions của server.

## Bằng chứng hiện tại

- `node --test test/contextHelp.test.js test/tutorial-integration-b05.test.js test/tutorialService.test.js test/profile-history.test.js test/currency-exchange-b03.test.js test/profileStore.test.js`: 40/40 đạt, gồm 14 context checks trên state thực của tám biến thể.
- `node scripts/tutorial-browser-check.js`: đạt trên server thực/SQLite tạm, xác thực, lỗi/retry, hết hạn/bắt đầu lại, thao tác sai/đúng, xác minh, reload trước nhận, nhận một lần, reload sau nhận, liên kết luật và viewport 320/390/844/1280. Đã xem ảnh `test-results/tutorial-B05-mobile-20261006.png`, sửa hidden link bị CSS ghi đè và chạy lại đạt.
- `node scripts/context-help-browser-check.js`: đạt trên cả 8 bàn thực, gợi ý theo pha, liên kết mở đúng biến thể, panel 320/390/844/1280 và trạng thái UNO 112 tạm dừng khi host ngắt kết nối. HTML đã nối sau khi A03 nhả phạm vi append-only. Resolver đọc reconnect.waiting thực khi UNO 112 không có trường paused trực tiếp.
- Npm scripts: `test:tutorial-browser`, `test:context-help-browser`. Trang hồ sơ/portal dẫn tới bài luyện khi nhiệm vụ chưa hoàn tất; hướng dẫn có thể truy cập khi chưa xác thực nhưng phần lưu tiến độ cần hồ sơ.

Không sửa dữ liệu người chơi thật; không commit/push/deploy. Full suite sau A03/A04 vẫn là cổng tích hợp riêng, chưa báo toàn dự án đạt.
