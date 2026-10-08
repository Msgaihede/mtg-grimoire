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
  refresh_secret TEXT,                     -- NULL once revoked, or once its device is off the
                                           -- roster; minted afresh by every claim
  patreon_refresh TEXT,                    -- for the cron's reconciliation
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

-- The device roll: which devices have presented a token for this group, and when they last did.
--
-- **One table answers both caps, because a subject holds exactly one group.** Five devices per
-- Patreon account and five devices per sync group are the same count asked twice — `/claim` binds
-- a subject to one group and a re-claim *moves* that binding rather than adding a second — so
-- counting rows here answers either question without the relay ever having to join a device to a
-- subscription.
--
-- **It holds ids and timestamps and nothing else, deliberately.** What a device is called is
-- `device_names`, which is synced end-to-end between the devices; the relay never sees it. A
-- roster the reader can read is a job for the app, and giving this table a `name` column would
-- hand the relay a fact it currently cannot learn.
--
-- **`last_seen` is what stops a reinstall costing a slot for ever.** A device whose data folder
-- is wiped mints a *new* id at `identity::ensure`, so its old row is named by no manifest and
-- freed by no rotation: five reinstalls would exhaust a reader's own account permanently. A row
-- unseen for `DEVICE_TTL_MS` (90 days) is not counted and is deleted by the same read that
-- counts. Ninety days is chosen against the case it must not break — a laptop put in a drawer for
-- a season and brought back — and against the one it must: a machine sold a year ago.
--
-- **`first_seen` is written and never read.** It is here because the row is cheap and the
-- question "when did this device join" is one a support conversation asks and nothing else can
-- answer once `last_seen` has moved.
CREATE TABLE IF NOT EXISTS group_devices (
  group_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

-- **No second index, unlike `group_keys` above, and the difference is not an oversight.** Every
-- read here names one group and nothing else: the count, the TTL prune, the manifest sweep and
-- the whole-group drop are all `WHERE group_id = ?` or that plus an equality on `device_id`.
-- SQLite builds an automatic index for the `PRIMARY KEY` of a rowid table, `group_id` is its
-- leading column, and `(group_id, device_id)` covers the only column the count reads — so a
-- `group_devices_by_group` would serve no query the primary key does not already serve, at the
-- cost of a second b-tree write on every `/token`, which is the hottest route the relay has. The
-- implementation plan asked for one; spec §4.1's table does not, and this follows the spec.

-- Added 2026-08-30. `ALTER TABLE` and not an edit to the CREATE above: that statement is
-- `IF NOT EXISTS` and does nothing at all on a database that already holds the table, so a new
-- column written there reaches a fresh deploy and never an existing one.
--
-- ⚠️ **The `ALTER`s are last in the file, and on a database that already has them they take the
-- whole file down with them.** `wrangler d1 execute --file` is **atomic**: D1 has no
-- `ADD COLUMN IF NOT EXISTS`, a duplicate column is an error, and one error rolls back every
-- statement above — including `CREATE TABLE group_keys`, which would have succeeded alone. This
-- comment said the re-run error was one "the deploy runbook expects and ignores"; it is not
-- ignored, and on 2026-08-30 it left a deployed Worker 500ing on `no such table: group_keys`
-- after an execute that looked fine.
--
-- **So this file is for a database that has never been migrated.** To bring an existing one
-- forward use `infrastructure/relay/migrations/2026-08-30-group-keys.sql` and run each `ALTER` as its own
-- `--command`, where a duplicate-column error can fail alone.

-- The pairing rendezvous: a short-lived meeting point for the two blobs an X25519 handshake
-- exchanges, so a reader retypes one code instead of two. Ten minutes and no authentication —
-- `infrastructure/relay/src/rendezvous.ts` carries the argument for standing ahead of the bearer gate. No second
-- index: every read names `(rv, slot)` or `rv` alone, and the primary key's automatic index
-- covers both.
CREATE TABLE IF NOT EXISTS pairing_rendezvous (
  rv         TEXT    NOT NULL,
  slot       TEXT    NOT NULL CHECK (slot IN ('offer', 'join')),
  blob       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rv, slot)
);

