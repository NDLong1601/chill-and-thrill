# Bộ prompt triển khai cổng game LAN

Bộ này tương ứng kế hoạch M0–M7 tại [kế hoạch chương trình](../ke-hoach-cong-game.md).
Các prompt là yêu cầu cho những lượt triển khai sau; việc tạo bộ prompt chưa triển khai các mốc.

## Cách dùng

1. Mở chat có workspace C:\Users\PC\Documents\the-gang.
2. Dùng lần lượt M0 → M1 → M2 → M3 → M4 → M5 → M6A → M6B → M6C → M7.
3. Dán toàn bộ nội dung một file prompt vào chat. Hoặc nhắn: “Đọc và thực hiện toàn bộ prompt trong docs/prompts/<tên-file>. Chỉ triển khai mốc này.”
4. Mỗi file đã có bối cảnh chung, yêu cầu riêng và cách bàn giao; không cần ghép thêm prompt nền.
5. Nếu dùng chat mới, giữ cùng workspace và yêu cầu đọc tài liệu bàn giao trước. Tiếp tục trong chat cũ cũng được.
6. Chỉ chuyển sang mốc tiếp theo khi phần tiền đề đã đạt hoặc đã ghi rõ ảnh hưởng của phần chưa đạt. Không chạy đồng thời các mốc sửa chung nền tảng/phòng/ví.
7. M6 được tách thành ba lần triển khai vì mỗi game có engine và bộ luật riêng. M7 vẫn là kiểm tra tích hợp cuối, không thay cho kiểm thử từng mốc.

## Danh sách

| Prompt | Kết quả mong đợi |
|---|---|
| [M0](M0-thiet-ke-va-khao-sat.md) | M0 — Khảo sát, đặc tả và thiết kế |
| [M1](M1-trang-chu-va-nen-tang.md) | M1 — Trang chủ hai chế độ và nền tảng nhiều game |
| [M2](M2-uno.md) | M2 — UNO và hoàn thiện cơ chế thêm game |
| [M3](M3-ho-so-vi-nhiem-vu.md) | M3 — Hồ sơ, SQLite, ví chip và nhiệm vụ |
| [M4](M4-tien-len.md) | M4 — Tiến lên và game Kịch tính đầu tiên |
| [M5](M5-poker.md) | M5 — Poker Texas Hold’em No-Limit |
| [M6A](M6A-sam-loc.md) | M6A — Sâm lốc |
| [M6B](M6B-phom.md) | M6B — Phỏm |
| [M6C](M6C-bang.md) | M6C — BANG! bộ cơ bản |
| [M7](M7-kiem-thu-va-ban-giao.md) | M7 — Kiểm thử tích hợp, ổn định LAN và bàn giao |

## Các mặc định đã ghi trong prompt

- M0 chỉ thiết kế, tài liệu và prototype; M1 trở đi triển khai thật.
- Một server LAN, thiết bị riêng cho mỗi người; bot chưa thuộc phạm vi.
- Giữ stack hiện có, tách module vừa đủ, SQLite trước khi bật kinh tế.
- Game chưa làm không được giả lập thành “chơi được”.
- Không cần chờ xác nhận các chi tiết triển khai thông thường.
- Luật vùng miền được đặc tả thành biến thể rõ ràng; luật còn mơ hồ không được âm thầm đoán trong engine.
- Tiến lên bản đầu đề xuất mức góp cố định/người và người thắng nhận pot; đó là luật chip local, không tự kèm phạt tài chính.
- Poker xử lý cả all-in, side pot và cash-out.
- Nhiệm vụ chỉ nhận sự kiện được server xác nhận; dữ liệu chip có transaction và chống xử lý trùng.
- Báo cáo mỗi mốc ở docs/milestones; bằng chứng test không được suy đoán.

## Prompt tiếp tục khi một mốc đang dở

Dùng nội dung sau, thay Mx bằng mốc đang làm:

> Tiếp tục hoàn thành mốc Mx trong dự án này. Đọc prompt gốc tại docs/prompts và tài liệu bàn giao tương ứng tại docs/milestones, kiểm tra code thực tế và thay đổi hiện có. Tiếp tục từ công việc đã hoàn thành, không viết lại từ đầu hoặc ghi đè thay đổi của tôi. Ưu tiên phần còn thiếu/lỗi kiểm thử theo tiêu chí nghiệm thu của mốc; chỉ chạy lại kiểm tra cần thiết sau thay đổi. Cập nhật bàn giao bằng kết quả thực tế. Chưa triển khai mốc tiếp theo.

## Prompt rà soát trước khi chuyển mốc

> Rà soát mốc vừa hoàn thành theo prompt gốc và tiêu chí nghiệm thu. Đối chiếu yêu cầu với code, UI, lưu trữ và kiểm thử thực tế. Tìm phần bị bỏ sót, dữ liệu giả, nút chưa hoạt động, lỗi quyền xem bài, reconnect và chip nếu liên quan. Sửa các lỗi thuộc phạm vi mốc, kiểm tra lại phù hợp và cập nhật tài liệu bàn giao. Báo rõ phần chưa thể xác minh; không bổ sung tính năng ngoài mốc.

