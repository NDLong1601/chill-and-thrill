# Kiểm tra sản phẩm và kế hoạch nâng cấp Chill & Thrill

Ngày kiểm tra: 05/10/2026. Đánh giá trên working tree hiện tại tại `C:\Users\PC\Documents\chill-and-thrill`, bao gồm các thay đổi chưa commit.

**Kết luận**

Các luồng chơi thông thường có nền tảng tốt: 142/142 kiểm thử Node đạt và 6 bộ kiểm tra trình duyệt đạt. Tuy nhiên, đã tái hiện 7 vấn đề ngoài phạm vi kiểm thử hiện có. Ưu tiên sửa tính nhất quán giữa tiền và trạng thái ván, cùng khả năng thoát khỏi bàn bị mất kết nối, trước khi mở rộng tính năng.

Chưa sửa mã sản phẩm trong lượt kiểm tra này. Chỉ thêm báo cáo, script tái hiện và kết quả kiểm tra. Dữ liệu fixture nằm trong bộ nhớ hoặc thư mục tạm của hệ điều hành; không sử dụng database/phòng của người chơi thật.

**Bằng chứng kiểm tra**

| Kiểm tra đã chạy | Kết quả | Phạm vi |
|---|---|---|
| `npm test` | 142/142 đạt | Engine, tích hợp socket/API, ví, migration, recovery và các regression hiện có |
| `test:portal-browser` | Đạt | Portal, chuyển sang bàn, hồ sơ chung, tiếp tục/rời phòng |
| `test:shared-ui` | Đạt | Mật khẩu và nhập lại, QR, các phòng chờ, xoay màn hình, deep link |
| `test:thrill-flow` | Đạt | Hai ván liên tiếp, hiển thị bàn đông người, quy đổi coin/gem, ảnh lá bài |
| `test:table-updates` | Đạt | Tên, số tiền, chuyển ghế giữa trang, đồng hồ lượt, chia ván tiếp |
| `test:review-browser` | Đạt | Hồ sơ, nhiệm vụ, QR có mật khẩu, Phỏm và các regression UI |
| `test:profile-browser` | Đạt | Tạo và khôi phục hồ sơ |
| `node scratch/audit-20261005.cjs` | Hoàn thành, xác nhận 7 vấn đề | Tái hiện bổ sung bằng dữ liệu tạm |

Các browser suite trên không báo lỗi JavaScript trang. Đã xem ảnh trang chủ điện thoại và bàn Phỏm ngang. Chưa thử thiết bị iPhone/Android thật, WiFi chập chờn thật, tải lớn hoặc chơi thủ công hết mọi tổ hợp luật. Một số fixture kết thúc ván bằng lời gọi engine để kiểm tra thanh toán/chơi tiếp; kết quả đó không thay thế kiểm thử toàn bộ diễn biến một ván.

Log tại `test-results/audit-*.log`; log tổng kiểm thử tại `test-results/audit-unit-tests.log`.

**Các luồng chưa hoạt động đúng — đã tái hiện**

P1: cần xử lý trước khi dùng ổn định cho nhóm chơi có lưu tiền. P2: sửa trong đợt hoàn thiện gần nhất.

| Mã | Mức | Vấn đề và tác động | Hướng xử lý |
|---|---|---|---|
| A01 | P1 | Lưu JSON thất bại nhưng vẫn giữ coin và báo bắt đầu thành công. Sau restart, ví còn giữ tiền nhưng phòng quay lại chờ. | Snapshot ván và ledger trong cùng transaction SQLite; trả thành công sau commit. |
| A02 | P1 | Poker không tiếp tục sau reconnect nếu còn một ghế không tham gia hand đang offline. | Điều kiện bỏ pause phải căn cứ vào người đang tham gia hand. |
| A03 | P1 | Một người bỏ kết nối làm người còn lại bị giữ trong bàn; không rời được và coin tiếp tục bị giữ. | Chính sách reconnect có hạn và kết thúc/tiếp tục ván theo luật đã công bố. |
| A04 | P2 | API tình trạng lưu trữ trả bình thường dù Phỏm có lỗi lưu trữ. | Tổng hợp tình trạng tất cả manager và phân biệt lỗi đọc/ghi. |
| A05 | P2 | Tạo Tiến lên cược 500 coin nhưng phòng chờ vẫn thông báo giữ 100 coin. | Mọi thông báo đọc stake/maxLoss/currency do server cung cấp. |
| A06 | P2 | Avatar đã lưu bị ghi đè về mặc định khi tạo phòng từ portal sau tải lại trang. | Khởi tạo avatar picker/state từ hồ sơ, tránh PATCH dữ liệu mặc định chưa được chọn. |
| A07 | P2 | Validator phòng chấp nhận cược coin cao hơn giới hạn của hàm giữ tiền. Người đủ tiền vẫn không bắt đầu được. | Dùng giới hạn theo từng tiền tệ, thống nhất cận cược và khoản giữ tối đa. |

