# Converging From Any State: The Pairing Baseline

**Status:** design, approved 2026-08-29. Supersedes one sentence of
[the cross-platform design](2026-08-27-cross-platform-design.md) §7.7 — see §2.

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
writing the baseline into the log as ordinary ops.

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

## 4. Decisions taken

| Decision | Where |
| --- | --- |
| Two devices' same-named decks and folders stay **two** | [§6](#6-what-does-not-merge-and-why-that-is-the-safe-direction) |
| The baseline carries **history** (`deck_audit`) too | [§7](#7-what-a-baseline-contains) |
| A baseline counter is a **claim**, resolved by `max` — not a delta | [§8](#8-the-one-rule-that-is-genuinely-new) |
| The baseline is **ops**, not a snapshot artifact | [§5](#5-approach-a-baseline-is-just-ops) |
| It is triggered by **a peer needing it**, not by the pairing event | [§9](#9-when-a-baseline-is-emitted) |

## 5. Approach: a baseline is just ops

A device that sees a peer with no watermark writes one `put` per synced row into `sync_ops` and
syncs normally.

Everything downstream is reused unchanged: the wire envelope, batching, compaction, `apply`,
grain-matching, `min(uid)` adoption, deferral. **There is no second transport and no second apply
path.**

**Why not a snapshot artifact.** It is what §7.7 rejected, and the reason holds: a whole-table
dump needs its own apply path, and that path has to agree with the op path on every rule in §3 —
the grain table, min-uid, per-field LWW, add-wins, the counter rule. Two implementations of one
merge is the drift this repository builds golden fences against
([text-mirror.md](../../reference/text-mirror.md) is the precedent). A dump also re-introduces
the 2 MB per-row cap that §7.7 was pleased to be rid of.

**Why not pull-based.** "Send me the rows I lack" needs a query protocol on the relay. The relay
is a dumb log that cannot read what it stores; giving it a query means giving it comprehension,
which is the one thing decision 4 forbids.

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
- **`deck_audit`'s contribution is reported separately** in whatever the reader is shown (§10),
  because it is the part that can be surprising.

## 8. The one rule that is genuinely new

`sync_ops.counters` holds **deltas, never values** — that is what makes two devices each adding
a copy land at +2 rather than +1, and it is the founding constraint of this whole subsystem.

**A baseline is not an edit, and must not be read as one.** If a desktop holding 4 Lightning Bolt
and a phone holding 3 of the same printing in the same folder both baseline, summing gives 7
cards that do not exist — silently, plausibly, and findable only by counting cardboard.

So: **a baseline op's `counters` are a claim about what that device believes it holds, and the
resolution is `max`, not `+`.** Four, in that example. Ordinary edits after the baseline resume
as true deltas, so +1 on each device still lands at +2.

The failure this avoids is unrecoverable. The failure it risks — two genuinely separate stashes
being under-counted — is visible on screen and fixable by hand.

### How the flag is carried

`sync_ops.kind` is `CHECK (kind IN ('put','del'))`, and SQLite cannot alter a CHECK, so a third
verb would rebuild the table on every reader's disk. Instead:

```sql
ALTER TABLE sync_ops ADD COLUMN baseline INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1));
```

`ADD COLUMN` with a CHECK is legal — v19's `deck_cards.finish` does exactly this and the
constraint is enforced. The flag rides the wire envelope beside `kind`, and `apply` reads it in
one place: the counter arm.

**Everything else about a baseline op is an ordinary op.** Same `put` verb, same fields, same
parents, same HLC ordering, same add-wins. The flag changes one arm of one function.

## 9. When a baseline is emitted

**Not at pairing.** The relay compacts once every device has acked, keeping a 30-day tail — so a
baseline sent once at pairing is gone by the time a third device joins on day 40, or by the time
a wiped phone re-pairs. A pairing-time one-shot would work exactly once and then quietly stop.

**The trigger is a peer that needs one:** a device in the roster (`sync_devices`) for which this
device holds no watermark in `sync_peers`. That covers the first pairing, a third device joining
later, and a device wiped and re-paired — all the same condition, detected the same way.

**Idempotence, and where the marker lives.** `ALTER TABLE sync_devices ADD COLUMN baselined_at
INTEGER;` — NULL means "this peer has never been sent a baseline".

It goes on the **roster** and not on `sync_peers`, and that is the whole reason to name the table
here: `sync_peers` holds a watermark and only gains a row once a peer has *acked* something, so a
peer that needs a baseline is precisely a peer with no row there. A marker on a table whose
absence is the trigger cannot work. `sync_devices` has one row per device in the group from the
moment pairing completes — verified on the live pair, two rows.

Re-emitting is *harmless* — grain-match plus `min(uid)` plus `max` on counters converge — but it
is wasteful, and "harmless" is not a reason to do it twice.

**Both directions.** Each device baselines for the other. That is what makes "I want to see my
collection on my phone **and** my desktop" true rather than half-true, and it is why the emitter
is chosen by the roster rather than by who started the pairing.

**Ordering.** Rows are emitted parents-first — folders, decks, categories, then entries, cards,
wishes, tags, audit. The deferral machinery would converge anyway, but only after as many passes
as the dependency chain is deep; emitting in order costs nothing and makes a first sync one pass.

**Stamping.** A baseline op is stamped with the row's own modification time, **not with "now"**.
A baseline stamped now would beat a peer's genuinely newer edit under per-field LWW, so the
device that happened to pair second would win every argument it should lose.

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

## 10. What the reader sees

The Sync panel already reports *"Sent N changes and received N changes"* and defers with a
sentence. A baseline is larger than an ordinary sync and must not look like a hang:

- While emitting or applying a baseline, the panel says so in its own words — that this is the
  first exchange with that device and roughly how much is moving.
- The count of `deck_audit` rows is named separately (§7).
- A baseline that fails part-way leaves the peer's marker unset, so the next sync starts it
  again. Partial application is safe: every op is independently mergeable, which is the property
  that made ops the right carrier in the first place.

## 11. Budget

Measured on the real device pair, 2026-08-29: **1 069 synced rows**, average op **698 B** on the
wire.

| | This collection | Free-tier limit |
| --- | --- | --- |
| Baseline payload | ~746 KB | 5 GB store |
| Stored rows at 200 ops/batch | ~6 | 100 000 row-writes/day |
| A 50 000-row collection | ~35 MB, 250 stored rows | same |

The bulk-import case §7.7 already sized is the worst case and is unchanged. `deck_audit` is the
only unbounded contributor, which is why §7 requires batching rather than assembly.

## 12. An adjacent bug, found while writing this

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

## 13. What this design does not do

- **It does not change any conflict rule** except the counter arm behind the baseline flag.
- **It does not merge same-named decks or folders** (§6).
- **It does not add a snapshot artifact, a query protocol, or a second apply path** (§5).
- **It does not address the WebSocket fan-out**, which remains owed from PR 7.
- **It does not transfer the corpus.** Every platform builds its own from Scryfall — decision 5,
  untouched. A phone that has not synced its corpus will hold collection rows whose cards it
  cannot yet draw, and that is the existing, intended behaviour for a card the corpus lacks.

## 14. How it will be verified

- **Unit**: the counter arm under the flag (`max`, not `+`), stamping from `updated_at`, the
  emit order, the trigger condition, and idempotence — each with a mutation that must go red.
- **Two-database**: the existing in-process pair test extended to "A has 275 rows, B has none" and
  to "both have overlapping rows", asserting convergence and no duplicates.
- **The one that matters**: the live pass in §1 re-run. The phone's collection must read **275**,
  and its decks, folders and wishes must match the desktop's. That number is the deliverable —
  nothing else demonstrates the feature this design exists for.
