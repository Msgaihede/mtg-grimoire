# A release deploys everything — design

**Date:** 2026-10-11 · **Status:** awaiting the owner's review

## 1. Goal

Merging the release PR ships every host and every Worker from that one tag, and leaves the owner
nothing to do by hand afterwards: the desktop builds, the web app, the relay, the share Worker,
and the Android bundle on Google Play's internal track.

Success is: a release run ends with all three Workers serving the tag's code, the tag's bundle on
the internal track, and the release published — or with the release still a draft and a summary
that says which step stopped it.

## 2. Decisions (the owner's, 2026-10-11)

| Question | Decision |
| --- | --- |
| What a release deploys | **Everything.** The relay and the share Worker join the web app; this reverses "the relay and the share Worker are deployed by no job" (2026-10-04). |
| Play Console state | The app exists and **its first bundle was uploaded by hand**, so the upload key is registered and the API can be used. |
| Play track | **Internal**, rolled out there at once. Promotion to closed testing or production stays the owner's click. |
| The relay's D1 schema | **Applied by the job**, through wrangler's tracked migrations, before the deploy. |
| Delivery | One spec, **two pull requests in sequence**: Cloudflare (relay and share Worker) first, the Play upload second. One commit each. |

## 3. What was found (read 2026-10-11)

- **A release already does three of the five.** `release.yml` builds the desktop (`build`),
  builds and deploys the web app (`web`, `web-deploy`), and builds and signs the Android bundle
  (`android`, `android-sign`), which leaves the run as the artifact `play-upload-bundle`.
- **The `release` environment holds five values** (names asked of GitHub): the three
  `ANDROID_*`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The last published release is
  v0.43.0 (2026-10-08).
- **The relay's `schema.sql` cannot be re-run.** It holds four plain `ALTER TABLE … ADD COLUMN`
  statements, and D1 has no `ADD COLUMN IF NOT EXISTS`. So it cannot be handed to production as
  a first tracked migration. The share Worker's `schema.sql` is three `IF NOT EXISTS` statements.
- **The five files in `infrastructure/relay/migrations/` are all applied** to production, by
  hand, the last on 2026-09-28. Each is already folded into `schema.sql`.
- **The share Worker imports one module of the relay's** (`@grimoire/relay/src/token`, which
  imports nothing). A deploy job has no workspace links, so `wrangler` cannot follow it without
  an `alias` — the app Worker's `wrangler.jsonc` already carries one for the same reason.
- **No CI job builds the share viewer.** `pnpm build` type-checks `apps/share`; nothing runs
  `pnpm share:build`, which writes the `apps/share/dist-share` the share Worker's deploy uploads.
- **Pull request 874 is open** and tightens the fence this design extends
  (`scripts/release-rule.test.mjs`: every executed line of a secret-holding job is listed). This
  work builds on it and lands after it.

## 4. The job graph

```
release-please ─┬─ build (windows, linux) ─────────────┐
                ├─ android ── android-sign ────────────┤
                ├─ web ────────────────────────────────┤
                └─ share ──────────────────────────────┤
                                                       ▼
        relay-deploy → share-deploy → web-deploy → play-upload → publish
```

| Job | New | Needs | Reads from the `release` environment |
| --- | --- | --- | --- |
| `share` | yes | `release-please` | nothing |
| `relay-deploy` | yes | `release-please`, `build`, `android-sign`, `web`, `share` | `CLOUDFLARE_INFRA_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `share-deploy` | yes | `release-please`, `share`, `relay-deploy` | `CLOUDFLARE_INFRA_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `web-deploy` | no | adds `share-deploy` to what it needs today | unchanged |
| `play-upload` | yes | `release-please`, `android-sign`, `web-deploy` | `PLAY_SERVICE_ACCOUNT_JSON` |
| `publish` | no | adds `relay-deploy`, `share-deploy`, `play-upload` | nothing |

**Why this order.** Nothing goes live until every host has built at the tag. The relay goes
first because a page that asks a relay without its half fails every request
(`docs/agent/EXTERNAL_SERVICES.md`); the share Worker follows it because it verifies the relay's
tokens; the web app is third. The Play upload is last because it is the one step that cannot be
taken back: Play never accepts a `versionCode` twice.

**The rules every deploy job keeps**, as `web-deploy` does today:

- `environment: release`, and no other job reads a value from it.
- It builds nothing: no pnpm, no cargo, no Gradle, no cache.
- `wrangler` comes from `infrastructure/wrangler/package-lock.json` (`npm ci --ignore-scripts`
  in a step that holds no token) and is run by path.
