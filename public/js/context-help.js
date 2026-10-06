(function (root, factory) {
  const content = typeof module === 'object' && module.exports ? require('./tutorial-content') : root?.ChillTutorialContent;
  const help = factory(content);
  if (typeof module === 'object' && module.exports) module.exports = help;
  if (root) root.ChillContextHelp = help;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (content) {
  'use strict';
  const varFor = (state, override) => {
    if (override) return override;
    if (state.gameId === 'the-gang' && (!state.variant || state.variant === 'standard')) return 'base-v1';
    if (state.gameId === 'uno' && !state.variant && !state.rulesVersion
      && (state.phase === 'TURN' || Object.hasOwn(state, 'pendingWdf') || Object.hasOwn(state, 'pendingUno'))) return 'classic-108-v1';
    return state.variant || state.rulesVersion || null;
  };
  const isSeat = state => typeof state.myId === 'string' && state.myId.length > 0;
  function resolveState(state, options = {}) {
    if (!state || typeof state !== 'object' || !isSeat(state)) return { title:'Chưa có trạng thái ghế', body:'Kết nối vào một bàn để nhận hướng dẫn theo lượt.', actions:[] };
    const gameId = state.gameId, variant = varFor(state, options.variant), phase = state.phase;
    const guide = content?.findGuide(gameId, variant);
    if (!guide) return { title:'Chưa xác định biến thể', body:'Chọn đúng phiên bản game để xem luật áp dụng cho bàn này.', actions:[] };
    const awaitingReconnect=state.reconnect?.waiting?.some(player=>player.expired===false);
    if (state.paused || awaitingReconnect) return { gameId, variant, phase, title:'Bàn đang tạm dừng', body:'Chờ người mất kết nối quay lại; không gửi thao tác cho lượt đang dừng.', actions:[] };
    if (['WAITING','LOBBY'].includes(phase)) return { gameId,variant,phase,title:'Chuẩn bị vào ván',body:'Xem luật của bàn và xác nhận sẵn sàng. Chủ phòng bắt đầu khi đủ người và các điều kiện của bàn đã đạt.',actions:[] };
    if (['RESULT','CANCELLED','GAME_OVER'].includes(phase) || state.gameOver) return { gameId,variant,phase,title:'Ván đã kết thúc',body:'Đọc kết quả và biên nhận của bàn trước khi chơi tiếp hoặc rời phòng.',actions:[] };
    const current = state.currentPlayerId === state.myId;
    if (gameId === 'uno') {
      const isClassicLocal = variant === 'classic-local-v1';
      const pendingUno = isClassicLocal ? state.unoWindow : state.pendingUno;
      const unoTarget = isClassicLocal ? (pendingUno?.playerId || pendingUno?.targetId) : pendingUno?.targetId;
      const offered = Array.isArray(state.availableActions) ? state.availableActions.map(item=>item.type) : [];
      if (pendingUno && unoTarget === state.myId) return isClassicLocal ? { gameId, variant, phase, title:'Gọi UNO ngay', body:'Bạn còn đúng một lá và chưa xác nhận UNO. Gọi trong cửa sổ đang mở để tránh bị phạt.', actions:['call_uno'] } : {gameId,variant,phase,title:'Đang chờ bắt lỗi UNO',body:'Bạn đã quên gọi trước khi đánh lá áp chót. Cửa sổ bắt lỗi đang mở; lần sau hãy gọi UNO khi còn hai lá và đang đến lượt mình.',actions:[]};
      if (pendingUno) return { gameId, variant, phase, title:'Có thể bắt lỗi UNO', body:'Chọn bắt lỗi khi cửa sổ còn mở; máy chủ sẽ xử lý mức phạt.', actions:['catch_uno'] };
      const reaction = isClassicLocal ? state.reactionWindow : state.pendingWdf;
      if (reaction || phase === 'WDF_CHALLENGE') { if (reaction?.targetId !== state.myId) return { gameId,variant,phase,title:'Chờ phản ứng +4',body:'Chỉ người bị tác động quyết định rút hoặc phản đối.',actions:[] }; return { gameId,variant,phase,title:'Xử lý Wild Draw Four',body:'Chấp nhận rút 4 và mất lượt, hoặc phản đối để máy chủ kiểm tra điều kiện +4. Tay bài đối thủ vẫn kín.',actions:isClassicLocal?['draw_penalty','challenge_draw_four']:['accept_wdf','challenge_wdf'] }; }
      if (phase === 'DRAW_PENALTY' || state.pendingDraw) return { gameId,variant,phase,title:'Rút phạt',body:'Không cộng dồn phạt trong hai biến thể. Ghế đích rút đủ số lá đang hiển thị rồi mất lượt.',actions:(isClassicLocal?state.pendingTargetId:state.pendingDraw?.targetId)===state.myId?['draw_penalty']:[] };
      if (offered.includes('choose_color') || state.openingColorPending || phase === 'CHOOSE_COLOR') return { gameId,variant,phase,title:'Chọn màu Wild',body:'Chọn một trong bốn màu để lượt tiếp tục.',actions:current?['choose_color']:[] };
      if (current && (state.drawChoice || state.drawnCardId)) return {gameId,variant,phase,title:'Lá vừa rút',body:'Chỉ lá vừa rút mới có thể đánh trong lượt này. Bạn cũng có thể kết thúc lượt rút.',actions:isClassicLocal?['play_drawn','pass_draw']:['play','pass']};
      if (!isClassicLocal && current && state.myHand?.length===2 && !state.unoDeclaredForTurn) return {gameId,variant,phase,title:'Gọi UNO trước lá áp chót',body:'Gọi UNO trước khi đánh một trong hai lá còn lại. Sau khi đánh, cửa sổ bắt lỗi mới mở cho các ghế khác.',actions:['declare_uno','play','draw']};
      if (current) return { gameId,variant,phase,title:'Lượt của bạn',body:`Khớp lá trên cùng theo màu, số hoặc biểu tượng; Wild luôn đánh được. ${isClassicLocal?'Bạn có thể rút dù vẫn có lá đánh được.':'Nếu đã rút, chỉ lá vừa rút mới được đánh.'}`,actions:isClassicLocal?['play_card','draw_card']:['play','draw'] };
      return { gameId,variant,phase,title:'Đợi lượt',body:'Lượt đang ở ghế khác. Bạn sẽ được hướng dẫn lại khi server cập nhật trạng thái.',actions:[] };
    }
    if (gameId === 'the-gang') {
      if (phase === 'SHOWDOWN') return { gameId,variant,phase,title:'Showdown',body:'Nếu thử thách yêu cầu đoán, cùng đồng đội thống nhất trước khi chủ phòng lật người cuối. Chỉ bài công khai ở lượt lật mới xuất hiện.',actions:state.players?.find(player=>player.id===state.myId)?.isHost?['reveal_next']:[] };
      if (state.specialistState && (['PASS','VIEW','SELECT_CARD','DISCARD'].includes(state.specialistState.stage) || state.specialistState.proposal)) return { gameId,variant,phase,title:'Hoàn tất chuyên gia',body:'Thao tác chip bị khóa cho đến khi hoàn tất chuyên gia. Chỉ làm lựa chọn riêng được giao cho ghế của bạn.',actions:['specialist_action'] };
      if (['PRE_FLOP','FLOP','TURN','RIVER'].includes(phase)) return { gameId,variant,phase,title:`Vòng ${phase}`,body:`Màu chip hiện tại là ${state.currentRoundChipColor || 'màu của vòng'}. Chọn chip để thể hiện thứ hạng bạn dự đoán cho bài của mình, rồi chốt. Chip đã khóa không thể đổi; xác nhận sẽ bị đặt lại nếu chip thay đổi.`,actions:['claim_chip','return_chip','confirm_round'] };
    }
    if (gameId === 'tien-len') {
      if (!current) return { gameId,variant,phase,title:'Đợi lượt',body:'Theo dõi tổ hợp trên bàn. Người đã bỏ lượt không vào lại vòng này.',actions:[] };
      if (!state.topPlay && state.initialRequiredCardId) return { gameId,variant,phase,title:'Mở ván',body:'Tổ hợp đầu tiên của bạn phải chứa lá mở đầu được server đánh dấu trong tay riêng.',actions:['play'] };
      return state.topPlay ? { gameId,variant,phase,title:'Đè hoặc bỏ lượt',body:'Muốn đè, dùng cùng loại và cùng số lá với giá trị cao hơn hoặc một cách chặt được south-v1 cho phép. Nếu không, bỏ lượt.',actions:['play','pass'] }
        : { gameId,variant,phase,title:'Dẫn vòng',body:'Chọn rác, đôi, sám, sảnh, tứ quý hoặc đôi thông hợp lệ theo south-v1.',actions:['play'] };
    }
    if (gameId === 'sam-loc') {
      if (phase === 'SAM_DECLARATION') return { gameId,variant,phase,title:'Báo Sâm hay không?',body:'Chọn một lần trong cửa sổ sau khi chia. Nếu nhiều người báo, thứ tự ghế phân định người được ưu tiên.',actions:state.samWindow?.myResponse?[]:['declare_sam','pass_sam'] };
      if (!current) return { gameId,variant,phase,title:'Đợi lượt',body:'Theo dõi bài trên bàn; server báo khi đến lượt ghế của bạn.',actions:[] };
      if (state.samDeclarer?.id === state.myId) return { gameId,variant,phase,title:'Đang Báo Sâm',body:'Đánh hết bài để báo thành công. Nếu bỏ lượt khi cần đè hoặc người khác hết bài trước, Báo Sâm thất bại.',actions:state.topPlay?['play','pass']:['play'] };
      return state.topPlay ? { gameId,variant,phase,title:'Đè hoặc bỏ lượt',body:'Đè bằng cùng loại/cùng độ dài và giá trị cao hơn. Bản local-v1 không có chặt riêng; hai lá cùng giá trị không đè nhau.',actions:['play','pass'] }
        : { gameId,variant,phase,title:'Dẫn vòng',body:state.initialRequiredCardId?'Lượt đầu phải chứa lá thấp nhất được chia.':'Chọn tổ hợp hợp lệ để mở vòng.',actions:['play'] };
    }
    if (gameId === 'poker') {
      if (!current || !state.legalActions) return { gameId,variant,phase,title:current?'Chưa có action hợp lệ':'Đợi lượt',body:'Chỉ thao tác theo thông tin server công bố cho ghế bạn.',actions:[] };
      const legal = state.legalActions, amount = Number.isFinite(legal.callAmount) ? legal.callAmount : Number(legal.toCall || 0);
      return { gameId,variant,phase,title:amount===0?'Không có chip cần theo':'Có chip cần theo',body:amount===0?'Bạn có thể check hoặc bet nếu bàn cho phép; fold vẫn bỏ quyền thắng pot.':'Bạn có thể call số chip hiển thị, raise nếu quyền tố đã mở và mức tối thiểu hợp lệ, hoặc fold.',actions:[...(legal.canCheck?['check']:[]),...(legal.canCall?['call']:[]),...(legal.canBet?['bet']:[]),...(legal.canRaise?['raise']:[]),...(legal.canFold?['fold']:[]),...(legal.canAllIn?['all_in']:[])] };
    }
    if (gameId === 'phom') {
      if (!current) return { gameId,variant,phase,title:'Đợi lượt',body:'Các lá đã hạ là công khai; bài tay ghế khác vẫn kín.',actions:[] };
      if (phase === 'LAYDOWN') return { gameId,variant,phase,title:'Hạ phỏm',body:'Chọn nhóm không chồng lấn. Mọi lá đã ăn phải nằm trong ít nhất một nhóm hợp lệ; máy chủ xử lý gửi bài theo lựa chọn hợp lệ.',actions:['lay_down','declare_u'] };
      if (phase === 'DISCARD') return { gameId,variant,phase,title:'Đánh một lá',body:'Đánh lá không bị khóa bởi các lá đã ăn. Nếu đây là lượt cuối, sau đó bàn chuyển sang hạ bài.',actions:['discard'] };
      if (phase === 'DRAW_OR_EAT') return { gameId,variant,phase,title:'Bốc hoặc ăn',body:'Có thể bốc từ nọc hoặc ăn đúng lá vừa đánh nếu nó được ghép vào phỏm hợp lệ ngay lúc ăn.',actions:['draw','eat'] };
    }
    if (gameId === 'bang') {
      if (state.players?.find(player=>player.id===state.myId)?.dead) return {gameId,variant,phase,title:'Bạn đã bị loại',body:'Bạn có thể theo dõi các lá và vai trò đã công khai đến hết ván.',actions:[]};
      if (state.pending) { if (state.pending.waitingId !== state.myId) return {gameId,variant,phase,title:'Đợi phản ứng',body:'Một hiệu ứng đang chờ ghế khác. Lượt chính tạm dừng.',actions:[]}; return {gameId,variant,phase,title:'Trả lời hiệu ứng',body:state.pending.message || 'Chỉ dùng các lựa chọn hợp lệ mà máy chủ hiển thị cho hiệu ứng này.',actions:['respond']}; }
      if (!current) return { gameId,variant,phase,title:'Đợi lượt',body:'Lượt chính ở ghế khác. Phản ứng chỉ xuất hiện khi server chỉ định bạn.',actions:[] };
      return { gameId,variant,phase,title:phase==='DRAW'?'Rút đầu lượt':'Lượt chính',body:phase==='DRAW'?'Xử lý Dynamite/Jail theo thứ tự rồi rút hai lá; lượt chính bắt đầu sau khi hiệu ứng kết thúc.':'Chơi lá hợp lệ theo tầm/khoảng cách và giới hạn BANG!, rồi bỏ đến khi số lá không vượt số máu.',actions:phase==='DRAW'?['draw_cards']:['play_card','end_turn']};
    }
    return { gameId, variant, phase, title:'Đợi trạng thái game', body:'Chưa có hướng dẫn cụ thể cho pha hiện tại.', actions:[] };
  }
  function resolve(state, options) {
    const item=resolveState(state,options);
    if(item.variant==='classic-local-v1' && Array.isArray(state?.availableActions)) {
      const legal=new Set(state.availableActions.map(action=>action.type));
      item.actions=item.actions.filter(action=>legal.has(action));
    }
    return item;
  }
  function render(target, state, options) {
    if (!target || typeof target.replaceChildren !== 'function') return null;
    const item = resolve(state, options), title = document.createElement('strong'), body = document.createElement('p');
    title.textContent = item.title; body.textContent = item.body; target.replaceChildren(title, body); return item;
  }
  return Object.freeze({ resolve, render });
}));
