# `infrastructure/scan-worker/` — the scan inbox

A fourth Cloudflare Worker, beside the relay, the share Worker and the web app's hosting. It has
one route: the card scanner's **Send** posts one camera picture to it, with the exact printing and
finish a reader says the picture shows, and it keeps both so the scanner can be tested against
them and improved (issue #776).

**A reader sends one picture at a time, by hand.** The app shows the picture first, the reader
picks the card and the finish, and only that press calls this Worker. Nothing here is asked on a
launch, on a schedule or on a frame.

## Why it is a Worker of its own

**Blast radius, and the kind of route this is.** Every other write this project's servers take is
behind a token the relay minted, which is behind a membership. This one is behind nothing — a
reader is not asked to pay to say the scanner was wrong — so it is the one route on the account a
stranger can make store bytes. It therefore binds the least there is: **one R2 bucket and one rate
limiter. No D1, no Durable Object, no secret, no service binding, and it imports no module of
another Worker's.** A fault here can fill or lose the scans; it cannot reach a membership, a sync
log or a shared binder, and a deploy here cannot break any of them.

**And nothing is ever read back out through it.** There is no `GET` for a picture or a label, no
listing and no delete: a Worker with no way to tell a stranger from its maker must not offer
either of them anything. An upload route that also served what it took would be free image
hosting for whoever found it. The maker reads the bucket with his own credentials (below).

## The route

| Route | Body | Answer |
| --- | --- | --- |
| `POST /scan` | the JPEG, as `image/jpeg` | `201 { "id": "…" }` |
| `OPTIONS /scan` (a browser's pre-flight) | | `204`, for an origin on `APP_ORIGINS` |
| anything else | | `404`, or `405` on `/scan` |

The label rides in the `x-scan-label` header as **ASCII JSON** — every character past `~` escaped
as `\u….`, which is how the app already sends its scanner a frame's options. A header's bytes
reach a Worker as Latin-1, so a name sent as it is spelled would be stored as mojibake; a header
that is not ASCII is refused rather than repaired.

The refusals, in the order they are checked — each before anything that costs more:

| Status | `code` | When |
| --- | --- | --- |
| 405 | | not `POST` (ahead of the limiter) |
| 429 | `rate_limited` | more than 12 a minute from one address |
| 415 | | not sent as `image/jpeg` |
| 400 | | no label, or one `src/label.ts` refuses (the sentence names the field) |
| 413 | `frame_limit` | over 2 MB by its `content-length` |
| 503 | `inbox_full` | the inbox was full when this isolate last asked, under a minute ago |
| 413 | `frame_limit` | over 2 MB by the bytes as they arrive |
| 400 | | the body does not start as a JPEG does |
| 503 | `inbox_full` | 500 pictures already waiting |

The app words each of these for a reader itself (`crates/grimoire-core/src/scanner_submit.rs`),
matching on the status or the `code` and never on the sentence, which is written for a developer
with a `curl`.

## What is stored

Two objects a submission, under one id — `20261011T101500Z-9f8a…`, the second it arrived and
eight random bytes:

- `frames/{id}.jpg` — the picture, byte for byte as it was sent. Nothing is decoded or re-encoded.
- `labels/{id}.json` — the label, **rebuilt from the fields that were checked** (a key the shape
  does not name is dropped), plus `id`, `received_at` (this Worker's clock) and `bytes`.

```json
{
  "v": 1,
  "card": { "id": "<Scryfall id>", "set": "2x2", "number": "117", "lang": "en", "name": "Lightning Bolt" },
  "finish": "foil",
  "scanner": { "reported": "<Scryfall id or null>", "mode": "fast", "confidence": 0.82, "distance": 31, "bundle": 98000 },
  "app": { "version": "0.43.0", "platform": "desktop" },
  "frame": { "width": 1920, "height": 1080 },
  "id": "20261011T101500Z-9f8a0c1d2e3f4a5b",
  "received_at": "2026-10-11T10:15:00.123Z",
  "bytes": 412345
}
```

`card` is the printing the reader chose; the engine reads its set, number, language and name out
of the install's own card data, so a label cannot pair one printing's id with another's name.
`scanner` is what the scanner had said at the press, and every figure is `null` when it had
none. **`reported` is the printing it had decided on, and `null` while it had decided nothing**
— never the card it was merely leaning towards, which the tracker knows by another id. So
`reported === card.id` is a scan it got right, any other id is one it got wrong, and `null` is
one it had not answered; `confidence` and `distance` are how far it had got.

**Nothing stored says who sent it**: no device, no group, no account, no address. The privacy
policy (`apps/light/public/privacy.html`, *Sending a scan*) promises that, so a field added to
the label is a sentence owed there — and `id` is the only way one submission is found again,
which is why the app shows it to the reader.

**The picture is written first and the label last**, and both writes are handed to the runtime
to finish (`waitUntil`) so a sender who hangs up between them does not split a pair. A write
that fails in between still leaves a picture nobody named, which is litter: a `frames/` object
with no `labels/` object of the same id is a failed upload and can be deleted. It is counted
against the cap all the same — see below.

## What bounds it

- **500 pictures waiting** (`MAX_PENDING`), counted by listing `frames/` — one list a
  submission, no counter to drift. With the 2 MB cap that is **about a gigabyte**, against R2's
  free ten, whoever is sending and from however many addresses. A full inbox turns pictures
  away with a sentence until it is emptied; that is the right way round — a full inbox costs a
  few scans, an unbounded one costs money.
  - **It counts pictures, not labels**, so a picture whose label never landed is counted: bytes
    are what the cap is for, and a sender who could make uncounted ones would not be bounded.
  - **It is asked after the picture has arrived, not before.** Asked first, a sender who sent
    its headers and held its body back was counted in before it stored anything, and any number
    of them could be let past a nearly full inbox at once.
  - **"About", because the count and the write are two steps.** Requests that count in the same
    instant each store, so the inbox can end a burst holding 500 and that burst. Nothing here
    can make the two one step — that takes a Durable Object or a database, which this Worker
    is deliberately without — and the next request after the burst is refused.
  - **A full inbox is remembered for a minute** by the isolate that found it full, so a flood
    against one costs a refusal and not a list each. A list is a billed R2 operation (the free
    plan gives a million a month, shared with the share Worker); a submission that is stored
    costs three.
- **2 MB a picture** (`MAX_FRAME_BYTES`), which the engine refuses first. The app sends a JPEG no
  longer than 1920 pixels on its long edge.
- **12 a minute from one address** (`RL_SUBMIT`). Measured on the relay, these limiters are far
  looser than their number reads: it bounds a flood from one address and nothing else, and it
  fails open when the binding is missing or throws.
- **A strict label.** A submission without a whole one is refused, not stored.

It does not keep a request off the account's 100,000-a-day budget: the Worker has already been
invoked to refuse it, and a rule in front of the Worker needs a zone, which `workers.dev` has not.

## A browser

The web app's engine sends from a page with `fetch`, so `src/cors.ts` answers the pre-flight and
puts `Access-Control-Allow-Origin` on every answer — the refusals above all — for an origin on
`APP_ORIGINS`, which is exactly `https://mtg-grimoire.app`. It is the relay's `cors.ts`, copied,
and it is **not an access control** here either: `curl` sends whatever `Origin` it likes. What it
buys is that a foreign page cannot spend a reader's browser on filling the inbox. The web
policy's `connect-src` names this Worker's host (`infrastructure/app-worker/_headers`), so **this
Worker is deployed before a web build that asks it**: a page that asks a host with no CORS answer
fails every request.

## Reading the inbox

With the owner's own credentials — never through this Worker.

```
npx wrangler r2 object get mtg-grimoire-scans/labels/<id>.json --remote --file <id>.json
npx wrangler r2 object get mtg-grimoire-scans/frames/<id>.jpg --remote --file <id>.jpg
```

For the whole inbox, R2's S3 API with an API token scoped to this one bucket (`rclone copy`, or
`aws s3 sync` against the account's R2 endpoint) brings `frames/` and `labels/` down as two
folders that pair by file name. **Delete what has been read** — the cap counts what is waiting,
and an inbox nobody empties stops taking scans at 500. A deletion request names an id; delete
both of its objects, in the bucket and in any copy.

## Deploying

⚠️ **No agent may run `wrangler deploy` or create the bucket.** Those are the repository owner's,
and no CI job deploys this Worker. `wrangler dev --local` is the only wrangler command an agent
may run.

**This Worker has not been deployed.** Until it is, a press on Send is answered in a sentence —
*the server answered 404* from a desktop or a phone, *the server could not be reached* from a
browser — and nothing else in the app notices.

1. `npx wrangler r2 bucket create mtg-grimoire-scans`. The deploy fails naming the `SCANS`
   binding until the bucket exists.
2. `npx wrangler deploy`, from this folder, and read the address it prints. It must be
   `https://mtg-grimoire-scans.denmark-east.workers.dev` — the Worker's name and the account's
   subdomain — which is `scanner_submit::SCAN_BASE` in the engine, a source in the web policy
   and a row of the privacy policy. `src/wrangler.test.ts` holds the name to the engine's line.
3. Ask the host, rather than this file, what it does:

   ```
   S=https://mtg-grimoire-scans.denmark-east.workers.dev
   curl -s -w " %{http_code}\n" "$S/scan"
   curl -s -w " %{http_code}\n" -X POST "$S/scan"
   curl -s -o /dev/null -w "%{http_code} %header{access-control-allow-origin}\n" -X OPTIONS \
     -H "origin: https://mtg-grimoire.app" -H "access-control-request-method: POST" "$S/scan"
   curl -s -w " %{http_code}\n" "$S/frames/x.jpg"
   ```

   A deployed Worker answers `{"error":"method not allowed"} 405`,
   `{"error":"a scan is sent as image/jpeg"} 415`, `204 https://mtg-grimoire.app` and
   `{"error":"not found"} 404`. Then send one real scan from the app and read it back out of the
   bucket: that is the only thing that shows the bucket binding works.

There is no secret to set and no schema to apply. Before the Android release that carries Send,
the Play Console's Data safety form changes — `docs/play/README.md`, *Data safety*.

## Testing

No workerd in this tree, for the reason `infrastructure/share-worker/README.md` gives: the
handler is a plain function over an injected `Env`, driven as `worker.fetch(request, env)` over
`src/fake.ts`'s bucket and limiter.

```
pnpm exec vitest run --project scan-worker
pnpm exec tsc -p infrastructure/scan-worker/tsconfig.json
```

`label.test.ts` and `wrangler.test.ts` read the engine's Rust, this folder's `wrangler.jsonc` and
the privacy policy as text: a label field the engine sends and this side does not read, an
address or a cap that moved on one side only, and a log switched back on are each red there.
