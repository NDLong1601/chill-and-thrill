# Cấu trúc giao diện Chill & Thrill

Đề xuất ngày 05/10/2026: dùng một luồng ngắn **Sảnh → Chọn game → Phòng chờ → Bàn chơi → Kết quả → Ván tiếp**. Hồ sơ và ví là một tab riêng, không chen vào luồng chuẩn bị ván.

## Các màn hình

| Màn hình | Cấu trúc | Thao tác chính |
| --- | --- | --- |
| Sảnh | Thanh điều hướng gọn; khu nhập tên và mã phòng; hai nhóm Giải trí/Kịch tính | Vào phòng hoặc chọn game |
| Chọn game | Tên và số người; luật nhanh và hướng dẫn ở bên trái; cấu hình tạo phòng ở bên phải | Tạo phòng |
| Phòng chờ | Header tên game; khối mã/QR/link bên trái; danh sách ghế và thiết lập bên phải; nút sẵn sàng/bắt đầu bên dưới | Mời bạn và chuẩn bị ván |
| Bàn chơi | Header mã phòng/trạng thái; ghế quanh bàn; bài chung ở giữa; bài riêng và thao tác ở dưới | Chơi ván |
| Kết quả | Bảng kết quả ngay trên bàn, nút mở ván tiếp và rời phòng | Chơi tiếp cùng phòng |
| Hồ sơ | Tên/avatar; ví theo từng loại; nhiệm vụ; lịch sử; khôi phục | Quản lý hồ sơ |

Phòng chờ thu về một cột trên điện thoại và vẫn nhập liệu theo chiều dọc. Khi bắt đầu ván, các game yêu cầu xoay ngang; lời nhắc xoay không làm thay đổi ghế, bài hoặc trạng thái ván.

## Ngôn ngữ hình ảnh

- Nền xanh than, panel xanh đậm, viền nhẹ, một màu vàng cho thao tác chính; font Be Vietnam Pro.
- Cùng khoảng cách, bo góc, vị trí mã phòng và nút hành động ở mọi phòng chờ.
- Tiến lên, Sâm, Phỏm và Poker dùng cùng bàn nỉ, cách đặt ghế, vùng bài riêng, thanh công cụ và bảng kết quả. Thao tác đặc thù của từng game nằm trong vùng hành động.
- The Gang giữ chip xếp hạng theo vòng. Hai biến thể UNO giữ lá chức năng và luật riêng; BANG! giữ vai, khoảng cách và trang bị.
- Luật/hướng dẫn nằm tại màn hình game tương ứng. Sảnh không hiển thị phiên bản luật, schema database, milestone hay phần giới thiệu mã nguồn.

## Thành phần chung

`mobile-ui.js` xử lý nhập liệu/chiều màn hình; `room-access.js` xử lý popup mật khẩu; `room-shell.js` bố trí phòng chờ; `table-shell.js` bố trí bàn kịch tính; `shared-ui.css` chứa phong cách dùng chung. Các client game giữ luật và các nút riêng. Không thay thế toàn bộ engine hoặc gộp hai UNO.

Mật khẩu mới trên giao diện có 6 chữ số. Popup dùng một ô nhập thật cùng sáu ô hiển thị để bàn phím, dán và xóa hoạt động tự nhiên. Phòng cũ có mật khẩu chữ vẫn có lựa chọn nhập tương thích.

QR cần dùng địa chỉ mở được trên máy khách. Khi chủ bàn mở bằng localhost, gợi ý địa chỉ LAN; khi mở bằng địa chỉ LAN/tên miền, dùng địa chỉ hiện tại. Hiển thị mã và link cạnh QR, báo lỗi tải và cho phép thử lại. Không đặt mật khẩu hoặc token ghế trong QR/link.

## Giới hạn kiểm chứng

Kiểm tra tự động bằng trình duyệt mô phỏng không xác nhận việc bàn phím hệ thống iPhone bật trong chế độ Thêm vào Màn hình chính. Cần kiểm tra thêm trên thiết bị thật: nhập tên/mã/số, dán PIN, nhập sai và thử lại, đóng bàn phím, xoay màn hình và khôi phục ghế sau khi mở lại ứng dụng.

## Kết quả triển khai và kiểm tra

