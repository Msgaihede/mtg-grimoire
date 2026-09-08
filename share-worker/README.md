# `share-worker/` — the shared-collection Worker

A second Cloudflare Worker beside `relay/`. It holds the whole of shared collections: the gated
writes an entitled reader publishes with, the R2 blob each snapshot lives in, the public pages a
stranger opens, and the daily pass that darkens a link when a membership ends.

**A share is a snapshot the owner publishes, not a window onto their database.** Everything a
viewer sees was true when the owner last pressed publish, the owner chooses what crosses, and
nothing a viewer does can reach back. `docs/superpowers/specs/2026-09-08-collection-sharing-design.md`
is the design; everything below is what a deploy needs.

## Why it is not a route on the relay

**Blast radius.** Sync is a paid feature people depend on; sharing is new and will churn, and
every deploy here is done by hand by one person. One Worker carrying both means a bad share
deploy is a sync outage. The two share **a D1 database** and **the `RELAY_HMAC_KEY` secret** and
nothing else — no service binding, and only two of the relay's modules are imported
(`src/token.ts` for `verify`, and `src/fakeD1.ts` in the tests).

`relay/`'s source and its deploy are untouched by this feature.

## What it can read, which is the invariant that now has an exception

`relay/src/index.ts` argues, correctly, that the relay can decrypt nothing it stores. **That
argument does not extend here.** By decision 2 a share snapshot is stored **in the clear**, and
Cloudflare — and Markus — can read it. What that buys is the OpenGraph card in Discord, a
server-rendered landing page, and the freedom to page server-side later without re-cutting the
format. What it costs, stated so nobody has to rediscover it:

- the app must never send a field a reader would not put on a public page. Spec §3's six absences
  (`purchase_price`, `purchase_currency`, `acquired_at`, `acquisition_source`, `notes`, `tags`)
  are the fence, and they are **absences rather than switches** for exactly this reason;
- a compromise of this Worker's D1 or R2 is a compromise of every shared binder and of nothing
  else — the sync log's ciphertext is in a different Durable Object under a different key, and
  this Worker holds no key material at all;
- the privacy claim the app makes to a reader is therefore **"anyone with the link"**, and must be
  worded that way in the UI. Not "private", not "encrypted".

## The routes

| Route | Body | Answer | Guard |
| --- | --- | --- | --- |
| `POST /g/{group}/share` | metadata | `200 { id, url }` | bearer |
| `PUT /g/{group}/share/{id}` | gzip | `200 { hash }` | bearer |
| `GET /g/{group}/shares` | | `200 { shares: [ … ] }` | bearer |
| `DELETE /g/{group}/share/{id}` | | `204` | bearer |
| `GET /s/{id}` | | `200` HTML, or `410` | **public** |
| `GET /s/{id}/{hash}.json.gz` | | `200`, immutable | **public** |
| `GET /assets/*` | | the viewer bundle | **public** |

The gated four verify the token the relay minted, with `relay/src/token.ts`'s `verify` over the
shared `RELAY_HMAC_KEY`, and compare **`claims.grp` against the path segment**. That comparison is
not redundant with the signature: a validly signed token for one's *own* group is exactly what an
attacker has.

**The two public routes are the whole of the entitlement asymmetry.** Publishing needs a token,
which needs a membership; viewing needs the link and nothing else, which is what issue #360 asked
for. The link *is* the capability — there is no viewer account and no per-viewer access control.

`GET /assets/*` reaches **no code here**. `wrangler.jsonc`'s `assets` binding names `/s/*` and
`/g/*` as the only prefixes that `run_worker_first`, so the viewer bundle is served at the edge:
a static asset request is free and unlimited even on the free plan, and that is what keeps a share
that goes viral off the account's 100,000-request/day budget. Adding a route for the bundle would
undo it.

## The blob, and the two-step

