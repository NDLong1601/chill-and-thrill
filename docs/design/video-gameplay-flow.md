# Luồng thao tác từ video tham chiếu

Tham chiếu: video `bandicam 2026-10-05 21-25-57-073.mp4`, dài khoảng 120,9 giây, do người dùng cung cấp ngày 05/10/2026. Video quay Sâm Lốc VH trên trình duyệt. Các mốc dưới đây mô tả tương tác quan sát được; phần tích hợp dùng bàn và luật hiện có của Chill & Thrill.

| Quan sát trong video | Áp dụng |
| --- | --- |
| Khoảng 12 giây: nhìn bài, chọn Báo Sâm/Không báo | Sâm giữ cửa sổ đăng ký hiện có; người chơi có thể chọn trước các lá trên tay |
| Khoảng 40–44 giây: nút đổi thứ tự bài | Nút ↔ đặt cạnh tên bài riêng, đổi giữa thứ tự giá trị và chất; giữ lựa chọn hiện tại |
| Trong lượt chơi: lá đã chọn được nhấc lên | Chạm/click/Space chọn một lá; vuốt ngang chọn hoặc bỏ chọn các lá đã đi qua; hủy cử chỉ khôi phục lựa chọn trước đó |
| Người đang thao tác có vòng sáng quanh avatar | Vòng tiến độ và số giây theo đồng hồ 30 giây của server; tạm dừng khi mất kết nối |
| Bỏ qua và còn một lá được báo gần ghế | Hiện nhãn Bỏ lượt/Còn 1 lá/Báo Sâm; mặt sau bài và số lá dùng dữ liệu công khai |
| Khoảng 59 giây: mở thông tin người chơi | Chạm avatar mở tên, kết nối, chủ bàn, số lá; Poker có stack công khai |
| Khoảng 115 giây: kết quả và nút tiếp tục | Kết quả tăng/giảm coin hoặc chip theo từng ghế; đóng/mở lại bảng, chia ván tiếp trên cùng bàn |

## Cấu trúc thực thi

- `table-shell.js`: vùng bàn, bài riêng, thanh công cụ và khung hành động chung.
- `table-flow.js`: avatar, nhãn ghế, thông tin người chơi, hiệu ứng chia/đánh, bảng kết quả và chặn gửi đúp trong khi chờ trạng thái server.
- `hand-interaction.js`: chọn bài bằng chuột, cảm ứng và bàn phím; không gửi thao tác game. Tiến lên, Sâm và Phỏm dùng chung thành phần này.
- `turn-clock.js`: hiển thị thời gian bằng đồng hồ đơn điệu, cập nhật vòng tiến độ ở ghế đang chơi.
- `tien-len-rules.js` và `sam-loc-rules.js`: cùng một module luật thuần dùng ở client và engine, để nút Đánh kiểm tra tổ hợp, đè bài và lá mở ván. Đường dẫn require cũ vẫn hoạt động.

Chọn trước không đánh tự động. Nút game chỉ xuất hiện trong lượt/giai đoạn có hành động. Tiến lên/Sâm vô hiệu hóa Đánh nếu tổ hợp chưa hợp lệ; Phỏm giữ yêu cầu đúng một lá được phép bỏ khi đánh. Server tiếp tục xác thực toàn bộ thao tác, revision, quyền ghế và thanh toán.

Mỗi lần đổi match, lựa chọn và bản nháp được xóa, kể cả bộ bài mới có lại cùng ID lá. Phỏm hạ/gửi dùng bảng nháp mở tạm từ thanh công cụ; trên điện thoại, bàn thu gọn vào giai đoạn này để chừa chỗ cho các nút và bộ chọn nơi gửi. Màn hình ngang thấp đặt ghế theo hai bên để giữ vùng bài chung ở giữa.

Hiệu ứng chỉ chạy khi nhận ván mới hoặc bài đánh mới, không chạy lại khi reconnect/reload và tôn trọng `prefers-reduced-motion`. Người chơi có thể tiếp tục thao tác trong khi hiệu ứng ngắn chạy.

## Tương thích

Trong lúc nối phần kiểm tra tổ hợp, phát hiện bảng tên tổ hợp Tiến lên bị lệch một chỉ số: đôi được gán thành sám, sám thành tứ quý, tứ quý không có tên loại. Đã sửa về luật được mô tả trong dự án. Khi khôi phục snapshot cũ, tổ hợp trên bàn được tính lại từ chính các lá công khai đã đánh; ID, token, bài trên tay và khoản giữ được giữ nguyên.

Coin/chip, mức cược, hệ số thanh toán và hai UNO giữ cơ chế hiện có. Kết quả chỉ hiển thị số tiền do engine gửi; thông tin ghế không tiết lộ bài đối thủ. Bản tích hợp không thêm biểu phí, cấp độ hoặc số liệu tài khoản từ game trong video.

## Kiểm chứng

- `npm test`: 144/144 qua, gồm nhận diện đôi/sám/tứ quý và khôi phục nhãn tổ hợp từ snapshot cũ.
- `npm run test:video-flow`: chạm/vuốt, hủy cử chỉ, Space, chọn trước, sắp bài, kiểm tra lá mở ván, avatar/đồng hồ, bấm đúp, kết quả và reset ván mới; hạ/gửi Phỏm trên màn hình nhỏ.
- `npm run test:thrill-flow`: hai ván liên tiếp và bàn đủ số ghế ở bốn game; kiểm tra không đè vùng bài chung và không cắt bài riêng.
- `test:table-updates`, `test:shared-ui` và các kiểm tra trình duyệt Poker/Tiến lên/Sâm/Phỏm qua; `shared-ui` kiểm tra cả hai UNO và nhập liệu trong chế độ iPhone standalone mô phỏng.

Ảnh: `test-results/video-flow-*-selected.png`, `video-flow-*-result.png`, `video-flow-phom-laydown.png` và `thrill-*-players.png`. Kiểm thử dùng DB/phòng trong bộ nhớ hoặc thư mục tạm. Chưa xác nhận bàn phím hệ thống và thao tác cảm ứng trên iPhone thật.

Khởi động lại server hiện có, sau đó tải lại trang để áp dụng cả module luật và giao diện mới. Snapshot source trước lượt sửa nằm ở `.migration-backups/video-flow-20261005`; dữ liệu người chơi không được dùng làm fixture.
