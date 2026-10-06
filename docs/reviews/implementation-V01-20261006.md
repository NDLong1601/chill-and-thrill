# V01 — Nghiệm thu tích hợp product-audit-20261005

Ngày chốt: 06/10/2026, Asia/Saigon. Trạng thái: **đạt nghiệm thu tự động trên working tree hiện tại**.

Bổ sung 11:06: bốn tệp giao diện/điều hướng đổi sau snapshot chốt 10:13 bên dưới. Đã sửa đường Continue thiếu đích quay về portal và kiểm tra lại 14 bộ browser liên quan, tất cả đạt. Xem [báo cáo delta V01](implementation-V01-delta-20261006.md) và [danh mục SHA-256 mới](../../test-results/product-audit-delta-20261006.json). Bằng chứng Node 448/448 được giữ vì backend/Node test không đổi, không được chạy mới trong lượt delta. Các số liệu 36 bộ và timestamp bên dưới mô tả snapshot nghiệm thu gốc.

21 hạng mục A01–A07, B01–B06/B08, C01/C02/C04–C08 đã hoàn tất triển khai. Mỗi hạng mục đã có chat riêng, được ghi trong [bảng tiến độ](product-audit-implementation-20261006.md). V01 là cổng kiểm tra chung, không phải tính năng thứ 22. Không còn lỗi kiểm thử tự động chưa xử lý ở bộ bằng chứng bên dưới.

## Kết quả chốt

| Kiểm tra | Kết quả | Bằng chứng |
|---|---|---|
| Full Node trên code sản phẩm cuối | **448/448 đạt**, fail/cancelled/skipped = 0 | [acceptance-full-node-20261006.log](../../test-results/acceptance-full-node-20261006.log) |
| Browser và kiểm tra vận hành | **36 bộ đạt** trên snapshot tương ứng | [Danh mục bằng chứng và SHA-256](../../test-results/product-audit-acceptance-20261006.json) |
| Crash sau published start/action | 16/16, đủ tám target: The Gang, hai UNO, Tiến lên, Poker, Sâm lốc, Phỏm, BANG! | Đã nằm trong full Node; [báo cáo recovery](implementation-V01-recovery-20261006.md) |
| COMMIT lỗi, rollback, cùng action retry, tombstone, JSON export, backup/restore và UNO reaction timer | 21/21, đã nằm trong full Node | [audit-v01-casual-commit.test.js](../../test/audit-v01-casual-commit.test.js) |
| C08 service/routes/backup/lifecycle/production cancellation/UNO112 next round | 21/21, đã nằm trong full Node | [Báo cáo C08](implementation-C08-20261006.md) |
| Nhiều tab với Socket.IO thật | PASS: một chủ ghế, stale tab bị từ chối, giữ tiền/settlement một lần, ack muộn an toàn, 0 page errors | [final-multitab-20261006.log](../../test-results/final-multitab-20261006.log) |
| Nhóm đổi game | PASS: invite riêng, consent, handoff vào phòng production, hai profile và mobile | [acceptance-group-lobby-20261006.log](../../test-results/acceptance-group-lobby-20261006.log); Node còn kiểm tra nhóm bốn người qua cả tám target |
| Khán giả | PASS cả tám target: password/reconnect/role guard/privacy, bốn viewport, không tạo/sửa profile hoặc ledger | [acceptance-spectator-20261006.log](../../test-results/acceptance-spectator-20261006.log) |
| Giải đấu trên server thật | PASS: hai vòng UNO108, khóa roster, kết quả server tự ghi đúng một lần, bảng điểm/lịch sử sau restart, bốn viewport, không đổi ledger | [acceptance-tournament-product-20261006.log](../../test-results/acceptance-tournament-product-20261006.log) |
| Launcher/backup/restore | PASS: child thật, active-hand graceful stop/exit, đóng cổng, authenticated seat/profile recovery; browser control/cookie/QR/backup/restore mới | Ba log `final-launcher-{child,control,ui}-20261006.log` trong danh mục bằng chứng |

