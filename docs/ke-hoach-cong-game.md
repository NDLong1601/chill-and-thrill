# Kế hoạch mở rộng The Gang thành cổng game LAN

Ngày lập: 05/10/2026. Trạng thái: đề xuất để triển khai; chưa thay đổi chương trình.

## 1. Mục tiêu và giả định

Khi mở địa chỉ máy chủ, người chơi thấy trang chủ, chọn Giải trí hoặc Kịch tính, chọn game, tạo/tham gia phòng rồi vào bàn. Một nền tảng dùng chung phục vụ nhiều game; mỗi game giữ luật và giao diện riêng.

- **Giải trí:** The Gang hiện có, UNO, BANG! và các boardgame bổ sung sau.
- **Kịch tính:** Poker, Sâm lốc, Tiến lên, Phỏm. Dùng chip ảo để tham gia bàn và tính thắng thua; nhận chip từ nhiệm vụ.
- Chip chỉ có giá trị trong máy chủ local; không thiết kế nạp/rút tiền hoặc quy đổi phần thưởng có giá trị. Không có phí bàn ở bản đầu.
- Hiểu “local” là một máy chạy server, mỗi người dùng điện thoại/máy tính riêng cùng WiFi. Chơi một mình với bot là phạm vi mở rộng, vì mỗi game cần AI và mức khó riêng.
- Tạm hiểu “the bang” trong yêu cầu là The Gang đang có; BANG! là một game riêng. Nếu đó là game thứ ba, bổ sung sau khi xác định tên và luật.
- Các luật và con số kinh tế bên dưới là đề xuất phạm vi sản phẩm, chưa phải tuyên bố về luật chính thức của từng game.

## 2. Hiện trạng đã đọc từ mã nguồn

| Thành phần | Hiện có | Hướng tận dụng |
|---|---|---|
| Máy chủ | Node.js, Express, Socket.IO | Giữ nền tảng cho LAN và cập nhật thời gian thực |
| Luật và phòng | `src/gameEngine.js` chứa cả GameManager và luật The Gang | Tách dần quản lý phòng khỏi luật game |
| Kết nối | Tạo/vào phòng, QR, token khôi phục ghế, chuyển chủ phòng | Đưa thành dịch vụ chung, giữ tương thích link mời cũ |
| Lưu trữ | `data/rooms.json`, bản lưu version 1 | Giữ trong đợt đầu; chuyển sang giao dịch cơ sở dữ liệu trước khi bật ví |
| Giao diện | HTML/CSS/JS, `app.js`, `enhancements.js`, bố cục bàn riêng | Tạo khung trang chung, cô lập phần giao diện The Gang |
| Bài | `deck.js`, `handEvaluator.js` | Tái dùng phần bài 52 lá và so bài đã kiểm tra phù hợp |
| Kiểm thử | Unit, integration, kịch bản browser | Giữ kiểm thử hồi quy và mở rộng theo từng game |

Hai khác biệt cần xử lý ngay:

1. `modeId` đang có nghĩa là độ khó The Gang. Phải tách **chế độ toàn hệ thống**, **game**, **biến thể/độ khó** thành ba trường khác nhau.
2. Chip The Gang là dấu xếp hạng sức mạnh bài. Không đưa chúng vào ví, không quy đổi thành chip đặt cược.

Đọc mã nguồn cho thấy hiện đang giới hạn phòng ở 6 người theo The Gang. Giới hạn người và điều kiện bắt đầu phải chuyển về cấu hình của từng game. Các tính năng hiện có trong tài liệu chưa được chạy lại để xác minh ở lượt lập kế hoạch này.

## 3. Cấu trúc sản phẩm

```text
Trang chủ
├── Giải trí
│   ├── The Gang
│   ├── UNO
│   └── BANG!
├── Kịch tính
│   ├── Poker
│   ├── Tiến lên
│   ├── Sâm lốc
│   └── Phỏm
├── Vào phòng bằng mã / link / QR
├── Nhiệm vụ
├── Hồ sơ và ví chip
└── Lịch sử chơi

Mỗi game → Giới thiệu và luật → Tạo phòng / Phòng đang mở
          → Phòng chờ → Bàn chơi → Kết quả → Chơi tiếp
```