- `npm test`: 126/126 bài kiểm tra qua; các bài kiểm tra dùng dữ liệu tạm hoặc bộ nhớ.
- `test:shared-ui`: qua cho 7 game và cả hai UNO; popup PIN sai/đúng, mật khẩu chữ cũ, nhập mã và số, profile tab, QR LAN/tên miền HTTPS, link trực tiếp, link khác game, reload và xoay màn hình.
- `test:thrill-flow`: qua hai ván liên tiếp ở Poker/Tiến lên/Sâm/Phỏm; bàn đủ 6/4/5/4 người, ghế không đè bài chung, bài riêng nằm trong màn hình, số dư và quy đổi đúng.
- `test:browser`, `test:portal-browser`, `test:review-browser` và các kiểm tra riêng của UNO/Poker/Tiến lên/Sâm/Phỏm/BANG!/hồ sơ đều qua trong lượt sửa này.
- Ảnh kiểm tra nằm trong `test-results/ui-*.png`; gồm sảnh, popup PIN, trang chi tiết và các phòng chờ trên điện thoại/máy tính.

Mã nguồn trước lượt sửa được giữ trong `.migration-backups/ui-20261005-200850`. Không thay thế database hoặc xóa hồ sơ/phòng đang lưu. Khởi động lại tiến trình server hiện có và tải lại trình duyệt để áp dụng phần xử lý địa chỉ QR mới.


## Bổ sung cho lượt sửa bàn và phiên ngày 05/10/2026

- Sảnh và trang game cũ dùng cùng cấu hình phòng; mức cược coin tùy chọn, số nguyên và cách viết `k`, `m`, `tr` được kiểm tra bằng chung một parser ở client/server. Bàn cũ giữ nguyên mức cược khi khôi phục.
- Tên được chuẩn hóa khi đọc dữ liệu cũ; storage tên dùng duy nhất một lớp JSON. Không thay ID, token hoặc dữ liệu ví.
- Chuyển từ portal sang bàn truyền quyền ghế bằng token hiện có. Nút Tiếp tục chủ động chuyển ghế; kết nối cũ mất quyền điều khiển. Reconnect thông thường vẫn bảo vệ ghế đang mở ở tab khác.
- Bài riêng chiếm toàn bộ chiều ngang. Bỏ panel cạnh bài; chỉ hiện thanh hành động trên mép vùng bài khi có thao tác. Nhật ký/thông tin vẫn mở bằng nút chung.
- Tiến lên/Sâm/Phỏm chia ván tiếp trực tiếp từ kết quả; giữ coin mới trong transaction trước khi thay ván. Thiếu coin giữ nguyên kết quả, không giữ một phần của bàn.
- Đồng hồ lượt 30 giây chạy ở server cho Poker/Tiến lên/Sâm/Phỏm/BANG!/cả hai UNO, có hành động hết giờ hợp lệ và tạm dừng khi mất kết nối. Cửa sổ phản ứng riêng của UNO và Báo Sâm giữ luật hiện có. The Gang là game đồng đội không có lượt người riêng.
- Coin, gem và chip Poker dùng các balance riêng trong cùng ProfileStore. Giữ tỷ giá 10.000.000 coin = 1 gem, thưởng nhiệm vụ coin, không đổi chip Poker sang coin.

Bản sao mã nguồn trước lượt này: `.migration-backups/rounds-20261005-211123`. Kiểm thử dùng bộ nhớ và dữ liệu tạm, không chạy trên hồ sơ thật. Khởi động lại server để áp dụng engine mới; bàn đang lưu được khôi phục bằng mã/token hiện có.


Kiểm chứng sau lượt bổ sung: **142/142** bài kiểm thử Node qua. Các kiểm tra trình duyệt `test:table-updates`, `test:thrill-flow`, `test:shared-ui`, `test:portal-browser`, `test:browser`, `test:uno-browser`, `test:bang-browser`, `test:poker-browser`, `test:phom-browser` qua. Luồng nhập sai rồi sửa mức cược trên điện thoại được kiểm tra để tránh lỗi nút Tạo phòng dịch chuyển khi blur ô nhập. Ảnh mới: `test-results/table-updates-tien-len-landscape.png` và `test-results/thrill-*-players.png`.

## Bổ sung từ video thao tác

Đã nối chọn bài bằng chạm/vuốt/bàn phím, chọn trước lúc chờ lượt, đồng hồ ở avatar, nhãn bỏ lượt/còn một lá, thông tin ghế và bảng kết quả chung. Các client dùng chung thành phần tương tác và trình bày, giữ adapter hành động riêng. Chi tiết áp dụng, tương thích và kiểm chứng mới: [Luồng thao tác từ video](video-gameplay-flow.md).
