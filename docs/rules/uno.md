# UNO local v1

Trạng thái: **playable** từ M2. Đây là một ván độc lập (không phải cuộc đua 500 điểm) và chưa tạo chip/phần thưởng; engine phát `matchId` ổn định để M3 có thể ghi nhận `match_completed` sau này.

## Nguồn và phạm vi

Mốc này dùng bộ UNO cổ điển 108 lá theo [hướng dẫn UNO chính thức của Mattel (B0001)](https://service.mattel.com/instruction_sheets/B0001-Eng.pdf): mỗi màu có 19 lá số, mỗi loại Skip/Reverse/Draw Two có 8 lá, thêm 4 Wild và 4 Wild Draw Four. Không lấy Wild Customizable, Swap Hands hay bất kỳ lá/bản mở rộng nào vào bộ v1.

Hướng dẫn trên mô tả 2–10 người; bản LAN v1 giới hạn **2–6 người** để bàn và luồng reconnect hiện tại dễ dùng. Mỗi người 7 lá; lá chỉ được gửi về socket của chủ sở hữu, còn đối thủ chỉ thấy số lá.

## Luồng ván

1. Server xáo bộ bài, chia 7 lá/người, lật một lá bỏ và chọn ngẫu nhiên người đi đầu. Không có dealer hiển thị vì không ảnh hưởng luật trong bản số.
2. Đến lượt, đánh đúng **màu, số hoặc biểu tượng** của lá trên cùng; Wild luôn được đánh và người đánh chọn màu. Không đánh nhiều lá, không cộng dồn +2/+4.
3. Người chơi có thể chủ động không đánh, rút đúng một lá; chỉ lá vừa rút mới có thể được đánh trong lượt đó, nếu không thì kết thúc lượt.
4. Khi chồng rút hết, server giữ lá bỏ trên cùng rồi xáo các lá bỏ còn lại. ID lá không thay đổi.
5. Ai hết bài thắng ván. Nếu lá cuối là +2/+4, mục tiêu vẫn phải xử lý rút bài (và với +4 vẫn có quyền phản đối) trước khi hiện kết quả; các lá hành động khác không mở thêm lượt sau khi đã có người thắng.

## Lá hành động

| Lá | Hiệu lực v1 |
|---|---|
| Skip | Người kế tiếp mất lượt. Với hai người, người đánh đi tiếp. |
| Reverse | Đảo hướng. Với hai người, Reverse tương đương Skip và người đánh đi tiếp. |
| Draw Two | Người kế tiếp rút 2 lá, mất lượt; không được đánh chồng +2. |
| Wild | Người đánh chọn một trong bốn màu, kể cả màu đang dùng. |
| Wild Draw Four | Người đánh chọn màu; người kế tiếp chọn chấp nhận hoặc phản đối trước khi rút. Không được chồng +4. |

Lá mở đầu được áp dụng hiệu lực Skip/Reverse/Draw Two. Wild mở đầu để server chọn ngẫu nhiên một màu (quyết định local để không phải tạo một lượt riêng trước ván). Wild Draw Four mở đầu được trả lại chồng rút rồi lật lá khác.

## +4 và phản đối

Theo nguồn Mattel, +4 chỉ hợp lệ nếu người đánh không có lá trùng **màu trước đó** (trùng số/biểu tượng khác màu vẫn được). Server cho phép đánh +4 để mục tiêu có quyền phản đối; nó ghi nhận kết quả kiểm tra trên server và không gửi cả tay bài của người đánh.

- Chấp nhận hoặc hết 12 giây: mục tiêu rút 4 và mất lượt.
- Phản đối đúng: người đánh +4 rút 4; mục tiêu đi lượt bình thường.
- Phản đối sai: mục tiêu rút 6 và mất lượt.

Chỉ người phải rút +4 được phản đối. Cửa sổ phản đối 12 giây tính theo clock server; nếu có người mất kết nối, clock dừng và khi tất cả nối lại nó chạy phần thời gian còn lại. Sau restart, phòng được khôi phục ở trạng thái tạm dừng, không tự thưởng thêm lượt phản đối.

## UNO

Trước khi đánh lá áp chót, người chơi bấm **Gọi UNO**. Nếu còn đúng một lá mà chưa gọi, server mở cửa sổ 12 giây; bất kỳ người khác có thể **Bắt lỗi UNO**, buộc người đó rút 2 lá. Không ai bắt lỗi thì ván tiếp tục. Đây là quyết định local rõ ràng cho ứng dụng số; các ấn bản/hướng dẫn vật lý có khác biệt về mức phạt và thời điểm bắt lỗi.

## Tính toàn vẹn và kết nối

- Mọi action có `actionId` và `expectedRevision`; action cũ bị từ chối, gửi lại cùng ID không áp dụng lần hai.
- Server kiểm tra lượt, lá trên tay, màu Wild, tính hợp lệ +4, phạt và điều kiện thắng. Client không gửi bộ bài, kết quả hay hình phạt tự khai.
- Mất kết nối giữa ván tạm dừng toàn bàn và giữ ghế trong 120 giây. Khôi phục bằng token phòng sẽ thấy lại đúng bài, lượt, màu, phạt và cửa sổ phản ứng còn lại.
- Phòng UNO, state và lưu khôi phục nằm tách riêng The Gang; mã phòng được kiểm tra chéo để không đụng nhau.

## Không thuộc v1

- Tính điểm 500 qua nhiều ván, luật nhà, chat/bot, chip, ví, nhiệm vụ nhận thưởng và thiết bị thật.
- Hình thức công khai bàn tay khi phản đối +4: bản LAN này chỉ cho server phân xử để không lộ các lá không liên quan.
