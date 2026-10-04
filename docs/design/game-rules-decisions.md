# M0 — Quyết định luật và các điểm còn mở

> Các luật dưới đây là mặc định **local để triển khai**, không phải xác nhận luật chính thức hay luật thống nhất giữa mọi vùng. Mỗi game phải có `rules.md` riêng trước khi gắn `playable`.

## 1. Nguyên tắc chốt luật

Một variant chỉ được đưa vào production khi có:

- mã và version, số người, bộ bài/thành phần;
- trạng thái và thứ tự lượt;
- action hợp lệ/không hợp lệ và lỗi;
- timeout/disconnect;
- điều kiện kết thúc, hòa và bảng điểm/chip;
- tối thiểu một ví dụ cho từng trường hợp đặc biệt;
- test case từ tài liệu luật.

Luật nhà là cấu hình có tên, version và hiển thị trước khi tạo phòng. Không âm thầm đổi luật giữa hai trận cùng variant.

## 2. The Gang — bảo toàn implementation hiện tại

| Mục | Mặc định đang có | Quyết định M0 |
|---|---|---|
| ID | Chưa có game ID độc lập; `mode` đang là `BASIC`, `ADVANCED`, `EXPERT`, `MASTER_THIEF` | Map thành `gameId=the-gang`, `ruleVariant=base-v1`, `difficulty=mode` |
| Người chơi | 2–6 | Giữ; tách khỏi giới hạn game khác |
| Vòng | Pre-Flop → Flop → Turn → River → Showdown | Giữ state machine hiện tại |
| Rank chip | Chip 1..N theo thứ tự bài | Giữ hoàn toàn; không vào wallet |
| Private state | bài tẩy, insight specialist, chip/log bị lọc trong `buildStateFor` | Giữ redaction; viết contract test khi adapter hóa |
| Reconnect | token ghế, giữ bài/chip, chuyển host | Giữ semantics; đổi persistence sau M3 |
| Mode | 4 mode trong `src/cardsData.js` | Giữ tên/ý nghĩa trong variant; không dùng làm category |
| Kết quả | phá két hoặc báo động; lịch sử room | Giữ kết quả; sau này event `match_completed` chỉ khi kết thúc hợp lệ |

Không chỉnh luật The Gang trong M0. Browser check hiện tại có lỗi baseline, nhưng test engine/integration pass nên chưa coi đó là lý do thay đổi luật.

## 3. UNO — đề xuất `classic-local-v1`

| Quy tắc | Mặc định local | Còn mở trước M2 |
|---|---|---|
| Người chơi | 2–4, một phòng một match | Có mở 5–8 không |
| Bộ bài | UNO classic 108 lá, server xáo/chia; bài người khác private | Bộ bài house cụ thể nếu dùng biến thể khác |
| Lượt | Theo chiều bắt đầu; lá đánh phải cùng màu, số/ký hiệu hoặc Wild | Có cho chọn hướng sau Wild không |
| Wild | Người đánh chọn màu tiếp theo | Wild Draw Four chỉ hợp lệ khi không có lá cùng màu; có challenge hay không |
| Draw | Không có lá hợp lệ thì rút 1; nếu lá vừa rút hợp lệ có thể đánh ngay | Draw-until-play có bật không; mặc định không |
| Skip/Reverse/+2 | Xử lý theo classic; 2 người thì Reverse tương đương Skip | Cách tính phạt khi chuỗi +2; mặc định không stacking |
| UNO | Bấm báo UNO khi còn 1 lá; server ghi timestamp; quên bị phạt 2 lá nếu bị bắt trước lượt kế | Ai được bắt và cửa sổ bắt bao lâu |
| Kết thúc | Người hết bài thắng ván; điểm theo bài còn lại là optional sau | Có chơi nhiều ván tới 500 điểm không |
| Chip | `usesWallet=false`; nhiệm vụ tính match hoàn thành | Có reward daily hay chờ M3 |

M2 phải test action stale/duplicate, private hand, Wild color, UNO penalty, disconnect và resume; không gửi toàn bộ deck cho client.

## 4. Tiến lên — đề xuất `south-v1`

Đây là Tiến lên miền Nam local, không tự nhận là luật chuẩn duy nhất.

| Quy tắc | Mặc định đề xuất | Điểm phải chốt |
|---|---|---|
| Người chơi/bài | 4 người ưu tiên; cho phép 2–3 ở variant test; bộ 52 lá, mỗi người 13 | Bản phát hành có cho 2–3 không |
| Thứ tự | 3 thấp nhất, 2 cao nhất; chất dùng khi so lá đơn/chặt theo bảng variant | Thứ tự chất vùng/local; default tạm `3♠ < 3♣ < 3♦ < 3♥` chỉ là cấu hình test |
| Mở đầu | Người có 3♠ đi trước ở ván đầu; ván sau người thắng ván trước đi | Nếu 3♠ nằm trong bộ đã quy định khác |
| Tổ hợp | Đơn, đôi, ba, sảnh ≥3 lá, tứ quý, đôi thông ≥3 đôi | Sảnh có được chứa 2; default không |
| Đánh/chặn | Cùng loại và lớn hơn; tứ quý/đôi thông được chặt 2 theo bảng | Cụ thể chặt 2 và thứ tự đôi thông |
| Bỏ lượt | Bỏ lượt tới khi vòng kết thúc; khi mọi người bỏ, người đánh cuối mở lượt mới | Có giới hạn reconnect/timeout |
| Kết thúc | Người hết bài đầu tiên thắng; những người còn lại xếp hạng | Có tính thối, cóng, tới trắng không |
| Chip local | Giữ trước 100/người; winner nhận pot 400, tương đương +300/-100 trong ví | Cận trên phạt chặt/thối phải được tính trước khi bật |

