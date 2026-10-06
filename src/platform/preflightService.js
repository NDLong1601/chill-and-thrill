'use strict';

const { getGame, getStakeLimits } = require('./gameRegistry');
const { CURRENCIES, currencyForGame } = require('./currencies');
const { BIG_BLIND, MIN_BUY_IN, MAX_BUY_IN } = require('../games/poker/pokerEngine');

const FIXED_WAGER_GAMES = new Set(['tien-len', 'sam-loc', 'phom']);
const HOST_FUNDING_STATUSES = new Set(['sufficient', 'insufficient', 'capacity-blocked', 'seat-conflict', 'unknown', 'not-required']);

function fail(code) {
  const messages = {
    ROOM_NOT_FOUND: 'Không tìm thấy phòng.',
    VIEWER_NOT_IN_ROOM: 'Ghế hiện tại không còn trong phòng.',
    VIEWER_IDENTITY_MISMATCH: 'Không thể xác minh hồ sơ của ghế hiện tại.',
    PROFILE_STORE_UNAVAILABLE: 'Chưa thể xác minh ví cho phòng này.',
    GAME_NOT_SUPPORTED: 'Game của phòng chưa có preflight.',
  };
  throw Object.assign(new Error(messages[code] || 'Không thể tạo thông tin trước khi bắt đầu.'), { code });
}

function resolveManager(manager, roomCode) {
  if (!manager) fail('ROOM_NOT_FOUND');
  if (manager.rooms?.has?.(roomCode)) return manager;
  if (manager.gameManager?.rooms?.has?.(roomCode)) return manager.gameManager;
  if (typeof manager.managerForCode === 'function') {
    const actual = manager.managerForCode(roomCode);
    if (actual?.rooms?.has?.(roomCode)) return actual;
  }
  return null;
}

function resolveProfileStore(explicitStore, owner, manager) {
  if (explicitStore?.walletForUpdate) return explicitStore;
  for (const candidate of [
    owner?.profileStore,
    owner?.profiles,
    owner?.profileService?.profiles,
    manager?.profiles,
    manager?.profileStore,
    manager?.profileService?.profiles,
    manager?.gameManager?.profileService?.profiles,
  ]) if (candidate?.walletForUpdate) return candidate;
  return null;
}

function roomGameId(room) {
  return room.gameId || 'the-gang';
}

function roomVariant(room, owner, gameId) {
  if (gameId === 'uno') {
    if (room.variant === 'classic-108-v1') return 'classic-108-v1';
    if (room.variant === 'classic-local-v1' || room.config || owner?.constructor?.name !== 'UnoManager') return 'classic-local-v1';
    return 'classic-108-v1';
  }
  return room.variant || room.rulesVersion || 'standard';
}

function roomLimits(room, owner, gameId, variant, definition) {
  let minimumPlayers = definition.minPlayers;
  if (gameId === 'the-gang') minimumPlayers = 2;
  if (gameId === 'uno') minimumPlayers = 2;

  let maximumPlayers = definition.maxPlayers;
  if (gameId === 'the-gang') maximumPlayers = room.config?.maxPlayers || 6;
  else if (gameId === 'uno' && variant === 'classic-local-v1') maximumPlayers = room.config?.maxPlayers || 4;
  else if (gameId === 'uno' && variant === 'classic-108-v1') maximumPlayers = 6;
  else if (Number.isInteger(room.config?.maxPlayers)) maximumPlayers = room.config.maxPlayers;
  else if (owner?.constructor?.name === 'UnoManager') maximumPlayers = 6;
  return { minimumPlayers, maximumPlayers };
}

function roomCurrency(room, store, gameId) {
  const reservations = Array.isArray(room.reservations) ? room.reservations : [];
  const row = reservations.find(item => item && typeof item === 'object');
  if (row?.currency && CURRENCIES[row.currency]) return row.currency;
  if (row?.reservationId && typeof store?.reservationCurrency === 'function') {
    try {
      const currency = store.reservationCurrency(reservations, '');
      if (CURRENCIES[currency]) return currency;
    } catch { /* A missing legacy row is handled by the room's persisted currency below. */ }
  }
  if (CURRENCIES[room.currency]) return room.currency;
  return currencyForGame(gameId);
}

