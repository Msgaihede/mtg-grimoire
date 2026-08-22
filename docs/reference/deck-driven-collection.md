# Deck driven collection

**Shipped 2026-08-22.** [Issue #168](https://github.com/Msgaihede/mtg-grimoire/issues/168); the
design is [2026-08-22-deck-driven-collection-design.md](../superpowers/specs/2026-08-22-deck-driven-collection-design.md).
This page is the record of what was built, and where it differs from that spec the **code** is
what is written down here.

Every figure on this page was measured on **Windows**, and each one names the build it was taken
on. There are very few: the only numbers here that a build cannot answer for itself are the ones
the spec inherited, and they are marked where they appear.

Not everybody wants to keep a collection by hand. A reader who builds decks has already told this
app what cards they own — twice, if they then re-enter the same cards on the Collection page.
This setting makes the second entry unnecessary: **switch it on and your decks _are_ your
collection.**

The rule, in one line: **the collection is the sum of every `deck_cards` row whose `variant` is
`live`.**

**Nothing is deleted.** The setting changes where the collection is *read from*; the reader's
hand-built `collection_entries` stay on disk untouched and come back the moment the switch goes
off. That is the sentence the whole design rests on, and it is why the five collection writes
refuse in Rust rather than writing somewhere invisible.

## The bit — `deck_driven.rs`

One row in `app_meta` (schema v6), **no migration** — `nav.rs`'s shape, copied wholesale.

- `K_DECK_DRIVEN = "deck_driven_collection"`, stored as `"1"` / `"0"` through two named
  constants. **Off writes `"0"`; it does not delete the row.** The temptation is to treat the
  row's *existence* as the setting — that implementation reads correctly and clears wrong, and
  `switching_it_off_again_clears_a_stored_on` is the test it fails.
- `stored(&Connection) -> bool` is **infallible, and the breadth of that is the rule**. No row (a
  fresh install, and the common case), an unreadable row, `"true"`, `"yes"`, `"2"`, `""` — every
  one answers `false`, which is the hand-kept collection the reader's own rows are still sitting
  in. That is the right floor: the degraded state shows them their data. It is also what makes
  "reading the setting can never fail" cheap enough to do inside every query builder.
- `store(&Connection, bool)` has **no refusals**. A `bool` off the IPC boundary has no junk
  state — `serde` has already rejected everything that is not `true` or `false` — so there is
  nothing for a validation arm to catch.
- `switch(&Connection, bool)` is `store` **plus the allocation ledger**, in one transaction, and
  is what the command calls. See
  [the allocator section](#as-they-were-is-not-as-they-should-be--the-ledger-is-rebuilt-on-the-way-off):
  the ledger goes stale for as long as the setting is on, and the way back off is where it is
  settled. Reach for `store` only when you mean the bit and nothing else — which, outside its
  own tests, is nowhere.
- Two commands, registered in `lib.rs`'s `invoke_handler` beside `nav::nav_collapsed`:
  `deck_driven_collection` (a bare `bool`, infallible by signature) and
  `set_deck_driven_collection`. **No capabilities entry** — Tauri v2's ACL gates `core:` and
  `plugin:` commands, and an app's own `#[tauri::command]` is always callable.
- **The write goes through `collection_source::with_write_owned`, not bare `with_write`**, and
  that one line is the only thing in the module that is not `nav.rs`'s. Flipping this bit changes
  which cards are owned without touching either table, so the search index's `owned` dimension is
  stale the instant the write lands and nothing on screen would say so.
- **A refusal here *is* surfaced**, unlike the nav rail's. That switch costs a reader one launch's
  starting state; this one changes what their whole Collection page is a list of.

## The rule — `collection_source.rs`

One predicate:

```rust
pub const LIVE: &str = "dc.variant = 'live'";
```

Four things are *absent* from it and each absence is a decision:

- **No `deck_categories` join and no `is_active` term.** An inactive Maybeboard is a statement
  about how the *deck* is read, not about whether the cards are in the reader's hands. This is
  the one place in the crate that deliberately departs from `deck::allocate_deck`'s rule.
- **No `decks.archived` term.** Archiving is filing, not disassembling.
- **No `theory_enabled` term**, because none is needed: a deck with no theory list keeps every
  row as `live`, so "a deck without a plan counts in full" falls out of the predicate rather than
  needing a clause.
- **No `decks` join at all**, which is the same sentence from the other end.

> **`collection_source::LIVE` is not the same kind of value as `deck::LIVE` or
> `deck_theory::LIVE`, which share its name**, and three files now see both. Those two are
> `schema::DECK_VARIANTS[0]` — the bare variant *value* `live`, bound as a query **parameter**.
> This one is a whole **predicate**, interpolated into a SQL string. Both are `&'static str`, so
> binding this as a parameter (it would match no row) or interpolating one of those (a syntax
> error, on a good day) is a mistake nothing but the reading catches.

### Two shapes, not one

**This is the first place the shipped code departs from the spec.** The spec described a single
`source(conn, alias)` fragment swapped in everywhere. What shipped is that fragment — renamed
`rows` — **plus four direct-read builders**, because the readers ask two different shapes of
question:

- `rows(conn, alias)` — the **grouped** row source, a `FROM` fragment. Only the two commands that
  list whole rows want it.
- `owns_printing`, `copies_of_printing`, `copies_of_oracle`, `owned_rowids` — **direct**
  correlated reads that go straight at `deck_cards` with no `GROUP BY`.

The reason is a performance one and it is load-bearing: `search.rs`'s owned badge sits inside a
correlated subquery over a **116 000-row** table (the corpus figure from
[data-and-sync.md](data-and-sync.md); not re-measured for this change), and a correlated read of
an aggregate recomputes the whole deck sum once per candidate row. `idx_deck_cards_card` covers
the direct arms, and it is the same index the hand-kept arm's `idx_collection_card` is.

Two spellings of one rule is exactly how a thing like this drifts, so
`the_two_shapes_agree_on_the_same_database` runs both against one fixture and compares. The
fixture seeds a hand-built collection **and** the live deck rows that match it copy for copy, so
every builder can be asked the same question in both modes — and every ON-arm assertion doubles as
a claim that the derived arm is blind to those rows.

### The grouped source

```sql
(SELECT min(dc.id)                      AS id,
        dc.card_id                      AS card_id,
        dc.set_code                     AS set_code,
        dc.collector_number             AS collector_number,
        dc.lang                         AS lang,
        coalesce(dc.finish, 'nonfoil')  AS finish,
        NULL                            AS condition,
        NULL                            AS condition_original,
        sum(dc.quantity)                AS quantity,
        0                               AS tradelist_quantity,
        count(DISTINCT dc.deck_id)      AS deck_count,
        NULL AS purchase_price,  NULL AS purchase_currency,
        NULL AS acquired_at,     NULL AS acquisition_source,
        NULL AS serial_number,
        0 AS altered, 0 AS signed, 0 AS proxy, 0 AS misprint,
        NULL AS grading,  '[]' AS tags,  NULL AS notes,
        max(dc.needs_review)            AS needs_review,
        min(dc.created_at)              AS created_at,
        max(dc.updated_at)              AS updated_at
   FROM deck_cards dc
  WHERE dc.variant = 'live'
  GROUP BY dc.card_id, coalesce(dc.finish, 'nonfoil'), dc.lang) {alias}
```

Off, `rows` returns the string `collection_entries {alias}` and nothing else.

- **The grain matches `COLLECTION_GRAIN`'s live terms and no others.** `card_id`, `finish` and
  `lang` are the three a deck card can supply. `condition`, `altered`, `signed`, `proxy`,
  `misprint`, `serial_number` and `grading` are also in that grain and have no source here, so
  they are constants — and constants that cannot collapse two real rows into one, because they
  are constant across *every* derived row.
- **`coalesce(dc.finish, 'nonfoil')` is the one translation, and it appears twice.**
  `deck_cards.finish` is `NULL | 'foil' | 'etched'` and `'nonfoil'` is never stored
  (`deck::normalise_finish`); `collection_entries.finish` is `NOT NULL` and spells it out. It is
  in the `GROUP BY` as well as the `SELECT` for `COLLECTION_GRAIN`'s own reason: SQLite treats
  NULLs as distinct, so grouping on the bare column would fork every regular copy.
- **`condition` is `NULL`, not `'NM'`.** The DDL default would be a fact the reader never stated,
  and the collection export scope would write it into their file. `CollectionRow.condition` is
  `Option<String>` in Rust and `string | null` in `ipc.ts`, and every renderer handles the absent
  case.
- **`needs_review` survives.** `deck_cards` carries the column and `reconcile::sweep_orphans`
  already writes it over all three user card tables, so a vanished printing still flags a
  deck-driven collection and the page's banner still has something to offer. `max()` over the
  group is "any contributing row has a sentence".
- **`min(dc.id) AS id` is unique per group**, because the groups partition disjoint sets of rows —
  which is all a React key and a virtualiser need. **It is not a `collection_entries.id`**, which
  is the whole of why the five writes refuse.
- **`set_code` and `collector_number` are bare columns in an aggregate.** They sit outside the
  `GROUP BY` with more than one aggregate function present, so SQLite's `min`/`max` bare-column
  rule does not apply and each is taken from an arbitrary row of its group. That is harmless
  **by construction rather than by luck**: `deck_cards` denormalises both from the one `cards`
  row its `card_id` names, so every row of a group carries the same pair and the arbitrary choice
  cannot be observed. A column that is *not* constant per `card_id` may not be added the same way.

### `deck_count` is not part of the shared column shape

**The second departure from the spec**, and it is worth stating plainly because the natural
reading of "the same columns" is wrong here.

The derived arm emits `deck_count`; `collection_entries` has no such column, and wrapping the
table in a subquery just to add `NULL AS deck_count` would put an aggregate-free view in front of
the grain index for no gain. So `collection::list_entries` **picks the expression per mode** —
`e.deck_count` on, the literal `NULL` off — and **appends** it to the end of its own SELECT list,
so every index above it stays what it was. (The number of that column is deliberately not written
down here: it moved once already when main's `legalities` landed in a merge, and the row mapper in
`collection.rs` is the one place that has to count.)

A caller who read "the same columns" and wrote `e.deck_count` straight would get `no such column`
in the **hand-kept** mode only: the half of the switch a derived-mode test never reaches. The
derived half has its own version of that trap, and
`every_sort_key_and_a_text_filter_answer_from_the_derived_source` is the guard: a sort key or a
text filter names columns the row mapper never reads — `e.created_at`, `e.condition`, the price
expression — so a column left out of the subquery is `no such column` on a page nobody tested
sorting.

### Three table aliases are spoken for

The hand-kept arms bind `collection_entries e`; the derived arms bind `deck_cards dc`, and
`copies_of_oracle` binds `cards k` beside it. A `card_col` or `oracle_col` argument that itself
begins `e.`, `dc.` or `k.` is captured by the **inner** alias rather than the caller's — which
quietly turns `owns_printing` into a tautology, with no compile error and no runtime error,
because the resulting SQL is perfectly valid and simply asks a different question. Nothing
collides today (`search.rs` binds only `c` and `cards_fts`), and that is the whole reason to
write it down: **`e`, `dc` and `k` are taken.**

## The seven readers

Every SQL site that asks "what does the reader own" takes the swap, each in whichever shape fits
the question it asks. `grep -rn 'collection_source::' src-tauri/src` is the census; this table is
what each one is *for*.

| Site | What it feeds | Shape |
| --- | --- | --- |
| `collection.rs` — `from_sql` | the Collection page's list and summary | `rows(conn, "e")` |
| `search.rs` — the `owned` filter | the Owned / Missing chip | `owns_printing` |
| `search.rs` — the tile badge | owned copies on every search tile | `copies_of_oracle` collapsed, `copies_of_printing` not |
| `index/mod.rs` — `rebuild_owned` | the `owned` / `missing` facet counts | `owned_rowids` |
| `import.rs` — `match_columns` | **which printing an import resolves to** | `copies_of_printing` |
| `wishlist.rs` — `owned_sql` | wishlist fulfilment and the Fulfilled filter | its own two arms, built on `LIVE` |
| `deck_theory.rs` — `owned_spare_sql` | the theory shopping list's "Already owned" | its own two arms, built on `LIVE` |

**The last two are the third departure from the spec**, which put all five correlated readers on
shared builders. They could not be: both narrow by **finish**, which no shared builder does, and
the theory one also subtracts the copies sitting in **built** decks. Each writes its own pair of
arms and takes only `LIVE` from the shared module. A new reader that needs a term nobody else
needs joins those two rather than widening a builder.

Two consequences of the finish narrowing are worth stating on their own, because both fail
silently:

- **`wishlist::owned_sql` narrows by printing *and* finish and by neither condition nor anything
  else.** A wish *for the foil* is not satisfied by the nonfoil in a binder. On the derived side
  that means `coalesce(dc.finish, 'nonfoil') = w.preferred_finish` — binding the deck's NULL
  straight through would make **every regular wish read zero owned**.
- **`deck_theory::owned_spare_sql`'s derived arm has no `deck_allocations` in it at all**, because
  that ledger is not written in this mode (see below), so the rows still on disk describe a world
  the reader left. "Copies a built deck is using" becomes a sum over the built decks' own live
  rows. `is_built` keeps the job it has always had: a card in an unbuilt deck's live list is still
  available to a plan, and one in a sleeved-up deck is not. Its `coalesce(?2, 'nonfoil')` does
  double duty — the same NULL-versus-`nonfoil` translation, applied to **both** halves of the
  subtraction.

**`images.rs`'s `prewarm_keys` needed no change.** Its UNION already reads `deck_cards` alongside
`collection_entries`, so a deck-driven collection's images were already being warmed.

## `invalidate_owned` on a deck write

While the switch is on, the search index's `owned` dimension moves whenever a live deck row moves.
Rebuilding it after every deck edit in the **hand-kept** mode would be a full index clone for
nothing; *not* rebuilding it in the **derived** mode is the search Owned facet answering from
before the edit with nothing on screen to notice. So the wrapper asks:

```rust
collection_source::with_write_owned_if_derived(state, f)
```

`sync::with_write`, plus `index::lifecycle::invalidate_owned` **on success only** and **only while
`deck_driven::stored`**. The flag is read *after* the write, on the read pool, so it cannot
contend with the write that has already finished — nothing a deck write does can change it.

Its neutral twin `with_write_owned` — always invalidate — **moved out of `collection.rs` into this
module** when the source became switchable. Its three callers are now a collection write,
`reset::collection_clear`, and the setting itself, and what they have in common is this module
rather than that one.

**Thirteen deck commands** are routed through `with_write_owned_if_derived` — the twelve that can
move `deck_cards.quantity`, `.variant` or `.card_id`, plus `deck_missing_to_wishlist`:

| File | Commands |
| --- | --- |
| `deck.rs` | `deck_update` (which carries the theory move), `deck_delete`, `deck_duplicate`, `deck_add_card`, `deck_set_card_quantity`, `deck_category_clear`, `deck_move_card`, `deck_swap_printing`, `deck_set_card_finish`, `deck_missing_to_wishlist` |
| `deck_meta.rs` | `deck_category_delete` |
| `deck_undo.rs` | `deck_undo_apply`, `deck_redo_apply` |

**`deck_missing_to_wishlist` is on that list and writes no `deck_cards` row** — it writes
`wishlist_entries` and rewrites the deck's `deck_allocations`, and neither is a change to what the
reader owns in either mode. Routing it is harmless and one fewer exception to remember; the
sentence above it, not the routing, was what was wrong.

Two more writers outside that set take the same wrapper: **`import::deck_import_commit`**, the
bulk decklist write, and **`reset::decks_clear`**. The last one is the fourth departure from the
spec, which did not mention it: it was the only unrouted writer left after the crate was swept,
and it is the *largest* ownership change a reader can make in one press — with the setting on,
wiping the decks **is** wiping the collection.

**Fifteen call sites, and the obvious grep finds four of them.**
`grep -rn 'with_write_owned_if_derived' src-tauri/src` misses eleven, because `deck.rs` and
`deck_meta.rs` both `use … as owned_if_derived` and call it under the short name — the full name
appears at those two files' `use` lines and nowhere else in either. What is left over is mostly
the definition, doc references and prose. The census that works is:

```
grep -rn "owned_if_derived(&state" src-tauri/src
```

which finds every site whichever name it was called under, plus the two in `collection_source`'s
own test for the wrapper.

**`deck_meta::deck_category_set_active` deliberately stays on plain `sync::with_write`.** It moves
no card: it flips `is_active`, and `LIVE` carries no `is_active` term, so a deck-driven collection
counts the pile either way. Routing it would be a ~1 MB index clone per press for an answer that
cannot have changed. (It still reallocates, because in the hand-kept mode it *is* the allocator's
rule. The two rules genuinely differ here, on purpose.)

**`reconcile.rs` got no new invalidation call, and this is correct — do not "fix" it.** Verified in
source by a reviewer, 2026-08-22. `reconcile::apply`'s deck half is an ownership change while the
collection is derived, and it is the one deck write in the crate with no command behind it, so
there is no wrapper to hang a rebuild off. It needs none: `sync.rs`'s `reconcile_ids` already calls
`index::lifecycle::invalidate_owned` whenever a pass reports
`repointed + folded + flagged > 0`, and every arm of `reconcile::merge` — the deck arm included —
bumps one of those three. `reconcile::apply` has exactly **one caller crate-wide**. That refresh is
deliberately **not** gated on the setting: it was written for the collection rows and costs one
dimension re-read on a pass that has already found something to tell the user about.

`reconcile::sweep_orphans` is the deliberate exception and needs no refresh at all — it writes
`needs_review` and never a `card_id`, so the set of cards the reader owns is the same before and
after it in **both** modes.

## The five refusals, and the id collision that makes them a fence

While `deck_driven::stored(&conn)` is true, five functions in `collection.rs` return
`Err(collection::DECK_DRIVEN)` before doing anything:

`add_entry` · `set_quantity` · `update_entry` · `remove_entry` · `commit_import`

```
Your collection is driven by your decks. Turn the setting off in Settings to edit it by hand.
```

**This is a safety requirement, not a courtesy.** The derived `id` is a `deck_cards.id`.
`collection_remove(id)` and `collection_set_quantity(id, n)` address `collection_entries` by
primary key, and the reader's hidden hand-built rows are **still on disk** — so a stray call
carrying a derived id would delete or rewrite an unrelated row the reader cannot currently see.
A UI that merely greys the button is the *second* fence; this is the first.

The refusal is checked inside the pure function rather than at the command, so a test can prove a
write never reached the table by getting the sentence back from a direct call.

**`reset::collection_clear` stays allowed.** It is the Danger Zone, and throwing away the hidden
hand-built rows is a legitimate thing to want. What changes there is one clause on the row's
summary, said where the button already is:

> Every card you own, with its condition, purchase price, tags and notes — your hand-built
> collection, which is currently hidden because this collection is driven by your decks.

`DECK_DRIVEN` is a **sentence** the reader reads on its own, after they pressed something. The
frontend's `DECK_DRIVEN_REASON` — `"Your collection is driven by your decks"` — is a **clause**
appended to a control's accessible name, immediately after the name of the thing being greyed:
`"Add to collection — your collection is driven by your decks"`. A capitalised sentence with a
full stop in the middle of an accessible name is the wrong register, and a second copy of the
backend's wording is a second place for it to drift. **The two are deliberately different strings
for two different jobs.** Four surfaces append the clause: `AddToCollection`, the card context
menu's Collection row (`cardMenu.tsx`), the Collection table's quantity stepper, and the import
dialog's `collection` destination — refused at the destination picker, so the reader learns before
building a plan.

## What a derived row cannot carry

`deck_cards` supplies `card_id`, `finish` and `lang`, and nothing else the collection grain names.
Twelve of `collection_entries`' columns therefore have no source, and the derived row emits a
constant for each:

| Column | Derived value | Why not something else |
| --- | --- | --- |
| `condition`, `condition_original` | `NULL` | the DDL's `'NM'` would be a fact the reader never stated, and export would write it to their file |
| `tradelist_quantity` | `0` | a deck card is not in a tradelist |
| `purchase_price`, `purchase_currency` | `NULL` | nothing was bought |
| `acquired_at`, `acquisition_source` | `NULL` | there is no acquisition story |
| `serial_number`, `grading` | `NULL` | no source |
| `altered`, `signed`, `proxy`, `misprint` | `0` | no source; constant across every derived row, so they cannot collapse two real rows into one |
| `tags` | `'[]'` | the column is JSON and the renderers parse it |
| `notes` | `NULL` | no source |

Two things it *can* carry that the table cannot: `deck_count`, free in the same aggregate; and
`needs_review`, `max()`ed across the group.

Giving deck cards a condition is a different feature with its own question about what happens to
the four other places a deck row is written, and it is out of scope. So is per-deck ownership:
copies are **pooled**, so three decks each running a Sol Ring means three Sol Rings, and there is
no "these are the same physical card" concept for this change to invent.

## The allocator, and the four other owned numbers

`deck_allocations.collection_entry_id` is a hard FK into `collection_entries(id)`. Derived rows
have no such ids, and the ledger would be circular anyway — every deck would claim copies it
itself contributed. So while the switch is on:

- **`deck::allocate_deck` returns `Ok(())` immediately**, and the early return sits **above its
  own `DELETE`**. Existing rows are left exactly as they were rather than torn down, so a reader
  who presses the switch to look and presses it straight back finds their decks as they left
  them, not emptied by a mode that never used them.
- **`deck::attribute_owned` reports `owned_quantity = quantity` for every `live` row**, so no live
  deck card draws the short mark. That is not a fudge — under this setting it is true by
  construction, because the collection *is* the sum of those very rows. It takes the inactive
  category with it, which is where this rule departs from the allocator's on purpose.
- **The theory fence stays**, for a second reason on top of the ledger one: a theory row is a card
  the reader has said they do **not** have yet. `deck_allocations` carries no variant, so a theory
  read walks the *live* deck's claims — that test comes first in `attribute_owned` and stands on
  its own rather than being folded in with the category one.
- **`deck::missing_to_wishlist` therefore finds nothing missing on a live list** and writes no
  wishes. The theory route (`deck_theory_missing_to_wishlist`) is unaffected and is the one that
  still means something.

### "As they were" is not "as they should be" — the ledger is rebuilt on the way off

**Left standing is not left correct, and that gap shipped as a bug.** Every card write calls
`allocate_deck`, and every one of those calls returns early for the whole time the setting is on.
So the claims a deck had when the reader switched over are the claims it still has when they
switch back — describing a deck that may have been edited a hundred times in between. The failure
is not in the deck that went stale; it is in **every other built deck**, because `allocate_deck`
computes availability as the entry's quantity minus the claims of other built decks:

> Four Sol Rings. Deck A is built and claims one; deck B is built and gets the other three. Turn
> the setting on, take Sol Ring out of A, turn it back off. A's phantom claim still stands, so B
> is short a copy it owns, the theory spare under-reports, and `missing_to_wishlist` on B writes a
> wish for a card sitting in the reader's binder. Only a later card write **to A** clears it, and
> nothing tells the reader one is owed.

So **`deck_driven::switch` is what the command calls, not `deck_driven::store`**. On the way off it
writes the flag and then calls `deck::allocate_every_deck`, which empties `deck_allocations` and
deals every deck again, **deck id ascending**. A per-deck loop would not do: a deck reallocated
before the deck whose rows went stale still subtracts those stale rows and comes out short, so the
table is cleared once, up front. The order matters twice — the flag is written first because
`allocate_every_deck` asks `deck_driven::stored` and would stand down if it still read on, and both
writes are in **one transaction** because a crash between them lands on exactly the state being
repaired.

Nothing happens on the way **on**. The ledger is not read in that mode, and clearing it there —
the other candidate fix — would throw away a state the reader may be one press from wanting back.

**What it costs**: 102 ms and 106 ms for 50 decks × 100 cards against a 500-entry collection, and
424 ms at 200 decks — in-memory SQLite, **debug** build, 2026-08-22, measured with a throwaway
test that was deleted after. Linear in decks, and it is a one-press cost on a setting a reader
flips rarely. A release build is the usual several times faster and was not measured.

**A rebuild is not always claim-for-claim what the incremental history left.** Where copies are
scarce, "oldest deck first" can hand the last playset to a different deck than the order of past
edits did. That is the honest answer: it is what the same decks would be given if they were
entered today, and it is the only self-consistent one available.

The tests are `switching_the_setting_off_rebuilds_a_ledger_that_went_stale_while_derived` (the
scenario above, end to end), `switching_the_setting_on_leaves_every_claim_standing` (the other
arm), and `the_setting_and_its_rebuild_commit_or_fail_together` (an `ABORT` trigger on
`deck_allocations`, fired after the DELETE and before the first INSERT).

The remaining owned numbers need no special handling beyond the source swap: the search badge, the
search facet, wishlist fulfilment and import match ranking all read the derived sum and stay
consistent with the Collection page by construction.

## The Collection page in this mode

- **A note above the filter bar** — "Your collection is the sum of the cards in your decks. Theory
  lists are left out." — with a button to Settings. It is how somebody who forgot the switch finds
  it again, and *"theory lists are left out"* is the one thing a reader cannot deduce from the
  sentence before it. A `<button>` and not an `<a>`: there is no router in this app, so a link
  would have nowhere to point.
- **The Condition chip group is hidden**, and the filter is dropped from the request, from the
  query key and from the `activeCount` badge — one expression in `useCollection`, so all three
  move together. That is a **correctness** fix rather than a tidy-up: every derived row's
  condition is NULL, so a grade the reader picked before flipping the setting would empty the page
  from a chip that is no longer on screen to clear.
- **The third column's header shortens** from `Finish · condition` to `Finish`. **The header reads
  the mode; the cell reads the row.** A cell branches on `row.condition === null` and never on the
  flag — the DTO is the fact about *this* row, and a cell reading the flag could contradict the
  data it was handed during the render after a flip.
- **The Actions column carries the provenance.** It loses its only control — a derived row cannot
  be removed, because the copies are in the decks — and answers the question a derived row
  actually raises instead: `3 decks`, singular-aware. The count is free in the aggregate; the
  names are one hover away. The caption under the table changes with it, from *"To remove an
  entry, set its copies to zero"* to *"Copies are removed in the deck that holds them. Hover a deck
  count to see which."*
- **The quantity stepper is greyed with its reason**, `aria-disabled` and never `disabled` — the
  reason has to stay reachable, which means the control has to stay in the tab order. The page's
  `onSetQuantity`/`onRemove` callbacks also **return early**, which is the load-bearing half:
  `aria-disabled` is a statement to assistive tech and stops no click, and the row's context menu
  and the keyboard never saw the attribute at all. Letting the press through to a backend that
  refuses would surface the refusal as *"Could not change your collection"* over an optimistic
  patch that had already moved the number and then moved it back — a failure, where the truth is
  "that control is not available".
- **The empty state** says *"Your collection is driven by your decks, and you have no decks yet."*
  The manual mode's *"Add cards from search, or import a collection file"* would be wrong as well
  as unhelpful here: the reader would follow it and watch the page stay empty.
- **The summary's tradelist figure is hidden** — it can only read 0. The other aggregates are all
  meaningful: `value` and `unpriced` are the same sums over the same price join, `needs_review`
  still counts, and `unique_cards` / `entries` differ from each other in this mode exactly as they
  do in the other.

### `collection_row_decks` and its tooltip

```rust
#[tauri::command] // collection_decks.rs
collection_row_decks(card_id: String, finish: String, lang: String) -> Vec<RowDeck>
// RowDeck { deckId, deckName, quantity }
```

Ordered by deck name (`COLLATE NOCASE`, with the id as the tiebreak two decks of one name need),
`live` only, and summed across each deck's categories — **the inactive ones included, because
these lines have to add up to the count above them.**

**`finish` arrives in the collection's spelling and is translated back**: a regular copy is
`'nonfoil'` on a collection row and NULL on a deck card, so the predicate is the same
`coalesce(dc.finish, 'nonfoil') = ?2` the derived source groups by. A mismatch here would silently
empty the tooltip on every regular row while the count above it read three.

**The command is not gated on the setting, and that is right.** `row_decks` has no flag check and
queries `deck_cards` unconditionally: "which decks hold this printing" is a fact about decks and is
true in either mode. What is mode-specific is *who asks* — the page reaches for it only where a
`deckCount` exists to explain, and that is `null` while the collection is hand-kept. (`ipc.ts`
claimed this answered empty on a hand-kept collection until 2026-08-22; it never did.)

**There is no `Tooltip` component in this app — the API is `useTooltip()`, which returns a binder
you spread onto the anchor** (`{...tip(content, { describes: false })}`). The **laziness is a
consequence of passing a component rather than a string**: `content` is a `ReactNode` that
`TooltipProvider` renders inside itself, under the app's `QueryClientProvider`, so the query does
not exist until a panel is open and it re-renders in place when the answer lands. Mounting *is*
the open and unmounting is the close; there is no `onOpenChange` and none is needed. **A string
would be snapshotted at bind time** and the panel would sit on "Loading…" forever.

`describes: false`, so the panel wires no `aria-describedby` — its text is asynchronous, and
pointing a description at a panel that says "Loading…" at the moment it is read is worse than
pointing at nothing. The count itself is plain text in the accessibility tree either way. The
query is keyed under `["collection", "row-decks", cardId, finish, lang]` so every write that
already invalidates the collection takes the tooltip's lines with it, with a 30 s `staleTime`
covering the gap between two hovers.

## The frontend seam

- `src/lib/useDeckDrivenCollection.ts`, from `useNavCollapsed.ts`: a query with
  `staleTime: Infinity`, an optimistic `setQueryData` before `mutate` — and, **unlike the nav
  rail's, a rollback and a surfaced refusal.** Every clause of the rail's "never roll back"
  argument points the other way here: this switch decides what the Collection page is a *list of*,
  so a switch left reading "Enabled" over a hand-kept collection would be the page and the control
  disagreeing until the next restart. The previous value is carried into the mutation rather than
  derived as `!enabled`, so a defensive write of the value it already holds is not "rolled back" to
  the opposite of where it started.
- **A read that fails is `false`** — the hand-kept collection, where the reader's own rows are.
  That is why a failed read raises nothing while a failed write does: nobody asked for the read,
  and its fallback is already the safe answer.
- **The flag is a segment of `useCollection`'s `filterKey`**, exactly as `marketplace.id` is, so a
  flip refetches the list *and* the summary rather than serving the other mode's cache. One
  segment moves the table and the nine figures above it together.
- A successful flip invalidates `["collection"]`, `["cards","search"]`, `["decks"]` and
  `["wishlist"]` — the same four keys `AddToCollection` already fires, because the same four
  surfaces move.
- The page reads the flag off `useCollection` rather than calling the hook again, so the page, the
  filter bar and the table cannot disagree about which mode they are drawing for the length of a
  render.

## The Storybook fake

`.storybook/fake/db.ts` carries `deckDrivenCollection: boolean` on `FakeDb` — plain, following
`navCollapsed`, because the backend cannot produce a third state — with a `false` default in
`makeDb`, a read handler and a write handler that goes through `refuseIfBusy`. The fake's
`collection_list`, `collection_summary`, the search wall's owned fields, the wishlist's owned
fields and `deck_get`'s all honour the flag, or Storybook would draw a wall the app never draws.
It mirrors the crate's shape rather than the crate's output: `collectionSource(db)` returns rows,
so every filter, order and mapper below it is written once.

**The `deckDriven` seed's subject is a *setting*, and it seeds no `collection_entries` at all.**
That emptiness is the fixture rather than a shortcut: the setting deletes nothing, so the
commonest real world has hidden hand-built rows under the derived list — but a story drawing five
rows cannot tell whether they came from the decks or the table unless the table is empty. A world
with both belongs to the *switching* stories, which make it by pressing the control on `starter`.

Three decks and eight deck cards, chosen so every clause of `LIVE` is visible at once: Lightning
Bolt across all three (one of them a **switched-off** Maybeboard, one **archived**, neither
subtracted), Urza's Saga as a regular row and a foil row of one printing, and Dismember in a
`theory` list and therefore **not in the collection at all**. `Collection/Page`'s `DeckDriven`
story is that seed on the real page; `Settings/DeckDrivenPanel` is the switch and its three
states.

## Out of scope

- **A holding area for cards removed from live decks** — the follow-up comment on issue #168. It
  needs its own answers (is it a deck? does it count? how does a card get in and out?) and would
  double this change. A reader can already make a deck called "Binder", keep its cards live, and
  have exactly that behaviour today.
- **Condition, purchase price or acquisition data on a deck card.**
- **Per-deck ownership.** Copies are pooled.
- **Making the allocator work against derived rows.** A version that allocates deck cards to each
  other is a different design.
