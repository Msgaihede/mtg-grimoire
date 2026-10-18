-- The Discord integration's second PR (issue #1096, spec
-- `docs/superpowers/specs/2026-10-17-discord-integration-design.md`, §12): the signed roster
-- document's chain, and the two pairing slots that carry a device's signing key.
--
-- **Two `CREATE TABLE`s and nothing else**, which is this folder's rule (`README.md`): the
-- previous release's code runs on this schema for the moment between the apply and the deploy,
-- and it reads neither table.

-- One row per roster document (RD) a group has published: the RD as the exact string a device
-- sent — it is verified over those bytes and served as them, never re-serialised — and the one
-- authenticator it came with, `mac` (open mode; the relay holds no group key and cannot check it)
-- or `sig` (Ed25519 by the RD's `signer`, which the relay does check once the group is signed).
--
-- **One chain per group, ordered by `(epoch, step)`**: a rotation starts an epoch at step 0 and
-- an amendment at the same epoch takes the next step. The primary key is what makes two writers
-- racing for one position land one row, and `src/roster.ts`'s guarded `INSERT` is what keeps the
-- chain linear past that. **No second index**: every read is `WHERE group_id = ?` ordered by
-- `epoch` and `step` — the newest, or every one from an epoch on — which is this key's own order,
-- walked forwards or backwards.
--
-- **No `CHECK` on anything.** The RD's shape is `roster.ts`'s to judge before a row is written,
-- and a closed set here would be the next migration's rebuild — the trap the table below exists
-- because of.
CREATE TABLE IF NOT EXISTS rosters (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  step       INTEGER NOT NULL,
  roster     TEXT    NOT NULL,
  mac        TEXT,
  sig        TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch, step)
);

-- The pairing rendezvous's two new slots, `offersig` and `joinsig`: each side's signing key and
-- protocol level, sealed under `pair_key` like the two blobs beside them (spec §4, *Pairing*).
--
-- ⚠️ **A table of its own, and not two more rows in `pairing_rendezvous`, because that table
-- cannot take them.** Its `slot` is `CHECK (slot IN ('offer', 'join'))` (`../schema.sql`, which
-- production holds), and SQLite cannot widen a `CHECK` with `ALTER TABLE`: the only way to admit a
-- third value there is to rebuild the table — create, copy, drop, rename — which this folder's
-- *additive only* rule forbids for the reason it gives, and which would race every pairing in
-- flight. So the new slots live here, with the same shape, the same key and the same ten minutes,
-- and `rendezvous.ts` picks the table by the slot. **This one has no `CHECK`**, so the next slot
-- is a line in `rendezvous.ts` and not a third table: the set of slots is the Worker's to close.
CREATE TABLE IF NOT EXISTS pairing_slots (
  rv         TEXT    NOT NULL,
  slot       TEXT    NOT NULL,
  blob       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rv, slot)
);
