-- The group-key store, as a migration that can be run twice.
--
-- **Why this is not just `schema.sql` again.** `wrangler d1 execute --file` applies the file
-- **atomically**: one failing statement rolls the whole thing back. `schema.sql` ends with two
-- `ALTER TABLE ... ADD COLUMN`, D1 has no `ADD COLUMN IF NOT EXISTS`, and adding a column that is
-- already there is an error — so on any database that has already had those columns added, the
-- `ALTER`s fail and take `CREATE TABLE group_keys` down with them, even though the CREATE comes
-- first in the file and would have succeeded on its own.
--
-- That is not a hypothetical. It happened on the 2026-08-30 deploy: `wrangler deploy` landed,
-- `/g/{group}/keys` went from 404 to a **500**, and `authIsRecent`'s
-- `SELECT auth FROM group_keys` was throwing `no such table` against a Worker whose schema
-- execute had reported nothing wrong. `schema.sql`'s own comment said the re-run error was one
-- "the deploy runbook expects and ignores". It is not ignored; it reverts.
--
-- Every statement here is `IF NOT EXISTS`, so this file is safe to run any number of times. The
-- two `ALTER`s are deliberately **not** in it — run them one per `--command` so that each can
-- fail alone and harmlessly:
--
--   npx wrangler d1 execute mtg-grimoire-relay --remote \
--     --command "ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER"
--   npx wrangler d1 execute mtg-grimoire-relay --remote \
--     --command "ALTER TABLE entitlements ADD COLUMN group_auth TEXT"
--
-- "duplicate column name" from either is the correct answer on a database that already has it,
-- and it now costs nothing else.

CREATE TABLE IF NOT EXISTS group_keys (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  auth       TEXT    NOT NULL,
  keys       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
);

CREATE INDEX IF NOT EXISTS group_keys_by_group ON group_keys (group_id, epoch DESC);
