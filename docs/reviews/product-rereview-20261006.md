# Review lại sau triển khai — 06/10/2026

Đánh giá working tree hiện tại tại `C:\Users\PC\Documents\chill-and-thrill`, gồm cả thay đổi chưa commit. Đã đọc quy ước hợp nhất M0–M3 và đối chiếu báo cáo audit ngày 05/10, các báo cáo triển khai A/B/C/V01 với mã nguồn và lần chạy kiểm thử mới.

**Kết luận:** A01–A07 đã có mã sửa và regression đạt trong lần chạy này. Tuy nhiên, tái hiện được **6 lỗi tích hợp/giao diện mới**, trong đó 3 lỗi P1 chặn luồng sảnh nhóm hoặc giải đấu. Nên xử lý các lỗi này trước khi coi đợt nâng cấp đã nghiệm thu đầy đủ.

**Cập nhật sau review:** Đã sửa R01–R06 và chạy nghiệm thu mới: 458/458 test Node và 10 bộ browser liên quan đạt. Xem [báo cáo sửa lỗi R01–R06](implementation-R01-R06-20261006.md). Nội dung bên dưới giữ bằng chứng và kết quả tại thời điểm review trước sửa.

Không sửa mã sản phẩm hoặc dữ liệu người chơi trong lượt review. Chỉ thêm tài liệu, script tái hiện và kết quả kiểm tra. Fixture bổ sung dùng database trong bộ nhớ, server cổng ngẫu nhiên và profile/trình duyệt tạm.

## Phát hiện cần sửa

P1: chặn luồng chính của tính năng mới, ưu tiên sửa trước đợt dùng ổn định tiếp theo. P2: lỗi trải nghiệm hoặc vòng đời cần hoàn thiện tiếp. Các mã R là phát hiện của lần review này, không thay thế mã A của lần trước.

### R01 — P1: Quay về sảnh nhóm bằng kết nối mới không đổi được game

