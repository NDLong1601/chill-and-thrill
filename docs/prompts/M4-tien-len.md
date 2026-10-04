# M4 — Tiến lên và game Kịch tính đầu tiên

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


Mục tiêu: Tiến lên miền Nam chơi được trọn ván với chip thật trong hệ thống local, dùng ví M3.

Đầu vào: M1, M3; nền tảng card UI dùng chung nếu đã có M2.

Luật và thanh toán:
1. Đọc quyết định luật có sẵn. Nếu chưa có, chọn biến thể Tiến lên miền Nam local cho 2–4 người, 13 lá mỗi người, và viết docs/rules/tien-len.md trước khi viết engine.
2. Chốt tường minh thứ tự quân/chất, lượt mở đầu khi không chia hết bộ, lượt mở ván sau, lẻ/đôi/sám/sảnh, tứ quý/đôi thông, giới hạn lá 2 và tổ hợp được chặt.
3. Chốt bỏ lượt và quyền vào lại vòng, người được dẫn vòng mới, điều kiện tới trắng, thứ tự ưu tiên nếu nhiều người có thắng đặc biệt.
4. Phân biệt luật đánh bài với luật thanh toán. Nếu chưa có quyết định khác, dùng bản đầu: kết thúc khi một người hết bài hoặc thắng đặc biệt theo luật; mỗi người góp cùng mức cố định, người thắng nhận pot. Ghi rõ là cách tính chip local.
5. Chặt hợp lệ vẫn theo luật đã chọn nhưng không tự phát sinh khoản phạt ngoài bảng thanh toán. Nếu mở thối/cóng/đền bằng chip, phải đặc tả và tính cận trên khoản phải giữ trước khi cho chọn.
6. Hiện bảng thanh toán và mức mất tối đa ngay tại tạo phòng/phòng chờ. Không thay luật hoặc mức chip giữa ván.

Engine và UI:
- Dùng bộ 52 lá chuẩn, chia/xáo phía server. Các action play/pass được kiểm tra bài sở hữu, tổ hợp, quyền lượt và trạng thái vòng.
- Cung cấp chọn nhiều lá, sắp xếp theo giá trị/chất, đánh/bỏ lượt, xem tổ hợp đã chọn và thông báo lý do đánh không hợp lệ.
- Các gợi ý phía client chỉ dựa vào bài người đó và dữ liệu công khai; server kiểm tra lại.
- Ghế hiện số lá còn lại, lượt hiện tại, trạng thái đã bỏ vòng và kết nối.
- Start ván giữ đủ chip cho toàn bàn trong một transaction. Chia bài, snapshot đầu và giữ chip không được lệch nhau khi có lỗi.
- Kết thúc ghi kết quả, thanh toán và sự kiện nhiệm vụ đúng một lần. Ván mới kiểm tra số dư lại, không tự chơi tiếp nếu thiếu chip.
- Rời giữa ván không trả chip ngay; hỗ trợ yêu cầu rời sau ván. Mất mạng tạm dừng theo chính sách của nền tảng.
- Hủy ván có chính sách và audit rõ, chỉ đảo khoản chưa chốt; không sửa kết quả ván trước.

Kiểm thử:
- Tổ hợp hợp lệ/không hợp lệ, bộ có lá 2, chặt, tới trắng và quy tắc bỏ vòng.
- Bàn 2/3/4 người; không giả định lá mở bắt buộc luôn được chia.
- Đánh lặp, action ngoài lượt, dùng bài người khác, revision cũ.
- Bốn người góp 100, người thắng có delta +300, ba người còn lại -100; pot đóng về 0, không phí.
- Một người thiếu chip: không ai bị giữ tiền một phần.
- Crash lúc giữ chip, lượt đánh và thanh toán; reconnect/restart không sinh hoặc mất chip.
- Chơi lại với người thiếu tiền; rời bàn và dọn phòng không để khoản giữ treo.
- Nhiệm vụ hoàn thành tăng đúng một lần; các game giải trí vẫn chạy bình thường.

Tiêu chí hoàn thành: Kịch tính có game thật từ home đến thanh toán và chơi tiếp; mọi biến thể được bật đều có luật và khoản giữ đủ.

Bàn giao:
- Cập nhật docs/milestones/M4.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

