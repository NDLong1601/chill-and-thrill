# M3 — Hồ sơ, SQLite, ví chip và nhiệm vụ

Bạn đang làm việc trong dự án C:\Users\PC\Documents\chill-and-thrill.

Bối cảnh:
- Mở rộng The Gang hiện có thành cổng game LAN: Giải trí gồm The Gang, UNO, BANG!; Kịch tính gồm Poker, Tiến lên, Sâm lốc, Phỏm.
- Một máy chạy server, người chơi dùng thiết bị riêng cùng WiFi. Chip ảo dùng nội bộ cùng server; không có nạp/rút tiền hoặc quy đổi. Bot chưa thuộc phạm vi.
- Nền tảng ban đầu là Node.js, Express, Socket.IO, HTML/CSS/JavaScript. Kiểm tra hiện trạng thực tế trước khi sửa; không giả định kiến trúc vẫn giống bản ban đầu.
- Đọc docs/ke-hoach-cong-game.md, AGENTS.md nếu có, và tài liệu bàn giao của các mốc trước trong docs/milestones. Quyết định rõ ràng của người dùng được ưu tiên khi tài liệu khác nhau.

Cách làm:
1. Chỉ triển khai mốc được yêu cầu bên dưới. Kiểm tra các phần phụ thuộc đã hoạt động; hoàn thiện thiếu sót nhỏ liên quan trực tiếp. Nếu thiếu cả một mốc tiền đề, mô tả chính xác phần thiếu, tiếp tục phần độc lập và không giả vờ đã hoàn thành.
2. Giữ thay đổi hiện có của người dùng. Xác minh thư mục gốc Git trước thao tác Git; giới hạn công việc trong dự án này nếu repository gốc nằm ở thư mục cha.
3. Tận dụng code hiện có, tách trách nhiệm vừa đủ; giữ Node.js/Express/Socket.IO và module JavaScript nếu không có lý do cụ thể phải đổi. Không viết lại toàn bộ dự án hoặc tự bổ sung dịch vụ cloud.
4. Tự quyết định chi tiết kỹ thuật thông thường và ghi lại giả định. Chỉ hỏi khi thiếu quyết định thực sự làm thay đổi phạm vi/luật mà không có mặc định hợp lý; tiếp tục việc độc lập trong khi chờ.
5. Mọi tính năng cần chạy thật từ UI đến server và lưu trữ liên quan. Không dùng dữ liệu giả, TODO, nút không hoạt động hoặc kết quả do client tự khai để thay phần bắt buộc.
6. Giữ bài/vai bí mật ở server, chỉ gửi dữ liệu được phép cho từng người. Chip xếp hạng của The Gang hoàn toàn tách khỏi ví chip.
7. Kiểm thử phù hợp với thay đổi; dùng dữ liệu thử và database tạm, không reset dữ liệu chơi thật. Không làm yếu test chỉ để chạy xanh.
8. Hoàn thành triển khai và kiểm tra trong phạm vi mốc; không dừng ở đề xuất sẽ làm. Không tự triển khai mốc tiếp theo.


Mục tiêu: cung cấp danh tính bền vững, ví có sổ giao dịch và nhiệm vụ hoạt động thật; sẵn sàng cho game có chip ở M4. Không dùng một game cược giả để thay kiểm thử ví.

Đầu vào: M1; tích hợp The Gang và UNO nếu M2 đã hoàn thành.

Hồ sơ:
1. Hồ sơ server có ID ổn định, tên/avatar, lịch sử và ví. Không dùng socket ID hay nickname làm chủ sở hữu số dư.
2. Tạo nhanh không email; phiên xác thực bằng token đủ ngẫu nhiên. Tách token hồ sơ và quyền điều khiển ghế; hỗ trợ khôi phục/ghép thiết bị bằng cơ chế local rõ ràng.
3. Đổi nickname không tạo ví mới. Không lấy được hồ sơ người khác bằng tên hoặc playerId. Không log token/PIN; lưu bí mật khôi phục theo cách phù hợp.
4. Nhiều tab không cùng điều khiển ghế; một hồ sơ không tham gia hai bàn có chip cùng lúc.

