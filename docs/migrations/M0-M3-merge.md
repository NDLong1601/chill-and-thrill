# Hợp nhất M0–M3 vào Chill & Thrill

Ngày: 05/10/2026. Thư mục làm việc và Git root hiện tại: `C:\Users\PC\Documents\chill-and-thrill`.

Yêu cầu đã xác nhận: hợp nhất M0–M3 từ bản cũ, giữ các game M4–M6 hiện có. Không lấy nguyên cây mã nguồn cũ để thay chương trình mới.

## Bản sao lưu

Trước khi sửa, đã sao lưu hai cây mã nguồn/tài liệu vào `.migration-backups/M0-M3-20261005/source` và `.migration-backups/M0-M3-20261005/destination` trong thư mục hiện tại. Bao gồm cả tệp chưa được Git theo dõi; không phụ thuộc một commit để khôi phục.

Bản sao lưu giữ nguyên các phiên bản trước hợp nhất và được Git ignore. Nó không bao gồm `node_modules`, dữ liệu người chơi, font nhị phân hoặc ảnh kiểm tra. Các tệp dữ liệu người chơi hiện có được giữ nguyên trong đợt chuyển mã nguồn; các bài kiểm thử dùng DB/room file tạm hoặc bộ nhớ.

## Cách giải quyết khác biệt

| Phần | Bản hợp nhất đang chạy |
|---|---|
| M0 | Bộ thiết kế và prototype trong `docs/design`, cập nhật đường dẫn workspace; baseline trong báo cáo M0 là số liệu lịch sử |
| M1 | Chuyển shell trang chủ, CSS/JS portal, quản lý phòng có cấu hình, adapter The Gang và route/API vào nền hiện tại |
| M2 | Giữ cả UNO 112 lá từ bản cũ và UNO 108 lá của bản mới, mỗi biến thể có engine, UI và tài liệu luật riêng |
| M3 | Giữ `ProfileStore`/SQLite hiện có làm nguồn hồ sơ, ví, ledger và nhiệm vụ duy nhất; `ProfileService` là facade tương thích API của portal cũ |
| M4–M6 | Giữ engine, bàn chơi, luật và thanh toán Tiến lên, Poker, Sâm lốc, Phỏm, BANG!; nối trực tiếp từ portal mới |

Không mở thêm database ví theo schema cũ của `ProfileService`/`WalletService`/`MissionService`. Những trách nhiệm đó được hợp nhất vào `ProfileStore` đang phục vụ M4–M6. Bản gốc các service cũ vẫn có trong snapshot mã nguồn để tra cứu.

`RoomService`/`GameManager` xử lý The Gang và UNO 112; `MultiGameManager` điều phối thêm UNO 108 và các game hiện có. Tất cả dùng cùng `ProfileStore`. `gm.rooms` và các hook The Gang tiếp tục tương thích với bộ kiểm thử trước đó.

## Hai biến thể UNO

| Biến thể | Giới hạn | Vào chơi | File chính |
|---|---|---|---|
| `classic-local-v1` | 112 lá, 2–4 người | `/games/uno`, lựa chọn mặc định, bàn nằm trong shell portal | `src/games/uno/engine.js`, `adapter.js`, `public/js/uno-classic.js`, `docs/rules/uno-classic.md` |
| `classic-108-v1` | 108 lá, 2–6 người | Chọn ở trang chi tiết UNO hoặc vào `/uno` | `src/games/uno/unoEngine.js`, `unoDeck.js`, `public/js/uno.js`, `docs/rules/uno.md` |

Phòng đã có không bị đổi bộ bài/luật. Link mời xác định engine của phòng; QR UNO 112 dẫn về portal, QR UNO 108 không có mật khẩu dẫn về `/uno`. QR phòng có mật khẩu luôn dẫn về portal để nhập mật khẩu trước khi chuyển sang bàn. Không tải chung hai bộ CSS/client UNO vào một bàn.

## Hồ sơ và dữ liệu

