# B04 — Trang chủ điện thoại

Ngày: 06/10/2026. Phạm vi: sảnh game portal, lối tắt mobile và regression trình duyệt. Không thay backend, luật game, ví hay ledger.

## Hành vi

- Thêm bộ lọc **Tất cả / Giải trí / Kịch tính**, có trạng thái `aria-pressed` và điều hướng tương thích `/play/casual`, `/play/thrill`. Danh mục vẫn lấy game và ID từ `/api/registry`.
- Rút gọn hero và thẻ game trên màn hình nhỏ; ẩn logo hero dư thừa trên điện thoại, giữ mã phòng, tên/avatar, đường chi tiết, trạng thái tiếp tục/rời phòng và các tùy chọn phòng. Đã kiểm tra chiều rộng 320, 390, 844 ngang và desktop 1280, không tràn ngang.
- Thêm **Yêu thích** và **Chơi gần đây**. Tùy chọn nằm trên thiết bị hiện tại ở khóa `chill-thrill:portal-home-preferences`, schema phiên bản 1. Chỉ giữ ID có trong catalog; ID hỏng/lạ được bỏ qua. Danh sách gần đây tối đa 6 game và chỉ cập nhật khi server xác nhận tạo, vào hoặc tiếp tục phòng thành công; mở thẻ, xem luật, hoặc tạo phòng bị từ chối không cập nhật.
- Nút **Tạo phòng** ở thẻ chính và shortcut đưa đến form cấu hình hiện có với `?quick=create`; không gửi lệnh tạo tự động. Form tiếp tục yêu cầu chọn biến thể UNO, mức cược, sức chứa, quyền truy cập và mật khẩu. Cược/giữ lấy từ `stakeRules` của server theo sức chứa; nếu catalog cũ thiếu metadata, giao diện để server xác nhận giới hạn thay vì tự đặt trần.
- Hỏng JSON hoặc bị chặn `localStorage` hiện thông báo; yêu thích vẫn hoạt động trong phiên hiện tại. `app.js` bắt lỗi đọc/ghi storage ở bước khởi tạo profile token để portal vẫn tải được.
- Giữ UNO 112 (`classic-local-v1`) trong shell `/rooms/:code`; UNO 108 (`classic-108-v1`) tiếp tục handoff qua `/uno?room=`. Link cũ `/?room=CODE`, flow mã phòng, hồ sơ tên/avatar, tiếp tục và rời phòng vẫn hoạt động. Selector `data-game-card-action` tiếp tục duy nhất trong danh mục để các browser check cũ dùng được.

## Tệp

- `public/index.html` — khối shortcut/filter và stylesheet mới.
- `public/css/portal-home-mobile.css` — bố cục mobile, thẻ gọn, focus keyboard, trạng thái filter và storage.
- `public/js/portal.js` — lọc/render, preferences phiên bản, recent sau xác nhận server, quick-create vào form, stake preview/validation theo metadata, lưu identity hiện hành.
- `public/js/app.js` — guard nhỏ cho localStorage lúc khởi tạo và nhận profile state.
- `scripts/portal-home-mobile-browser-check.js` — browser regression; lệnh `test:portal-home-mobile` trong `package.json`.
- `test-results/portal-home-B04-20261006.png` — ảnh sảnh ở viewport 390×844, chụp từ browser check.

## Kiểm tra đã chạy

- `npm run test:portal-home-mobile` — **đạt**. Kiểm tra 320×800, 390×844, 844×390, 1280×850; keyboard filter/detail/join; favorite/recent sau reload; bỏ ID không hợp lệ; recent chỉ sau create/join thành công; `/rooms/:code`, `/?room=CODE`, tiếp tục/rời phòng; identity; cả hai UNO; cược/giữ theo giới hạn server; JSON hỏng và storage bị chặn; không có lỗi trang ứng dụng hoặc tràn ngang.
- `npm run test:a05-stakes` — **đạt**; 50, 500 và 10.000 coin ở chi tiết, phòng chờ, bàn và kết quả; cả reservation chip cũ.
- `node scripts/audit-a06-browser-check.js` — **đạt**; hydration tên/avatar, picker, reload, PATCH tên-only, fetch trễ và tạo/vào phòng.
- `npm run test:portal-browser` — **đạt**; QR/UNO, resume/leave, UNO 108 và M4–M6, hồ sơ/ví chung, không lỗi trang.
- `npm test` — **199/199 đạt**.
- `node --check public/js/portal.js`, `public/js/app.js`, `scripts/portal-home-mobile-browser-check.js` và parse `package.json` — **đạt**.

Browser dùng Chrome headless với viewport mô phỏng và server, SQLite, room files ở thư mục tạm. Chưa thử điện thoại vật lý hoặc Wi‑Fi thật. Favorite/recent là tùy chọn local theo trình duyệt, không đồng bộ hồ sơ; nếu storage bị chặn thì danh sách chỉ tồn tại đến khi tải lại trang.
