# M0 — Ma trận nghiệm thu và backlog M1–M7

> M0 chỉ tạo tài liệu/prototype. Các tiêu chí dưới đây là điều kiện chuyển mốc; “đã thiết kế” không được tính là “đã chạy được”.

## 1. Thứ tự ưu tiên

| Ưu tiên | Kết quả |
|---|---|
| P0 | Platform chung, The Gang adapter, UNO, profile/SQLite/wallet/mission, Tiến lên local v1, reconnect và kiểm thử LAN |
| P1 | Poker, Sâm lốc, Phỏm, BANG! bộ cơ bản, hướng dẫn/analytics theo game |
| P2 | Bot, giữ nhóm khi đổi game, tournament, khán giả, export/import profile, one-click packaging |

Bản đầu người chơi sử dụng được theo thứ tự: M1 The Gang qua shell → M2 thêm UNO → M3 profile/ví/nhiệm vụ → M4 Tiến lên. Không gọi Poker/Sâm/Phỏm/BANG! là chơi được trước mốc tương ứng.

## 2. Backlog theo mốc

| Mốc | Đầu vào | Đầu ra bắt buộc | Phụ thuộc | Acceptance criteria kiểm tra được | Rủi ro/giảm thiểu |
|---|---|---|---|---|---|
| M1 — Home/platform | M0 docs; The Gang hiện tại; registry contract | Home/category/detail/room routes; `gameRegistry`; room/seat adapter; The Gang chạy qua shell; legacy `/?room=` | M0 | 1) Tạo/vào/reconnect The Gang qua UI mới. 2) Room chỉ có `the-gang`. 3) Back/forward/reload/deep link không lộ private state. 4) Test cũ pass. 5) Game chưa làm bị khóa. | Gộp room và luật hiện tại; tách adapter, giữ event bridge + contract tests |
| M2 — UNO | M1 platform | `uno` module, private hand, draw/play/Wild/UNO, waiting/table components | M1 | 2 phòng UNO độc lập không lẫn state; mọi action server-side; duplicate/stale action an toàn; resume; test rules/private redaction | Biến thể UNO mơ hồ; chốt `classic-local-v1` trước code |
| M3 — Profile/wallet/mission | M1 room identity; data schema | SQLite migrations; profile/session; reservation/ledger; mission progress/claim; migration report từ JSON | M1; ưu tiên sau M2 có thể song song engine | Tạo profile; restart/reconnect; không âm chip; cùng chip không giữ 2 room; claim lặp một lần; ledger/mission atomic; backup/restore smoke test | Transaction sai giữa match và ví; dùng temp DB/fault injection, không reset dữ liệu thật |
| M4 — Tiến lên | M3 wallet; shared room/game shell | `tien-len/south-v1`; actions/timer/result/settlement; rules doc + tests | M3 | Chơi trọn ván 4 người; đánh tổ hợp/chặn/bỏ lượt đúng decision table; max-loss reservation; kết quả chip đối soát; reconnect/restart | Luật vùng miền; khóa tới trắng/đền/thối ngoài variant đầu |
| M5 — Poker | M3 wallet; shared table; evaluator đã audit | Hold'em NL; blind/stack/pot/side-pot/all-in/tie/cash-out | M3; M4 components có thể tái dùng | Main/side pot đúng; all-in/raise/tie; settlement bảo toàn chip; disconnect timeout; restart khôi phục snapshot; private cards lọc | Nhiều trường hợp side pot; property tests và deterministic fixtures |
| M6A — Sâm lốc | M2 room/components; M3 wallet | `sam-local-v1`; rules/test/guide | M3 | Chỉ bật sau khi chốt báo Sâm/chặn/đền/max-loss; chơi trọn ván và thanh toán có test | Nhầm với Tiến lên; decision table riêng |
| M6B — Phỏm | M2 room/components; M3 wallet | `phom-local-v1`; draw/eat/discard/layoff/scoring | M3 | Ù/móm/ăn chốt/đền/gửi bài và hòa có test; settlement bounded | Luật địa phương; không bật kinh tế trước khi tính cận trên |
| M6C — BANG! | M1 room/private transport; M3 nếu có chip | `bang/base-local-v1`; role redaction/action windows | M1, M3 tùy economy | Vai ẩn không leak qua state/log/reconnect; phản ứng ngoài lượt đúng timeout; phe thắng đúng rules doc | Phạm vi bộ cơ bản lớn; cắt expansion, fixture privacy |
| M7 — LAN/release | Tất cả game đã đánh dấu playable | Multi-device test, backup/restore runbook, package, performance/accessibility fixes, final handover | Các mốc playable | Không Internet sau cài; máy chủ + điện thoại thật cùng WiFi; reload/disconnect/restart; không private leak; logs/runbook; test suite pass | Chưa có bằng chứng thiết bị thật ở M0; lập test matrix theo thiết bị |

