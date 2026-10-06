# B08 — Hợp đồng adapter và API client chung

Ngày: 06/10/2026. Phạm vi: contract/client mới và chuyển dần các request portal qua lớp dùng chung. Tích hợp vẫn dùng `MultiGameManager` và `ProfileStore` hiện có; không tạo database hay ledger mới. Không đổi chữ ký manager hoặc xóa event alias cũ.

**Trạng thái: HOÀN TẤT** — contract v1, server wiring bổ sung, portal migration và QA Node/browser đã đạt.

## Đã thêm

- `src/platform/gameAdapterContract.js` định nghĩa contract v1 với năm thao tác `create`, `join`, `resume`, `action`, `result`. Adapter mới nhận context object; factory bọc callback manager cũ mà không đổi lời gọi hay response cũ. Response mới giữ `legacy`, chuẩn hóa `ok/error`, bảo toàn error code/details và capability metadata. Adapter lỗi vẫn thành response có mã lỗi thay vì làm rơi nguyên nhân.
- Cùng module khai báo tám cặp game/variant → manager/entry path. UNO yêu cầu variant tường minh trong contract mới. Hàm chuyển tiếp chỉ áp mặc định legacy khi biết bề mặt cũ: `room:create` chọn `classic-local-v1` (112 lá); `create_room` chọn `classic-108-v1` (108 lá).
- `public/js/game-api-client.js` cung cấp API client dùng được trong trình duyệt và Node, cho HTTP cùng socket ack. Có timeout, `AbortSignal`, xử lý disconnect, phân biệt lỗi trước gửi với kết quả có thể chưa rõ sau gửi, và bỏ qua ack đến muộn. Client không retry create/join/resume/action theo mặc định; retry socket chỉ bật cho `game:request_state`/`game:result` hoặc mutation có capability idempotency, operation cho phép và key xuất hiện thật trong payload/header.
- `MultiGameManager` tạo contract cho game/variant và ràng buộc thao tác với manager hiện tại. `src/httpServer.js` chuyển `room:create/join/resume` và `game:action` qua contract, rồi trả `legacy` response theo định dạng cũ. Event bổ sung `game:result` trả envelope chuẩn hóa lấy từ state theo ghế; error khi không tìm thấy phòng/ghế có mã rõ.
- Portal dùng client chung cho tạo/vào/tiếp tục phòng. `public/index.html` nạp client trước `portal.js`. Các event/alias cũ, URL cũ và token ghế tiếp tục hoạt động. `result` không trả object nội bộ; outcome được chiếu từ builder state đã xác thực ghế. `rulesVersion` của game như `south-v1` và `local-v1` được giữ riêng, không bị thay bằng tên variant contract `standard`.

## Regression và bằng chứng

Root chạy `node --test test/game-api-contract.test.js test/game-result.socket.integration.test.js test/portal.integration.test.js`: **11/11 đạt**. Log: `test-results/automation-b08-result-20261006.log`.

Test dùng `createGameServer`, manager thật và SQLite/room JSON fixture riêng dưới `.tmp-b08-*` trong workspace; thư mục fixture được dọn sau test. Đã xác nhận:

- Tám target gồm cả hai engine UNO; giữ đúng hai ID lịch sử và hai mặc định theo legacy surface.
- Contract wrapper giữ credential/response cũ, message lỗi kiểu chuỗi, error code/details kiểu mới và capability.
- Socket timeout, abort trước/sau gửi, disconnect, ack muộn và cleanup listener.
- Retry read an toàn; action không retry chỉ vì có `retry`; action chỉ retry khi key nằm trên wire và server capability khai báo operation idempotent. REST GET retry khi lỗi mạng; POST timeout/abort trả trạng thái có thể chưa rõ và không gửi lần hai.
- Hai manager UNO tạo/vào/bắt đầu phòng, phân biệt bài kín theo ghế, trả result không chứa tay bài, giữ đường resume và trả lỗi action có mã.

Fixture nằm trong thư mục `.tmp-b08-*` tạo riêng bên trong workspace writable, dùng SQLite và room JSON tạm, rồi được dọn sau test. Test không mở cổng mạng; client transport edge cases dùng socket shim, còn manager và `ProfileStore` là implementation thật.

`test/game-result.socket.integration.test.js` kiểm tra event `game:result` qua Socket.IO thật cho cả hai biến thể UNO: summary theo ghế, từ chối ghế ngoài phòng, không lộ tay bài khi ván đang chơi và lọc trường riêng khi có kết quả cuối. Root chạy portal browser check thành công: tạo/vào phòng, sẵn sàng, action, reload, rời phòng, chuyển bàn trong cùng browser, UNO 108 và M4–M6 cùng hồ sơ. Log: `test-results/automation-b08-portal-20261006.log`.

## Phạm vi còn lại

Migration được giữ theo từng luồng. Portal đã dùng client chung; các client bàn độc lập còn giữ đường legacy để chuyển riêng sau khi đối chiếu từng game. Đây là giới hạn phạm vi của đợt này, không chặn B08.

- Client bàn `public/js/uno.js`, `public/js/uno-classic.js`, `public/js/tien-len.js`, `public/js/poker.js`, `public/js/sam-loc.js`, `public/js/phom.js`, `public/js/bang.js` và các trang độc lập chưa nạp client này. Có thể chuyển từng luồng sau khi kiểm tra request/response cụ thể; không chuyển hết một lượt.
- `game:action` hiện dùng contract cho UNO hai biến thể và M4–M6. The Gang vẫn thao tác bằng event lịch sử như `claim_chip`/`advance_phase`; contract trả `GAME_ACTION_UNSUPPORTED` nếu gọi generic action cho The Gang. Alias cũ của game đó không thay đổi.
- `game:result` được thêm ở server, nhưng chưa có UI bàn nào gọi nó. API client luôn dựa trên phản hồi của server; không tự retry create/action/money mutation sau timeout không rõ kết quả.
- Không thêm script alias vào `package.json`; `node --test` tự tìm test mới.

Socket.IO result authorization/privacy và portal/browser đã được xác nhận trong QA root nêu trên. Các event alias và response legacy vẫn có regression coverage. Giới hạn generic action của The Gang tiếp tục được trả rõ bằng `GAME_ACTION_UNSUPPORTED`; gameplay The Gang giữ các event lịch sử.
