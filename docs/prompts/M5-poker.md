# M5 — Poker Texas Hold’em No-Limit

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


Mục tiêu: bàn Poker dùng chip ảo, chơi trọn hand và nhiều hand liên tiếp; xử lý đúng all-in, side pot, hòa và cash-out.

Đầu vào: M3 và nền tảng bàn/kinh tế đã kiểm chứng ở M4. Mặc định hỗ trợ 2–6 người cho bản đầu, chưa làm giải đấu hay bot.

Luật:
- Viết docs/rules/poker.md, tra cứu nguồn luật đáng tin cậy đúng loại bàn. Chốt dealer/button, small/big blind, heads-up, preflop/flop/turn/river/showdown.
- Chốt min/max buy-in, blinds cố định, số chip tối thiểu để chơi hand mới, quy tắc người mới/người ngồi ngoài/quay lại và dịch button.
- Đặc tả fold/check/call/bet/raise/all-in; raise amount là tổng cược của vòng để UI không gây nhầm.
- Đặc tả minimum raise, all-in không đủ một mức raise, điều kiện mở lại quyền tố và tổng nhiều lần all-in ngắn; không chỉ kiểm tra số chip dương.
- Chốt thời điểm lật bài, tự chạy phần bài chung còn lại khi hết hành động, chip lẻ khi chia pot, phần cược không được ai theo phải trả lại.
- Không áp hiệu ứng chuyên gia hoặc Jack đặc biệt của The Gang.

Engine:
1. Tái dùng phần so bài chuẩn chỉ sau khi đọc và kiểm tra độc lập; cô lập adapter The Gang nếu evaluator có hiệu ứng riêng.
2. Theo dõi stack, cược từng vòng, tổng đóng góp hand, trạng thái folded/all-in/active, người cần hành động, mức cược và bước raise hợp lệ.
3. Máy chủ tính các action hợp lệ và giá trị biên để gửi cho người đang hành động; client không quyết định pot hoặc thắng thua.
4. Xây pot theo mức đóng góp, giữ riêng người có quyền thắng từng pot. Chip của người fold vẫn thuộc pot nhưng họ không được nhận.
5. Showdown so năm lá tốt nhất từ bảy lá; chia main/side pot độc lập; hoàn phần cược dư không có người theo trước khi chia.
6. Một hand được thanh toán đúng một lần; button/stack chuyển sang hand sau từ trạng thái đã commit.

Ví và kết nối:
- Buy-in: ví → stack; bet: stack → pot; win: pot → stack; rời bàn: stack → ví.
- Top-up/rebuy chỉ giữa hand và trong giới hạn. Không vừa tăng stack vừa trừ ví ở hai bước không nguyên tử.
- Fold không đồng nghĩa được cash-out mọi khoản trong hand đang xử lý; rời sau hand là hành vi mặc định.
- Dùng chính sách mất kết nối nền tảng. Nếu bật timeout, check khi không cần call, còn lại fold; không tự call/raise.
- Lưu đủ state để khôi phục giữa vòng cược hoặc side pot; không dùng đóng socket làm điều kiện hoàn buy-in.
- Nhiệm vụ tính hand hoàn tất theo định nghĩa đã ghi; tránh đếm lần xem showdown hoặc cash-out thành một hand mới.

UI:
- Hiện pot tổng và side pot khi có, stack, đóng góp vòng, dealer/blinds, bài chung và bài riêng.
- Nút chỉ xuất hiện khi hợp lệ; slider/ô số ghi rõ “Tố đến tổng ...”, số chip thêm và mức tối thiểu/tối đa.
- Call thiếu tiền chuyển thành all-in đúng số dư; chưa đến lượt không cho đặt lệnh làm thay đổi state.
- Kết quả giải thích ai thắng pot nào, tay bài, chip nhận; số dư ví và stack không bị trình bày như cùng một khoản.

Kiểm thử trọng yếu:
- Heads-up và nhiều người, vòng không ai bet, tất cả trừ một người fold.
- Raise thiếu mức tối thiểu, short all-in không mở lại quyền tố, chuỗi all-in ngắn theo luật đã chốt.
- Đóng góp 100/250/500 khi ba người còn quyền: main pot 300, side pot 300 và trả lại 250 không được theo; sau đó thêm ca có người fold góp tiền.
- Hòa main pot nhưng khác người thắng side pot; chip lẻ; cùng dùng năm lá trên board; wheel/kicker.
- All-in preflop tự chạy board và settlement duy nhất.
- Buy-in/top-up/cash-out lặp hoặc đồng thời; restart trước/sau settlement.
- Tổng ví + stack + pot + các khoản giữ không đổi ngoài giao dịch thưởng hợp lệ.

Tiêu chí hoàn thành: chơi nhiều hand qua UI, bao gồm các tình huống đặc biệt đã nêu; báo rõ số người và biến thể được hỗ trợ, không gọi hoàn tất khi chỉ có chia bài và so bài.

Bàn giao:
- Cập nhật docs/milestones/M5.md với phần đã làm, quyết định/giả định, các file chính, cách chạy, kiểm thử thực tế, phần chưa xác minh và đầu vào cho mốc tiếp theo.
- Báo cáo ngắn: kết quả người chơi sử dụng được, các kiểm tra đã chạy và kết quả, hạn chế còn lại. Không khẳng định đã kiểm tra thiết bị thật hoặc luật chính thức nếu chưa có bằng chứng.

