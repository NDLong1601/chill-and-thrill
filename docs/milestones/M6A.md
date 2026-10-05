# M6A — Sâm lốc

Ngày: 05/10/2026<br>
Trạng thái: triển khai local v1; M6B Phỏm và M6C BANG! chưa triển khai.

## Kết quả người chơi dùng được

- Mở [Sâm lốc](/sam-loc), tạo/vào bàn 2–5 người, chia QR, dùng hồ sơ/ví M3 chung và sẵn sàng trước ván.
- Server chia 10 lá riêng, mở cửa sổ Báo Sâm 60 giây, ổn định ưu tiên nhiều người báo theo thứ tự ghế, và chuyển sang Sâm hoặc ván thường với lá thấp nhất đã chia.
- Bàn hỗ trợ rác/đôi/sám/tứ quý/sảnh, bỏ vòng, Báo một/chặn Báo một, Báo Sâm thành công và thất bại. Chất không dùng để so bài và không có chặt Tiến lên.
- Trước khi chia, mỗi người giữ mức thua tối đa `2 × 20 × (số người − 1)`. Kết quả đóng các khoản giữ trong một settlement idempotent; UI giải thích lý do và delta chip.
- Mất kết nối tạm dừng ván; restart khôi phục cửa sổ Báo Sâm/bài/lượt/khoản giữ. Chủ bàn hủy được trước lá đầu, sau đó chip được hoàn có sổ cái.

## Luật và quyết định đã chốt

- Biến thể là Sâm lốc local v1, 2–5 người, cược cơ bản 20 chip. Không có bot, tới trắng, thối 2, cóng hay các luật nhà không xác định.
- Báo Sâm thay thế ván thường: thành công nhận `2 × cược` từ mỗi đối thủ; thất bại trả số đó cho từng đối thủ. Báo một chỉ thêm một cược trong ván thường, không cộng với đền Sâm.
- Tất cả chi tiết, ví dụ tổ hợp, giới hạn cuối bài, deadline/reconnect và chứng minh mức giữ có trong [sam-loc.md](../rules/sam-loc.md).

## Kỹ thuật và file chính

- [samLocDeck.js](../../src/games/sam-loc/samLocDeck.js) — deck, tổ hợp và so bài riêng; không gọi logic chặt/chất của Tiến lên.
- [samLocEngine.js](../../src/games/sam-loc/samLocEngine.js) — room state, Báo Sâm, private state, reconnect/persistence và settlement.
- [profileStore.js](../../src/platform/profileStore.js) — thêm `settleReservations`, một primitive server-side để đóng khoản giữ theo bảng zero-sum, dùng cho các game cược cố định có phạt.
- [multiGameManager.js](../../src/platform/multiGameManager.js), [httpServer.js](../../src/httpServer.js), [gameRegistry.js](../../src/platform/gameRegistry.js) — đăng ký game, route, QR và companion snapshot `*.sam-loc.json`.
- [sam-loc.html](../../public/sam-loc.html), [sam-loc.js](../../public/js/sam-loc.js) — sảnh, room, Báo Sâm, bài tay, kết quả.

## Cách chạy

```text
npm install
npm start
```

Mở `http://localhost:3000/sam-loc`. SQLite mặc định là `data/chill-and-thrill.sqlite`; khi cấu hình `GANG_DATA_FILE`, snapshot Sâm lốc nằm ở companion `*.sam-loc.json`.

## Kiểm thử đã chạy

```text
npm test
68 passed

npm run test:sam-loc-browser
Sâm lốc browser check passed
```

Các test M6A bao phủ deck/tổ hợp không dùng chất, ưu tiên nhiều người Báo Sâm, action đến sau hạn, state riêng tư, Sâm thành công/thất bại, Báo một, mức giữ 2–5 người, settlement idempotent, Socket.IO/QR/rule route, restart trong cửa sổ Báo Sâm và layout viewport 390px. Lần `npm test` trên Windows có một dòng cảnh báo `EPERM` khi test Poker cũ đổi tên tệp tạm; tất cả 68 test vẫn pass.

## Chưa xác minh / đầu vào M6B

- Chưa kiểm tra trên điện thoại hoặc Wi‑Fi thật.
- M6B phải triển khai Phỏm như engine riêng với bốc/ăn/hạ/gửi và không được dùng state machine Sâm lốc thay thế.
