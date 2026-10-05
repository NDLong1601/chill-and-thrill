# M6C — BANG! bộ cơ bản

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


Mục tiêu: thêm BANG! vào Giải trí, chơi đầy đủ một bộ cơ bản được xác định; dùng phòng chung và nhiệm vụ, không dùng ví để đặt cược.

Đầu vào: M1–M2 và hệ thống hồ sơ/nhiệm vụ nếu M3 đã có. Tên game BANG! độc lập với The Gang.

Luật và dữ liệu:
1. Xác định đúng phiên bản bộ cơ bản; đọc rulebook/tài liệu nhà phát hành, ghi nguồn và phạm vi vào docs/rules/bang.md. Không trộn card/nhân vật từ các bản mở rộng.
2. Lập danh mục số lượng lá, vai, nhân vật, máu, năng lực; kiểm tra tổng bộ bài và tổ hợp vai theo số người hỗ trợ.
3. Mô tả vòng rút/chơi/bỏ, giới hạn BANG! mỗi lượt, khoảng cách, tầm súng, trang bị, check bài và hạn chế lá trùng.
4. Đặc tả phản ứng ngoài lượt: Missed!, Beer và cứu khi mất máu, Duel, Gatling, Indians!, Jail, Dynamite cùng thứ tự giải quyết các hiệu ứng và tương tác năng lực theo bộ đã chọn.
5. Chốt chết/loại người, thưởng/phạt khi loại, thời điểm xét thắng và điều kiện thắng theo phe, đặc biệt Renegade.
6. Không gắn nhãn “bộ cơ bản đầy đủ” nếu còn thiếu lá hoặc nhân vật. Có thể phát triển từng phần bên trong nhưng chỉ bật playable sau khi đạt phạm vi đã chốt.

Engine:
- Tách khu vực bài trên tay, trang bị, hiệu ứng chờ, chồng rút/bỏ, HP, vai và nhân vật.
- Xây hàng đợi/ngăn xếp phản ứng rõ ràng: ai phải trả lời, lựa chọn hợp lệ, mục tiêu, hạn, effect ID và cách kết thúc. Tạm ngừng hành động lượt chính khi còn hiệu ứng chưa giải quyết.
- Card effect xử lý qua cấu trúc dữ liệu/hàm tách biệt; không trộn vào transport hoặc một chuỗi if theo UI.
- Tính khoảng cách từ người còn sống và modifiers đúng thời điểm; cập nhật sau khi người chơi bị loại.
- Check chiến thắng ở điểm luật yêu cầu trước khi tiếp tục rút/thưởng/hiệu ứng khác, để không tiếp tục ván đã kết thúc.
- Giữ vai bí mật phía server; chỉ công khai theo luật. Không để vai ẩn lọt vào log, history đang chơi, tooltip hoặc trạng thái người đã bị loại.
- Hết chồng rút có xử lý theo luật; ID từng lá không bị trùng.
- Reconnect/restart giữ được hiệu ứng đang chờ, mục tiêu và người cần phản ứng.

UI:
- Hiện máu, nhân vật, trang bị, khoảng cách/tầm và lượt. Vai riêng dễ xem nhưng có thể che khi cần.
- Chọn lá → chọn mục tiêu hợp lệ → xác nhận; modal phản ứng hiện rõ lý do và lựa chọn.
- Người bị loại thấy trạng thái của mình và thông tin công khai; không tự động được xem bài/vai kín của người còn sống.
- Kết quả giải thích phe thắng, hiện vai khi luật cho phép, chơi lại cùng phòng.
- Nhiệm vụ tham gia trận: định nghĩa người bị loại sớm có đủ điều kiện nhận khi trận kết thúc; không thưởng lặp khi reload.

Kiểm thử:
- Mỗi loại lá/nhân vật thuộc bộ được chọn có ca luật trọng yếu.
- Khoảng cách sau khi loại người, modifiers, giới hạn BANG!, vũ khí và trang bị trùng.
- Hiệu ứng nhiều mục tiêu, phản ứng liên tiếp, phản ứng sai người/trùng, chết giữa chuỗi hiệu ứng.
- Beer/cứu, Duel, Jail/Dynamite, thưởng/phạt và điều kiện thắng từng phe.
- Kiểm tra vai/bài ẩn trên payload mạng của từng người, kể cả người bị loại.
- Restart giữa phản ứng không mất hoặc giải quyết effect hai lần.
- Bàn đông người trên mobile không che bài/nút phản ứng; các game còn lại không bị ảnh hưởng.

Tiêu chí hoàn thành: bộ cơ bản đã chọn chơi trọn trận với mọi thành phần thuộc phạm vi, không chỉ có bắn/mất máu; tài liệu và khả năng thực tế khớp nhau.

Bàn giao:
- Cập nhật docs/milestones/M6C.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

