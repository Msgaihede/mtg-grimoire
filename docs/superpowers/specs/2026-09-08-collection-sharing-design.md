# Shared collections

[Issue #360](https://github.com/Msgaihede/mtg-grimoire/issues/360), raised from Discord by
Giradeli, with a second comment proposing it as a Patreon-gated add-on. User schema **v41**,
relay D1 **+2 tables**, and one **new Cloudflare Worker**. This is the design;
`docs/reference/collection-sharing.md` is the page that will hold the record of what shipped.

**The one sentence: a share is a snapshot the owner publishes, not a window onto their
database** — so everything a viewer sees was true when the owner last pressed publish, the owner
chooses what crosses, and nothing a viewer does can reach back.

Everything below is a consequence of that, and of the eight decisions in §2.

---

## 1. What the issue asked for, and what it gets

The issue asks for four things:

1. a **permanent web link** to a collection or a collection folder;
2. the **root collection** included, **locked folders** excluded;
3. private sharing between friends — borrowing for a tournament, trades, "almost a storefront";
4. a **wishlist folder specific to a shared collection**, for a buy list or trade list.

It gets 1, 2 and 3 as written. It gets 4 in a narrowed form: a viewer can push cards from a
shared binder into a wishlist folder they already have, and the folder is **not** bound to the
share. §8 carries that trade.

It also asks the question the title of this file is the answer to — *web app, or in the app?* —
and the answer is **both, from one format**. A link a friend opens in a browser is what the issue
is about. A Grimoire user opening the same link inside their own app, where their collection and
their wishlist are, is what makes the trade half work. Two readers, one snapshot, one contract.

**One thing in the issue is quietly already built and the spec must not implement a ghost.**
`collection_folders.locked` shipped at user schema v34 ([issue
#365](https://github.com/Msgaihede/mtg-grimoire/issues/365),
[collection-folders.md §The lock](../../reference/collection-folders.md)) and it inherits down the
tree. The exclusion clause is therefore not a feature to build here; it is a query to get right,
and §4 is about the two ways of getting it wrong.

---

## 2. The eight decisions, and who took them

Taken by Markus on 2026-09-08, asked directly. They are recorded here because six of them close
off an alternative that a later reader will otherwise re-propose.

| # | Decision | The alternative, and why not |
| --- | --- | --- |
| 1 | **A small purpose-built web viewer**, hosted as Cloudflare static assets | Reusing the web target would meet a stranger with a 75 MB corpus ingest (15.6–16.3 s), 2.64 MB of wasm and a per-origin one-tab refusal. See §7. |
| 2 | **The relay stores the snapshot in the clear** | §5.1. This is the first thing the relay can read, and it is the one decision here that reverses an existing invariant. |
| 3 | **Condition, language and market value may cross.** Purchase price, acquisition data and notes never do | §3. Not "off by default" — absent from the format. |
| 4 | **v1 is publish + web viewer + in-app viewer** | A viewer-only first release was on the table and was not taken; the trade case is the point. |
| 5 | **A lapsed membership darkens existing links** at the end of the grace window | §6. Links that outlive the membership were the alternative. |
| 6 | **The in-app viewer is a new top-level view**, shown only once the reader has opened a share | A destination inside the 3,580-line `CollectionPage.tsx`, or a dialog. |
| 7 | **One share per folder.** Re-sharing returns the same link | Many links per folder with different fields was the storefront-shaped alternative; it makes revocation and refresh one-to-many. |
| 8 | **Want lists push into an existing wishlist folder** | A wishlist folder bound to a share id is what the issue literally asks for; it costs a synced column and a schema rung, and §8 says what it would take to add later. |

---

## 3. `ShareSnapshot` — the contract, and the fields that are absent

One JSON document, gzipped, versioned by its `v` field. It is the contract between **three**
implementations — one Rust writer and two TypeScript readers — which is one more than the text
mirror has, and is why §12 puts a golden corpus in front of it.

```jsonc
{
  "v": 1,
  "id": "kQ2p7fMx9Lb0RtVw",          // the share id, 16 chars; the last path segment of the link
  "title": "Trade binder",           // the folder's name, or "Collection" for a whole-collection share
  "owner": "Giradeli",               // what the owner typed. Never derived from Patreon.
  "updatedAt": 1757308800,           // seconds; what the page renders as "as of …"
  "marketplace": "tcgplayer",        // which feed the prices below came from
  "currency": "USD",
  "fields": ["condition", "lang", "value"],   // which optional fields this snapshot carries
  "folders": [
    { "uid": "f3c1…", "name": "Trade binder", "parent": null },
    { "uid": "9ab2…", "name": "Duals",        "parent": "f3c1…" }
  ],
  "cards": [
    {
      "id":  "0000579f-7b35-4ed3-b44c-db2a538066fe",  // scryfall id — the card's identity
      "n":   "Fury Sliver",
      "s":   "tsp",
      "cn":  "157",
      "f":   "nonfoil",                                 // nonfoil | foil | etched
      "q":   2,
      "fo":  "9ab2…",                                   // folder uid, or null for the root
      "img": "https://cards.scryfall.io/normal/front/0/0/0000579f-….jpg",
      "c":   "NM",                                      // only when "condition" is in fields
      "l":   "en",                                      // only when "lang" is in fields
      "p":   0.34                                       // only when "value" is in fields
    }
  ]
}
```

**`img` travels rather than being derived, and gzip is why.** Scryfall's image URLs are long
(~90 B) and every one of them shares the `https://cards.scryfall.io/normal/front/` prefix, which
is exactly the shape DEFLATE erases; deriving them instead would save a few percent and buy a
dependency on a URL scheme this app does not control. `image_uri::has_cache_buster` already
exists because that scheme has moved before.

**Six fields are absent from this format and cannot be switched on**: `purchase_price`,
`purchase_currency`, `acquired_at`, `acquisition_source`, `notes` and `tags`. Decision 3 made
`notes` and the free-text `tags` optional-and-off; this spec makes them absent instead, because
an optional field is a field a future switch can turn on by accident, and these are the ones a
reader would be most upset to have published. `needs_review`, `tradelist_quantity`, `grading`,
`serial_number`, `altered`, `signed`, `proxy` and `misprint` are absent for the plainer reason
that nothing in the viewer draws them.

**`fields` is on the wire even though a reader could infer it from the keys present.** A folder
of cards that all happen to be `NM` is indistinguishable from a snapshot that carries no
condition at all, unless the snapshot says which question it answered.

**Cards are a flat array and folders are a separate tree.** The alternative — nesting cards
inside folders — makes the common viewer operation (filter across the whole binder) a tree walk,
and makes a card that moves folders a structural diff rather than a field change.

### 3.1 Size, which is estimated and must be measured before v1 locks the format

**No measured payload size for a collection read exists anywhere in this repo.** The reference
database is 275 entries (`collection-folders.md`), the owner's own live collection measured 0
rows on 2026-08-20 (`import-export.md`), and the closest thing to a budget is the export sweep's
`SWEEP_PAGE = 500` with its worked "3,000-row collection → six round trips".

Arithmetic, so that the plan has something to falsify: ~150 B/card before compression, so 3,000
cards ≈ 450 KB ≈ ~100 KB gzipped, and a 50,000-card whole-collection share ≈ 7.5 MB ≈ ~1.5 MB
gzipped. **Plan step 1 is to measure a real one**, and the caps in §5.3 are provisional until it
has.

---

## 4. The publisher — and why it is not a `CollectionQuery`

`src-tauri/src/share/`, compiled for wasm as well as desktop (it reads SQLite and formats JSON;
only the upload is gated).

**A share does not ride on `collection::list_entries`, and the two reasons are both defaults that
are right for the app and wrong here.**

* **`folder_id = ?` is direct members only** (`collection.rs:1674`). A share of a parent folder
  built on that query would silently omit every subfolder — no error, no empty state, just a
  binder missing its best drawer.
* **`exclude_locked` is skipped entirely when `folder_id` is set** (`collection.rs:1709`) —
  *"standing in a locked folder names it, and a named folder is served whole"*. That is the
  correct rule for a reader clicking into their own drawer and a leak in a share.

So `share::snapshot(conn, folder_uid: Option<&str>, fields) -> ShareSnapshot` is its own read,
and its shape is the inverse of `CollectionQuery`'s:

1. resolve the subtree from the named folder (or from the root, for a whole-collection share);
2. **drop every folder that is locked or has a locked ancestor**, reusing
   `collection_folders::LOCKED_FOLDER_IDS` — the same recursive CTE the app already trusts, so
   there is no second opinion about what "locked" means;
3. **drop every folder whose `kind <> 'user'`** — deck groups and `Recently removed` are never
   shareable, which is the rule `CollectionPage.tsx:1358`'s `userFolders` already applies on
   screen;
4. read the entries of what survives, join `cards` for name and image, and price through
   `sorting::price_expr` at the owner's marketplace **only if `value` is in `fields`**;
5. emit.

**Its default is nothing.** `CollectionQuery::exclude_locked` defaults to `false` because an
unasked question must keep today's answer for the mirror and the export sweep — a whole-collection
backup is "the one read that must never ask". A share is the opposite kind of read: an unasked
question here must publish *less*, never more. Stating that inversion is the point of this
section, because the two functions sit one file apart and the wrong instinct is cheap.

**A locked folder cannot be published at all** — `share::publish` refuses before it reads, with a
sentence, rather than uploading an empty snapshot that reads as "this person owns nothing".

### 4.1 Publishing, and the two-step that makes a failed upload harmless

```
mint id (if new) → POST meta → PUT gzip → relay commits object_key → app stores the link
```

The D1 row does not point at the new blob until the blob has landed. A publish that dies halfway
leaves the **previous** snapshot serving, which is the same commit-last shape
`sync_engine::client::post_rotation` uses and the same reason: a half-published share is a broken
link in somebody's Discord, and the old one is never worse than that.

**Refresh** runs on app launch and after a sync that touched a shared folder, debounced, plus a
manual *Update now*. A failure keeps the old snapshot and says so on the folder — the same
courtesy-versus-correctness split `sync.md` makes about leaving a group.

### 4.2 Schema — user v41, one table, not synced

```sql
CREATE TABLE collection_shares (
  id         TEXT PRIMARY KEY,          -- the share id, as minted by the relay
  folder_uid TEXT,                      -- collection_folders.sync_uid; NULL = whole collection
  title      TEXT NOT NULL,
  fields     TEXT NOT NULL,             -- JSON array, as on the wire
  state      TEXT NOT NULL CHECK (state IN ('live','lapsed','revoked')),
  published  INTEGER,                   -- when this device last uploaded; NULL = never from here
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_collection_shares_folder
  ON collection_shares (folder_uid) WHERE folder_uid IS NOT NULL;
```

**It is a cache, and `SYNCED_TABLES` stays at 13.** The relay's `GET /g/{group}/shares` is the
roster, exactly as the rewrapped key set is the roster for group membership — and for the same
reason. A synced copy would be a second record of a fact the relay already holds, and the two
would disagree the first time a device was offline during a revoke. What this table buys is a
"shared" badge on a folder that survives being offline, and nothing more.

**`folder_uid` and not `folder_id`**: a share outlives the device that made it, and the row id is
local. The unique index is decision 7 — one share per folder — enforced where it can actually be
enforced on the reading side; the relay enforces it too (§5.2), and the relay's is the one that
counts.

**⚠️ v41 is this branch's guess.** `USER_SCHEMA_VERSION` is 40 today and every open branch that
adds a rung is guessing the same number. Renumber before merging, and read
*Schema rung collisions with main* before assuming the number in this file survived.

### 4.3 The owner's name

Typed by the reader on their first publish, held on the relay in the share row, and read back by
every other device from `GET /g/{group}/shares` — so the second device to publish inherits the
name rather than asking again.

**It is never derived from Patreon.** The relay already holds a Patreon id in exactly one column
of one table and names the subject everywhere else; a display name pulled from the OAuth profile
would hand it an identity it currently has no reason to learn, and would put a reader's legal
name on a public page because they once clicked Connect.

---

## 5. The relay side

### 5.1 A second Worker, and the invariant that now has an exception

**A new Worker, `mtg-grimoire-share`, not a route on the relay.** It binds the *same* D1 database
and the same `RELAY_HMAC_KEY`, so it can verify a token the relay minted without a service
binding, and it holds the whole feature — public reads, gated writes and the static assets. The
relay's source and its deploy are untouched.

The reason is blast radius rather than tidiness. Sync is a paid feature people depend on;
sharing is new and will churn. One Worker carrying both means a bad share deploy is a sync
outage, and every deploy here is done by hand by one person.

**And now the exception.** `relay/src/index.ts` argues, correctly, that the relay can decrypt
nothing it stores. That argument does not extend to this Worker, by decision 2: **a share
snapshot is stored in the clear, and Cloudflare, and Markus, can read it.** What that buys is an
OpenGraph card in Discord, a server-rendered landing page, and the freedom to page server-side
later without re-cutting the format. What it costs is stated so that nobody has to rediscover it:

* the app must never send a field a reader would not put on a public page — §3's six absences are
  the fence, and they are absences rather than switches for this reason;
* a compromise of this Worker's D1 or R2 is a compromise of every shared binder, and of nothing
  else — the sync log's ciphertext is in a different Durable Object under a different key, and
  this Worker holds no key material at all;
* the privacy claim the app makes to a reader is therefore **"anyone with the link"**, and must
  be worded that way in the UI. Not "private", not "encrypted".

### 5.2 D1 — two tables

```sql
CREATE TABLE shares (
  id          TEXT PRIMARY KEY,       -- 16 base64url chars, 96 bits from crypto::random_bytes
  group_id    TEXT NOT NULL,
  folder_uid  TEXT,                   -- NULL = whole collection
  title       TEXT NOT NULL,
  owner_name  TEXT NOT NULL,
  card_count  INTEGER NOT NULL,
  total_value REAL,
  currency    TEXT,
  marketplace TEXT,
  fields      TEXT NOT NULL,
  object_key  TEXT,                   -- NULL until the first blob commits
  bytes       INTEGER,
  state       TEXT NOT NULL CHECK (state IN ('live','lapsed','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX shares_folder ON shares (group_id, coalesce(folder_uid, ''))
  WHERE state <> 'revoked';
CREATE INDEX      shares_group  ON shares (group_id);
```

⚠️ **`WHERE state <> 'revoked'` was added on 2026-09-08 and this design carried the total index
until then.** A revoked row **stays** — it is what answers a viewer 410 *"withdrawn"* rather than
the 404 that says they mistyped — and re-sharing that folder mints a **new** id, because a revoked
link must stay dead. Those two sentences are together a second row on the folder's key, which the
total index refuses: measured against real SQLite, the publish after any revoke dies with `UNIQUE
constraint failed: index 'shares_folder'`. The partial index is exactly decision 7 — at most one
*serving* share per folder — and lets the tombstones accumulate beside it. The lookup in front of
it carries the same predicate, or it answers the tombstone and mints a third id on the third
press.

`state` is a **state and not a `revoked_at` stamp**, and decision 5 is why: a lapsed membership
darkens a link, and a membership that revives must light it again. A timestamp can only be set.
`revoked` is the reader's own press and is terminal; `lapsed` is the cron's and is reversible.

The share id is minted from `crypto::random_bytes` and base64url-encoded — 96 bits, in the same
alphabet `GROUP_SEGMENT` already constrains a path segment to, so the router's existing character
rule needs no second opinion. It is unguessable and it is the *only* credential a viewer has.

### 5.3 R2 — the blob

`shares/{id}/{hash}.json.gz`, content-addressed, so the URL is immutable and can be served
`public, max-age=31536000, immutable`. The previous version is deleted on publish; R2 deletes are
free. Caps, provisional until §3.1 is measured: **8 MB gzipped per snapshot** and **20 shares per
group**, both refused relay-side with the number in the message.

**Not D1 rows, not KV, not the Durable Object.** D1's free tier allows 100,000 row writes/day
account-wide, which a 3,000-card share would spend thirty times over; KV allows 1,000 writes/day,
which is the same limit `relay/wrangler.jsonc` already rejected KV for; and a Durable Object is
the one line that meters, which is precisely why the bearer gate stands in front of it and why
anonymous traffic must never reach one. R2's free tier is 10 GB stored, 1 M writes and 10 M reads
a month, egress free.

### 5.4 Routes

| Route | Body | Answer | Guard |
| --- | --- | --- | --- |
| `POST {share}/g/{group}/share` | metadata | `200 { id, url }` | bearer |
| `PUT {share}/g/{group}/share/{id}` | gzip | `200 { hash }` | bearer |
| `GET {share}/g/{group}/shares` | | `200 { shares: [ … ] }` | bearer |
| `DELETE {share}/g/{group}/share/{id}` | | `204` | bearer |
| `GET {share}/s/{id}` | | `200` HTML, or `410` | **public** |
| `GET {share}/s/{id}/{hash}.json.gz` | | `200`, immutable | **public** |
| `GET {share}/assets/*` | | the viewer bundle | **public** |

The four gated routes reuse `relay/src/token.ts`'s `verify` and the same
`claims.grp !== group → 401` check, which is not redundant with the signature: a validly signed
token for one's *own* group is exactly what an attacker has.

**The two public routes are the whole of the entitlement asymmetry** — publishing needs a token,
which needs a membership; viewing needs the link and nothing else, which is what the issue asked
for.

---

## 6. The lapse, and why the public read stays one D1 lookup

Decision 5: **a link goes dark at the end of the grace window.** The mechanism is a daily cron —
**the share Worker's own, not the relay's**, because §5.1 keeps the relay's source and deploy
untouched and a flip written into `relay/src/claim.ts`'s `reconcile` would break exactly that
claim. The free plan allows five cron triggers per account and the relay uses one. The share
Worker's pass reads `entitlements` (the same D1) and writes `shares`:

* a subject whose status is `dead` → `UPDATE shares SET state = 'lapsed' WHERE group_id = ?`;
* a subject that is `active` or in `grace` → the same statement with `'live'`, `WHERE state =
  'lapsed'` so a reader's own `revoked` is never resurrected.

**It reads the stored `status`, and does not re-run `decide`.** `reconcile` is what moves a
subject through `active → grace → dead` against Patreon, and duplicating that judgement in a
second Worker would give one account two opinions about when a membership ended. This pass reads
the answer the relay already wrote.

**So `GET /s/{id}` reads one row and branches on `state`, with no join to `entitlements` and no
second query.** Putting the entitlement check on the read path instead would make every anonymous
view a two-table read on the account's shared D1 budget, to answer a question that changes at most
once a day.

`lapsed` and `revoked` answer **410**, not 404, with different sentences — a viewer should learn
that a share was withdrawn or expired, not that they mistyped a link. The app shows the same
distinction on the owner's side, because "your links stopped working because your membership
ended" is a sentence the app owes the reader before their friends tell them.

A `lapsed` share keeps its R2 object. Reclaiming that storage is a sweep for later, and §13 says
so rather than inventing a retention rule nobody has needed yet.

---

## 7. The web viewer

A third Vite build in `share/`, output `dist-share/`, importing from `src/` — the card tile, the
image helpers, the design tokens — and importing **nothing** from `src/lib/core`, `src/workers` or
`src/pwa`. It never opens OPFS, never loads wasm, and never registers a service worker.

That last constraint is not stylistic. The browser build renders nothing until a 75 MB corpus is
ingested; its wasm module is 2,642,182 B; its OPFS pool is exclusive **per origin**, so a second
tab is refused outright. A stranger clicking a Discord link would meet all three. The viewer
therefore has no core at all: it fetches one JSON document and renders it.

The page:

* `GET /s/{id}` is answered by the **Worker**, not by a static file, so the HTML can carry
  OpenGraph tags built from the D1 row — *"Giradeli's Trade binder · 412 cards · updated 2 days
  ago"*. This is the concrete thing decision 2 bought, and it is worth one Worker request.
* the shell then loads the bundle from `/assets/*`, which is a **static asset request: free and
  unlimited**, and fetches the immutable blob once.
* filtering, sorting, folder navigation and search all happen in the browser over the loaded
  snapshot. No further requests.
* **the owner's name is in the header and on the OG card**, per the issue's "clearly marked who
  the collection belongs to", and the page says *read-only* and *anyone with this link* in words.
* card art comes straight from `cards.scryfall.io`.

### 7.1 The cost nobody can design away

**The Workers free plan's 100,000 requests/day is per *account*.** A share that goes viral draws
on the same budget every paying reader's sync depends on, and past the ceiling *every* reader
starts erroring at once — the cliff the existing 70% alarm was added for.

What the design does about it: the shell is `public, max-age=300`, the blob is immutable for a
year, `caches.default` sits in front of R2, and static assets cost nothing. That puts a cold view
at roughly two Worker requests and a warm one at zero. What the design cannot do about it: bound
how many strangers click. **The clean fix is the $5/month Workers Paid plan**, and it is a
business decision rather than an engineering one. §14 leaves it open.

**A custom domain would fix two things at once** and is also deferred. This is the link as it
stands:

```
https://mtg-grimoire-share.denmark-east.workers.dev/s/kQ2p7fMx9Lb0RtVw
```

Nobody wants to paste that into a Discord, and a domain would also let R2 serve the blob directly
with no Worker request at all.

---

## 8. The in-app viewer, and the want list

A new top-level view — `ViewId` gains `"shared"` — that **appears in the rail only once the
reader has opened at least one share**, so nobody who never uses the feature pays a rail slot for
it. `src/App.tsx`'s dispatch chain gains one arm.

**A share is opened by pasting its link.** The app reads no launch intent and declares no URL
scheme; `relay/src/pair.ts` carries the whole argument for why adding one is a separate piece of
work with an Android trap in it. Paste is the honest v1.

What the view draws: the shared binder read-only, the owner's name in the header, the *as of*
date, and — the reason it exists — **every row cross-referenced against the reader's own data**:
*you own 2 · you want 3*. The two figures come from existing reads over `collection_entries` and
`wishlist_entries` keyed on the snapshot's scryfall id.

**Want lists (decision 8).** Tick rows, press *Add to wishlist*, choose one of your existing
wishlist folders. That is `wishlist_folders` and `wishlist_entries` used exactly as they are —
no new table, no new synced column, no schema rung.

What the issue asked for and did not get is a wishlist folder **bound** to a share, so that a buy
list for one trading partner is a distinct, re-openable thing. Adding it later is one nullable
`share_id` column on `wishlist_folders`, which is a synced column and therefore a schema rung and
a grain question. It is deliberately not in v1, and the shape above does not foreclose it.

**There is no read-only mode anywhere on the data path today** — `lock_db_read` returns the
*write* connection on wasm, and `src/lib/writes.ts` is only about which mutation owns the error
banner. The shared view's read-only guarantee therefore comes from **not having a database at
all**: it renders a fetched JSON document and has no ipc write path in it. That is a stronger
guarantee than a flag, and it is why this view does not live inside `CollectionPage.tsx`.

---

## 9. What is gated, and what is not

* **Publishing is Patreon-gated**, and is gated by the bearer token rather than by a check in the
  UI — a client-side gate is a suggestion. The token comes from the existing `/token` flow and an
  unentitled caller cannot mint one.
* **A share belongs to the group, not to the device that published it**, consistent with *an
  entitlement is a property of the GROUP*. Every paired device lists, refreshes and revokes.
* **Viewing is open to everyone**, needs no account, no app and no token.
* The app's Share control is hidden — not disabled with a nag — for a reader who has connected
  nothing, and the Settings sync panel is where the connection story already lives.

---

## 10. Error handling — the refusals, as sentences

Following the cabinet's own rule that refusals are sentences rather than constraint failures:

| Situation | What happens |
| --- | --- |
| Share a locked folder | Refused before reading. *"That folder is locked. Unlock it before sharing it."* |
| Share a deck group or `Recently removed` | The control is absent, as it is for every other folder write |
| A shared folder is locked afterwards | The next publish refuses; the app marks the share **stale** and says why. It does **not** auto-revoke — that is the reader's press |
| Publish while over the size cap | Refused relay-side, with the measured size and the cap in the message |
| Publish while over the share cap | Refused relay-side, naming the count |
| Publish without a membership | 401 from the bearer gate; the app shows the connect story |
| Upload dies mid-`PUT` | The old snapshot goes on serving; the app reports the failure and keeps the link |
| Viewer opens a revoked link | **410**, *"This shared collection was withdrawn."* |
| Viewer opens a lapsed link | **410**, *"This shared collection is no longer available."* |
| Viewer opens a malformed id | **404** |
| Snapshot `v` is newer than the viewer | The page says so and offers the link to update, rather than rendering a partial binder |

---

## 11. Where the code goes

| Path | Holds |
| --- | --- |
| `src-tauri/src/share/mod.rs` | `ShareSnapshot`, `snapshot()`, the field selection |
| `src-tauri/src/share/publish.rs` | The two-step upload; desktop/Android only |
| `src-tauri/src/share/commands.rs` | `share_list`, `share_create`, `share_refresh`, `share_revoke`, `share_open` |
| `share/` | The web viewer bundle, `vite.share.config.ts`, `dist-share/` |
| `share-worker/` | `wrangler.jsonc`, `src/index.ts`, `src/shares.ts`, `src/blob.ts`, `src/page.ts`, `src/lapse.ts` |
| `src/features/share/` | The in-app view, the paste dialog, the want-list picker |
| `src/lib/ipc.ts` | The five commands and `ShareSnapshot`'s TypeScript mirror |
| `docs/reference/collection-sharing.md` | The record of what shipped |

---

## 12. Testing

**A committed golden snapshot is the fence**, for the reason `src/features/transfer/__golden__/`
exists and one degree harder: three implementations of one format, not two. One corpus, one
golden `.json`, the Rust writer asserting byte equality against it and both TypeScript readers
parsing it in their own suites. Drift becomes a red build rather than a viewer that quietly
disagrees with the publisher.

Beyond it, the tests that would have caught the failures this design is shaped around:

* a snapshot of a parent folder **includes** its subfolders' cards — the `folder_id = ?` trap;
* a snapshot of a parent folder **excludes** a locked subfolder's cards — the `exclude_locked`
  trap, and the one that leaks;
* a locked folder at any depth, and a folder whose ancestor is locked, are both dropped;
* `kind = 'deck'` and `kind = 'removed'` folders never appear;
* a snapshot's JSON contains no `purchase_price`, `notes`, `tags` or `acquired_at` key **for any
  input** — a sweep over the serialised text, not over the struct, so a future field addition
  fails it;
* `fields` omitted ⇒ `c`, `l` and `p` absent on every card, and present on none by accident;
* the relay: publish, replace, revoke, the caps, the `lapsed`↔`live` flip, the 410s, and the
  `claims.grp !== group` refusal — against `fakeD1.ts`, as the existing handlers are;
* the in-app viewer has no ipc write in its subtree — a source sweep, because the guarantee is
  structural.

**One test that must not be written**: an assertion that reads its own constant. The cap tests
take their number from the message, not from the binding.

---

## 13. Deliberately out of scope

* **Live shares.** A viewer reading the group's op log would need the group key, which is full
  read *and write* to everything the reader owns.
* **Per-viewer access control**, accounts, or a viewer identity of any kind. The link is the
  capability, and the UI says so in those words.
* **A URL scheme or an Android App Link** that opens a share in the app. `pair.ts` documents why
  adding one is its own piece of work with a trap in it.
* **Server-side paging and search.** Decision 2 makes them possible; §3.1's arithmetic says they
  are not yet needed. The format does not foreclose them.
* **Sharing decks or wishlists.** Same machinery would serve, and neither is what #360 asked for.
* **Reclaiming R2 storage from long-lapsed shares.** A sweep for the day it matters.
* **A wishlist folder bound to a share id** — §8.

---

## 14. Open, and only a measurement or a deploy can close it

1. **The real snapshot size**, over a collection larger than 275 rows. Plan step 1. The caps in
   §5.3 are provisional until it lands.
2. **Whether R2 can be enabled on the account** without changing the plan — the free tier is
   generous, but enabling R2 is a dashboard action only Markus can take, and *ask the host, never
   a document* applies.
3. **Workers Paid, or the free plan plus an alarm.** §7.1. Sharing puts anonymous traffic on the
   budget sync depends on, and this is a business decision.
4. **A custom domain.** It would fix the link's appearance and remove the Worker request from
   every blob fetch at once. Deferred, not rejected.
5. **The new Worker's name and URL**, which become a compiled-in constant beside `RELAY_BASE` and
   must match byte for byte on both sides — the trap `wrangler.jsonc` already documents for the
   OAuth redirect URI.

No agent may deploy any of it. `wrangler dev --local` is the only wrangler command an agent may
run.
