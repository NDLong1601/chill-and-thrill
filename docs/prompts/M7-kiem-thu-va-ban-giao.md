# M7 — Kiểm thử tích hợp, ổn định LAN và bàn giao

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


Mục tiêu: kiểm chứng cổng game trên toàn bộ phạm vi đã phát hành, sửa lỗi tích hợp và tạo quy trình vận hành local có thể làm theo.

Đầu vào: các mốc triển khai, tài liệu luật và báo cáo kiểm thử. Kiểm kê game thực sự playable; game chưa hoàn thành vẫn để “Sắp có” và báo thiếu so với kế hoạch, không đổi nhãn để vượt nghiệm thu.

Công việc:
1. Lập ma trận game × số người × thiết bị × tình trạng mạng × trạng thái lưu trữ. Chạy baseline toàn bộ test trước khi sửa; liên kết mỗi lỗi với ca tái hiện.
2. Kiểm thử end-to-end: home → chọn chế độ → game → tạo/vào phòng → ready → chơi → kết quả → nhiệm vụ → chơi tiếp/rời bàn. Bao gồm link mời, QR, link cũ, reload và back/forward.
3. Chạy nhiều phòng thuộc cả hai chế độ cùng lúc. Kiểm tra host rời, người chơi rời, người mới vào, nhiều tab cùng hồ sơ, đổi nickname, hồ sơ hết chip.
4. Kiểm tra disconnect/reconnect, pause/timer, server restart giữa lượt, phản ứng và settlement. Dùng tiến trình/database thử; không dừng phiên chơi thật mà không có ngữ cảnh cho phép.
5. Kiểm tra tính nguyên tử bằng fault injection có kiểm soát: trước/sau giữ chip, trước/sau commit kết quả, sau commit trước ack, lúc nhận nhiệm vụ. Tính lại tổng ví/stack/pot/khoản giữ và đối chiếu ledger.
6. Kiểm tra payload quyền truy cập: giả playerId, gọi action ngoài phòng/lượt, action lặp/cũ, thay amount, yêu cầu admin từ tài khoản thường; kiểm tra rate limit và payload size phù hợp.
7. Kiểm tra bài/vai/token không lộ qua snapshot, log, lỗi, lịch sử, danh sách phòng, người bị loại hoặc link chia sẻ.
8. Kiểm tra UI ở desktop và viewport mobile dọc/ngang: overflow, nút bị che, chọn bài dài, nhiều ghế, modal, bàn phím nhập mã, focus, tương phản, mục tiêu chạm, âm thanh và fullscreen.
9. Phân biệt rõ browser giả lập viewport với thiết bị thật. Nếu có thiết bị thật và công cụ phù hợp thì thử LAN thực tế; nếu không, viết checklist thao tác cụ thể cho người dùng và đánh dấu chưa xác minh, không bịa bằng chứng.
10. Kiểm tra LAN không Internet sau cài đặt: tài nguyên/font/Socket.IO không phụ thuộc CDN; QR dùng IP LAN phù hợp. Không tắt mạng máy người dùng để thử; dùng môi trường kiểm thử có kiểm soát.
11. Đo tài nguyên theo tải local hợp lý đã khai báo: số phòng, số client, thời gian test, latency xử lý, tần suất ghi DB, memory sau tạo/rời phòng nhiều lần. Tìm listener/timer không cleanup. Chỉ tối ưu vấn đề có số đo hoặc lỗi cụ thể.
12. Hoàn thiện validation cấu hình, thông báo lỗi và khả năng khởi động lại. Khi DB lỗi, không tiếp tục nhận hành động có chip như đã lưu thành công.
13. Tạo hướng dẫn Windows: phiên bản Node hỗ trợ, npm install/npm start, cổng/IP LAN, xử lý xung đột cổng, truy cập cùng WiFi, vị trí dữ liệu/log. Không tự mở firewall hoặc công khai server ra Internet.
14. Tạo quy trình backup/restore đã thử trên bản sao. Với SQLite đang ghi, dùng phương pháp backup nhất quán hoặc dừng ghi đúng cách, không chỉ copy mỗi file DB rồi bỏ qua WAL. Restore phải gồm schema/version tương thích.
15. Cập nhật README, changelog, release checklist và danh sách hạn chế thật. Sửa lỗi trong phạm vi phát hành, không thêm bot, giải đấu hoặc framework mới.

Bằng chứng đầu ra:
- docs/qa/release-matrix.md: từng ca, môi trường, kết quả, bằng chứng/lỗi.
- docs/operations/local-server.md: chạy và xử lý sự cố.
- docs/operations/backup-restore.md: backup/restore/rollback đã thử.
- docs/qa/manual-device-checklist.md: phần thiết bị thật cần người dùng thực hiện nếu chưa truy cập được.
- Báo cáo đối soát chip từ dữ liệu thử và ảnh UI của các màn chính khi công cụ hỗ trợ.

Tiêu chí hoàn thành:
- Các test bắt buộc chạy đạt; phần không thể chạy ghi rõ nguyên nhân và tác động.
- Mỗi game được công bố playable có luồng end-to-end và luật tương ứng.
- Không còn lỗi đã biết làm lộ bài/vai, tạo/mất chip, thanh toán lặp hoặc làm hỏng dữ liệu.
- Khôi phục và backup/restore có bằng chứng; bộ cài/chạy local thực hiện được theo hướng dẫn.
- Nếu vẫn còn lỗi chặn, báo mốc chưa hoàn tất và nêu đúng phần còn thiếu; không tuyên bố chương trình sẵn sàng chỉ vì unit test xanh.

Bàn giao:
- Cập nhật docs/milestones/M7.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

