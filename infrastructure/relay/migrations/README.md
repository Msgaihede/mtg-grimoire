# The relay's D1 migrations

`release.yml`'s `relay-deploy` runs `wrangler d1 migrations apply mtg-grimoire-relay --remote`
from `infrastructure/relay` before it deploys. wrangler applies every `.sql` file here that the
table `d1_migrations` does not name yet, in name order, and records it. A file runs once.

**The first release run with the infra token creates the tables `d1_migrations` and
`d1_migrations_share` in the production D1**, even though no migration is pending: a write to
the live database, harmless, by design.

- **`../schema.sql` is the baseline and is never edited.** It is the shape production holds: the
  database was built from it by hand, and on 2026-10-11 `sqlite_master` of the live database
  was compared with it, and matched (`docs/reference/ci-and-releases.md`).
  `scripts/d1-migrations.test.ts` pins its hash; a red hash means the change belongs in a new
  file here.
- **Name a file `NNNN_what-it-does.sql`**: four digits, the next number, lower case and hyphens.
  The same test refuses a number used twice and a gap.
- **Additive only.** The migration is applied before the deploy, so for a moment the previous
  release's code runs on the new schema: add a column or a table, never drop or rename one.
- **Nothing undoes it.** A re-run applies nothing that the table already names, and the way
  back is D1's Time Travel, by hand.
- **A file that fails is not fixed by a re-run.** The job runs the same commit and fails the
  same way. The fix is a corrected file in a new release (and, if part of it took effect, D1's
  Time Travel, by hand).
- **A deploy by hand between releases**, of a tree with a pending file here, applies it first
  with `wrangler d1 migrations apply mtg-grimoire-relay --remote` (the owner's command) —
  never `d1 execute --file`, which runs the SQL without recording it, so the next release
  would run the file again.
- **`../applied-by-hand/` is history**: the five migrations run by hand before this folder was
  tracked, each already in `schema.sql`. Nothing reads them.

No agent applies one to production: `--remote` is the release's, or the owner's.
