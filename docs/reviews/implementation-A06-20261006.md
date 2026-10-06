# Hoàn tất A06 — identity portal

Ngày: 06/10/2026.

Portal lấy tên và avatar từ hồ sơ server vào các bộ chọn identity, gồm cả picker hồ sơ và picker phòng The Gang. Tên/avatar được đánh dấu riêng khi người chơi sửa; PATCH chỉ gửi các trường đã sửa. Các lần lưu chạy tuần tự, còn phản hồi GET/PATCH cũ không thể thay lựa chọn mới trên giao diện. Trước khi có token, các chỉnh sửa được giữ để gửi trong lần tạo hồ sơ; hàng đợi lưu không chạy khi chưa có token.

Sửa tên không gửi avatar. Tạo hồ sơ/phòng, tải lại trang, vào phòng và quay về portal giữ avatar hồ sơ. Tên và avatar người chơi đang sửa cũng được giữ khi fetch hồ sơ cũ trả về trễ.

## Tệp

- `public/js/portal.js` — hydrate identity từ hồ sơ, lưu PATCH theo trường đã sửa, tuần tự hóa cập nhật và bỏ qua phản hồi cũ.
- `scripts/audit-a06-browser-check.js` — regression trình duyệt A06, server `ProfileStore` và phòng chỉ dùng bộ nhớ.

## Kiểm tra

- `node scripts/audit-a06-browser-check.js` — đạt: hồ sơ mới không token, chọn avatar 🥷 và tạo phòng; hồ sơ có avatar 🥷 tải lại; đổi tên chỉ PATCH tên; fetch chậm không ghi đè tên/avatar mới; tạo phòng, vào phòng và trở về portal; không có lỗi JavaScript trang.
- `node scripts/portal-browser-check.js` — đạt: UNO LAN/QR, sẵn sàng, hành động, tải lại, rời phòng, chuyển game UNO 108 và M4–M6, hồ sơ/ví dùng chung; không có lỗi JavaScript trang.
- `node --check public/js/portal.js` và `node --check scripts/audit-a06-browser-check.js` — đạt.

Browser chạy Chrome headless với viewport mô phỏng; chưa kiểm tra điện thoại vật lý hoặc mạng WiFi thực tế. Không chạy toàn bộ `npm test` trong lượt A06.
