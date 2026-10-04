# 🎭 The Gang — Poker Heist (Bản LAN Chơi Cùng WiFi)

> Game hợp tác Poker Texas Hold'em phỏng theo boardgame **The Gang** nổi tiếng. Dành riêng cho gia đình và bạn bè chơi nội bộ qua mạng WiFi nhà, hoạt động ổn định, mượt mà, giao diện sang trọng và hoàn toàn miễn phí.

---

## 🚀 Hướng Dẫn Chạy Game

### 1. Cài đặt (chỉ cần chạy lần đầu)
Mở terminal trong thư mục `the-gang` và chạy:
```bash
npm install
```

### 2. Khởi động máy chủ
```bash
npm start
```
Terminal sẽ hiển thị địa chỉ IP mạng nội bộ của bạn, ví dụ:
```
╔════════════════════════════════════════════════════════╗
║        🎭  THE GANG  -  HEIST POKER LAN SERVER         ║
╠════════════════════════════════════════════════════════╣
║  💻 Máy chủ Host : http://localhost:3000                 ║
║  📱 Chơi WiFi LAN: http://192.168.1.51:3000            ║
╚════════════════════════════════════════════════════════╝
```

### 3. Kết nối chơi
- **Máy chủ (Host)**: Mở trình duyệt vào `http://localhost:3000`
- **Mọi người trong nhà (Điện thoại, Tablet, Laptop)**: Kết nối cùng WiFi và mở địa chỉ `http://192.168.x.x:3000` (theo IP hiện ở terminal).

---

## 🎲 Các Chế Độ Chơi (Bám Sát Luật Chơi Gốc)

| Chế độ | Mô tả | Độ khó |
|---|---|---|
| **Cơ bản (Basic)** | 3 Két sắt, 3 Báo động. Không dùng Thử thách hay Chuyên gia. Thích hợp cho người mới làm quen. | ⭐ Dễ |
| **Nâng cao (Advanced)** | 3 Két, 3 Báo động. Thắng vụ cướp mở 1 thẻ **Thử thách** (tăng độ khó), Thua vụ cướp mở 1 thẻ **Chuyên gia** (trợ giúp). | ⭐⭐ Chuẩn |
| **Chuyên nghiệp (Expert)** | 1 Thẻ Thử thách vĩnh viễn suốt trận đấu + cơ chế Thử thách/Chuyên gia từng vụ cướp. | ⭐⭐⭐ Khó |
| **Siêu trộm (Master Thief)** | Chỉ có **2 Báo động** là thua! Không có Chuyên gia giúp đỡ. Luôn có **2 Thẻ Thử thách** kích hoạt đồng thời! | ⭐⭐⭐⭐ Đỉnh cao |

---

## 🃏 Quy Trình 1 Vụ Cướp (Heist)

Mỗi vụ cướp diễn ra qua 4 vòng tương ứng với Texas Hold'em Poker và 4 màu chip:

1. **Vòng 1 · Pre-Flop (⚪ Chip Trắng):**
   - Mỗi người nhận 2 lá bài tẩy bí mật (hoặc 3 lá nếu có Thử thách #10).
   - Chọn chip trắng (1⭐ đến N⭐) để đánh giá độ mạnh của bài tẩy.
2. **Vòng 2 · The Flop (🟡 Chip Vàng):**
   - Lật 3 lá bài chung ở giữa bàn.
   - Chọn chip vàng (1⭐ đến N⭐). Chip trắng vẫn giữ nguyên trước mặt để cả đội thấy sự biến đổi!
3. **Vòng 3 · The Turn (🟠 Chip Cam):**
   - Lật lá bài chung thứ 4.
   - Chọn chip cam (1⭐ đến N⭐).
4. **Vòng 4 · The River (🔴 Chip Đỏ):**
   - Lật lá bài chung thứ 5.
   - Chọn chip đỏ (1⭐ đến N⭐).
5. **Màn So Bài (Showdown):**
   - Chỉ có **Chip Đỏ (Vòng 4)** quyết định thắng thua!
   - Lật bài theo thứ tự Chip Đỏ từ 1⭐ (yếu nhất) đến N⭐ (mạnh nhất).
   - Nếu thứ tự bài tăng dần (hoặc hòa nhau hợp lệ) mà không ai nhỏ hơn người trước → **🔓 Phá thành công 1 Két sắt**!
   - Nếu có lỗi sai thứ tự → **🚨 Kích hoạt 1 Chuông báo động**!

---

## 🔄 Tiếp Tục Chơi Trong Cùng Phòng

- **Sau mỗi vụ cướp**: Host bấm **▶ TIẾP TỤC VỤ CƯỚP TIẾP THEO** ngay trên màn hình kết quả để tự động chia bài mới, áp dụng thẻ bài mới theo luật mà không bị thoát phòng.
- **Sau khi kết thúc trận (Game Over)**: Host bấm **🔄 CHƠI LẠI TRẬN MỚI CÙNG PHÒNG** để reset điểm số và bắt đầu ngay ván mới cùng mọi người.
- Hoặc bấm **🏠 Trở về phòng chờ** để đổi chế độ chơi hay đổi người.

## Bản nâng cấp: cách sử dụng

- **Vào phòng nhanh:** mở phần QR ở phòng chờ. Chọn địa chỉ WiFi của máy chủ, rồi quét QR hoặc sao chép đường dẫn. Link có sẵn mã phòng. Khi mở trên máy chủ bằng `localhost`, chương trình ưu tiên địa chỉ LAN để điện thoại có thể vào được.
- **Sẵn sàng:** mỗi thành viên, kể cả chủ phòng, bấm Sẵn sàng. Đổi chế độ hoặc quy tắc giao tiếp sẽ hủy trạng thái sẵn sàng để cả đội xác nhận lại.
- **Chốt chip:** sau khi chọn chip, mọi người bấm Chốt chip. Chủ phòng chuyển vòng khi tất cả đã chốt. Mỗi lần lấy, trả hoặc lấy chip của người khác sẽ hủy chốt của cả đội. Đây là bước xác nhận của bản số để tránh chuyển vòng khi còn đang trao đổi chip.
- **Lấy chip đồng đội:** nếu bạn đã có chip, chip cũ trở về bàn; đồng đội bị lấy chip sẽ chưa có chip. Không tự đặt chip của mình trước mặt người khác. Chip bị khóa không thể được đổi, trả hay lấy ở Vòng 1–3; Vòng 4 không khóa.
- **Khôi phục:** khi WiFi gián đoạn hoặc tải lại trang trong cùng tab, ghế, bài và chip được khôi phục bằng phiên riêng của tab. Không cho hai cửa sổ cùng điều khiển một ghế. Chủ phòng mất kết nối thì quyền chủ phòng chuyển sang người đang kết nối.
- **Quản lý phòng:** nút 👥 cho phép chuyển chủ phòng, tạm dừng/tiếp tục và đưa cả đội về phòng chờ. Mời ra/rời phòng chỉ thực hiện ở phòng chờ hoặc giữa hai vụ cướp. Ván tạm dừng khi có thành viên mất kết nối để không tự chơi thay bài bí mật của họ.
- **Điện thoại:** xoay ngang khi vào bàn. Bài chung, tất cả ghế đồng đội, bài riêng, khay chip và nút chốt/chuyển vòng cùng nằm trong một màn hình, không cần cuộn. Bố cục tự điều chỉnh theo phần màn hình Chrome đang hiển thị, kể cả khi còn thanh địa chỉ. Lần chạm đầu trên bàn sẽ yêu cầu toàn màn hình nếu trình duyệt hỗ trợ; nút **⛶** cho phép bật/tắt, và chương trình tôn trọng khi bạn thoát toàn màn hình. Nút này cũng có ở màn hình nhắc xoay ngang. Chạm bài riêng để phóng to; nút **🙈** che/hiện bài. Các nút chính và chip có vùng chạm tối thiểu 44px. Menu **☰** chứa quản lý phòng, lịch sử, âm thanh, luật và thẻ đang dùng; nút **✨ / ⚖️** mở thao tác chuyên gia/chi tiết so bài. Các thao tác cần chọn bài hoặc dự đoán được mở trong hộp riêng. Bài, chip và kết nối được giữ nguyên khi xoay. Khung chat mặc định đóng.
- **Giao tiếp:** mặc định theo luật, chỉ dùng các câu nhanh trung tính và tắt emoji trong vụ cướp. Chủ phòng có thể bỏ lựa chọn này ở phòng chờ cho một phiên chơi thoải mái; mọi người cần sẵn sàng lại.
- **Luyện tập:** nút Chơi thử có hướng dẫn tại sảnh chạy một vụ cướp mẫu qua 4 vòng, không tác động vào phòng thật.

## Thẻ và so bài

Tất cả 10 Thử thách và 10 Chuyên gia có xử lý tương ứng. Thẻ cần chọn người sử dụng có bước đề xuất và được cả đội đồng ý. Bài được chia sẻ bởi Người cung cấp thông tin chỉ gửi cho người nhận được chọn; Tin tặc/Jack yêu cầu người sử dụng chọn một lá để bỏ. Điều phối viên chuyển bài đồng thời theo thứ tự ghế; Nghệ sĩ lừa đảo chỉ xáo những lá tẩy đã chia sau khi mọi người xác nhận đã xem.

Quét võng mạc và Quét vân tay yêu cầu các đồng đội thống nhất dự đoán trước khi lật người giữ chip đỏ cao nhất. Người này không được bỏ phiếu. Dự đoán sai làm vụ cướp thất bại ngay cả khi thứ tự bài đúng. Mất điện ẩn chip và nhật ký lấy chip các vòng trước. Camera an ninh vẫn giữ đúng 3 lá tẩy khi kết hợp với hiệu ứng đổi bài.

So bài được lật từng người. Kết quả hiển thị 5 lá tốt nhất, các vị trí sai thứ tự, hòa đúng và giá trị quyết định khi cùng hạng bài. Cơ bắp chỉ thuộc người được cả đội chọn: thắng mọi tay bài cùng hạng nhưng vẫn thua hạng cao hơn. Jack không có chất và không dùng tạo thùng.

Chế độ Chuyên nghiệp/Siêu trộm loại Tiếp cận nhanh khỏi toàn bộ chồng Thử thách. Siêu trộm bắt đầu với hai thẻ ngẫu nhiên. Tiến độ chồng thẻ được giữ trong cùng phòng qua các trận để có thể gặp đủ các thẻ, thay vì luôn trở lại thẻ số 1.

## Lưu dữ liệu và chơi LAN không có Internet

Socket.IO, CSS và JavaScript được phục vụ từ máy chủ LAN, dùng font có sẵn trên thiết bị; chơi không cần tải CDN hay Google Fonts. Lần cài `npm install` vẫn cần Internet.

Phòng, phiên khôi phục và 100 vụ cướp/trận gần nhất được lưu tự động tại `data/rooms.json`. Dữ liệu này giúp khôi phục khi khởi động lại máy chủ. Ghế mất kết nối trong phòng chờ được giữ khoảng 2 phút; khi đang chơi được giữ cho đến khi chủ phòng đưa về phòng chờ hoặc cả phòng hết hạn. Phòng không có người kết nối được giữ tối đa 12 giờ. Giữ thư mục `data` nếu muốn giữ lịch sử và các phiên khôi phục.

Nút 📊 hiển thị tỷ lệ thắng theo chế độ, chi tiết từng vụ và cho tải lịch sử JSON. Thiết bị cũng giữ 100 kết quả đã xem để có thể mở lại từ sảnh. Chỉ lưu ván đã so bài xong; bỏ dở vụ cướp về phòng chờ không tính thắng/thua.

## Kiểm tra chương trình

Node.js 20 trở lên:

```powershell
npm test
```

Kiểm tra giao diện bằng Chrome cài trên máy (chạy ẩn, không dùng hồ sơ trình duyệt cá nhân):

```powershell
npm run test:browser
```

Nếu dùng Edge: `$env:GANG_BROWSER_CHANNEL='msedge'` trước khi chạy. Ảnh kiểm tra màn hình máy tính, điện thoại dọc/ngang và bàn 6 người được lưu trong `test-results/`.

Đổi cổng nếu 3000 đang được dùng:

```powershell
$env:PORT='3001'
npm start
```