Đề xuất tuyến trang: `/`, `/play/casual`, `/play/thrill`, `/games/:gameId`, `/rooms/:code`, `/missions`, `/profile`. Máy chủ phải phục vụ đúng khi tải lại trang hoặc mở trực tiếp link con. Link cũ `/?room=ABCD` vẫn nhận diện phòng và đưa vào luồng mới.

Truy cập `/` thông thường luôn thấy trang chủ. Nếu có phiên đang chơi, hiện thẻ “Tiếp tục phòng ABCD”. Link mời được vào thẳng màn xác nhận phòng, không bắt người chơi chọn lại chế độ và game.

## 4. Các màn hình cần làm

### Trang chủ

- Hai thẻ lớn: **Giải trí — Chơi cùng bạn bè** và **Kịch tính — Đấu trí với chip ảo**.
- Thanh trên có tên/avatar, số chip và lối vào nhiệm vụ.
- Ô nhập mã phòng luôn dễ thấy; thêm nút tiếp tục phòng nếu có phiên.
- Hiện game gần đây hoặc game đang có phòng trên cùng máy chủ.
- Game chưa triển khai có nhãn “Sắp có”; không cho tạo phòng chưa chơi được.

### Danh mục và chi tiết game

- Thẻ game có tên, mô tả ngắn, số người được hỗ trợ, mức phức tạp, trạng thái phát hành.
- Trang chi tiết có luật nhanh, luật đầy đủ, cấu hình mặc định, tạo phòng và danh sách phòng cho phép hiển thị.
- Chế độ Giải trí không yêu cầu số dư chip. Chế độ Kịch tính giải thích mức cần có trước khi người chơi vào bàn.
- Không dùng thời lượng chơi cố định khi chưa có dữ liệu; nếu hiển thị ước tính phải ghi rõ.

### Tạo phòng và phòng chờ

Thông tin chung: tên phòng, giới hạn người, công khai trong LAN hoặc chỉ qua lời mời, mật khẩu tùy chọn, luật/biến thể, thời gian lượt và hành vi khi mất kết nối.

Thông tin bổ sung cho Kịch tính: mức chip, giới hạn tham gia, cách tính kết quả và mức thua tối đa theo luật đang chọn. Poker hiển thị blinds và khoảng buy-in; game còn lại hiển thị đơn vị tính chip và bảng thanh toán của biến thể.

Phòng chờ gồm danh sách ghế, avatar, trạng thái kết nối/sẵn sàng, luật tóm tắt, QR/link, quyền chủ phòng. Thay đổi luật hoặc mức chip sẽ hủy sẵn sàng của cả phòng. Khi bắt đầu, server kiểm tra lại số người, số dư và cấu hình, rồi mới khóa chip cần thiết.

Bản đầu: một phòng gắn với một game. Muốn đổi game thì tạo phòng mới. Giữ nguyên nhóm qua nhiều game là tính năng sau, tránh phải giải quyết việc đổi luật và hoàn chip cùng lúc ngay ở bản đầu.

### Bàn chơi và kết quả

- Dùng chung ghế, avatar, chỉ báo lượt, kết nối, menu, chat, âm thanh và màn kết quả.
- Vùng trung tâm và thanh hành động do từng game quyết định.
- Với game nhiều bài trên tay, hỗ trợ sắp xếp, chọn nhiều lá, xem tổ hợp hợp lệ và xác nhận đánh.
- Với Poker, hiển thị số tiền cần theo, tổng cược khi tố, stack, pot và nút fold/check/call/raise/all-in theo trạng thái hợp lệ.
- Kết quả có lý do thắng/thua, bảng tính điểm/chip, số dư trước/sau, tiến độ nhiệm vụ, chơi tiếp và rời bàn.
- Trang chủ và sảnh dùng được ở cả dọc/ngang. Chỉ yêu cầu xoay ngang cho bàn thực sự cần; không áp quy tắc của The Gang lên mọi màn hình.

## 5. Phạm vi từng game

