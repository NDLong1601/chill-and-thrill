# Reconnect and turn lifecycle

The server stores a reconnect deadline for each disconnected seat. The standard grace period is 120 seconds. Repeated page loads, room reloads, and server restarts keep the original deadline; they do not start a new grace period.

## During the grace period

Games that need the missing seat’s decision pause their active turn and show the affected players and remaining time. Each offline seat keeps its own deadline, so one player’s expiry does not remove another player’s remaining grace period. Poker ignores disconnected seats that are sitting out, folded, or otherwise no longer active in the hand. An all-in seat remains part of the hand and its pot.

The server remains authoritative for the turn clock. Connected turns have a 30-second deadline. UNO reaction windows use their own absolute server deadlines and continue while a player reconnects or the server restarts.

## At grace expiry

The game applies a legal, repeatable action when the disconnected seat can act:

- **The Gang:** the active heist returns to the lobby and only expired seats are removed.
- **Poker:** check when there is nothing to call; fold when the seat owes a call. An all-in seat stays eligible for its existing pot.
- **Tiến lên and Sâm lốc:** make a legal play, or pass when responding to another play. Sâm lốc’s declaration window keeps its own deadline.
- **Phỏm:** draw or eat, lay down a valid meld plan when required, and discard only a legal card.
- **BANG!:** resolve the pending response with a legal server action and finish the turn safely.
- **UNO:** choose a default color, resolve the active turn, or accept a penalty. Reaction windows keep their own deadlines.

If an action cannot be committed to storage, the room and wallet transaction roll back together. The server logs the failure and retries after 30 seconds rather than repeating the action on every timer tick.

## Leaving UNO

The existing **Hủy ván & rời** action still cancels the current round and leaves immediately. **Rời sau ván** is a separate action that records a queued departure; the seat remains in the completed match and is removed only after the result has been recorded.

## Privacy and money

Reconnect banners show status and policy but do not reveal private cards. Fixed-stake coin games continue using the shared profile store and coin ledger. Reservations remain attached to the match until its result is committed and settled.

## Recovering after a server interruption

The Gang, both UNO variants and BANG! save their private room state in the existing shared SQLite database before publishing a start, action or result. If a commit fails, the server restores the room and suppresses the failed action's updates; the player can retry without consuming the action receipt. Restart restores the same cards, phase and pending decisions, and keeps the saved reconnect deadline. A committed room closure prevents an old JSON file from reopening that room.

The existing JSON room files remain compatible exports and legacy recovery inputs. A failed export produces a storage warning while the committed SQLite snapshot remains safe. Unreadable legacy inputs are preserved and reported for the host to inspect. Backups must still contain the shared database and all room files, and restore into a new directory.