`POST` writes the metadata row with `object_key` **NULL**; `PUT` stores the bytes in R2 and only
then points the row at them. That order is the whole of what makes a failed upload harmless: a
publish that dies in between leaves either *no* snapshot or the *previous* snapshot, and never a
link to something that was never written. The superseded object is deleted **after** the row has
moved, and only when the key actually changed — a republish of an unchanged collection is
content-addressed to the same key, and a delete that skipped that comparison would erase the
object it had just written.

The key is `shares/{id}/{hash}.json.gz`, where `hash` is the first 16 hex characters of the body's
SHA-256. ⚠️ **That is why the `PUT` buffers rather than streaming straight into R2**: the digest
has to be known before the object can be named, and R2's Workers binding has no rename. The buffer
is bounded by the 8 MB cap, which is checked as it fills, so a caller who omits or lies about
`content-length` still cannot make this Worker hold more than the cap.

`GET /s/{id}/{hash}.json.gz` is `public, max-age=31536000, immutable` with `caches.default` in
front of R2, so a warm view costs no storage read. What `immutable` costs is that revoking cannot
recall an edge copy somebody already holds; what revoking *does* stop is every new viewer, because
the shell is the only thing that hands out that URL and it is `max-age=300`.

`GET /s/{id}` is rendered from the D1 row — that is what carries the OpenGraph card, and it is the
only thing decision 2's plaintext storage buys. **It inlines the blob's URL** as
`<link id="snapshot" rel="preload" as="fetch" crossorigin href="/s/{id}/{hash}.json.gz">` rather
than offering an `index.json` route beside it, because the response is already holding the fact a
second request would go and fetch. A row whose `object_key` is still NULL gets the shell, a
sentence, and **no `<link>`** — its absence is the signal the viewer reads.

⚠️ **`src/page.ts` interpolates a title and an owner's name that a reader typed, and there is no
template engine.** One `esc()` covers every value; a new field rendered without it is an XSS on a
page strangers open.

## The lapse, and why the public read stays one lookup

`src/lapse.ts` is a **daily cron on this Worker**, `30 3 * * *`. It reads `entitlements` — the
relay's table, in the D1 database the two Workers share — and writes `shares.state`: a group whose
subject is `dead` has its **live** shares darkened to `lapsed`, and a group whose subject is
`active` or in `grace` has its **lapsed** shares lit again.

**It reads the stored `status` and does not re-run `decide`.** `relay/src/claim.ts`'s `reconcile`
is what moves a subject through `active → grace → dead` against Patreon; a second opinion here
would be one account with two answers to when a membership ended. `grace` **serves** — a declined
card is a failed payment Patreon retries, not a cancellation the reader chose.

**`revoked` is never touched.** The reader's own press is terminal and the cron's flip is
reversible, which is the whole reason `state` is a state rather than a `revoked_at` stamp. The
`AND state = ?` clause in the one `UPDATE` is what enforces it, and the candidate query ahead of
it is deliberately **not** narrowed to the rows that can move — narrowing it would be free,
correct, and would make that clause unreachable for a group whose only share is a tombstone, which
is exactly the case it exists for.

**A group with no entitlement row at all is not serving, and goes dark.** That is a real state
rather than a hypothesis: `/claim` *moves* a binding rather than refusing one, so a subject who
reconnects on another group leaves this one entitled by nothing. Fail closed, because `lapsed` is
reversible — a group that should not have gone dark lights again on the next pass, where a group
that should have gone dark and did not, never does.

Two things follow for a deploy. `30` and not `0` because `relay/wrangler.jsonc` already owns
`0 3 * * *` and there is nothing to be gained by having both passes write the same D1 on the same
minute; this is the account's **second** cron trigger of the free plan's five. And because the
verdict is written into the column, **`GET /s/{id}` reads one row and branches on `state`** — no
join to `entitlements`, no second query — so a link that goes viral costs a single-table read on
the budget every paying reader's sync shares.