| Game | Phạm vi phát hành đầu tiên | Phần cần kiểm tra kỹ |
|---|---|---|
| The Gang | Giữ 4 độ khó, thẻ, QR, reconnect, lịch sử, hướng dẫn và bố cục hiện có | Không làm thay đổi luật hoặc mất phiên cũ khi tách module |
| UNO | Một bộ luật nền được chốt trước; đánh/rút bài, đổi chiều, bỏ lượt, đổi màu, phạt rút, gọi UNO, kết thúc ván | Điều kiện dùng lá chức năng, phản đối/phạt, hết chồng rút; tùy chọn luật nhà phải ghi rõ |
| Tiến lên | Chọn Tiến lên miền Nam làm biến thể đầu; luật tổ hợp, bỏ lượt, kết thúc và thanh toán được đặc tả trước | Thứ tự chất, chặt, thối, tới trắng, cóng, đánh hết đầu tiên hay xếp hạng toàn bàn |
| Poker | Texas Hold’em No-Limit, một loại bàn dùng chip ảo | Thứ tự hành động, minimum raise, all-in thiếu mức tố, side pot, hòa bài, chip dư, heads-up |
| Sâm lốc | Một biến thể có báo Sâm, chặn Sâm và bảng kết quả rõ ràng | Thời điểm báo, trách nhiệm đền, báo một, thắng đặc biệt, khác biệt so với Tiến lên |
| Phỏm | Một biến thể chốt trước; bốc/ăn/đánh, hạ và tính điểm | Ù, móm, ăn chốt, đền, gửi bài, thứ tự hạ và trường hợp bằng điểm |
| BANG! | Một bộ cơ bản được xác định cụ thể, chưa thêm bản mở rộng | Vai ẩn, khoảng cách, vũ khí, phản ứng ngoài lượt, nhân vật, loại người, điều kiện thắng theo phe |

Trước khi lập trình mỗi game, tạo `rules.md` riêng gồm: phiên bản luật, số người hỗ trợ, luồng lượt, hành động hợp lệ, luật tùy chọn, ít nhất một ví dụ cho mỗi trường hợp đặc biệt và cách kết thúc. Tham khảo nguồn luật đúng phiên bản ở giai đoạn này. Tạo ca kiểm thử từ tài liệu đó.

Với Poker, có thể dùng lại phần so bài tiêu chuẩn sau khi kiểm tra. Các hiệu ứng chuyên gia, Jack không chất và chip xếp hạng của The Gang phải nằm riêng. Có sẵn trình so bài chưa đồng nghĩa đã có vòng đặt cược Poker.

## 6. Hồ sơ và chip

### Hồ sơ local

- Người chơi có hồ sơ bền vững trên server: ID, tên, avatar, ngày tạo, ví, nhiệm vụ và thống kê.
- Tách ID hồ sơ khỏi socket và token khôi phục một ghế. Mở phòng mới vẫn dùng ví cũ.
- Tạo hồ sơ nhanh không yêu cầu email. Thiết bị giữ thông tin nhận diện; ghép thiết bị mới bằng mã khôi phục hoặc PIN local phù hợp.
- Không cho lấy hồ sơ chỉ bằng cách nhập trùng tên. Không lưu PIN dạng rõ trong cơ sở dữ liệu.
- Ví dùng chung giữa các game trên cùng một server. Server khác có dữ liệu khác; không mặc định đồng bộ cloud.
- Một hồ sơ chỉ tham gia một bàn có chip tại một thời điểm trong bản đầu. Nhiều tab xem được trạng thái nhưng không cùng điều khiển một ghế.

### Các loại số dư

Phân biệt số chip **có thể dùng**, **đang giữ cho bàn/ván**, và **đang nằm trong pot**. Màn hình có thể gộp thông tin cho dễ đọc, nhưng dữ liệu kế toán phải phân biệt được.

**Poker:** chuyển chip từ ví vào stack tại bàn khi buy-in; đặt cược chuyển stack vào pot; kết thúc ván chia pot về stack; rời bàn an toàn chuyển stack còn lại về ví. Bổ sung stack chỉ giữa các ván.

**Tiến lên/Sâm/Phỏm:** giữ trước khoản đủ trang trải mức thua tối đa theo biến thể và cấu hình bàn. Sau ván thanh toán, trả phần giữ còn lại, rồi kiểm tra lại điều kiện chơi tiếp. Nếu chưa tính được cận trên trách nhiệm đền/phạt, chưa mở biến thể đó; không chỉ khóa đúng một mức cược cơ bản.

Ví dụ Tiến lên đơn giản để kiểm thử kinh tế: 4 người giữ 100 chip/người, người thắng nhận toàn bộ 400 chip. So với trước ván, người thắng +300 và ba người còn lại mỗi người -100. Đây chỉ là **luật chip local đề xuất**, không phải khẳng định về cách tính tiền tiêu chuẩn của Tiến lên. Các kiểu xếp hạng/chặt/thối sẽ có bảng riêng và mức giữ tương ứng.

