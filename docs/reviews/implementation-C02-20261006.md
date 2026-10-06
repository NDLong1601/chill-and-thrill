# C02 — Luyện tập với bot

Ngày 06/10/2026. **Hoàn tất** UNO112 và Tiến lên, trang luyện tập, route server chính và link từ chi tiết game.

PracticeService quản lý phiên finite trong bộ nhớ, capability ngẫu nhiên băm phía server, expiry/capacity, revision và actionId. Không nhận production ProfileStore, profile token hay real room manager. Tiến lên dùng manager cùng validator play/pass với reservation stub riêng trong phiên; UNO112 dùng engine server và legal actions thực. Bot chỉ nhận projection gồm bài của ghế mình và dữ liệu công khai; không có bài đối thủ, draw pile hoặc ledger. Số bước bot hữu hạn, nhường event loop định kỳ.

Trang `/practice` chọn game, đánh bài/rút/chọn màu/bắt lỗi UNO hoặc tổ hợp Tiến lên, chơi ván tiếp và đóng phiên. Reload cùng tab tiếp tục phiên còn hạn; blocked sessionStorage vẫn giữ được phiên đang mở. Phiên mới mở lựa chọn game trước khi chia lại và đóng phiên cũ. Điểm luyện tập không thay coin/chip/gem, nhiệm vụ, hồ sơ hoặc xếp hạng. UNO108 vẫn có engine/link sản phẩm riêng; luyện tập 108 ghi rõ chưa hỗ trợ, API từ chối thay vì chạy nhầm 112.

HTTP practice routes riêng dùng Bearer capability và no-store; unauthorized không trả state. Lifecycle server cleanup/close xóa phiên; không tạo database ví hoặc room file luyện tập. Portal chi tiết UNO/Tiến lên có link luyện tập và chọn đúng game khi mở.

Kiểm chứng **8/8** test: chơi hết ván seeded UNO/Tiến lên qua validator thật, bot privacy, revisions/idempotency/expiry/capability, routes server chính không đổi wallets/ledger/operations/reservations/rooms/matches/mission claims/snapshots của SQLite fixture. Standalone browser và product browser từ portal đạt UNO, action, reload, đổi sang Tiến lên, cleanup, mobile/desktop và không request ngoài server. Log `automation-c02-{node,browser,product}-20261006.log` trong test-results. Product browser chạy với PRACTICE_PRODUCT=1.

Coordinator sửa mapping kebab IDs → camel keys gây trang không chạy và hoàn thành production integration/QA khi feature chat có approval pending; không đổi permissions. Không dùng dữ liệu người chơi, không commit/push/deploy. Browser viewport giả lập, chưa kiểm tra thiết bị/WiFi thật; chưa nghiệm thu toàn bộ audit trước V01.
