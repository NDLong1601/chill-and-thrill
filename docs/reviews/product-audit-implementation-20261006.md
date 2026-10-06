# Tiến độ hoàn thiện product-audit-20261005

Ngày bắt đầu: 06/10/2026. Workspace: `C:\Users\PC\Documents\chill-and-thrill`.

Yêu cầu: mỗi tính năng bắt đầu trong một chat riêng, triển khai chi tiết và kiểm thử cẩn thận. Các chat dùng chung working tree hiện tại; phần có phụ thuộc hoặc cùng sửa một file phải chạy lần lượt. Giữ các thay đổi chưa commit và dữ liệu người chơi. Không có DB ví thứ hai; mọi fixture dùng bộ nhớ hoặc thư mục tạm.

**Checkpoint mới 06/10/2026 11:06 Asia/Saigon:** 21 hạng mục vẫn hoàn tất. Đối chiếu hash xác định bốn tệp UI/navigation đổi sau nghiệm thu; đã kiểm tra lại **14 bộ browser liên quan, tất cả đạt**. Tìm và sửa `resumeRoom()` thiếu đích quay về sảnh; bổ sung regression create/join/resume/reload/leave và giữ legacy links. Backend/Node test không đổi; giữ bằng chứng 448/448 từ lượt trước, không báo là chạy mới. Chi tiết ở [báo cáo delta V01](implementation-V01-delta-20261006.md). Không mở thêm chat tính năng trùng.

**Checkpoint chốt 06/10/2026 10:13 Asia/Saigon:** hoàn tất 21 hạng mục triển khai và cổng V01 tự động. Full Node **448/448**, fail/cancelled/skipped = 0; 36 bộ browser/vận hành đạt. Các fixture dùng dữ liệu tạm, dữ liệu người chơi được giữ nguyên. Điện thoại/WiFi thật, nhấp đúp launcher bằng UI và tải mục tiêu chưa xác minh. Chi tiết ở [báo cáo V01](implementation-V01-20261006.md).

Baseline lịch sử đầu lượt: `npm test` đạt **144/144**, không lỗi, 06/10/2026; khác số 142 trong audit gốc.

