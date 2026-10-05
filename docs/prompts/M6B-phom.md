# M6B — Phỏm

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


Mục tiêu: thêm Phỏm vào Kịch tính với bốc/ăn/đánh/hạ/gửi và thanh toán hoàn chỉnh cho một biến thể xác định.

Đầu vào: hồ sơ/ví/phòng chung và kinh nghiệm settlement từ các mốc trước. Chưa cần AI hoặc nhiều biến thể.

Đặc tả:
1. Tạo docs/rules/phom.md, chốt số người hỗ trợ, chia bài, người có thêm lá và đánh đầu, thứ tự lượt/vòng, số lượt bốc và điều kiện hết ván.
2. Định nghĩa phỏm bộ và dây, cách tính bài rác, A/J/Q/K, thứ tự hạ và cách phân xử bằng điểm.
3. Chốt ăn lá vừa đánh, nghĩa vụ lá ăn phải nằm trong phỏm, các phỏm chồng lấn và điều kiện lựa chọn tổ hợp.
4. Chốt ù/ù tròn nếu hỗ trợ, móm, ăn chốt, đền, gửi bài, tái lượt nếu có và quan hệ giữa các luật này.
5. Lập bảng chip: xếp hạng, ăn bài, ăn chốt, ù, đền, thứ tự và việc khoản nào thay thế khoản nào. Ghi rõ luật local nếu nguồn không thống nhất.
6. Tính cận trên trách nhiệm mỗi người từ tất cả trạng thái có thể xảy ra theo cấu hình. Nếu không chứng minh khoản giữ đủ thì chưa bật biến thể đó.

Triển khai:
- State machine phân biệt chờ bốc/ăn, chờ đánh, hạ, gửi, kết thúc; chỉ hành động đúng giai đoạn mới có hiệu lực.
- Engine kiểm tra tổ hợp lá ăn/phỏm từ server. Nếu tự gợi ý hạ, tìm phương án hợp lệ theo bài người chơi; không dùng greedy đơn giản bỏ lỡ phỏm chồng lấn.
- Người chơi chọn nhóm phỏm khi có nhiều cách; server kiểm tra ràng buộc lá ăn và một lá không nằm hai nhóm cùng lúc.
- Gửi bài phải tham chiếu phỏm đã hạ hợp lệ, cập nhật sở hữu và số điểm nhất quán; bài đã hạ public, bài chưa hạ giữ kín.
- UI phân biệt lá bốc/ăn, phỏm đã chọn, bài rác, khu vực hạ/gửi, lượt và giai đoạn.
- Kết quả giải thích điểm bài rác, thứ hạng, móm/ù/đền và từng khoản chip.
- Chọn một mô hình hạch toán nhất quán: khuyến nghị tích lũy nghĩa vụ ăn/phạt trong state ván và chốt một lần khi kết thúc. Nếu chuyển chip giữa ván phải có đối soát/đảo giao dịch đúng khi hủy.
- Tích hợp mission event, replay, reconnect/restart; rời phòng không xóa nghĩa vụ ăn/phạt.

Kiểm thử:
- Ăn hợp lệ/không hợp lệ; lá ăn buộc nằm trong phỏm; nhiều tổ hợp chồng lấn.
- Phỏm ba/bốn lá hoặc dây dài theo luật, bài rác, bằng điểm, móm.
- Thứ tự hạ, ăn chốt làm thay đổi vòng nếu có, gửi bài hợp lệ/không hợp lệ, ù và đền.
- Mỗi trường hợp của bảng thanh toán có ví dụ đầu vào/kết quả độc lập.
- Mức thua tối đa, cộng/trừ chip bảo toàn, không tính hai lần tiền ăn và tiền kết thúc.
- Reload khi đang chọn phỏm và reconnect ở lượt bốc/ăn/hạ/gửi.
- Snapshot/log không lộ bài chưa hạ; client không tự khai phỏm hoặc điểm cuối.
- Restart trước/sau settlement không thay thứ hạng và không nhân đôi tiền.

Tiêu chí hoàn thành: toàn bộ luồng từ chia đến hạ/gửi/tính điểm hoạt động; biến thể và phạm vi hỗ trợ được công bố; không bỏ xử lý đền hoặc ăn chốt mà vẫn đánh dấu game hoàn chỉnh.

Bàn giao:
- Cập nhật docs/milestones/M6B.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

