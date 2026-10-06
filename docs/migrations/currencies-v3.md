# Tiền tệ kịch tính và bàn chơi

Poker sử dụng chip riêng. Tiến lên, Sâm lốc và Phỏm sử dụng coin. Gem được đổi
hai chiều với coin theo tỷ lệ 10.000.000 coin = 1 gem; không có đổi chip.
The Gang, UNO và BANG! không dùng tiền cược. Chip xếp hạng của The Gang giữ
nguyên giao diện và chức năng cũ.

Schema v3 thêm số dư coin/gem vào bảng `wallets` và đơn vị vào `wallet_ledger`
và `reservations` trong database `ProfileStore` hiện có. Không tạo database
khác. Hồ sơ, token, số dư chip, lịch sử và các khoản giữ cũ được giữ nguyên.
Mỗi hồ sơ nhận 1.000 coin khởi đầu một lần; số dư gem ban đầu là 0. Chip Poker
vẫn giữ số dư hiện có. Nhiệm vụ nhận thưởng mới bằng coin; các thưởng đã nhận
trước nâng cấp không được cộng lại hoặc đổi đơn vị.

Khoản giữ của ván đang chơi trước nâng cấp vẫn thanh toán bằng đơn vị đã ghi
trong ledger, kể cả khi khôi phục sau restart. Ván tiếp theo của Tiến lên/Sâm/
Phỏm mới giữ coin. Client đọc đơn vị từ server để hiển thị đúng ván cũ.

Quy đổi được xác thực bằng token hồ sơ, dùng số gem nguyên và tỷ lệ trên server.
Cả hai thay đổi số dư và lịch sử nằm trong một transaction. Yêu cầu lặp cùng
operation key không quy đổi lần hai; coin đang giữ trong ván không thể đem đổi.

Các game kịch tính dùng bàn chung ở giữa, ghế quanh bàn, bài riêng và thao tác
cạnh nhau. Nhật ký, thông tin người chơi và phỏm công khai mở từ thanh công cụ.
Kết quả hiện trên bàn. Chủ bàn mở phòng chờ cho ván tiếp (Poker mở hand tiếp);
các ghế được giữ, số dư được kiểm tra lại trước khi chia.

Điện thoại dọc được nhắc xoay ngang khi vào ván, cho cả hai phiên bản UNO và
các game độc lập. Nút toàn màn hình thử khóa hướng nếu trình duyệt hỗ trợ;
khi không hỗ trợ, người chơi xoay máy thủ công. Việc xoay không gửi hành động
game hoặc thay đổi bài. Hình ảnh UNO giữ nguyên.

Sau cập nhật cần dừng server bằng Ctrl+C để lưu phòng, chạy lại `npm start`,
rồi Ctrl+F5 trên các thiết bị. Không xóa database hay các tệp phòng.

Kiểm tra: `npm test`, `npm run test:thrill-flow` và các script browser của
từng game. Fixture dùng bộ nhớ hoặc file/SQLite tạm, không dùng dữ liệu thật.
