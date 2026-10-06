# V01 — Khôi phục sau khi tiến trình dừng đột ngột

Phạm vi bổ sung ngày 06/10/2026 trong workspace `C:\Users\PC\Documents\chill-and-thrill`. Đây là nghiệm thu phần recovery; nghiệm thu toàn audit do coordinator chính chốt sau C08.

## Phát hiện và thay đổi

Child process lưu phòng chờ, bắt đầu ván, xác nhận mọi ghế đã nhận `game_state` đang chơi rồi thoát ngay, không gọi `close`, không chờ timer và không flush sau bắt đầu. The Gang, UNO 112 và UNO 108 phục hồi về WAITING, mất match và bài vừa phát. Kiểm tra tương tự sau hành động phát hiện BANG! phát MAIN nhưng phục hồi về DRAW, mất lượt rút bài và biên nhận.

Đã thêm `src/platform/gameStateTransactions.js`: dùng transaction và bảng `game_snapshots` của ProfileStore hiện có cho The Gang, hai UNO và BANG!. Snapshot, dữ liệu kết quả/nhiệm vụ và thay đổi phòng commit trước khi phát socket hoặc cập nhật channel. Commit lỗi phục hồi chính object room, bỏ các thông báo thất bại và giữ nguyên biên nhận để thử lại. Timer phản ứng UNO 112 chỉ đổi sau commit. JSON tiếp tục làm bản xuất và nguồn nhập cũ; lỗi xuất được báo riêng. Snapshot/tombstone ưu tiên hơn JSON cũ; deadline reconnect được lưu ngay khi phục hồi.

Các khóa snapshot nội bộ `the-gang`, `uno-local`, `uno-108`, `bang` phân biệt hai UNO. Game ID công khai, kết quả, ví, ledger, tokens và đường dẫn lịch sử giữ nguyên. MultiGameManager bổ sung store cho UNO 108 và lưu cấu hình đầy đủ trước ack create/join. Backup validation chấp nhận phòng có snapshot phục hồi dù bản JSON hợp lệ không chứa phòng đó; vẫn kiểm tra JSON hỏng, checksum, schema và references.

## Bằng chứng kiểm thử

- `test/audit-v01-restart-matrix.test.js`: **16/16 đạt**, đủ 7 game và hai UNO, tại ranh giới sau bắt đầu và sau hành động. Child process dùng manager thật, SQLite thật và transport fixture để xác nhận thứ tự phát. So sánh đúng match/phase, bài, roles, stack/contributions, deck/piles, chip, pending decisions và receipts; sau reconnect kiểm tra quyền ghế và bài kín. Đối soát chính xác mọi balance, reservation, operation và ledger row trước/sau.
- `test/audit-v01-casual-commit.test.js`: **21/21 đạt**, commit lỗi khi bắt đầu/hành động, không phát thành công ở ghế/channel, rollback tiền/kết quả, retry cùng action, tombstone chống phục hồi phòng đã đóng, backup/restore từ export rỗng và JSON export bị lỗi rename. Ca timer UNO 112 kiểm tra rollback cửa sổ đã hết hạn, giữ retry tự động sau 30 giây và xử lý thành công khi storage phục hồi. Tất cả fixture trong thư mục tạm.
- Regression kết hợp A03, A04/storage, C04, C07, preflight/API/B08, nhóm qua 8 bàn, Gang/hai UNO/BANG và các ca recovery: **163/163 đạt** ở lần chạy chốt với timeout 15 giây/test, log `automation-overlap-v01-recovery-regression-20261006.log`.
- Browser The Gang đạt đầy đủ 6 ghế/Camera/Showdown, viewport 480/568/667/844/932, chiều cao 240px, safe area, fullscreen, QR, reconnect, host transfer và privacy; không lỗi trang hoặc request ngoài server.
- Browser UNO 108 và BANG! đạt với client/Socket.IO thật. UNO 112 còn có regression Socket.IO/reaction-window thật trong `test/uno-classic.test.js`.

Log: `test-results/automation-overlap-v01-{restart,casual-commit,recovery-regression,storage-contract,gang-browser,uno-browser,bang-browser}-20261006.log`. Các số liệu là phạm vi riêng, không đại diện cho full suite sau tích hợp C08. Chưa kiểm tra điện thoại hoặc WiFi thật. Không sửa dữ liệu người chơi, tạo database ví riêng, commit, push hay deploy.

Phạm vi đã nhả cho coordinator chính sau khi kiểm tra chốt. Một lượt trước đó của `uno-classic.test.js` treo ở worker và đã dừng đúng tiến trình test thuộc lượt này; chạy diagnostic TAP đạt 7/7. Đã chuyển coordinator nhận xét fixture phản ứng +4 ngẫu nhiên cần xóa `openingColorPending` khi chuẩn bị trạng thái thủ công và đăng ký cleanup sớm. Không báo lượt treo là đạt; lượt scoped cuối 163/163 ở trên đã hoàn thành.