- Database mặc định: `data/chill-and-thrill.sqlite`, dùng schema `ProfileStore` v2, tự nâng cấp từ v1 bằng migration thêm bảng `game_snapshots`; hồ sơ/token/ví hiện có được giữ nguyên. `GANG_DATABASE_FILE` và alias cũ `GANG_DB_FILE` cùng được chấp nhận; nếu có cả hai thì `GANG_DATABASE_FILE` được ưu tiên.
- `GANG_DATA_FILE` tiếp tục chọn JSON phòng. Phòng The Gang/UNO 112 đọc version 1–2, ghi version 2 và hash token ghế. Các game khác tiếp tục đọc các tệp lưu riêng hiện có.
- Không sao chép SQLite khác schema vào đè database đang chạy. Đợt này chuyển và hợp nhất mã nguồn, không gộp ví giữa hai máy chủ.
- REST `/api/profile`, `/api/missions` và Socket.IO của M4–M6 xác thực cùng token, đọc cùng hồ sơ/ledger. Trình duyệt dùng khóa `chill-thrill:profile-token`, vẫn đọc khóa portal cũ khi cần.
- Kết quả The Gang và UNO 112 đồng bộ phòng, kết quả và nhiệm vụ trong transaction của cùng store, có savepoint khi gọi service lồng nhau. Kết quả lặp không tăng tiến độ lần nữa.
- Thưởng ngày chưa nhận giữ trong bảy kỳ gần nhất ở portal; kỳ theo `Asia/Ho_Chi_Minh`. Socket cũ nhận thưởng ngày hiện tại; REST có thể chọn kỳ còn hiệu lực. Cả hai dùng cùng idempotency key nên không cộng hai lần.
- Dashboard hiển thị chip khả dụng, khoản giữ và stack Poker hiện tại từ snapshot. Stack là thông tin bàn, không cộng lại với khoản giữ để tính tổng tài sản. Cách hạch toán buy-in/cash-out của Poker được giữ trong ledger hiện tại.
- Poker dùng snapshot riêng trong SQLite làm nguồn khôi phục ưu tiên, cùng transaction với buy-in, cược, kết quả và cash-out. JSON Poker là bản xuất tương thích; dấu đóng phòng trong SQLite ngăn JSON cũ phục hồi ghế đã cash-out. Sao lưu khi server đã dừng phải giữ cả database và JSON.
- Phòng Tiến lên/Sâm/Phỏm hết hạn khi load được hoàn khoản `HELD` đúng một lần trước khi dọn. Poker hết hạn giữa hand hoàn đóng góp về stack trước khi cash-out; hand đã chốt giữ nguyên kết quả. Phòng không bị dọn nếu transaction hoàn chip thất bại.

## Route và cấu hình

Portal phục vụ `/`, `/play/casual`, `/play/thrill`, `/games/:gameId`, `/rooms/:code`, `/missions`. Link cũ `/?room=ABCD` tiếp tục hoạt động. `/profile` giữ trang khôi phục hồ sơ hiện có.

The Gang/UNO 112 chơi trong shell; các game M4–M6 và UNO 108 chuyển sang bàn hiện có sau khi tạo/vào phòng. Thông tin ghế được chuyển qua storage cùng origin, giữ cùng hồ sơ. Rời bàn xóa thông tin “Tiếp tục phòng” liên quan.

Cấu hình phòng chung gồm tên, số người, quyền hiển thị và mật khẩu băm; các trường chưa cho thay đổi từ UI game hiện có được ẩn ở portal. Server vẫn kiểm tra mật khẩu/giới hạn người ở đường vào chung. API danh sách phòng và metadata không trả token, bài hoặc password hash.

## Kiểm tra sau hợp nhất

- `npm test`: **94/94 pass** tại lần kiểm tra toàn bộ ngày 05/10/2026; gồm các game M4–M6, hai UNO, hồ sơ/ví và test tích hợp portal mới.
- `npm run test:browser`: **pass**; luồng The Gang qua trang chủ mới, QR/link, reconnect, chuyển host, bố cục nhiều viewport, fullscreen và kết quả; không có page error hoặc request ngoài server.
- `npm run test:portal-browser`: **pass**; UNO 112 tạo/vào/bắt đầu/reload; UNO 108 và toàn bộ M4–M6 đi từ portal sang bàn tương ứng, dùng chung hồ sơ/ví và không có page error.
- `npm run test:profile-browser`: **pass**; kiểm tra trang hồ sơ và luồng khôi phục. Ba test tích hợp portal cũng được chạy lại và đều pass.
- Kiểm thử browser là Chrome headless/viewport mô phỏng. Chưa xác minh điện thoại thật hoặc WiFi thật trong đợt chuyển thư mục này.

## Hướng dẫn chạy

```powershell
cd C:\Users\PC\Documents\chill-and-thrill
npm start
```

Node.js 24 trở lên. Đường dẫn trong bộ prompt M0–M7 đã đổi sang workspace này. Các báo cáo milestone là kết quả tại thời điểm từng mốc; tài liệu này và phần bổ sung tại M1–M3 mô tả bản hợp nhất hiện tại.

Sau lượt review, 10 lỗi đã được sửa và bổ sung các kiểm thử crash/expiry/phiên/UI. Xem [báo cáo sửa lỗi M0–M6](../reviews/M0-M6-fixes-20261005.md); số liệu 94 test phía trên là baseline lúc hợp nhất.

Muốn khôi phục mã nguồn trước hợp nhất: dừng server, sao lưu mã nguồn hiện tại, rồi đối chiếu/copy các tệp từ snapshot `destination` theo nhu cầu. Không khôi phục hoặc xóa dữ liệu người chơi chỉ để khớp với phiên bản code; database phải tương thích schema của code được chọn.
