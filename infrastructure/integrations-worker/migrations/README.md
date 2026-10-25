# The integrations Worker's D1 migrations

`release.yml`'s `integrations-deploy` runs `wrangler d1 migrations apply mtg-grimoire-relay --remote`
from `infrastructure/integrations-worker` before it deploys. The database is the relay's; this
Worker's list is kept in a table of its own, `d1_migrations_integrations`, so no list on that
database — the relay's `d1_migrations`, the share Worker's `d1_migrations_share`, this one — can
mark another's file as applied.

The rules are the relay's — `../../relay/migrations/README.md`: a file is
`NNNN_what-it-does.sql`, additive only, applied once. **This Worker has no `schema.sql`
baseline**, unlike the relay and the share Worker: it was never built by hand, so its first
migration is its whole history.
