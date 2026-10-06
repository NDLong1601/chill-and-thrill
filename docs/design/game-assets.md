# Tài nguyên hình ảnh game

Bộ ảnh được nhập từ `C:\Users\PC\Downloads\images`. Các ảnh gốc được giữ
nguyên. Bản dùng cho trình duyệt nằm trong `public/assets/game`, được đóng gói
thành WebP lossless và phục vụ trực tiếp từ máy chủ LAN.

- Bốn sheet chất bích, cơ, rô, chuồn được tách thành đủ 52 lá: A, 2–10, J, Q, K.
- `card/mặt sau.png` dùng cho các lá úp và nọc bài thường.
- `logo.png` dùng trên cổng game, các trang bài thường và hồ sơ.
- `chip.png` dùng cho ví và bàn cược Poker. The Gang giữ nguyên chip số/ngôi sao
  và bốn màu vòng như giao diện cũ; chip này chỉ biểu thị thứ hạng bài.
- `coin.png` dùng cho Tiến lên, Sâm lốc, Phỏm và phần thưởng nhiệm vụ.
- `gem.png` dùng cho số dư và quy đổi coin/gem. Game giải trí không cược tiền tệ.
  Cả ba số dư cùng dùng `ProfileStore`, cùng database và ledger có trường đơn vị.

The Gang, Poker, Tiến lên, Sâm lốc, Phỏm và bảng minh họa thứ hạng tay bài
dùng chung ảnh bài thường.
BANG! dùng ảnh theo chất/hạng của lá bài, đồng thời giữ tên hiệu ứng, loại lá
và thao tác riêng. Lá Jack không chất trong The Gang giữ cách hiển thị chữ
vì bộ ảnh cung cấp chỉ có 52 lá chuẩn. Chỉ những lá đã được máy chủ cho phép
hiển thị mới được ánh xạ sang ảnh; bài đối thủ vẫn úp.

Hình ảnh của cả hai phiên bản UNO chưa được nhập hoặc thay đổi.

## Nhập lại tài nguyên

Cần Python và Pillow. Chạy tại thư mục dự án:

```powershell
python scripts/import-game-assets.py "C:\Users\PC\Downloads\images"
```

Script ghi lại 52 ảnh mặt trước, một mặt sau, bốn biểu tượng và
`public/assets/game/manifest.json`. Manifest lưu kích thước, vùng cắt và SHA-256
của chín ảnh nguồn để đối chiếu. 53 ảnh bài có thêm PNG dự phòng; trình duyệt
tự thử PNG nếu WebP không tải được. Script không đọc thư mục ảnh UNO.

`public/js/game-art.js` ánh xạ bài sang ảnh; `public/css/game-art.css` điều chỉnh
kích thước và giữ vùng bấm/chọn của giao diện. Sau khi cập nhật, tải lại trang
bằng Ctrl+F5 để trình duyệt lấy tài nguyên mới.
