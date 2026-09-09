-- The share index. Applied to the SAME D1 database the relay uses, because the two Workers are
-- separate for blast radius and not because the data is (spec §5.1):
--   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
--
-- ⚠️ One statement per `--command` on a database that already holds part of this, because
-- `wrangler d1 execute --file` is atomic and a duplicate object takes the whole file down —
-- the failure that left a deployed Worker 500ing on 2026-08-30.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  folder_uid  TEXT,
  title       TEXT NOT NULL,
  owner_name  TEXT NOT NULL,
  card_count  INTEGER NOT NULL,
  total_value REAL,
  currency    TEXT,
  marketplace TEXT,
  fields      TEXT NOT NULL,
  -- NULL until the first blob commits. That is what makes a failed upload leave the previous
  -- snapshot serving rather than a broken link.
  object_key  TEXT,
  bytes       INTEGER,
  -- A state and not a `revoked_at` stamp: a lapsed membership darkens a link and a revived one
  -- must light it again, and a timestamp can only be set. `revoked` is the reader's own press
  -- and is terminal; `lapsed` is the cron's and is reversible.
  state       TEXT NOT NULL CHECK (state IN ('live','lapsed','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One share per folder (decision 7). `coalesce` because SQLite treats NULLs as distinct, so a
-- bare unique index would allow any number of whole-collection shares per group.
--
-- ⚠️ **`WHERE state <> 'revoked'` is load-bearing and the plan's version of this line did not
-- have it.** A revoked row **stays** — it is what answers a viewer 410 *"This shared collection
-- was withdrawn"* rather than the 404 that says they mistyped the link — and re-sharing that same
-- folder mints a **new** id, because a revoked link must stay dead. Those two sentences are
-- together a second row for the folder, which a total unique index refuses: the publish that
-- follows any revoke would have died on a constraint violation, as a 500, against the live
-- database and never against `fakeD1` (which models column keys and not expression indexes). The
-- partial index keeps exactly the rule decision 7 asks for — at most one *live or lapsed* share
-- per folder — and lets the tombstones accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS shares_folder
  ON shares (group_id, coalesce(folder_uid, '')) WHERE state <> 'revoked';
CREATE INDEX IF NOT EXISTS shares_group ON shares (group_id);
