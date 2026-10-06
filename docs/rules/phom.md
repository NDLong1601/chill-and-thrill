# Phỏm local v1

Phạm vi này là một biến thể Phỏm LAN xác định cho Chill & Thrill, không phải tuyên bố thay thế mọi luật địa phương. Nó chỉ dùng coin ảo trên cùng máy chủ, không nạp/rút hay quy đổi tiền thật.

## Bàn và bài

- 2–4 người, một bộ 52 lá, không joker. Giá trị điểm: A = 1, 2–10 theo mặt lá, J = 11, Q = 12, K = 13.
- Người ngồi ghế đầu tiên (chủ bàn ở ván đầu) nhận 10 lá và đánh trước; các người khác nhận 9 lá. Ván sau trong cùng phòng vẫn dùng thứ tự ghế này ở local v1.
- Có tổng cộng `số người × 4 − 1` lượt bốc/ăn sau lá đánh đầu. Mỗi lượt bốc/ăn phải đánh một lá. Sau lá đánh cuối, bàn chuyển sang hạ bài.
- Ván kết thúc sớm khi một người **ù** ngay sau khi có 10 lá và toàn bộ 10 lá có thể phân thành phỏm. Không có ù khan, ù tròn, tái hay gửi ù trong v1.

## Phỏm, rác và lựa chọn nhóm

- **Bộ**: 3 hoặc 4 lá cùng số/giá trị, khác chất vì bộ bài chỉ có một lá mỗi chất.
- **Dây**: ít nhất 3 lá liên tiếp cùng chất. A chỉ thấp (`A-2-3` hợp lệ); `Q-K-A` và mọi dây vòng không hợp lệ.
- Một lá chỉ thuộc tối đa một phỏm. Khi có phỏm chồng lấn, người chơi tự chọn nhóm để hạ. Gợi ý của server duyệt mọi tổ hợp hợp lệ, tối thiểu điểm rác, không dùng thuật toán greedy.
- Điểm rác là tổng điểm các lá không nằm trong phỏm đã hạ và chưa gửi. Người không hạ bất kỳ phỏm nào là **móm**, có 150 điểm để luôn đứng sau mọi tay bài tối đa 10 lá trong biến thể này.

## Lượt bốc, ăn và đánh

1. Người đầu tiên đánh một lá.
2. Người kế tiếp chọn **bốc** một lá từ nọc hoặc **ăn** chính lá vừa đánh, rồi đánh một lá.
3. Ăn chỉ hợp lệ khi người chơi đồng thời gửi một nhóm phỏm hợp lệ chứa lá đang ăn. Lá đã ăn được ghi lại và bắt buộc nằm trong phỏm khi hạ; client không thể tự xác nhận điều này.
4. Lá vừa đánh ngay trước lượt bốc/ăn cuối là **lá chốt**. Ăn lá này là ăn chốt; người ăn vẫn phải đánh lá cuối trước khi bàn hạ.

Không được đánh lại lá đã ăn hoặc đánh một lá làm các lá đã ăn không còn nằm trong bất kỳ bộ phỏm hợp lệ, không chồng lấn nào. Server kiểm tra khả năng này trước khi đổi tay/lượt; UI khóa các lá không thể đánh. Người chơi vẫn có thể chọn cách nhóm phỏm khác khi hạ nếu bảo toàn mọi lá đã ăn.

## Hạ và gửi

- Khi hết vòng, người mở đầu hạ trước rồi theo chiều ghế. Người đang hạ chọn các phỏm không chồng lấn và server kiểm tra lại mọi lá ăn bắt buộc.
- Sau khi một người đã hạ, những người hạ sau có thể gửi lá rác của mình vào một phỏm công khai của người hạ trước, miễn thêm lá đó vẫn tạo bộ/dây hợp lệ. Không gửi vào phỏm của chính mình và không gửi vào người chưa hạ.
- Lá đã hạ công khai; bài chưa hạ của người khác không bao giờ được gửi về client. Điểm được tính sau gửi.

## Coin và thanh toán

Đơn vị `S` do chủ bàn chọn khi tạo phòng (mặc định 10 coin), chấp nhận `500`, `1.000`, `10k`, `10tr`. Engine chỉ ghi một settlement zero-sum khi kết thúc; hủy trước lá đánh đầu hoặc phòng hết hạn hoàn toàn khoản giữ.

| Tình huống | Chuyển coin | Quan hệ ưu tiên |
|---|---:|---|
| Ăn thường | người ăn → người đánh: `1S` | Cộng dồn đến settlement |
| Ăn chốt | người ăn → người đánh: `2S` | Cộng dồn đến settlement |
| Tính điểm | mỗi cặp khác điểm: người điểm cao → người điểm thấp: `1S`; bằng điểm không chuyển | Chỉ áp dụng khi không ù/đền |
| Ù | mỗi đối thủ → người ù: `4S` | Thay **tiền tính điểm**, không thay tiền ăn đã phát sinh |
| Đền | người đã ăn từ 3 lá trở lên → mỗi đối thủ: `6S` | Thay toàn bộ tiền ăn và điểm của **người đền**; tiền ăn độc lập giữa các người khác vẫn giữ |

Nếu có nhiều người cùng điểm thấp nhất, họ đồng hạng; không có khoản tính điểm giữa họ. Ăn ba lá kích hoạt đền ở settlement cuối (không chuyển tiền giữa ván), nên reload/hủy không thể để lại khoản nợ dở dang.

### Cận trên khoản giữ

Một người đền mất tối đa `6S × (n − 1)`, với `n` là số người. Đây lớn hơn trường hợp không đền: tối đa bốn lần ăn (một lần có thể là chốt `2S`, tổng không quá `5S`) cộng nhiều nhất `(n − 1)S` tiền xếp điểm. Vì vậy mỗi người được giữ trước:

```text
maxLoss = 6 × S × (n − 1) coin
```

Tương ứng 60 / 120 / 180 coin cho bàn 2 / 3 / 4 người. Server không chia bài nếu toàn bộ khoản giữ này không thể tạo nguyên tử.

## Kết nối lại và giới hạn

- Mất kết nối trong lượt bốc/ăn, đánh hoặc hạ/gửi làm bàn tạm dừng tối đa 120 giây. Deadline, bài, lá vừa đánh, phỏm đã hạ, nghĩa vụ ăn và khoản giữ được snapshot để khôi phục sau restart; restart lặp lại không cấp lại grace.
- Hết grace, ván tiếp tục và server tự rút, hạ hoặc bỏ lá hợp lệ khi ghế vắng đến lượt. Settlement và khoản giữ vẫn chạy theo luật; disconnect không hủy ván hoặc tự hoàn coin. Chủ phòng chỉ có thể hủy trước lá đánh đầu tiên; người rời giữa ván được cash-out sau khi settlement và kết quả đã ghi xong.
- Không có timer, tái, ù khan/ù tròn, báo, gửi trước hạ, hoặc các luật phạt địa phương ngoài bảng trên.

Mỗi lượt bốc/ăn và đánh có tổng cộng 30 giây. Hết giờ server tự bốc nếu cần, đánh lá được phép bỏ mà không phá phỏm bắt buộc của lá đã ăn; khi hạ sẽ dùng phương án phỏm hợp lệ. Đồng hồ giữ phần còn lại trong grace và lượt của ghế vắng được xử lý ngay khi grace hết. Phòng legacy trước reconnect policy 2 vẫn dùng quy tắc hết hạn 12 giờ để hoàn khoản giữ; bàn policy 2 không bị hủy do disconnect.

Chủ bàn chọn **Chia ván tiếp** để giữ coin và chia ngay trên cùng bàn.
