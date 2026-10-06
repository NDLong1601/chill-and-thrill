# Sửa các lỗi R01–R06 sau review

Ngày hoàn tất: 06/10/2026. Workspace: `C:\Users\PC\Documents\chill-and-thrill`.

Đã sửa cả sáu lỗi trong `product-rereview-20261006.md`. Lần kiểm tra cuối đạt **458/458 test Node** và **10 bộ kiểm tra trình duyệt liên quan**. Mã được sửa trực tiếp trên working tree, giữ các thay đổi đã có. Kiểm thử sử dụng database/phòng tạm hoặc bộ nhớ; không mở hay chỉnh database người chơi để sửa dữ liệu thủ công.

## Hành vi sau sửa

| Mã | Thay đổi | Bằng chứng nghiệm thu |
|---|---|---|
| R01 | Socket sảnh mới được khôi phục vào đúng ghế cũ qua adapter resume đã xác thực trước khi rời/cash-out. Vẫn chặn đổi game giữa ván và khi khoản giữ không khớp. | Nhóm bốn hồ sơ đi qua cả tám target bằng socket mới; Poker RESULT cash-out đúng một lần, đóng khoản giữ và bảo toàn số dư. |
| R05 | Handoff tới trang tích hợp lưu đúng `gang.session`, gồm room/seat/profile token và variant; thay session cũ trước khi điều hướng. | Browser UNO108 → sảnh → The Gang → sảnh → UNO112 → sảnh → Tiến lên. The Gang/UNO112 vào đúng ghế với session sạch hoặc cũ; reload vẫn khôi phục được. |
| R02 | `cancel_before_first_play` và `cancel_before_first_discard` được nối vào cùng cơ chế capture/resolve vòng giải. Vòng hủy đóng ở `CANCELLED`, không cộng điểm và cho bắt đầu vòng tiếp. | Tiến lên, Sâm, Phỏm: guest bị từ chối; lỗi ghi snapshot rollback; host hủy thành công; retry không hoàn hai lần; vòng sau bắt đầu được. |
| R02 recovery | Reconcile đọc bằng chứng hoàn coin đã commit cùng snapshot WAITING/tombstone, đối chiếu từng reservation/profile/currency và ledger của đúng match. Chỉ cập nhật trạng thái giải; không ghi thêm giao dịch ví. | Giả lập lỗi cập nhật giải ở cả ba game, từ chối snapshot mâu thuẫn, sau đó phục hồi đúng một lần. Mở lại SQLite tạm khi không còn nhóm trong bộ nhớ vẫn ghi vòng cũ là CANCELLED và giữ nguyên ví. |
| R03 | Thông báo nội bộ sau commit từ các manager cung cấp mã phòng cho SpectatorService, độc lập với việc có socket người chơi nhận state. Các yêu cầu publish cùng lượt được gom lại; public projection và transaction guard vẫn áp dụng. | Lượt timeout Tiến lên khi cả hai ghế offline được gửi tới watcher; lỗi snapshot không gửi state rollback. Bộ spectator product kiểm tra cả tám target, quyền chỉ đọc, mật khẩu, privacy và reconnect đạt. |
| R04 | Ghế online của thành viên tại phòng được nhóm liên kết được tính là hoạt động nhóm khi sweep. | Nhóm đang chơi tồn tại sau 31 phút; nhóm bỏ hoang được dọn sau hạn idle; chính sách hết hạn tuyệt đối sáu giờ vẫn áp dụng. |
| R06 | Navbar desktop dùng hai hàng để các liên kết không đè lên tab hồ sơ; tab có thể xuống dòng, số dư được ẩn ở chiều rộng trung bình khi cần. Test ví mở subtab Ví mới. | Click thường vào hồ sơ/ví và kiểm tra mọi liên kết ở 390/701/900/1024/1180/1280/1366/1440/1920px, tên dài, số dư lớn, focus bàn phím. Quy đổi/retry mất phản hồi đạt. |

## Các file chính

