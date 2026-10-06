# UNO — `classic-local-v1`

Ngày chốt: 05/10/2026. Phạm vi: M2.

## Nguồn và mức độ chính thức

Nguồn tham khảo chính là [Mattel UNO Card Game GXV52-Eng.pdf](https://service.mattel.com/instruction_sheets/GXV52-Eng.pdf), bản hướng dẫn do Mattel phát hành năm 2020. Nguồn này ghi bộ 112 lá, 2–10 người, chia 7 lá, cách đánh theo màu/số/biểu tượng, hành vi lá chức năng, gọi UNO, phản đối Wild Draw Four và việc tái xáo chồng bỏ. Đây là căn cứ cho các luật đánh bài của `classic-local-v1`.

Một số quyết định dưới đây là local của cổng game, không được gắn nhãn “luật chính thức”: ứng dụng chỉ hỗ trợ 2–4 người ở M2; tên màu `red` hiển thị là đỏ (nguồn GXV52 gọi màu tương ứng là pink); không tính điểm 500 nhiều vòng; Reverse trong bàn hai người được xử lý như Skip; đồng hồ phản ứng là chính sách kỹ thuật của server.

## Bộ bài và giới hạn

- 2–4 người trong ứng dụng M2; nguồn Mattel rộng hơn là 2–10.
- 112 lá, mỗi lá có `id` riêng: 76 lá số (mỗi màu có một số 0 và hai bản số 1–9), 8 Draw Two, 8 Reverse, 8 Skip, 8 Wild và 4 Wild Draw Four.
- Mỗi người nhận 7 lá. Chồng còn lại là chồng rút; một lá mở đầu được đặt vào chồng bỏ.
- Wild Draw Four nếu lật làm lá đầu sẽ được trả vào bộ và rút lá khác. Nếu lá đầu là Draw Two, Reverse hoặc Skip, hiệu ứng áp dụng ngay theo quy tắc của lá. Nếu lá đầu là Wild, người bắt đầu phải chọn màu trước lượt đầu; đây là cách local để không dùng màu ngầm.

## Lượt và hành động

Người chơi phải đánh lá khớp màu hiện hành, số hoặc biểu tượng; Wild luôn có thể đánh. Có thể chọn rút dù đang có lá đánh được. Nếu lá vừa rút đánh được, người chơi chỉ được đánh chính lá đó trong cùng lượt hoặc bỏ lượt; không được đánh lá khác trong tay.

- `play_card`: đánh đúng lá trong tay, kèm `chosenColor` cho Wild/Wild Draw Four.
- `draw_card`: rút một lá. Lá đánh được tạo lựa chọn `play_drawn` hoặc `pass_draw`.
- `draw_penalty`: rút toàn bộ phạt đang chờ. Không được đánh chồng Draw Two hoặc Wild Draw Four.
- Reverse đổi hướng; Skip bỏ lượt kế tiếp; Draw Two làm người kế tiếp rút 2 và mất lượt; Wild đổi màu; Wild Draw Four đổi màu và mở cửa sổ phản ứng.
- Không đánh nhiều lá cùng lúc, không nhảy lượt và không cộng dồn phạt trong variant này.

Trong bàn hai người, Reverse được xử lý như Skip để lượt quay lại người vừa đánh. Đây là quyết định local vì tài liệu GXV52 không đặc tả riêng bàn hai người.

## Gọi UNO và phản đối

Khi đánh lá áp chót và còn đúng một lá, người chơi bấm `call_uno`. Nếu chưa gọi, server mở cửa sổ bắt lỗi 5 giây hoặc tới khi người kế tiếp bắt đầu hành động, tùy điều kiện nào đến trước. Người khác bấm `catch_uno` thì người quên gọi rút 2 lá. Sau khi cửa sổ đóng, không thể bắt lỗi cho lượt đó.

Khi Wild Draw Four được đánh, server lưu màu hiện hành trước lá +4 và mở cửa sổ 15 giây cho người bị tác động. Người đó chọn:

- Rút 4 và mất lượt.
- Phản đối. Nếu người đánh có lá cùng màu với màu trước +4, phản đối thành công và người đánh +4 rút 4; nếu không có, phản đối thất bại và người phản đối rút 6 rồi mất lượt.

Bài dùng để kiểm tra tính hợp lệ nằm trên server; bản tin phản đối chỉ công bố kết quả, không gửi bài của người đánh ra cả bàn.

## Lá cuối, chồng rút và kết quả

Nếu lá cuối là Draw Two, người kế tiếp vẫn rút 2 trước khi kết thúc ván. Nếu lá cuối là Wild Draw Four, cửa sổ phản đối vẫn được xử lý trước khi kết thúc ván; số lá phạt được cập nhật cho người bị tác động hoặc người đánh sai. Ván kết thúc khi một người có 0 lá sau khi hiệu ứng lá cuối đã được xử lý.

Khi chồng rút hết, server giữ lại lá trên cùng của chồng bỏ, xáo phần còn lại thành chồng rút mới và giữ nguyên mọi `cardId`; nếu không còn lá để xáo thì không tự sinh lá mới.

M2 dùng một ván có người hết bài làm đơn vị kết quả. Không cộng điểm lá còn lại và không chạy cuộc đua 500 điểm nhiều ván, dù đó là cách ghi điểm trong nguồn Mattel. “Trận” nhiều ván và scoring sẽ là phạm vi sau; `matchId`/`resultId` của kết quả hiện tại đã được lưu để M3 nhận sự kiện.

## Đồng hồ, reconnect và khôi phục

Ghế mất kết nối có 120 giây để khôi phục. Hạn này được lưu cùng snapshot và không được gia hạn thêm khi server khởi động lại lần nữa. Bàn tạm dừng trong grace; sau đó khi ghế vắng đến lượt, server tự chọn màu đỏ cho Wild mở đầu, rút phạt đang chờ, hoặc rút rồi bỏ lượt theo trạng thái hợp lệ. Không tự đánh một lá bài kín thay người chơi.

Deadline phản ứng là thời gian tuyệt đối do server tạo, không tin đồng hồ client. Cửa sổ gọi/bắt UNO 5 giây và phản đối +4 15 giây vẫn tiếp tục chạy trong grace và khi server restart. Nếu hết hạn, server tự đóng cửa sổ hoặc xử lý +4 theo luật trước khi phát trạng thái tiếp theo. Resume khôi phục đúng `matchId`, revision, lượt, hướng, màu, bài riêng, phạt và deadline phản ứng.

Các action phải có `actionId`, `matchId` và `expectedRevision`. Action trùng trả `DUPLICATE_ACTION`; revision cũ trả `STALE_REVISION`; action ngoài lượt/giai đoạn không đổi state.

## Rời phòng

Người chơi có thể chọn **Rời sau ván** để xếp lịch rời ngay cả khi bàn đang tạm dừng; ghế và phiên chỉ được gỡ khi nhận `room_left` sau kết quả. Nút **Hủy ván & rời** giữ hành vi hiện có: hủy ván, xóa cửa sổ phản ứng, đưa người còn lại về phòng chờ và không ghi thắng/thưởng. Mất kết nối tự nó không hủy ván. Sau khi rời, người chơi dùng cùng hồ sơ để tạo/vào game khác.
