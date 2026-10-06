# A04 — Trạng thái lưu trữ và cổng an toàn cược

Ngày: 06/10/2026. Trạng thái: **hoàn tất, tích hợp và nghiệm thu tại coordinator**.

## Hành vi

- Collector ghi nhận read/write/commit/export tại điểm thực của ProfileStore và mọi manager, gồm hai UNO. Giữ thời gian thử/thành công/lỗi, stage và mã lỗi đã lọc; không xuất exception text, đường dẫn, hồ sơ, token hoặc bài kín.
- API `/api/storage/status` giữ `scope/database/schemaVersion/integrity/error`, thêm `sources/warnings/failures/canStartWager/blockedReason/heldAudit`. SQLite integrity không bị báo hỏng chỉ vì JSON export thất bại.
- Snapshot SQLite là authority của Tiến lên/Sâm/Phỏm/Poker; lỗi export hoặc đọc legacy JSON là cảnh báo khi SQL còn an toàn. JSON của Gang/UNO 112, UNO 108 và BANG vẫn được theo dõi trực tiếp; đọc hỏng được giữ nguyên để tránh ghi đè.
- Ván cược mới/buy-in kiểm tra lại health, cờ lỗi manager và HELD ngay trước mutation, kể cả chưa có GET status. Lỗi authoritative commit/write chỉ gỡ sau thành công tương ứng; lỗi đọc cần probe/parse được xác minh. Refund/settlement/cash-out vẫn được phép khi an toàn trong transaction.
- Đối soát HELD chỉ đọc: kế thừa A01 cho ba game coin; kiểm tra Poker bằng reservation ID/profile/amount trong snapshot ghế đã commit, không phụ thuộc hand ID hiện tại. HELD mất liên kết hoặc không nhận diện được chặn cược mới; không tự hoàn tiền hoặc sửa nguồn.
- Cảnh báo tiếng Việt trong profile và portal/bàn, phân biệt lỗi chặn cược với cảnh báo export. `storage-warning.js` nối module hiện có, cập nhật khi tải/kết nối/quay lại trang và định kỳ; không thay luật hoặc bật/tắt handler game ở client.

## Bằng chứng

- `node --test test/audit-a04-product.test.js test/storageDiagnostics.test.js test/storageDiagnostics.store.test.js`: **31/31 đạt**. Bao gồm lỗi rename riêng từng manager/export, JSON hỏng, timestamp, chỉ thành công cùng operation mới gỡ, API không lộ private data, direct gate không cần GET, rollback commit, refund/cash-out khi gate lỗi, Poker orphan và Poker hold hợp lệ qua hand ID khác.
- `node scripts/audit-a04-browser-check.js`: **đạt** trên SQLite/phòng tạm. Profile/native warning ở 320/390/844/1280; lỗi Phỏm chặn start Tiến lên thực, không giữ coin, khôi phục cho start và giữ đúng 100 coin/người; không page error. Đã xem `test-results/storage-A04-profile-mobile-20261006.png`.
- `npm test`: **313/313 đạt, 0 skip** tại checkpoint sau A04; log `test-results/automation-a04-integrated-full-20261006.log`. Các feature tiếp theo vẫn cần cổng kiểm tra riêng.
- A03 lifecycle browser và portal browser đã đạt sau phần tích hợp storage ban đầu, log `automation-a03-after-storage-browser-20261006.log` và `automation-portal-after-storage-browser-20261006.log` trong `test-results`.

## Phạm vi vận hành

Read lỗi trên nguồn recovery cần sửa/kiểm tra và khởi động lại an toàn; không tự thay thế nguồn hỏng bằng dữ liệu rỗng. API là diagnostics công khai đã lọc, công cụ admin/backup thuộc C05/C04 riêng. Kiểm tra trình duyệt là Chrome headless/viewport mô phỏng; chưa thử điện thoại hoặc WiFi thật.

Chat A04 có trạng thái chờ approval; coordinator đã thực hiện các sửa bổ sung và kiểm thử được người dùng yêu cầu bằng tool local hiện có, không thay thiết lập quyền. Không có bằng chứng auto-review rejection được công bố trong trạng thái đọc được. Không commit/push/deploy hoặc thay dữ liệu người chơi thật. Backend đã nhả cho B01; coordinator giữ report/queue/memory.