**A01 — Coin và phòng mất đồng bộ khi ghi tệp thất bại**

- Tái hiện: tạo phòng Tiến lên và lưu trạng thái WAITING; giả lập lỗi ghi riêng tệp phòng; bấm bắt đầu; khởi động lại manager với cùng database/tệp tạm.
- Kết quả: trả `{ok:true}`; ví từ 1.000 khả dụng thành 900 khả dụng + 100 đang giữ; phòng phục hồi ở WAITING với `reservations: []`. Không còn thông tin khoản giữ trong phòng được phục hồi để xử lý ván đó theo luồng bình thường.
- Nguồn: [startRound và flush](../../src/games/tien-len/tienLenEngine.js#L105), [loadFixedRooms](../../src/platform/completedRoom.js#L24). `reserveMany` commit SQLite trước khi ghi JSON; `flush` chỉ log lỗi.
- Sâm lốc và Phỏm cũng có cấu trúc giữ tiền rồi ghi JSON tương tự. Đây là phạm vi cần kiểm thử tiếp, chưa coi là đã tái hiện độc lập trên cả hai game.
- Giải pháp: mở rộng cách Poker đang commit snapshot + ledger sang ba game coin, trong cùng `ProfileStore`. Bao gồm bắt đầu, hành động quyết định kết quả, thanh toán và đóng phòng. Nếu commit lỗi, khôi phục trạng thái bộ nhớ và không phát thông báo thành công. Giữ JSON làm bản xuất tương thích.
- Khôi phục dữ liệu cũ: đối chiếu khoản HELD với snapshot/room/match, lập danh sách bất nhất. Chỉ tự hoàn khi chứng minh không có ván hợp lệ hoặc thanh toán đã chốt; giữ lịch sử và idempotency key. Không reset ví hay xóa dữ liệu để che lỗi.
- Nghiệm thu: giả lập lỗi ghi, lỗi commit và dừng tiến trình tại các ranh giới; sau restart phải khôi phục đúng ván hoặc hoàn đúng một lần. Tổng khả dụng + khoản giữ + giá trị đã phân phối phải đối soát được.

**A02 — Poker chờ nhầm ghế không tham gia hand**

- Tái hiện: phòng 3 ghế; chỉ A/B buy-in và ready; C không tham gia hand. C offline, A offline rồi A reconnect.
- Kết quả: A/B đều online và đang trong hand nhưng `paused=true`, `turnClock.deadlineAt=null`.
- Nguồn: [Poker bind](../../src/games/poker/pokerEngine.js#L111) đòi mọi ghế online để bỏ pause, trong khi điều kiện ngắt hand dựa vào `inHand`.
- Giải pháp: dùng chung hàm tính người cần chờ trong `bind`, `access`, disconnect và timer; hiển thị rõ đang chờ ai. Việc xử lý người đã fold cần được chốt riêng theo chính sách kết nối.
- Nghiệm thu: hand tiếp tục khi mọi người cần tham gia đã reconnect; ghế ngồi ngoài không chặn hand; ghế thực sự đang chơi vẫn được bảo vệ trong thời gian reconnect.

**A03 — Không có đường thoát khi đối thủ bỏ kết nối**

- Tái hiện: Tiến lên đang chơi, B offline, A còn online; giả lập đã 13 giờ và chạy cleanup; A yêu cầu rời bàn.
- Kết quả: phòng vẫn tồn tại, ví A giữ 100 coin, yêu cầu rời bị từ chối vì ván tạm dừng. Cleanup ván đang chơi chỉ hoàn khi không còn ai online; đồng hồ lượt cũng dừng khi pause.
- Nguồn: [access](../../src/games/tien-len/tienLenEngine.js#L54), [leaveRoom và cleanup](../../src/games/tien-len/tienLenEngine.js#L188), [turnClock](../../src/platform/turnClock.js#L16).
- Đây là thiếu sót về vòng đời phiên chơi, dù việc tạm dừng ban đầu là có chủ đích để giữ bài.
- Giải pháp đề xuất: cho reconnect 60–120 giây, thời hạn do server quản lý và được lưu. Hết hạn xử lý theo game: Poker check/fold khi đến lượt; game coin cần chốt luật bỏ cuộc/tự đi hợp lệ và thanh toán trong mức đã giữ. The Gang có thể tiếp tục dùng quyền host đưa về sảnh theo luật hiện có. Không cho người sắp thua lợi dụng ngắt mạng để hủy và hoàn cược vô điều kiện.
- Luồng UI: hiện tên người offline, thời gian chờ, điều gì xảy ra khi hết hạn và trạng thái “rời sau ván”.
- Nghiệm thu: ngắt kết nối ở từng phase, cả host và guest; bàn luôn đến trạng thái tiếp tục hoặc kết thúc hữu hạn; khoản giữ được đóng đúng một lần.

**A04 — Báo tình trạng lưu trữ chưa đầy đủ**

- Tái hiện: đặt cờ lỗi lưu trữ Phỏm trên fixture, gọi `/api/storage/status`; kết quả vẫn `error:null`, `integrity:ok`.
- Nguồn: [API lưu trữ](../../src/httpServer.js#L85) chỉ xét `gm.gang.storageError`. Kiểm tra integrity SQLite không chứng minh mọi tệp game ghi được. Lỗi ghi runtime ở một số `flush` cũng chưa đặt cờ.
- Giải pháp: theo dõi trạng thái đọc/ghi từng game, thời điểm commit thành công cuối, số khoản giữ bất nhất; chặn ván cược mới khi không đảm bảo lưu an toàn. API phục vụ UI chỉ trả thông tin cần thiết; diagnostics chi tiết dành cho chủ máy.
- Nghiệm thu: gây lỗi từng storage riêng đều hiện cảnh báo đúng; khi khôi phục ghi thành công mới xóa trạng thái lỗi. Không báo hỏng SQLite chỉ vì JSON export lỗi nếu snapshot đã an toàn.

**A05 — Phòng chờ hiển thị hai số tiền khác nhau**

- Tái hiện bằng trình duyệt: chọn Tiến lên cược 500. Nút bắt đầu ghi “giữ 500 coin/người”; lời nhắc lại ghi “giữ 100 coin”.
- Nguồn: [renderRoom](../../public/js/tien-len.js#L36) còn hard-code 100; thành phần [room-create](../../public/js/room-create.js#L43) đã dùng giá trị server.
- Giải pháp: một hàm dựng thông tin cược chung, phân biệt tiền cược và khoản giữ tối đa; kiểm tra cả ván cũ dùng chip được khôi phục sau migration.
- Nghiệm thu: cược 50/500/10k hiển thị nhất quán ở chi tiết game, phòng chờ, bàn và kết quả; thiếu tiền nêu số thiếu cụ thể.

**A06 — Portal ghi đè avatar đã lưu**

- Tái hiện bằng trình duyệt: hồ sơ có avatar 🥷; tải lại portal và tạo phòng mà không chọn avatar mới; hồ sơ đổi thành 🕶️.
- Nguồn: [state ban đầu và renderAccount](../../public/js/portal.js#L7), [ensureLocalProfile](../../public/js/portal.js#L104). State avatar khởi tạo mặc định, render hồ sơ chưa đồng bộ lại state/picker; PATCH sau đó ghi mặc định lên server.
- Giải pháp: nạp identity từ hồ sơ vào state và cả hai picker; chỉ gửi trường người chơi đã chủ động sửa. Xử lý kết quả fetch cũ để không ghi đè lựa chọn mới.
- Nghiệm thu: đổi avatar, reload, tạo/vào phòng và trở về portal vẫn giữ đúng avatar. Chỉnh tên cũng không làm thay avatar. Việc sửa tên ở tab hồ sơ đã kiểm tra và đang lưu được.

**A07 — Giới hạn cược không thống nhất**

- Tái hiện: `validateRoomConfig('tien-len', {stake:2000000000})` được chấp nhận; ví fixture có 3.000.001.000 coin; `reserveMany` vẫn báo `RESERVATION_INVALID`.
- Nguồn: [validateStake](../../src/platform/gameRegistry.js#L59) tính theo giới hạn coin 10^12; [validAmount](../../src/platform/profileStore.js#L26) dùng giới hạn chip 10^9 cho cả reserve coin.
- Giải pháp: `validateAmount(value, currency)` chung cho server; cận stake phụ thuộc mức giữ/thua tối đa của game và cả giới hạn ví khi thắng. UI lấy giới hạn từ registry; không tự đoán.
- Nghiệm thu: test cận dưới/cận trên/cận + 1 cho từng game và currency; không tạo cấu hình mà người đủ tiền vẫn không thể bắt đầu.

**Những phần nên nâng cấp**

| Hạng mục | Giá trị cho người dùng | Giải pháp cụ thể | Ưu tiên |
|---|---|---|---|
| Vòng đời kết nối | Không mắc kẹt vì một người rời mạng | Thời hạn reconnect, xử lý hết hạn theo game, thông báo người đang chờ | Làm cùng A02/A03 |
| Trước khi bắt đầu | Hiểu chính xác tiền cược và điều kiện vào ván | Hiện số dư khả dụng, mức giữ, số còn thiếu và người chưa ready; host thấy lý do chưa bắt đầu được | Cao |
| Ví và lịch sử | Phân biệt tiền chuyển sang giữ với lời/lỗ thực tế | Hiện availableDelta/reservedDelta/tổng thay đổi, nhóm theo match và tiền tệ, biên nhận kết quả | Cao |
| Quy đổi và tiến trình | Coin/gem có mục đích dễ hiểu | Hiện xem trước số trừ/nhận, mức tối đa có thể đổi, mục đích dùng gem; kiểm tra cân bằng nguồn thưởng | Vừa |
| Trang chủ điện thoại | Vào game quen thuộc nhanh hơn | Danh mục rút gọn, game gần đây/yêu thích, nút vào/tạo nhanh; giữ đường xem luật chi tiết | Vừa |
| Hướng dẫn từng game | Người mới biết hành động tiếp theo | Hướng dẫn theo tình huống, giải thích hành động không hợp lệ, ví dụ luật các biến thể | Cao |
| Bàn chơi | Đọc lượt và thao tác rõ trên màn hình nhỏ | Nhấn mạnh người đến lượt; tùy chọn cỡ bài/chữ, âm thanh và giảm chuyển động; kiểm tra điện thoại thật | Vừa |
| Kiểm thử | Bắt lỗi ngoài các luồng thông thường | Regression cho 7 phát hiện, fault injection, nhiều tab, restart giữa action và kiểm thử bảo toàn tiền | Cao |
| Cấu trúc mã | Hạn chế khác biệt giữa các bàn | Adapter hợp đồng thống nhất cho create/join/resume/action/result; API client chung thay dần việc bọc `socket.emit`/hàm manager | Sau khi có regression |

Hiện mỗi hồ sơ mới có 1.000 coin, tổng ba nhiệm vụ ngày đang mở thưởng 450 coin, trong khi 1 gem = 10.000.000 coin. Đây không phải lỗi tính toán đã chứng minh, nhưng cho thấy cần thiết kế rõ vai trò gem và nhịp tích lũy trước khi mở thêm cửa hàng/nhiệm vụ. Nếu đổi tỷ lệ, phải có phiên bản và chính sách chuyển đổi bảo toàn giá trị người chơi cũ; không tự đổi trong lần sửa lỗi kỹ thuật.

Nhiệm vụ hướng dẫn `tutorial_verified` đang chủ động khóa vì chưa có luồng server xác minh. Nên bổ sung hướng dẫn được server ghi nhận theo phiên bản trước khi mở thưởng; không chỉ tin tín hiệu “đã hoàn thành” từ trình duyệt.

**Tính năng nên thêm**

| Tính năng | Phạm vi đề xuất | Điều kiện nghiệm thu |
|---|---|---|
| Giữ nhóm khi đổi game | Một nhóm/lobby chung, host đề xuất game mới, mọi người xác nhận | Đổi game không phải gửi lại mã cho từng người; hand có cược phải thanh toán/cash-out trước |
| Chơi thử với bot | Bắt đầu UNO và Tiến lên; bot dùng cùng validator server, chỉ được thấy thông tin hợp lệ của ghế mình | Chơi thử được khi thiếu bạn; mặc định ví luyện tập không tác động ledger thật |
| Lịch sử chung | Theo game/ngày/nhóm, kết quả và biến động ví, chi tiết quyết định thanh toán | Tìm được nguồn từng khoản lời/lỗ; không lộ bài riêng của ván đang chạy |
| Sao lưu/khôi phục có kiểm tra | Công cụ chủ máy tạo backup nhất quán, phiên bản schema, kiểm tra phục hồi trên dữ liệu tạm | Khôi phục đúng hồ sơ, khoản giữ và phòng; không nhân đôi số dư |
| Bảng quản trị LAN | Địa chỉ/QR, phòng và kết nối đang hoạt động, tình trạng lưu, dừng tạo bàn mới để bảo trì | Chỉ chủ máy được thao tác quản trị; mọi can thiệp tiền có biên nhận |
| Bộ chạy một lần bấm | Khởi động/dừng an toàn, hiển thị IP/QR, thư mục dữ liệu dễ sao lưu | Người không dùng terminal vẫn mở bàn và tắt server đúng cách |
| Khán giả | Kênh xem riêng, chỉ state công khai, chính sách vào bàn giữa ván | Không nhận bài kín qua socket/API, kể cả khi đổi vai trò |
| Giải đấu/bảng xếp hạng nhóm | Triển khai sau khi thời hạn ván và luật bỏ cuộc ổn định | Luật tính điểm rõ, chống ghi kết quả lặp, tách xếp hạng khỏi thao tác cấp coin |

Đề xuất thứ tự thêm mới: hướng dẫn/chơi thử → lịch sử chung → giữ nhóm đổi game → quản trị/sao lưu → khán giả/giải đấu. Không cần thêm game mới ngay khi bảy game hiện tại vẫn còn các điểm kẹt phiên.

**Kế hoạch triển khai và cổng nghiệm thu**

| Đợt | Việc làm | Điều kiện hoàn thành |
|---|---|---|
| 1 — Ổn định dữ liệu và phiên | A01–A04; đưa fixture thành regression chính thức; chốt luật mất kết nối | Không có khoản giữ mất liên kết sau lỗi/restart; Poker reconnect đúng; ván bỏ kết nối có kết quả hữu hạn; trạng thái lưu báo đúng |
| 2 — Hoàn thiện luồng chơi | A05–A07; điều kiện đủ tiền/ready; thống nhất hiển thị ví và lỗi | Cấu hình hợp lệ phải bắt đầu được khi đủ điều kiện; giao diện dùng cùng giá trị server; identity không bị đổi ngoài ý muốn |
| 3 — Dễ bắt đầu và chơi theo nhóm | Hướng dẫn từng game, bot luyện tập đầu tiên, lịch sử chung, giữ nhóm đổi game | Người mới chơi thử được; nhóm chuyển game không mất ghế/hồ sơ; kết quả đối soát được |
| 4 — Vận hành và mở rộng | Sao lưu/khôi phục, công cụ chủ máy, đóng gói; sau đó khán giả/giải đấu | Diễn tập phục hồi đạt; kiểm tra thiết bị/WiFi thật; kiểm tra tải theo số phòng mục tiêu đã chọn |

Không tách database ví mới. Các đợt phải giữ chung ProfileStore/ledger, token/link cũ và hai engine UNO rõ ràng. Giữ các thay đổi hiện có; chỉ sửa theo phạm vi từng đợt và không reset dữ liệu người chơi.

**Cách dùng lại bằng chứng**

Chạy từ thư mục dự án: `node scratch/audit-20261005.cjs`. Script hiện tại xác nhận sự tồn tại của lỗi, vì vậy sau khi sửa sản phẩm phải đổi kỳ vọng thành hành vi đúng trước khi dùng nó làm regression. Các thư mục dữ liệu tạm được in trong log để đối chiếu; không chứa dữ liệu người chơi thật.
