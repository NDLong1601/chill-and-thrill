# M0 — Khảo sát, đặc tả và thiết kế

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


Mục tiêu: tạo bộ thiết kế đủ cụ thể để triển khai M1–M7 dựa trên code thực tế. Đây là mốc tài liệu và prototype, chưa thay đổi hành vi production hoặc migration dữ liệu thật.

Công việc:
1. Đọc entry point, HTTP/Socket handlers, quản lý phòng, luật The Gang, UI, persistence, bộ test và scripts. Chạy baseline npm test và kiểm tra browser nếu môi trường hỗ trợ. Phân biệt lỗi có sẵn với phần chưa chạy được; chưa sửa lan sang nghiệp vụ.
2. Vẽ bản đồ phụ thuộc: phần dùng chung, phần riêng The Gang, dữ liệu public/private, sự kiện mạng, phiên ghế, chip xếp hạng và lịch sử. Chỉ ra điểm cần adapter để tránh viết lại toàn bộ.
3. Thiết kế thông tin:
   - Category: casual/thrill.
   - Game ID độc lập.
   - Rule variant/độ khó riêng của từng game.
   - Profile ID, seat ID, socket ID và session token có vai trò riêng.
   - Một phòng gắn một game; đổi game bằng phòng mới.
4. Đặc tả các luồng: mở trang chủ, chọn chế độ/game, tạo phòng, nhập mã/QR/link, sẵn sàng, chơi, kết quả, tiếp tục phòng, nhiệm vụ, hồ sơ, hết chip, mất kết nối.
5. Lập danh sách route: /, /play/casual, /play/thrill, /games/:gameId, /rooms/:code, /missions, /profile. Giữ đường vào cũ /?room=ABCD. Ghi rõ reload, back/forward, link lỗi, phòng hết hạn và hồ sơ chưa tạo.
6. Tạo prototype HTML/CSS tương tác bằng dữ liệu minh họa, đặt riêng trong docs/design; chỉ prototype được dùng dữ liệu giả và phải ghi rõ là bản thiết kế. Có thể đi qua home → danh mục → chi tiết → tạo phòng → phòng chờ. Hiện được hai phong cách Giải trí/Kịch tính trong một hệ thống thống nhất.
7. Thiết kế cho điện thoại dọc, ngang và desktop; không bắt xoay ở trang chủ. Có trạng thái trống, loading, lỗi, mất kết nối, thiếu chip, game sắp có. Dùng tiếng Việt dễ hiểu và nút đủ lớn để chạm.
8. Đặc tả module game: metadata, cấu hình, khởi tạo, xử lý action, dữ liệu riêng từng người, timeout/disconnect, kết quả và đề xuất thanh toán. Định nghĩa revision/action ID và cơ chế phản hồi lỗi.
9. Phác thảo schema SQLite và ranh giới transaction: hồ sơ, phòng, snapshot ván, ví, khoản giữ, sổ giao dịch, nhiệm vụ. Chỉ ra quy trình migration từ rooms.json, backup, khôi phục và rollback tương thích.
10. Lập bảng quyết định luật còn mở cho từng game. Đề xuất mặc định từ kế hoạch, ghi rõ luật local; chưa cần khảo cứu toàn bộ chi tiết bảy game ở mốc này.
11. Phân rã backlog theo M1–M7 với đầu vào, đầu ra, phụ thuộc, acceptance criteria và rủi ro. Ưu tiên phiên bản đầu gồm The Gang + UNO + Tiến lên + ví + nhiệm vụ.

Tài liệu đầu ra:
- docs/design/product-spec.md
- docs/design/architecture.md
- docs/design/data-and-migration.md
- docs/design/game-rules-decisions.md
- docs/design/acceptance-matrix.md
- docs/design/prototype.html và assets cần thiết.
Có thể dùng file tương đương đã tồn tại; cập nhật thay vì tạo hai nguồn sự thật.

Tiêu chí hoàn thành:
- Prototype mở được, không cần backend mới; có các bước điều hướng đã nêu.
- Kiến trúc và schema giải thích được cả reconnect và tính toàn vẹn chip.
- Có kết quả baseline thực tế, vị trí code liên quan và backlog triển khai được.
- Ghi rõ các quyết định còn mở, không bắt chờ phê duyệt lại cho chi tiết kỹ thuật thường lệ.
- Chỉ hoàn thành tài liệu/prototype, không kích hoạt chức năng mới trong ứng dụng.

Bàn giao:
- Cập nhật docs/milestones/M0.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

