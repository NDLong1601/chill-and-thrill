(function (root, factory) {
  const content = factory();
  if (typeof module === 'object' && module.exports) module.exports = content;
  if (root) root.ChillTutorialContent = content;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GUIDE_CATALOG = [
    { gameId: 'the-gang', variant: 'base-v1', title: 'The Gang', rules: 'Hợp tác xếp hạng bài qua chip màu; chip này không phải tiền trong ví.', steps: [
      'Ở Pre-Flop, Flop, Turn hoặc River, lấy chip của màu vòng hiện tại để biểu thị mức tự tin về bài của bạn. Nếu đang có chuyên gia chờ, hoàn tất bước của chuyên gia trước.',
      'Dùng “Chốt chip” sau khi đã chọn. Nếu chip chưa khóa, bạn có thể đổi lựa chọn; mọi lần đổi làm các xác nhận cũ mất hiệu lực.',
      'Chủ phòng chỉ chuyển vòng khi mọi người đã chọn và chốt chip. Chỉ ghế của bạn thấy bài riêng; chip, bài và insight của người khác vẫn bị che theo luật.',
      'Ở Showdown, cùng thống nhất dự đoán nếu thử thách yêu cầu, rồi chủ phòng lật kết quả. Hãy đọc phản hồi của bàn trước khi tiếp tục.' ] },
    { gameId: 'uno', variant: 'classic-local-v1', title: 'UNO 112 · classic-local-v1', rules: '112 lá, 2–4 người; không cộng dồn phạt. Hai người chơi vẫn dùng luật Reverse như Skip.', steps: [
      'Đánh một lá khớp màu, số hoặc biểu tượng của lá trên cùng; Wild luôn có thể đánh. Có thể rút dù đang có lá đánh được.',
      'Sau khi rút, chỉ lá vừa rút được đánh trong lượt đó; nếu không đánh thì kết thúc lượt. Phạt +2 được rút đủ 2 lá, không được chồng phạt.',
      'Khi còn một lá sau lượt đánh, dùng “Gọi UNO” trong cửa sổ. Người khác có thể “Bắt lỗi UNO” nếu cửa sổ vẫn mở.',
      'Khi bị +4, chỉ ghế bị tác động chọn rút 4 hoặc phản đối. Server kiểm tra riêng bài của người đánh; không suy đoán tay bài đối thủ.' ] },
    { gameId: 'uno', variant: 'classic-108-v1', title: 'UNO 108 · classic-108-v1', rules: '108 lá, 2–6 người; bản này dùng engine/action riêng từ UNO 112.', steps: [
      'Đánh theo màu, số hoặc biểu tượng; Wild yêu cầu chọn một trong bốn màu. Chọn màu ngay trong thao tác đánh.',
      'Nếu rút được lá đánh được, chỉ lá vừa rút mới có thể đánh. +2/+4 không cộng dồn; người nhận xử lý phạt theo nút của bàn.',
      'Gọi UNO trước khi đánh lá áp chót. Nếu quên, người khác có thể bắt lỗi trong cửa sổ 12 giây.',
      'Khi bị Wild Draw Four, chấp nhận rút 4 hoặc phản đối. Kết quả đúng/sai do server xác định và không tiết lộ tay bài người đánh.' ] },
    { gameId: 'tien-len', variant: 'south-v1', title: 'Tiến lên miền Nam · south-v1', rules: 'Bàn local 2–4 người, 13 lá/người; luật chặt/tới trắng đúng theo phiên bản đã công bố.', steps: [
      'Lượt mở đầu phải chứa lá thấp nhất được chia cho chính bạn. Sau đó, khi dẫn vòng, chọn một tổ hợp hợp lệ.',
      'Khi có bài trên bàn, chỉ đánh cùng loại và cùng số lá với giá trị cao hơn, hoặc một cách chặt được luật cho phép; nếu không muốn/không thể đè, bỏ lượt.',
      'Sau khi tất cả người khác bỏ, người đánh cuối dẫn vòng mới. Người đã bỏ không trở lại vòng đó.',
      'Không tự cộng phạt thối/cóng/đền: các luật đó không thuộc south-v1. Server kiểm tra tổ hợp, lá thuộc tay và thứ tự lượt.' ] },
    { gameId: 'poker', variant: 'holdem-nl-v1', title: 'Poker Texas Hold’em · holdem-nl-v1', rules: 'No-Limit 2–6 ghế, blind 5/10 chip; “tổng cược đến” là tổng trong vòng cược.', steps: [
      'Đọc số chip cần theo trên bàn. Nếu bằng 0, có thể check; nếu lớn hơn 0, chọn call để theo, raise hợp lệ hoặc fold.',
      'Bet chỉ dùng khi vòng chưa có cược. Raise phải cao hơn cược hiện tại và đạt mức tăng tối thiểu; all-in ngắn có thể hợp lệ nhưng không luôn mở lại quyền tố.',
      'Fold bỏ quyền thắng pot, không lấy lại chip đã đặt. Call chỉ theo bằng stack còn lại nếu bạn không đủ mức đầy đủ.',
      'Server giữ bài riêng, lượt, minimum raise, pot và kết quả. Hãy dựa vào mục “Hành động hợp lệ” của ghế bạn, không suy từ bài kín đối thủ.' ] },
    { gameId: 'sam-loc', variant: 'local-v1', title: 'Sâm lốc · local-v1', rules: 'Bàn 2–5 người, 10 lá/người; không chặt riêng và không phạt thối 2.', steps: [
      'Ngay sau khi chia, mỗi ghế chọn “Báo Sâm” hoặc “Không báo” trong cửa sổ. Mỗi ghế chỉ trả lời một lần; hết giờ được tính là không báo.',
      'Nếu bạn Báo Sâm, bạn mở lượt. Báo thành công khi bạn đánh hết 10 lá; nếu bỏ khi cần đè hoặc người khác hết bài trước thì Báo Sâm thất bại.',
      'Trong ván thường, lượt mở đầu phải chứa lá thấp nhất được chia. Đè bài cùng loại/cùng độ dài bằng giá trị cao hơn; đồng giá trị không đè nhau.',
      'Nếu không đè được, bỏ lượt khi không phải người dẫn. Không suy diễn luật chặt hoặc phạt 2: chúng không có trong local-v1.' ] },
    { gameId: 'phom', variant: 'local-v1', title: 'Phỏm · local-v1', rules: 'Bàn 2–4 người; bộ là 3–4 lá cùng giá trị, dây là ít nhất 3 lá liên tiếp cùng chất.', steps: [
      'Trong lượt, chọn bốc từ nọc hoặc ăn đúng lá vừa đánh nếu nó tạo phỏm cùng lúc. Lá ăn bắt buộc phải nằm trong phỏm khi hạ.',
      'Sau khi bốc/ăn, đánh một lá hợp lệ. Không đánh lá đã ăn hoặc làm các lá ăn không còn tạo được phỏm.',
      'Khi bàn chuyển sang hạ, chọn các phỏm không chồng lấn; server bắt buộc giữ đủ mọi lá đã ăn trong phỏm.',
      'Sau khi hạ, có thể gửi lá rác vào phỏm công khai của người hạ trước nếu thêm vào vẫn tạo bộ/dây hợp lệ. Không gửi vào tay kín hay phỏm của chính mình.' ] },
    { gameId: 'bang', variant: 'base-4th-edition-v1', title: 'BANG! · bộ cơ bản Fourth edition', rules: 'Bản local chỉ dùng bộ cơ bản; mỗi lượt rút 2, chơi bài hợp lệ, rồi bỏ xuống bằng số máu.', steps: [
      'Đầu lượt xử lý Dynamite rồi Jail theo trạng thái bàn; sau đó rút bài. Lá kiểm tra riêng của Lucky Duke có thể cho chọn kết quả.',
      'Trong lượt chính, xem tầm và khoảng cách công khai trước khi dùng BANG!. Thường chỉ một BANG! mỗi lượt, trừ Volcanic hoặc Willy the Kid.',
      'Khi có pending effect, lượt chính dừng. Chỉ ghế được chỉ định trả lời: dùng lá chặn hợp lệ hoặc nhận hiệu ứng; với Slab the Killer cần hai Missed!.',
      'Beer hồi 1 máu trong lượt khi bạn chưa đầy máu; khi đang mất máu cuối, Beer là lá duy nhất có thể tự cứu. Beer không có tác dụng khi còn đúng hai người sống. Khi kết thúc lượt, bỏ đến khi số bài không vượt số máu.' ] },
  ];

  function listGuides() { return GUIDE_CATALOG.map(({ gameId, variant, title, rules, steps }) => ({ gameId, variant, title, rules, steps: steps.slice() })); }
  function findGuide(gameId, variant) { return GUIDE_CATALOG.find(item => item.gameId === gameId && item.variant === variant) || null; }
  return Object.freeze({ VERSION: '2026-10-06.v1', GUIDE_CATALOG, listGuides, findGuide });
}));
