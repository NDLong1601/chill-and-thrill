# B06 — Tùy chọn bàn mobile

Ngày 06/10/2026. Hoàn tất trên bảy game và hai biến thể UNO; không sửa kinh tế hoặc dữ liệu người chơi.

Module `public/js/table-preferences.js` và CSS chung cung cấp cỡ bài/chữ, đánh dấu người đang xử lý lượt/phản ứng, âm báo tùy chọn và giảm chuyển động. Tùy chọn lưu theo thiết bị, vẫn dùng được khi localStorage bị khóa. Âm thanh chỉ khởi tạo sau thao tác tin cậy và bật lựa chọn; state trùng không báo lại. UNO +4, rút phạt, cửa sổ bắt lỗi và BANG phản ứng sử dụng actor thực từ public state; không đọc bài của đối thủ.

Các trang portal và native đã nối module. Coordinator kiểm tra bàn thật và sửa panel bị đặt trong stage tuyệt đối, vùng nội dung bàn che thao tác, và width/flex-basis native ngăn lá bài đổi kích thước. Các bàn native dành hàng riêng cho preferences; UNO 112 đặt panel trong `uno-shell`; The Gang đặt tùy chọn và gợi ý trong menu tiện ích có giới hạn theo viewport. Cách chọn bài hiện hành được giữ nguyên.

Kiểm chứng: `node --test test/table-preferences.test.js` đạt **6/6**; harness `scripts/table-preferences-browser-check.js` đạt bàn phím, bốn viewport 320/390/844/1280, computed card/font sizes, forced colors, giảm chuyển động, âm báo, persistence và storage bị khóa. Test đợi kích thước sau transition CSS, không hạ kỳ vọng. `scripts/table-preferences-product-check.js` đạt **tám bàn sản phẩm thực tế**, cùng actor, cỡ bài/chữ, viewport và reload. Log `test-results/automation-b06-{node,browser,product}-20261006.log`; ảnh UNO112 `test-results/table-preferences-B06-product-uno112-mobile.png`.

Browser sử dụng Chrome headless và dữ liệu SQLite/phòng tạm; chưa kiểm thử điện thoại hoặc WiFi thật. Feature chat gặp approval pending ở sandbox trước; coordinator hoàn thành QA bằng công cụ local được cấp quyền, không đổi cấu hình approval. Nhả frontend cho B01 và các tính năng tiếp theo. Chưa nghiệm thu toàn bộ audit trước V01.

## Kiểm tra bổ sung 06/10/2026 08:16 Asia/Saigon

Lượt kiểm tra tích hợp phát hiện panel preferences và context help tạo hàng grid ngoài bố cục ba hàng của The Gang: arena chỉ còn khoảng 42px, ghế đè bài chung ở màn hình ngang thấp. Sau khi chuyển hai panel vào menu hiện có, `scripts/browser-check.js` đạt đầy đủ bàn sáu người, Camera ba lá, River/Showdown, viewport rộng 480/568/667/844/932px và cao 240px, safe area 24px, fullscreen, reconnect/host transfer, privacy, không request ngoài server và không page error. Ảnh `test-results/mobile-table-568.png` đã được xem trực tiếp. Log lỗi trước sửa `test-results/automation-overlap-browser-20261006.log`, log đạt `test-results/automation-overlap-gang-fix-20261006.log`.

Kiểm tra gợi ý phát hiện UNO 112 bị ép ngang vì preferences là flex child bên cạnh shell; panel đã được chuyển vào shell. Kiểm tra toàn trang còn phát hiện toolbar UNO 108 tràn tại 320px; header và nhóm công cụ nay cho xuống dòng. The Gang chỉ đổi kích thước bài trên tay, giữ kích thước bài chung và thumbnail đối thủ. Script sản phẩm bổ sung kiểm tra toàn trang không tràn ngang khi cỡ bài lớn/chữ lớn nhất, menu nằm trong chiều cao viewport và bài công khai giữ kích thước qua hai lựa chọn cỡ bài.

Kết quả sau sửa: **20/20** Node cho preferences/context; harness bàn phím/âm thanh/storage đạt; **tám bàn thực tế** qua actor, cỡ bài/chữ, 320/390/844/1280, toàn trang, menu và reload; context help **tám biến thể** đạt cùng deep link hướng dẫn. Log `test-results/automation-overlap-{ui-node,b06-harness,b06-product,b05-context}-20261006.log`. Core browser Tiến lên, Sâm, Phỏm, Poker, UNO 108, BANG và portal cũng đạt trong lượt này với dữ liệu tạm/bộ nhớ. Baseline Node **329/329** là checkpoint trước tích hợp B08, không phải nghiệm thu toàn audit. V01 đã có chat `01a10ebd-8fd2-7f92-a658-8b0466a0434f`, còn chờ B08/C01/C05/C06/C07/C08 hoàn tất sản phẩm.

Phạm vi sửa và QA bổ sung đã hoàn tất; nhả `table-preferences.js`, `table-preferences.css`, `context-help-ui.js`, `table-preferences-product-check.js`, `context-help-browser-check.js` cho coordinator chính. Không sửa manager, store, portal, package hoặc dữ liệu thật.
