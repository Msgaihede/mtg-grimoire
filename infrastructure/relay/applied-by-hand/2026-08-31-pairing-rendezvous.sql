-- Run as its OWN --command. `wrangler d1 execute --file` is atomic and a duplicate-object error
-- rolls back every statement in the file; on 2026-08-30 that left the deployed Worker 500ing on
-- `no such table: group_keys` after an execute that looked fine.
CREATE TABLE IF NOT EXISTS pairing_rendezvous (
  rv         TEXT    NOT NULL,
  slot       TEXT    NOT NULL CHECK (slot IN ('offer', 'join')),
  blob       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rv, slot)
);