- Its first step asks whether its values are set, told `true`/`false` and never the value. None
  set: it deploys nothing, says so in the summary and ends green. Some but not all: it fails.
  **For `relay-deploy` and `share-deploy` the token alone decides**: `CLOUDFLARE_ACCOUNT_ID` is
  already set for `web-deploy`, so without that exception every release would fail until the
  new token existed. No token: green, nothing deployed. A token and no account id: it fails.
- It refuses a tag older than the newest published release, so a late re-run cannot put old code
  in front of new.
- A failure leaves the release a draft.

**Considered and not chosen.** One combined job for the relay and the share Worker: fewer lines,
but a re-run redoes both. A second workflow on `release: published`: a failed Worker deploy would
leave a published release with half its hosts, and `on:` would gain a trigger the fence refuses.

## 5. Piece A — the relay and the share Worker (first pull request)

### 5.1 The token

A second token, `CLOUDFLARE_INFRA_API_TOKEN`, used by `relay-deploy` and `share-deploy` and by
nothing else. The web app's token keeps its one-Worker scope. The two Workers share one token
because they already share the D1 database and the signing key.

**The Workers' own secrets stay in Cloudflare.** `PATREON_CLIENT_SECRET`,
`PATREON_WEBHOOK_SECRET` and `RELAY_HMAC_KEY` are never in GitHub; a `wrangler deploy` neither
reads nor changes them.

### 5.2 `share` — the viewer, built at the tag

`pnpm share:build`, a check that `apps/share/dist-share/assets/share.js` exists and is not
empty, and the folder uploaded as the artifact `share-bundle`. No secret. `ci.yml`'s `frontend`
build leg runs the same `pnpm share:build`, so a pull request that breaks the viewer is red
before a tag is.

### 5.3 `relay-deploy`

1. Ask whether the two values are set.
2. Refuse an older tag.
3. Install `wrangler` from the lockfile.
4. `wrangler d1 migrations apply mtg-grimoire-relay --remote`, from `infrastructure/relay`.
5. `wrangler deploy`, from `infrastructure/relay`. The Durable Object's own migrations are in
   `wrangler.jsonc` and go with it, as they do by hand.
6. `node scripts/relay-deploy-probe.mjs`: the runbook's step-0 probes that need no credential,
   each held to the answer this tree's router gives.

**What the probe proves, and what it does not.** It proves the relay is up and routing after the
deploy. The runbook already records that no credential-free probe can tell one version from the
next, so *which* version is live rests on `wrangler deploy` exiting zero; the version id it
prints goes into the summary.

### 5.4 D1 migrations

- **`schema.sql` is the baseline, and it is frozen.** It is the shape production has today. A
  test pins its SHA-256; changing it is a red build whose message says to write a migration.
- **`infrastructure/relay/migrations/` becomes wrangler's tracked folder and starts empty.** The
  D1 binding names it (`migrations_dir`) and the bookkeeping table (`migrations_table`:
  `d1_migrations`). The first automated run therefore finds nothing to apply, and **the owner
  runs no baseline step**. The five applied files move to `infrastructure/relay/applied-by-hand/`
  as history. Git keeps no empty folder, so each tracked folder holds a short `README.md` with
  the rules below; what `wrangler d1 migrations apply` does with a folder of no `.sql` files is
  checked against a local database (`--local`) while this is built, before the job relies on it.
- **A new migration is `NNNN_what-it-does.sql`**, applied once, in name order. The "never through
  `--file`" trap the old files warn about was a re-run on a half-applied database; a tracked file
  never runs twice.
- **A migration must be additive**: it is applied before the deploy, so for a moment the
  deployed code is the previous release's on the new schema.
- **The share Worker gets the same**, with its own folder and its own table
  (`d1_migrations_share`) on the same database, so neither Worker's list can shadow the other's.
- **Local databases follow**: `scripts/web-smoke/sync-harness.mjs` applies `schema.sql` and then
  the tracked migrations, and a relay test builds a database the same way with `node:sqlite`, so
  a migration that does not apply to the baseline fails in a pull request.

### 5.5 `share-deploy`

Download `share-bundle` into `apps/share/dist-share`, check it arrived whole, apply the share
Worker's migrations, `wrangler deploy` from `infrastructure/share-worker`, then
`node scripts/share-deploy-probe.mjs`: the README's five probes, and `/assets/share.js` byte for
byte against the bundle — the one that says this build is what the address serves.