- **Tái hiện:** nhóm hai người chuyển sang UNO 108, nhận ghế; ngắt socket bàn và mở kết nối mới cùng profile như khi điều hướng về sảnh nhóm; cùng xác nhận chuyển sang Tiến lên.
- **Thực tế:** trả `OLD_ROOM_LEAVE_FAILED` / “Chưa thể rời bàn cũ an toàn.” Bàn cũ đang `WAITING`, vẫn có hai ghế; đây không phải trường hợp cố đổi game giữa ván.
- **Nguyên nhân:** [groupLobbyService.js:222](../../src/platform/groupLobbyService.js#L222) gọi `leaveRoom` bằng socket mới được xác thực profile, nhưng chưa gắn với ghế cũ. Engine yêu cầu socket đang sở hữu ghế. Kiểm thử chuyển qua nhiều game hiện dùng lại socket nên bỏ sót điều hướng trang thật.
- **Giải pháp:** trước khi rời/cash-out, thực hiện chuyển quyền ghế bằng thông tin resume đã xác thực, hoặc cung cấp thao tác vòng đời nội bộ dựa trên quyền sở hữu profile. Giữ nguyên kiểm tra ván đang diễn ra, khoản giữ và cash-out đúng một lần; không bỏ kiểm tra quyền ghế.
- **Nghiệm thu:** browser A → sảnh nhóm → B bằng socket mới; WAITING và RESULT; Poker có stack; thành viên offline; retry sau mất phản hồi. Không nhân đôi ghế hoặc thanh toán.

### R05 — P1: Nút vào bàn từ sảnh nhóm không khôi phục ghế The Gang/UNO 112

- **Tái hiện:** nhóm hai người chọn The Gang hoặc UNO `classic-local-v1`; từ `/group-lobby` bấm nút vào bàn mới trong context chưa có `gang.session`.
- **Thực tế:** chuyển tới `/?room=CODE` nhưng không vào phòng chờ. `gang.session` vẫn rỗng. Điền tên rồi bấm vào phòng báo “Phòng đã đủ 2 người.” vì hai ghế đã được server đặt trước cho nhóm.
- **Nguyên nhân:** [group-lobby.js:235](../../public/js/group-lobby.js#L235) chỉ ghi các khóa localStorage `chill-thrill:*`. Trang tích hợp đọc sessionStorage `gang.session` trong [enhancements.js:91](../../public/js/enhancements.js#L91), nên không gửi resume cho ghế vừa nhận.
- **Giải pháp:** thống nhất hợp đồng handoff/resume giữa sảnh nhóm và trang game, có phân biệt variant. Với trang tích hợp, lưu/đọc đúng session hoặc chủ động resume bằng handoff đã xác thực khi trang đích kết nối.
- **Nghiệm thu:** bấm vào bàn là đến đúng ghế cho cả The Gang, UNO 112 và UNO 108; thử context sạch, session cũ của phòng khác, reload và retry. Giữ tương thích token/link cũ.

### R02 — P1: Hủy ván đầu ở game coin khiến giải đấu bị kẹt

- **Tái hiện độc lập trên cả ba game:** tạo giải hai vòng Tiến lên, Sâm hoặc Phỏm; bắt đầu ván; host hủy trước lá đánh đầu tiên/lá bỏ đầu tiên.
- **Thực tế:** phòng trở về `WAITING` nhưng bản ghi match giải đấu còn `REGISTERED`. Chạy `reconcilePending` không giải quyết được. Bắt đầu lại bị từ chối: “Vòng giải hiện chưa sẵn sàng bắt đầu ván mới.”
- **Nguyên nhân:** [groupTournamentSupport.js:55](../../src/platform/groupTournamentSupport.js#L55) chỉ bọc `gameAction` cho `play_again`; hai action `cancel_before_first_play` và `cancel_before_first_discard` đi thẳng xuống engine. Wrapper hủy hiện áp dụng cho `leaveRoom`/`gangAction`, bỏ sót các action coin này.
- **Giải pháp:** nối các action hủy hợp lệ vào `aroundCancellation`, ghi nhận match trước khi engine reset phòng, đóng association theo trạng thái hủy không tính điểm. Chỉ đóng khi engine đã hủy thành công, đồng bộ với transaction hiện có.
- **Nghiệm thu:** cả ba game hủy → bắt đầu lại được; không cộng điểm; request lặp không tạo hiệu ứng phụ; guest hủy bị từ chối không làm kết thúc vòng giải. Kiểm tra rollback và restart.
- Chưa thấy bằng chứng mất coin trong ca này; lỗi đã chứng minh là trạng thái giải đấu bị kẹt.

### R03 — P2: Khán giả không nhận lượt tự động khi mọi người chơi offline

- **Tái hiện:** Tiến lên có một khán giả, hai người chơi cùng mất kết nối; cho hết reconnect grace và chạy một lượt timeout hợp lệ. Fixture chỉnh thời gian và gọi timer trực tiếp để không chờ hai phút.
- **Thực tế:** revision server tăng từ 3 lên 4, kênh khán giả không có event mới và vẫn giữ revision 2, dù còn một watcher.
- **Nguyên nhân:** [spectatorService.js:146](../../src/platform/spectatorService.js#L146) kích hoạt publish từ việc gửi `game_state` cho socket người chơi. Khi không còn người chơi online, engine không gửi player state nên lượt tự động không kích hoạt publish khán giả.
- **Giải pháp:** dùng thông báo thay đổi phòng sau commit, độc lập với danh sách người chơi online; từ đó dựng public projection cho watcher. Giữ kiểm tra quyền xem và không phát dữ liệu từ transaction rollback.
- **Nghiệm thu:** tất cả người chơi offline, timeout/bot tiếp tục, kết thúc ván và đóng phòng đều cập nhật watcher; không lộ bài kín, không phát trạng thái chưa commit.

### R04 — P2: Nhóm đang chơi bị coi là không hoạt động sau 30 phút

- **Tái hiện:** nhóm đã vào UNO 108, ván ở `TURN`, cả hai ghế online; dùng clock của group service tiến đến 31 phút từ hoạt động sảnh cuối cùng rồi sweep.
- **Thực tế:** nhóm bị xóa trong khi bàn và người chơi vẫn hoạt động. Người chơi mất nhóm để trở về tiếp tục đổi game.
- **Nguyên nhân:** [groupLobbyService.js:400](../../src/platform/groupLobbyService.js#L400) xét `lastActivityAt` của nhóm; heartbeat chỉ có tại trang sảnh nhóm. Hoạt động trong bàn không gia hạn nhóm. Không nhầm với chính sách hết hạn tuyệt đối sáu giờ.
- **Giải pháp:** khi đánh giá idle, xét hoạt động/ghế kết nối tại phòng được nhóm liên kết; hoặc bổ sung heartbeat nhóm từ trang game. Quy định riêng nhóm bỏ hoang, nhóm đang chơi và giới hạn tuyệt đối.
- **Nghiệm thu:** nhóm có người đang chơi tồn tại qua mốc 30 phút; nhóm thực sự bỏ hoang vẫn được dọn; quay lại sảnh giữ thành viên và quyền host; kiểm tra cả giải đấu nhiều vòng.

### R06 — P2: Thanh điều hướng desktop đè lên tab hồ sơ

- **Tái hiện bằng Chrome 1280×900:** mở portal với profile có tên/số dư, bấm chính giữa tab “Hồ sơ người chơi”.
- **Thực tế:** menu “Vào phòng” đè lên tab và nhận pointer event; Playwright không thể click sau 8 giây. Ảnh xác nhận chữ/nút chồng nhau: [rereview-currency-wallet-failure.png](../../test-results/rereview-currency-wallet-failure.png).
- **Nguyên nhân:** [shared-ui.css:180](../../public/css/shared-ui.css#L180) cho menu co xuống `min-width:0` trong khi các liên kết giữ `nowrap` và các khối hai bên không co. Layout hai hàng chỉ áp dụng tới 1180px ở dòng 317; 1280px vẫn thiếu chỗ cho một hàng.
- **Giải pháp:** cho navbar chuyển hai hàng/thu gọn theo chiều rộng nội dung, hoặc tăng breakpoint dựa trên tổng độ rộng thực tế; không chữa bằng z-index vì chỉ đổi phần tử nào chặn phần tử nào.
- **Nghiệm thu:** click thường, không `force`, vào tất cả mục tại 1024/1180/1280/1366/1440px, tên dài và số dư lớn; thêm kiểm tra bàn phím/focus. Không chỉ kiểm tra trang có tràn ngang hay không.

## Đối chiếu A01–A07

| Mã cũ | Kết quả review hiện tại |
|---|---|
| A01 | Đã có snapshot SQLite cùng transaction ledger, rollback room và gửi socket sau commit. Regression lỗi snapshot/commit/recovery trong bộ test mới đạt. |
| A02 | Đã sửa điều kiện reconnect Poker theo ghế tham gia hand; regression đạt. |
| A03 | Đã có reconnect grace và xử lý hết hạn; regression và browser lifecycle đạt. Lỗi mới R03 nằm ở việc phát state cho khán giả. |
| A04 | Đã có diagnostics chung; unit/integration và browser cảnh báo đạt. |
| A05 | Hiển thị tiền lấy từ state game; browser kiểm tra stake đạt. |
| A06 | Regression avatar sau tải lại và tạo phòng đạt. |
| A07 | Validator tiền tệ/cận cược/khả năng thanh toán đã được hợp nhất; regression đạt. |

Kết quả trên xác nhận các ca đã chạy; không khẳng định mọi tổ hợp mạng, thiết bị và luật chơi đều hết lỗi.

## Kiểm thử mới thực sự đã chạy

- `npm test`: **448/448 đạt**, không fail/skip/cancel. Log: `test-results/rereview-20261006-unit.log`.
- **17 browser/product script gốc được chọn: 16 đạt, 1 không đạt.** Không dùng lại con số 36 suite trong báo cáo triển khai như kết quả của lần review này.
- 16 script đạt: `audit-a06-browser-check`, `a05-stakes-browser-check`, `group-lobby-browser-check`, `group-tournament-product-browser-check`, `spectator-product-browser-check`, `practice-browser-check`, `preflight-browser-check`, `portal-home-mobile-browser-check`, `portal-browser-check`, `audit-a04-browser-check`, `audit-v01-multitab-browser-check`, `profile-history-browser-check`, `tutorial-browser-check`, `admin-product-browser-check`, `table-preferences-product-check`, `a03-lifecycle-browser-check`.
- Script gốc `currency-wallet-browser-check` không đạt và retry vẫn không đạt: vào tab hồ sơ nhưng chưa mở subtab Ví mới. Bản sao chỉ thêm click subtab vượt qua mobile, sau đó phát hiện R06 tại desktop. Đây là hai nguyên nhân riêng.
- Bản sao `scratch/rereview-currency-wallet-alternate.cjs` dùng nút hồ sơ ở góc phải rồi mở subtab Ví: **đạt** cả portal và `/profile`, mobile/desktop, gồm retry khi phản hồi quy đổi bị mất. Không có bằng chứng lỗi tính toán quy đổi từ ca kiểm tra này. Cần cập nhật script gốc theo UI mới và giữ regression riêng cho tab bị che.
- `node scratch/rereview-20261006.cjs`: hoàn tất, xác nhận R01–R05. Các assertion của script cố ý kiểm chứng lỗi hiện tại; exit 0 có nghĩa là tái hiện được lỗi, không phải sản phẩm đã được sửa.
- `node scratch/rereview-currency-wallet.cjs`: không đạt tại click tab desktop, có log và ảnh chứng minh R06. Bản này đã thêm bước mở subtab Ví vào bản sao của test gốc.
- Đã xem ảnh mobile giải đấu, mobile khán giả và desktop portal bị chồng điều hướng. Các log lần review nằm ở `test-results/rereview-*.log`.

Chưa chạy lại toàn bộ launcher/browser suite, chưa thử điện thoại thật, WiFi chập chờn thật, tải lớn hoặc mọi diễn biến của từng ván. Tái hiện bằng socket/API và clock fixture được ghi rõ ở mỗi mục; không gọi đó là thử nghiệm thực tế kéo dài 31 phút.

## Thứ tự khắc phục đề xuất

1. **Sảnh nhóm:** sửa R05 và R01 cùng hợp đồng resume/handoff. Bổ sung ca browser trọn vòng từ nhóm → game A → nhóm → game B, cho cả hai UNO và The Gang.
2. **Giải đấu:** sửa R02, bao phủ start/action/cancel/result/restart bằng cùng cơ chế vòng đời. Kiểm tra score và ledger độc lập, idempotent.
3. **Phiên dài và nền:** sửa R04/R03; kiểm tra nhóm tồn tại lâu, người chơi mất mạng và watcher vẫn nhận trạng thái đã commit.
4. **Điều hướng và nghiệm thu:** sửa R06, cập nhật kiểm thử tab Ví; chạy lại 448 test, các browser suite liên quan và các ca mới với kỳ vọng đúng sau sửa.

Chưa cần thêm game hoặc tính năng lớn trong đợt kế tiếp. Khoảng trống hiện tại là sự kết nối giữa các tính năng đã triển khai, đặc biệt điều hướng tạo socket mới, handoff giữa hai loại trang game và các action hủy ngoài luồng kết quả thông thường.
