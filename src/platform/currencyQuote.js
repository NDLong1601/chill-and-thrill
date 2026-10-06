'use strict';

const { CURRENCIES, COIN_PER_GEM } = require('./currencies');

const validBalance = value => Number.isSafeInteger(value) && value >= 0;
const formatNumber = value => Number(value).toLocaleString('vi-VN');

function quoteCurrencyExchange({ balances, direction, gems, creditCapacity = null } = {}) {
  if (!['coin-to-gem', 'gem-to-coin'].includes(direction) || !Number.isSafeInteger(gems) || gems <= 0 || !Number.isSafeInteger(gems * COIN_PER_GEM)) {
    return { valid: false, canExchange: false, error: 'Nhập số gem nguyên dương để quy đổi.' };
  }

  const coin = balances?.coin || {};
  const gem = balances?.gem || {};
  if (![coin.available, coin.reserved, gem.available, gem.reserved].every(validBalance)) {
    return { valid: false, canExchange: false, error: 'Không đọc được số dư để báo giá.' };
  }

  const fromCurrency = direction === 'coin-to-gem' ? 'coin' : 'gem';
  const toCurrency = direction === 'coin-to-gem' ? 'gem' : 'coin';
  if (creditCapacity && (creditCapacity.currency !== toCurrency
    || creditCapacity.max !== CURRENCIES[toCurrency].max
    || ![creditCapacity.available, creditCapacity.protectedCredit, creditCapacity.remaining].every(validBalance))) {
    return { valid: false, canExchange: false, error: 'Không đọc được giới hạn nhận của ví.' };
  }
  const debit = direction === 'coin-to-gem' ? gems * COIN_PER_GEM : gems;
  const credit = direction === 'coin-to-gem' ? gems : gems * COIN_PER_GEM;
  const sourceAvailable = balances[fromCurrency].available;
  const destinationAvailable = creditCapacity?.available ?? balances[toCurrency].available;
  const destinationCapacity = Math.max(0, Math.min(
    CURRENCIES[toCurrency].max - destinationAvailable,
    creditCapacity?.remaining ?? Number.MAX_SAFE_INTEGER,
  ));
  const protectedCredit = creditCapacity?.protectedCredit || 0;
  const sourceMaxGems = direction === 'coin-to-gem' ? Math.floor(sourceAvailable / COIN_PER_GEM) : sourceAvailable;
  const destinationMaxGems = direction === 'coin-to-gem' ? destinationCapacity : Math.floor(destinationCapacity / COIN_PER_GEM);
  const maxGems = Math.max(0, Math.min(sourceMaxGems, destinationMaxGems));
  const sourceShortfall = Math.max(0, debit - sourceAvailable);
  const destinationShortfall = Math.max(0, credit - destinationCapacity);
  const canExchange = sourceShortfall === 0 && destinationShortfall === 0;
  let error = null;
  if (sourceShortfall > 0) {
    error = direction === 'coin-to-gem'
      ? `Cần ${formatNumber(debit)} coin khả dụng; hiện có ${formatNumber(sourceAvailable)} coin khả dụng (${formatNumber(coin.reserved)} đang giữ). Còn thiếu ${formatNumber(sourceShortfall)} coin.`
      : `Cần ${formatNumber(debit)} gem khả dụng; hiện có ${formatNumber(sourceAvailable)} gem khả dụng. Còn thiếu ${formatNumber(sourceShortfall)} gem.`;
  } else if (destinationShortfall > 0) {
    error = direction === 'coin-to-gem'
      ? `Ví gem chỉ còn chỗ cho tối đa ${formatNumber(destinationCapacity)} gem; yêu cầu này vượt giới hạn ${formatNumber(destinationShortfall)} gem.`
      : `Số dư coin chỉ còn chỗ nhận tối đa ${formatNumber(destinationCapacity)} coin; ${protectedCredit > 0 ? `${formatNumber(protectedCredit)} coin sức chứa được để dành để thanh toán các ván đang chơi. ` : ''}Yêu cầu này vượt giới hạn ${formatNumber(destinationShortfall)} coin.`;
  }

  const after = Object.fromEntries(['coin', 'gem'].map(currency => [currency, {
    available: (currency === toCurrency ? destinationAvailable : balances[currency].available) + (currency === fromCurrency ? -debit : credit),
    reserved: balances[currency].reserved,
  }]));
  return {
    valid: true,
    canExchange,
    direction,
    gems,
    rate: COIN_PER_GEM,
    maxGems,
    fromCurrency,
    toCurrency,
    debit,
    credit,
    balances: {
      coin: { ...coin, ...(toCurrency === 'coin' && creditCapacity ? { available: destinationAvailable } : {}) },
      gem: { ...gem, ...(toCurrency === 'gem' && creditCapacity ? { available: destinationAvailable } : {}) },
    },
    after,
    protectedCredit,
    error,
  };
}

module.exports = { quoteCurrencyExchange };