function readWallet(store, profileId, currency) {
  if (!store || typeof profileId !== 'string' || !CURRENCIES[currency]) return null;
  try {
    const wallet = store.walletForUpdate(profileId, currency);
    const cap = CURRENCIES[currency].max;
    if (!Number.isSafeInteger(wallet?.available) || !Number.isSafeInteger(wallet?.reserved) ||
        wallet.available < 0 || wallet.reserved < 0 || wallet.available > cap || wallet.reserved > cap) return null;
    return { available: wallet.available, reserved: wallet.reserved };
  } catch { return null; }
}

function pokerBuyInMinimum(stack) {
  if (stack === 0) return MIN_BUY_IN;
  if (stack >= BIG_BLIND) return 0;
  return Math.ceil((BIG_BLIND - stack) / BIG_BLIND) * BIG_BLIND;
}

function pokerEligibility(player) {
  const reasons = [];
  if (!player.connected) reasons.push('PLAYER_OFFLINE');
  if (!player.ready) reasons.push('NOT_READY');
  if (!Number.isSafeInteger(player.stack) || player.stack < BIG_BLIND) reasons.push('STACK_INSUFFICIENT');
  if (player.leaveAfterHand) reasons.push('LEAVE_AFTER_HAND');
  return { eligible: reasons.length === 0, reasons };
}

function activeReservationRoom(store, profileId) {
  if (!store?.db?.prepare) return undefined;
  try {
    return store.db.prepare("SELECT room_code AS roomCode FROM reservations WHERE profile_id = ? AND status = 'HELD'").get(profileId)?.roomCode || null;
  } catch { return undefined; }
}

function fixedSeatFunding({ seat, currency, stake, limits, store }) {
  const unknown = { status: 'unknown', wallet: null, shortfall: null, blockers: ['FUNDS_UNKNOWN'] };
  if (typeof seat.profileId !== 'string' || !store || !CURRENCIES[currency]) return unknown;
  if (!Number.isSafeInteger(stake) || !store.validateAmount?.(stake, currency) || stake < limits.minStake || stake > limits.maxStake) {
    return { ...unknown, blockers: ['STAKE_INVALID'] };
  }

  const amountToHold = limits.holdFactor * stake;
  const maxNetGain = limits.maxNetGainFactor * stake;
  const grossPayout = limits.grossPayoutFactor * stake;
  if (![amountToHold, maxNetGain, grossPayout, limits.playerCount * amountToHold,
    limits.playerCount * grossPayout].every(Number.isSafeInteger)) {
    return { status: 'capacity-blocked', wallet: null, shortfall: null, blockers: ['AMOUNT_OVERFLOW'] };
  }
  if (![amountToHold, maxNetGain, grossPayout].every(value => store.validateAmount?.(value, currency))) {
    return { status: 'capacity-blocked', wallet: null, shortfall: null, blockers: ['AMOUNT_OVERFLOW'] };
  }

  const wallet = readWallet(store, seat.profileId, currency);
  if (!wallet) return unknown;
  const shortfall = Math.max(0, amountToHold - wallet.available);
  const blockers = [];
  const activeRoom = activeReservationRoom(store, seat.profileId);
  if (activeRoom === undefined) blockers.push('FUNDS_UNKNOWN');
  else if (activeRoom && activeRoom !== seat.roomCode) blockers.push('PLAYER_ALREADY_RESERVED');
  if (shortfall > 0) blockers.push('FUNDS_INSUFFICIENT');
  const walletMax = CURRENCIES[currency].max;
  if (wallet.reserved > walletMax - amountToHold) blockers.push('WALLET_CAPACITY');
  if (wallet.available > walletMax - maxNetGain) blockers.push('PAYOUT_CAPACITY');
  return {
    status: blockers.includes('PLAYER_ALREADY_RESERVED') ? 'seat-conflict' :
      blockers.includes('FUNDS_INSUFFICIENT') ? 'insufficient' :
        blockers.length ? 'capacity-blocked' : 'sufficient',
    wallet, amountToHold, shortfall, maxNetGain, grossPayout, blockers,
  };
}

function addUnique(blockers, code, details) {
  if (!blockers.some(item => item.code === code)) blockers.push({ code, ...(details ? { details } : {}) });
}

function normalizeStorageStatus(storageStatus) {
  if (typeof storageStatus === 'boolean') return storageStatus;
  if (storageStatus && typeof storageStatus === 'object' && typeof storageStatus.canStartWager === 'boolean') return storageStatus.canStartWager;
  return null;
}

