# Hoàn tất A05 — Thống nhất hiển thị cược và khoản giữ

Ngày: 06/10/2026

Phạm vi: Tiến lên, Sâm lốc và Phỏm; không đổi luật thanh toán, ledger hay tỷ lệ coin/gem.

## Hành vi đã triển khai

- Bổ sung bộ đọc kinh tế chung trong `GameValues`: lấy `currency`, `stake` và `maxLoss` từ state server; giữ riêng cược với khoản giữ, không tự gán khoản giữ bằng cược. Nếu state thiếu `maxLoss`, giao diện ghi khoản giữ đang chờ xác nhận.
- Khi state ở kết quả, ưu tiên số liệu đã chốt trong `state.result`; nếu kết quả Tiến lên không lặp `maxLoss`, dùng trường `state.maxLoss` vẫn có trong state server.
- Chi tiết portal định dạng mức cược theo `GameValues`, nhận currency từ catalog server và cho biết mức giữ được xác nhận tại phòng chờ. Lobby, bàn và kết quả cùng dùng mô tả chung.
- Nhãn currency và icon trên bàn theo `state.currency`; phòng cũ có reservation bằng chip tiếp tục hiện chip sau khi khôi phục.
- Đã bỏ các nhãn cược/mức giữ cố định trong markup Tiến lên, Sâm lốc và Phỏm. Room legacy vẫn nhận cấu hình cược hiện hành.

## File thay đổi

- `public/js/game-values.js`
- `public/js/portal.js`
- `public/js/room-create.js`
- `public/js/tien-len.js`, `public/js/sam-loc.js`, `public/js/phom.js`
- `public/tien-len.html`, `public/sam-loc.html`, `public/phom.html`
- `test/gameValues.test.js`
- `scripts/a05-stakes-browser-check.js` và lệnh `test:a05-stakes` trong `package.json`
- Follow-up sau A07: `public/js/room-create.js` và `scripts/room-create-limits-browser-check.js`

Backend không được sửa trong A05. A01 đã bổ sung `maxLoss: room.stake` vào state Tiến lên; state Sâm lốc và Phỏm đã gửi `maxLoss` theo số người. Cả ba gửi currency từ reservation của phòng.

## Kiểm thử

- `npm test`: **178/178 đạt**.
- `npm run test:a05-stakes`: **đạt**. Chrome headless kiểm tra 50, 500 và 10.000 coin tại chi tiết portal, phòng chờ, bàn và kết quả; cấp 2.000.000 coin fixture cho mỗi người chơi; khôi phục phòng Tiến lên đang giữ chip từ snapshot SQLite tạm, nối lại hai ghế và xác nhận bàn/kết quả ghi chip. Không có lỗi trang trình duyệt.
- `npm run test:table-updates`: **đạt**.
- `npm run test:portal-browser`: **đạt**.
- `npm run test:tien-len-browser`, `npm run test:sam-loc-browser`, `npm run test:phom-browser`: **đều đạt**.
- `node scripts/room-create-limits-browser-check.js`: **đạt**. Native form lấy `minStake` và `maxStake` theo `stakeRules.maxPlayers`/`game.maxPlayers` từ `/api/registry`; min và max hợp lệ ở UI, max+1 bị chặn trước khi gửi tạo phòng. Không cấp fixture tiền hoặc bắt đầu ván ở boundary. Catalog fixture cũ không có `stakeRules` không nhận cận tự đặt và hiển thị rằng server kiểm tra cược khi tạo phòng.

Database và file phòng của kiểm thử A05 nằm trong thư mục tạm; test xóa thư mục đó sau khi đóng server. Không đọc hay sửa dữ liệu người chơi cục bộ.

## Còn chưa kiểm chứng

Chrome headless đã kiểm tra viewport desktop và mobile giả lập; chưa chạy trên điện thoại thật hoặc Wi‑Fi thật. Tiến lên giữ `maxLoss` ở state phòng sau khi kết quả chốt, không sao chép trường này vào riêng `state.result`; giao diện hiện đọc được cả hai dạng.

Follow-up native limits dùng catalog thật cho các giới hạn hiện hành; nhánh catalog cũ thiếu `stakeRules` được giả lập bằng response fixture. Kiểm tra việc từ chối cược ở boundary khi tạo phòng thuộc các regression server A07.
