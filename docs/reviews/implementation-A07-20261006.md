# A07 — Giới hạn stake và sức chứa ví thanh toán

Ngày triển khai: 06/10/2026.

## Hành vi

- `validateAmount(value, currency = 'chip')` dùng giới hạn riêng của chip, coin và gem. Các API giữ tiền không truyền currency tiếp tục dùng chip như trước; giữ coin dùng trần coin 10¹², không còn bị áp trần chip 10⁹.
- `gameRegistry` tính stake tối đa theo số ghế cấu hình. Metadata `/api/registry` công bố `stakeRules` gồm đơn vị, mức mặc định, mức tối thiểu và các giới hạn theo từng số người (`maxStake`, `holdFactor`, `maxLossFactor`, `maxNetGainFactor`, `grossPayoutFactor`). Client lấy các giá trị này từ registry.
- Trước khi Tiến lên, Sâm lốc hoặc Phỏm giữ tiền, `ProfileStore.preflightFixedGameStart` kiểm tra mức cược, từng người chơi đủ khoản giữ, cột khoản giữ còn chỗ, các phép nhân/tổng vẫn là safe integer, và mọi ghế có thể nhận mức thắng tối đa mà không vượt trần ví coin.
- Ví có coin đang giữ bảo toàn sức chứa cho lần hoàn/thanh toán đó. Thưởng nhiệm vụ, quy đổi gem sang coin và mọi khoản cộng coin khác bị chặn nếu sẽ chiếm phần headroom đã bảo vệ. `walletCreditCapacity(profileId, 'coin')` trả `{ currency, max, available, protectedCredit, remaining }`; B03 có thể dùng `remaining` làm sức chứa nhận coin trong quote quy đổi. Các khoản giữ coin cũ/không nhận diện được bảo vệ tối thiểu bằng giá trị cần hoàn.
- Settlement và release từ chối tập reservation có nhiều currency trước khi sửa ví. Tổng pot, tổng delta và các khoản cộng được kiểm tra safe integer. Đường hoàn/thanh toán đóng chính khoản giữ trong cùng transaction A01 và vẫn kiểm tra trần ví.

Giới hạn theo luật server hiện có:

| Game | Giữ tối đa mỗi ghế | Mức lời ròng tối đa dùng cho preflight | Cận khoản thanh toán tối đa dùng để giới hạn stake |
|---|---:|---:|---:|
| Tiến lên | `stake` | `(số ghế − 1) × stake` | `số ghế × stake` pot |
| Sâm lốc | `2 × (số ghế − 1) × stake` | `max(2 × (số ghế − 1), số ghế) × stake`, gồm phạt “báo một” | Khoản giữ + mức lời ròng tối đa |
| Phỏm | `6 × (số ghế − 1) × stake` | Tổng khoản giữ của các đối thủ, theo cận settlement zero-sum đã lưu | Khoản giữ + mức lời ròng tối đa |

Các cận này chỉ bảo vệ giữ tiền, payout hiện có và sức chứa ví; không thay đổi luật hoặc tỷ lệ thắng/thua. Tiền cược vẫn được lưu nguyên dạng coin/chip của hồ sơ hiện tại, không tạo ví/database mới.

## File triển khai

- `src/platform/currencies.js`: validator dùng chung theo đơn vị tiền.
- `src/platform/gameRegistry.js`: giới hạn stake theo game/số ghế và metadata registry công khai.
- `src/platform/profileStore.js`: validator tương thích chip, preflight, sức chứa payout đang giữ, giới hạn số học và kiểm tra settlement/release đồng nhất currency.
- `src/games/tien-len/tienLenEngine.js`, `src/games/sam-loc/samLocEngine.js`, `src/games/phom/phomEngine.js`: truyền số ghế cấu hình vào validator và preflight trước khi giữ coin.
- `test/audit-a07.test.js`: regression riêng dùng SQLite, room file và profile tạm.
- `test/table-flow.test.js`, `test/uno-classic.test.js`: ổn định hai fixture ngẫu nhiên làm full suite có thể báo sai trạng thái. Tiến lên dùng thứ tự identity trong kiểm tra replay để không kích hoạt tới trắng ngoài mục tiêu. Socket UNO kiểm tra đúng chủ ghế 7 lá/người kế tiếp 9 lá khi top là Draw Two; thêm ca engine seed cố định chứng minh phân phối `[7, 9]`. Không đổi engine hoặc luật UNO.

Không sửa route/quote/stylesheet B03 hoặc stake UI A05. Contract nối B03 là `ProfileStore.walletCreditCapacity(profileId, 'coin')`; quote nhận coin nên giới hạn phần credit theo `remaining`, đồng thời vẫn tính nguồn gem và số dư gem theo cận hiện tại. Client stake A05/B01 đọc `/api/registry` → `games[].stakeRules.limitsByPlayerCount[maxPlayers]`, không tự tính cận.

## Kiểm thử đã chạy

- `node --test test/audit-a07.test.js`: **19/19 đạt**. Bao gồm min/max/max+1 từng currency và từng game/số ghế; mức tối đa với số người thực và cấu hình tối đa; ví thiếu tiền; overflow/rollback; settlement/release không trộn currency; credit nhiệm vụ/quy đổi khi đang giữ; và thanh toán pot đến đúng trần ví.
- `node --test test/audit-a07.test.js test/table-flow.test.js test/uno-classic.test.js`: **42/42 đạt** sau khi cố định hai fixture.
- Tái hiện audit Tiến lên: stake **2.000.000.000 coin**, hai ví fixture **3.000.001.000 coin**; cả hai giữ tiền và bàn bắt đầu.
- `npm test`: **199/199 đạt** ở lần chạy cuối, gồm hồi quy A01/A02, ProfileStore, các game, quy đổi B03 và portal integration.
- Root cause của lần full suite thất bại đầu: replay test Tiến lên dùng xáo bài ngẫu nhiên dù assertion yêu cầu hand kế tiếp còn hoạt động; một deal tới trắng hợp lệ làm phòng ở `RESULT`. Fixture replay nay deterministic. Root cause UNO112: test gán 9 lá cho ghế chủ khi top là Draw Two, trong khi engine đúng luật phát 2 lá cho ghế kế tiếp. Test nay kiểm tra đúng 7/9 theo ghế; thêm fixture seed ổn định xác nhận nhánh Draw Two.

## Giới hạn

- Chưa chạy browser suite trong lượt A07 vì không sửa UI; browser portal và bàn game đã có baseline đạt trong phạm vi các lượt liên quan. Registry được kiểm tra trực tiếp bằng test Node.
- B03 cần dùng `walletCreditCapacity(...).remaining` trong quote quy đổi coin đích để UI không báo mức cao hơn mức server chấp nhận khi một ván đang giữ coin.
- Bộ kiểm thử browser không mô phỏng thiết bị thật hoặc tải nhiều phòng.
