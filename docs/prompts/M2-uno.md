# M2 — UNO và hoàn thiện cơ chế thêm game

Bạn đang làm việc trong dự án C:\Users\PC\Documents\the-gang.

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


Mục tiêu: UNO là game Giải trí thứ hai, chơi trọn ván và hoạt động độc lập với các phòng The Gang.

Đầu vào: registry, phòng chung, routing, adapter và hợp đồng module từ M1.

Luật:
1. Xác định bộ UNO cơ bản/phiên bản sử dụng; tra cứu tài liệu của nhà phát hành đúng phiên bản, lưu link tham khảo và quyết định vào docs/rules/uno.md.
2. Ghi rõ số người được hỗ trợ, bộ bài/số lượng từng loại, chia bài, lá mở đầu, đánh/rút, đổi chiều, bỏ lượt, Wild, Draw Two, Wild Draw Four, điều kiện phản đối và phạt.
3. Mặc định không cộng dồn phạt rút, không nhảy lượt và không đánh nhiều lá cùng lúc; nếu nguồn đã chọn khác thì giải thích và chốt nhất quán.
4. Đặc tả gọi UNO, cửa sổ bắt lỗi, thời điểm hết cửa sổ, thứ tự xử lý khi lá cuối có hiệu ứng và khi chồng rút hết.
5. Bản đầu dùng một ván có người hết bài làm đơn vị kết quả; chưa cần vòng đua tích điểm nhiều ván. Ghi rõ ranh giới ván/trận cho nhiệm vụ sau.
6. Nếu chưa truy cập được nguồn, ghi rõ phần nào là luật local thay vì gắn nhãn chính thức không có căn cứ.

Triển khai:
- Bộ bài riêng UNO, ID duy nhất cho từng lá kể cả nhiều lá có cùng màu/số; không dùng trực tiếp deck 52 lá.
- Engine có trạng thái lượt/hướng, chồng rút/bỏ, màu hiện hành, phạt chờ xử lý, cửa sổ phản ứng và kết quả.
- Các action chỉ hợp lệ cho đúng người và đúng giai đoạn; có kiểm tra lại revision và chống gửi trùng.
- Server chỉ gửi bài riêng; số lá trên tay người khác là public. Phản đối +4 không làm lộ bài ra toàn bàn.
- UI chọn lá, chọn màu, rút/đánh theo luật, gọi UNO và phản đối khi hợp lệ; thể hiện rõ lượt và hướng đi.
- Khôi phục giữ đúng lượt, bài, màu, phạt và cửa sổ phản ứng. Đồng hồ phản ứng phải thuộc server và có chính sách pause/restart rõ.
- Dùng sảnh/phòng/QR/chuyển host chung; không sao chép nguyên khối quản lý phòng của The Gang.
- Cung cấp rules/help dễ đọc, kết quả và chơi tiếp cùng phòng.
- Chuẩn bị sự kiện hoàn thành ván có ID ổn định cho M3; nếu M3 chưa có thì không tự tạo ví hoặc cộng chip.

Kiểm thử:
- Bộ bài đúng số lượng, không mất/nhân đôi lá qua rút và xáo lại.
- Các lá chức năng, bàn hai người, lá đầu/lá cuối, chồng rút hết.
- Gọi/bắt lỗi UNO đúng cửa sổ; phản đối +4 thành công/thất bại theo luật đã chốt.
- Action không hợp lệ không làm thay đổi state.
- Hai phòng UNO và một phòng The Gang chơi đồng thời không lẫn dữ liệu.
- Reconnect/restart tại lượt thường và cửa sổ phản ứng.
- UI chọn bài trên màn hình nhỏ, thiếu người, người mất kết nối, ván kết thúc.

Tiêu chí hoàn thành: UNO được đánh dấu playable chỉ khi luồng từ tạo phòng đến kết quả/chơi tiếp hoạt động, tài liệu và engine thống nhất; hồi quy The Gang vẫn đạt.

Bàn giao:
- Cập nhật docs/milestones/M2.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

