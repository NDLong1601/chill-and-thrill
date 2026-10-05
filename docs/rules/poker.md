# Poker Texas Hold’em No-Limit local v1

Ngày chốt: 05/10/2026. Đây là luật bàn chip ảo local của Chill & Thrill, không phải lời khẳng định rằng mọi casino hay giải đấu áp dụng cùng house rule. Cơ chế cược vô hạn và all-in ngắn dựa trên [Poker TDA Rules](https://www.pokertda.com/poker-tda-rules/) (đặc biệt nguyên tắc mở lại cược); cấu trúc tiền bàn, buy-in và giới hạn thời gian là lựa chọn của bàn local, tham chiếu [Robert’s Rules of Poker](https://www.pagat.com/docs/RobsPkrRules11.pdf).

## Phạm vi và tiền chip

- Texas Hold’em No-Limit, 2–6 hồ sơ local, không bot, không rake, không ante, không tournament hay đổi chip sang tiền thật.
- Blind cố định `SB 5 / BB 10`. Buy-in đầu tiên từ `200` đến `1.000` chip, bội số 10; top-up/rebuy cũng bội số 10, chỉ giữa hand, và stack sau top-up không vượt 1.000.
- Cần stack ít nhất 10 chip để được chia hand mới. Người vào bàn khi hand đang diễn ra ngồi ngoài đến hand sau. Có thể bỏ sẵn sàng giữa hand; có thể rời bất cứ lúc nào, nhưng người đang trong hand được đánh dấu **rời sau hand**, rồi mới cash-out.
- Buy-in chuyển ví → stack với khoản giữ riêng; bet chuyển stack → pot trong state của bàn; thắng trả pot → stack; cash-out chuyển toàn bộ stack → ví một lần. Ví “dùng được”, chip “đang giữ”, và stack không phải cùng một con số.

## Button, chia bài và vòng cược

- Button đi theo chiều kim đồng hồ sang ghế đủ điều kiện ở hand kế. Nếu button rời, ghế kế bên theo chiều kim đồng hồ nhận lượt button tiếp theo.
- Từ 3 người: SB ở trái button, BB ở trái SB, preflop bắt đầu ở trái BB; flop/turn/river bắt đầu ở trái button.
- Heads-up: button cũng là SB, người còn lại là BB; preflop button hành động trước, các vòng sau BB hành động trước.
- Chia hai lá riêng; lần lượt preflop, flop (3 lá), turn (1), river (1), showdown. Lá riêng chỉ được gửi cho đúng ghế. Khi mọi người còn lại all-in hoặc không còn action hợp lệ, server tự lật các lá chung còn lại.
- Không có turn timer ở v1. Nếu người đang trong hand mất kết nối, hand tạm dừng để giữ bài/stack; không auto call hoặc raise.

## Action và mức cược

`Cược đến tổng X` là **tổng chip của người đó trong vòng đang cược**, không phải số chip thêm. UI cũng hiện số chip thêm để tránh nhầm.

- **Fold:** bỏ quyền thắng mọi pot, nhưng chip đã đặt vẫn ở pot.
- **Check:** chỉ khi không cần theo.
- **Call:** theo đúng mức cược hiện tại, hoặc all-in bằng số stack còn lại nếu không đủ.
- **Bet:** khi chưa có cược, ít nhất BB (= 10), trừ khi toàn bộ stack nhỏ hơn mức đó.
- **Raise:** tổng mới phải cao hơn mức hiện tại; mức tăng tối thiểu bằng lần bet/raise đầy đủ gần nhất (đầu vòng là BB). Không giới hạn số raise đầy đủ.
- **All-in:** có thể là call thiếu, bet nhỏ, raise đầy đủ hoặc raise ngắn. Raise ngắn chỉ hợp lệ khi đúng toàn bộ stack; nó không thay đổi minimum raise.
- Người đã action chỉ được tố lại khi khi action quay về họ, tổng mức cược họ đang đối mặt đã tăng ít nhất một full bet/raise. Nhiều short all-in được cộng dồn cho so sánh này; nếu chúng đạt mức đầy đủ thì quyền tố mở lại. Minimum raise vẫn là full bet/raise hợp lệ gần nhất.

Ví dụ: cược 100, A call; hai all-in ngắn lần lượt lên 130 và 160. Nếu full raise gần nhất là 60, A chỉ call/fold vì tăng 60? Khi mức quay lại đúng tăng **ít nhất 60**, A được raise lại; nếu tổng chỉ tăng 50 thì không. Server kiểm tra từng ghế, không tin client tự báo quyền raise.

## Pot, showdown và chip lẻ

- Mỗi pot được xây từ các ngưỡng đóng góp. Người fold vẫn là contributor nhưng bị loại khỏi danh sách có quyền thắng. Server so 5 lá tốt nhất trong 7 bằng evaluator standard không có hiệu ứng The Gang.
- Trước khi chia, phần đóng góp cao hơn mức đóng góp của mọi người khác được hoàn ngay cho người đã đặt (cược không ai theo). Ví dụ `100 / 250 / 500` của ba người còn quyền thành main pot `300`, side pot `300`, hoàn `250` cho người đóng 500.
- Mỗi main/side pot được so và chia độc lập. Có thể hòa main pot nhưng người khác thắng side pot. Nếu số chip không chia hết, chip lẻ đi lần lượt cho người thắng đầu tiên bên trái button rồi theo chiều kim đồng hồ.
- Nếu tất cả trừ một người fold, người còn lại nhận pot hợp lệ sau khi hoàn phần cược không ai theo. Nếu showdown, chỉ người chưa fold mới lật lá riêng.
- Một `matchId`/hand được ghi kết quả đúng một lần. Nhiệm vụ M3 đếm hand Poker hợp lệ đã hoàn tất, không đếm lần xem kết quả hoặc cash-out.

## An toàn, reconnect và kết thúc

- Server là nguồn sự thật của deck, bài riêng, lượt, mức cược, minimum raise, pot, người thắng và delta stack. Một action cần revision + action ID để chặn request cũ/trùng.
- State bàn (deck, lá riêng, đóng góp, stack, action đã xử lý, button và street) được ghi vào SQLite trong cùng transaction với thay đổi chip; companion JSON là bản xuất tương thích. Khi restart, SQLite được ưu tiên, ghế trở lại mất kết nối và hand đang chạy tạm dừng. Không dùng việc socket đóng để tự hoàn chip.
- Khoản buy-in/cash-out được ghi theo idempotency key trong SQLite. Nếu hand bị bỏ dở, mọi người trong hand đều mất kết nối quá 12 giờ, server hủy hand, hoàn mọi đóng góp (kể cả của người fold) về stack rồi cash-out từng ghế trong một transaction. Hand bị hủy không tính nhiệm vụ. Nếu hand đã chốt, server cash-out stack sau kết quả và không hoàn lại pot lần nữa. Dấu đóng bàn ngăn JSON cũ phục hồi lại khoản đã thanh toán.
- Rời trong hand chỉ đặt lịch rời. Sau khi chốt đầy đủ kết quả/nhiệm vụ, server cash-out, gỡ ghế và báo `room_left` để UI về sảnh. Không có nút “hủy hand” giữa ván đang chơi.