### Nguyên tắc xử lý

- Server xác định hành động hợp lệ, kết quả và thay đổi chip; client gửi yêu cầu hành động.
- Chip là số nguyên; không có số dư âm, không cho dùng một khoản chip ở hai bàn.
- Mỗi cấp thưởng, buy-in, hoàn chip và thanh toán có mã giao dịch duy nhất. Gửi lại yêu cầu hoặc restart không thực hiện lần thứ hai.
- Ghi sổ mọi thay đổi: người chơi, loại giao dịch, lượng chip, nguồn, phòng/ván, thời điểm, số dư liên quan.
- Ví, phần giữ, pot và trạng thái ván được cập nhật trong giao dịch nguyên tử; lỗi giữa chừng không tạo ra trạng thái đã trừ tiền nhưng chưa ghi ván.
- Tổng chip trước/sau một ván phải bằng nhau. Chip mới chỉ sinh từ nguồn thưởng được ghi nhận hoặc thao tác quản trị có nhật ký.
- Không chuyển chip trực tiếp giữa người chơi ở bản đầu. Quản trị local có thể reset/cấp chip cho buổi chơi, nhưng phải có xác nhận và ghi lịch sử; quyền này khác quyền chủ phòng.

### Con số khởi đầu để thử nghiệm

| Nguồn | Chip đề xuất | Điều kiện |
|---|---:|---|
| Hồ sơ mới | 1.000 | Một lần cho mỗi hồ sơ |
| Hoàn thành một ván hợp lệ | 100 | Một lần mỗi ngày |
| Hoàn thành ba ván hợp lệ | 200 | Một lần mỗi ngày |
| Chơi hai game khác nhau | 150 | Một lần mỗi ngày; chỉ bật khi có đủ game |
| Hoàn thành hướng dẫn tương tác | 200 | Một lần cho nhiệm vụ mở đầu |

Các số này là cấu hình để thử, cần chỉnh theo thời gian chơi thực tế. Ví dụ bàn nhập môn tiêu hao tối đa 100 chip mỗi ván ở luật đơn giản để người mới có khoảng 10 lần tham gia từ số dư ban đầu. Poker cần đặt mức blinds và buy-in riêng để có thời gian chơi hợp lý.

Khi hết chip, người chơi vẫn vào Giải trí và hoàn thành nhiệm vụ. Có thể thêm nhiệm vụ cứu trợ giới hạn ngày nếu thử nghiệm cho thấy người chơi bị kẹt quá lâu; không tự động cấp vô hạn sau mỗi lần thua.

## 7. Nhiệm vụ

- Có nhóm làm quen một lần và nhóm hằng ngày. Thành tựu dài hạn bổ sung sau.
- Ưu tiên tham gia và hoàn thành ván; không yêu cầu cược lớn, cố tình thua hoặc phải thắng liên tục.
- Game Giải trí cũng giúp kiếm chip, tạo đường đi tự nhiên sang Kịch tính.
- Server cập nhật tiến độ từ sự kiện đã xác nhận như `match_completed`, `tutorial_completed`. Client không tự báo “đã thắng” để nhận thưởng.
- Phân biệt ván con, trận và phiên chơi. Với The Gang, đề xuất nhiệm vụ “hoàn thành trận” tính khi cả trận kết thúc; một vụ cướp có thể phục vụ nhiệm vụ khác với tên rõ ràng.
- Mỗi nhiệm vụ định nghĩa điều kiện hợp lệ: đủ người theo game, có tham gia thật, đã kết thúc hợp lệ, không bị hủy. Vào/rời phòng hoặc khôi phục lại kết quả không tăng tiến độ.
- Khóa duy nhất theo hồ sơ + nhiệm vụ + kỳ ngày. Thao tác “Nhận” có thể bấm lại nhưng chỉ cấp một lần.
- Dùng lịch ngày Asia/Ho_Chi_Minh trên server, không dựa vào đồng hồ điện thoại. Tiến độ ngày cũ giữ lịch sử; giao dịch nhận thưởng phải gắn đúng kỳ.
- Bot hoặc bàn thử nghiệm không cộng thưởng trong giai đoạn đầu.
- Trang nhiệm vụ hiển thị mô tả, tiến độ, thưởng, trạng thái và thời điểm làm mới. Nút nhận thưởng không làm gián đoạn lượt đang chơi.

