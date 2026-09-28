-- The reconciliation's queue: a column and the partial index that reads it. Run as TWO
-- `--command`s, in this order, never through --file:
--
--   npx wrangler d1 execute mtg-grimoire-relay --remote \
--     --command "ALTER TABLE entitlements ADD COLUMN reconciled_at INTEGER"
--   npx wrangler d1 execute mtg-grimoire-relay --remote \
--     --command "CREATE INDEX IF NOT EXISTS entitlements_reconcile ON entitlements (reconciled_at, subject) WHERE status <> 'dead'"
--
-- **Two, and the order is forced.** The index names the column, so it cannot be created first.
-- And they are not one --file because `wrangler d1 execute --file` is atomic: D1 has no
-- `ADD COLUMN IF NOT EXISTS`, so on a database the `ALTER` has already reached — by an earlier
-- `--command`, say — a second run answers "duplicate column name" and rolls the index back with
-- it, and the column is there with nothing to read it. That is the 2026-08-30 failure one table
-- over. As two commands, a duplicate-column error is the correct answer on a re-run and costs
-- nothing else, and the index is `IF NOT EXISTS` and safe to repeat on its own.
--
-- Additive: every existing row reads NULL, which `reconcile` reads as *never reconciled* and
-- puts at the front of the queue — so the first hourly passes after the deploy work through the
-- whole live table `RECONCILE_BUDGET` rows at a time, reaching subjects the old pass never got
-- to, and settle into each subject about once a day once they have.
--
-- Apply BOTH before the deploy that ships the budgeted `reconcile`, and check the column landed
-- with `--command "SELECT reconciled_at FROM entitlements LIMIT 0"` — empty is the pass, and
-- `no such column` means the `ALTER` did not run. A Worker on a database without the column fails
-- quietly rather than loudly: nothing a device calls reads it, so sync is untouched, but every
-- hourly `scheduled` throws on the `SELECT` — no subject is reconciled, and the pairing
-- rendezvous sweep that runs after it in `index.ts` never runs either. A missing index costs
-- nothing but speed. The reverse order costs nothing at all: a column and an index nothing reads
-- yet are inert.
ALTER TABLE entitlements ADD COLUMN reconciled_at INTEGER;

CREATE INDEX IF NOT EXISTS entitlements_reconcile
  ON entitlements (reconciled_at, subject) WHERE status <> 'dead';
