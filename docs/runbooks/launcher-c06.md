# Launcher C06 — khởi động, dừng, backup

## Mở bảng điều khiển

Nhấp đúp `launch-chill-and-thrill.cmd` trong thư mục dự án. Launcher mở bảng điều khiển trong trình duyệt; cửa sổ PowerShell và tiến trình trợ giúp chạy ẩn. Cần Node.js 24 trở lên.

Bảng điều khiển chỉ lắng nghe tại `127.0.0.1:41739`. Người chơi dùng địa chỉ và QR của máy chủ game trong trang; bảng điều khiển không mở quyền quản trị qua Wi-Fi/LAN. Cửa sổ đầu tiên được mở bằng một mã dùng một lần trong phần fragment của URL, rồi đổi thành cookie phiên `HttpOnly`, `SameSite=Strict`. Trang xóa fragment ngay khi nạp; không có secret quản trị trong query string.

Nhấn **Khởi động** để chạy một tiến trình máy chủ do launcher sở hữu. Khi cổng game mặc định `3000` đang được dùng, bảng sẽ báo xung đột cổng. Launcher không dò hoặc tắt tiến trình khác; hãy dừng ứng dụng đã mở máy chủ đó rồi thử lại. Khi server đang chạy, bảng hiện địa chỉ của các card mạng IPv4 và tạo QR riêng cho từng địa chỉ. Điện thoại cần cùng mạng Wi-Fi/LAN và cổng game phải được Windows Firewall cho phép.

Nhấn **Dừng an toàn** để gửi yêu cầu qua IPC. Trạng thái chỉ thành “Đã dừng an toàn” sau khi server xác nhận `close()` hoàn tất và tiến trình con đã thoát. Nếu quá thời gian chờ, nút dừng cho phép thử lại; launcher không buộc tắt server. Không sao lưu khi đang ở trạng thái lỗi dừng hoặc khi chưa xác nhận trạng thái bằng launcher.

## Tệp dữ liệu và backup

Thẻ **Vị trí trên máy này** hiển thị ProfileStore SQLite, file phòng chính và các file manager còn lại. Các nút **Mở** mở thư mục bằng File Explorer. ProfileStore giữ chung hồ sơ, chip, coin, gem và ledger của portal cùng mọi game; launcher không tạo ví/database thứ hai.

Đường dẫn tuân theo cấu hình hiện có:

- `GANG_DATABASE_FILE` chọn SQLite; nếu không có, `GANG_DB_FILE` là alias cũ; nếu cả hai được đặt thì `GANG_DATABASE_FILE` được ưu tiên.
- `GANG_DATA_FILE` chọn JSON phòng The Gang/UNO 112 và vị trí suy ra của các file manager khác.
- Mặc định, dữ liệu nằm trong `data\` của dự án.

**Tạo backup đã xác minh** yêu cầu một trạng thái dừng sạch. Nếu server đang chạy trong launcher, thao tác sẽ dừng nó rồi chờ ACK và process exit trước khi gọi module C04. Bundle được tạo ở `backups\chill-and-thrill-<timestamp>-<id>\`. Module C04 đọc SQLite theo chế độ read-only, dùng `VACUUM INTO`, kiểm tra ledger/snapshot/room và xác minh SHA-256 trước khi hoàn tất bundle. Nếu một tệp nguồn thiếu, thay đổi giữa lúc sao lưu hoặc kiểm tra không đạt, thao tác báo lỗi và không đánh dấu bundle là hoàn tất.

Khi bảng mới mở mà chưa khởi động/dừng server qua launcher, trạng thái chưa được xác nhận và backup bị từ chối. Nếu server đang chạy ngoài launcher, hãy dừng nó theo cách đã khởi động rồi mở launcher, khởi động và dừng qua launcher trước khi dùng backup; thao tác này xác nhận đúng tiến trình được quản lý.

## Khôi phục

Dán đường dẫn thư mục backup vào ô **Khôi phục từ thư mục backup**. Launcher xác minh manifest, checksum và schema, sau đó tạo một thư mục mới cạnh bundle backup. Nó không ghi đè `data\`, không xóa database hiện tại và không tự đổi cấu hình máy chủ sang thư mục vừa khôi phục. Mở thư mục kết quả, kiểm tra tệp rồi cấu hình `GANG_DATABASE_FILE` và `GANG_DATA_FILE` có chủ ý trước khi dùng bộ dữ liệu đó.

## Bảng quản trị C05 (tùy chọn)

Launcher có liên kết tới `/admin` trên máy chủ cục bộ. Trang C05 yêu cầu nhập secret `CHILL_ADMIN_SECRET` đã cấu hình cho Windows user. Tên biến theo `src/platform/adminService.js`; secret không được truyền trong URL, QR hoặc API trạng thái launcher. API quản trị C05 chỉ chấp nhận loopback, nên máy người chơi trong LAN không thể dùng trang này.

Có thể tạo secret ngẫu nhiên 32 byte trong PowerShell rồi lưu ở cấp Windows user:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$secret = [Convert]::ToBase64String($bytes)
$rng.Dispose()
[Environment]::SetEnvironmentVariable('CHILL_ADMIN_SECRET', $secret, 'User')
```

Lưu giá trị `$secret` vào password manager để nhập trong trang quản trị, sau đó đóng và mở launcher lại để tiến trình server nhận cấu hình mới. Không dán secret vào URL, QR, báo cáo hoặc ảnh chụp màn hình.

## Giới hạn vận hành

- Launcher không giám sát server được mở trực tiếp bằng `npm start`/`node server.js`; cổng xung đột sẽ được hiển thị mà không đóng tiến trình đó.
- Restore tạo bản dữ liệu mới để kiểm tra thủ công. Nó không tự nhập hoặc thay dữ liệu đang chạy.
- QR được tạo từ IPv4 interfaces mà Windows báo cho Node. Chưa thể kết luận thiết bị ở mọi router/firewall đều kết nối được chỉ từ danh sách IP.
- C06 không thay đổi `server.js`, `src/httpServer.js`, `package.json`, schema profile hoặc các engine/biến thể UNO.