## 8. Kiến trúc triển khai

Giữ Node.js, Express và Socket.IO hiện có. Bước đầu tổ chức JavaScript thành module; chưa cần đổi toàn bộ giao diện sang framework mới. Chọn SQLite cho hồ sơ, ví và giao dịch local ở giai đoạn kinh tế; thư viện và phiên bản được chọn sau khi xác minh tương thích Node trên máy triển khai.

```text
src/
  platform/
    gameRegistry.js       # Danh mục, nhóm game, giới hạn người, cấu hình
    roomService.js        # Ghế, sẵn sàng, host, quyền truy cập
    playerService.js      # Hồ sơ và phiên
    walletService.js      # Ví, giữ chip, ghi sổ
    missionService.js     # Tiến độ và nhận thưởng
    persistence/          # Schema, migration, snapshot, transaction
    transport/            # HTTP, Socket.IO, xác thực payload
  games/
    the-gang/
    uno/
    tien-len/
    poker/
    sam-loc/
    phom/
    bang/
  shared/cards/           # Bài 52 lá, xáo/chia, công cụ so bài phù hợp
public/js/
  shell/                  # Điều hướng, hồ sơ, danh mục
  components/             # Phòng chờ, ghế, chat, kết nối
  games/                  # Giao diện từng game
```

Mỗi game đăng ký: `gameId`, `category`, phiên bản luật, giới hạn người, trạng thái phát hành, schema cấu hình, khả năng dùng ví. Server tự suy ra nhóm từ `gameId`, không tin nhóm client gửi lên.

Giao diện module gồm các trách nhiệm: tạo trạng thái, kiểm tra bắt đầu, áp dụng hành động, xử lý hết giờ/mất kết nối, tạo trạng thái nhìn thấy bởi từng người, xác định kết quả và đề xuất thanh toán. Module không tự ghi ví; dịch vụ chung kiểm tra và thực hiện thanh toán.

Luồng xử lý: nhận hành động → kiểm tra phiên/quyền/lượt/phiên bản trạng thái → áp dụng luật → tính thay đổi chip nếu có → lưu nguyên tử → gửi trạng thái đã lọc đến từng người. Tuần tự hóa các thay đổi trong cùng phòng và ngăn xung đột trên cùng ví.

Sự kiện mới có thể dùng `room:create`, `room:join`, `room:ready`, `game:action`, `wallet:updated`, `mission:updated`. Có lớp chuyển tiếp cho sự kiện The Gang cũ trong giai đoạn di chuyển. Hành động có `actionId`, `matchId`, `expectedRevision` để nhận biết yêu cầu trùng hoặc đã cũ.

Không gửi bộ bài chưa chia, bài đối thủ, vai ẩn BANG! hoặc token của người khác trong snapshot, log, lịch sử hay dữ liệu người xem. Tạo dữ liệu riêng cho từng người từ server; che bằng CSS không đủ.

## 9. Dữ liệu và chuyển đổi

Các nhóm dữ liệu chính:

| Nhóm | Nội dung |
|---|---|
| `players`, `player_sessions` | Hồ sơ bền vững, thiết bị/phiên hợp lệ |
| `rooms`, `room_members` | Game, phiên bản luật, cấu hình, ghế, host |
| `matches`, `match_snapshots` | Trạng thái khôi phục, revision, kết quả |
| `wallets`, `wallet_entries` | Số dư và sổ giao dịch |
| `chip_reservations` | Chip giữ cho bàn/ván và trạng thái giải phóng |
| `mission_definitions`, `mission_progress`, `mission_claims` | Luật nhiệm vụ, tiến độ, nhận thưởng |

Chuyển đổi theo thứ tự:

