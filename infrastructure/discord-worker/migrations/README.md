# The Discord front's D1 migrations

The database is the relay's (`mtg-grimoire-relay`); this Worker's list is kept in a table of its
own, `d1_migrations_discord`, so neither the relay's list (`d1_migrations`) nor the share
Worker's (`d1_migrations_share`) can mark one of these files as applied, or this list one of
theirs.

**No release applies these.** No job of `release.yml` deploys this Worker (`../README.md`,
_Deploying_), so the owner applies them, from `infrastructure/discord-worker`, before the deploy
that needs them:

```
node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --remote
```

The rules are the relay's — `../../relay/migrations/README.md` — with one difference: there is
no `schema.sql` baseline, because these tables did not exist before this list. A file is
`NNNN_what-it-does.sql`, additive only, applied once; never `d1 execute --file`, which runs the
SQL without recording it. `scripts/d1-migrations.test.ts` holds the names and applies the whole
chain to an empty database after the relay's and the share Worker's, and this Worker's suite
stands its D1 up from the same files (`../src/fake.ts`).

No agent applies one to production: `--remote` is the owner's.