| Mã | Phạm vi và điều kiện hoàn thành | Trạng thái | Chat |
|---|---|---|---|
| A01 | Snapshot + ledger nguyên tử cho Tiến lên/Sâm/Phỏm; rollback, recovery, đối soát HELD, fault/crash tests | Hoàn tất; npm test 172/172 và browser 3 game đạt | 01a10d3b-4bc9-7dd2-83bb-ae87f6c35229 |
| A02 | Poker reconnect chỉ chờ ghế có ảnh hưởng hand, đồng hồ tiếp tục đúng | Hoàn tất; 11/11 test Poker và browser đạt | 01a10d3b-5725-7961-8778-4910797b6aad |
| A03 | Reconnect hữu hạn, chính sách từng game, thanh toán một lần, UI người chờ/thời hạn/rời sau ván | Hoàn tất; focused 66/66 + A02 3/3 và coin/Poker browser đạt; nhả engine/client | 01a10d6e-8fe6-7993-a352-b786a15dd18d |
| A04 | Trạng thái đọc/ghi mọi manager, commit/export phân biệt, cảnh báo và chặn cược không an toàn | Hoàn tất bởi coordinator; 31/31 scoped + fault/browser, full 313/313; nhả backend cho B01 | 01a10d7d-5db8-7390-a013-38b5bedab0ba |
| A05 | Cược/mức giữ/tiền tệ hiển thị nhất quán từ server, bao gồm phòng chip cũ | Hoàn tất A05 và native limits A07; các browser regression đạt | 01a10d4a-283a-7853-8ff2-b189163fcca9 |
| A06 | Giữ avatar/tên khi reload/create/join, chỉ PATCH trường đã sửa, chống fetch cũ | Hoàn tất; regression identity và portal browser đạt | 01a10d3b-60d3-7533-a639-97e6a570d40e |
| A07 | Validator tiền tệ chung, giới hạn stake/hold/win thống nhất server và registry | Hoàn tất; 199/199, cận tiền và fixture không ngẫu nhiên | 01a10d54-5446-73f0-8a5e-f9fa9559824b |
| B01 | Trước khi bắt đầu: số dư/mức giữ/số thiếu/người chưa ready và lý do host chưa start được | Hoàn tất; scoped 30/30, harness và 8 waiting variants + host/guest product browser đạt | 01a10e84-6ef4-7921-b1ef-8ec204b71c19 |
| B02 | Ví và lịch sử chung: delta khả dụng/giữ/tổng, nhóm match/currency, biên nhận và tìm theo game/ngày/nhóm | Hoàn tất bởi lượt kế tiếp; scoped 30/30 và history/profile/B03 browser đạt | 01a10d72-d778-7cc2-820a-875ef915eb2b |
| B03 | Quy đổi: xem trước trừ/nhận, mức tối đa, vai trò gem và giải thích nhịp thưởng; giữ tỷ lệ hiện có | Hoàn tất; quote bảo vệ sức chứa A07, browser và test tổng đạt | 01a10d50-d094-75f2-9d76-be827b304b06 |
| B04 | Trang chủ mobile: danh mục rút gọn, game gần đây/yêu thích, create/join nhanh và luật chi tiết | Hoàn tất; 199/199 và browser 320/390/844/1280 cùng A05/A06/portal đạt | 01a10d62-1b89-7cb2-83e5-38743518f9ae |
| B05 | Hướng dẫn tình huống từng game/biến thể, lỗi dễ hiểu; tutorial_verified được server xác minh theo phiên bản | Hoàn tất; scoped 40/40, tutorial SQLite thật và context-help browser 8 biến thể đạt | 01a10d75-50f6-7f70-9838-dc5226aa138a |
| B06 | Bàn mobile: nhấn mạnh lượt, tùy chọn bài/chữ/âm thanh/giảm chuyển động, viewport tests | Hoàn tất; 20/20 UI scoped, harness, tám bàn product/context và Gang 240px/6 ghế đạt; nhả frontend | 01a10e87-17cc-7ea2-9236-d4ac43dfdca2 |
| B08 | Hợp đồng adapter create/join/resume/action/result và API client chung, chuyển dần có regression | Hoàn tất tích hợp portal gradual; 11/11 gồm Socket result/privacy hai UNO và portal browser đạt | 01a10eaf-af7a-72e2-a9c9-3311533d9242 |
| C01 | Giữ nhóm đổi game: lobby/đề xuất/xác nhận, không gửi lại mã, settle/cash-out trước | Hoàn tất; 13/13 + nhóm bốn người qua tám bàn 9/9 và product invite/consent/handoff/resume đạt | 01a10ebb-8d60-7c70-8f60-28fea023d6fc |
| C02 | Bot luyện tập UNO/Tiến lên dùng validator server và state hợp lệ, không tác động ledger thật | Hoàn tất; 8/8 + standalone/product browser qua portal, không đổi shared ledger | 01a10e9a-aea7-7fe1-b36c-3bfbba13362d |
| C04 | Backup nhất quán, schema/manifest/checksum, phục hồi thử trên dữ liệu tạm, bảo toàn hồ sơ/hold/phòng | Hoàn tất module/CLI stopped-server và runbook; full 313/313 gồm symlink, có npm aliases | 01a10e8e-5433-72a1-af92-3011c75066d6 |
| C05 | Admin LAN: IP/QR/phòng/kết nối/storage/maintenance, xác thực chủ máy và biên nhận can thiệp | Hoàn tất; scoped 12/12 + actual admin browser/QR/maintenance/receipt bốn viewport đạt; nhả backend C01 | 01a10eb4-bb8e-7251-8c1e-1b082c4ae8cf |
| C06 | Bộ chạy một lần bấm: start/stop an toàn, IP/QR, đường dẫn dữ liệu và backup dễ dùng | Hoàn tất; lifecycle 6/6 + UI harness + actual child và control browser/QR/backup/restore đạt; nhả file | 01a10eb6-3da0-7ef0-865d-a2bae90874b3 |
| C07 | Khán giả: kênh public riêng, chính sách vào bàn/đổi vai trò, không lộ bài qua socket/API | Hoàn tất; 17/17 + product tám bàn, reconnect mật khẩu, role/privacy/ledger và bốn viewport đạt | 01a10ebe-f7ab-7932-ad05-417abaffe279 |
| C08 | Giải đấu/xếp hạng nhóm: luật điểm, idempotent results, tách khỏi cấp coin | Hoàn tất; 21/21 scoped, production hai vòng/roster lock/replay/restart/bốn viewport, không đổi ledger | 01a10ebf-9893-7433-961c-f4a22f28b8f0 |
| V01 | Kiểm tra tích hợp cuối: 7 regression, fault/restart, nhiều tab, bảo toàn tiền, browser suites | Đạt nghiệm thu tự động; 448/448 Node và 36 browser/vận hành, recovery cả tám target; giới hạn thiết bị/tải ghi rõ | 01a10ebd-8fd2-7f92-a658-8b0466a0434f |

B02 hợp nhất hai đề xuất cùng phạm vi dữ liệu: “Ví và lịch sử” và “Lịch sử chung”. Vòng đời kết nối triển khai cùng A02/A03. Kiểm thử là yêu cầu của mọi chat và có cổng tích hợp cuối V01.

Kiểm tra điện thoại/WiFi thật chỉ được ghi nhận nếu thực sự thực hiện; viewport mô phỏng không được báo là kiểm thử thiết bị thật. Các thay đổi kinh tế không được tự đổi tỷ lệ hoặc giá trị tài sản người chơi.

## Điều phối khi các lượt automation chồng nhau