1. Sao lưu dữ liệu hiện có, xác định phiên bản và kiểm tra đọc được.
2. Bao The Gang bằng adapter; phòng cũ mặc định `category=casual`, `gameId=the-gang`; `mode` cũ chuyển thành độ khó riêng.
3. Giữ token ghế cũ hoạt động trong thời gian chuyển đổi. Không gộp hồ sơ chỉ vì trùng tên; tạo/liên kết hồ sơ khi người chơi xác nhận phiên hợp lệ.
4. Chuyển phòng và lịch sử sang schema mới bằng migration có version, có thể chạy lại mà không nhân đôi.
5. Trước khi bật chip, đưa trạng thái ván có ảnh hưởng đến chip và sổ giao dịch vào cùng cơ chế giao dịch. Tránh ví ở database nhưng kết quả quyết định thanh toán vẫn chỉ ghi JSON độc lập.
6. Xác minh số phòng, ghế, lịch sử và quyền truy cập sau chuyển đổi. Dữ liệu không đọc được phải giữ nguyên để xử lý.
7. Chỉ bật ví/nhiệm vụ sau khi kiểm tra khôi phục và migration đạt yêu cầu. Rollback cả code và dữ liệu tương thích; không chạy code cũ lên database đã thay đổi tùy tiện.

## 10. Mất kết nối, rời bàn và dừng server

- The Gang tiếp tục chính sách tạm dừng khi mất người hiện có.
- Với game theo lượt, đề xuất bản đầu cũng tạm dừng và giữ thời gian lượt khi mất kết nối. Sau thời gian chờ, mọi người chọn tiếp tục chờ hoặc hủy ván theo chính sách rõ ràng.
- Nếu thêm tự động hành động: phải có quy tắc từng game; Poker có thể check khi không cần theo tiền, còn lại fold. Không dùng chung một “bỏ lượt” cho mọi game.
- Không hoàn chip ngay khi mất WiFi hoặc đóng tab. Ghế, bài, stack và phần giữ vẫn thuộc phiên.
- Khi người chơi yêu cầu rời giữa ván, xử lý theo luật hiện hành hoặc đánh dấu rời sau ván; không cho bỏ trách nhiệm chip bằng nút thoát.
- Restart server: khôi phục snapshot đã commit và chip tương ứng, dừng đồng hồ cho đến khi người chơi nối lại.
- Nếu trạng thái không thể khôi phục: hủy riêng ván chưa hoàn tất, đảo các khoản chưa thanh toán theo giao dịch; giữ nguyên kết quả các ván đã chốt. Không chia lại hoặc trả lại toàn bộ buy-in ban đầu làm mất kết quả đã có.
- Trường hợp dữ liệu chưa đủ để xác định chip: giữ nguyên dữ liệu, khóa bàn liên quan và báo quản trị, không suy đoán rồi cấp chip.
- Xóa phòng hết hạn chỉ sau khi đã giải phóng hợp lệ các khoản giữ. Chủ phòng không có quyền tự chọn người thắng hoặc tự sửa số dư.

## 11. Lộ trình và tiêu chí hoàn thành

Ước lượng dưới đây là ngày công cho một người làm chính, gồm triển khai và kiểm thử trong từng bước; chưa phải lịch cam kết. Độ rộng luật BANG!, Phỏm và Poker có thể làm tăng đáng kể thời gian. Phát hành từng mốc, không đợi đủ bảy game.

| Mốc | Công việc | Phụ thuộc | Tiêu chí hoàn thành | Ngày công tham khảo |
|---|---|---|---|---:|
| M0 | Chốt sơ đồ trang, cấu hình luật dự kiến, mẫu giao diện, baseline kiểm thử | Không | Luồng tạo/vào phòng và bản đồ dữ liệu thống nhất | 2–3 |
| M1 | Trang chủ hai chế độ, danh mục, route, game registry, adapter The Gang | M0 | The Gang chơi đầy đủ qua giao diện mới, link cũ còn dùng | 5–8 |
| M2 | UNO và hoàn thiện giao diện module dùng chung | M1 | Hai game giải trí chạy ở các phòng độc lập, không lẫn trạng thái | 5–8 |
| M3 | Hồ sơ, SQLite/migration, ví, giữ chip, nhiệm vụ, lịch sử giao dịch | M1 | Gửi lặp/restart/đa tab không tạo chip sai; phục hồi được dữ liệu | 5–8 |
| M4 | Tiến lên với một biến thể và một cách thanh toán đã chốt | M3 | Chế độ Kịch tính có game chơi trọn ván, chip chính xác | 5–8 |
| M5 | Poker và các trường hợp đặt cược đặc biệt | M3, bàn dùng chung từ M4 | All-in, side pot, hòa, rời bàn và restart có kết quả đúng | 8–12 |
| M6 | Sâm lốc, Phỏm, BANG! thành các bản bổ sung riêng | M2/M3 theo game | Mỗi game có bộ luật, kiểm thử và hướng dẫn hoàn chỉnh | 15–24 |
| M7 | Kiểm tra LAN nhiều thiết bị, khả năng khôi phục, tối ưu và tài liệu vận hành | Các game đã phát hành | Chơi được trong LAN không Internet sau cài đặt, có sao lưu/khôi phục | 3–5 |

