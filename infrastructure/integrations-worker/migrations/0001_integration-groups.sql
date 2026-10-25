-- The groups that have an integrations store (`src/store.ts`), one row each: written by
-- `PUT /g/{group}/settings` before the store is made, deleted by `DELETE /g/{group}` after it
-- is emptied, and read by the daily lapse pass (`src/lapse.ts`), which empties the store of a
-- group whose membership no longer serves. A row is the pass's index and not the switch — the
-- switch is the store itself, in the group's Durable Object — so a row with no store behind it
-- costs one empty `deleteAll` and is forgotten.
--
-- `created_at` is Unix milliseconds, and the order a backlog drains in: oldest store first.
--
-- Additive: a table of its own on the relay's database, which nothing else reads or writes.
CREATE TABLE IF NOT EXISTS integration_groups (
  group_id   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