Full Node hoàn thành lúc 09:41:38 ngày 06/10/2026. Đã đối chiếu timestamp: từ lần chạy đó không có thay đổi trong code sản phẩm hoặc Node test. Hai file thay đổi sau đó chỉ là fixture/browser regression sửa kỳ vọng, và cả hai bộ đã chạy lại đạt. Các bằng chứng browser vận hành độc lập được giữ lại khi code liên quan không thay đổi; C01/C07/C08, portal mobile/identity và practice production đã kiểm tra lại ở lượt chốt 10:08–10:10.

36 bộ gồm: bảy game với hai UNO, portal/profile/history, lifecycle/storage, shared UI/thrill/table updates, tutorial/context, preferences harness và tám bàn thật, preflight, practice standalone/product, admin, group lobby, spectator, tournament, home mobile, identity, room limits, ba launcher checks, multitab, currency exchange và stake labels. Node và browser dùng bộ nhớ hoặc SQLite/room files tạm; không dùng dữ liệu người chơi.

## Các lỗi đã đóng trong nghiệm thu

- Bảy phát hiện A01–A07 có regression chính thức. Snapshot/ledger nguyên tử, relevant Poker waiters, reconnect deadline, storage gate, tiền cược/currency, identity và money bounds đều được kiểm tra.
- V01 tìm thêm crash loss ở The Gang/hai UNO lúc bắt đầu và BANG! sau action. `gameStateTransactions` commit shared SQLite trước publication, rollback ổn định object/receipt và giữ JSON tương thích. C04 kiểm tra backup có authoritative snapshot, C07 chỉ phát public projection.
- Những lỗi bố cục do preferences/context chiếm hàng grid ở The Gang và flex/header ở hai UNO đã sửa; product checks tám bàn đạt. The Gang còn đạt sáu ghế Camera/River/Showdown, chiều cao 240 px, safe area và fullscreen.
- Lượt browser acceptance đầu có hai fixture sai: portal gán opening +2 cho host thay vì ghế tiếp theo; preferences harness thiếu class `hand` của bàn production. Sửa fixture, giữ kiểm tra cả hai private hand và kích thước card; rerun đạt tại `acceptance-portal-repaired-20261006.log` và `acceptance-preferences-harness-repaired-20261006.log`. Không tính hai log thất bại cũ là đạt.

Đã xem ảnh mobile giải đấu/bảng điểm và bàn The Gang 568 px; bảng và thao tác vừa viewport. Các suite ghi 0 page errors theo phạm vi kiểm tra. Những test có kiểm tra request ngoài server cũng đạt; không suy rộng thành kiểm tra mọi request của tất cả suite.

## Phạm vi sử dụng và giới hạn

- Giữ một ProfileStore/ledger chung, lịch sử game ID/token/link và hai UNO tách biệt. Tỷ lệ coin/gem không đổi; điểm giải đấu không cấp tiền. Bot hiện hỗ trợ UNO112 và Tiến lên; UNO108 hiển thị rõ chưa hỗ trợ luyện tập.
- Backup chỉ tạo sau khi server do launcher sở hữu đã dừng sạch; restore luôn sang thư mục mới. B08 chuyển portal sang hợp đồng chung theo từng phần, giữ client bàn legacy tương thích.
- **Chưa xác minh điện thoại/WiFi thật, Windows Firewall/router, thao tác nhấp đúp launcher bằng UI hoặc tải nhiều phòng theo mục tiêu vận hành.** Viewport mô phỏng và socket tự động không thay thế những phép thử đó. Đây là giới hạn nghiệm thu môi trường, không phải lỗi tự động đã tái hiện còn bỏ ngỏ.
- Không thay dữ liệu người chơi, reset working tree, commit, push hoặc deploy trong lượt nghiệm thu. Các log thất bại lịch sử vẫn giữ để đối chiếu.

Khi mã thay đổi, chạy lại bộ liên quan; full Node bằng `npm test`. Không lặp lại toàn bộ audit trên mỗi lượt automation khi mã và trạng thái không đổi. Trước khi dùng cho nhóm thật, thực hiện diễn tập với hai điện thoại cùng WiFi, reconnect/rotation, QR và một backup/restore sang dữ liệu thử theo [runbook launcher](../runbooks/launcher-c06.md).
