# B01 — Preflight trước khi bắt đầu ván

Ngày: 06/10/2026. Trạng thái cuối: **hoàn tất renderer/service, state riêng theo ghế, cổng start và phòng chờ tám biến thể**.

MultiGameManager nối `preflight` tại buildStateFor của chính ghế nhận state. Broadcast đọc diagnostics đã có với ignorePending, tránh đối soát nhầm khoản giữ giữa transaction. Khi host mở ván cược, gate lấy lại kết quả A04 trước mutation; false/unknown hoặc lỗi refresh không được coi an toàn. Validator tiền/readiness/phase ở engine vẫn chạy lại. Server sản phẩm luôn đăng ký collector và callback refresh; manager standalone không có collector giữ tương thích tests/legacy.

`public/js/preflight-mount.js` và dependencies đã nối portal/native HTML. Panel cập nhật theo state/revision/ready/buy-in, ẩn khi vào ván hoặc rời phòng. Client chỉ hạn chế nút start theo quyết định server, không mở nút vượt điều kiện renderer game. Payload mới có số dư/shortfall của người xem; host chỉ nhận nhãn tài chính peer, guest không nhận chúng. Legacy players[].balance vẫn giữ theo yêu cầu tương thích coordinator; renderer không dùng alias đó. Không tuyên bố đã xóa mọi field tài chính của state lịch sử.

Nghiệm thu cuối: **30/30** scoped trong `preflight.test.js`, `preflightService.test.js`, `preflightServer.integration.test.js`, gồm manager thật/tám biến thể, money/capacity, Poker không giữ lặp, Socket.IO riêng ghế và storage gate mới. Harness browser đạt mobile/desktop; product browser đạt panel WAITING trên tám biến thể, host/guest, readiness Chưa thể → Có thể bắt đầu, start fault không giữ tiền và recovery. Log `automation-b01-node-20261006.log`, `automation-b01-browser-20261006.log`, `automation-b01-b06-product-20261006.log`, `automation-b01-a04-product-20261006.log` trong test-results.

Fixture chỉ dùng DB/phòng tạm hoặc bộ nhớ; chưa thử điện thoại/WiFi thật. Coordinator hoàn thành integration/QA khi feature chat có approval pending ở sandbox cũ, không đổi approval settings. Nhả backend/frontend cho B08; chưa nghiệm thu toàn bộ audit trước V01.

## Checkpoint module ban đầu — lịch sử trước tích hợp

Các đoạn dưới mô tả trạng thái ban đầu, đã được phần nghiệm thu cuối ở trên thay thế.

## Phạm vi của checkpoint

Đã thêm renderer không có quyền thay đổi trạng thái phòng hoặc ví:

- `public/js/preflight.js`: kiểm tra schema preflight, tạo view model an toàn, hiển thị số liệu của riêng người xem, danh sách người chưa ready/mất kết nối, và blocker mà host cần biết. Renderer không tính lại số dư, khoản giữ, shortfall, người đủ điều kiện, hay điều kiện bắt đầu.
- `public/css/preflight.css`: bố cục co giãn cho phòng chờ, ưu tiên đọc được trên màn hình hẹp.
- `test/preflight.test.js`: fixture hợp đồng riêng trong Node, không khởi tạo manager, không mở database hay sửa file phòng.
- `scripts/preflight-browser-check.js`: kiểm tra renderer trên Chrome headless với viewport 360×780, 390×844 và 1280×900; script dùng Chromium Playwright nếu có, nếu không thì dùng Chrome/Edge cài sẵn.

Module không được nối vào HTML, socket, API, manager hay nút Bắt đầu trong checkpoint này. A04 đang sở hữu backend; B06 đang sở hữu client/HTML. Chỉ tích hợp sau khi coordinator mở rõ phần đó.

## Contract server đề xuất cho tích hợp

Server gửi preflight gắn với socket/ghế đã xác thực, cùng `room.revision` để client bỏ payload cũ. Số dư và shortfall tiền tệ chỉ nằm ở `viewer`; roster công khai chỉ có `id`, `name`, `ready`, `connected`.

```js
{
  schemaVersion: 1,
  room: {
    code, gameId, variant, phase, revision,
    minPlayers, maxPlayers,
    requiresWagerSafety: true | false
  },
  seats: [{ id, name, ready, connected }],
  viewer: {
    seatId, isHost,
    wallet: null | { currency: 'coin' | 'chip' | 'gem', available, reserved },
    funding: { mode: 'none' | 'fixed-hold' | 'poker-buy-in', ...serverComputedValues }
  },
  evaluation: { allowed, blockers: [{ code, details? }] },
  storage: { canStartWager: true | false | null },
  host: { seatFunding: [{ seatId, status }] } // chỉ gửi riêng cho host
}
```

`host.seatFunding.status` chỉ được là `sufficient`, `insufficient`, `capacity-blocked`, `unknown` hoặc `not-required`. Nó cho host biết ai cần hỗ trợ, nhưng không mang available/reserved/shortfall, profile ID, token hay ledger của người khác. Server không broadcast trường này cho guest. Tất cả thông tin ví khác ghế phải bị loại khỏi payload; renderer cố ý bỏ qua các trường thừa như `players[].balance`, `wallet`, `profileId`, và shortfall của người khác.

Các blocker đã có nhãn giải thích tiếng Việt: thiếu số người, vượt sức chứa ghế, người chưa sẵn sàng hoặc offline, thiếu số dư, hết sức chứa ví, chưa xác minh ví, lỗi lưu trữ/đối soát, chưa xác nhận currency, sai phase và chưa đủ Poker eligible. Nội dung exception/path nội bộ server không được gửi tới client.

