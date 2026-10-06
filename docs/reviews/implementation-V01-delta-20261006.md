# V01 — Kiểm tra thay đổi sau nghiệm thu

Chốt lúc 11:06 ngày 06/10/2026, Asia/Saigon (04:06 UTC). Trạng thái: **đạt kiểm tra các thay đổi giao diện và điều hướng mới**. 21 hạng mục audit đã hoàn tất ở các chat riêng; lượt này không tạo chat tính năng trùng.

So với danh mục SHA-256 lúc 10:13, chỉ bốn tệp sản phẩm đổi: `public/css/shared-ui.css`, `public/css/table-shell.css`, `public/js/game-session.js`, `public/js/portal.js`. Thay đổi bổ sung đồng bộ màu màn tạo/chờ phòng, tăng độ rõ của ghế/bài và đưa người rời bàn mở từ portal về sảnh. Backend và các Node test không đổi sau log full Node 448/448; checksum log vẫn khớp. **448/448 là bằng chứng được giữ lại, không phải lần chạy mới trong lượt này.**

## Lỗi tìm được và sửa

`resumeRoom()` điều hướng trực tiếp tới bàn mà thiếu `returnTo=portal`. Vì vậy, “Tiếp tục phòng” rồi rời bàn vẫn về màn tạo phòng của game. Đã bổ sung đích quay về sảnh trong `public/js/portal.js`; regression tái hiện thất bại trước sửa và đạt sau sửa trên cả sáu bàn độc lập: UNO108, Tiến lên, Poker, Sâm lốc, Phỏm, BANG!.

`scripts/portal-browser-check.js` được mở rộng để kiểm tra create/reload/leave, resume/handoff/leave và rời phòng đã lưu từ portal. Kiểm tra một ghế sau handoff, phòng đã đóng và xóa thông tin ghế/Continue sau rời. Các kiểm tra ví chung, hai UNO và chuyển game vẫn được giữ.

`scripts/shared-ui-browser-check.js` cập nhật kỳ vọng sau khi rời bàn mở từ portal: về sảnh. Kiểm tra `returnTo` trước/sau reload, xóa thông tin ghế, số người trong phòng giảm đúng; đường vào trực tiếp UNO legacy vẫn về màn game cũ. Các kiểm tra mật khẩu, QR, xoay màn hình và link khác game giữ nguyên.

## Bằng chứng mới

**14 bộ browser đạt**, exit code 0; đều dùng bộ nhớ hoặc thư mục tạm. Danh mục log, script và SHA-256 nguồn tại [product-audit-delta-20261006.json](../../test-results/product-audit-delta-20261006.json).

| Kiểm tra | Kết quả và log |
|---|---|
| Portal mở rộng | Đủ sáu bàn create/resume/reload/leave, xóa thông tin ghế, một ví chung; `delta-portal-resume-fixed-20261006.log` |
| Shared UI | Tám target protected join/retry/reload/leave, link legacy/cross-game; `delta-shared-ui-repaired-20261006.log` |
| Bàn nhiều người và hai ván | Tiến lên/Sâm/Phỏm/Poker, desktop và landscape, không chồng ghế hoặc che bài; `delta-thrill-flow-20261006.log` |
| Tùy chọn bàn | Cả tám target, 320/390/844/1280 px, reload; `delta-preferences-product-20261006.log` |
| Hướng dẫn tình huống | Cả tám target và mobile; `delta-context-help-20261006.log` |
| Continue và cập nhật bàn | Handoff, đồng hồ, hành động, ván tiếp; `delta-table-updates-20261006.log` |
| Sáu game độc lập | UNO108, Tiến lên, Poker, Sâm, Phỏm, BANG!; sáu log `delta-{uno108,tien-len,poker,sam-loc,phom,bang}-20261006.log` |
| Trang chủ mobile và identity | Favorites/recent, hai UNO, resume/leave, avatar/name và fetch race; `delta-home-mobile-20261006.log`, `delta-identity-20261006.log` |

Đã xem ảnh mới `thrill-tien-len-desktop.png`, `thrill-phom-4-players.png` và `ui-poker-waiting-desktop.png`. Bộ shared UI thất bại đầu do kỳ vọng cũ (`delta-shared-ui-20261006.log`); bộ portal mở rộng thất bại trước sửa resume (`delta-portal-expanded-20261006.log`). Giữ cả hai log và ghi rõ bản đạt thay thế; không tính log thất bại là đạt.

Các giới hạn nghiệm thu môi trường vẫn còn: chưa dùng điện thoại/WiFi thật, chưa nhấp đúp launcher qua UI, chưa kiểm tra tải theo mục tiêu số phòng. Không sửa dữ liệu người chơi, tỷ lệ tài sản, cấu hình hệ thống hoặc lịch automation; không commit/push/deploy.