/**
 * Build one socket/seat-specific preview from live manager state. This performs
 * reads only: it never calls startGame, reserves money, changes room state, or
 * returns peer balances. The start handler remains the final authority.
 */
function buildRoomPreflight({ manager, roomCode, viewerSeatId, viewerProfileId, profileStore, storageStatus } = {}) {
  const owner = resolveManager(manager, roomCode);
  if (!owner) fail('ROOM_NOT_FOUND');
  const room = owner.rooms.get(roomCode);
  if (!room || !Array.isArray(room.players)) fail('ROOM_NOT_FOUND');
  const players = room.players;
  const viewer = players.find(player => player?.id === viewerSeatId);
  if (!viewer) fail('VIEWER_NOT_IN_ROOM');
  if (viewerProfileId !== undefined && viewer.profileId !== viewerProfileId) fail('VIEWER_IDENTITY_MISMATCH');

  const gameId = roomGameId(room);
  const definition = getGame(gameId);
  if (!definition) fail('GAME_NOT_SUPPORTED');
  const variant = roomVariant(room, owner, gameId);
  const { minimumPlayers, maximumPlayers } = roomLimits(room, owner, gameId, variant, definition);
  const playerCount = players.length;
  const isHost = viewer.isHost === true;
  const fixedWager = FIXED_WAGER_GAMES.has(gameId);
  const pokerWager = gameId === 'poker';
  const requiresWagerSafety = fixedWager || pokerWager;
  if (requiresWagerSafety && (viewerProfileId !== undefined && viewer.profileId !== viewerProfileId ||
      viewerProfileId === undefined && typeof viewer.profileId === 'string')) {
    fail('VIEWER_IDENTITY_MISMATCH');
  }
  const effectiveStorageSafety = normalizeStorageStatus(storageStatus);
  const store = resolveProfileStore(profileStore, owner, manager);
  if (requiresWagerSafety && !store) fail('PROFILE_STORE_UNAVAILABLE');

  const seats = players.map(player => ({
    id: String(player.id), name: String(player.name || 'Người chơi'),
    ready: player.ready === true, connected: player.connected === true,
  }));
  const ownCurrency = fixedWager ? roomCurrency(room, store, gameId) : pokerWager ? 'chip' : null;
  const viewerWallet = ownCurrency ? readWallet(store, viewer.profileId, ownCurrency) : null;
  if (requiresWagerSafety && !viewerWallet) {
    // An unavailable read stays unknown in the private payload; it never falls
    // back to a public profile projection or another seat's balance.
  }

  const blockers = [];
  if (room.phase !== 'WAITING') addUnique(blockers, 'PHASE_NOT_WAITING');
  if (!viewer.connected) addUnique(blockers, 'VIEWER_OFFLINE');
  if (playerCount < minimumPlayers) addUnique(blockers, 'MIN_PLAYERS', { minimumPlayers, playerCount });
  if (playerCount > maximumPlayers) addUnique(blockers, 'ROOM_CAPACITY', { maximumPlayers, playerCount });
  if (isHost && requiresWagerSafety) {
    if (effectiveStorageSafety === false) addUnique(blockers, 'STORAGE_UNSAFE');
    else if (effectiveStorageSafety !== true) addUnique(blockers, 'STORAGE_STATUS_UNKNOWN');
  }

  let funding = { mode: 'none' };
  let fundingStatuses;
  let eligibilityStatuses;
  let financialChecks = new Map();

  if (fixedWager) {
    const currency = ownCurrency;
    const limitsCount = Math.max(minimumPlayers, playerCount);
    let limits = null;
    if (limitsCount <= maximumPlayers) {
      try { limits = getStakeLimits(gameId, limitsCount); } catch { limits = null; }
    }
    if (!CURRENCIES[currency]) addUnique(blockers, 'CURRENCY_INVALID');
    if (playerCount > maximumPlayers || !limits || !CURRENCIES[currency]) {
      funding = { mode: 'fixed-hold', currency: CURRENCIES[currency] ? currency : null, amountToHold: null, shortfall: null, status: 'unknown' };
      fundingStatuses = players.map(player => ({ seatId: String(player.id), status: 'unknown' }));
    } else {
      const stake = room.stake;
      for (const player of (isHost ? players : [viewer])) {
        const checked = fixedSeatFunding({ seat: { ...player, roomCode: room.code }, currency, stake, limits, store });
        financialChecks.set(player.id, checked);
        for (const code of checked.blockers) {
          if (isHost) addUnique(blockers, code);
        }
      }
      const ownCheck = financialChecks.get(viewer.id);
      funding = {
        mode: 'fixed-hold', currency,
        amountToHold: Number.isSafeInteger(ownCheck?.amountToHold) ? ownCheck.amountToHold : null,
        shortfall: Number.isSafeInteger(ownCheck?.shortfall) ? ownCheck.shortfall : null,
        maxNetGain: Number.isSafeInteger(ownCheck?.maxNetGain) ? ownCheck.maxNetGain : null,
        grossPayout: Number.isSafeInteger(ownCheck?.grossPayout) ? ownCheck.grossPayout : null,
        status: ownCheck?.status || 'unknown',
      };
      if (isHost) {
        fundingStatuses = players.map(player => ({
          seatId: String(player.id),
          status: HOST_FUNDING_STATUSES.has(financialChecks.get(player.id)?.status)
            ? financialChecks.get(player.id).status : 'unknown',
        }));
      }
    }
    const requiresConnected = !['the-gang', 'uno-112'].includes(gameId);
    if (players.some(player => !player.ready)) addUnique(blockers, 'NOT_READY');
    if (requiresConnected && players.some(player => !player.connected)) addUnique(blockers, 'PLAYER_OFFLINE');
  } else if (pokerWager) {
    const stack = Number.isSafeInteger(viewer.stack) && viewer.stack >= 0 ? viewer.stack : null;
    const minimumAdditionalBuyIn = stack === null ? null : pokerBuyInMinimum(stack);
    const shortfall = minimumAdditionalBuyIn === null || !viewerWallet
      ? null : Math.max(0, minimumAdditionalBuyIn - viewerWallet.available);
    const ownStatus = stack === null || !viewerWallet ? 'unknown' :
      minimumAdditionalBuyIn === 0 || shortfall === 0 ? 'sufficient' : 'insufficient';
    funding = {
      mode: 'poker-buy-in', currency: 'chip', amountToHold: null,
      shortfall, status: ownStatus,
      stack, minToStart: BIG_BLIND, minBuyIn: MIN_BUY_IN, maxBuyIn: MAX_BUY_IN,
      minimumAdditionalBuyIn,
      maximumAdditionalBuyIn: stack === null ? null : Math.max(0, MAX_BUY_IN - stack),
    };
    const checks = isHost ? players : [viewer];
    eligibilityStatuses = checks.map(player => ({ seatId: String(player.id), ...pokerEligibility(player) }));
    if (isHost) {
      const eligibleCount = eligibilityStatuses.filter(item => item.eligible).length;
      if (eligibleCount < 2) addUnique(blockers, 'POKER_MIN_ELIGIBLE', { minimumPlayers: 2, eligibleCount });
    }
  } else {
    const requiresConnected = !(gameId === 'the-gang' || (gameId === 'uno' && variant === 'classic-local-v1'));
    if (players.some(player => !player.ready)) addUnique(blockers, 'NOT_READY');
    if (requiresConnected && players.some(player => !player.connected)) addUnique(blockers, 'PLAYER_OFFLINE');
  }

  // The client receives host evaluation details and per-seat funding labels only
  // when this authenticated seat owns the host role. Guests receive no peer
  // financial status or global reason list.
  const evaluation = {
    allowed: isHost && blockers.length === 0,
    blockers: isHost ? blockers : [],
  };
  const payload = {
    schemaVersion: 1,
    room: {
      code: String(room.code), gameId, variant, phase: String(room.phase || ''),
      revision: Number.isSafeInteger(room.revision) ? room.revision : null,
      minPlayers: minimumPlayers, maxPlayers: maximumPlayers, requiresWagerSafety,
    },
    seats,
    viewer: {
      seatId: String(viewer.id), isHost,
      wallet: ownCurrency && viewerWallet ? { currency: ownCurrency, ...viewerWallet } : null,
      funding,
    },
    evaluation,
    storage: { canStartWager: isHost && requiresWagerSafety ? effectiveStorageSafety : null },
  };
  if (isHost && fundingStatuses) payload.host = { seatFunding: fundingStatuses };
  if (isHost && eligibilityStatuses) payload.host = { ...(payload.host || {}), seatEligibility: eligibilityStatuses };
  return payload;
}

module.exports = { buildRoomPreflight };
