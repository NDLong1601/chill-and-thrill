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
- Khi chặt theo ba dòng trên, vòng hiện tại kết thúc ngay và người chặt dẫn vòng mới. Không có khoản chip phạt cho hành vi chặt.

Ví dụ: `5♠ 5♣ 6♦ 6♥ 7♠ 7♣` (ba đôi thông) có thể chặt `2♥`; `8♠ 8♣ 9♦ 9♥ 10♠ 10♣ J♦ J♥` (bốn đôi thông) có thể chặt đôi `2` hoặc tứ quý.

## Bỏ lượt, kết thúc và tới trắng

- Khi đã có bài trên bàn, người không dẫn vòng có thể bỏ lượt. Người dẫn vòng không được bỏ.
- Khi mọi người khác người dẫn đã bỏ, bài trên bàn được dọn và người dẫn đánh tổ hợp mới. Không được vào lại vòng đã bỏ.
- Ván kết thúc ngay khi một người đánh hết bài.
- Trước lá đánh đầu tiên, server kiểm tra tới trắng theo thứ tự ưu tiên: tứ quý 2; sảnh rồng 3 đến A (mỗi giá trị một lá, lá thứ 13 bất kỳ); sáu đôi; năm đôi thông; bốn sám. Nếu nhiều người có tới trắng cùng mức, ưu tiên người ngồi trước theo thứ tự chia bài. Tới trắng kết thúc ván ngay, không có lượt đánh.
- Không mở thối, cóng hay đền trong v1. Chúng không ảnh hưởng kết quả hoặc chip, nhằm giữ mức trách nhiệm tối đa xác định được trước khi chia.

## Chip local và vòng đời bàn

- Mức cược duy nhất là **100 chip/người**. Ngay trước lúc chia, server giữ 100 chip của toàn bộ bàn trong một transaction; thiếu chip ở bất kỳ ai thì không ai bị giữ chip và ván không bắt đầu.
- Khi có người thắng, mọi khoản giữ được đóng và người thắng nhận toàn bộ pot. Ví dụ 4 người: pot 400, người thắng `+300`, mỗi người còn lại `-100`. Không có phí, phạt chặt, phạt thối hay chia pot.
- Cấu hình/mức cược không đổi giữa ván. Chơi tiếp kiểm tra và giữ chip lại từ đầu.
- Mất mạng trong ván làm ván tạm dừng; bài, lượt và khoản giữ vẫn nằm ở server. Người chơi có thể khôi phục ghế bằng token cũ. Nút rời trong ván chỉ ghi yêu cầu rời sau khi ván được chốt; không trả chip ngay.
- Chủ bàn chỉ có thể hủy **trước lá đánh đầu tiên**; toàn bộ khoản giữ sẽ được hoàn với một audit/ledger entry. Phòng có ván đang giữ chip nhưng toàn bộ người chơi mất kết nối quá 12 giờ sẽ được hủy và hoàn chip.

## Ranh giới bảo mật

Client chỉ nhận bài của chính mình; ghế khác chỉ thấy số lá còn lại. Client có thể gợi ý tổ hợp từ bài mình nhưng server luôn kiểm tra quyền sở hữu lá, lượt, tổ hợp, chặt, revision và idempotency trước khi thay đổi state hoặc ví.
