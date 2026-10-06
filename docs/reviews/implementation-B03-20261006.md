# B03 — Quy đổi và tiến trình

Ngày: 06/10/2026. Phạm vi: xem trước coin/gem, mức đổi tối đa, lỗi số dư/giới hạn và retry an toàn trên portal cùng trang `/profile`.

## Hành vi đã triển khai

- Máy chủ cung cấp `GET /api/wallet/exchange/quote`. Báo giá xác thực bằng profile token, chỉ đọc hồ sơ của token đó, gửi `Cache-Control: no-store`, và lấy tỷ giá/giới hạn từ module tiền tệ phía server. Tham số `profileId` phía trình duyệt không được dùng.
- Báo giá tính theo coin/gem **khả dụng**. Coin đang giữ ở bàn không thể dùng để đổi; khoản giữ được giữ nguyên. Mức tối đa là số gem nguyên nhỏ hơn giữa khả năng chi trả của nguồn và `walletCreditCapacity.remaining` ở ví đích (được chặn thêm bởi `CURRENCIES.max`). Phần sức chứa được dành cho thanh toán ván coin đang chơi được giải thích trong preview/lỗi theo cách người chơi đọc được.
- Giao diện hiện chính xác đơn vị/số bị trừ, số nhận, số dư khả dụng sau quy đổi, khoản giữ hiện tại và mức tối đa. Nút tối đa điền số gem lớn nhất server vừa báo; chiều đổi và số gem vẫn do người chơi chọn.
- Khi quote đã cũ, POST vẫn gọi `ProfileStore.exchangeCurrency`, nơi kiểm tra lại hai ví trong transaction. Nếu số dư nguồn thay đổi, phản hồi nêu số đang có và số còn thiếu; nếu vướng trần đích, `WALLET_LIMIT`/`PAYOUT_CAPACITY` được báo lại bằng dung lượng nhận còn lại, phần coin được dành cho thanh toán ván và phần vượt trần.
- Giao dịch có operation key được lưu trong `sessionStorage` của tab. Khi phản hồi bị mất, giao diện khóa nguyên hướng/số tiền và cho kiểm tra lại cùng operation key. Server trả kết quả idempotent cũ nếu giao dịch đã commit; nó không ghi thêm ledger. Nếu báo giá mới hết khả năng đổi, vẫn có nút kiểm tra lần gửi cũ.
- Phần giải thích nêu coin dùng cho Tiến lên, Sâm lốc và Phỏm; gem là đơn vị quy đổi đang có, chưa có cửa hàng gem; chip Poker có ví riêng. Nhịp thưởng lấy từ server: 1.000 coin lúc tạo hồ sơ và tổng thưởng của các nhiệm vụ ngày hiện đang mở (450 coin từ 3 nhiệm vụ trong fixture kiểm tra).
- Không thay tỷ lệ 1 gem = 10.000.000 coin, cách cấp coin, số dư/ledger hiện có, hồ sơ/token, chip Poker hoặc dữ liệu người chơi. Không thêm database ví. Không sửa markup trang: `currency-wallet.js` thêm phần nội dung cần thiết vào form đã có.

## Tệp thuộc B03

- `src/platform/currencyQuote.js` — phép tính báo giá thuần, số tối đa và lỗi thiếu tiền/vượt trần.
- `src/httpServer.js` — route quote riêng; POST hiện có trả thông tin giao dịch, báo thiếu cụ thể khi `ProfileStore` từ chối số dư mới.
- `public/js/currency-wallet.js` — quote live, preview, nút tối đa, hướng đổi, trạng thái xác nhận và khóa retry.
- `public/css/currency-wallet.css` — style riêng cho giải thích, preview, nút tối đa và màn nhỏ.
- `test/currency-exchange-b03.test.js` — kiểm tra phép tính, quyền riêng tư và route.
- `scripts/currency-wallet-browser-check.js` — kiểm tra trình duyệt bằng server/database bộ nhớ và hồ sơ fixture.

## Kiểm tra đã chạy

- `node --test test/currency-exchange-b03.test.js test/currencies.test.js` — **8/8 đạt**. Bao gồm số tiền biên/nguyên dương, thiếu coin/gem, tiền đang giữ, chỗ đích đúng trần/vượt trần, quote không lộ ví hồ sơ khác, tỷ giá/phần thưởng từ server, stale quote, POST lặp cùng operation key và quote trong ván coin gần trần có sức chứa trả thưởng được bảo vệ.
- `node scripts/currency-wallet-browser-check.js` — **đạt** trên portal và `/profile`, ở viewport 390×844 và 1280×900. Fixture một lần làm rớt phản hồi sau khi server commit; lần kiểm tra lại dùng cùng khóa và ledger vẫn chỉ có hai dòng cho một giao dịch.
- `node --test test/audit-a07.test.js test/currency-exchange-b03.test.js test/currencies.test.js` — **27/27 đạt**, gồm regression sức chứa trả thưởng A07 và quote B03 gần trần.
- `node --test test/uno-classic.test.js` — **6/6 đạt** khi chạy riêng.
- `npm test -- --test-reporter=dot` — **đạt** trong lượt chạy cuối trên working tree chung.

## Giới hạn

Quote là ảnh chụp số dư tại thời điểm gọi; một hành động đồng thời có thể làm nó cũ trước khi người chơi xác nhận. POST được kiểm tra lại và không áp dụng quote cũ. Operation key phía trình duyệt tồn tại trong session của tab hiện tại; nếu người chơi chủ động bắt đầu một giao dịch mới sau khi đóng tab mà không còn key cũ, đó là lệnh mới. Kiểm tra viewport dùng Chrome headless, chưa phải điện thoại thật.