## Ánh xạ theo luật và tiền hiện hành

- Casual The Gang, UNO 112 (`classic-local-v1`), UNO 108 (`classic-108-v1`) và BANG! không dùng ví cược trong preflight. Module giữ nguyên `gameId`/variant và không tự gộp hai engine UNO.
- Tiến lên, Sâm lốc, Phỏm nhận currency và khoản sẽ giữ từ server/reservation hiện hành. `stake` và `maxLoss` là hai khái niệm riêng: theo luật/cận A07, hold mỗi ghế lần lượt là `stake`, `2 × (số ghế − 1) × stake`, và `6 × (số ghế − 1) × stake`. Không có giả định `stake = 100`; phòng legacy dùng chip phải tiếp tục hiện chip theo reservation được khôi phục.
- Poker dùng chip. Buy-in/top-up chuyển chip từ số dư khả dụng vào hold/stack trước khi mở hand. Mở hand không giữ thêm chip; stack là phần tiền đã giữ và không được cộng lần nữa vào tổng ví. `minimumAdditionalBuyIn`, mức thiếu và eligibility của ghế phải do server tính từ luật Poker/stack hiện tại.
- Điều kiện tối thiểu, sức chứa, readiness và eligibility phải do manager/registry trả về. Các luật đang chạy không đồng nhất: Poker bắt đầu khi có ít nhất hai ghế kết nối, ready và đủ stack; các game còn lại có cách xét ghế/readiness theo manager và variant. Module chỉ trình bày blocker server gửi, không tự suy diễn từ tên game hoặc luật mặc định.
- A07 kiểm tra cả khả dụng, mức giữ, sức chứa khoản giữ, safe-integer và sức chứa payout. Vì vậy `insufficient` và `capacity-blocked` là hai kết quả riêng, còn số liệu chính xác chỉ người sở hữu ví thấy.

## Cổng an toàn lưu trữ

Với `requiresWagerSafety: true`, chỉ `storage.canStartWager === true` mới cho renderer hiện trạng thái “Có thể bắt đầu”. `false` hiện lỗi lưu trữ; `null` hoặc thiếu trạng thái hiện “chưa xác nhận an toàn” và chặn khẳng định có thể bắt đầu. Game không cược đặt `requiresWagerSafety: false`. Cổng này chỉ là cách trình bày fail-closed; server vẫn phải đánh giá lại toàn bộ điều kiện và storage trong handler bắt đầu trước mọi hold/start.

A04 chưa mở integration storage/API/manager vào B01. Vì vậy trạng thái thực còn thiếu phải được gửi là `null`, không được mặc định an toàn.

## Quyền riêng tư và tương thích đang chờ tích hợp

Trong source hiện tại, projection của Tiến lên, Sâm lốc và Phỏm vẫn có `players[].balance` lấy từ hồ sơ; Poker có `players[].balance` làm alias stack. Trường cũ chưa bị xóa hoặc sửa trong checkpoint này để giữ tương thích và không chạm công việc UI hiện hữu, theo chỉ dẫn coordinator. Renderer B01 không dùng các trường đó. Khi tích hợp, backend cần payload ví riêng theo socket và trạng thái đủ/thiếu riêng cho host; public game state không được dùng làm nguồn ví hoặc phát số dư các người chơi khác. Đây là hạng mục bắt buộc còn mở để đáp ứng đầy đủ privacy của B01.

Host thấy số dư/shortfall của chính host, trạng thái ready công khai, từng ghế đủ/thiếu điều kiện ví theo nhãn, và nguyên nhân server chặn start. Guest chỉ thấy số dư/shortfall của mình, readiness công khai và thông báo chung; không nhận blocker tài chính theo từng người.

## Kiểm tra

- `node --test test/preflight.test.js` — **15/15 đạt**: coin/chip/gem; phòng legacy chip; shortfall; Poker buy-in và stack; casual/no-wallet; hai UNO variants; host/guest privacy; readiness; thiếu người; vượt sức chứa ghế; wallet credit capacity; storage false/null; dữ liệu tiền không an toàn; và blocker không lộ prose/path server.
- `node scripts/preflight-browser-check.js` — **đạt** trên viewport mobile giả lập 360×780 và 390×844, desktop giả lập 1280×900: fixed hold, Poker buy-in, UNO108, overflow ngang, revision, blocker lưu trữ và lọc thông tin ví peer. Harness fallback dùng browser Chrome cài sẵn do binary Chromium cache của Playwright không có.
- Chưa chạy full `npm test` hay browser suites của product trong checkpoint này; chúng đang có thay đổi chưa commit từ các feature khác. Chưa thử điện thoại hoặc Wi-Fi thật.
- Không tạo/mở database hay room file; không sửa dữ liệu người chơi; không sửa file shared hiện có, `package.json`, queue hay memory; không commit/push/deploy.

## Còn chờ

1. A04 mở API/storage/manager/backend tích hợp và cung cấp điều kiện authoritative `canStartWager`.
2. B06 mở client/HTML tích hợp, cập nhật preflight theo thay đổi ready/buy-in/room revision, và loại số dư peer khỏi mọi public state mà không phá link/variant/tương thích cần giữ.
3. Handler start phải kiểm tra lại phase, ghế, readiness/eligibility, wallet/capacity và storage trong cùng transaction phù hợp trước khi bắt đầu. Preview preflight không được gọi engine start hoặc mutate ledger.
4. Khi được mở, thêm integration tests trên rooms/DB tạm cho Gang, UNO112, UNO108, BANG!, các game coin, Poker; test guest/host trên nhiều socket để chứng minh số liệu riêng không phát tán; sau đó chạy lại scoped browser và regression suites liên quan.
