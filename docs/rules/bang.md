# BANG! bộ cơ bản — phạm vi local v1

## Phiên bản và nguồn

Triển khai này dùng **BANG! Fourth edition** của daVinci/dV Giochi, không thêm
lá, nhân vật hay luật từ Dodge City, The Bullet hoặc bất kỳ mở rộng nào. Nhà
phát hành xác định hộp cơ bản dành cho 4–7 người, có 7 vai, 16 nhân vật và 80
lá chơi trong [rulebook Fourth edition chính thức](https://bang.dvgiochi.com/content/1/docs/01_bang_rules_EN.pdf).
Số lượng và suit/rank của lá được chép từ [danh mục lá BANG! của dV Giochi](https://bang.dvgiochi.com/cardslist.php?id=1).

Nguồn được kiểm tra ngày 05-10-2026. Tên giao diện có thể Việt hoá, còn ID
quy tắc giữ nguyên tên tiếng Anh để không nhập nhằng với các mở rộng.

## Thành phần được triển khai

| Nhóm | Thành phần |
|---|---|
| Vai | 1 Sheriff, 2 Deputy, 3 Outlaw, 1 Renegade. Theo số người: 4 = Sheriff/Renegade/2 Outlaw; 5 thêm 1 Deputy; 6 = 3 Outlaw + 1 Deputy; 7 = 3 Outlaw + 2 Deputy. |
| Nhân vật | Bart Cassidy (4), Black Jack (4), Calamity Janet (4), El Gringo (3), Jesse Jones (4), Jourdonnais (4), Kit Carlson (4), Lucky Duke (4), Paul Regret (3), Pedro Ramirez (4), Rose Doolan (4), Sid Ketchum (4), Slab the Killer (4), Suzy Lafayette (4), Vulture Sam (4), Willy the Kid (4). Sheriff có thêm 1 máu. |
| Trang bị xanh | Barrel ×2, Dynamite ×1, Scope ×1, Mustang ×2, Jail ×3; Remington ×1 (tầm 3), Rev. Carabine ×1 (tầm 4), Schofield ×3 (tầm 2), Volcanic ×2 (tầm 1), Winchester ×1 (tầm 5). |
| Lá nâu | BANG! ×25, Missed! ×12, Beer ×6, Cat Balou ×4, Stagecoach ×2, Wells Fargo ×1, Duel ×3, General Store ×2, Gatling ×1, Indians! ×2, Panic! ×4, Saloon ×1. |

Tổng chính xác là **80 lá**, mỗi lá có ID độc lập ở server (kể cả hai lá trùng
suit/rank vật lý). Toàn bộ 16 năng lực nhân vật có trong engine: rút/lật riêng
cho Bart, Black Jack, Jesse, Kit, Lucky, Pedro, Suzy và Vulture; chuyển đổi
BANG!/Missed! của Calamity; Barrel/Mustang/Scope bẩm sinh; phản ứng, sát
thương và giới hạn BANG! cho các nhân vật còn lại.

## Chuẩn bị và thông tin kín

- Server xáo vai và nhân vật, chỉ công khai Sheriff. Mỗi ghế biết vai của mình;
  vai khác chỉ lộ khi bị loại hoặc khi ván kết thúc.
- Nhân vật công khai. Mỗi người nhận số lá bằng máu ban đầu; Sheriff đi trước.
- Server chỉ gửi `myHand` cho chính ghế đó. Người đã chết vẫn chỉ thấy bài/vai
  đã công khai, không nhận bài/vai của người còn sống.
- Chồng rút hết sẽ xáo chồng bỏ công khai. Lá trong tay, lá General Store đang
  mở và bài đang chờ phản ứng không bị xáo nhầm vào chồng rút.

## Lượt, khoảng cách và trang bị

Mỗi lượt: xử lý Dynamite rồi Jail (nếu có), rút 2 lá với lựa chọn riêng của
nhân vật, chơi bao nhiêu lá hợp lệ muốn chơi, rồi bỏ cho đến khi số lá trên tay
không lớn hơn máu hiện có. Súng Colt .45 mặc định có tầm 1; chỉ giữ một vũ khí
xanh. Vũ khí mới bỏ vũ khí cũ. Không có hai bản sao cùng tên trước mặt (trừ
hiệu ứng bẩm sinh của nhân vật).

Khoảng cách được tính vòng tròn chỉ theo người còn sống. Scope/Rose giảm
khoảng cách nhìn thấy; Mustang/Paul tăng khoảng cách khi người khác nhìn họ;
kết quả nhỏ nhất là 1. Vũ khí đổi tầm bắn, **không** đổi khoảng cách. Sau một
người bị loại, khoảng cách được tính lại ngay.

Chỉ được đánh một lá BANG! mỗi lượt, trừ Volcanic hoặc Willy the Kid.
Calamity Janet đổi được BANG! và Missed!, nhưng BANG! được chơi theo cách đó
vẫn tính vào giới hạn. Slab the Killer yêu cầu hai Missed! để chặn BANG! thật
của ông ấy.

## Hiệu ứng và phản ứng

Server giữ `pending` effect ID cùng người phải phản ứng, mục tiêu, chuỗi tiếp
theo và lựa chọn hợp lệ. Khi còn `pending`, lượt chính bị dừng; chỉ đúng người
có thể trả lời. Trạng thái này được lưu để reconnect/restart tiếp tục mà không
giải quyết hai lần.

- **BANG!/Gatling:** mục tiêu bỏ Missed! (hoặc BANG! nếu Calamity), có thể rút
  Barrel/Jourdonnais trước, hoặc nhận 1 máu. Gatling lần lượt nhắm mọi người
  khác, không tính vào giới hạn BANG!.
- **Beer và chết:** khi mất máu cuối cùng, chỉ Beer có thể cứu; có thể dùng
  nhiều Beer liên tiếp nếu vẫn chưa trên 0. Beer không có hiệu lực khi chỉ còn
  hai người. Saloon không phải lá cứu ngoài lượt.
- **Duel:** hai người lần lượt bỏ BANG! (Calamity có thể dùng Missed!); người
  không bỏ được nhận 1 máu. Barrel/Missed! thường không chặn Duel.
- **Indians!:** mỗi người khác phải bỏ BANG! hoặc nhận 1 máu; Missed!/Barrel
  không chặn.
- **Jail/Dynamite:** đầu lượt rút kiểm tra. Jail thoát khi Heart, nếu không
  bỏ lượt; không được đánh Sheriff. Dynamite nổ khi Spade 2–9 gây 3 máu, nếu
  không nổ thì chuyển sang người sống bên trái. Dynamite luôn kiểm tra trước
  Jail. Lucky Duke lật hai lá cho mọi lần rút kiểm tra và tự chọn kết quả.
- **Panic!/Cat Balou:** chọn một trang bị công khai của mục tiêu, hoặc server
  chọn ngẫu nhiên lá tay kín. Panic! lấy lá (tầm 1); Cat Balou bỏ lá (mọi tầm).
- **Stagecoach/Wells Fargo, Beer, Saloon:** rút 2/rút 3, hồi bản thân, hoặc
  hồi tất cả người còn sống. **General Store** mở bằng số người còn sống rồi
  chia lần lượt theo chiều kim đồng hồ.

## Loại người và kết thúc

Khi máu còn 0 sau cơ hội Beer, người đó lộ vai, bỏ bài tay/trang bị (Vulture
Sam lấy chúng nếu còn sống). Server kiểm tra thắng **ngay lúc đó** trước thưởng
hoặc hiệu ứng theo sau: Sheriff chết thì Renegade thắng chỉ khi là người sống
duy nhất, nếu không Outlaw thắng; khi toàn bộ Outlaw và Renegade chết thì
Sheriff/Deputy thắng.

Nếu ván chưa kết thúc, người loại Outlaw rút 3 lá; Sheriff loại Deputy phải bỏ
toàn bộ bài tay/trang bị. BANG! là game Giải trí: không có giữ chip hay thanh
toán ví. Khi kết thúc hợp lệ, toàn bộ người từng tham gia (kể cả bị loại sớm)
được ghi một `matchId` duy nhất cho nhiệm vụ; reload hay gửi lại action không
ghi thưởng lần hai.

## Reconnect và hành động tự động

Ghế mất kết nối có tối đa 120 giây để khôi phục; deadline được lưu qua restart và không được đặt lại nếu server khởi động lại lần nữa. Bàn tạm dừng trong grace. Hết grace, các ghế còn kết nối tiếp tục chơi và server hành động khi ghế vắng đến lượt hoặc cần phản ứng:

- **BANG!/Gatling:** dùng Missed! hợp lệ trước; nếu không có thì thử Barrel còn lại; nếu không thể chặn thì nhận sát thương.
- **Indians!/Duel:** bỏ BANG! hợp lệ nếu có, nếu không nhận sát thương.
- **Jail/Dynamite/Barrel:** chọn lá kiểm tra có lợi nếu có; Lucky Duke chọn trong hai lá đã mở.
- **General Store/Kit Carlson:** lấy lá mở đầu tiên hoặc hai lá đầu theo thứ tự server.
- **Mất máu cuối:** dùng Beer hợp lệ nếu cứu được, nếu không thì bị loại theo luật.
- **Lượt thường:** rút bài nếu đang ở pha rút; khi hết lượt bỏ đúng số bài dư theo thứ tự tay bài.

Chủ bàn có thể chọn **Rời sau ván** giữa ván; ghế được gỡ sau kết quả và phát `room_left`. Disconnect không hủy ván. Bàn policy 2 không bị hủy vì đã mất kết nối quá lâu; quy tắc hết hạn cũ chỉ áp dụng với snapshot legacy chưa có policy này.

## Giới hạn giao diện local v1

Không có bot, mở rộng hay luật nhà. Các hành động tự động là lựa chọn server xác định theo các mục trên; client không gửi cờ tự xử lý, bài đối thủ hoặc trạng thái ẩn.
