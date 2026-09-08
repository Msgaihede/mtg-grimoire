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
4. `npx wrangler deploy`, and read the address it prints.
5. **Write that address into two places, byte for byte**: `wrangler.jsonc`'s `SHARE_BASE` var
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
index that makes one share per folder true — is **not** enforced there. `handleCreate` decides it
by reading the folder's row rather than by catching a constraint failure, and `schema.sql` was
checked against real SQLite with `node:sqlite` on 2026-09-08: the index refuses a second live
share of one folder and a second whole-collection share, and admits a fresh row beside a revoked
tombstone.
