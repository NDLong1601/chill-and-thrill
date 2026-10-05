# Workspace

Work in `C:\Users\PC\Documents\chill-and-thrill` for this project. Use an explicit
working directory when a tool's default directory still points to an older copy.

Read `docs/migrations/M0-M3-merge.md` before changing shared room, profile, or UNO
code. The merged project keeps M4–M6 and two explicit UNO variants. All games and
the portal use one `ProfileStore`/chip ledger; do not introduce a separate wallet
database when extending the imported portal APIs.

Preserve existing work and local player data. Use temporary databases and room
files for tests. Keep historical game IDs, tokens, and legacy links compatible.