Tổng tham khảo: **48–76 ngày công**, khoảng **10–16 tuần** ở nhịp 5 ngày/tuần cho phạm vi đầy đủ trên. Đánh giá lại sau M1 và sau game có chip đầu tiên. Việc có hỗ trợ AI không loại bỏ thời gian chốt luật và chơi thử nhiều thiết bị.

**Bản đầu có đủ hai chế độ chơi thực tế:** M1 + M2 + M3 + M4: The Gang, UNO, Tiến lên; ví và nhiệm vụ. Khoảng 22–35 ngày công tính cả M0. Poker có thể đổi lên trước Tiến lên nếu đó là ưu tiên trải nghiệm, đổi lại mốc chơi có chip đầu tiên sẽ phức tạp hơn.

## 12. Kiểm thử và tiêu chuẩn phát hành

### Hồi quy The Gang

Chạy bộ test hiện có sau khi tách engine và sau khi đổi transport/persistence. Kiểm tra bốn độ khó, hiệu ứng thẻ, xác nhận chip, quyền xem bài, chuyển host, mất kết nối, QR/link, lịch sử và mobile.

### Từng game

Kiểm tra số lượng bài, không trùng bài, lượt và tổ hợp hợp lệ, hành động ngoài lượt, điều kiện thắng/hòa, các trường hợp đặc biệt trong `rules.md`, kết quả nhất quán khi tải lại. Không bắt đầu triển khai biến thể tiếp theo nếu biến thể đầu chưa đạt.

### Kinh tế

- Không âm chip; không sử dụng cùng khoản chip hai lần.
- Buy-in, phần giữ, pot, stack, hoàn chip và phần thưởng đối soát được.
- Bấm nhận thưởng nhiều lần, mạng gửi lại hoặc server khởi động lại vẫn chỉ nhận một lần.
- Thử lỗi ở các điểm trước/sau commit và trước/sau phát kết quả.
- Tổng chip chỉ thay đổi đúng bằng giao dịch cấp thưởng/quản trị; toàn bộ thanh toán ván bảo toàn tổng.

### Tích hợp và giao diện

Chạy nhiều phòng khác game cùng lúc; thử máy chủ và điện thoại thật trên LAN, màn hình nhỏ, xoay máy, tải lại trang, mở link sâu, mất WiFi, host rời và dừng server. Kiểm tra dữ liệu thực sự gửi qua mạng để bảo đảm không lộ bài/vai, không chỉ nhìn giao diện.

Mỗi bản phát hành phải có game chạy được từ vào phòng đến kết quả, hướng dẫn luật và cấu hình, đường khôi phục dữ liệu đã thử, không có game gắn nhãn chơi được nhưng engine còn thiếu.

## 13. Backlog ưu tiên

**P0 — Để đạt mô hình hai chế độ:** trang chủ, danh mục, module game, phòng chung, giữ The Gang, UNO, hồ sơ, ví/sổ giao dịch, nhiệm vụ, Tiến lên bản nền, khôi phục và kiểm thử.

**P1 — Hoàn thành danh sách mong muốn:** Poker, Sâm lốc, Phỏm, BANG!, hướng dẫn tương tác theo game, thống kê cá nhân theo game, quản trị dữ liệu local.

**P2 — Mở rộng sau:** bot, giữ nhóm khi đổi game, giải đấu nội bộ, huy hiệu/avatar mở khóa, khán giả có chính sách bài ẩn, xuất/nhập hồ sơ có kiểm soát, đóng gói khởi động một lần bấm.

Các lựa chọn cần chốt ở đầu từng mốc: tên cổng game; bộ luật/phiên bản UNO và BANG!; biến thể Tiến lên/Sâm/Phỏm; thứ tự Poker so với Tiến lên; mức chip thử nghiệm. Các giả định trong tài liệu đủ để triển khai thiết kế M0–M1 mà chưa cần quyết định tất cả biến thể ngay.
