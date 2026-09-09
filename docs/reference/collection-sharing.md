# Shared collections — the record of what shipped

[Issue #360](https://github.com/Msgaihede/mtg-grimoire/issues/360), raised from Discord by
Giradeli. The design is
[2026-09-08-collection-sharing-design.md](../superpowers/specs/2026-09-08-collection-sharing-design.md);
this page is the record of what was built against it, with the reason at each site and the date on
every figure.

**The one sentence: a share is a snapshot the owner publishes, not a window onto their
database.** Everything a viewer sees was true when the owner last pressed publish, the owner
chooses what crosses, and nothing a viewer does can reach back. Every decision below is a
consequence of that.

It is **user schema v41**, **one new Cloudflare Worker** beside `relay/`, **one new D1 table** on
the database the relay already owns, and **two viewers** — a public web page and a top-level view
inside the app — reading **one format** written by **one Rust publisher**.

⚠️ **The spec says two D1 tables, twice, and one shipped.** Its header line and §5.2's own heading
both say *two*; §5.2's body defines `shares` and two indexes, and `share-worker/schema.sql`
creates exactly that. Nothing is missing — the second table was designed away and the counts were
not re-read. It is the failure this repository's own rule warns about: a prose-only edit routes to
neither CI job, so nothing goes red when a count rots.

⚠️ **None of it is deployed, and the constant in the binary says so.** Read
[the next section](#nothing-is-deployed-and-the-binary-says-so-in-words) before you draw any
conclusion from a link, a route or a request figure on this page.

---

## Nothing is deployed, and the binary says so in words

**`share::publish::SHARE_BASE` is `<set on first deploy>`**, and so is the `SHARE_BASE` var in
`share-worker/wrangler.jsonc`. They are one value in two languages and
`share::publish::tests::the_share_base_matches_the_workers_own_placeholder` reads the Worker's
config and asserts they agree byte for byte, so whoever changes one is asked about the other.

**A placeholder that cannot be mistaken for an address is the point.** A plausible invented URL is
worse than an obvious hole, because it is what gets copied into documentation and deployed
against — the failure `relay/wrangler.jsonc`'s `database_id` comment already records happening.

**And the app refuses in words rather than in reqwest's.** `share::publish::endpoint` asks whether
the effective base carries an `http(s)` scheme and answers `NOT_DEPLOYED` when it does not,
**before any request and before any `error_log` row**. Without that guard a connected reader
pressing *Share* met `builder error: relative URL without a base` — reqwest's sentence about a
mistake nobody made — and every list press folded an error row under `Source::Relay`. The test is
the **scheme** and not an equality against the constant, deliberately: `base == SHARE_BASE` would
start refusing everything on the day that constant became a real host, because no override is the
ordinary case.

The only way to exercise any of this today is the `sync_state` key **`share_url`**, a dev override
with no UI that mirrors `relay_url` exactly.

**What is missing is more than the address.** As of 2026-09-08:

| | State |
| --- | --- |
| The Worker | never deployed; it has no address to probe |
| `shares` in D1 | `share-worker/schema.sql` is written and has never been applied to the remote database |
| The R2 bucket | **R2 may not be enabled on the account at all** — a dashboard action only Markus can take (spec §14 item 2) |
| `RELAY_HMAC_KEY` on this Worker | not set; it must be the *same value* the relay holds or every publish is a 401 and nothing says why |
| `dist-share/` | built by no automated command — see [what nothing runs](#what-no-build-runs-and-what-that-costs) |

⚠️ **Do not conclude any of that from this page on the day you read it.**
[hosted-relay-deploy.md](hosted-relay-deploy.md) opens with the rule and this feature inherits it:
**ask the host, never a document.** Five files in this repository once agreed the relay was
undeployed and all five were wrong within a day. A `curl -I` is the only sentence that cannot rot.
`share-worker/README.md` carries the deploy runbook, and its step 0 is that same instruction.

**No agent may deploy.** `wrangler deploy`, `wrangler d1 execute --remote` and
`wrangler secret put` are the repo owner's; `wrangler dev --local` is the only wrangler command an
agent may run.

---

## The format

One JSON document, gzipped, versioned by `v` — `src-tauri/src/share/snapshot.rs` writes it and
`src/lib/shareSnapshot.ts` is the reader both viewers come through. Spec §3 has the annotated
example; what follows is what the shipped writer actually does with it.

**Short keys on the card, because that struct repeats once per copy** and the snapshot is what
crosses a stranger's network: `id n s cn f q fo img c l p`. The snapshot's own header is spelled
out (`v id title owner updatedAt marketplace currency fields folders cards`), because it occurs
once.

**Cards are a flat array and folders are a separate tree.** Nesting cards inside folders would
make the common viewer operation — filter across the whole binder — a tree walk, and make a card
that moves drawers a structural diff rather than a field change.

**`img` travels rather than being derived.** Scryfall's URLs are long and every one shares the
`https://cards.scryfall.io/normal/front/` prefix, which is exactly the shape DEFLATE erases;
deriving them would save a few percent and buy a dependency on a URL scheme this app does not
control. `image_uri::has_cache_buster` exists because that scheme has moved before.

### The absences are absences, not switches

**Six columns are absent from the format and cannot be turned on**: `purchase_price`,
`purchase_currency`, `acquired_at`, `acquisition_source`, `notes` and the collection's free-text
`tags`. Decision 3 first made `notes` and `tags` optional-and-off; the spec made them absent
instead, **because an optional field is a field a future switch can turn on by accident** and
these are the six a reader would most mind having published. `needs_review`, `condition_original`,
`tradelist_quantity`, `grading`, `serial_number`, `altered`, `signed`, `proxy` and `misprint` are
absent for the plainer reason that nothing in either viewer draws them.

**The fence is `no_private_field_can_reach_the_wire`, a sweep over the *serialised text* rather
than over the struct — so a future field addition fails it — and it reads values as well as key
names.** Both of spec §3's lists are in it, and each column the fixture can write a string into
has its value in it too, spelled `private-…` so a match is unambiguous.

**The value half is not decoration, and the mutation that proves it is the finding of the run.**
Swapping the select's `e.lang` for `e.acquisition_source` puts `"l":"private-source GP Copenhagen"`
on the wire **under an entirely legitimate key name** — and the key-only version of that sweep
passes it. Only `altered`, `signed`, `proxy` and `misprint` are key-name-only, honestly documented
as such, because a boolean has no distinctive value to carry.

⚠️ **The fence had two holes and both were about the _fixture_ rather than the list** (found
2026-09-08, in the whole-branch review). **`needs_review` was on both halves of the sweep and NULL
on every row the fixture made** — it is a free-text *sentence* the reconciler writes, and a column
the fixture never sets is a column fenced by its key name alone, so a leak under a short key would
have serialised as `null` and passed both halves. **`condition_original` was on neither half nor in
spec §3** — arbitrary text out of the reader's own import file, whatever their spreadsheet held
before the grade was normalised, sitting one line below `condition` in the very table the publisher
reads. Both carry a `private-…` marker now, both are on the list, and each was mutation-checked by
pointing the select's `e.condition` at them in turn. The general form is worth more than the two
columns: **a value sweep proves nothing about a column the fixture leaves unset.**

**The TypeScript half swept five key names and no values while calling itself *"the assertion that
the writer's absences are real"***, and it sweeps both now. The two fences are deliberately not one:
Rust's runs over a snapshot built at test time and so holds for every input, while
`shareSnapshot.test.ts`'s runs over the **committed** golden and is what goes red when a golden is
regenerated with a leak in it — the case where the writer's own suite moved in the same commit.

### `fields` advertises a question, never an answer

`fields` is on the wire even though a reader could infer it from the keys present, because a
binder whose cards all happen to be `NM` is indistinguishable from one published without condition
at all unless the snapshot says which question it answered.

**And `fields` naming a column does not promise every card carries it.** Three absences are
ordinary rather than edge cases, and the writer emits every one deliberately:

* **An ungraded copy carries no `c`.** `NONE` is schema v35's *not set* — an app sentinel rather
  than a grade — and putting it on the wire would ship a value every reader of this format would
  then have to know how to decode.
* **An unquoted finish carries no `p`.** `sorting::price_expr` answers NULL for a printing the
  marketplace does not list, which for a foil copy of a card priced only in `usd` is the ordinary
  case. `p` is `Option<f64>` and never `f64` for this reason: the flat read raised
  `InvalidColumnType` and **failed the entire publish over one unpriced card**. A `0.0` would be
  the app claiming a shop offered the card for nothing.
* **A folder whose parent is not itself in the snapshot carries `parent: null`.** A folder shared
  out of the middle of the cabinet is the root of the tree it publishes, so no edge ever points at
  a drawer nobody shared. A tree walk may assume every non-null `parent` resolves *within*
  `folders`; it may **not** assume a null one means "top of the owner's collection".

Both viewers render a missing `c` or `p` as an em dash. `shareSnapshot.ts`'s header states all
three, because that is the file both readers see.

⚠️ **Three implementations spelled that absence three ways, and one of them disagreed with the
writer about arithmetic** (fixed 2026-09-08). `share::publish::meta_body` sends `totalValue: null`
unless at least one card carried a price, on the stated grounds that *a `0.0` on a binder no feed
quotes is the page claiming it is worth nothing* — and `share/SharePage.tsx` folded a missing `p`
to zero, so a share published with `value` where the marketplace quotes nothing rendered **"Worth
$0.00 at TCGplayer prices"** on the public page: the exact number the writer goes out of its way to
refuse, mitigated by a `, with N unquoted` clause and still there. The page declines to state a
total now — *"No TCGplayer price is quoted for anything here"* — so there are three states rather
than two: prices were not shared, prices were shared and nothing is quoted, prices were shared and
something is.

**And the absence itself is now spelled `== null` everywhere, in both viewers.** It was
`=== undefined` in three readers and `?? null` in two others. The writer emits neither — `c` and
`p` both carry `skip_serializing_if` — but **nothing validates a document on the way in**, so a
`p: null` counted as *quoted*: it contributed 0 to the total and was left out of the unquoted
count, and a `c: null` would have rendered the blank cell both files' comments say must never
happen.

### The golden is the fence, and there are three implementations

`src-tauri/src/share/__golden__/snapshot.json` is committed, the Rust writer asserts byte equality
against it, and both TypeScript suites parse it. That is `src/features/transfer/__golden__/`'s
argument one degree harder: **three implementations of one format rather than two**, so drift is a
red build instead of a viewer that quietly disagrees with the publisher.

Two things about the artifact: it is stored **LF**, verified at the git-blob level and not merely
on disk; and its one price cell is the only byte in it that depends on `serde_json`'s float
formatting, which is worth knowing before anybody edits the fixture's price.

The golden is a **full** snapshot and exercises no absence. That is deliberate — the absences are
covered by targeted Rust tests that assert on the *serialised JSON* plus a TypeScript
delete-and-reparse case, so a second byte-exact artifact would duplicate coverage while adding a
second file to keep in LF and in sync.

**One user-visible sentence is spelled twice and is fenced the same way the rest is** (2026-09-08).
`OpenShareDialog`'s `NOT_A_SHARE_LINK` claims to be `share::publish::NOT_A_LINK` word for word —
the same paste can be refused on either side of the boundary, and a reader who typed one wrong
thing must not be told two different things depending on which half noticed — and nothing held the
two together. `OpenShareDialog.test.tsx` reads `publish.rs` through Vite's `?raw` and compares, the
trick `ipc.test.ts` already uses on the crate and `share::publish` already uses on the Worker's
`wrangler.jsonc`. Five lines, in a feature whose whole shape is *one format, N implementations,
fenced*.

### Size, measured

**Measured 2026-09-08, debug build, Windows**, by `share::tests::a_thousand_card_snapshot_is_measured`,
which prints rather than asserts so that it reports rather than rots:

| | |
| --- | --- |
| 1 000 cards, raw JSON | **273 117 B** (273 B/card) |
| the same, gzipped | **41 331 B** (**41.3 B/card**) |
| ratio | 6.6× |

Extrapolated linearly: **3 000 cards ≈ 124 KB gzipped**, **50 000 cards ≈ 2.07 MB gzipped**. The
Worker's `MAX_BLOB_BYTES` is therefore roughly 190 000 cards — far above any real collection, which
is the right side to be wrong on. The spec's pre-measurement arithmetic was low by 1.8× on the raw
figure and close on the compressed one.

**Treat 41.3 B/card as a floor.** Name and price entropy in the fixture are still optimistic.

⚠️ **The first fixture written for this measurement made it a fiction, and how it did is the
transferable part.** It filed every printing at `tsp 157` with a two-byte card id — and DEFLATE
erases repetition of exactly that shape, so the compressed number would have been a measurement of
the fixture rather than of the format. The fixture that produced the figures above uses
uuid-shaped ids, Scryfall-shaped image URLs, distinct names, climbing collector numbers, and a
rotation through four sets, three finishes and five grades.

> **A compression measurement is a measurement of its fixture's entropy first and the format's
> second.**

The same fixture round produced a second lesson of its own: the plan's fixture keyed `image_uris`
on `'normal'`, a key this app does not store (`image_uri::LIST_VARIANT` is `display`). Every `img`
would have been **silently absent**, all nine planned tests would still have passed, and the
41.3 B/card figure would have been measured over a document missing its longest field. **A fixture
can make a whole column untested without failing anything.**

---

## The publisher, and the two `collection.rs` traps

`src-tauri/src/share/` compiles for wasm as well as desktop — it reads SQLite and formats JSON;
only the upload is gated.

**A share does not ride on `collection::list_entries`, and that is the whole of its safety.** The
two reasons are both defaults that are right for the app and wrong here:

* **`folder_id = ?` is direct members only.** `CollectionQuery`'s named-folder arm pushes
  `e.folder_id = ?` and nothing else, so a share of a parent folder built on it would silently
  omit every subfolder — no error, no empty state, just a binder missing its best drawer.
* **`exclude_locked` is skipped entirely once a folder is named.** The guard reads
  `if q.exclude_locked && q.folder_id.is_none()`, because *standing in a locked folder names it,
  and a named folder is served whole*. That is the correct rule for a reader clicking into their
  own drawer and **a leak in a share**.

So `share::snapshot` is its own read, and its shape is the inverse of `CollectionQuery`'s:

1. resolve the subtree from the named folder, or from the root for a whole-collection share;
2. drop every folder that is locked **or has a locked ancestor**, through
   `collection_folders::LOCKED_FOLDER_IDS` — the app's single copy of the inheritance rule, so
   there is never a second opinion about what "locked" means;
3. drop every folder whose `kind <> 'user'` — deck groups and `Recently removed` are never
   shareable;
4. read the entries of what survives, join `cards` for the name and image, and price through
   `sorting::price_expr` **only if `value` is in `fields`**;
5. emit.

> **`CollectionQuery`'s unasked question keeps every row; this one's keeps none.** A whole-collection
> backup is the one read that must never ask. A share is the opposite kind of read: an unasked
> question here must publish *less*, never more.

The recursive CTE uses `UNION` and never `UNION ALL`, `delete_folder`'s reason for the same word:
the duplicate-row check is what makes a `parent_id` cycle — a hand-edited database, a restored
backup — converge instead of running forever.

### The three refusals, in order, before a row is read

`FOLDER_NOT_FOUND` → `FOLDER_NOT_SHAREABLE` → `FOLDER_IS_LOCKED`, and the order is asserted.
A folder that is not there can never report as locked, because *"unlock it"* is advice nobody can
act on for a drawer that does not exist.

**A locked folder is refused rather than published empty**, and the mutation that proves why is
worth keeping: replacing `effectively_locked` with a plain `locked <> 0` produces
`ShareSnapshot { title: "Top shelf", folders: [], cards: [] }` — a **success** carrying nothing,
which is precisely spec §4's *"an empty snapshot that reads as this person owns nothing"*. That is
why the **refusal** had to be fenced and not merely the exclusion.

### The root arm, and the leak that sixteen green tests did not see

The card read gates `e.folder_id IS NULL OR` on `folder_uid.is_none()` — the root's unfiled cards
belong to a whole-collection share and to no named-folder share. **Making that arm unconditional
left sixteen tests green**, the original fourteen included, over a share of one small binder
carrying **every unfiled card the reader owns**. It is fenced now by a test written for exactly
that mutation, and by a second that pins the root arm's dependence on the lock exclusion.

Both mutations here are the same lesson from opposite ends, and it is the one
[the rules section](#the-rules-this-run-earned) generalises: **a leak and a refusal each need
their own fence, because the exclusion working does not prove the refusal fires and the refusal
firing does not prove the exclusion holds.**

### Two wire decisions the design did not take

`condition = 'NONE'` emits **no `c` key**, and a folder whose parent is outside the snapshot gets
`parent: null`. Each is one line to reverse and each is fenced by a test. What a reader loses is
the ability to tell *"no condition recorded"* from *"condition not shared"* for a single card —
and the snapshot-level `fields` array still answers that for the share as a whole.

---

## Publishing: the two-step, and what it does not buy

```text
read the snapshot → POST the metadata → PUT the gzip → only now write collection_shares
```

The relay's row does not point at the new blob until the blob has landed, and the app does not
point at the *share* until the relay has said it did. A publish that dies halfway leaves the
**previous** snapshot serving — `sync_engine::client::post_rotation`'s commit-last shape and its
reason: a half-published share is a broken link in somebody's Discord, and the old one is never
worse than that.

**The snapshot is read first even though the id comes second**, which reverses the order the plan
wrote. Two things force it: the `POST`'s metadata carries `cardCount`, which is a fact about the
read; and the three refusals above belong **before** any request, or a folder the app is about to
refuse has already left a row on the relay. `share::snapshot` takes the id as an argument
precisely because it is the relay's to mint, so the document is built with an empty one and
stamped when the answer comes back.

That order is pinned, and the pin is a real fence rather than a smoke test: with the shipped
order a locked folder on a placeholder-host database answers `FOLDER_IS_LOCKED`; with the order
reversed the same fixture answers `NOT_DEPLOYED` — a different sentence pointing the reader at a
different problem.

⚠️ **What the two-step buys is the blob, the link and the cached row — and not the header above
them.** The Worker's `POST` updates `title`, `owner_name`, `card_count`, `total_value` and `fields`
on the existing row *before* the `PUT`, and the public page draws its heading and its card count
from that row. So a **republish** that dies between the two steps goes on serving the previous
snapshot under a header describing the new one — 412 cards promised, 400 delivered — until the next
successful publish. That is strictly smaller than a dead link and is the trade the shape was
chosen for; it is written down because the paragraph above it reads like a stronger promise than
it is.

### The five commands

`share_list`, `share_create`, `share_refresh`, `share_revoke`, `share_open` —
`src-tauri/src/share/commands.rs`, mirrored in `src/lib/ipc.ts`, and the mirror is fenced by
`ipc.test.ts`'s parsers over the Rust source rather than by two hand-typed lists.

Three of the five are worth a sentence each:

* **`share_list` reaches the network, best effort**, and is the only one of the five that could.
  Spec §4.3 has a second device inherit the owner's name from the relay's list, and every other
  command needs an id or a name that device does not yet have — so this is the only press that
  could ever learn the group's shares. No membership means no request at all; a failure answers
  the cache. `web/route.rs` routes the **pure** cache read alone, so the browser build gets no
  network command.
* **`share_open` answers `serde_json::Value`**, not a typed struct. `ShareSnapshot` cannot
  implement `Deserialize` — `fields: Vec<&'static str>` has no owned form — and spec §10 wants a
  newer `v` **told about** rather than refused, which a strict Rust struct turns into a parse error
  at the wrong layer. Rust gunzips and refuses a non-object; TypeScript's `parseSnapshot` draws the
  version conclusion, which is where that rule already lives.
* **`share_open` needs no membership and sends no token.** Viewing is open to everyone and the
  link is the whole of the capability.

All five run on the **write** connection through one `spawn_blocking` helper, so each can record
its failure in `error_log` — and because a guard on a `Mutex`-held connection cannot cross an
`await` on a multi-threaded runtime. That is `sync_engine::commands::sync_now`'s shape exactly,
precedent rather than a new sin.

**The consumer side takes the value as a value.** `shareSnapshot.ts` exports `parseSnapshotValue`
beside `parseSnapshot`, and the in-app viewer calls the former: re-serialising what
`share_open` already parsed would be a full JSON round trip over 2.07 MB at the 50 000-card size,
done to learn nothing.

### The refusals are sentences

`NOT_DEPLOYED`, `NOT_CONNECTED`, `MEMBERSHIP_REFUSED`, `OWNER_NAME_REQUIRED`, `UNKNOWN_SHARE`,
`NOT_A_LINK`, `SHARE_IS_GONE`, `NO_SUCH_SHARE`, `SHARE_NOT_READY` — `share::publish` holds them all
and `refusal()` is the pure function that picks one. Two of them carry a rule:

* **A 401 here does not revoke the grant.** `client::lapsed` exists because a 401 on push, pull or
  ack leaves nothing to try; here the token came back from `/token` seconds ago, so the authority
  on whether a membership ended is the next sync. Taking the grant away over this would tell a
  reader their membership ended because a binder failed to publish.
* **The two cap refusals are matched on `code` and never on the sentence** — `share_limit` and
  `blob_limit` — because the copy is free to be improved and a 403 already means other things.
  That is `entitlement`'s `device_limit` rule, and it is the one that was learned the hard way.
  The Worker's own `error` string is kept where it exists, because **the number is in it** —
  *"that snapshot is {size} bytes and a share may be at most {cap}"* — which is the difference
  between a refusal a reader can act on and "too big".

---

## User schema v41 — `collection_shares`

⚠️ **v41 was this branch's guess.** Every open branch adding a rung guesses the same number; read
*Schema rung collisions with main* before assuming the number here survived the merge.
`src-tauri/CLAUDE.md`'s ladder record carries the rung's own paragraph, and **that record routes to
neither CI job**, so a renumber on the way in rots it silently.

**It is a cache and it is not synced.** No `sync_uid` column, no `SYNCED_TABLES` entry — the relay's
`GET /g/{group}/shares` is the roster, exactly as the rewrapped key set is the roster for group
membership and for the same reason: a synced copy would be a second record of a fact the relay
already holds, and the two would disagree the first time a device was offline during a revoke.
What the table buys is a *shared* badge on a folder that survives being offline, and the links to
go with it. `share::cache::reconcile` therefore **deletes** — a share the relay does not name has
left — and it deliberately does not write `published`, which records when *this* device last
uploaded and which the relay knows nothing about.

**`owner_name` and `url` are columns rather than derivations**, and both were added to the rung
after it was first written, inside the same unshipped v41. The name is what the *next* device in
the group publishes under instead of asking the reader to type it again; the link is built by the
Worker from its own binding, so rebuilding it in Rust would be one string built twice — and a
placeholder until the day the Worker is deployed. Neither can be answered offline by anything but a
column, and answering offline is the one thing this cache exists for.

### Both partial unique indexes, and the one that refused nothing

```sql
CREATE UNIQUE INDEX idx_collection_shares_folder
  ON collection_shares (folder_uid) WHERE folder_uid IS NOT NULL;

CREATE UNIQUE INDEX idx_collection_shares_whole
  ON collection_shares ((folder_uid IS NULL)) WHERE folder_uid IS NULL;
```

The first says a folder may be shared once. A whole-collection share carries a NULL `folder_uid`
and so is in no index at all, which is why there is a second.

⚠️ **The obvious second index — `ON collection_shares (folder_uid) WHERE folder_uid IS NULL` —
refuses nothing.** The reasoning first written beside it (*every admitted row shares the same null
key, so at most one row can exist*) is exactly backwards: **SQLite holds NULLs in a UNIQUE index as
distinct from each other**, so a second whole-collection share goes straight in. Measured on SQLite
3.53.0 with `node:sqlite`, then reproduced as a red Rust test, then reproduced again independently
by the reviewer rather than taken on the report's word. Indexing the **expression**
`(folder_uid IS NULL)` stores the same non-null `1` for every row the partial index admits, which
is what makes the second one collide.

It is `COLLECTION_GRAIN`'s `coalesce(folder_id, 0)` argument reaching a second table. The
one-index alternative — `UNIQUE (coalesce(folder_uid, ''))`, which is what the relay's own index
does — was available and deliberately not taken: two indexes say the two rules separately, and the
relay's has to fold a `group_id` in anyway.

**A store therefore deletes the other row on the folder first**, and that is not tidying: the relay
mints a *new* id when a withdrawn folder is shared again, so the insert would otherwise collide
with the tombstone of the share it replaces. The folder key is `coalesce(folder_uid, '')` there for
the same NULL reason — `folder_uid = ?` matches nothing at all for a whole-collection share.

---

## The Worker

`share-worker/` — a **second** Cloudflare Worker beside `relay/`, binding the same D1 database and
the same `RELAY_HMAC_KEY` so it can verify a token the relay minted without a service binding.
**`relay/`'s source and its deploy are untouched by this feature.**

**The reason is blast radius rather than tidiness.** Sync is a paid feature people depend on;
sharing is new and will churn, and every deploy is done by hand by one person. One Worker carrying
both means a bad share deploy is a sync outage.

`share-worker/README.md` is the operational page — the routes, the deploy steps, the testing
notes. What follows is the part that belongs in the record rather than in the runbook.

### The invariant that now has an exception

`relay/src/index.ts` argues, correctly, that the relay can decrypt nothing it stores. **That
argument does not extend to this Worker.** By decision 2 a share snapshot is stored **in the
clear**, and Cloudflare — and Markus — can read it. What that buys is the OpenGraph card in
Discord, a server-rendered landing page, and the freedom to page server-side later without
re-cutting the format. What it costs:

* the app must never send a field a reader would not put on a public page — the six absences are
  the fence, and they are absences rather than switches for exactly this reason;
* a compromise of this Worker's D1 or R2 is a compromise of every shared binder **and of nothing
  else** — the sync log's ciphertext is in a different Durable Object under a different key, and
  this Worker holds no key material at all;
* **the privacy claim the app makes is "anyone with the link"**, and must be worded that way in
  the UI. Not "private", not "encrypted".

### Nothing here reaches a Durable Object

The Worker binds none, and `wrangler.jsonc` carries no `durable_objects` and no `migrations`. **A
DO is the line that meters** — a request that reaches one costs a Durable Object request whether it
is honoured or refused — and this is the Worker that will carry anonymous traffic. Its state is D1
and R2, which bill per operation.

`/assets/*` is routed to **no code here** for the other half of the same argument:
`wrangler.jsonc`'s `assets` binding names `/s/*` and `/g/*` as the only `run_worker_first`
prefixes, and a static asset request is free and unlimited even on the free plan. Adding a route
for the viewer bundle would put every viewer's JavaScript on the account's daily budget.

### The page a stranger lands on, and the one trap in it

`GET /s/{id}` is rendered from the D1 row rather than served as a static file, which is what lets
the HTML carry OpenGraph tags built from that row — *"Giradeli's Trade binder · 412 cards"*. That
card is the concrete thing decision 2's plaintext storage buys, and it is worth one Worker request.
Every response the page module produces carries `noindex`, the shell and both 410s and the 404
alike, because it sits in one shared template.

⚠️ **`page.ts` interpolates a title and an owner's name that a reader typed, and there is no
template engine.** One `esc()` — five characters, `&` first — covers every interpolation site,
including inside `content="…"` and `href="…"`. **A new field rendered without it is an XSS on a
page strangers open.**

### R2, and the key shape

`shares/{id}/{hash}.json.gz`, where `hash` is the first 16 hex characters of the body's SHA-256 —
content-addressed, so the URL is immutable and can be served
`public, max-age=31536000, immutable`. The superseded object is deleted **after** the row has moved
and **only when the key actually changed**: a republish of an unchanged collection is
content-addressed to the same key, and a delete that skipped that comparison would erase the object
it had just written.

⚠️ **The `PUT` buffers rather than streaming straight into R2, and the plan's "no buffering" was not
implementable.** A content-addressed key needs the digest *before* the object can be named, and
R2's Workers binding has no rename and no server-side copy. The bound is preserved differently:
chunks past `MAX_BLOB_BYTES` are dropped as they arrive, so a caller who omits or lies about
`content-length` still cannot make the Worker hold more than the cap.

**What `immutable` costs** is that revoking cannot recall an edge copy somebody already holds. What
revoking *does* stop is every new viewer, because the shell is the only thing that hands out that
URL and the shell is `max-age=300`.

### `live` / `lapsed` / `revoked`

| State | Written by | Reversible? |
| --- | --- | --- |
| `live` | a publish, and the daily pass lighting a revived membership | — |
| `lapsed` | **the daily cron only** | yes — the next pass lights it again |
| `revoked` | **the reader's own press only** | **no — terminal** |

Both non-live states answer **410** and not 404, with different sentences: a viewer should learn
that a share was withdrawn or expired, not that they mistyped a link.

> **`state` is a state and not a `revoked_at` stamp, and decision 5 is why: a lapsed membership
> darkens a link and a membership that revives must light it again. A timestamp can only be set.**

**Which pass moves it.** `share-worker/src/lapse.ts` is a daily cron on **this** Worker at
`30 3 * * *` — `30` and not `0` because `relay/wrangler.jsonc` already owns `0 3`, and a trigger
here rather than a second job inside the relay's `reconcile` because §5.1 keeps the relay's source
and deploy untouched. It is the account's second cron trigger of the free plan's five.

It reads `entitlements` — the relay's table in the shared database — and writes `shares.state`: a
group whose subject is `dead` has its **live** shares darkened, and one that is `active` or in
`grace` has its **lapsed** shares lit. `grace` **serves**: a declined card is a failed payment
Patreon retries, not a cancellation the reader chose.

**It reads the stored `status` and does not re-run `decide`.** `relay/src/claim.ts`'s `reconcile`
is what moves a subject through `active → grace → dead` against Patreon, and a second opinion here
would be one account with two answers to when a membership ended.

**A group with no entitlement row at all goes dark**, which is the opposite of what the plan's SQL
would have done and is better: `/claim` *moves* a binding rather than refusing one, so a subject
who reconnects on another group leaves this one entitled by nothing — a real state rather than a
hypothesis. Fail closed, because `lapsed` is the reversible direction: a group that should not have
gone dark lights again on the next pass, where a group that should have gone dark and did not,
never does.

**The candidate query ahead of the `UPDATE` is deliberately not narrowed** to the rows that can
move. Narrowing it would be free and correct — and would make the `AND state = ?` clause
**unreachable** for a group whose only share is a tombstone, which is exactly the case that clause
exists for. Choosing a slightly wider read to keep a guard testable is the trade at this size, and
`lapse.ts` and the README both say so, so nobody optimises it away.

**`updated_at` is written only to rows that actually moved**, pinned by two tests, because the
public page renders that stamp and a nightly restamp would make every share claim it had been
refreshed at 03:30.

**And because the verdict is written into the column, `GET /s/{id}` reads one row and branches on
`state`** — no join to `entitlements`, no second query. Putting the entitlement check on the read
path would make every anonymous view a two-table read on the account's shared D1 budget, to answer
a question that changes at most once a day.

### The tombstone, the partial index, and the 500 that shipped for one commit

```sql
CREATE UNIQUE INDEX shares_folder ON shares (group_id, coalesce(folder_uid, ''))
  WHERE state <> 'revoked';
```

⚠️ **`WHERE state <> 'revoked'` is load-bearing and the design carried the total index until this
run.** Two requirements collide in it: a revoked row **stays**, because it is what answers 410
rather than the 404 that says a viewer mistyped; and re-sharing that folder mints a **new** id,
because a revoked link must stay dead. Those two sentences are together a second row on the
folder's key, which a total unique index refuses — measured against real SQLite, the publish after
any revoke dies with `UNIQUE constraint failed: index 'shares_folder'`.

⚠️ **And the lookup in front of it has to carry the same predicate.** Without it `.first()` answers
the tombstone, every publish after a revoke takes the mint-a-new-id branch, and **the third press
is an uncaught 500 for ever** — i.e. every Refresh of that folder after a revoke, permanently.
**Two publishes cannot see it**, because the second one is *supposed* to mint a new id, which is
why the regression test publishes **four** times around one revoke and pins the id from the second
press on. Both folder-key reads now route through one `serving()` helper.

**`relay/src/fakeD1.ts` cannot check any of this** — it models column keys, not expression indexes
and not partial ones — so both halves were driven against real SQLite with `node:sqlite` over the
shipped `schema.sql`. That is the general shape: *an index the test double does not implement is an
index the suite cannot fence.*

**Revoked tombstones accumulate unbounded.** There is no retention rule and none was invented; it
is a sweep for the day it matters, beside spec §13's identical note about reclaiming R2 storage
from long-lapsed shares.

### The caps

`MAX_SHARES_PER_GROUP`, `MAX_BLOB_BYTES` and `MAX_TEXT_CHARS` (the title and the owner's name) are
the three, and the constants are the authority rather than a number written here.

**`fields` gained a fourth bound in the same round, and its ceiling is the format's own arity
rather than a number somebody picked.** Checking each element does not bound the array —
`["condition"]` repeated a hundred thousand times passes every element check and is a megabyte of
JSON text in a column of a D1 database the whole account shares. `fields` is a *set* over three
known names, so anything longer than that is duplicates or junk.

---

## The request budget, and what the caching actually buys

**The Workers free plan's 100,000 requests/day is per *account*.** A share that goes viral draws on
the same budget every paying reader's sync depends on, and past the ceiling *every* reader starts
erroring at once — the cliff the relay's existing 70% alarm was added for. **Nothing in this design
can bound how many strangers click.**

What the design does do:

* **the viewer bundle is a static asset**, free and unlimited, served without reaching this Worker
  at all;
* **the blob is `immutable` for a year** with `caches.default` in front of R2;
* **the shell is `public, max-age=300`** *for a share that is serving*, so a reader who reloads
  inside five minutes spends nothing.

That puts a cold view at roughly **two Worker requests** — the shell and the blob.

**The five minutes are conditional, and the two exceptions are the interesting part.** A shell for
a row whose blob has not committed answers **`no-store`**, because that state is transient and the
advice on the page is *reload*; and **both 410s answer `no-store` too**, because `lapsed` is
reversible — a reader who renews must not be told for five more minutes that their link is dead —
and a 404 becomes a 200 the moment a publish lands on that id. A gone page also carries **no
metadata and no OpenGraph tags at all**: a withdrawn share whose card went on advertising the
binder in every Discord it was ever pasted into is most of what withdrawing it was for.

⚠️ **Two facts qualify the warm one, and both are recorded rather than assumed** (spec §14 item 6):

* **The Cache API does not read through.** A `caches.default` hit still costs a **Worker request**;
  what it saves is the R2 read. So *"a warm view costs zero"* holds through the **browser's**
  `max-age`, not through `caches.default` — every distinct viewer inside the shell's 300 s still
  spends one Worker request against the shared daily budget.
* **Cloudflare's Cache API page does not name `workers.dev`.** It grants functional cache
  operations to *custom domains* and to Pages functions on `*.pages.dev`, and conspicuously omits
  the address this Worker would first be deployed at. If the Cache API is inert there, *"a warm
  view costs no R2 read"* quietly stops holding on the first deploy. **It fails open** — an extra
  R2 read, nothing breaks — so this is a `curl -I` after the first deploy and not a document to
  argue with.

**A custom domain would fix two things at once** and is deferred, not rejected: nobody wants to
paste a `*.workers.dev` link into a Discord, and a domain would let R2 serve the blob with no
Worker request at all. **The clean fix for the ceiling is the $5/month Workers Paid plan**, which
is a business decision rather than an engineering one.

---

## The two viewers

### The public one — `share/`, built by `vite.share.config.ts`

A third Vite build importing from `src/` — the card tile, the image helpers, the design tokens —
and importing **nothing** from `src/lib/core`, `src/lib/ipc`, `src/workers`, `src/features` or
`@tauri-apps/`. It never opens OPFS, never loads wasm, and never registers a service worker.
**It has no core at all**: it fetches one JSON document and renders it. `SharePage.test.tsx`
walks the real import graph — resolving `./foo` against the **importing file's** own directory, so
relative-only modules are reachable — and counts a side-effect and a dynamic import as imports.

That is not stylistic. A stranger following a Discord link into the *web target* would meet a
75 MB corpus ingest, a 2.64 MB wasm module, and an OPFS pool that is exclusive per origin and
refuses a second tab. All three at once.

⚠️ **Spec §7 also says `src/pwa`, and the shipped fence deliberately does not.** `@/lib/images`
imports `@/pwa/target`'s `isWebTarget`, so the graph reaches one pure function in that directory;
`vite.share.config.ts` defines `__CORE__` as `"web"`, and the reviewer confirmed neither
`__CORE__` nor `"web"` survives into the built JS, so the branch is folded away. Nothing about a
service worker or a core reaches the bundle. Do not "fix" the sweep to match the spec sentence
without re-reading this paragraph.

**Measured 2026-09-08** by `vite build --config vite.share.config.ts` on this branch:
`dist-share/assets/share.js` is **486.74 kB, 141.49 kB gzipped**, one chunk, with the fonts as
separate assets beside it. (It read **486.47 / 141.43** earlier the same day; the whole-branch
review's guards — the total that declines to state itself, the `== null` absences — are the 0.27 kB
between them. Re-measured rather than left standing, because `npm run share:build` answers it in
three seconds and this is one of the few numbers on this page a command re-derives.) **The entry name is pinned rather than content-hashed**, because the
Worker's shell links `/assets/share.js` by a fixed name and cannot learn a Vite manifest without a
second Worker request.

Five things a future editor needs:

* ⚠️ **The shell's inline `<style>` is unlayered and Tailwind's utilities are not.** Its bare
  `body`, `main`, `h1` and `p` rules beat a layered declaration at any specificity, so they would
  repaint every paragraph and clamp every container on this page whatever class it carries.
  `main.tsx` reads the shell's `<style>` elements **before** adding its own and then removes them.
* ⚠️ **The blob URL is inlined in the shell** as
  `<link id="snapshot" rel="preload" as="fetch" crossorigin>`, rather than offered as an
  `index.json` route, because the shell response is already holding the fact a second request would
  go and fetch. **A row whose `object_key` is still NULL gets no `<link>`, and its absence is the
  signal** the viewer reads to draw *still uploading*.
* ⚠️ **`credentials: "omit"` on the fetch made Chromium discard that preload.** The `<link>`
  requests in credentials mode `same-origin` — `fetch`'s own default — so passing `"omit"` made the
  modes disagree and the warmed response was dropped on the floor: *"a preload for … is found, but
  is not used because the request credentials mode does not match"*. The blob was then fetched
  **twice on every cold view**, defeating the whole point of inlining the link. Measured in the
  running page 2026-09-08 and re-measured after the fix: one request, `initiatorType: "link"`.
* **A row is not identified by id + finish + folder + condition.** The first version keyed the card
  list that way and React is entitled to drop one of a duplicated pair. The fence is a
  `console.error` spy rather than a length assertion, because React emits the duplicate-key warning
  on first mount too. The fixture uses two `structuredClone`s of the same card, so it agrees on
  **every** field rather than on the four the old composite key happened to name.
* **The folder rail re-roots whatever the walk did not reach**, and that line is the difference
  between a malformed document *losing* a drawer and merely mis-nesting one. **A cycle has no root
  at all** — every folder in it names a parent that resolves — so a walk from `null` finds none of
  them, and the rail silently loses every drawer in the loop *and the way to the cards inside it*.
  The current writer cannot produce one; **the viewer parses a document it did not write**, and
  `parseSnapshot` promises nothing about the folder graph by design. Deleting the rescue does not
  mis-nest a drawer — it removes **all** folder navigation, because the rail is gated on being
  non-empty, so the failure is a missing landmark rather than a wrong one. `src/features/share/shareTree.ts`
  is the same rule for the in-app viewer.

Both live-found bugs above are **pinned**: reverting either fix reddens a named test. A bug found
by hand and fixed without a fence comes back the next time somebody touches the file, which is the
whole reason the live pass was worth doing.

### The in-app one — `src/features/share/`

A new top-level view; `ViewId` gains `"shared"`, and the rail row appears only once the reader has
opened at least one share (decision 6), so nobody who never uses the feature pays a rail slot for
it.

**It is opened by pasting a link.** The app reads no launch intent and declares no URL scheme;
`relay/src/pair.ts` carries the whole argument for why adding one is a separate piece of work with
an Android trap in it.

**The read-only guarantee is structural, and it has to be.** There is no read-only mode anywhere on
this app's data path — `lock_db_read` returns the *write* connection on wasm, and `src/lib/writes.ts`
is only about which mutation owns the error banner — so a flag would be a claim rather than a fence.
What this view has instead is that it renders a **fetched document**, and every command it names
is enumerated in one file.

`readOnly.test.ts` is that check: an `import.meta.glob` over the whole subtree, sweeping for
`ipc.<name>` against two enumerated lists, plus four **back doors** refused outright
(`ipc["…"]`, a binding taken off `ipc`, `ipc` passed as an argument, a namespace import) because
none of the four has a legitimate use here and *"absent"* is a complete answer. It carries its own
anti-vacuity guard, because a moved directory would otherwise turn the guarantee into a green build
over an empty set.

**The roster of what the view may call is `READS` and `WRITES` in that file, and the build answers
both.** Spec decision 8's want list — tick rows, press *Add to wishlist*, choose a folder the
reader already has — **is** a write, and it landed in `AddToWishlist.tsx`. It went onto a **second
list** rather than as two more entries on the first, so `READS` stays only reads and a diff that
touches `WRITES` is a diff about the view's promise: **every name there has to be a write to
something else the reader owns.** A `shareRefresh` or a `collectionAdd` on that list would be the
promise gone, whatever the sweep then said.

The want list itself takes nothing new: no table, no synced column, no schema rung. It folds the
picked copies onto one wish per printing and finish, offers the wishlist cabinet as it stands —
**no folder is minted here**, because §8 defers binding a folder to a share — and says which
copies are already on the reader's list, since `wishlist_add` folds onto the grain and a second
add would otherwise be silent. **The tick is gated on the same answer the figure line is**: against
the empty index every card reads *wanted 0*, so a want list built during the sweep would offer to
add cards the reader already wants with nothing on screen saying so.

**The cross-reference is the reason to open a share in the app at all** — *you own 2 · you want 3*,
from two sweeps over the reader's own lists. Three things about it:

* **Two reads, folded, never materialised.** There is no by-id read on either list, so the sweep
  walks both once and folds each page into a map, **discarding the rows**. At 50 000 cards, holding
  every row to build a `Map<string, number>` is the whole list in memory for an answer that fits in
  a few hundred kilobytes.
* **The answers are filed under `["collection", …]` and `["wishlist", …]`**, not under `["share"]`,
  because that is what they are reads *of* — so every existing write that changes what the reader
  owns already invalidates them. Filed under `["share"]` they would be correct on the first draw
  and 30 seconds stale after the reader's next add, `staleTime` making a missing invalidation look
  like a considered figure.
* ⚠️ **`ready` was computed and then never consumed**, which drew `You own 0 · You want 0` on every
  tile until both sweeps finished — up to ~100 round trips at 50 000 cards — and made the two filter
  chips act on that zero: *On your wishlist* said "Nothing here matches" and *You do not own it*
  showed the whole binder. **No test caught it because every cross-reference case `waitFor`ed past
  the window.** The fix's test holds `collectionList` open with a hand-resolved promise and asserts
  *inside* the loading window.

**`staleTime: Infinity` and `retry: false`** on the fetched snapshot, against the app's defaults: a
snapshot does not change on its own, and every refusal the crate returns is a sentence and terminal.
The view offers a *Check for an update* press, which is `refetch()`.

⚠️ **The blob fetch asks for gzip and then sniffs for it, and both halves are insurance against a
question no document can settle.** `src-tauri/Cargo.toml` builds reqwest `default-features = false`
with **no `gzip` feature** — deliberately, because Scryfall's bulk data is a real `.gz` *file* and
transparent decompression would corrupt it — so this client decodes nothing itself and, until
2026-09-08, sent no `accept-encoding` either. The Worker stores a gzipped object and nails
`content-encoding: gzip` on by hand (`share-worker/src/blob.ts`), and `parse_snapshot` ran
`GzDecoder` unconditionally. **An edge that answered an `accept-encoding`-less client with the
identity body would therefore have failed every in-app open with a corruption sentence on a
perfectly healthy share** — and whether Cloudflare does that on this deploy is a fact about the
deploy. So `open` sends `accept-encoding: gzip` explicitly and `parse_snapshot` branches on the
`1f 8b` magic, reading anything else as the JSON it may well be; either answer opens.
`share-worker/README.md`'s step 5 is the two `curl`s (`-sI --compressed` and bare `-sI`) that say
which answer the deploy actually gives, and **nobody has run them, because nothing is deployed.**

**The in-app viewer's field guards are the public page's, crossed** (2026-09-08). `parseSnapshotValue`
guarantees three things — an object, a `v` that is not newer, and two arrays — and everything past
that is `snapshot as ShareSnapshot`, a **cast rather than a strip**. `share/SharePage.tsx` built
`asText`, a nullable `asOf` and an `Array.isArray(snapshot.fields)` check for exactly that and
explains why in its own comment; none of it had crossed, so a body that parsed and omitted
`currency` threw inside `snapshot.currency.toLowerCase()` **during render**. **The exposure is the
opposite way round from the page the guards were written for**: the web viewer only ever loads its
own Worker's blob, while this view opens whatever `shareLinkFrom` lets through — the scheme and a
`/s/{id}` tail, with the **host deliberately unchecked so a fork works** — so any page anywhere
serving a gzipped `{"folders":[],"cards":[]}` reaches this render. And `grep -rn
"componentDidCatch\|getDerivedStateFromError" src/` answered **nothing**: a throw here unmounted the
whole app to a white window whose only recovery was restarting the program. `SharedBoundary` is the
app's one error boundary, scoped to the one view whose document arrives from a pasted URL.

### The entry point, which decision 6 left nowhere to put

Spec decision 6 hides the *Shared* rail row until a reader has opened a share, and the collection's
control is for **publishing** — so nothing in the app offered a reader their *first* share. Binding
`switchView` against the whole of `NAV` rather than the filtered rail made `Ctrl+6` open the view
either way, landing on an empty state with a paste button. **That fixed reachable and not
discoverable.**

So *Open a shared collection* sits beside the Share control on the cabinet, mounting the same
dialog. Both halves of the feature then live in one place — publish your binder, open somebody
else's. Making the rail row unconditional would have fixed discovery by spending the slot decision
6 exists to save, on a feature most readers will never use.

⚠️ **The chord is gone, and this view is the destination that goes without one** (2026-09-08,
after `origin/main` brought Trade and Playtesting into the rail). `NAV` holds **ten** destinations
against `Ctrl+1…9`, and `Ctrl+0` is not a tenth step of that run — so one row has to have no
chord, and which one is forced by what a chord is *for*: it does not move. Every other row is on
the rail for every reader; `shared` appears only once a link has been opened, so a digit bound to
it would either shift the digits after it — one press meaning two things to two readers — or point
at a row half the readers do not have. `AppShell.tsx`'s `CHORD_NAV` is `NAV` minus that one entry,
derived rather than written out, and `AppShell.test.tsx` pins the consequence by name: *"gives the
Shared view no chord, and `Ctrl+6` reaches Scanner instead"*.

**What it costs this view is nothing, and the paragraph above is why**: the route the chord had was
a *fallback*, written when the app offered no first share at all, and the cabinet's control is the
signpost it was standing in for. Once a share is open the rail row is the way back.
`docs/reference/keyboard-shortcuts.md` carries the ruling; `src/App.tsx`'s dispatch comment claimed
the chord still worked until this pass, which is the **third** site on this branch to ship a comment
contradicting its own code — `nav.ts`, `shortcuts.ts` and `AppShell.tsx` were all updated when the
chord went and that one was not.

### The Share control

`src/features/collection/ShareFolderMenu.tsx` — publish the level on screen, copy its link, update
it, withdraw it.

* **Hidden, not greyed, for a reader who has connected nothing** (spec §9). A control whose only
  outcome is a sentence explaining that it does not work teaches a reader nothing its absence would
  not, and Settings is where the connection story lives. A membership that *ended* keeps the
  control, because that reader has connected something and the publish is what refuses, in words
  that name where to go.
* **A locked folder greys the row with `unlock it first`** — the phrase `Delete…` already uses,
  deliberately, because it points at the same next thing to do, and because a menu row is as wide
  as its widest content so the full sentence would set the width of the whole panel.
* **A share whose folder was locked afterwards is marked stale and is never auto-revoked** (spec
  §10). The next publish refuses, so the snapshot on the relay is frozen rather than wrong. A link
  in somebody's chat window going dead because its owner tidied a drawer would be the app taking a
  decision nobody asked it to take.
* ⚠️ **`SUPPORTER_KEY` and `supporterState` belong in `src/lib/query.ts` beside `RELAY_KEY`, not
  in `SyncPanel`.** This control needs both — the membership decides whether it is drawn at all —
  and importing them from the panel is right by the one-prefix-one-spelling rule while dragging
  `QrScanner` and `jsqr` into the collection chunk behind them. **A query key imported from a
  panel carries that panel's whole module graph**, which is a bundling fact no lint sees.
* ⚠️ **`useShares(connected)` takes its gate as an argument, and this is about the write
  connection rather than about what the control draws** (2026-09-08). `share_list` is the only one
  of the five commands that reconciles, and `share::commands` runs it inside
  `on_the_write_connection` → `sync::with_write` — so it **holds the exclusive write lock across a
  relay round trip**, and every other user write in the app answers `db::BUSY` after
  `WRITE_LOCK_WAIT` (5 s), whose own doc says only something genuinely stuck should hold it that
  long. The share client's read timeout is **60 s**. That shape is `sync_now`'s and was deferred as
  matching it — but `sync_now` is a **press**, while this hook is called unconditionally by a
  component that mounts with the whole Collection page, and `query.ts` leaves
  `refetchOnWindowFocus` at TanStack's default **true**. So on a connected device every focus of
  the app on that page could hold the write connection for a network trip, and it is invisible
  today only because `endpoint()` short-circuits on the placeholder base. The query is now
  `enabled: connected` — the control is hidden for everyone else anyway, and an unconnected device
  would be taking that lock to be handed the local cache it already has — with
  `refetchOnWindowFocus: false` beside it, because this list changes on a press and both presses
  invalidate `SHARE_KEY` themselves.

**`CollectionFolder` gained `sync_uid` for this**, and its absence was a plan defect found only
when the control was built: `share_create` takes a `folderUid` and `ShareRow` answers one, but the
DTO carried no uid at all — so **a named folder could not be shared, only the whole collection**,
which is the issue's headline capability. It is `Option<String>` / `string | null` because the
column is nullable, and **a `null` is a folder that cannot be shared yet rather than an error**.
The discriminated `ShareTarget` in the menu exists so that "no folder" and "a folder I cannot name"
can never be the same value — `share_create` reads a `null` `folderUid` as *the whole collection*.

### The accessible name, and the finding both viewers proved

**Both viewers shipped the same heading with the same two `block` spans on the same day, one broken
and one correct, and the difference is invisible in the rendered pixels.** The public page's `<h1>`
computed to `Giradeli’sTrade binder` — this repository's own `Missing2` failure, arriving on the
one page strangers open, as the first thing a screen reader announces.

Measured 2026-09-08, in jsdom, which trims the same way a browser does:

| | |
| --- | --- |
| A space **inside** the first element — `{owner}’s{" "}` | **does not work.** Name computation trims each element's contribution *before* appending it, so the trailing space is gone before the concatenation |
| A space **between** the two elements — `</span>{" "}<span>` | **works.** It is a sibling text node in its own right |
| An explicit `aria-label` | works, and is what the public page now uses |

> **Assert the computed accessible name, never the parts.** Asserting the two texts separately is
> exactly what let this ship: the in-app viewer's own test was green for the right reason and the
> public page's was green for the wrong one, and neither test could tell you which.

The in-app viewer was checked directly rather than assumed to share the bug: it does not, because
its space is a sibling node. **Two files, one shape, one day, and only where the space was put
separated them** — which is why the rule is about the assertion rather than about the markup.

---

## The rules this run earned

Both are general. They are here rather than in the ledger because the ledger is deleted when the
branch finishes.

### A guarantee asserted with the mechanism that breaks it absent is not asserted

**Five vacuous tests were found across this one feature**, and every one asserted the *right*
outcome while being satisfied by the **absence of setup** rather than by the code under test:

1. **The publisher's `image_uris` fixture keyed on `'normal'`** — a variant this app does not
   store. Every `img` would have been absent, and all nine planned tests still green.
2. **"404 for a hash the row is not serving"** — passed with its guard deleted, because a hash
   nobody stored 404s on the R2 miss regardless. It seeds a real orphan object now.
3. **"answers 410 for a revoked share rather than serving its bytes"** — green over a Worker that
   served the withdrawn snapshot, because the test **installed no cache**, and the edge cache is
   the mechanism that broke it. `withCache()` appeared in exactly one test in that file.
4. **`expect(fetched).not.toHaveBeenCalled()`** in the web viewer — **unfailable**: `fetch` lived
   only in a module that test never imported. An unfailable assertion is worse than none, because
   it reads as coverage.
5. **Every cross-reference case `waitFor`ing past the loading window** — the window the defect lived
   in.

Two near-misses had the same shape and were caught before they could count: a table missing from
the schema's `TABLES` roster makes the byte-identity test **skip that table on both sides** and pass
green over it; and a table missing from `fakeD1`'s `PRIMARY_KEY` map makes that table's cap tests
vacuous.

**The fix for #3 is the one to copy: it closed the shape structurally rather than at the
instance.** The cache fake moved from an opt-in `withCache()` to a `beforeEach` that installs it for
every test in the file, so the next test written there cannot be vacuous the same way. And the
mutation that proved it is what a mutation should look like — moving `cache.match` back in front of
the state read gives `expected 200 to be 410`, i.e. **the defect itself** rather than a proxy for
it.

**A green mutation is a result, not a pass.** Deleting one array guard in `parseSnapshot` left the
suite green — because the guard one line below is independently sufficient for the same input.
Rather than report that as if the test had held, the implementer deleted **both** guards, got three
failures, and left the measurement as a comment at the site so the next editor does not delete a
clause on the strength of a mutation that stays green.

### Numbers in prose split three ways

Every stale figure this run found was one of three kinds, and each wants a different repair. A
prose-only edit routes to neither CI job, so nothing goes red when one rots.

| Kind | Repair | Why |
| --- | --- | --- |
| A **count** | replace it with a **name** — *one chord per `NAV` entry*, *the steps of the sequence* | the build already answers it, and a count is a fact about a *tree*: every open branch has a different one |
| An **example of drawn output** | keep the literal form, take the **current** value — `Ctrl 1 to Ctrl 8` | an example that disagrees with what the component draws is precisely the failure that paragraph warns about |
| A **measurement** | keep the **dated** figure, and say what changed **around** it | re-deriving it needs the measurement re-run, and a number invented to look current is worse than an honest stale one |

The third row is the one that gets violated with good intentions. When `BottomTabBar` went from six
destinations to eight, its 65×52 tab measurement was **not** renumbered: the arithmetic changed
(390px ÷ 8 = 48.75) but nobody had re-measured what the row actually does at that width, so the
figure keeps its date and the open question is named beside it.

---

## What no build runs, and what that costs

* **`npm run share:build` is in neither `npm run verify` nor CI.** The type-checking half is
  covered — `share/` is in the root `tsconfig.json`'s `include`, and `npm run build` also runs
  `tsc -p tsconfig.share-worker.json` — and `vitest` collects both `share/**/*.test.{ts,tsx}` and
  `share-worker/src/**/*.test.ts` through globs named in `vite.config.ts`. **What nothing runs is
  the bundle**, so `dist-share/` existing at all is a manual step, and `wrangler deploy` fails
  naming that directory until it has been taken.
* **`share/` and `share-worker/` match no arm of CI's `changes` router**, so they fall to the `*)`
  fail-safe and run **every** job — frontend, rust, wasm and android. That is the cheap direction
  to be wrong in and it is deliberate design of that router; it does mean a Worker-only edit runs
  the whole clippy-and-test matrix on two platforms.
* ⚠️ **A directory `vite.config.ts`'s test globs do not name is collected by nothing**, and
  `vitest run` answers `No test files found` — which prints on stdout and is easy to read as a
  pass. `share-worker/` was in that state for exactly one commit.

---

## The bugs still open, and the work still owed

**The live pass happened on 2026-09-08, and it found two defects.** Both were in the collection's
Share control, both are fixed, and both are recorded here because neither suite could see either.

* 🔴 **The action block overhung its row at the phone's frame, and `Export` was off the window.**
  `FigureRow`'s actions box was `ml-auto shrink-0` while the `<dl>` beside it is `flex-1` with a
  `0%` basis — so the box's **max-content** was a hard floor on the row. One `ImportExportPair`
  (158.86px) fitted; that pair plus a sharing group (**421.67px**) did not, and at 390×844 the row
  read `scrollWidth` **421** against `clientWidth` **335** with `documentElement.scrollWidth` still
  **390** — `Import` cut mid-word, `Export` entirely off screen and **unreachable by scrolling**,
  because the overflow was in a box the page does not scroll. Two changes: the actions box lost
  `shrink-0`, so a block whose content wraps falls onto two lines at any width; and below the phone
  fold both groups draw as glyph pairs (`ImportExportPair`'s own *the word gives way, never the
  control*, and `ShareFolderMenu` reads the same fold). Re-measured over the built stylesheet at a
  **335px** row: compact, sharing **74** + transfer **74** on **one** line with the `<dl>` keeping
  **155px**; worded, **251.78** + **155.70** on **two** lines with the `<dl>` on its own; and
  `scrollWidth === clientWidth === 335` with no button past the right edge in either.
* 🟠 **The *Open a shared collection* dialog dropped the caret on `<body>`**, reproduced by Escape
  and by the ✕. `Dialog` says the host owes the caret and this host draws **two** openers — and the
  shared `back()` focuses the *Share* button, which is not drawn at all for a reader who has
  connected nothing, i.e. exactly the reader most likely to press *Open*. The Open button has its
  own ref now. The other two dialogs were already correct.

Confirmed clean in the same pass: the greyed row's accessible name reads *"Share this folder…
unlock it first"* in Chromium's AX tree (a real space — not the `Missing2` failure); the
`NOT_DEPLOYED` sentence matches `publish.rs` byte for byte with **no `error_log` row written**; the
malformed-link refusal keeps the dialog open and the text; and the *Shared* row hides again on
leaving. Zero console errors or warnings across the pass.

⚠️ **This paragraph also said *"`Ctrl+6/7/8` all land correctly"*, and it was driven before the
final `origin/main` merge.** The rail was eight destinations that day; it is **ten** now, `shared`
has **no chord at all**, and `Ctrl+6` reaches Scanner — see [the chord
ruling](#the-entry-point-which-decision-6-left-nowhere-to-put) above. The finding is not wrong so
much as about a different tree, which is exactly the failure mode a dated measurement is supposed
to prevent, so it is struck rather than renumbered: **nothing on the current bar has been driven by
chord.**

**`BottomTabBar` was driven at eight destinations and it truncates rather than overflowing** —
**and eight is not what a reader has now.** The row is `flex` with no wrap, so a 390px window
divides by whatever it is given: the 65px-per-tab figure was measured at **six** tabs on
2026-08-29, and eight gives **48.75px**. Driven at 390×844 (2026-09-08, WebView2, **before the
final `origin/main` merge**): every tab drew at exactly **48.75 × 52**, `nav.scrollWidth ===
clientWidth === 390`, and `documentElement`/`body` likewise — **nothing overflowed**, and the 44px
`--target-min` never bound. **Exactly one label truncated**: `Collection`, 55 against 49, drawn as
`Collecti…`; every other span reported `scrollWidth === clientWidth`.

⚠️ **The bar draws nine now, and ten with a share open, and neither has been driven.** Trade and
Playtesting arrived from `main`, so the ordinary bar is **nine** tabs at 43.33px — `BottomTabBar.tsx`
records four labels truncating there (`Collection` 55.23, `Playtesting` 61.97, `Scanner` 45.73,
`Settings` 45.42, against a 44px content box) — and a reader who has opened somebody's binder gets
the **tenth**, at 39px per box. That component's own header is honest about the tenth and this page
was not, which is why the figures above keep their date and are described as the bar they were taken
on rather than being arithmetically renumbered. The rule stands as `BottomTabBar` states it: the
row was at its floor at nine already, and what to do about a phone with ten destinations is a
question about what a phone's navigation *is*, not about what a tenth tab costs.

The same pass settled the two figures the tree carried for that ink width. Re-measured at 12px
Geist Variable: Search 38.67, Tagger 37.50, Decks 34.27, **Collection 55.23**, Wishlist 43.30,
Shared 39.06, Scanner 45.73, Settings 45.42 — and `Search` reproduces the 2026-08-29 headless
figure exactly, which is the cross-check that the face is the right one. So **`BottomTabBar.tsx`'s
55.23 was correct and `BottomTabBar.stories.tsx`'s 54.98 was not**; the story is corrected and
dated. (Eight labels, so **Trade and Playtesting are not on that list** — the widths are per-label
and do not move with the tab count, but the census is a tree's.)

**The action row at 1280 with the search column docked does neither of the two things this page
predicted.** The premise that the inner `flex-wrap` is inert was right — `FigureRow` used to size
the actions at max-content — but the `<dl>` beside it is `min-w-0 flex-1` and absorbed the whole
cost: the wrapper drew **421.67** flush to the row's right edge, the `<dl>` was squeezed to
**571.33**, both children stayed on one line, and nothing overflowed at 1280 **or** at the 1024
floor. It broke only below a row width of **445.67**, which is the phone defect above.

**Automatic refresh is deliberately not built, and no plan task ever assigned it.** Spec §4.1 used
to promise *"on app launch and after a sync that touched a shared folder, debounced, plus a manual
Update now"*; **only the manual press exists.** The reasoning: the viewer is *told* how stale a
snapshot is (the page renders *as of …*), the owner has an explicit press and a stale mark — so
this is a convenience rather than a correctness gap; and an on-launch re-publish for every share is
real network on the account's shared budget, with nothing deployed to measure it against. **What it
costs is that a snapshot can sit stale for as long as an owner does not press Update**, visible to
them in the app and to viewers as an older *as of* date.

⚠️ **The spec was amended, and this paragraph went on saying it had not been.** It read *"§4.1 was
ruled to be amended to say so and it was not — as this page is written the spec still reads as
though the trigger shipped, and §14 carries no item for it. This page is the correction until
somebody makes that edit."* Commit `6ff7a8ba` made exactly that edit: §4.1 now reads *"Refresh in
v1 is the manual Update now and nothing else"* with the ⚠️ paragraph explaining the narrowing, and
§14 carries **item 7** for the automatic half. So the correction outlived the thing it corrected
and became the only wrong sentence of the pair — a **prose-only edit routes to neither CI job**,
which is what lets a note like this rot in place while every build stays green. Read the spec, not
this line, for what §4.1 says.

**A pre-existing landmine in `relay/src/fakeD1.ts`, found here and deliberately not fixed.** Its
tokenizer has **no rule for `'`**, so `WHERE status = 'dead'` resolves `dead` as a *column*, yields
NULL and matches nothing — **silently, never throwing**. `IN (SELECT …)` is not in its dialect at
all. `relay/src/claim.ts` already contains such literals; nothing goes wrong today only because
`claim.test.ts` never drives those handlers through the fake, and **the first test that does will
pass vacuously.** Left alone because changing relay test infrastructure mid-feature is how a clean
branch acquires an unrelated red.

**Smaller ones, each with its reason for standing:**

* **Republishing a lapsed share answers 200 while the link stays dark** until the next cron pass —
  up to 24 hours. Deliberate, and `state` is on the wire for the app to surface.
* **No CORS and no `OPTIONS` handling.** The relay has none either and the client is Rust.
* **`CardArt` prints "No card"** for a printing with no picture, so a tile can read
  `Brainstorm / No card` — which reads as an error rather than as *the publisher's corpus forgot
  this printing*. Fixing it means touching copy every wall in the app draws.
* **Revoked tombstones and lapsed R2 objects both accumulate unbounded.** Two sweeps for the day
  they matter, and spec §13 says so rather than inventing retention rules nobody has needed.
* **A seconds-long window after a republish** shows the new metadata over the old blob — the same
  window the two-step's header caveat above describes.
* **The 410 on `/s/{id}` is HTML**, so the app cannot tell withdrawn from lapsed and says one
  sentence for both. An app that claimed to know which had happened would be reading prose.

---

## Where the code is

| Path | Holds |
| --- | --- |
| `src-tauri/src/share/snapshot.rs` | `ShareSnapshot`, the subtree read, the gzip, the three refusals |
| `src-tauri/src/share/cache.rs` | `collection_shares` reads, writes and `reconcile`. Every target |
| `src-tauri/src/share/publish.rs` | The two-step upload and the sentences. Desktop and Android only |
| `src-tauri/src/share/commands.rs` | The five commands and `ShareRow`. The module is every-target; the commands are not |
| `src-tauri/src/share/__golden__/` | The committed snapshot both TypeScript suites read |
| `share-worker/` | The Worker — `index.ts` (router and gate), `shares.ts`, `blob.ts`, `page.ts`, `lapse.ts`, `env.ts`, `schema.sql`, `README.md` |
| `share/` | The public viewer bundle; `vite.share.config.ts` builds it into `dist-share/` |
| `src/features/share/` | The in-app view, the paste dialog, the want list, its hooks, the folder tree, the read-only sweep |
| `src/features/collection/ShareFolderMenu.tsx` | The Share control and the entry point beside it |
| `src/lib/shareSnapshot.ts` | The format, read — imports nothing, by requirement |
| `src/lib/ipc.ts` | The five commands and `ShareRow`'s mirror |

## Further reading

| Doc | Holds |
| --- | --- |
| [collection-folders.md](collection-folders.md) | The cabinet the publisher reads — the eleventh grain term, and the lock this feature must never publish through |
| [sync.md](sync.md) | The relay, the group, the bearer token this Worker verifies, and the entitlement that gates a publish |
| [hosted-relay-deploy.md](hosted-relay-deploy.md) | The other Worker's runbook, and the *ask the host, never a document* rule this page inherits |
| [data-and-sync.md](data-and-sync.md) | The schema ladder v41 sits on |
| [web-target.md](web-target.md) | The browser build the public viewer deliberately is not |
