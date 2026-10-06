# C01 — Sảnh nhóm và chuyển bàn đồng thuận

Ngày: 06/10/2026.

## Đã thêm

- `src/platform/groupLobbyService.js` giữ nhóm và capability trong bộ nhớ, tạo mã mời/capability ngẫu nhiên, giới hạn số ghế theo registry, và buộc mọi người xác nhận cùng proposal revision trước khi chuyển. Profile chỉ có thể thuộc một nhóm hoạt động. Thay thành viên, mất kết nối, đổi host hoặc proposal mới làm mất consent cũ.
- Host chọn game, variant và cấu hình từ allowlist/validator của registry hiện tại. Hai biến thể UNO được ghi rõ (`classic-local-v1`, `classic-108-v1`); cả hai mở đúng adapter/manager hiện có. Bàn đích là private. Bàn cũ đang chạy được giữ nguyên và chuyển bị chặn. Poker chỉ được cash-out qua luồng `gm.leaveRoom` hiện có sau khi reservation ID của manager khớp chính xác các khoản HELD trong cùng `ProfileStore`; mismatch hoặc lỗi chặn trước khi sửa bàn.
- Chuyển đích dùng operation ID ổn định theo group/proposal, tra ghế bằng profile identity và tiếp tục retry sau ACK thất lạc mà không tạo bàn/ghế trùng. Sau khi xác minh đủ roster, ghế manager được nhả khỏi socket hiện tại để từng người vào lại bằng credential riêng của họ. Credential chỉ trả cho profile thành viên tương ứng; response lobby không trả room code hoặc seat token.
- `src/platform/groupLobbyRouter.js` cung cấp API có xác thực `ProfileService` qua `X-Profile-Token`/Bearer và capability riêng qua `X-Group-Capability`. API gồm tạo nhóm, vào nhóm, đọc trạng thái, xoay invite, proposal, confirm, switch, handoff, heartbeat, disconnect, chuyển host và rời nhóm. Body không được dùng làm nguồn profile ID, tên hay avatar.
- `public/group-lobby.html`, `public/js/group-lobby.js`, `public/css/group-lobby.css` thêm sảnh responsive. Trang chỉ cho host đề xuất game; mọi thành viên thấy chính xác variant/cấu hình và tự xác nhận. Mỗi thành viên tự bấm vào bàn mới khi sẵn sàng; client lưu đúng credential vào key legacy mà trang game hiện có đọc, đồng thời giữ tương thích các route và room code cũ.

## Hợp đồng tích hợp C08

- `GroupLobbyService.getTrustedGroupSnapshot(groupId)` trả `null` nếu nhóm không còn hoạt động; nếu có, trả snapshot frozen gồm `groupId`, `revision`, `membershipRevision`, `hostProfileId`, `participantProfileIds`, `members[{profileId,displayName,joinOrder,isHost,connected}]`, `targetParticipantProfileIds`, `targetMembers[{profileId,displayName,joinOrder}]`, proposal `{id,revision,status,target}`, `currentTargetRoomCode`, `roomBinding`, `transitionStatus` và `expiresAt`. Đây là trusted server-side API; không serialize snapshot này trực tiếp ra client.
- `roomBinding` lấy từ manager thật và gồm `roomCode`, `gameId`, `variant`, `matchId`, `participants`, `phase` và trạng thái terminal. Khi switch hoàn tất, service kiểm tra room/variant và danh sách participants khớp toàn bộ profile roster trước khi chốt.
- Server nhận `options.groupMembershipLocked(groupId)`; trả `true` hoặc `{locked:true, code?, message?}` sẽ khóa join/leave/chuyển host khi một giải C08 đang ghim roster. Gọi `service.setMembershipLockChecker(fn)` sau khởi tạo cũng được hỗ trợ.
- Server nhận `options.bindGroupTargetRoom(context)` hoặc service `setTargetBindingHandler(fn)`. Sau khi manager xác minh đủ seats, callback nhận `{operationId,groupId,groupRevision,membershipRevision,hostProfileId,members,proposalId,target,roomBinding}` để C08 lưu liên kết idempotent. Callback được await trong lúc group transition lock đang giữ; triển khai phải idempotent theo `operationId` và không gọi ngược `getTrustedGroupSnapshot` cho cùng group.

## Hook server và C07

- `src/httpServer.js` mount `/api/groups` sau JSON parser và C05 admin gate, phục vụ `/group-lobby`, nối adapter/lifecycle với manager thật, giữ maintenance/storage authorization hooks hiện có và đóng `GroupLobbyService` khi server đóng.
- Portal thêm đường dẫn sảnh nhóm. C07 mount `attachSpectatorSupport(app, io, gm)` và nút portal xem phòng là additive; không đổi quyền trong manager, profile hoặc gameplay. C07-owned service/client/browser-check vẫn thuộc C07.

## Xác minh

- `node --check` cho service, router, server, client, browser check và test: đạt.
- `node --test test/groupLobby.test.js`: **13/13 đạt** trên suite đầy đủ, gồm manager thật cho hai UNO variant, các kiểm tra ledger, API HTTP và Socket.IO đã mount.
- `node --test --test-name-pattern="group switch|capacity|membership|active coin|Poker|lost join|target authorization|HTTP router|tournament lock" test/groupLobby.test.js`: **12/12 đạt**, gồm hai UNO variant, capacity/minimum, stale consent, khóa C08, bảo toàn coin hand, poker cash-out/reservation guard, retry, authorization và profile resolver.
- `node --test --test-name-pattern="mounted HTTP and authenticated Socket.IO flow" test/groupLobby.test.js`: **1/1 đạt** sau khi fixture sort bản sao vì `roomBinding.participants` là mảng frozen. Test dùng server tạm, hai profile/token thật, xác nhận chống spoof/stale capability, tạo đúng một bàn UNO 108, privacy của từng handoff và binding manager.
- `node scripts/group-lobby-browser-check.js`: **đạt** với production server tạm, SQLite/room files tạm, hai profile, flow invite/consent/switch/handoff và resume trên UNO thật, layout 320/390px, không tràn ngang, không lỗi trang hoặc request ngoài.

Không dùng hồ sơ/database/phòng người chơi thật. Chưa commit, push hoặc deploy.

## Nghiệm thu bổ sung tại coordinator — 06/10/2026 09:00 Asia/Saigon

`node --test test/groupLobbyTargets.integration.test.js` đạt **9/9**: một nhóm bốn hồ sơ, Socket.IO thật, chuyển lần lượt The Gang → UNO 112 → UNO 108 → Tiến lên → Poker → Sâm lốc → Phỏm → BANG!. Mỗi bàn chỉ có một phòng, đúng bốn hồ sơ, bốn credential riêng được resume qua socket thật; các bàn cũ rỗng được đóng. Số dư không đổi, không có HELD và không thêm ledger do chuyển phòng chờ.

Log: `test-results/resume-c01-eight-targets-20261006.log`, `test-results/resume-c01-integration-20261006.log`, `test-results/resume-c01-browser-20261006.log`. Tổng scoped C01 gồm 13 + 9 test đều đạt; product browser cũng đạt. Nhả các file shared cho tích hợp C08 tại coordinator.
