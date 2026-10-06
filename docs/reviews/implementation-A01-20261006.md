# A01 — Snapshot và ledger cho Tiến lên, Sâm lốc, Phỏm

Ngày triển khai: 06/10/2026.

## Hành vi

Ba engine ghi snapshot phòng SQLite trong cùng transaction với khoản giữ, hoàn, settlement, kết quả ván, thao tác phòng và tombstone đóng phòng. Chỉ sau khi transaction commit, engine mới gửi event socket hoặc thực hiện join/leave phòng. Nếu ghi snapshot hay commit lỗi, engine khôi phục room và ánh xạ socket trong bộ nhớ, SQLite rollback cả ledger, rồi trả lỗi thay vì báo thao tác thành công. Lỗi bị engine con bắt lại trong `startGame`/`playAgain` vẫn làm hủy transaction ngoài.

SQLite là nguồn phục hồi ưu tiên. JSON hiện có tiếp tục được đọc khi chưa có snapshot SQLite và tiếp tục được ghi làm bản tương thích; lỗi export JSON không đảo ngược một commit SQLite thành công. Tombstone đóng trong cùng transaction ngăn JSON cũ hồi sinh phòng. Hết hạn vẫn hoàn các reservation `HELD` và đóng snapshot trong cùng transaction.

Tiến lên đưa `maxLoss` bằng `stake` vào state server để UI dùng đúng mức giữ. Công cụ đối chiếu A01 mặc định mở SQLite chỉ đọc; báo HELD cùng snapshot, room mirror, room JSON cũ và match. Chế độ `--refund-safe` chỉ hoàn khi có tombstone SQLite hợp lệ, không có match hoàn tất, snapshot/room mirror không hoạt động và không có phòng legacy đang chơi. Snapshot hỏng, thiếu hoặc dữ liệu mâu thuẫn cần kiểm tra thủ công.

Chạy đối chiếu chỉ đọc:

```powershell
node scripts/audit-a01.js C:\path\to\chill-and-thrill.sqlite
```

Khi cần đối chiếu thêm JSON ở đường dẫn riêng, truyền `--tien-len-json=...`, `--sam-loc-json=...` hoặc `--phom-json=...`. Chỉ bật hoàn các trường hợp an toàn sau khi đọc báo cáo bằng `--refund-safe`.

## File triển khai

- `src/platform/coinRoomTransactions.js`: transaction chung, phục hồi room khi lỗi và trì hoãn event socket.
- `src/platform/completedRoom.js`: nạp SQLite snapshot trước JSON cũ và tôn trọng tombstone.
- `src/platform/profileStore.js`: chế độ mở chỉ đọc và đối chiếu/hoàn reservation an toàn.
- `src/games/tien-len/tienLenEngine.js`, `src/games/sam-loc/samLocEngine.js`, `src/games/phom/phomEngine.js`: cài transaction chung sau đồng hồ lượt; Tiến lên công bố `maxLoss`.
- `scripts/audit-a01.js`: CLI đối chiếu A01.
- `test/audit-a01.test.js`: regression lỗi ghi/commit, crash, thanh toán và đối chiếu.

## Kiểm thử đã chạy

- `node --test test/audit-a01.test.js`: 25/25 đạt. Gồm lỗi JSON, lỗi ghi snapshot, lỗi lệnh `COMMIT`, lỗi shuffle sau khi giữ coin, lỗi settlement tới trắng bị `startGame` bắt lại, lỗi settlement từ action kết thúc ván, settlement idempotent và bảo toàn tổng coin trên cả ba game.
- Child process cho từng game dừng trước khi ghi snapshot, sau khi ghi snapshot nhưng trước commit, và sau commit nhưng trước export JSON. Restart phục hồi đúng trạng thái WAITING/coin chưa giữ hoặc trạng thái ván/coin đã giữ theo ranh giới SQLite.
- `node --test test/review-regressions.test.js`: đạt cùng regression expiry/tombstone và recovery hiện có.
- `npm test`: 172/172 đạt trên toàn bộ bộ kiểm thử Node, gồm A02 và các regression game/hồ sơ.
- `npm run test:tien-len-browser`, `npm run test:sam-loc-browser`, `npm run test:phom-browser`: cả ba đạt. Bàn host/guest vào và bắt đầu ván; các luồng browser không báo lỗi JavaScript hoặc lỗi mạng ngoài server.
- `maxLoss` Tiến lên được kiểm tra trực tiếp qua state server.

## Giới hạn

Công cụ tự hoàn có chủ đích bảo thủ: khoản HELD thiếu tombstone đóng hợp lệ hoặc còn bất kỳ nguồn phòng đang hoạt động nào sẽ chỉ được liệt kê, không tự sửa. Không kiểm tra thiết bị thật/WiFi thật. Không sửa pokerEngine, portal hoặc chính sách reconnect.
