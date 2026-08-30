-- The device roll, as a migration that can be run twice.
--
-- **Why this is not just `schema.sql` again**, and it is the same answer
-- `2026-08-30-group-keys.sql` gives at length: `wrangler d1 execute --file` applies the file
-- **atomically**. `schema.sql` ends with two `ALTER TABLE ... ADD COLUMN`, D1 has no
-- `ADD COLUMN IF NOT EXISTS`, and adding a column that is already there is an error — so on any
-- database those columns have already reached, the `ALTER`s fail and take every `CREATE` above
-- them down too, including this one, even though it comes first in the file and would have
-- succeeded on its own.
--
-- That is not a hypothetical: it is what the 2026-08-30 deploy did. `wrangler deploy` landed,
-- `/g/{group}/keys` went from a 404 to a **500**, and `SELECT auth FROM group_keys` was throwing
-- `no such table` against a Worker whose schema execute had reported nothing wrong. The one new
-- table in that change was the one the rollback ate.
--
-- **This file has no `ALTER` at all, which is what makes it uneventful.** `group_devices` is a
-- new table and needs no column added to an existing one, so there is nothing here that can fail
-- on a second run and nothing to run one statement at a time. Apply it with:
--
--   npx wrangler d1 execute mtg-grimoire-relay --remote \
--     --file=./relay/migrations/2026-08-30-group-devices.sql
--
-- Run it **before** the deploy that ships `admitDevice`, not after. A Worker calling `/token` on
-- a database without this table answers 500 on the route every device uses to sync, where the
-- reverse order costs nothing: a table nothing writes to yet is inert.

-- See `relay/schema.sql` for what each column is for and why there is no name column. In short:
-- one table answers both caps because a subject holds exactly one group, and `last_seen` is what
-- stops a wiped data folder — which mints a *new* device id — costing a reader a slot for ever.
CREATE TABLE IF NOT EXISTS group_devices (
  group_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
