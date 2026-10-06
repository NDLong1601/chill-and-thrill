'use strict';

// Read-only waiting-room preflight renderer. The server supplies every balance,
// funding decision and start blocker; this module never derives wallet state.
(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis === 'object') globalThis.RoomPreflight = api;
})(function createPreflight() {
  const CURRENCY_NAMES = Object.freeze({ coin: 'coin', chip: 'chip', gem: 'gem' });
  const FUNDING_LABELS = Object.freeze({
    sufficient: 'Đủ điều kiện ví',
    insufficient: 'Thiếu số dư khả dụng',
    'capacity-blocked': 'Ví chưa đủ sức chứa khoản thanh toán',
    unknown: 'Chưa xác minh được ví',
    'not-required': 'Không cần ví',
  });

  function safeAmount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function formatAmount(value) {
    const amount = safeAmount(value);
    return amount === null ? null : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(amount);
  }

  function currencyName(currency) {
    return CURRENCY_NAMES[currency] || 'đơn vị';
  }

  function requirePayload(payload) {
    if (!payload || payload.schemaVersion !== 1 || typeof payload !== 'object') {
      throw new TypeError('Dữ liệu preflight không đúng phiên bản.');
    }
    if (!payload.room || typeof payload.room.gameId !== 'string' || typeof payload.room.requiresWagerSafety !== 'boolean' || !Array.isArray(payload.seats) ||
        !payload.viewer || typeof payload.viewer.seatId !== 'string' || !payload.evaluation ||
        typeof payload.evaluation.allowed !== 'boolean') {
      throw new TypeError('Dữ liệu preflight thiếu trạng thái phòng cần thiết.');
    }
    return payload;
  }

  function blockerMessage(blocker, payload) {
    const details = blocker?.details && typeof blocker.details === 'object' ? blocker.details : {};
    const minimum = safeAmount(details.minimumPlayers);
    const count = safeAmount(details.playerCount);
    const minimumText = minimum === null ? 'mức tối thiểu' : `${minimum} người`;
    switch (blocker?.code) {
      case 'MIN_PLAYERS': return count === null
        ? `Cần ít nhất ${minimumText} mới bắt đầu được.`
        : `Hiện có ${count} người; cần ít nhất ${minimumText}.`;
      case 'ROOM_CAPACITY': return 'Số ghế hiện tại vượt giới hạn của phòng.';
      case 'NOT_READY': return 'Còn người chơi chưa bấm Sẵn sàng.';
      case 'PLAYER_OFFLINE': return 'Có người chơi đang mất kết nối.';
      case 'POKER_MIN_ELIGIBLE': return `Poker cần ít nhất ${minimum ?? 2} người kết nối, sẵn sàng và đủ stack.`;
      case 'FUNDS_INSUFFICIENT': return 'Có người chơi chưa đủ số dư khả dụng cho khoản cần giữ.';
      case 'WALLET_CAPACITY': return 'Ví của ít nhất một người chưa đủ sức chứa khoản giữ hoặc thanh toán tối đa.';
      case 'FUNDS_UNKNOWN': return 'Chưa xác minh được điều kiện ví của mọi người chơi.';
      case 'STORAGE_UNSAFE': return 'Máy chủ đang gặp vấn đề lưu trữ; chưa thể bắt đầu ván có cược.';
      case 'STORAGE_STATUS_UNKNOWN': return 'Máy chủ chưa xác nhận tình trạng lưu trữ an toàn; ván cược tạm thời chưa thể bắt đầu.';
      case 'HOLD_RECONCILIATION': return 'Máy chủ cần đối soát các khoản đang giữ trước khi mở ván cược.';
      case 'PERSISTENCE_UNAVAILABLE': return 'Máy chủ chưa xác nhận nơi lưu an toàn cho ván mới.';
      case 'CURRENCY_INVALID': return 'Đơn vị tiền của phòng chưa được xác nhận; hãy báo chủ máy.';
      case 'PHASE_NOT_WAITING': return 'Phòng không còn ở trạng thái chờ.';
      case 'NOT_HOST': return 'Chỉ chủ phòng được bắt đầu ván.';
      case 'BUY_IN_REQUIRED': return 'Cần buy-in hoặc top-up đủ mức tối thiểu trước khi chơi Poker.';
      default: return 'Máy chủ chưa cho phép bắt đầu. Hãy kiểm tra lại trạng thái phòng.';
    }
  }

  function buildViewModel(input) {
    const payload = requirePayload(input);
    const viewer = payload.viewer;
    const isHost = viewer.isHost === true;
    const funding = viewer.funding && typeof viewer.funding === 'object' ? viewer.funding : { mode: 'none' };
    const wallet = viewer.wallet && typeof viewer.wallet === 'object' ? viewer.wallet : null;
    const currency = CURRENCY_NAMES[wallet?.currency] ? wallet.currency : null;
    const seats = payload.seats.map(seat => ({
      id: String(seat?.id || ''),
      name: String(seat?.name || 'Người chơi'),
      ready: seat?.ready === true,
      connected: seat?.connected === true,
    }));
    const hostFunding = new Map();
    if (isHost && Array.isArray(payload.host?.seatFunding)) {
      for (const status of payload.host.seatFunding) {
        if (status && typeof status.seatId === 'string' && Object.hasOwn(FUNDING_LABELS, status.status)) {
          hostFunding.set(status.seatId, FUNDING_LABELS[status.status]);
        }
      }
    }
    const waitingFor = seats.filter(seat => !seat.ready || !seat.connected);
    const blockers = isHost && Array.isArray(payload.evaluation.blockers)
      ? payload.evaluation.blockers.map(blocker => blockerMessage(blocker, payload))
      : [];
    const storageSafety = payload.storage?.canStartWager;
    const storageSafe = payload.room.requiresWagerSafety ? storageSafety === true : true;
    const allowed = payload.evaluation.allowed === true && storageSafe;
    if (isHost && payload.room.requiresWagerSafety && storageSafety !== true &&
        !payload.evaluation.blockers?.some(blocker => ['STORAGE_UNSAFE', 'STORAGE_STATUS_UNKNOWN'].includes(blocker?.code))) {
      blockers.push(blockerMessage({ code: storageSafety === false ? 'STORAGE_UNSAFE' : 'STORAGE_STATUS_UNKNOWN' }, payload));
    }
    const revision = Number.isSafeInteger(payload.room.revision) ? payload.room.revision : null;

    return {
      room: {
        code: String(payload.room.code || ''),
        gameId: payload.room.gameId,
        variant: typeof payload.room.variant === 'string' ? payload.room.variant : '',
        phase: typeof payload.room.phase === 'string' ? payload.room.phase : '',
        requiresWagerSafety: payload.room.requiresWagerSafety,
        revision,
      },
      isHost,
      allowed,
      currency,
      wallet: wallet && currency ? {
        available: safeAmount(wallet.available),
        reserved: safeAmount(wallet.reserved),
      } : null,
      funding: {
        mode: ['none', 'fixed-hold', 'poker-buy-in'].includes(funding.mode) ? funding.mode : 'unknown',
        amountToHold: safeAmount(funding.amountToHold),
        shortfall: safeAmount(funding.shortfall),
        poker: funding.mode === 'poker-buy-in' ? {
          stack: safeAmount(funding.stack),
          minToStart: safeAmount(funding.minToStart),
          minBuyIn: safeAmount(funding.minBuyIn),
          maxBuyIn: safeAmount(funding.maxBuyIn),
          minimumAdditionalBuyIn: safeAmount(funding.minimumAdditionalBuyIn),
        } : null,
      },
      seats: seats.map(seat => ({ ...seat, fundingLabel: isHost ? hostFunding.get(seat.id) || null : null })),
      waitingFor,
      blockers,
    };
  }

  function appendText(document, parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function renderWallet(document, root, model) {
    const section = document.createElement('section');
    section.className = 'preflight-wallet';
    section.setAttribute('aria-labelledby', 'preflight-wallet-title');
    appendText(document, section, 'h3', '', 'Tiền trước khi bắt đầu').id = 'preflight-wallet-title';

    if (model.funding.mode === 'none') {
      appendText(document, section, 'p', 'preflight-muted', 'Game này không dùng ví và không giữ tiền khi bắt đầu.');
      root.appendChild(section);
      return;
    }

    if (!model.wallet || !model.currency) {
      appendText(document, section, 'p', 'preflight-warning', 'Máy chủ chưa gửi được số liệu ví riêng của bạn.');
      root.appendChild(section);
      return;
    }

    const unit = currencyName(model.currency);
    appendText(document, section, 'p', 'preflight-wallet-line', `Khả dụng: ${formatAmount(model.wallet.available) ?? 'chưa xác nhận'} ${unit}`);
    appendText(document, section, 'p', 'preflight-wallet-line', `Đang giữ trong ví: ${formatAmount(model.wallet.reserved) ?? 'chưa xác nhận'} ${unit}`);

    if (model.funding.mode === 'fixed-hold') {
      if (model.funding.amountToHold === null) {
        appendText(document, section, 'p', 'preflight-warning', 'Khoản sẽ giữ đang chờ máy chủ xác nhận.');
      } else {
        appendText(document, section, 'p', 'preflight-wallet-line preflight-hold', `Sẽ giữ khi bắt đầu: ${formatAmount(model.funding.amountToHold)} ${unit}`);
        if (model.funding.shortfall === null) {
          appendText(document, section, 'p', 'preflight-warning', 'Máy chủ chưa xác nhận số tiền còn thiếu.');
        } else if (model.funding.shortfall > 0) {
          appendText(document, section, 'p', 'preflight-shortfall', `Bạn còn thiếu ${formatAmount(model.funding.shortfall)} ${unit} cho khoản giữ này.`);
        } else {
          appendText(document, section, 'p', 'preflight-ok', 'Số dư khả dụng của bạn đủ cho khoản giữ.');
        }
      }
    } else if (model.funding.mode === 'poker-buy-in') {
      const poker = model.funding.poker;
      if (!poker) {
        appendText(document, section, 'p', 'preflight-warning', 'Thông tin buy-in Poker đang chờ máy chủ xác nhận.');
      } else {
        appendText(document, section, 'p', 'preflight-wallet-line', `Stack hiện tại: ${formatAmount(poker.stack) ?? 'chưa xác nhận'} chip`);
        appendText(document, section, 'p', 'preflight-muted', 'Mở hand không giữ thêm chip. Buy-in được giữ khi chuyển vào stack; stack này đã nằm trong khoản chip đang giữ.');
        if (poker.minimumAdditionalBuyIn !== null) {
          appendText(document, section, 'p', 'preflight-wallet-line', `Buy-in/top-up tối thiểu để đủ điều kiện: ${formatAmount(poker.minimumAdditionalBuyIn)} chip`);
          if (model.funding.shortfall !== null && model.funding.shortfall > 0) {
            appendText(document, section, 'p', 'preflight-shortfall', `Bạn còn thiếu ${formatAmount(model.funding.shortfall)} chip khả dụng cho mức buy-in/top-up tối thiểu.`);
          } else if (model.funding.shortfall === 0) {
            appendText(document, section, 'p', 'preflight-ok', 'Số dư khả dụng đủ cho mức buy-in/top-up tối thiểu.');
          }
        } else if (poker.stack !== null && poker.minToStart !== null && poker.stack >= poker.minToStart) {
          appendText(document, section, 'p', 'preflight-ok', 'Stack hiện tại đã đạt mức tối thiểu để nhận hand.');
        }
      }
    } else {
      appendText(document, section, 'p', 'preflight-warning', 'Cách tính khoản giữ đang chờ máy chủ xác nhận.');
    }
    root.appendChild(section);
  }

  function render(root, payload) {
    if (!root || !root.ownerDocument) throw new TypeError('Cần phần tử đích để hiển thị preflight.');
    const model = buildViewModel(payload);
    const document = root.ownerDocument;
    root.replaceChildren();
    root.classList.add('room-preflight');
    root.setAttribute('aria-live', 'polite');
    root.dataset.roomCode = model.room.code;
    root.dataset.gameId = model.room.gameId;
    root.dataset.variant = model.room.variant;
    if (model.room.revision !== null) root.dataset.revision = String(model.room.revision);

    const header = document.createElement('div');
    header.className = 'preflight-header';
    appendText(document, header, 'h2', '', 'Trước khi bắt đầu');
    const variantText = model.room.variant === 'classic-local-v1' ? 'UNO 112 lá' :
      model.room.variant === 'classic-108-v1' ? 'UNO 108 lá' : '';
    if (variantText) appendText(document, header, 'span', 'preflight-variant', variantText);
    root.appendChild(header);

    renderWallet(document, root, model);

    const readiness = document.createElement('section');
    readiness.className = 'preflight-readiness';
    readiness.setAttribute('aria-labelledby', 'preflight-readiness-title');
    appendText(document, readiness, 'h3', '', `Người chưa sẵn sàng (${model.waitingFor.length})`).id = 'preflight-readiness-title';
    if (!model.waitingFor.length) {
      appendText(document, readiness, 'p', 'preflight-ok', 'Mọi người đang kết nối và sẵn sàng.');
    } else {
      const list = document.createElement('ul');
      list.className = 'preflight-seats';
      for (const seat of model.waitingFor) {
        const item = document.createElement('li');
        const status = !seat.connected ? (seat.ready ? 'Mất kết nối' : 'Mất kết nối · chưa sẵn sàng') : 'Chưa sẵn sàng';
        appendText(document, item, 'span', 'preflight-seat-name', seat.name);
        appendText(document, item, 'span', 'preflight-seat-status', status);
        if (seat.fundingLabel) appendText(document, item, 'span', 'preflight-seat-funding', seat.fundingLabel);
        list.appendChild(item);
      }
      readiness.appendChild(list);
    }
    if (model.isHost) {
      for (const seat of model.seats.filter(item => item.fundingLabel && !model.waitingFor.some(waiting => waiting.id === item.id))) {
        // Show host-only financial eligibility without exposing balances or shortfalls.
        const row = document.createElement('p');
        row.className = 'preflight-host-funding';
        row.textContent = `${seat.name}: ${seat.fundingLabel}`;
        readiness.appendChild(row);
      }
    }
    root.appendChild(readiness);

    if (model.isHost) {
      const status = document.createElement('section');
      status.className = model.allowed ? 'preflight-start preflight-start-ok' : 'preflight-start preflight-start-blocked';
      status.setAttribute('role', 'status');
      appendText(document, status, 'h3', '', model.allowed ? 'Có thể bắt đầu' : 'Chưa thể bắt đầu');
      if (!model.allowed) {
        const list = document.createElement('ul');
        for (const message of (model.blockers.length ? model.blockers : ['Máy chủ chưa cho phép bắt đầu. Hãy làm mới trạng thái phòng.'])) {
          appendText(document, list, 'li', '', message);
        }
        status.appendChild(list);
      } else {
        appendText(document, status, 'p', '', 'Máy chủ xác nhận các điều kiện hiện đã đạt và sẽ kiểm tra lại trước khi mở ván.');
      }
      root.appendChild(status);
    } else {
      appendText(document, root, 'p', 'preflight-guest-note', 'Chủ phòng sẽ bắt đầu khi các điều kiện của máy chủ đã đạt.');
    }
    return model;
  }

  return Object.freeze({ buildViewModel, render, formatAmount });
});
