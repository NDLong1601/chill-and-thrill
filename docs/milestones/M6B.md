# M6B — Phỏm

Ngày: 05/10/2026<br>
Trạng thái: hoàn thành Phỏm local v1; M6C BANG! chưa triển khai.

## Kết quả người chơi dùng được

- Mở [Phỏm](/phom), tạo/vào bàn 2–4 người, chia QR, dùng cùng hồ sơ/ví M3 và sẵn sàng trước khi bắt đầu.
- Chơi trọn luồng: người đầu tiên đánh, những lượt sau bốc hoặc ăn, đánh, hạ phỏm và gửi bài vào phỏm công khai đã hạ trước đó.
- Server chỉ gửi mỗi ghế bài của chính họ; lá vừa đánh và phỏm đã hạ là công khai. Reload/reconnect/restart giữ bài, nọc, lá ăn, phỏm đã hạ và khoản giữ; ván dừng khi có người mất kết nối.
- Kết quả nêu điểm rác/móm, đồng điểm, ù/đền, từng khoản ăn/ăn chốt và delta chip. Chủ bàn có thể mở ván mới cùng phòng; hủy trước lá đánh đầu hoàn toàn khoản giữ.

## Luật và thanh toán đã chốt

- Biến thể `phom-local-v1`: 2–4 người, A thấp trong dây, bộ 3/4 lá hoặc dây cùng chất từ 3 lá. A=1, J/Q/K=11/12/13; móm là 150 điểm.
- Người đầu tiên nhận 10 lá và đánh trước, những người khác 9 lá. Sau `số người × 4 − 1` lượt bốc/ăn, bàn lần lượt hạ từ ghế đầu; ù kết thúc sớm khi toàn bộ 10 lá thành phỏm.
- Lá ăn phải được chứng minh nằm trong một phỏm hợp lệ, không chồng lấn, tại lúc ăn và lúc hạ. Gợi ý server dùng tìm kiếm toàn bộ nhóm hợp lệ, nên không bỏ lỡ phỏm chồng lấn do greedy.
- Ăn thường là 10 chip, ăn chốt là 20 chip; xếp điểm chuyển 10 chip cho mỗi cặp có điểm khác nhau; ù thay khoản xếp điểm bằng 40 chip từ mỗi đối thủ. Người ăn ba lá đền 60 chip cho mỗi đối thủ và thay nợ ăn/điểm của riêng người đó.
- Mức giữ trước chia là `6 × 10 × (số người − 1)`: 60/120/180 chip cho 2/3/4 người. Đây bao phủ đền nặng nhất; mọi khoản chỉ đóng trong một settlement zero-sum idempotent.
- Toàn bộ luật local, ví dụ và các luật cố ý không hỗ trợ nằm tại [phom.md](../rules/phom.md).

## Kỹ thuật và file chính

- [phomDeck.js](../../src/games/phom/phomDeck.js) — deck, điểm, bộ/dây, kiểm tra nhóm và tìm phương án phỏm chồng lấn.
- [phomEngine.js](../../src/games/phom/phomEngine.js) — state machine bốc/ăn → đánh → hạ/gửi → kết quả, state riêng tư, reconnect/snapshot và settlement.
- [multiGameManager.js](../../src/platform/multiGameManager.js), [httpServer.js](../../src/httpServer.js), [gameRegistry.js](../../src/platform/gameRegistry.js) — đăng ký game, route `/phom`, QR và companion snapshot `*.phom.json`.
- [phom.html](../../public/phom.html), [phom.js](../../public/js/phom.js) — sảnh, chọn bài, tạo phỏm nháp, gửi bài, hạ và màn kết quả responsive.
- [phom.test.js](../../test/phom.test.js), [phom.integration.test.js](../../test/phom.integration.test.js), [phom-browser-check.js](../../scripts/phom-browser-check.js) — test luật, settlement, Socket.IO/QR/private state và browser.

## Cách chạy

```text
npm install
npm start
```

Mở `http://localhost:3000/phom`. SQLite mặc định là `data/chill-and-thrill.sqlite`; với `GANG_DATA_FILE`, snapshot phòng Phỏm dùng companion `*.phom.json`.

## Kiểm thử đã chạy

```text
npm test
✔ 76 tests passed

npm run test:phom-browser
✔ Phỏm browser check passed
```

Test M6B có deck/ID duy nhất; A thấp; bộ/dây; phỏm chồng lấn; ăn đúng/sai; ăn chốt; lá ăn bắt buộc nằm phỏm; ù; móm/đồng điểm; gửi hợp lệ/sai; đền; giữ chip tối đa; settlement bảo toàn/idempotent; Socket.IO/QR; private payload; restart/reconnect; và viewport mobile 390px. `git diff --check` không báo whitespace error.

## Chưa xác minh / đầu vào M6C

- Chưa kiểm tra điện thoại thật hoặc Wi‑Fi thật; browser check dùng Chrome headless và viewport 390px.
- Đây là biến thể local được công bố trong luật; không khẳng định tương thích mọi luật Phỏm theo vùng.
- M6C cần triển khai BANG! như engine/card data riêng, giữ vai/bài kín và không dùng ví để đặt cược.
