# B02 — Ví và lịch sử chung

Ngày: 06/10/2026. Triển khai trong chat B02, kiểm tra bổ sung bởi điều phối automation.

## Hành vi

- Trang `/history`, mở từ `/profile`, tìm giao dịch và ván đã hoàn thành của chính hồ sơ đang đăng nhập. API `/api/history` xác thực bằng token trong header; không nhận `profileId` làm bộ chọn chủ dữ liệu.
- Biên nhận gom theo operation và tiền tệ, hiện riêng biến động khả dụng, đang giữ và tổng tài sản. Chuyển vào/hoàn khoản giữ có tổng thay đổi bằng 0; cash-out Poker hiện chênh lệch stack so với phần đã giữ, không cộng stack lại vào tổng.
- Một lần quy đổi có cả coin và gem trong cùng biên nhận. Gửi lại claim/exchange không tạo giao dịch lịch sử thứ hai. Lịch sử ván giải trí vẫn có dù ván không đổi ví.
- Lọc theo game, khoảng ngày Việt Nam, mã phòng, nhóm giao dịch và tiền tệ; phân trang theo timestamp/type/reference ổn định, không mất hoặc lặp hàng có cùng thời điểm. Giới hạn 50 sự kiện mỗi trang và tối đa 366 ngày khi có hai biên ngày. Lọc tiền tệ áp dụng cho giao dịch ví, kết quả ván không có đơn vị thì chọn tất cả tiền tệ để xem.
- Metadata mã phòng/biến thể ở kết quả đọc từ snapshot lúc chốt ván, giữ đúng khi phòng đã xóa hoặc mã được tái sử dụng. UNO cũ thiếu bằng chứng hiện “Biến thể UNO chưa lưu”. Tiền cược/pot chỉ có nhãn chip/coin/gem khi kết quả đã lưu đơn vị; dữ liệu cũ thiếu đơn vị ghi rõ, không suy coin từ tên game.
- API chỉ trả allowlist kết quả công khai và các delta của chủ hồ sơ. Không trả private hand, role kín, token, hash, wallet payload hoặc state JSON. UI dùng `textContent`; các trường server chưa đủ dữ liệu có fallback.
- Trang hồ sơ hiện các delta rõ ràng cho mọi tiền tệ, có link lịch sử, guard storage và tiếp tục đọc token legacy `gang.profileToken`. Trang lịch sử có loading, empty, lỗi và thử lại; query bộ lọc mới thay thế phản hồi cũ đang tới chậm, còn tải thêm không chạy trùng.

## Tệp

- `src/platform/profileStore.js`: truy vấn lịch sử, cursor/filters, public result projection và metadata match bất biến.
- `src/platform/profileService.js`, `src/httpServer.js`: facade tương thích, route `/history` và API được xác thực.
- `public/history.html`, `public/js/history.js`, `public/css/history.css`: trang lịch sử.
- `public/profile.html`, `public/js/profile.js`, `public/css/profile.css`: link và các delta gần đây.
- `test/profile-history.test.js`, `scripts/profile-history-browser-check.js`: các regression.
- `test-results/history-B02-mobile-20261006.png`: ảnh đã xem ở 390px.

Không thay tỷ lệ quy đổi, luật thanh toán hoặc dữ liệu thật. Tất cả fixture sử dụng bộ nhớ hoặc SQLite/phòng trong thư mục tạm.

## Kiểm tra

- `node --test test/profile-history.test.js test/currency-exchange-b03.test.js test/audit-a07.test.js`: **30/30 đạt** ở lần cuối. Riêng B02 có 6 ca tổng hợp, gồm hold/settlement/refund/Poker/exchange/claim, casual match, timestamp trùng, metadata bất biến, đơn vị chip cũ, ngày Việt Nam, bounds và quyền truy cập.
- `node scripts/profile-history-browser-check.js`: **đạt**, không page error. Profile deltas, quyền sở hữu, XSS, hold/refund/exchange, đơn vị chip, lọc game/ngày/phòng/nhóm/tiền tệ, 31 kết quả trùng thời điểm qua hai trang, phản hồi cũ đến chậm, retry sau lỗi, guest/storage bị chặn. Layout 320×740, 390×844, 844×390, 1280×900 không tràn ngang.
- `node scripts/currency-wallet-browser-check.js`: **đạt**, portal/profile ở mobile và desktop, kể cả mất phản hồi rồi gửi lại.
- `node scripts/profile-browser-check.js`: **đạt**, tạo và cập nhật hồ sơ.
- `npm test` lúc A03 vẫn đang sửa vòng đời phiên: **209/221**, 12 lỗi thuộc leave/expiry/clock của game. Log `test-results/b02-full-node-20261006.log` đã chuyển cho A03/điều phối trước. Đây chưa phải cổng tích hợp toàn dự án đạt; cần chạy lại sau A03 ổn định. Các kiểm tra B02/B03/A07 phía trên đều đạt.

Các lỗi bắt được và đã xử lý: request đang tải bỏ qua bộ lọc mới; projection bỏ mất đơn vị tiền của kết quả; fixture dùng hàng bootstrap đầu tiên dù chip/coin có cùng timestamp và thứ tự UUID không cố định. Browser fixture token bỏ qua trang `about:blank` không có origin; không bỏ qua lỗi trang ứng dụng.

## Giới hạn

“Nhóm” hiện là nhóm giao dịch/phòng; lobby nhóm C01 chưa được triển khai. Lịch sử chỉ có các sự kiện đã được server lưu, không dựng lại dữ liệu thiếu của ván cũ. Đã kiểm tra Chrome headless và viewport mô phỏng; chưa thử điện thoại vật lý hoặc Wi-Fi thật. Toàn bộ fixture browser dùng SQLite/phòng tạm; không dùng dữ liệu người chơi thật.