A lapsed share **keeps its R2 object**. Reclaiming that storage is a sweep for later (spec §13),
not a retention rule invented here: a revived membership wants the snapshot back.

## Deploying

⚠️ **No agent may run `wrangler deploy`, `wrangler d1 execute --remote` or `wrangler secret put`.**
Those are the repo owner's. `wrangler dev --local` is the only wrangler command an agent may run.

**Step 0 is to ask the host rather than a document**, for the reason `relay/README.md` opens with:
that file has been wrong twice about what was deployed, in the same week, and the only sentence
that cannot rot is a `curl`. As of 2026-09-08 **nothing is deployed at this Worker's address,
because it has no address yet.**

1. **Enable R2 on the account** — a dashboard action, and spec §14's open item 2. Then
   `npx wrangler r2 bucket create mtg-grimoire-shares`.
2. **Apply the schema** to the relay's existing database:
   `npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql`.
   ⚠️ On a database that already holds part of it, run **one statement per `--command`**:
   `--file` is atomic and a duplicate object takes the whole file down, which is the failure that
   left a deployed Worker 500ing on 2026-08-30.
3. **Set the one secret**: `npx wrangler secret put RELAY_HMAC_KEY`, with the **same value** the
   relay holds. A different one means every publish is a 401 and nothing else says why.
4. **Build the viewer** so `dist-share/` exists. ⚠️ `wrangler.jsonc` declares an `assets`
   binding over `../dist-share`, and **`wrangler deploy` fails naming that directory when it is
   absent** — the binding is declared ahead of the build for the same reason the R2 bucket is, so
   the deploy question is asked once.
5. `npx wrangler deploy`, and read the address it prints.
6. **Write that address into two places, byte for byte**: `wrangler.jsonc`'s `SHARE_BASE` var
   (currently the placeholder `<set on first deploy>`) and `share::SHARE_BASE` in the Rust. Then
   deploy again, because a `var` is baked at deploy time. The same trap `RELAY_BASE` documents
   for the OAuth redirect URI applies with less mercy here: a mismatched `SHARE_BASE` produces
   links that resolve to nothing rather than an error anybody sees.

## Testing

There is **no test runner for workerd in this tree, deliberately** —
`@cloudflare/vitest-pool-workers` drags wrangler and workerd into a suite pinned to vitest 4.1.10,
and `vite.config.ts` says so. So the handlers are plain functions over an injected `Env`, driven
as `worker.fetch(request, env)` against `relay/src/fakeD1.ts`'s SQL evaluator, exactly as
`relay/src/rotate.test.ts` drives `/rotate` and `/keys`.

```
npx vitest run share-worker/
npx tsc -p tsconfig.share-worker.json
```

⚠️ `share-worker/src/**/*.test.ts` is a glob in `vite.config.ts`. A directory that list does not
name is collected by **nothing**, and `vitest run` answers `No test files found` — which is easy
to read as a pass.

`fakeD1` models column keys and not expression indexes, so `shares_folder` — the partial unique
index that makes one share per folder true — is **not** enforced there. `handleCreate` therefore
decides it by *reading* the folder's row, and catches a constraint violation only as the backstop
for two devices publishing at once: the loser re-reads and is answered the winner's id rather than
a 500. Neither half can be checked against the fake, so both were driven against real SQLite with
`node:sqlite` on 2026-09-08 — the index refuses a second live share of one folder and a second
whole-collection share, admits a fresh row beside a revoked tombstone, and the sequence
publish → revoke → publish → publish → publish answers one stable id from the second press on.

⚠️ **That last sequence is the shape of the bug this Worker shipped for one commit.** The lookup
in front of the index has to carry the index's own `state <> 'revoked'` predicate; without it the
tombstone is what `first()` answers, every later publish takes the mint-a-new-id branch, and the
third press is an uncaught 500 for ever. Two publishes cannot see it — the second is *supposed*
to mint a new id — which is why the test publishes four times.