Lưu trữ:
- Kiểm tra phiên bản Node và chọn thư viện SQLite tương thích, khóa dependency hợp lý; không nâng toàn bộ stack chỉ để thêm SQLite.
- Tạo schema có migration: players/sessions, rooms/members, matches/snapshots, wallets/ledger, reservations, mission definitions/progress/claims.
- Backup rooms.json, migration có version và chạy lại an toàn. Giữ phòng/token/lịch sử cũ; không ghép người chỉ vì trùng tên.
- Dữ liệu ví và mọi state quyết định thanh toán phải cùng ranh giới transaction. Sau commit mới phát sự kiện tới client; rollback cũng không để state RAM ở trạng thái chưa commit.
- Khôi phục server từ snapshot đã commit; migration lỗi không ghi đè nguồn. Viết hướng dẫn backup/restore/rollback có giới hạn phiên bản.

Ví:
- Chip số nguyên trong giới hạn an toàn, chặn âm, NaN, Infinity, vượt miền và payload giả.
- Cấp 1.000 chip mở đầu đúng một lần; cấu hình tách khỏi code luật.
- Có API/service nội bộ cho giữ chip, buy-in, chuyển stack/pot, thanh toán, giải phóng, thưởng. Client không có endpoint tùy ý đặt delta số dư.
- Mỗi nghiệp vụ có idempotency key ổn định và ràng buộc duy nhất trong DB. Cùng key khác payload phải bị từ chối, không âm thầm coi là yêu cầu cũ hợp lệ.
- Mọi thay đổi có dấu vết liên kết player/room/match/source. Thiết kế ledger để đối soát cả ví, khoản giữ, stack và pot.
- Transaction nhiều người là tất cả-hoặc-không; một người thiếu chip thì không trừ những người còn lại.
- Quyền chủ phòng không đồng nghĩa quyền quản trị chip. Cấp/reset cho buổi chơi nếu làm phải qua lệnh quản trị local có nhật ký, không để socket người chơi tự gọi.

Nhiệm vụ:
- Một ván hợp lệ/ngày +100; ba ván/ngày +200; hai game/ngày +150; hướng dẫn +200 một lần nếu có luồng hướng dẫn được server xác nhận thực chất.
- Không cấp thưởng hướng dẫn chỉ từ việc client gửi tutorial_completed; nếu chưa có bước xác minh thì giữ nhiệm vụ đó chưa mở và báo rõ.
- Nguồn tiến độ là kết quả đã commit, có match ID duy nhất. Ván hủy/thử/bot không tính; định nghĩa hoàn thành The Gang là hoàn thành cả trận, không cộng lại từng lần xem kết quả.
- Tính ngày theo Asia/Ho_Chi_Minh trên server. Lưu kỳ nhiệm vụ với sự kiện để replay qua nửa đêm không ghi sai ngày.
- Ghi tiến độ và kết quả trong cùng transaction hoặc có cơ chế phát lại sự kiện bền vững; không mất tiến độ nếu crash sau khi kết thúc ván.
- Nhận thưởng nguyên tử, một lần mỗi hồ sơ/nhiệm vụ/kỳ. Chọn rõ cách xử lý thưởng chưa nhận của ngày trước và hiển thị đúng.
- Không thay đổi điều kiện một nhiệm vụ đang diễn ra mà không version hóa.

UI:
- Hồ sơ, số dư khả dụng/đang giữ, lịch sử chip có lý do, tiến độ nhiệm vụ và nhận thưởng.
- Thiếu chip vẫn vào Giải trí. Không tăng số dư lạc quan trước khi server xác nhận.
- Hiển thị server local là phạm vi dữ liệu, lỗi lưu trữ và trạng thái khôi phục dễ hiểu.

Kiểm thử bắt buộc:
- Migration fixture cũ, chạy migration lại, dữ liệu hỏng và rollback trên bản sao.
- Hai yêu cầu đồng thời tiêu cùng ví; hai người cùng bắt đầu bàn; một người thiếu chip.
- Nhận thưởng đồng thời, lặp action, đổi ngày, replay kết quả, nhiều tab.
- Crash trước/sau commit và sau commit nhưng trước gửi ack: chạy lại chỉ có một giao dịch.
- Tổng tài sản bằng số đầu + nguồn thưởng/quản trị hợp lệ; các giao dịch nội bộ không sinh chip.
- DB tạm thực sự cho test transaction, không chỉ mock service.
- Hồi quy The Gang/UNO và khôi phục ghế cũ.

Tiêu chí hoàn thành: hồ sơ/ví/nhiệm vụ dùng được qua UI, có bằng chứng về tính nguyên tử và chống giao dịch lặp, không có đường client tự cộng tiền.

Bàn giao:
- Cập nhật docs/milestones/M3.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

