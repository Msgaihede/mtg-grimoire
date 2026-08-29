# Converging From Any State: The Pairing Baseline

**Status:** design, approved 2026-08-29. Amended the same day after reading the merge path and the
deployed relay — see [§18](#18-what-changed-in-the-amendment) for what moved and why.
Supersedes one sentence of [the cross-platform design](2026-08-27-cross-platform-design.md) §7.7 —
see §2.

**Goal:** a device that joins a pairing group ends up holding the group's collection, decks,
folders, wishlist and tags, whatever state either device was in beforehand — and so does the
device it joined.

---

## 1. What is broken, measured

Driven on 2026-08-29 against a real pair: a desktop holding 275 collection entries, 611 deck
cards, 55 categories, 88 wishes and 4 decks, and a OnePlus 12 with an empty collection. Both on
schema v29, both pointed at a deployed relay.

Pairing completed. Both devices independently derived and displayed the same six-digit SAS
(`351768`), both ended at "of 2, at key version 0", and a quantity change on the desktop
travelled: **"Sent 1 change"** on one side, **"received 1 change"** on the other. The transport
works end to end.

Then:

| | |
| --- | --- |
| Desktop collection | **275** entries |
| Phone collection after pairing and syncing | **0** entries |
| What the phone said | *"1 change arrived before the change they build on. They land on a later sync."* |

The deferral is **correct**. The op was a `put collection_entries` naming a `folder` parent by
uid, and the phone has never seen that folder — so `apply` held it rather than inserting a row
into a folder that does not exist. It will hold it for ever, because the folder's own op was
never written.

**The cause is that `sync_ops` only ever holds what the capture triggers saw.** They begin
capturing at v29. Every row that existed before then — which on any real device is the entire
collection — has a `sync_uid` but has never been the subject of an op. There is nothing to send,
so a new device receives nothing, and every op it later receives defers on a parent that never
arrives.

## 2. The sentence this corrects

§7.7 of the cross-platform design says:

> There is no separate snapshot artifact, so the **2 MB per-row cap can never be hit** however
> large a collection grows; a new device replays the compacted log.

The conclusion is right and the premise is not. The log does not contain the collection; it
contains changes captured since capture began. "A new device replays the compacted log" is true
only once something puts the collection *into* the log, and nothing does.

This design keeps the rejection of a snapshot artifact — see §5 — and makes the sentence true by
sending the baseline over the log as ordinary ops.

## 3. What already exists, and is not changing

The merge is built and this design leans on all of it.

**`apply` matches an incoming op to a local row in three steps**: the table's own **logical
grain** (its unique index, with every foreign local id replaced by that parent's `sync_uid`),
then the **uid**, then insert. When a grain match is found, **both devices set the row's uid to
the lower of the two** — deterministic, no alias table.

| Table | Logical grain |
| --- | --- |
| `collection_entries` | 11 terms, ending in `folder_uid` |
| `wishlist_entries` | `oracle_id, card_id, preferred_finish, folder_uid` |
| `deck_cards` | `deck_uid, variant, category_uid, card_id, finish` |
| `deck_categories` | `deck_uid, name` |
| `deck_tags` | `name_key` |
| `muted_tags` | `namespace, tag_id` |
| `decks`, `deck_folders`, `wishlist_folders`, `collection_folders`, `deck_audit` | none — uid only |

Also unchanged: the HLC and its ordering, per-field last-writer-wins, add-wins row existence,
the 200-op batch, compaction with a 30-day tail, the deferral of an op whose parent has not
arrived, and `needs_review`.

**And one mechanism this design leans on much harder than the first draft did.** `sync_peers`
is a per-peer watermark meaning *"everything at or below this has been applied"*, and
`apply_in` drops an op at or below it before anything else happens. §9 turns that into the
whole of the baseline's arithmetic.

## 4. Decisions taken

| Decision | Where |
| --- | --- |
| Two devices' same-named decks and folders stay **two** | [§6](#6-what-does-not-merge-and-why-that-is-the-safe-direction) |
| The baseline carries **history** (`deck_audit`) too | [§7](#7-what-a-baseline-contains) |
| A baseline counter is a **claim**, resolved by `max` — never a delta | [§8](#8-the-counter-rule) |
| A baseline carries the emitter's **horizon**, which is what makes it exact | [§9](#9-the-horizon) |
| The baseline is **ops over the existing log**, not a snapshot artifact | [§5](#5-approach-the-baseline-is-ops-and-the-log-is-the-carrier) |
| Baseline ops are **never written to `sync_ops`** | [§5](#5-approach-the-baseline-is-ops-and-the-log-is-the-carrier) |
| It is triggered by **a peer needing it**, not by the pairing event | [§10](#10-when-a-baseline-is-emitted) |
| A key rotation **re-arms** the baseline for the devices that remain | [§12](#12-revocation-and-a-device-that-sleeps) |

## 5. Approach: the baseline is ops, and the log is the carrier

A device that sees a peer it has never heard from builds one `put` per synced row, seals them in
the ordinary envelope, and pushes them.

Everything downstream is reused unchanged: the wire envelope, batching, compaction, `apply`,
grain-matching, `min(uid)` adoption, deferral. **There is no second transport and no second apply
path.**

### 5.1 They are not written to `sync_ops`, and that is the amendment's biggest simplification

The first draft filed baseline ops in the outbox behind a new `sync_ops.baseline` column. They
are built in memory instead, sealed, pushed, and forgotten. Three things follow:

* **`sync_ops.counters` keeps its meaning.** Its own DDL comment reads *"Counter DELTAS, never
  values. Two devices each adding one copy must end at +2; a value ends at +1 and silently loses
  a card."* A stored baseline op would make that sentence conditionally false, which is the kind
  of quiet contradiction that costs somebody a day in a year's time.
* **There is nothing worth keeping.** A baseline is derived from the reader's own tables and can
  be rebuilt by a table scan at any moment. §11's partial-failure rule already says a half-sent
  baseline is simply sent again.
* **The schema change shrinks to one column.** No `ALTER TABLE sync_ops`, no third `CHECK`, no
  change to the outbox's shape at all.

The `baseline` flag and the horizon therefore live on the **wire** `Op` alone, both
`#[serde(default)]`, so a peer on an older build ignores them rather than failing to parse.

### 5.2 Why not a snapshot artifact — the real reason, which the first draft missed

The first draft argued that a whole-table dump needs its own apply path. That is avoidable: a
joiner could convert a dump's rows into ops in memory and feed the one `apply` it already has.
The argument that actually holds is about **who receives it**.

**The roster does not propagate.** `pairing::confirm` and `pairing::complete` each call
`identity::add_device` for the one peer they just paired with, and `sync_devices` is deliberately
not in `schema::SYNCED_TABLES` — `schema.rs` says of pairing's three tables that **they must
never themselves sync**, because they hold this device's secret key, the group key and the
roster. So with A and B paired and C joining via A:

```
A's roster: {A, B, C}      B's roster: {A, B}      C's roster: {A, C}
```

B never learns that C exists, and cannot be cheaply made to.

The log is a **broadcast**: everything anybody pushes is read by everybody. So C's baseline
reaches B even though B has never heard of C, and B ends up holding C's pre-pairing rows without
doing anything. An artifact addressed to A would not reach B, and C's rows would be missing there
permanently. Making a snapshot fix that means letting every device fetch every snapshot and
tracking which it has ingested — which is the log, re-implemented, minus the compaction that
already collects it.

**Why not pull-based.** "Send me the rows I lack" needs a query protocol on the relay. The relay
is a dumb log that cannot read what it stores; giving it a query means giving it comprehension,
which is the one thing the encryption forbids.

## 6. What does not merge, and why that is the safe direction

`decks`, the three folder tables and `deck_audit` have no unique index, so they match by uid
alone. Two devices that each independently made a deck called "Krenko" end with **two decks**.

Approved deliberately. `sync.md` already argues the folder case — two devices' folders both
called "Binder" are two folders and must stay two — and the alternative fuses two things a reader
may consider distinct, with no undo and no way to tell afterwards that it happened. Visible
clutter on a first pair is recoverable by hand; a silent fusion is not.

## 7. What a baseline contains

**Every row of every synced table, `deck_audit` included.**

Including history was chosen over the narrower alternative: a deck's story reads the same
wherever it is opened. The cost is that `deck_audit` is the one synced table with no ceiling —
it is append-only narrative proportional to how much the reader has done, not to what they own.

Two consequences the implementation owes:

- **The baseline is emitted in batches and never assembled as one message.** A reader with a
  large history must not meet a single envelope that cannot be sent.
- **`deck_audit`'s contribution is reported separately** in whatever the reader is shown (§13),
  because it is the part that can be surprising.

## 8. The counter rule

`sync_ops.counters` holds **deltas, never values** — that is what makes two devices each adding
a copy land at +2 rather than +1, and it is the founding constraint of this whole subsystem.

**A baseline is not an edit, and must not be read as one.** If a desktop holding 4 Lightning Bolt
and a phone holding 3 of the same printing in the same folder both baseline, summing gives 7
cards that do not exist — silently, plausibly, and findable only by counting cardboard.

### 8.1 The failure the first draft's rule did not cover

§8 as first written said only *"the resolution is `max`, not `+`"*. That fixes claim against
claim and says nothing about **a delta the claim already contains**, which is the ordinary case
rather than an exotic one:

> The desktop is paired, the reader adds a copy (`+1`, row now at 5), and then syncs. The outbox
> holds that `+1`; the baseline, read from the row afterwards, claims 5. **Both reach the phone
> in one pull page.** `merge::fold` sums counters and `apply::insert_row` seeds a new row from
> that sum, so the phone inserts the row at **6**.

That is §1's live scenario exactly. It would have failed the very test this design exists to
pass.

### 8.2 The rule

For each counter key, where a fold contains at least one baseline op:

```
claim = the greatest value claimed by any baseline op for that key
next  = max( local_current + Σ surviving deltas,  claim )
```

and where it contains none, `next = local_current + Σ deltas`, exactly as today. "Surviving
deltas" means the ordinary, non-baseline deltas left after §9's horizon has been applied.

Worked against every case that came up:

| | plain sum | this rule | true |
| --- | --- | --- | --- |
| two devices each `+1`, no baseline | 2 | 2 | 2 |
| desktop 4 / phone 3, both baseline | 7 | 4 | 4 |
| first pair, the claim already holds the emitter's own `+1` | **6** | 5 | 5 |
| three devices, the claim already holds a third device's `+1` | **6** | 5 | 5 |
| the joiner genuinely holds more than the claim | 9 | 9 | 9 |

**It cannot over-count.** Deltas are added to what this device already holds — which is the
existing, correct op-path answer — and the claim can only raise that floor. A baseline can
therefore never invent a card.

**What it can do is under-count**, and only in one shape: a row changed between the emitter
reading its tables and the joiner's first pull, where the claim dominates the delta. §9 removes
that shape for every op the emitter had already absorbed; what is left is the window between
emission and delivery, which §10's ordering keeps to seconds. Under-counting is visible on
screen and fixable by hand, which is the direction this design chooses on purpose.

**One consequence to state rather than discover.** While a claim is present the row cannot fall
to zero, so a concurrent "remove the last copy" loses to it and `Floor::DeleteAtZero` does not
fire. That is add-wins in flavour and consistent with §3, and it is worth a test of its own.

## 9. The horizon

A claim is a statement about a row. It is only exact if the receiver also knows **what the
emitter had already taken in when it read that row** — otherwise the ops folded into the claim
are still on the log, and adding them is the over-count §8.1 describes.

Every device already keeps precisely that bookkeeping. `sync_peers` means *"everything at or
below this has been applied"*, and the claim was read from tables written by those applications.

So a baseline carries a **horizon**: the emitter's `sync_peers` map, plus the emitter's own
highest stamp. The receiver, before it filters anything, raises each of its own watermarks to
`max(own, horizon)`. Every op already inside the claim is then dropped by `apply_in`'s existing
first step — counted as `skipped`, the mechanism that exists and is tested — and everything above
it is genuinely new and lands on the claim honestly.

This is what makes the arithmetic exact for **any** number of devices rather than approximately
right for two.

**Raising a watermark is destructive and must be treated that way.** It permanently skips ops, so
a horizon that was too high would lose data silently. Two guards: it is built only from the
emitter's own `sync_peers`, which already carries exactly this meaning, and it is applied as
`max`, so it can never walk a watermark backwards.

## 10. When a baseline is emitted

**Not at pairing.** The relay compacts once every device has acked, keeping a 30-day tail — so a
baseline sent once at pairing is gone by the time a third device joins on day 40, or by the time
a wiped phone re-pairs. A pairing-time one-shot would work exactly once and then quietly stop.

**The trigger is a peer that needs one.** A row in `sync_devices` that is

- **not revoked** (`revoked_at IS NULL` — see §12),
- has **no watermark** in `sync_peers`, and
- has **no `baselined_at`**, or one older than the relay's tail.

That covers the first pairing, a third device joining later, and a device wiped and re-paired —
all the same condition, detected the same way.

**Idempotence, and where the marker lives.** `ALTER TABLE sync_devices ADD COLUMN baselined_at
INTEGER;` — NULL means "this peer has never been sent a baseline". **This is the design's only
schema change**, and it makes user schema v30.

It goes on the **roster** and not on `sync_peers`, and that is the whole reason to name the table
here: `sync_peers` only gains a row once a peer has *acked* something, so a peer that needs a
baseline is precisely a peer with no row there. A marker on a table whose absence is the trigger
cannot work. `sync_devices` has one row per device in the group from the moment pairing completes
— verified on the live pair, two rows.

### 10.1 The marker re-arms, and it has to

Stamping the marker for good reintroduces the failure this design exists to remove. Suppose A
baselines for C successfully and marks it done, but **C's own baseline never gets out** and C is
not opened for a month. The relay's compaction roster is built from acks and rows, not from
anybody's device list, so a device it has never heard from in either direction is invisible to
the floor and can be compacted past. C then pulls and finds nothing, and A will not try again.
C is empty for ever, silently.

So the marker is advisory: **a peer that is still silent when the marker is older than the
relay's 30-day tail is baselined again.** Worst case that is one wasted re-send a month for a
device that never came back.

### 10.2 Both directions, ordering, and stamping

**Both directions.** Each device baselines for the other. That is what makes "I want to see my
collection on my phone **and** my desktop" true rather than half-true, and it is why the emitter
is chosen by the roster rather than by who started the pairing.

**Pull before emit.** A joining device is handed the state of whichever device it paired with, so
`client::run_once` must complete its pull before it emits — otherwise a host that is behind
speaks for the group in a voice that is out of date. Today's order is push, pull, ack; the
baseline is emitted after the pull and before the push that carries it.

**Ordering.** Rows are emitted parents-first — folders, decks, categories, then entries, cards,
wishes, tags, audit. `apply` re-imposes that order by table anyway and the deferral machinery
would converge regardless, so this is belt and braces; what it buys is a first sync in one pass
instead of several.

**Stamping.** A baseline op is stamped with the row's own modification time, **not with "now"**.
A baseline stamped now would beat a peer's genuinely newer edit under per-field LWW, so the
device that happened to pair second would win every argument it should lose.

It buys a second thing that only becomes visible with three devices: a device that is already up
to date recognises almost every op of somebody else's re-broadcast baseline as **older than its
own watermark**, and skips the lot with no database work at all (§11).

Read off the live database rather than from `schema.rs`, which is a ladder and answers about
whichever rung the grep landed on:

| Table | Column to stamp from |
| --- | --- |
| `collection_entries`, `wishlist_entries`, `deck_cards`, `deck_categories`, `decks`, `deck_folders`, `wishlist_folders`, `collection_folders`, `deck_tags` | `updated_at` |
| `muted_tags` | `muted_at` |
| `deck_audit` | `at` |

Every synced table has one, so there is no fallback arm to write and none should be invented.

> ⚠️ **`collection_entries.acquired_at` is not a modification time and must never be used here.**
> It is the date the reader says they acquired the card — user data, frequently NULL, and
> sometimes years old. Stamping a baseline from it would file a row's whole state under a date
> that has nothing to do with when it was written.

## 11. More than two devices

Because the roster does not propagate (§5.2), a join produces **two** baselines and not one per
device already in the group. C pairs with A:

| | gets what it needs | from |
| --- | --- | --- |
| **C** | the whole group's data | A's baseline — A pulled first, so its state already carries B's contributions |
| **A** | C's pre-pairing rows | C's baseline |
| **B** | C's pre-pairing rows | C's baseline, which B reads although it has never heard of C |

B emits nothing and converges anyway. The cost of the broadcast is bandwidth, not work: B's
watermark for A already sits above almost every stamp in A's baseline, so B skips it in the first
filter. The rows B does apply are the ones A changed since B last synced, which B wanted anyway.

A fourth device joining still costs two baselines, not four.

## 12. Revocation, and a device that sleeps

### 12.1 A device offline for thirty days or more loses nothing

`log.compact` keeps a row when it is **above the slowest device's cursor** *or* inside the
thirty-day tail, and a device that has acked even once is in that map. So everything above its
cursor survives regardless of age; the tail is extra insurance for rows every device has already
consumed, not a window in which a sleeping device's inbox is discarded.

Two consequences follow, and neither is this design's to fix:

- **The log cannot compact past the slowest device.** A device that is lost and never removed
  pins the floor for ever and the group's log grows without bound.
- **Revocation never reaches the relay**, which has no notion of a roster, so a removed device's
  ack row keeps pinning that floor after it is gone. Both need a relay route — see §17.

### 12.2 Revocation is broken today, before any of this

`identity::revoke_device` marks the row revoked, bumps the epoch and mints a new group key, all
locally. **Nothing distributes that key.** Its own doc says as much. So when A removes C from a
group of three:

- **B still holds the old epoch.** A's envelopes now carry a higher one, so `client::pull` marks
  B `behind`, refuses to advance its cursor, and waits for a key nothing will ever hand it.
- **A silently discards everything B writes.** B's envelopes carry the *lower* epoch, which does
  not set `behind`, so A counts them unreadable, logs one `error_log` row and steps over them.

Removing a third device therefore breaks the two that remain until B is re-paired by hand — which
does work, because `create_group` returns the existing group and `confirm` seals the *rotated*
key, but nothing tells the reader that. The app also points at a control that does not exist:
`"This device cannot remove itself. Use Leave group instead."` There is no `leave_group` in the
crate, no `syncLeave` in `ipc.ts` and no Leave button in `SyncPanel.tsx`.

### 12.3 What this design does about it

Two repairs, both inside code this work already touches:

1. **The trigger skips revoked devices** (§10). Without it a device the reader removed sits on
   the roster with no watermark for ever and — with §10.1's re-arm — triggers a full baseline
   every month for a peer that will never answer.
2. **A rotation clears `baselined_at` for the devices that remain**, in `revoke_device`'s
   existing transaction. The next sync then re-baselines under the new epoch, which repairs
   exactly what the epoch boundary swallowed. Claims resolve by `max` and a horizon only ever
   raises a watermark, so re-baselining cannot double-count.

Key redistribution after a rotation, and the missing Leave group, are §7.6 work and are **not**
fixed here — see §17.

## 13. What the reader sees

The Sync panel already reports *"Sent N changes and received N changes"* and defers with a
sentence. A baseline is larger than an ordinary sync and must not look like a hang:

- While emitting or applying a baseline, the panel says so in its own words — that this is the
  first exchange with that device and roughly how much is moving.
- The count of `deck_audit` rows is named separately (§7).
- A baseline that fails part-way leaves the peer's marker unset, so the next sync starts it
  again. Partial application is safe: every op is independently mergeable, which is the property
  that made ops the right carrier in the first place.
- **A joining device is handed the state of the device it paired with** (§10.2). Worth a sentence
  in the panel rather than a comment nobody reads.

## 14. Budget, and where the ceiling actually is

Measured on the real device pair, 2026-08-29: **1 069 synced rows**, average op **698 B** on the
wire. A full 200-op batch measured the same day from `wire::tests` (debug build):

```
200 ops: 139601 B of JSON (698 B/op), 186188 B sealed and base64url'd,
         186299 B as a stored row
```

Cloudflare's limits, read from the docs on 2026-08-29 rather than recalled:

| | limit | this collection |
| --- | --- | --- |
| SQLite per Durable Object | **10 GB** | 746 KB — 0.007% |
| Per stored row | 2 MB | 186 KB — 9% |
| Requests, Workers Free | 100 000/day | 6 pushes |
| Memory per isolate | **128 MB** | — |
| CPU per invocation, Workers Free | **10 ms** (5 min Paid) | — |

Scaled out at 698 B/op:

| collection | synced rows | baseline | stored rows |
| --- | --- | --- | --- |
| the measured pair | 1 069 | 746 KB | 6 |
| ten times it | ~10 000 | ~7 MB | 50 |
| §7.7's worst case | 50 000 | ~35 MB | 250 |

**Storage is never the binding constraint**, and it is not close: even the 50 000-row case,
doubled for two baselines, misses the per-object limit by a factor of a hundred and forty. It is
also transient — once every device acks, compaction removes it.

**The ceiling is the relay's read path.** `Group.pull` loads every row in the log into memory,
maps it, and `JSON.stringify`s the lot into one response body; there is no paging, and
`compactNow` runs the same whole-log read on every ack. Against 128 MB per isolate and 10 ms of
CPU on the free plan, that becomes uncomfortable somewhere north of 20–30 000 synced rows, and
earlier on the free plan than the paid one.

That is a real ceiling and it is **not** addressed here — see §17. It buys nothing at the
measured size and it costs a redeploy of a Worker that is currently working.

## 15. An adjacent bug, found while writing this

**Both devices are called "This device" in the roster.** Read off the live pair after a
successful pairing:

```json
[{"device_id":"253b5809…","name":"This device"},
 {"device_id":"942eb0a9…","name":"This device"}]
```

`sync_identity.name` defaults to "This device" on every install and nothing renames it at
pairing, so a group of two shows two identically-named rows and the reader cannot tell which
"Remove" button removes the phone. The panel's own copy says "Paired device" for the far one,
which papers over it for exactly two devices and stops working at three.

Not part of this design and not fixed by it. It belongs with the baseline work because a first
pairing is when a reader meets the roster, and because `sync_device_rename` already writes both
rows correctly — what is missing is only a default worth showing.

## 16. Where the six places are

Adding a user column touches a known list, and two of its entries have each been missed by an
agent before. For `sync_devices.baselined_at` specifically:

1. **`USER_SCHEMA_SQL`** — the fresh-install shape. Measured 2026-08-29 with `node:sqlite`:
   `ALTER TABLE … ADD COLUMN` on a `WITHOUT ROWID` table replaces the closing paren and leaves
   the table option after it, so the literal must read `revoked_at INTEGER\n             ,
   baselined_at INTEGER) WITHOUT ROWID`. `the_user_schema_is_byte_identical_to_what_the_ladder_builds`
   compares this against the ladder byte for byte.
2. **A v30 rung** at the bottom of `migrate_user`, **below the `v == 0` early return**.
3. **`schema::TABLES` / `side_of`** — unaffected: no new table.
4. **`mirror::watch::surface_of`'s census** — unaffected for the same reason; it asserts table
   names, not columns.
5. **`schema::tests::the_user_side_is_the_…`** — unaffected, likewise.
6. **`split::extract_user_file`** — walks `TABLES` over a legacy `mtg.db`. `sync_devices` does
   not exist there at all, so `shared_columns` answers `None` and the table is skipped. Nothing
   to mint.

**And the seventh path that seeds nothing.** `split::convert` builds the user file with
`create_user_schema` and stamps head, so no rung runs and `v == 0` never fires — the path every
existing desktop install takes exactly once. This design adds no singleton row, so it needs no
counterpart to `migrate_user`'s unconditional `sync_clock` repair. **An implementer who adds one
does**, and owes a test of the behaviour rather than of a row count.

## 17. What this design does not do

- **It does not change any conflict rule** except the counter arm behind the baseline flag (§8).
- **It does not merge same-named decks or folders** (§6).
- **It does not add a snapshot artifact, a query protocol, or a second apply path** (§5).
- **It does not page the relay's pull, and that is a dated, owed ceiling** (§14): a `limit` on
  `log.since` and a ranged `DELETE` in `compactNow`. One trap for whoever takes it — `pull`
  returns the head of the *whole* log as its cursor on purpose, because the puller's own rows are
  filtered out and a cursor from the slice would re-deliver them for ever. A page's cursor must
  be the highest seq **considered**, filtered rows included, or rows are silently skipped.
- **It does not free the relay's compaction floor when a device is revoked** (§12.1). Same
  follow-up: the relay needs to be told.
- **It does not redistribute the group key after a rotation, and does not build Leave group**
  (§12.2). Those are §7.6's, with their own design question — how does a remaining device receive
  a rotated key without a pairing ceremony?
- **It does not fix the roster's duplicate names** (§15).
- **It does not address the WebSocket fan-out**, which remains owed from PR 7.
- **It does not transfer the corpus.** Every platform builds its own from Scryfall — decision 5,
  untouched. A phone that has not synced its corpus will hold collection rows whose cards it
  cannot yet draw, and that is the existing, intended behaviour for a card the corpus lacks.

## 18. What changed in the amendment

Read against the first draft of the same day, after reading `merge`, `apply`, `client`, the
pairing flow and the deployed Worker:

| § | Change | Why |
| --- | --- | --- |
| 5.1 | Baseline ops are **not** stored in `sync_ops`; the `ALTER TABLE sync_ops ADD COLUMN baseline` is dropped | The outbox's "deltas, never values" comment would otherwise become conditionally false, and there is nothing worth keeping |
| 5.2 | The argument against a snapshot artifact is the **unpropagated roster**, not the second apply path | The old argument was avoidable; this one is not |
| 8 | The counter rule becomes `max(local + Σ deltas, claim)` | `max` alone inserts the first-pairing row at 6 — §1's own scenario |
| 9 | New: the horizon | Makes the arithmetic exact for any number of devices, using a mechanism that already exists |
| 10.1 | The marker re-arms after the relay's tail | Otherwise a joiner whose own baseline failed is empty for ever |
| 10.2 | `run_once` pulls before it emits | A host that is behind must not speak for the group |
| 12 | New: revocation and the sleeping device | Both were unexamined; one of them is broken today |
| 14 | Real measurements, and the ceiling relocated to the relay's read path | Storage misses by a factor of 140; `pull` does not page |

## 19. How it will be verified

- **Unit**: the counter rule under each row of §8.2's table, the horizon raising a watermark and
  never lowering it, stamping from the row's own column, the emit order, the trigger's three
  conditions including the revoked guard, the re-arm, and idempotence — each with a mutation that
  must go red, and **a mutation that survives is a finding to report rather than a test to
  adjust**.
- **Two-database**: the existing in-process pair test extended to "A has 275 rows, B has none",
  to "both have overlapping rows", and to a rotation followed by a re-baseline — asserting
  convergence, no duplicates, and that an ordinary edit still lands at +2.
- **The one that matters**: the live pass in §1 re-run. The phone's collection must read **275**,
  and its decks, folders and wishes must match the desktop's. That number is the deliverable —
  nothing else demonstrates the feature this design exists for.
