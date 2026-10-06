# A03 implementation review — 2026-10-06

**Status: complete.** A03 reconnect, turn timeout, UI, and documentation work is released for A04 to continue its separate store, route, and profile UI integration. No commit, push, or deployment was performed.

## Delivered

- Added persisted per-seat reconnect deadlines, restore helpers, and manager-authenticated server-action sockets in `src/platform/reconnectGrace.js`.
- Added the shared authoritative 30-second turn clock and deterministic per-game timeout actions. An offline actor is acted on at its grace deadline. A failed coin-room commit restores the pre-action room and wallet state, records a retry time, and waits 30 seconds before trying again.
- Applied reconnect state to The Gang, Poker, Tiến lên, Sâm lốc, Phỏm, BANG!, and both UNO variants. Poker’s reconnect pause applies only to live seats in the hand; an all-in seat remains in its hand and pot.
- Kept the existing UNO immediate cancel-and-leave action. Added a separate after-hand queue action for both explicit UNO variants; queued seats remain participants until the result is recorded.
- Kept UNO reaction windows on their absolute server deadlines across disconnects and restarts.
- Added the reconnect status banner, countdown, game-specific policy, and after-hand queue status. Public state assertions cover private-card privacy.
- Updated game rule pages and added `docs/rules/reconnect-lifecycle.md`.
- Added `test/audit-a03-reconnect-lifecycle.test.js` and `scripts/a03-lifecycle-browser-check.js`.

## Verification

- `node --test test/audit-a01.test.js test/audit-a03-reconnect-lifecycle.test.js test/review-regressions.test.js` — **66 passed, 0 failed**. This includes SQLite write-fault rollback through wrapped cleanup, retry gating, grace waiters, restart deadlines, UNO queue/cancel behavior, one-time coin settlement, and private-state checks.
- `node scripts/a03-lifecycle-browser-check.js` — **passed**. The browser check covers staggered reconnect deadlines and visible countdowns in Tiến lên, queued leave, grace protection, automatic turn progression, and Poker’s disconnected-seat fold while the other two seats continue.
- `node --check test/audit-a03-reconnect-lifecycle.test.js` and `node --check scripts/a03-lifecycle-browser-check.js` — **passed**.
- `node --test test/audit-a01.test.js` — **25 passed, 0 failed** after making its child-process crash fixture deterministic and checking that the intended active room and holds exist at the after-commit boundary.
- `node --test test/audit-a02-reconnect.test.js` — **3 passed, 0 failed**.
- Updated the legacy schema fixture in `test/review-regressions.test.js` to remove the version-4 tutorial table when simulating version 1 and assert migration to schema 4; the targeted suite above passes.

## Full-suite status

The latest `npm test` run reports **251 passed, 10 failed out of 261**. All ten failures are in `test/preflight.test.js`; `public/js/preflight.js` rejects their incomplete fixture payloads with `Dữ liệu preflight thiếu trạng thái phòng cần thiết.` The A01, A03, and review-regression tests pass in the focused run above. The preflight integration failures are outside A03’s released engine scope.

## Scope handoff

A04 may continue with its store, API route, and profile UI integration. A03’s room engines, reconnect helpers, turn clock, timeout actions, completed-seat handling, UNO clients, and reconnect rule pages are released. Keep B02/B04/B05-owned files with their current owners.