- `src/platform/groupLobbyService.js`: khôi phục ghế trước khi rời bàn; tính hoạt động phòng liên kết cho thời hạn nhóm.
- `public/js/group-lobby.js`: chuyển đúng session sang The Gang/UNO112.
- `src/platform/groupTournamentSupport.js`: hook các action hủy coin và dùng chung wrapper cancellation.
- `src/platform/groupTournamentService.js`, `groupTournamentLifecycle.js`: đối chiếu bằng chứng hủy đã commit để phục hồi trạng thái giải.
- `src/platform/roomCommitEvents.js`: kênh thông báo nội bộ chỉ mang mã phòng.
- `src/platform/coinRoomTransactions.js`, `gameStateTransactions.js`, `src/games/poker/pokerEngine.js`: phát thông báo sau lưu thành công.
- `src/platform/spectatorService.js`: đăng ký/hủy đăng ký các thông báo phòng, gom publish, giữ nguyên public projection.
- `public/css/shared-ui.css`: bố cục navbar; `scripts/currency-wallet-browser-check.js`: điều hướng subtab mới.
- `test/product-rereview-fixes.integration.test.js`, `test/groupLobbyTargets.integration.test.js`, `test/groupTournamentLifecycle.test.js`: hồi quy tích hợp, socket mới, rollback, ví và phục hồi.
- `scripts/group-lobby-browser-check.js`, `scripts/portal-navigation-browser-check.js`: luồng điều hướng thực tế và navbar nhiều kích thước.

Tất cả game tiếp tục sử dụng cùng `ProfileStore`/ledger. Không thêm database ví hoặc thay game ID, luật tiền cược, token và link cũ.

## Kiểm thử đã chạy

| Lệnh/bộ kiểm tra | Kết quả cuối |
|---|---|
| `npm test` | 458/458 đạt; fail/skip/cancel = 0 |
| `group-lobby-browser-check` | Đạt: cả hai loại trang game, chuyển bằng socket mới, session sạch/cũ và reload |
| `currency-wallet-browser-check` | Đạt: portal và `/profile`, mobile/desktop, giao dịch mất phản hồi và retry |
| `portal-navigation-browser-check` | Đạt: chín chiều rộng, tên/số dư dài, click không bị che, focus bàn phím |
| `spectator-product-browser-check` | Đạt: tám bàn thật, quyền xem và privacy |
| `group-tournament-product-browser-check` | Đạt: UI host/roster, kết quả hợp lệ, điểm đúng một lần, lịch sử/restart/bốn layout; chạy lại sau bổ sung recovery |
| `portal-browser-check` | Đạt: tạo/vào/resume/rời phòng qua portal và link LAN |
| `audit-v01-multitab-browser-check` | Đạt: nhiều tab và thanh toán một lần, không có page error |
| `a03-lifecycle-browser-check` | Đạt: reconnect lifecycle |
| `shared-ui-browser-check` | Đạt: phòng bảo vệ, QR, xoay màn hình, link cũ và rời bàn |
| `portal-home-mobile-browser-check` | Đạt: mobile, favorite/recent, khôi phục/rời bàn, identity và hai UNO |

Log Node cuối: `test-results/fixes-r01-r06-unit.log`. Log riêng recovery: `test-results/fixes-r02-recovery.log`. Các log browser: `test-results/fixes-*.log`; ảnh navbar đã sửa: `test-results/fixes-r06-navigation-1280.png` (đã xem trực tiếp).

Các lỗi ghi storage/cập nhật giải in trong regression là fault injection có chủ đích. Script tái hiện cũ trong `scratch/rereview-20261006.cjs` giữ nguyên như bằng chứng review trước sửa; không dùng exit code của script đó để nghiệm thu bản mới.

Các lệnh mới trong package.json:

```powershell
npm run test:rereview-fixes
npm run test:group-lobby-browser
npm run test:portal-navigation
npm run test:currency-wallet
```

Chưa kiểm tra trên điện thoại thật hoặc WiFi chập chờn thật. Kiểm tra expiry/timeout dùng clock fixture; kiểm tra restart sử dụng SQLite tạm. Sảnh nhóm vẫn là dữ liệu trong bộ nhớ theo thiết kế hiện có; sau restart, giải chưa hoàn tất xử lý theo chính sách suspend đã có. Recovery mới giữ đúng trạng thái hủy của vòng cũ, không tự dựng lại sảnh nhóm.

Máy chủ đang chạy cần khởi động lại để nạp mã backend mới; trình duyệt cần tải lại trang để nạp JS/CSS mới. Lượt sửa này không dừng phiên chơi thật hoặc tự khởi động lại máy chủ đang được người chơi sử dụng.
