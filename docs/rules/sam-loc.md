# Sâm lốc — local v1

Ngày chốt: 05/10/2026<br>
Phạm vi: bàn LAN 2–5 người, không bot, mỗi người 10 lá. Đây là biến thể nội bộ của Chill & Thrill, không phải tuyên bố về luật Sâm lốc duy nhất hoặc luật nhà của mọi nhóm.

## Bài, thứ tự và tổ hợp

- Dùng một bộ 52 lá chuẩn. Server xáo/chia, mỗi người nhận đúng 10 lá; lá dư không được dùng. Giá trị tăng dần là `3 4 5 6 7 8 9 10 J Q K A 2`.
- Chất chỉ để hiển thị: không phân chất khi so bài, nên hai lá rác cùng giá trị không đè được nhau. Không có luật chặt riêng, đôi thông hoặc tứ quý chặt `2` trong biến thể này.
- Tổ hợp hợp lệ là rác, đôi, sám, tứ quý và sảnh từ 3 lá. Sảnh là các giá trị liên tiếp, không chứa `2`. Muốn đè bài phải cùng loại, cùng độ dài và có giá trị cao hơn; bài đồng giá trị không đè được.
- Người có lá thấp nhất trong số lá đã chia mở ván và lá đánh đầu phải chứa chính lá đó. Khi tất cả người khác bỏ, người vừa đánh cuối dẫn vòng mới. Người dẫn không được bỏ.
- `2` được phép đánh rác, kể cả lá cuối; v1 không áp dụng thối `2` hoặc phạt cóng. Điều này tránh một lá cuối bị cấm khiến ván không thể kết thúc.

Ví dụ: `8♠ 8♣` đè `7♦ 7♥`; `9♠ 10♣ J♦` đè `6♠ 7♣ 8♦`; `Q♠ K♣ A♦` hợp lệ nhưng `Q♠ K♣ A♦ 2♥` không phải sảnh. `10♠` không đè `10♥`.

## Cửa sổ Báo Sâm

Sau khi chia nhưng trước lá đánh đầu, tất cả người đang kết nối có 60 giây để chọn **Báo Sâm** hoặc **Không báo**. Lựa chọn khóa một lần. Khi tất cả đã trả lời, hoặc đến hạn, server chốt cửa sổ; phản hồi còn thiếu ở hạn được tính là không báo.

- Nếu nhiều người Báo Sâm, người ngồi sớm hơn theo thứ tự ghế trong phòng được ưu tiên; cùng revision/action ID không thể đổi ưu tiên hoặc được tính hai lần.
- Nếu có người Báo Sâm, họ dẫn lượt. Trong pha này, nếu họ đánh hết 10 lá thì Báo Sâm thành công. Nếu họ bỏ khi đang cần đè, hoặc một người khác đánh hết bài trước, Báo Sâm thất bại và ván kết thúc ngay.
- Mất kết nối làm ván tạm dừng. Hạn Báo Sâm vẫn là hạn server đã lưu (không cấp thêm quyền khi reconnect); action đến sau hạn bị từ chối và server chốt theo các phản hồi đã có.
- Không ai Báo Sâm thì chuyển sang ván thường với lá thấp nhất đã chia như trên.

## Báo một và kết thúc ván thường

Khi một người còn đúng một lá sau lượt đánh, server công khai **Báo một**. Nếu đúng người ngồi kế tiếp đánh hết bài trong lượt ngay sau đó, đây là **chặn Báo một**. Ván vẫn kết thúc với người vừa hết bài; người đã Báo một chịu thêm một cược cơ bản cho người chặn. Nếu người kế tiếp bỏ hoặc không đánh hết bài, Báo một hết hiệu lực.

Không có tới trắng, thối hoặc cóng trong v1. Ván thường kết thúc ngay khi một người đánh hết bài.

## Chip local, mức giữ và bảng thanh toán

Cược cơ bản `s = 20 chip`. Chip không có giá trị ngoài máy chủ local. Trước khi chia, server giữ `maxLoss(n) = 2 × s × (n − 1)` của từng người trong một transaction, với `n` là số người tại bàn. Thiếu chip ở bất kỳ ghế nào sẽ không ai bị giữ chip.

| Kết quả | Người trả | Người nhận | Chuyển chip |
|---|---|---|---:|
| Ván thường | Mỗi người thua | Người đánh hết bài | `s` mỗi người |
| Chặn Báo một | Người đã Báo một | Người chặn/đánh hết bài | thêm `s` |
| Báo Sâm thành công | Mỗi người còn lại | Người Báo Sâm | `2s` mỗi người |
| Báo Sâm thất bại | Người Báo Sâm | Mỗi người còn lại | `2s` mỗi người |

Báo Sâm thay thế toàn bộ thanh toán ván thường và Báo một; các khoản không cộng dồn với đền Sâm. Báo một chỉ cộng với ván thường. Tổng delta luôn bằng 0; tất cả khoản giữ được đóng cùng một giao dịch idempotent rồi mới gửi kết quả.

Ví dụ bàn 5 người: `maxLoss = 2 × 20 × 4 = 160`. Báo Sâm thất bại khiến người báo `−160`, bốn người kia mỗi người `+40`; giữ 160 đủ chính xác. Ván thường có chặn Báo một làm người báo một mất `−40` (20 thua ván + 20 phạt), thấp hơn 160. Vì vậy không có nhánh nào mất quá khoản đã giữ.

## Khôi phục, hủy và bí mật

- Client chỉ nhận 10 lá của chính mình. Người khác chỉ thấy số lá, bài trên bàn, Báo một và người Báo Sâm đã được chốt. Không có bài đối thủ trong snapshot, nhật ký hoặc kết quả đang chơi.
- Reload/reconnect giữ bài, lượt, trạng thái Báo Sâm, khoản giữ và action ID. Ván đang hoạt động tạm dừng khi có ghế mất kết nối.
- Chủ bàn chỉ được hủy trước lá đánh đầu; server hoàn toàn bộ khoản giữ bằng giao dịch có sổ cái. Rời giữa ván chỉ đánh dấu rời sau khi chốt. Phòng hết hạn khi mọi người mất kết nối sẽ hoàn khoản giữ, không tự quyết toán một ván dang dở.
