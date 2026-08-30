-- The relay's entitlement store. Applied with:
--   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
--
-- `subject` is minted here and is NOT the Patreon user id. The Patreon id lives in exactly one
-- column of one table; the token, the group binding and every log line name the subject
-- instead. That is what lets a second source (Paddle) arrive later without a reader losing
-- their group.
CREATE TABLE IF NOT EXISTS entitlements (
  subject        TEXT PRIMARY KEY,
  -- Deliberately **not** CHECKed, unlike `status` below. The comment says a second value is
  -- coming, and SQLite cannot add or drop a CHECK with `ALTER TABLE` — closing this column
  -- would mean rebuilding the table on the day Paddle arrives, which is the friction the
  -- subject indirection exists to avoid. Nothing branches on `source` for entitlement; it is
  -- half of a uniqueness key, and a wrong value there fails as a duplicate, not as a silence.
  source         TEXT NOT NULL,            -- 'patreon' today; 'paddle' later
  external_id    TEXT NOT NULL,
  -- CHECKed because the set is closed *here*: it mirrors `Status` in `entitlement.ts`, which
  -- `decide` exhausts with a `switch`, so a fourth value could only arrive as a typo at a call
  -- site. A subject holding one would be neither serving nor dead, and nothing would say so.
  status         TEXT NOT NULL CHECK (status IN ('active', 'grace', 'dead')),

  -- **Not `> 0` by accident.** `decide` never emits `0`, but a caller spelling
  -- `decision.graceUntil ?? 0` would write one, and a zero here is a deadline that passed in
  -- 1970: a reader whose card was declined is killed on sight instead of getting their seven
  -- days. `decide` guards its own read the same way. The pair is deliberate — the write side
  -- is the one that can be got wrong, and it is not in the file that does the deciding.
  grace_until    INTEGER CHECK (grace_until IS NULL OR grace_until > 0),
  group_id       TEXT,                     -- bound on first claim, trust-on-first-use
  refresh_secret TEXT,                     -- NULL once revoked; this is what revocation clears
  patreon_refresh TEXT,                    -- for the daily reconciliation
  created_at     INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL
);

-- One row per source, so a webhook naming a Patreon user finds the subject in one lookup.
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_external
  ON entitlements (source, external_id);

-- The group binding must be unique too: two subjects bound to one group would each be able to
-- mint tokens for it, which is a shared subscription wearing two names.
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_group
  ON entitlements (group_id) WHERE group_id IS NOT NULL;

-- The short-lived code the OAuth landing page shows the reader. One-time and ten minutes —
-- **and this table enforces neither.** There is no `used` column and no sweep, so both live at
-- the call site: the reader is `expires_at > now`, and single-use means the DELETE happens in
-- the same transaction as the read, never read-then-delete. Two requests racing a read-then-
-- delete both see the code and both claim, which is the one bug this table cannot catch.
CREATE TABLE IF NOT EXISTS claim_codes (
  code       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The group's relay key, per epoch, and the rewrapped keys that go with it.
--
-- **Two homes for one fact, and they answer different questions.** `entitlements.group_auth` is
-- what the group is RIGHT NOW and is what `/token`'s group door compares against; this table is
-- the HISTORY, and it exists because a device that is merely behind a rotation holds an auth
-- that is stale by definition. An endpoint that only accepted the current auth would refuse
-- exactly the devices it exists to serve.
--
-- **`keys` is the manifest and the key distribution in one column**: a JSON object of
-- `device_id -> sealed blob`. Its key SET is the roster at this epoch, which is what makes a
-- removal impossible to disagree about — there is no second table to arrive late or out of order.
-- A device the object does not name is a device that has left.
--
-- **The relay can invert none of it.** `auth` is HKDF-SHA256 of the group key and cannot be run
-- backwards; every blob is sealed to a device's X25519 public key, which the relay does not hold
-- the other half of. This table is one more pile of bytes it cannot open.
CREATE TABLE IF NOT EXISTS group_keys (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  auth       TEXT    NOT NULL,
  keys       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
);

-- Read on every /keys and every /token group door, both by group alone. The `epoch DESC` is for
-- `currentManifest`, which is `ORDER BY epoch DESC LIMIT 1` and is the hottest read here.
CREATE INDEX IF NOT EXISTS group_keys_by_group ON group_keys (group_id, epoch DESC);

-- Added 2026-08-30. `ALTER TABLE` and not an edit to the CREATE above: that statement is
-- `IF NOT EXISTS` and does nothing at all on a database that already holds the table, so a new
-- column written there reaches a fresh deploy and never an existing one.
--
-- ⚠️ **These two are last in the file, and on a database that already has them they take the
-- whole file down with them.** `wrangler d1 execute --file` is **atomic**: D1 has no
-- `ADD COLUMN IF NOT EXISTS`, a duplicate column is an error, and one error rolls back every
-- statement above — including `CREATE TABLE group_keys`, which would have succeeded alone. This
-- comment said the re-run error was one "the deploy runbook expects and ignores"; it is not
-- ignored, and on 2026-08-30 it left a deployed Worker 500ing on `no such table: group_keys`
-- after an execute that looked fine.
--
-- **So this file is for a database that has never been migrated.** To bring an existing one
-- forward use `relay/migrations/2026-08-30-group-keys.sql` and run each `ALTER` as its own
-- `--command`, where a duplicate-column error can fail alone.
ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER;
ALTER TABLE entitlements ADD COLUMN group_auth  TEXT;
