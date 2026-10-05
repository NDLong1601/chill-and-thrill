# M6A — Sâm lốc

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


Mục tiêu: thêm Sâm lốc vào Kịch tính, có luật riêng, chip và nhiệm vụ; không chỉ đổi tên Tiến lên.

Đầu vào: phòng/module game, ví và cơ chế thanh toán từ M3–M4. Tận dụng công cụ bài/tổ hợp khi ngữ nghĩa thực sự giống nhau, không dùng điều kiện rải rác làm hai engine lẫn luật.

Đặc tả:
1. Tạo docs/rules/sam-loc.md, chốt số người, số bài, thứ tự lá, có/không phân chất khi so, lẻ/đôi/sám/sảnh/tứ quý, lá 2 và các giới hạn cuối bài.
2. Chốt vòng đăng ký báo Sâm: ai được đăng ký, thời hạn, xử lý nhiều người báo, thứ tự ưu tiên ổn định, khi nào bắt đầu và kết thúc.
3. Chốt báo Sâm thành công/thất bại, ai được chặn, trách nhiệm đền, báo một và quy tắc đánh khi người kế tiếp còn một lá.
4. Chốt thắng đặc biệt, thối và kết thúc; trường hợp cùng đủ điều kiện có thứ tự xử lý rõ.
5. Viết bảng thanh toán local theo từng nguyên nhân, thứ tự áp dụng và các khoản loại trừ nhau. Không suy diễn đền bằng một mức “phạt chung”.
6. Tính mức thua lớn nhất theo số người và cấu hình: maxLoss(player, config). Viết ví dụ chứng minh khoản giữ đủ cho cả đền Sâm và các phạt có thể cộng dồn hợp lệ.
7. Khi không có nguồn thống nhất do luật vùng miền, chọn một biến thể local minh bạch, không gọi đó là luật duy nhất.

Triển khai:
- State machine có đăng ký Sâm, chơi thường, thực hiện Sâm, báo một, kết quả theo luật đã chốt.
- Action báo/chặn/pass/play do server xác nhận. Lưu cửa sổ phản ứng và chính sách xử lý action sát hạn để reconnect không làm ai được thêm quyền.
- UI nêu rõ người báo Sâm, mức trách nhiệm chip, giai đoạn hiện hành, lượt, bài đã đánh, báo một và hành động hợp lệ.
- Tạo phòng/phòng chờ hiển thị đơn vị chip, bảng thanh toán, khoản giữ tối đa. Đổi cấu hình yêu cầu sẵn sàng lại.
- Giữ chip toàn bàn nguyên tử trước ván; settlement có ID duy nhất và diễn giải từng khoản.
- Thiếu tiền trước ván thì không bắt đầu. Không cắt phạt sau kết quả chỉ vì khoản giữ tính thiếu; coi đó là lỗi cần sửa trước khi phát hành.
- Dùng hồ sơ, nhiệm vụ, lịch sử và reconnect chung; không tạo ví riêng cho Sâm.

Kiểm thử:
- Nhiều người báo gần đồng thời, báo trễ, reconnect trong cửa sổ đăng ký.
- Sâm thành công/thất bại, có người chặn, báo một, kết thúc bằng lá bị cấm nếu có.
- Các tổ hợp giống Tiến lên nhưng khác cách so phải có test phân biệt.
- Ma trận bảng phạt/đền, khoản loại trừ nhau, trường hợp thua lớn nhất, bảo toàn chip.
- Replay settlement và restart tại giai đoạn báo Sâm/giữa ván/kết quả.
- Hai phòng Sâm cùng với Poker và The Gang không ảnh hưởng nhau.

Tiêu chí hoàn thành: biến thể duy nhất được mô tả đầy đủ và khớp code; báo Sâm/đền là tính năng thực sự; mọi khoản thanh toán giải thích và được bảo đảm trước ván.

Bàn giao:
- Cập nhật docs/milestones/M6A.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

