# M1 — Trang chủ hai chế độ và nền tảng nhiều game

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


Mục tiêu: mở link thấy cổng game mới; The Gang chơi đầy đủ trong Giải trí. Các game còn lại xuất hiện ở đúng nhóm và được đánh dấu “Sắp có”.

Đầu vào: thiết kế M0 và hệ thống The Gang đang có. Nếu tên cổng game chưa được chọn, dùng một nhãn trung tính có thể đổi từ cấu hình, không trì hoãn công việc.

Công việc:
1. Xây trang chủ với hai thẻ Giải trí/Kịch tính, nhập mã phòng, tiếp tục phòng đang có. Xây danh mục và chi tiết game theo thiết kế.
2. Tạo registry phía server với gameId, category, tên, phiên bản luật, giới hạn người, schema cấu hình, trạng thái phát hành, capabilities. Client đọc danh mục từ server; server không tin category hay trạng thái playable do client gửi.
3. Chỉ bật The Gang. Khi yêu cầu tạo game chưa phát hành bằng API trực tiếp, server vẫn phải từ chối. Chưa có M3 thì không hiển thị số dư giả hoặc nút nhận thưởng giả; giải thích tính năng chưa mở bằng trạng thái phù hợp.
4. Triển khai route và điều hướng, tải lại link sâu, back/forward, trang không tồn tại. Giữ link mời /?room=ABCD và QR cũ; link phòng đưa đúng game, không bắt chọn lại danh mục.
5. Tách quản lý phòng/transport khỏi luật The Gang bằng adapter và module. Giữ compatibility cho sự kiện cũ trong giai đoạn chuyển tiếp nếu cần. Không đặt luật The Gang vào room service dùng chung.
6. Phân biệt category, gameId, variant. Giữ BASIC/ADVANCED/EXPERT/MASTER_THIEF là độ khó của The Gang.
7. Cấu hình phòng: tên, giới hạn người theo game, công khai trong LAN/chỉ qua lời mời, mật khẩu tùy chọn. Phòng riêng không xuất hiện trong danh sách; mật khẩu được kiểm tra ở server và không trả lại client/log. Không coi có mã phòng là đã có quyền qua mật khẩu.
8. Phòng chờ chung: ghế/avatar, kết nối, sẵn sàng, sửa luật, QR/link, quyền host. Đổi luật hủy sẵn sàng; server kiểm tra lại điều kiện khi bắt đầu. Host rời thì chuyển quyền hợp lệ.
9. Cô lập UI The Gang, tránh chồng listener/socket handler mỗi lần đổi route. Chỉ mount module bàn đang dùng, cleanup khi rời.
10. Giữ bốn độ khó, toàn bộ thẻ, xác nhận chip, hướng dẫn, chat policy, riêng tư bài, lịch sử, reconnect và mobile của The Gang.
11. Version hóa dữ liệu để đọc phòng cũ: mặc định casual/the-gang, ánh xạ độ khó, giữ token và dữ liệu lịch sử. Không chuyển sang ví ở mốc này; không tự xóa save không đọc được.
12. Root / hiển thị trang chủ và thẻ tiếp tục; phải phân biệt “xem trang chủ” với “rời ghế đang chơi” để điều hướng không làm mất phiên.

Kiểm thử:
- Bộ test The Gang hiện có; bổ sung test cho adapter và migration khi cần.
- Tạo/vào phòng mới, phòng riêng/mật khẩu, QR/link cũ, link sâu và reload.
- Không vào được game chưa phát hành qua API.
- Đủ người theo giới hạn The Gang, không cố định giới hạn đó cho toàn nền tảng.
- Bài/token không lộ qua danh sách phòng hoặc snapshot.
- Chơi trọn một trận, quay về sảnh, chơi lại; đổi route không gửi action hai lần.
- Desktop và mobile dọc/ngang, không có overlay xoay ngang ở home.

Tiêu chí hoàn thành: người chơi đi từ home đến hết trận The Gang bằng UI mới; phiên/phòng cũ khôi phục được; các game chưa làm hiển thị trung thực. Giữ npm start và các lệnh kiểm tra hoạt động.

Bàn giao:
- Cập nhật docs/milestones/M1.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

