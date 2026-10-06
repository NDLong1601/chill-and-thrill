'use strict';

(function currencyWallet() {
  const form = document.getElementById('wallet-exchange');
  if (!form) return;
  const directionField = form.elements.direction;
  const gemsField = form.elements.gems;
  const submitButton = form.querySelector('button[type="submit"]');
  const message = form.querySelector('[data-exchange-message]');
  const rateLabel = form.querySelector('[data-exchange-rate]');
  let profile = null;
  let pending = null;
  let quote = null;
  let quoteRequest = 0;
  let submitting = false;

  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = '/css/currency-wallet.css';
  document.head.appendChild(style);

  const overview = document.createElement('div');
  overview.className = 'currency-wallet-overview';
  overview.innerHTML = '<p>Coin dùng để cược Tiến lên, Sâm lốc và Phỏm. Gem là đơn vị quy đổi hiện có; hiện chưa có cửa hàng gem. Chip Poker có số dư riêng và không đổi được sang coin hoặc gem. Khi có ván coin đang chơi, một phần chỗ nhận coin có thể được để dành để thanh toán kết quả.</p><p data-exchange-reward-pace>Mức thưởng coin đang tải từ máy chủ…</p>';
  form.insertBefore(overview, form.firstChild);

  const amountLabel = gemsField?.closest('label');
  const maxButton = document.createElement('button');
  maxButton.type = 'button'; maxButton.className = 'currency-exchange-max'; maxButton.dataset.exchangeMax = '';
  maxButton.textContent = 'Dùng mức tối đa'; maxButton.disabled = true;
  amountLabel?.appendChild(maxButton);

  const preview = document.createElement('div');
  preview.className = 'currency-exchange-preview'; preview.dataset.exchangePreview = '';
  preview.setAttribute('role', 'status'); preview.setAttribute('aria-live', 'polite');
  preview.textContent = 'Chọn hướng và số gem để xem trước quy đổi.';
  if (message) form.insertBefore(preview, message); else form.appendChild(preview);

  const format = value => Number(value).toLocaleString('vi-VN');
  const token = () => localStorage.getItem('chill-thrill:profile-token') || localStorage.getItem('gang.profileToken') || '';
  const parseGems = () => {
    const raw = String(gemsField?.value || '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const pendingStorageKey = () => `chill-thrill:currency-exchange:${profile?.id || 'unknown'}`;
  const matchesPending = (direction, gems) => pending?.profileId === profile?.id && pending.direction === direction && pending.gems === gems;
  const balanceSignature = value => JSON.stringify(['coin', 'gem'].map(currency => [
    value?.balances?.[currency]?.available, value?.balances?.[currency]?.reserved,
  ]));

  function savePending() {
    try {
      if (pending) sessionStorage.setItem(pendingStorageKey(), JSON.stringify(pending));
      else sessionStorage.removeItem(pendingStorageKey());
    } catch { /* The in-memory key still protects retries in this page. */ }
  }

  function restorePending() {
    pending = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingStorageKey()) || 'null');
      if (saved?.profileId === profile?.id && typeof saved.operationKey === 'string') pending = { ...saved, ambiguous: true };
    } catch { pending = null; }
  }

  function setPreviewText(text, isError = false) {
    preview.textContent = text;
    preview.classList.toggle('is-error', isError);
  }

  function showQuote(next) {
    quote = next;
    if (rateLabel && Number.isSafeInteger(next.rate)) rateLabel.textContent = `1 gem = ${format(next.rate)} coin`;
    const retry = matchesPending(directionField.value, parseGems()) && pending?.ambiguous;
    maxButton.disabled = retry || (!next.canExchange && next.maxGems === 0);
    maxButton.textContent = next.maxGems > 0 ? `Dùng tối đa ${format(next.maxGems)} gem` : 'Chưa có mức đổi khả dụng';
    if (next.rewards) {
      const rewardPace = overview.querySelector('[data-exchange-reward-pace]');
      const count = next.rewards.openDailyMissionCount;
      const total = format(next.rewards.openDailyMissionReward);
      rewardPace.textContent = `Hồ sơ nhận ${format(next.rewards.startingCoinGrant)} coin khi tạo; ${count} nhiệm vụ ngày đang mở cộng ${total} coin nếu hoàn thành và nhận thưởng.`;
    }

    if (!next.canExchange) {
      const suffix = retry ? ' Lần gửi trước có thể đã hoàn tất; chọn “Kiểm tra lần gửi trước” để dùng lại cùng khóa, không tạo giao dịch mới.' : '';
      setPreviewText((next.error || 'Số gem này chưa thể quy đổi. Hãy kiểm tra số dư và giới hạn ví.') + suffix, true);
      if (submitButton) {
        submitButton.textContent = retry ? 'Kiểm tra lần gửi trước' : 'Xác nhận quy đổi';
        submitButton.disabled = submitting || !retry;
      }
      return;
    }

    const fromName = next.fromCurrency === 'coin' ? 'coin' : 'gem';
    const toName = next.toCurrency === 'coin' ? 'coin' : 'gem';
    const fromAfter = next.after[next.fromCurrency];
    const toAfter = next.after[next.toCurrency];
    const protectedNote = next.toCurrency === 'coin' && next.protectedCredit > 0
      ? ` ${format(next.protectedCredit)} coin sức chứa được để dành để thanh toán các ván đang chơi.` : '';
    const retryNote = retry ? ' Lần gửi trước có thể đã hoàn tất; xác nhận sẽ kiểm tra lại cùng khóa giao dịch.' : '';
    setPreviewText(`Xem trước: trừ ${format(next.debit)} ${fromName} khả dụng, nhận ${format(next.credit)} ${toName}. Sau đổi: ${format(fromAfter.available)} ${fromName} khả dụng (${format(fromAfter.reserved)} đang giữ) và ${format(toAfter.available)} ${toName} khả dụng (${format(toAfter.reserved)} đang giữ).${protectedNote}${retryNote}`);
    if (submitButton) { submitButton.textContent = retry ? 'Kiểm tra lần gửi trước' : 'Xác nhận quy đổi'; submitButton.disabled = submitting; }
  }

  async function refreshQuote() {
    const requestId = ++quoteRequest;
    quote = null;
    if (submitting) return;
    if (pending?.ambiguous && pending.profileId === profile?.id) {
      directionField.value = pending.direction;
      gemsField.value = String(pending.gems);
      directionField.disabled = true;
      gemsField.disabled = true;
      maxButton.disabled = true;
    }
    const gems = parseGems();
    if (!gems) {
      setPreviewText('Nhập số gem nguyên dương để xem trước quy đổi.', true);
      maxButton.disabled = true;
      if (submitButton) submitButton.disabled = true;
      return;
    }
    const authToken = token();
    if (!authToken) {
      setPreviewText('Hãy tạo hoặc khôi phục hồ sơ để xem báo giá quy đổi.', true);
      maxButton.disabled = true;
      if (submitButton) submitButton.disabled = true;
      return;
    }
    setPreviewText('Đang lấy báo giá mới nhất từ máy chủ…');
    maxButton.disabled = true;
    if (submitButton) submitButton.disabled = true;
    try {
      const params = new URLSearchParams({ direction: directionField.value, gems: String(gems) });
      const response = await fetch(`/api/wallet/exchange/quote?${params}`, { headers: { 'X-Profile-Token': authToken }, cache: 'no-store' });
      const result = await response.json();
      if (requestId !== quoteRequest) return;
      if (!response.ok) throw new Error(result.error || 'Không lấy được báo giá.');
      showQuote(result);
    } catch (error) {
      if (requestId !== quoteRequest) return;
      setPreviewText(error.message || 'Không lấy được báo giá. Kiểm tra kết nối rồi thử lại.', true);
      maxButton.disabled = true;
      if (submitButton) {
        const retry = pending?.ambiguous && matchesPending(directionField.value, parseGems());
        submitButton.textContent = retry ? 'Kiểm tra lần gửi trước' : 'Xác nhận quy đổi';
        submitButton.disabled = !retry;
      }
    }
  }

  function render(nextProfile) {
    const previous = profile;
    const profileChanged = previous?.id !== nextProfile?.id;
    const currencyStateChanged = balanceSignature(previous) !== balanceSignature(nextProfile)
      || previous?.exchangeRate?.coinPerGem !== nextProfile?.exchangeRate?.coinPerGem;
    profile = nextProfile || null;
    form.hidden = !profile;
    if (!profile) return;
    if (rateLabel && Number.isSafeInteger(profile.exchangeRate?.coinPerGem)) {
      rateLabel.textContent = `1 gem = ${format(profile.exchangeRate.coinPerGem)} coin`;
    }
    for (const currency of ['coin', 'gem']) {
      document.querySelectorAll(`[data-balance="${currency}"]`).forEach(element => {
        element.textContent = format(profile.balances?.[currency]?.available || 0);
      });
    }
    document.querySelectorAll('[data-coin-reserved]').forEach(element => {
      element.textContent = format(profile.balances?.coin?.reserved || 0);
    });
    if (profileChanged) restorePending();
    if (profileChanged || currencyStateChanged) refreshQuote();
  }

  maxButton.addEventListener('click', () => {
    if (!quote || !Number.isSafeInteger(quote.maxGems) || quote.maxGems < 1) return;
    gemsField.value = String(quote.maxGems);
    refreshQuote();
    gemsField.focus();
  });
  directionField?.addEventListener('change', refreshQuote);
  gemsField?.addEventListener('input', refreshQuote);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const gems = parseGems();
    if (!gems) { setPreviewText('Nhập số gem nguyên dương để quy đổi.', true); return; }
    const retry = pending?.ambiguous && matchesPending(directionField.value, gems);
    if ((!quote && !retry) || (quote && ((!quote.canExchange && !retry) || quote.direction !== directionField.value || quote.gems !== gems))) {
      await refreshQuote();
      return;
    }
    const direction = directionField.value;
    if (!retry) {
      const operationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      pending = { direction, gems, profileId: profile?.id, operationKey: `exchange:${operationId}`, ambiguous: true };
    }
    pending.ambiguous = true;
    savePending();

    submitting = true;
    if (submitButton) submitButton.disabled = true;
    directionField.disabled = true; gemsField.disabled = true; maxButton.disabled = true;
    if (message) message.textContent = 'Đang quy đổi…';
    try {
      const response = await fetch('/api/wallet/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Profile-Token': token() },
        body: JSON.stringify({ direction: pending.direction, gems: pending.gems, operationKey: pending.operationKey }),
      });
      const result = await response.json();
      if (!response.ok) {
        const definitelyRejected = new Set(['EXCHANGE_INVALID', 'IDEMPOTENCY_INVALID', 'IDEMPOTENCY_CONFLICT', 'WALLET_LIMIT', 'PAYOUT_CAPACITY', 'WALLET_NOT_FOUND', 'CURRENCY_INVALID', 'PROFILE_UNAUTHORIZED']);
        if (definitelyRejected.has(result.code)) { pending = null; savePending(); }
        throw new Error(result.error || 'Không thể quy đổi.');
      }
      pending = null; savePending();
      render(result.profile);
      document.dispatchEvent(new CustomEvent('currency-wallet:updated', { detail: result }));
      if (message) message.textContent = result.exchange?.idempotent ? 'Đã xác nhận giao dịch trước đó; số dư không bị trừ lần nữa.' : 'Đã quy đổi và cập nhật số dư.';
    } catch (error) {
      if (pending) { pending.ambiguous = true; savePending(); }
      if (message) message.textContent = error.message || 'Mất kết nối. Bạn có thể thử lại; yêu cầu sẽ dùng lại khóa giao dịch.';
    } finally {
      submitting = false;
      directionField.disabled = false; gemsField.disabled = false;
      refreshQuote();
    }
  });

  window.CurrencyWallet = { render };
})();
