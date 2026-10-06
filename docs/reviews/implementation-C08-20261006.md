# C08 — Giải đấu và bảng xếp hạng nhóm

Ngày: 06/10/2026.

## Đã triển khai

- `src/platform/groupTournamentService.js` lưu giải, vòng đấu, liên kết trận và kết quả tính điểm trong bảng ứng dụng `group_tournament_records` của SQLite `ProfileStore` hiện có. Phần này không tạo ví tiền riêng, không ghi chip/ledger và không nhận kết quả do trình duyệt gửi lên.
- Quyền truy cập được kiểm tra qua snapshot nhóm đáng tin cậy của C01. Chủ nhóm tạo, bắt đầu và đóng giải; danh sách người chơi được khóa khi giải chạy. Người chơi và ghế được liên kết bằng profile ID, không dùng guest ID làm danh tính tính điểm.
- Chỉ kết quả trận đã commit mới được tính. UNO dùng danh sách người tham gia bất biến của snapshot kết quả; các trò chơi khác cũng đối chiếu kết quả commit với roster đã đăng ký. Giao nhận trùng không cộng điểm lần hai.
- Cách tính điểm: giải đối kháng dùng Thắng/Hòa/Thua = 3/1/0; The Gang dùng kết quả hợp tác chung +2 mỗi người khi thành công và 0 khi thất bại. Giải UNO giữ hai variant `classic-local-v1` và `classic-108-v1`; trò chơi không phải UNO dùng variant chuẩn `standard`. Mã phiên bản luật được lưu riêng với variant.
- `src/platform/groupTournamentLifecycle.js` nối ý định STARTING bền vững trước lệnh bắt đầu, liên kết match ID sau khi manager bắt đầu và snapshot nhóm được xác minh, xử lý callback hoàn tất đến sớm, phục hồi sau restart, và hủy không điểm sau reset do server xác nhận. Khóa bắt đầu trong tiến trình ngăn roster đổi trong lúc xác minh bất đồng bộ; hook lifecycle chạy ngoài khóa C01.
- `src/platform/groupTournamentRoutes.js` cung cấp API xác thực để xem luật, danh sách và chi tiết giải, tạo giải, bắt đầu và đóng giải. Không có API gửi kết quả/điểm từ client.
- `public/groups/tournament.html` và `public/js/group-tournament.js` cung cấp giao diện tiếng Việt cho giải, tiến độ, bảng xếp hạng và thao tác của chủ nhóm. Trạng thái STARTING/SUSPENDED và nhãn Thắng/Hòa/Thua được hiển thị dễ hiểu.

## Xác minh

- C08 service, routes, backup, lifecycle, hủy trên manager production và vòng kế tiếp UNO 112 qua Socket.IO: **21/21 đạt**, không bỏ qua hay lỗi. Log: `test-results/final-c08-scoped-20261006.log`.
- Kiểm tra product trên server production với nhóm/chủ nhóm, khóa roster, kết quả Socket.IO hợp lệ, tự ghi đúng một kết quả, lịch sử sau restart và bốn kích thước viewport: đạt. Không phát hiện thay đổi ledger hoặc lỗi trang. Log: `test-results/resume-c08-product-20261006.log`; ảnh: `test-results/group-tournament-C08-product-mobile.png`.
- Bộ kiểm tra toàn dự án: **448/448 đạt**, không bỏ qua hay lỗi. Log: `test-results/final-full-node-20261006.log`.
- `node --check public/js/group-tournament.js` thành công. Chạy lại nhóm service/backup/lifecycle tại lượt bàn giao: **17/17 đạt**.

## Phạm vi và giới hạn

Kiểm tra viewport và phiên Socket.IO được thực hiện tự động trên môi trường cục bộ; chưa kiểm tra trên điện thoại hoặc nhiều thiết bị thật. Bản báo cáo này chỉ ghi lại kết quả kiểm chứng hiện có; không bao gồm deploy hay thay đổi dữ liệu người chơi.
