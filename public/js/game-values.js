'use strict';

// One parser for native forms and the server. Amounts are always whole units.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameValues = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function cleanDisplayName(value) {
    let name = String(value ?? '');
    for (let i = 0; i < 8; i++) {
      try { const decoded = JSON.parse(name); if (typeof decoded !== 'string' || decoded === name) break; name = decoded; } catch { break; }
    }
    return name.replace(/[\\"\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 18);
  }
  function readName() {
    try { const name = cleanDisplayName(localStorage.getItem('gang.playerName')); writeName(name); return name; } catch { return ''; }
  }
  function writeName(value) {
    try { localStorage.setItem('gang.playerName', JSON.stringify(cleanDisplayName(value))); } catch {}
  }
  function parseAmount(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    let amount;
    if (typeof value === 'number') amount = value;
    else if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      const short = text.match(/^(\d+)(?:[.,](\d{1,6}))?\s*(k|m|tr|triệu|nghìn)$/u);
      if (short) {
        const scale = ['k', 'nghìn'].includes(short[3]) ? 1000n : 1000000n;
        const fraction = short[2] || '', divisor = 10n ** BigInt(fraction.length);
        const total = BigInt(short[1] + fraction) * scale;
        if (total % divisor) throw new Error('Số tiền phải là số nguyên.');
        amount = Number(total / divisor);
      } else if (/^\d+$/.test(text)) amount = Number(text);
      else if (/^\d{1,3}([., ])\d{3}(?:\1\d{3})*$/.test(text)) amount = Number(text.replace(/[., ]/g, ''));
    }
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
      throw new Error(`Nhập số nguyên từ ${formatAmount(min)} đến ${formatAmount(max)}. Có thể dùng 500, 1.000, 10k hoặc 10tr.`);
    }
    return amount;
  }
  function formatAmount(value) { return Number.isSafeInteger(value) ? value.toLocaleString('vi-VN') : '—'; }
  function formatCompact(value) {
    if (!Number.isFinite(value)) return '0';
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1000000) {
      const m = abs / 1000000;
      return `${sign}${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (abs >= 1000) {
      const k = abs / 1000;
      return `${sign}${k >= 100 ? k.toFixed(0) : k.toFixed(k >= 10 ? 1 : 2).replace(/\.?0+$/, '')}K`;
    }
    return `${sign}${abs}`;
  }
  function readEconomy(state) {
    const result = state?.result && typeof state.result === 'object' ? state.result : {};
    const currency = ['coin', 'chip', 'gem'].includes(state?.currency) ? state.currency : '';
    const amount = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    return {
      currency,
      stake: amount(state?.phase === 'RESULT' ? result.stake : state?.stake) ?? amount(state?.stake) ?? amount(result.stake),
      maxLoss: amount(state?.phase === 'RESULT' ? result.maxLoss : state?.maxLoss) ?? amount(state?.maxLoss) ?? amount(result.maxLoss),
    };
  }
  function currencyLabel(state) { return readEconomy(state).currency; }
  function describeEconomy(state, { includeMaxLoss = true } = {}) {
    const { currency, stake, maxLoss } = readEconomy(state);
    const unit = currency ? ` ${currency}` : '';
    const wager = stake === null ? 'Cược chưa được máy chủ cung cấp' : `Cược ${formatAmount(stake)}${unit}/người`;
    if (!includeMaxLoss) return wager;
    const hold = maxLoss === null ? 'mức giữ tối đa đang chờ xác nhận' : `giữ tối đa ${formatAmount(maxLoss)}${unit}/người`;
    return `${wager} · ${hold}`;
  }
  function applyEconomy(state, documentLike = globalThis.document) {
    if (!documentLike) return;
    const { currency } = readEconomy(state);
    documentLike.querySelectorAll('[data-economy-summary]').forEach(node => { node.textContent = describeEconomy(state); });
    documentLike.querySelectorAll('[data-game-currency]').forEach(node => { node.textContent = currency || '—'; });
    if (currency) documentLike.querySelectorAll('[data-game-currency-icon]').forEach(node => { node.src = `/assets/game/${currency}.webp`; });
  }
  function createEconomySummary(state, documentLike = globalThis.document) {
    if (!documentLike) return null;
    const node = documentLike.createElement('p');
    node.className = 'small'; node.dataset.economySummary = '';
    node.textContent = describeEconomy(state);
    return node;
  }
  return { cleanDisplayName, readName, writeName, parseAmount, formatAmount, formatCompact, readEconomy, currencyLabel, describeEconomy, applyEconomy, createEconomySummary };
});