Checkpoint hiện tại: các feature đã nhả file; V01 gốc chốt tại chat `01a10f2d-391c-7882-8a59-04ec9b04c4ed`, delta QA chốt tại chat `01a10f5f-bc9e-73e1-b7b9-2d01ad41dffe`. Không còn implementation owner đang hoạt động. Những checkpoint bên dưới là lịch sử; không dùng chúng để mở lại feature đã hoàn tất hoặc tạo chat trùng. Lượt automation sau đối chiếu `test-results/product-audit-delta-20261006.json` trước khi quyết định có cần QA/sửa thêm.

Checkpoint mới 06/10/2026 07:02 Asia/Saigon: các coordinator cũ và A03/A04 bị dừng do usage limit. Coordinator `01a10e82-f52b-7900-97f5-ef24296aac90` tiếp nhận queue/memory, tiếp tục đúng chat A03/A04, không tạo chat sửa lỗi trùng. B05 đã hoàn tất theo báo cáo và kiểm tra của coordinator trước. A03 vẫn sở hữu engine/client/clock/rules; A04 được nối store/service/routes/profile UI, chỉ sửa manager khi A03 nhả phạm vi. B01 mới chỉ sửa module/tests/report riêng, chờ A04 trước tích hợp shared state/client.

Kiểm tra toàn bộ đầu lượt này: **245/246 đạt**, một ca A03 rollback dùng tham chiếu player cũ sau khi wrapper thay children; A03 đang xác minh state authoritative và thêm regression nested cleanup/retry. Log: `test-results/automation-resume-full-node-20261006.log`. Không coi full suite đã đạt.

Các đoạn phía dưới là checkpoint lịch sử của lượt trước, không còn là khóa sở hữu hiện tại.

Checkpoint 07:12: A03 chốt focused 66/66 + A02 3/3, browser coin/Poker đạt và nhả engine/client. A04 tiếp nhận toàn bộ backend; B06 tiếp nhận game HTML/client/portal frontend, A04 chỉ nối profile UI/module cảnh báo riêng. B01 còn sửa module/tests và đợi cả A04/B06 nhả integration. Root đã ổn định shuffle của fixture A01 dùng chung; scoped A01 25/25 đạt. C04 bắt đầu ở chat riêng, chỉ module/CLI/tests mới. Full suite gần nhất trong lúc B01 đang làm là 251/261 (10 lỗi fixture preflight), chưa phải cổng nghiệm thu chung.

Checkpoint 07:27: kiểm tra tổng tại root đạt **269/269**, log `test-results/automation-backend-integration-20261006.log`; collector/store A04 13/13 đạt. Đây là checkpoint working tree hiện tại, chưa phải nghiệm thu A04/B01/B06/C04/C02: các phần UI/fault/integration mới vẫn đang làm. C02 mở chat riêng cho sandbox luyện tập trong bộ nhớ. B01 renderer/harness đã đạt 15/15 và đang bổ sung module server riêng.

Lượt 01:07 (chat `01a10d3f-3276-7de2-a17e-594567b85051`) đang hoàn tất A03 và sở hữu cập nhật bảng tiến độ/memory đến khi kết thúc lượt này; B04 và A05 followup native limits đã hoàn tất. Lượt kế tiếp (chat `01a10d71-21ab-7713-8638-7a68a5222320`) triển khai B02: các method đọc/history của ProfileStore, route history hẹp, profile UI/module history riêng; không sửa portal/index/app.js hay engine. A03 không sửa ProfileStore/ProfileService/httpServer trong lúc B02 sở hữu các file đó.

B02 đã chốt implementation và scoped QA dù chat còn yêu cầu quyền chạy test; coordinator lượt kế tiếp chạy và kiểm tra các test được ủy quyền bằng tool local, không đổi thiết lập quyền. B05 backend/store/routes đã qua scoped 24/24 và browser SQLite thật trên dữ liệu tạm; context-help 14/14 qua tám biến thể. A03 đã công bố mở riêng HTML append-only cho các stylesheet/script hướng dẫn, không sửa banner/buttons; game client/rules vẫn do A03 sở hữu. A04 có module diagnostics/test 7/7 đạt và đã được mở store/service/routes/profile UI sau phần backend B05; engines/completedRoom/coinRoomTransactions/multigame vẫn chờ A03. Lượt kế tiếp mở các phạm vi tích hợp theo thứ tự sau khi chủ file hoàn tất. Sau A03, lượt 01:07 cập nhật checkpoint và bàn giao các tính năng còn lại; không tạo thêm feature từ lượt cũ, tránh chat trùng và xung đột file.

Kiểm tra toàn bộ trong lúc A03 đang sửa: 209/221 đạt, 12 lỗi vòng đời/fixture đã chuyển A03 xử lý (`test-results/b02-full-node-20261006.log`). Kết quả này không được báo là full suite đạt. B02 có 30/30 scoped unit và browser history/profile/quy đổi đạt; kiểm tra toàn bộ sẽ chạy lại sau khi A03 chốt.