**Mặc định triển khai an toàn:** chưa bật `tới trắng`, `thối 2`, `cóng`, `đền` hoặc thanh toán phạt phức tạp cho tới khi có decision table và max-loss reservation. Không dùng một mức cược cơ bản để giả vờ đã bao phủ trách nhiệm đền.

## 5. Poker — đề xuất `holdem-nl-local-v1`

| Quy tắc | Mặc định local | Còn mở |
|---|---|---|
| Bàn | Texas Hold'em No-Limit, 2–9 người | Giới hạn bản đầu 6 hay 9 |
| Blind | Small/big blind cấu hình, đề xuất 10/20; dealer button xoay | Heads-up button/blind order |
| Buy-in | 20–200 big blinds, stack integer | Auto top-up giữa ván có bật không |
| Vòng | Pre-flop, flop, turn, river, showdown | Chia bài burn card có cần state riêng không |
| Action | fold/check/call/bet/raise/all-in; server quyết định min raise | Reopen betting khi all-in thiếu mức raise |
| Pot | Main pot + side pots, hòa chia chip dư theo quy tắc seat order | Chip lẻ khi chia pot |
| Kết quả | `handEvaluator.js` tái dùng sau khi test hole/community; không dùng luật rank chip The Gang | Bộ so bài Jack `suit=none` chỉ thuộc The Gang, không đưa vào Poker |
| Disconnect | Chờ grace; sau đó check nếu hợp lệ, fold khi phải call; ghi timeout action | Thời gian grace và auto-action chính thức |
| Chip | Buy-in chuyển wallet → stack; pot → stack; rời bàn sau ván trả stack | Phí bàn mặc định 0; không sinh chip |

M5 bắt buộc test all-in, side pot, tie, min raise, stale action, reconnect/restart và settlement đối soát.

## 6. Sâm lốc — đề xuất `sam-local-v1`

Chưa chọn là variant production. Mặc định nghiên cứu để viết luật:

- 2–4 người, 52 lá; thứ tự và tổ hợp gần Tiến lên nhưng không tự thừa nhận giống hệt.
- Có action `declare_sam` trước khi đánh theo cửa sổ được chốt; server ghi người báo.
- Bảng chặn/báo một/thắng đặc biệt và trách nhiệm đền phải là decision table độc lập.
- Nếu không tính được max-loss cho mọi trường hợp, `usesWallet` giữ false và không mở phòng Kịch tính.

Điểm mở: thời điểm báo Sâm, điều kiện hủy Sâm, đền khi người khác chặn, cóng, thối và thanh toán.

## 7. Phỏm — đề xuất `phom-local-v1`

Chưa chọn là variant production. Mặc định nghiên cứu để viết luật:

- 2–4 người, bộ 52 lá, chia 9 lá (người đi đầu 10 nếu variant dùng luật đó), mỗi lượt bốc/nọc hoặc ăn lá trước rồi đánh.
- Hạ phỏm, gửi bài và tính điểm chỉ sau khi chốt thứ tự hạ.
- Ù/móm/ăn chốt/đền phải được mô hình hóa bằng event kết quả, không suy từ UI.

Điểm mở: số lá chia, thứ tự người đầu, cách tính điểm A/J/Q/K, đền chốt, gửi bài khi bằng điểm và cận trên chip.

## 8. BANG! — đề xuất `base-local-v1`

Chưa chọn là variant production. Phạm vi sau cùng chỉ là bộ cơ bản, không mở rộng:

- Vai ẩn được server giữ; mỗi người chỉ nhận role view của mình và public thông tin đúng luật.
- Chốt số người, vai, nhân vật, khoảng cách, vũ khí, lượt và điều kiện thắng phe trước M6C.
- Các action ngoài lượt (phản ứng, Missed!, Bang!, Beer, Jail/Dynamite nếu có) phải có timeout/window riêng.
- Không gửi danh sách vai, deck chưa rút hoặc mục tiêu ẩn trong snapshot/log.

Điểm mở lớn nên không được gắn `playable` trong registry M1/M2.

## 9. Bảng quyết định liên game

| Chủ đề | Mặc định M0 | Lý do/điều kiện đổi |
|---|---|---|
| Difficulty | Thuộc `ruleVariant`/config của game | `modeId` cũ chỉ là The Gang difficulty |
| Pause | The Gang pause khi thiếu người; game khác theo module | Không dùng chung một hành vi bỏ lượt |
| Reconnect | Giữ seat/private state; một controller/socket | Bảo vệ bài/vai và tránh action trùng |
| Game chưa làm | `coming_soon`, không tạo room | Không dùng fake data trong production |
| Giải trí hết chip | Vẫn chơi được, nhiệm vụ có thể cấp reward | Không khóa người dùng khỏi cổng |
| Kịch tính hết chip | Chặn entry chỉ khi cần reservation; chỉ rõ số thiếu | Không cấp chip vô hạn |
| Chip The Gang | Rank chip, không ledger | Không trộn kinh tế với luật hợp tác |
| Lịch ngày nhiệm vụ | `Asia/Ho_Chi_Minh` trên server | Không tin đồng hồ thiết bị |
| Tiền thật | Không có | Local virtual chip only |

Mọi mục “còn mở” phải được chuyển thành issue/decision record trước khi mốc tương ứng bắt đầu; M0 không yêu cầu người dùng chốt toàn bộ bảy game ngay.
