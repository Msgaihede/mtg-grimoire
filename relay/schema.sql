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