`infrastructure/share-worker/wrangler.jsonc` gains
`"alias": { "@grimoire/relay/src/token": "../relay/src/token.ts" }`, and a test holds the pair
and holds that module to importing nothing.

### 5.6 The fence and the documents

- `scripts/release-rule.test.mjs`: the new graph; which job may read which value; every
  `wrangler` line in any workflow (one becomes five: two `d1 migrations apply`, three `deploy`);
  every executed line of the two new jobs.
- `scripts/ci-route.mjs` and its test: routes for the new probe scripts and for `apps/share`.
- The rule is rewritten wherever it is written: root `CLAUDE.md`, `.github/CLAUDE.md`,
  `docs/agent/EXTERNAL_SERVICES.md`, `docs/reference/ci-and-releases.md`,
  `docs/reference/hosted-relay-deploy.md`, the two Workers' READMEs and the comments in the
  three `wrangler.jsonc` files and in `release.yml`.
- **The agents' rule becomes:** merging the release PR deploys all three Workers, applies any
  pending D1 migration and uploads to Play, and an agent merges it only when asked to. A deploy
  between releases is still by hand and still asked for.

## 6. Piece B — the Play upload (second pull request)

### 6.1 `play-upload`

1. Ask whether `PLAY_SERVICE_ACCOUNT_JSON` is set, and whether `android-sign` signed a bundle (a
   new output of that job). No key: upload nothing, say the bundle is the artifact to upload by
   hand, end green. A key and no signed bundle: say so, end green.
2. Download `play-upload-bundle`.
3. `node scripts/android-release/play-upload.mjs <bundle> <versionCode>` — the only step the key
   reaches. Nothing is installed.

### 6.2 `scripts/android-release/play-upload.mjs`

No dependency: Node's `crypto` signs the service account's JWT, and `fetch` does the rest.

1. Exchange the JWT for an access token (scope `androidpublisher`).
2. Open an edit on `com.mtggrimoire.app`.
3. List the bundles Play holds. **If this `versionCode` is there, discard the edit, say so and
   end green** — a re-run is not an error.
4. List the tracks and what each holds. **If a bundle or a track has a higher `versionCode`,
   discard the edit and end red** — an older release's re-run does not go over a newer build.
   (Added in execution, which makes seven requests of six: §11.)
5. Upload the bundle; refuse to go on if Play read a different `versionCode` from it.
6. Put that `versionCode` on the `internal` track, status `completed`.
7. Commit the edit, and write to the summary what was uploaded and that promotion is the
   owner's click.

A refusal from Google is printed as Google wrote it, with a line for the three known ones: a
service account without the app permission, an app Play still treats as a draft, and a commit
Play will not send for review by itself.

**Why not an action.** A third-party upload action would run its own dependency tree in the step
that holds the key. The rule for these jobs is that every line they run is on a list.

**Tests.** The script's steps take the two base addresses as arguments, and
`play-upload.test.mjs` runs them against a local `node:http` stand-in for Google with a
throwaway RSA key: the JWT verifies, the order of calls is the one above, an already-present
`versionCode` uploads nothing, and each refusal is reported by name.

### 6.3 The fence and the documents

`scripts/release-rule.test.mjs` gains the job, its one value and its lines. The Play spec's §8
("Uploading to Play from CI") and `ci-and-releases.md`'s "the bundle is uploaded by hand" point
here.

## 7. What only the owner does

1. **The Cloudflare token** (before the first release after piece A, or `relay-deploy` and
   `share-deploy` end green having deployed nothing): a custom token on the one account with
   **Workers Scripts: Edit**, **D1: Edit** and **Workers R2 Storage: Edit**; no zone permission,
   both Workers are on `workers.dev`. Then
   `gh secret set CLOUDFLARE_INFRA_API_TOKEN --env release --repo Msgaihede/mtg-grimoire`.
2. **The Play service account** (before the first release after piece B): a Google Cloud project
   with the *Google Play Android Developer API* enabled; a service account with no cloud role;
   a JSON key for it; in Play Console, *Users and permissions* → invite the account's address →
   on *MTG Grimoire*, **Release apps to testing tracks** and nothing above it. Then
   `jq -c . key.json | gh secret set PLAY_SERVICE_ACCOUNT_JSON --env release --repo Msgaihede/mtg-grimoire`,
   and delete the file. The key is stored as one line (§11).
