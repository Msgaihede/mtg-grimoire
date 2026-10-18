-- The Discord front's two tables (issue #1096, the design's §13.3), in the relay's D1 database
-- beside the relay's and the share Worker's — the share Worker's arrangement, so no new database
-- has to be created. Every name starts `discord_`, so nothing here can collide with a table of
-- theirs, and this Worker reads none of theirs.
--
-- A first file and no `schema.sql` baseline: these tables never existed before this list, so the
-- list is the whole history and `scripts/d1-migrations.test.ts` applies it to an empty database
-- after the relay's and the share Worker's. Additive, like every file in a tracked folder
-- (`../../relay/migrations/README.md`).
--
-- **No collection, no key, no Discord token is stored here.** The bot's identity and the
-- reader's data are the bot device's Durable Object's; this database knows who is linked to which
-- object, and a sign-in while it is in flight.

-- A sign-in in progress: `POST /link/begin` writes one, Discord's redirect to
-- `/oauth/discord/callback` names who signed in on it, and `POST /link/claim` deletes it as it
-- mints the link. Ten minutes long; an expired row is deleted when it is next read, on every
-- begin, and by the daily sweep.
--
-- `challenge` is base64url(sha256(verifier)), never the verifier: the claim proves it holds the
-- verifier, which is what stops whoever saw `state` in a browser's address bar from claiming the
-- link first. `state` moves `pending → authorized` (the callback named a user) or
-- `pending → denied` (the reader pressed Cancel on Discord's page); a user is named exactly when
-- it is `authorized`.
CREATE TABLE IF NOT EXISTS discord_link_requests (
  code            TEXT PRIMARY KEY,
  challenge       TEXT NOT NULL CHECK (length(challenge) = 43),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'authorized', 'denied')),
  discord_user_id TEXT,
  username        TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((state = 'authorized') = (discord_user_id IS NOT NULL AND username IS NOT NULL))
);
-- The sweep's `expires_at <= ?`.
CREATE INDEX IF NOT EXISTS discord_link_requests_expiry ON discord_link_requests (expires_at);

-- One link per Discord account, and one bot Durable Object per link.
--
-- `secret_hash` is the SHA-256 of the link secret as 64 lower-case hex characters: the secret is
-- answered once, to the desktop, and kept nowhere here; a bearer is found by its hash. Linking
-- again replaces it, so the old one stops working the moment the new one is answered.
--
-- `do_id` is the Durable Object's id as `DurableObjectId.toString()` spells it, minted with
-- `newUniqueId()` when the account's link is first claimed and **kept by a link again** — the bot
-- enrolled in the reader's group stays the same device. Unlinking deletes the row after the
-- object's storage, so a link after that mints a fresh object.
CREATE TABLE IF NOT EXISTS discord_links (
  discord_user_id TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  secret_hash     TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  do_id           TEXT NOT NULL UNIQUE CHECK (length(do_id) = 64),
  created_at      INTEGER NOT NULL
);
