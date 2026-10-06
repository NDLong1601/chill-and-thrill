# C04 — Sao lưu và diễn tập phục hồi

Ngày: 06/10/2026. Công cụ hiện chạy độc lập bằng Node.js 24+, chưa có nút trong UI hay live quiesce/freeze gate.

## Phạm vi dữ liệu

Bundle chứa một bản SQLite nhất quán của ProfileStore v4 và các manager JSON cần cho phục hồi/compatibility:

| File trong bundle | Nội dung và nguồn phục hồi |
|---|---|
| `payload/profile-store.sqlite` | Một ProfileStore duy nhất: hồ sơ, session hash, các ví, ledger, reservations, room/match records và snapshot game |
| `payload/rooms.json` | The Gang và UNO 112; giữ room code, token/hash và trạng thái để các link cũ tiếp tục vào đúng bàn |
| `payload/rooms.uno.json` | UNO 108; JSON là nguồn phục hồi của manager này |
| `payload/rooms.bang.json` | BANG!; JSON là nguồn phục hồi của manager này |
| `payload/rooms.tien-len.json`, `rooms.sam-loc.json`, `rooms.phom.json`, `rooms.poker.json` | JSON export của các manager cược; snapshot SQLite được ưu tiên theo A01 |

Các đường dẫn manager mặc định được suy ra cạnh `GANG_DATA_FILE` (mặc định `data\rooms.json`). `GANG_DATABASE_FILE` được ưu tiên cho SQLite, sau đó `GANG_DB_FILE`, rồi `data\chill-and-thrill.sqlite`. Các file manager được yêu cầu đầy đủ kể cả khi không có phòng. Nếu triển khai tùy chỉnh, truyền đường dẫn từng file qua CLI; không tạo JSON rỗng để che một file nguồn bị thiếu.

## Tạo backup

1. Dừng server sạch bằng Ctrl+C và đợi tiến trình kết thúc. Trình dừng hiện tại flush manager rồi đóng ProfileStore. Không chạy lệnh trong khi server còn hoạt động.
2. Kiểm tra đường dẫn dữ liệu và thư mục backup đích. Thư mục đích phải mới, nằm ngoài cây dữ liệu nguồn, và thư mục cha phải tồn tại.
3. Chạy:

```powershell
cd C:\Users\PC\Documents\chill-and-thrill
node scripts/backup-create-c04.js --server-stopped --output 'E:\ChillBackups\ct-2026-10-06' --data-dir 'C:\Users\PC\Documents\chill-and-thrill\data'
```

Với đường dẫn manager tùy chỉnh, truyền thêm `--uno108`, `--tien-len`, `--poker`, `--sam-loc`, `--phom` và `--bang`. `--rooms` chọn file Gang/UNO 112; `--database` chọn ProfileStore. Lệnh từ chối thiếu file, file `.tmp` còn sót, JSON authoritative hỏng, SQLite sai schema, ledger/ví lệch, HELD thiếu room/snapshot, checksum không khớp và mọi đường dẫn chồng lấn.

`--server-stopped` là xác nhận do người vận hành đưa ra; công cụ chưa kết nối tới server để khóa thao tác hoặc phát hiện tiến trình đang sống. Không xem cờ này là live freeze. SQLite được tạo bằng `VACUUM INTO` trên kết nối chỉ đọc, đọc trạng thái SQLite/WAL đã commit; tool không chép file DB/WAL thô và không mở nguồn writable để migration hay đóng manager.

Bundle chỉ được coi hoàn chỉnh khi có `manifest.json` cuối cùng. Manifest ghi format version, ProfileStore schema, chế độ consistency, file IDs, kích thước và SHA-256. Nếu tiến trình dừng giữa lúc publish, thư mục chưa có manifest hoàn chỉnh và lệnh phục hồi sẽ từ chối.

## Xác minh và phục hồi thử

Mặc định, restore tạo một thư mục mới có timestamp cạnh bundle. Có thể chọn tên mới bằng `--output`; không chọn thư mục đã tồn tại, thư mục `data` đang dùng hoặc đường dẫn chồng với bundle:

```powershell
node scripts/backup-restore-c04.js 'E:\ChillBackups\ct-2026-10-06'
```

Restore kiểm tra manifest/checksum/file inventory, schema v4, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, tổng dư ví so với ledger và HELD, room/member/snapshot references, sau đó mới publish. Thư mục đích chứa các file dữ liệu trực tiếp và `backup-manifest.json`; không ghi đè database nguồn và không tự chép vào `data\`.

Để khởi chạy một fixture đã phục hồi thủ công, dùng đúng hai đường dẫn được in ở cuối lệnh restore:

```powershell
$env:GANG_DATABASE_FILE = 'E:\ChillBackups\ct-2026-10-06-restored-20261006T010203Z\profile-store.sqlite'
$env:GANG_DATA_FILE = 'E:\ChillBackups\ct-2026-10-06-restored-20261006T010203Z\rooms.json'
node server.js
```

Các file UNO/game còn lại nằm cùng thư mục với `rooms.json`, nên các manager dùng đường dẫn mặc định tiếp tục đọc chúng. Thử link phòng cũ và từng token trong fixture. Không đổi các biến môi trường để trỏ vào `data\` nếu mục tiêu là diễn tập phục hồi; việc thay dữ liệu đang dùng là thao tác vận hành riêng, không thuộc tool này.

## Giới hạn

- Công cụ hỗ trợ thư mục bundle, chưa đóng gói ZIP/encryption và chưa nối UI chủ máy.
- Snapshot v4 được xác nhận. Schema tương lai hoặc cũ bị từ chối cho tới khi có verifier/migration được kiểm tra riêng.
- Export JSON Tiến lên/Sâm lốc/Phỏm/Poker bị lỗi hoặc cũ có thể được lưu như bytes nếu snapshot SQLite tương ứng hợp lệ; trạng thái snapshot là authority. Export Gang/UNO 112, UNO 108 và BANG! cần parse được vì đây là nguồn phục hồi các room JSON-authoritative.
- Symlink/junction bị từ chối. Một số môi trường Windows không cấp quyền tạo symlink để chạy regression đó; lệnh kiểm tra link khi quyền hệ điều hành cho phép.
- Tất cả fixture QA phải ở `%TEMP%`; không chạy công cụ/test trên `data\` của người chơi.
