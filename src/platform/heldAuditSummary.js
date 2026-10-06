'use strict';

// Diagnostics only: never release a reservation or modify a recovery source.
function summarizeHeldReservations(store, { legacyRooms = [] } = {}) {
  return store.recordStorageRead('profile-store', 'all-held-audit', () => {
    const fixed = store.auditFixedGameHolds({ legacyRooms });
    const fixedStatus = new Map(fixed.flatMap(group => group.holds.map(hold => [hold.reservationId, !group.needsAttention])));
    const poker = new Map(store.gameSnapshots('poker').map(snapshot => [snapshot.roomCode, snapshot]));
    const rows = store.db.prepare(`SELECT id AS reservationId, profile_id AS profileId,
      room_code AS roomCode, operation_key AS operationKey, amount, currency
      FROM reservations WHERE status = 'HELD'`).all();
    let needsAttention = 0;
    for (const row of rows) {
      if (fixedStatus.has(row.reservationId)) {
        if (!fixedStatus.get(row.reservationId)) needsAttention++;
        continue;
      }
      let linked = false;
      const snapshot = poker.get(row.roomCode);
      if (snapshot && !snapshot.closedAt && row.currency === 'chip' && row.operationKey.startsWith('poker:buyin:')) {
        try {
          const room = JSON.parse(snapshot.stateJson);
          linked = room.code === row.roomCode && room.gameId === 'poker'
            && ['WAITING', 'HAND', 'RESULT'].includes(room.phase)
            && Array.isArray(room.players) && room.players.some(player => player.profileId === row.profileId
              && Array.isArray(player.reservations) && player.reservations.some(hold =>
                hold.reservationId === row.reservationId && hold.profileId === row.profileId
                && hold.amount === row.amount));
        } catch { /* Invalid snapshots are retained for review, never repaired here. */ }
      }
      if (!linked) needsAttention++;
    }
    return { total: rows.length, needsAttention };
  });
}

module.exports = { summarizeHeldReservations };