3. **One read of production's D1, or his word to make it**: `sqlite_master` compared with a
   database built from `schema.sql`, before the first release after piece A. Freezing the
   baseline is only right if the file is what production holds. Done 2026-10-11 (§11).

## 8. Not in this design

- Promotion on Play, release notes on Play, and any track but `internal`.
- Deploys between releases: still by hand, still asked for, `pnpm web:deploy-guard` first.
- Rolling a Worker back from a job. `wrangler rollback` stays by hand.
- Setting or rotating a Worker's secret from CI.
- Zone settings and DNS.
- Skipping a Worker whose source did not change since the last release.
- Keyless Google sign-in (workload identity federation) in place of the JSON key.

## 9. Risks the owner is accepting

- **The first release after each piece is the first real run of its jobs.** `release.yml` runs
  only on a push to `main` that cuts a release, so nothing before that exercises a deploy with a
  real token. Each job lands dormant until its value exists, and a failure leaves a draft.
- **The token's permissions are not verified** until that run; a missing one is named in its log.
  The same is true of what the Play API accepts for this app.
- **The new token can write the entitlements database and deploy over any Worker on the
  account**, the web app's included. What bounds it is the `release` environment's restriction
  to `main`.
- **A migration is applied with nobody watching and is not undone by a re-run.** D1's Time
  Travel is the way back, by hand.
- **Every release redeploys the relay**, changed or not, which closes live sync sockets for a
  moment; clients reconnect.
- **A run that stops midway leaves the Workers it reached ahead of the release.** That is the
  state every by-hand relay deploy has left, and the relay already has to serve older builds.

## 10. What changed in execution (piece A)

Found while piece A was built, and not as the sections above say.

- **The token alone decides** whether `relay-deploy` and `share-deploy` run (§4 already says so).
  The fence holds it: *asks for the token alone, and does nothing without it*.
- **The sync smoke applies the tracked migrations through `d1 execute --local --file`**, its
  existing helper in `scripts/web-smoke/sync-harness.mjs`, and not through
  `d1 migrations apply`. That adds no wrangler subcommand to what CI may start: the list stays at
  `d1 execute --local` and `dev --local`, and the release's five `wrangler` lines are the only
  other wrangler a workflow runs.
- **The local wrangler experiment (§5.4) needed a relative `--persist-to` on Windows.** With an
  absolute path wrangler 4.146.0 rewrites the database path to `./C:\…` and answers an internal
  error, which is a quirk of the path and not of an empty folder. CI passes no such flag. What it
  showed, with the folder empty and with one file, is in `docs/reference/ci-and-releases.md`,
  *A release deploys everything*.
- **The plan's relay-probe test was wrong as written.** It required fewer than five requests on
  the token door, but the probe list has five `/token` paths, two of them `OPTIONS` pre-flights
  that the router answers ahead of the rate limiter and that spend none of its budget. The test
  now counts the requests that do spend it: three an attempt, under the 30 a minute `RL_MINT`
  allows.
- **`scripts/toolchain.test.mjs` went from three `pnpm install`s in `release.yml` to four**, because
  `share` is a real fourth install. The plan had not listed that file.
- **The fence's check that the token reaches two steps and no third was written with a clause that
  hid any step naming `GITHUB_TOKEN`.** A review caught it, a mutation proved it (the token added
  to a third step in `relay-deploy` went red once the clause was gone), and the clause was dropped.
- **Pull request 874 was brought onto the branch by cherry-pick, not by merging `main`**, because
  the app's sync tool wanted the repository's origin confirmed first. `main` is merged before the
  pull request is opened.
- **The first run with the token writes to production.** `wrangler d1 migrations apply` creates
  its bookkeeping table, so the first release run with `CLOUDFLARE_INFRA_API_TOKEN` creates
  `d1_migrations` and `d1_migrations_share` in the live database even though no migration is
  pending. Harmless, and by design; §5.4 said the first run "finds nothing to apply", which is
  still true and is not the same as writing nothing.
- **The version id `wrangler deploy` prints is in the job's log only.** §5.3 says it "goes into
  the summary"; capturing it would put more shell into a step that holds the token, so it is not
  captured.

## 11. What changed in execution (piece B)

Found while piece B was built, and not as the sections above say.

