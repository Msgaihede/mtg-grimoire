# The share Worker's D1 migrations

`release.yml`'s `share-deploy` runs `wrangler d1 migrations apply mtg-grimoire-relay --remote`
from `infrastructure/share-worker` before it deploys. The database is the relay's; this Worker's
list is kept in a table of its own, `d1_migrations_share`, so neither list can mark the other's
file as applied.

The rules are the relay's — `../../relay/migrations/README.md`: `../schema.sql` is the baseline
and is never edited, a file is `NNNN_what-it-does.sql`, additive only, applied once.