## 3. Acceptance chung cho mọi game

### Engine và transport

- Server là nguồn sự thật; client chỉ gửi action envelope.
- `actionId` gửi lại không tạo thay đổi lần hai.
- `expectedRevision` cũ trả lỗi rõ và state mới.
- Action ngoài lượt, ngoài room hoặc ngoài variant bị từ chối.
- Timeout do server có receipt/revision riêng.

### Bí mật

- Bài/vai/insight/seed/hand của người khác không xuất hiện trong payload, log, lịch sử hay error.
- Reconnect cấp đúng view theo profile/seat.
- Game đã kết thúc mới reveal những phần mà ruleset cho phép.

### Ví và nhiệm vụ (khi `usesWallet=true`)

- `available`, `reserved`, `in_game` phân biệt trong data và audit.
- Không âm chip; không hai reservation cùng nguồn.
- Match result, reservation, ledger, mission event cùng transaction.
- Restart ở trước/sau commit không tạo double settlement.
- Claim một nhiệm vụ nhiều lần chỉ cấp một ledger entry.

### UI

- Portrait home/category/detail/room dùng được; không bắt xoay ở home.
- Landscape/desktop không cắt CTA; control chính ≥44px.
- Có loading, empty, error, offline, insufficient chips, coming soon.
- Deep link, legacy link, back/forward, phòng hết hạn và profile chưa tạo đều có thông báo tiếng Việt dễ hiểu.

## 4. Test matrix đề xuất

| Lớp | Test mẫu | Khi chạy |
|---|---|---|
| Unit game | state transition, legal actions, scoring, timeout | Mỗi module trước integration |
| Property/invariant | deck unique, no negative wallet, conservation, idempotency | M2–M7 |
| Integration socket | create/join/ready/action/revision/reconnect/host | M1 trở đi |
| Persistence | restart, migration, backup/restore, unreadable source | M3/M7 |
| Privacy | per-profile snapshot, no hidden card/role/token | M1, mỗi game mới |
| Browser | routes, empty/loading/error, mobile portrait/landscape/desktop | M1, M7 |
| LAN device | real phone/tablet/desktop cùng WiFi, mất WiFi, rotate | M7; chưa xác minh ở M0 |

## 5. Definition of done cho mốc

Một mốc chỉ được đóng khi:

1. Chức năng đi hết luồng UI → server → storage (nếu có) → kết quả.
2. Có test phù hợp và giữ test hồi quy trước đó.
3. Có rules/config version và không có nút fake/TODO ở đường chơi.
4. Có ghi rõ phần chưa kiểm tra, cách khôi phục và rủi ro còn lại trong `docs/milestones/Mx.md`.
5. Không kích hoạt mốc kế tiếp để che thiếu sót của mốc hiện tại.

## 6. Tiêu chí kết thúc M0

- [x] Đã đọc entry point, HTTP/Socket, room/game, UI, persistence, test và script browser.
- [x] Đã lập bản đồ public/private, identity, events, reconnect và chip separation.
- [x] Đã phác thảo routes, flows, module contract, SQLite và migration.
- [x] Đã ghi default/open decisions cho bảy game.
- [x] Đã tạo prototype HTML/CSS/JS dữ liệu minh họa trong `docs/design`.
- [x] Đã ghi baseline test thực tế trong `docs/milestones/M0.md`.
- [ ] Chưa phải nghiệm thu M1; production route/registry/wallet chưa được bật.
