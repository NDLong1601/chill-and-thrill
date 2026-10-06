# C04 — Backup và restore độc lập

Ngày: 06/10/2026. Trạng thái: **module/CLI/runbook độc lập hoàn tất**; chưa tích hợp UI C05 hoặc live quiesce gate. Không sửa file product/package có sẵn, không commit/push/deploy và không đổi queue/memory.

## Đã làm

- Thêm `src/platform/backupRestore.js` với bundle format v1, manifest hoàn chỉnh, SHA-256/kích thước từng file, kiểm tra inventory, path traversal, symlink/junction, overlap, đích đã tồn tại và archive partial.
- SQLite nguồn chỉ được mở read-only. `VACUUM INTO` tạo bản SQLite độc lập, gồm các giao dịch đã commit trong WAL nếu có; tool kiểm tra schema ProfileStore v4, `integrity_check`, `foreign_key_check`, ví/ledger/reservations, room/snapshot references và Poker stack/holds trước khi publish. Không migration hay đóng manager trên nguồn.
- Bundle gồm ProfileStore chung và bảy JSON manager: Gang/UNO 112, UNO 108, Tiến lên, Poker, Sâm lốc, Phỏm và BANG!. JSON authoritative Gang/UNO 112, UNO 108 và BANG! phải parse được. JSON export A01/Poker có thể cũ/hỏng nếu snapshot SQLite authority hợp lệ; manifest ghi lại `degradedExports`.
- Thêm CLI `scripts/backup-create-c04.js` và `scripts/backup-restore-c04.js`. Backup yêu cầu cờ xác nhận `--server-stopped`; restore tự chọn thư mục mới cạnh bundle nếu không truyền `--output`. Manifest được ghi cuối khi publish để archive dừng giữa chừng không thể xác minh như hoàn chỉnh.
- Thêm kiểm thử trong `test/backupRestore.test.js` và hướng dẫn vận hành tại `docs/runbooks/backup-restore-c04.md`.

## Kiểm tra

`node --check` cho module, hai CLI và test: đạt.

`node --test test/backupRestore.test.js` trong sandbox của chat C04: **5 test cấp cao đạt, 0 lỗi**; một subtest symlink bị skip vì sandbox trả `EPERM` khi tạo junction. Sau đó log QA tích hợp của coordinator ghi full Node suite **313/313 đạt, 0 lỗi, 0 skip**; ca symlink chạy thành công ở môi trường đó (`test-results/automation-a04-integrated-full-20261006.log`, dòng 131–133 và 418–423). Bộ test C04 dùng DB/room files trong `%TEMP%`, kiểm tra:

- backup/restore và source hash cùng directory inventory không đổi;
- session/profile token và room code/link cũ, Gang, UNO 112 và UNO 108 được nạp lại;
- hold Tiến lên, Poker reservation/stack và ledger khớp; settlement coin và cash-out Poker lặp cùng idempotency key không cộng lần hai;
- JSON export Tiến lên/Poker hỏng nhưng snapshot SQLite còn đúng vẫn phục hồi qua manager; JSON authoritative UNO 108 hỏng bị từ chối;
- thiếu file, checksum đổi, manifest partial/path traversal, schema tương lai, overlap và copy fault đều bị từ chối, không publish đích;
- restore mặc định tạo thư mục mới ngoài `data`.

Log lỗi JSON Tiến lên/Poker trong test restart là fault injection có chủ đích; manager lấy state từ snapshot SQLite. Chat C04 không tự chạy `npm test` hoặc browser suites; full Node suite phía trên là QA tích hợp của coordinator.

## Giới hạn cần giữ nguyên khi tích hợp

- Công cụ là stopped-server mode. `--server-stopped` là xác nhận của vận hành; code chưa có cơ chế tự khóa room mutation, drain socket, hoặc xác nhận process server đã kết thúc. UI C05 chỉ nên gọi module khi đã có lifecycle gate rõ ràng.
- Không có thay đổi `package.json`; chạy trực tiếp các file CLI như runbook. Coordinator có thể đăng ký npm aliases khi thực hiện release/QA chung.
- Restore output là fixture/data directory mới có `backup-manifest.json`. Tool không thay DB đang chạy, không nhập snapshot vào DB khác và không tự copy restore vào `data\`.
- Sandbox riêng của chat C04 không cho tạo symlink; full QA của coordinator đã chạy ca symlink thành công. Code từ chối symlink/junction gặp khi duyệt đường dẫn/bundle.

## CLI entrypoints

Các alias npm có thể trỏ trực tiếp tới hai file này:

```json
{
  "backup:create": "node scripts/backup-create-c04.js",
  "backup:restore": "node scripts/backup-restore-c04.js"
}
```

Gọi qua npm bằng `npm run backup:create -- --server-stopped --output <new-directory> [options]` và `npm run backup:restore -- <backup-directory> [--output <new-directory>]`.
