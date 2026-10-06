# Tiến lên miền Nam — local v1

Ngày chốt: 05/10/2026<br>
Phạm vi: bàn LAN 2–4 người, không bot, mỗi người nhận 13 lá. Đây là biến thể nội bộ của Chill & Thrill, không phải tuyên bố về luật chính thức hay luật nhà của mọi nhóm chơi.

## Bài và thứ tự

- Dùng đúng một bộ 52 lá chuẩn, xáo và chia hoàn toàn trên server. Với bàn 2 hoặc 3 người, các lá không chia không được dùng trong ván.
- Giá trị tăng dần: `3 4 5 6 7 8 9 10 J Q K A 2`.
- Chất chỉ phân định hai **lá rác cùng giá trị**: bích `♠` < chuồn `♣` < rô `♦` < cơ `♥`. Những tổ hợp khác cùng giá trị không thể hòa vì không có hai lá cùng chất.
- Lượt mở ván thuộc về người giữ lá thấp nhất **trong các lá đã chia**; lượt mở đầu phải chứa chính lá đó. Quy tắc này vẫn hợp lệ ở bàn 2/3 người, khi `3♠` có thể nằm trong phần không chia. Sau mỗi vòng, người vừa đánh cuối được dẫn vòng mới.

## Tổ hợp và chặt

Các tổ hợp hợp lệ là rác, đôi, sám, tứ quý, sảnh từ ba lá trở lên và đôi thông từ ba đôi liên tiếp trở lên. Sảnh/đôi thông không được chứa lá `2`. Bài cùng loại và cùng độ dài mới so trực tiếp; lá/tổ hợp có giá trị cao hơn thắng.

- Tứ quý hoặc từ ba đôi thông chặt được rác `2`.
- Tứ quý hoặc từ bốn đôi thông chặt được đôi `2`.
- Từ bốn đôi thông chặt được tứ quý.
- Khi chặt theo ba dòng trên, vòng hiện tại kết thúc ngay và người chặt dẫn vòng mới. Không có khoản coin phạt cho hành vi chặt.

Ví dụ: `5♠ 5♣ 6♦ 6♥ 7♠ 7♣` (ba đôi thông) có thể chặt `2♥`; `8♠ 8♣ 9♦ 9♥ 10♠ 10♣ J♦ J♥` (bốn đôi thông) có thể chặt đôi `2` hoặc tứ quý.

## Bỏ lượt, kết thúc và tới trắng

- Khi đã có bài trên bàn, người không dẫn vòng có thể bỏ lượt. Người dẫn vòng không được bỏ.
- Khi mọi người khác người dẫn đã bỏ, bài trên bàn được dọn và người dẫn đánh tổ hợp mới. Không được vào lại vòng đã bỏ.
- Ván kết thúc ngay khi một người đánh hết bài.
- Trước lá đánh đầu tiên, server kiểm tra tới trắng theo thứ tự ưu tiên: tứ quý 2; sảnh rồng 3 đến A (mỗi giá trị một lá, lá thứ 13 bất kỳ); sáu đôi; năm đôi thông; bốn sám. Nếu nhiều người có tới trắng cùng mức, ưu tiên người ngồi trước theo thứ tự chia bài. Tới trắng kết thúc ván ngay, không có lượt đánh.
- Không mở thối, cóng hay đền trong v1. Chúng không ảnh hưởng kết quả hoặc coin, nhằm giữ mức trách nhiệm tối đa xác định được trước khi chia.

## Coin local và vòng đời bàn

- Chủ bàn chọn mức cược **S coin/người** khi tạo phòng (mặc định 100). Có thể nhập `500`, `1.000`, `10k`, `10tr`; chỉ nhận số nguyên dương trong giới hạn ví. Ngay trước lúc chia, server giữ S coin của toàn bộ bàn trong một transaction; thiếu coin ở bất kỳ ai thì không ai bị giữ coin và ván không bắt đầu.
- Khi có người thắng, mọi khoản giữ được đóng và người thắng nhận toàn bộ pot. Ví dụ 4 người, S = 100: pot 400, người thắng `+300`, mỗi người còn lại `-100`. Không có phí, phạt chặt, phạt thối hay chia pot.
- Cấu hình/mức cược không đổi giữa ván. Chơi tiếp kiểm tra và giữ coin lại từ đầu.
- Khi mất kết nối, bàn chờ ghế đó tối đa 120 giây. Hạn reconnect được lưu cùng snapshot và không được gia hạn thêm khi server khởi động lại lần nữa. Ghế có thể khôi phục bằng token cũ.
- Hết 120 giây, bàn tiếp tục. Khi người vắng đến lượt, server đánh một lá hợp lệ (ưu tiên lá mở bắt buộc) hoặc bỏ lượt nếu đang chặn. Settlement và khoản giữ coin vẫn chạy theo luật; disconnect không hủy ván hoặc tự hoàn coin.
- Nút rời trong ván chỉ xếp lịch rời sau khi ván được chốt; server cash-out đúng sau settlement rồi báo `room_left`. Chủ bàn chỉ có thể hủy trước lá đánh đầu tiên.

## Ranh giới bảo mật

Client chỉ nhận bài của chính mình; ghế khác chỉ thấy số lá còn lại. Client có thể gợi ý tổ hợp từ bài mình nhưng server luôn kiểm tra quyền sở hữu lá, lượt, tổ hợp, chặt, revision và idempotency trước khi thay đổi state hoặc ví.

Mỗi lượt có 30 giây theo đồng hồ server. Trong 120 giây reconnect, đồng hồ giữ phần thời gian còn lại; khi grace hết, lượt ghế vắng được tự xử lý ngay. Restart giữ deadline gốc. Phòng legacy trước phiên bản reconnect policy 2 vẫn dùng quy tắc hết hạn 12 giờ đã có để hoàn khoản giữ; ván policy 2 không bị hủy chỉ vì thời gian trôi qua.

Sau kết quả, chủ bàn chọn **Chia ván tiếp** để giữ coin và chia ngay tại bàn cũ, không quay lại phòng chờ.