-- **`IF NOT EXISTS` still keeps this table above the `ALTER TABLE` lines below.** Nothing
-- about a `CREATE TABLE IF NOT EXISTS` needs to run last; the ordering rule this file's own
-- comment states is about the statements that are NOT idempotent, and this one is not one of
-- them. Adding a table below them would only cost a reader the moment it took to check.
ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER;
ALTER TABLE entitlements ADD COLUMN group_auth  TEXT;

-- The device `/claim` handed `refresh_secret` to, so that `/rotate` can retire the secret when a
-- manifest it adopts omits that device — a removed device keeps whatever its `user.db` holds, and
-- the secret opens `/token`'s refresh door. NULL beside a live secret is a row claimed before this
-- column existed, and the next accepted rotation retires that secret whatever its manifest says.
-- On an existing database this is `infrastructure/relay/migrations/2026-09-26-refresh-device.sql`, run as its
-- own `--command` for the reason the paragraph above the first `ALTER` gives.
ALTER TABLE entitlements ADD COLUMN refresh_device TEXT;

-- When the cron last tried to reconcile this subject with Patreon — **tried**: `reconcile` stamps
-- every row it selects before attempting any of them, so a row whose attempt throws goes to the
-- back of the queue rather than heading it for ever. NULL is *never*, and is what every existing
-- row reads on the day this lands, which is also the front of the queue: SQLite sorts NULL below
-- every value, so `ORDER BY reconciled_at` asks about the never-asked first.
--
-- ⚠️ **Its own column, and not `checked_at`, which looks like the same fact and is not.**
-- `/token` stamps `checked_at` on every trip, so ordering by it would put the subjects actually
-- syncing — the only ones a missed cancellation costs anything — permanently at the back.
--
-- On an existing database this is `infrastructure/relay/migrations/2026-09-28-reconciled-at.sql`: this `ALTER`
-- and then the index below, each as its own `--command`, for the reason the paragraph above the
-- first `ALTER` gives.
ALTER TABLE entitlements ADD COLUMN reconciled_at INTEGER;

-- The hourly pass's queue: live rows, least recently reconciled first, which is `reconcile`'s
-- `WHERE status <> 'dead' … ORDER BY reconciled_at, subject LIMIT ?` read straight off an index.
--
-- **The one statement in this file below an `ALTER`, and it has to be**: it indexes the column the
-- `ALTER` above adds. It is idempotent itself; what makes it safe here is only that this file is
-- for a database that has never been migrated, where nothing above it can fail.
--
-- **Partial, on `status <> 'dead'`, because the rows it leaves out are the table's growing half.**
-- Nothing deletes a lapsed subject, so dead rows only accumulate, and the pass never selects
-- one. Measured on SQLite 3.45.1 (Python's `sqlite3`, not D1) over 20 000 rows: without an index
-- the query is `SCAN entitlements` plus `USE TEMP B-TREE FOR ORDER BY` — every row read and
-- sorted, dead ones included, twenty-four times a day — and with this one it is
-- `SCAN entitlements USING INDEX entitlements_reconcile` with no sort, stopping at the `LIMIT`: a
-- few hundred VM steps against about 220 000 with a backlog, and dead rows never visited at all.
-- With nothing due it still walks every live entry, because the `IS NULL OR <` gives the planner
-- no range to stop at.
--
-- **It costs the hot route nothing.** SQLite maintains an index only when an `UPDATE` writes one
-- of its columns or a column of its `WHERE`; `/token`'s `SET checked_at = ?` writes neither and
-- was measured doing no index insert or delete. What pays is the rare writer of `status` or
-- `reconciled_at` — a claim, a webhook, a revocation, the cron itself.
CREATE INDEX IF NOT EXISTS entitlements_reconcile
  ON entitlements (reconciled_at, subject) WHERE status <> 'dead';