- **Piece B was built on a tree that already had pull request 888's two changelog jobs and
  piece A's tightened fence**, so `release.yml` is thirteen jobs, not eleven: eleven on a
  release, and `changelog-write` and `changelog-commit` between releases. Five jobs hold a
  secret on a release (`android-sign`, `relay-deploy`, `share-deploy`, `web-deploy`,
  `play-upload`), and `changelog-write` holds one between releases. `play-upload` is not in the
  fence's `DEPLOYS`: it starts no `wrangler`.
- **The script's test runs under the suite's default jsdom environment, not Node's.** The
  per-file Node directive is honoured by Vitest, but the shared setup file touches `document`
  and the file fails before any test. All 18 assertions pass under jsdom unchanged. On a runner
  the script uses Node's own `fetch` and `AbortSignal`.
- **A review found the fence did not hold `play-upload`'s download step or tie the key to the
  script's step.** Both are held now: the download step whole, and the key's holder is the step
  that runs the script. Three mutations record it (`docs/reference/ci-and-releases.md`, *A
  release deploys everything*, mutations 7 to 9).
- **`android-sign`'s summary names the upload job as the run page shows it**, *android (upload
  to Play)*, and says what to do when that job did not run.
- **The script knows four refusals, not three** (§6.2): a refused key, a draft app, changes
  waiting for review, and a missing permission.
- **Production's D1 was compared with the two baselines on 2026-10-11, and matches** (§7 item
  3): one read of `sqlite_master`, nothing written. The six tables and six named indexes are
  the same; `_cf_KV` is D1's own; `d1_migrations` and `d1_migrations_share` are not there yet.
- **The service account's key is stored as single-line JSON** (§7 item 2). GitHub masks each
  line of a multi-line secret separately, and the key Google downloads is pretty-printed, so
  set as it came every `{` and `}` in that job's log would read `***`.
- **Not settled by any of this**: that Play accepts a `completed` internal release for this app
  through the API, and that *Release apps to testing tracks* is permission enough. The first
  release with the account set is the first time either is asked.

What the final review of the whole branch changed, the same day:

- **The script refuses a release older than what Play holds** (§6.2 step 4, new). A release
  that never reached Play — no account at the time — could have its job run again after the
  next release uploaded, and the older build would have gone onto the internal track. After
  the bundles the script now reads the tracks (`edits.tracks.list`), takes the highest
  `versionCode` over both, and if it is above this release's discards the edit, uploads
  nothing and ends red. **Seven requests, not six.**
- **§6.2's test was not built as written.** It says the script's steps take the two base
  addresses and run against a local `node:http` stand-in. They do take the addresses
  (`hosts`), but the test hands `upload` its `send` and stages Google in memory: the suite
  runs every file under jsdom, whose `AbortSignal` is not Node's, so Node's `fetch` cannot be
  counted on to take the signal the script makes there. Node's real `fetch` was put under the
  script once, by hand, against a `node:http` stand-in on 127.0.0.1 with a throwaway key; what
  it sent is in `docs/reference/ci-and-releases.md`, *A release deploys everything*.
- **No answer names its step.** A dropped connection or a deadline is reported as
  `No answer from Google while trying to <step>: …`, without `fetch`'s `cause` attached. The
  commit has a deadline of its own, two minutes, and no request follows a redirect.
- **A success that is not what was asked for is refused and not quoted**: an answer that is
  not JSON (V8's own message quotes the text, which on a token answer is a slice of a
  credential), a token answer with no token, an edit with no id.
- **The script knows six refusals, not four**: a `versionCode` Play has used somewhere the
  bundle list does not show, read before the permission hint because Play says it with a 403;
  and an app Play does not know for the account (a 404 at the edit). A 401 or a 403 reads as a
  missing permission by status alone only at the token and at the edit.
- **A discard that fails does not fail the run**, and **the summary's last line depends on
  what happened**: uploading by hand is not offered after an older release, a `versionCode`
  mismatch or a `versionCode` Play has used, and after a commit that got no answer or a 5xx
  the line is to re-run the job first.
- **The fence holds the key's step whole**, line for line, and the order of the three steps
  after the asking one. Four edits beside the `run:` had stayed green — a `NODE_OPTIONS` next
  to the key, `VERSION` from `tag_name`, a `working-directory:`, the script's step above the
  download — and each is red now (`docs/reference/ci-and-releases.md`, mutations 10 to 13).
- **Still not settled**: all of the above was run against stand-ins. Play's real answers — the
  shape of the tracks list, the wording of each refusal — are first seen at the first release
  with the account set.
