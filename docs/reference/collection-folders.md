# The collection's folders, and the eleventh term of its grain

Schema **v24 and v25**, [issue #215](https://github.com/Msgaihede/mtg-grimoire/issues/215). The
design is
[2026-08-23-collection-folders-design.md](../superpowers/specs/2026-08-23-collection-folders-design.md);
this page is the record of what shipped, with the reason at each site. Every figure keeps the date
and the build it was taken on.

The short version: a collection row is filed in exactly one place, `NULL` is the root and is where
every row lands unless the reader says otherwise, and **the folder is part of what makes two rows
the same row**. That last clause is the load-bearing one and everything else on this page is a
consequence of it.

**And since v25 this cabinet is the physical ledger of where every card sits.** A card is in a
deck because its `collection_entries` row is filed in that deck's group — not because a claim
table says a deck has reserved it. `deck_allocations`, `deck::allocate_deck`,
`allocate_every_deck`, `kind_rank`, `Candidate` and `decks.is_built` are all **deleted** at that
rung. Exclusivity stopped being a sum somebody has to remember to recompute and became a fact the
reader can see and drag: two decks cannot both hold a copy, because one row cannot sit in two
folders. Everything in [the deck groups](#the-deck-groups-recently-removed-and-what-v25-converted)
is a consequence of that sentence the way everything above it is a consequence of the grain.

**This is the wishlist's cabinet one table over** — [wishlist-folders.md](wishlist-folders.md) is
the page it is a port of, and where a rule here is that page's rule, it is named rather than
re-argued. What the collection has that the wishlist does not is a folder that can belong to the
**app** rather than to the reader, and a grain that was already ten columns wide before a folder
joined it.

## The rung is split, and the split is the deviation worth knowing

Spec §3 lists **one** rung doing everything: create the folder table, widen the grain, insert
the `Recently removed` folder and one folder per deck, convert every `deck_allocations` row into a
placement, then drop `deck_allocations` and `decks.is_built`. **That rung could not ship in one
release**, because the first PR keeps the allocator working and the one after it is what removes
it. A rung that dropped `deck_allocations` at v24 would have taken out the app's only source of
owned/missing while nothing had yet replaced it.

| Rung | Does |
| --- | --- |
| **v24** | Creates `collection_folders` **in its full final shape**, `kind` and `deck_id` columns and both partial unique indexes included. Adds `collection_entries.folder_id`. Rebuilds `idx_collection_grain` with the eleventh term. Deletes zero-quantity rows. **Files nothing** — every existing row stays at the root, which is where it already was. |
| **v25** | Inserts the single `removed` folder and one `deck` folder per deck, converts every allocation into a placement, then drops `deck_allocations`, `decks.is_built` and the orphaned `app_meta` row `deck_driven_collection`. |

**Creating `kind` and `deck_id` at v24 rather than v25 was deliberate, and it paid.** They were
plain columns with no rows using them, so v25 needed no `ALTER TABLE` at all: it inserts, converts
and drops. Both partial indexes were created there for the same reason, and the `removed` insert
leans on one of them — the partial unique index on `kind` is what makes a second holding area
impossible, so that single `INSERT` is also the assertion that there is exactly one.

**v25 takes three things away, which makes it the first rung on this ladder that is not
additive.** That is why the rewind fixtures had to learn to put a table *back* (`UNDO_V25`), and
why the v25 tests start from a real v24 database rather than from a fresh install — a fresh
install has no claims to convert, so a test that starts there proves nothing about the conversion.

## The table, and the three `ON DELETE` actions

```sql
CREATE TABLE IF NOT EXISTS collection_folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user'
        CHECK (kind IN ('user','deck','removed')),
    deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
);
ALTER TABLE collection_entries ADD COLUMN folder_id INTEGER
    REFERENCES collection_folders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_removed
    ON collection_folders(kind) WHERE kind = 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_deck
    ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;
```

**Two of the actions point opposite ways, and both are chosen rather than inherited.**

- `collection_folders.parent_id` is **CASCADE**, onto its own table. A folder inside a deleted
  folder has nowhere else to be, so the whole sub-tree goes in one press. This is also why the
  cycle refusal below is not cosmetic: a cycle is a graph SQLite's recursive cascade would walk
  forever the day one of the folders in it is deleted.
- `collection_entries.folder_id` is **SET NULL**. A folder is a *filing decision*; the cards are
  the reader's **property**, and the two are not the same thing to lose. Deleting a drawer
  surfaces the copies in it at the root — where they were before anybody filed them — rather than
  throwing away what the reader owns. This is the strongest of the three SET NULLs in the schema
  for exactly that reason: a deck is work and a wish is a shopping list, but a collection row is a
  card that physically exists.

**This pair is the deck gallery's pair verbatim, and the wishlist's verbatim, and the symmetry is
the decision rather than a coincidence** — `collection_folders.parent_id` is
`deck_folders.parent_id`, and `collection_entries.folder_id` is `decks.folder_id`. "Folders nest,
and the things filed in them outlive the filing" is a rule this schema has now made **three
times**. `schema.rs`'s module doc carries the whole-schema inventory of both lists and is the copy
of record; `decks-storage.md` carries the deck slice and `wishlist-folders.md` the wishlist's. A
rung that adds one half of a new filing cabinet and forgets the other is exactly what those
inventories exist to catch, since a prose-only edit routes to neither CI job.

**The third action is this cabinet's own, and it points the other way on purpose.**
`collection_folders.deck_id` is **CASCADE**, not SET NULL — and it is the one key the other two
cabinets have no equivalent of. A folder that *stands for* a deck has no meaning once that deck is
gone, so the row goes with it. That is the opposite of what the folder's **contents** get, and the
two rules living in one table is why the contents are re-filed by hand before any cascade can
fire (see [the delete](#delete_folder-re-files-one-row-at-a-time)).

Nesting was ported rather than flattened for a cost reason, not an aspirational one: the tree
arithmetic, the cycle refusal and both cascade rules were already written and tested one table
over, so nesting was cheaper than writing a flat version would have been. `src/lib/folderTree.ts`
is reused **unchanged** — a `CollectionFolder` already answers `FolderLike` and a `CollectionRow`
already answers `Filed`. Nothing new is named `folderTree.ts`: a case-insensitive filesystem
resolves a second one against `FolderTree.tsx`, and `tsc` stays green while every test fails with
"not a function" (`src/features/decks/folders.ts:17-30`).

### The v24 step's four traps

Recorded because each is a way the migration could have been silently wrong, and none of the first
three would have raised anything:

1. **`idx_collection_grain` is rebuilt, not added to.** SQLite has no `ALTER INDEX`, and the
   `DROP` has to come first or the `CREATE` is a silent no-op on exactly the machines that already
   carry the ten-column index — the ones that matter. The `IF EXISTS` is for a fixture that took
   it away.
2. **`ADD COLUMN` has no `IF NOT EXISTS`, on either half of `ALTER TABLE`.** The step probes
   `pragma_table_info('collection_entries')` first, because the shared rewind above it *cannot* be
   complete: `UNDO_V24` drops the folder table and leaves `folder_id` standing. SQLite would in
   fact permit the `DROP COLUMN` once both indexes naming it were dropped — what a *shared* rewind
   may not do is the statement after that, since putting the ten-column index back means building
   a **narrower** unique index over rows written on the wide grain, which is a constraint failure
   the moment two of them differ only by folder, inside somebody else's fixture. So every fixture
   beneath head re-enters this step carrying the column, and a blind `ALTER` would answer
   `duplicate column name` — a failure no real upgrade can produce, which is the definition of a
   fixture lying about what it is testing. `schema_at_23`, which is the one fixture that goes on
   to *write* entries, pays the full rewind instead: the two indexes, then the column, then the
   table, then the ten-column index rebuilt as a literal.
3. **No backfill, and the absence is the design.** `folder_id` arrives NULL on every existing row,
   NULL is the root, and the root is the table the reader already sees — so an upgrade is
   invisible until they make their first folder. The unset value is not a lie a `DEFAULT` is
   telling; it is the answer. The widening is safe over existing rows for the same reason:
   `coalesce(folder_id, 0)` is the constant 0 across the whole carried-over table, so the new key
   is the old key plus a constant and is strictly *more* permissive than the one it replaces — two
   rows that clash on eleven terms clashed on ten, and the old index would already have refused
   them.
4. **`DELETE FROM collection_entries WHERE quantity = 0` is the one statement here that is not
   additive**, and it is the rung paying for a state that stops being reachable. See
   [zero quantity](#zero-quantity-deletes-the-row-and-what-that-costs).

The DDL is **spelled out literally and never interpolated from `COLLECTION_GRAIN` or
`COLLECTION_FOLDER_KINDS`**, the rule the v4, v8 and v23 steps all state: a migration step is
history, and a step that read the constant would silently rewrite what a *fresh* install creates
the next time the grain moves while every already-upgraded database kept the old shape — with the
two then disagreeing about what makes two rows the same row, and nothing anywhere going red.

### A new folder is numbered among the reader's own, and only those

`create_folder` takes `max(sort_order) + 1` **over `kind = 'user'` siblings**, not over every
sibling. The distinction did not exist before v25 and arrived with the app's own folders:
`Recently removed` is a root sibling sitting at `sort_order` 0 and every deck's group is another,
so counting them started the reader's *first* folder at 1 and left the holding area sorting ahead
of everything they would ever name. Nobody chose that ordering; it fell out of a query written
when every folder in the table was the reader's.

The UI draws the app's folders in a pinned section of their own (`PinnedFolders.tsx`), so their
numbers have no business in the reader's sequence at all — which is why the fence is on `kind`
rather than on "skip slot 0". `a_folder_the_app_owns_is_not_part_of_the_readers_numbering` seeds a
group at `sort_order` 9 alongside the holding area at 0, because either weaker spelling passes with
one system folder in the table.

## The eleventh term, and why it is load-bearing

```rust
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)";
```

The first ten terms are unchanged and are argued where they always were — `grading` enters
identity as **raw text**, so it is only ever written through the one fixed-field struct that owns
its key order. The eleventh is v24's, and it is v23's fourth-term reasoning applied one table over.

**Without it, filing a card into a folder would not be a filing at all.** The write would land on
the row the reader already had and simply raise its quantity — so their binder copy would appear
to **move**, out of wherever it was and into the folder being pointed at, and a filing decision
made last week would be undone by an add made today. A playset would collapse into whichever
folder was pointed at last. With the term, the same printing in two folders is two rows, moving
copies between them is a separate and explicit act (`collection_set_folder`), and "Add to
&lt;binder&gt;" is always an **add**.

`coalesce(folder_id, 0)` rather than the bare column, because **NULLs in a UNIQUE index are
distinct**. An un-coalesced term would stop enforcing anything for exactly the rows that need it
most: the ones at the root, where most cards live. That is the same device the grain's ninth and
tenth terms already use, for the same reason.

**It can never collide with a real folder**, because `collection_folders.id` is `INTEGER PRIMARY
KEY` and SQLite never *auto-assigns* rowid 0. The guarantee is narrower than it looks — SQLite will
happily store an explicit 0 — so `create_folder` never supplies an id and lets the database
assign. A folder numbered 0 would be indistinguishable from the root on the grain, and every card
in it would collide with the reader's unfiled copies of the same printing. Letting the database
assign is the whole of the fence.

### Every collision probe in the crate owes the eleventh term, and the reconciler's is the easy one to miss

`reconcile::collision_target` is the one probe that is not on a folder path at all: it runs after a
Scryfall migration repoints a row onto a new printing, and it asks "what row is already there?"
It spelled **ten** terms until v24, which was exact then and is a cross-folder fold now — the sweep
would sum the reader's filed copies into a binder they were never in, delete the row that *was*
there, and leave the row that actually blocked the repoint standing. A filing decision undone by an
upstream tidy-up, with nothing red and nothing in `error_log`.

`a_repointed_entry_folds_only_onto_an_entry_in_its_own_folder` is what fails if anyone narrows it
back, and `fold_wish_into_existing`'s own probe — which has spelled `coalesce(folder_id, 0)` since
v23 — is the same argument one table over, where the stake is a shopping list rather than cards
that physically exist.

**The rule, for the next term anybody adds to either grain:** a grain is not one constant, it is a
constant *and* every hand-spelled probe that compares against it. `COLLECTION_GRAIN` is deliberately
never interpolated into any of them — a probe compares a list of expressions over one row against
that many **bound values**, which is a different statement — so widening the constant cannot widen
the probes, and nothing in either half goes red when they drift.

## The merge rule: a write that lands on a taken grain merges

`collection_set_folder` moves one row onto a grain another row may already hold — it changes the
eleventh term, and nothing else. The rule is written once, in `set_entry_folder`'s doc, and every
other caller reaches it through the same function:

> **A write that lands on a taken grain merges, it does not fail.**

The two quantities sum into the row that was already there, the source row is deleted, and the
answer names the **destination** — whose id is not the id the caller handed in. Filing three
copies into a binder that already holds two of that printing is one row of five, which is what the
reader can see on the shelf. A `UNIQUE constraint failed` reaching them would be the app telling
them off for agreeing with it.

**`update_entry` stops refusing and merges too, and that half is not optional.** It used to answer
*"You already have an entry for that printing at that finish and condition"* and give up. With a
folder in the grain, **every** edit that moves a row into an occupied folder hits that refusal, so
the message became unreachable — and it was deleted with the branch rather than left standing,
because a message for an impossible state is the half-deleted rule this repo warns about.

`refile_entry` is the write itself, with no fence and no transaction of its own. Four details are
each a decision:

- **The source row is read before anything is decided**, because "is that entry still there?" is
  answered by the same statement. An `UPDATE` that changed no rows cannot tell a missing row apart
  from a grain collision, and the two want opposite answers.
- **The collision target is spelled out in SQL rather than interpolated from
  `COLLECTION_GRAIN`**, the reason `reconcile::collision_target` gives: that constant is a list of
  expressions over **one row**, and this compares the same list against eleven bound values. All
  eleven are in the comparison — a fold that matched on ten would merge a row into a row in
  another folder, which is precisely the bug the eleventh term exists to make impossible. At most
  one row can match, because those eleven terms *are* `idx_collection_grain`.
- **A miss is a plain `UPDATE … SET folder_id = ?`, with NULL bound as a *value***, never
  `coalesce(?, column)`. That spelling means "leave it alone" everywhere else in the crate, and
  using it here would make "back to the root" unexpressible — which is half of what the command is
  for.
- **`removed` stays `false`** over a merge that really did delete a row. The field means "the
  reader no longer has this", and here the copies are emphatically still theirs; the caller
  re-reads and selects the id it was handed.

### The fold went from five statements to two at v25, and the guard they were went with the table

`collection::fold_entry` is the crate's one answer to "one collection row becomes another", and
`merge_entry` is this module's name for it. It stood at **five** statements while
`deck_allocations` existed, because `deck_allocations.collection_entry_id` was the only enforced
foreign key pointed at a collection entry and it was `ON DELETE CASCADE` (schema v5), so that
`remove_entry` took a deck's reservations with the row it deleted. A merge had to leave nothing
for that cascade to take: the copies still existed and the deck still wanted them, and a folder
press that quietly unbuilt a built deck would have been the worst kind of silent. The five were:
sum the entries, fold any allocation where the destination was *already* claimed by the same deck,
delete those now-duplicate claims, repoint every remaining claim at the destination, and only then
delete the source.

**The three middle ones are gone.** `deck_allocations` is dropped at v25, **no enforced foreign
key points at `collection_entries` any more**, and what is left is the sum and the delete. That is
the wishlist's shape, arrived at by the guard becoming unnecessary rather than by anyone deciding
to simplify.

**The count is two, and this page and `collection_folders.rs` both say two.** One `UPDATE` that
sums the source into the survivor and one `DELETE` that removes the source — two `execute` calls.
Reading the source is not a third: it rides in the `UPDATE`'s own `FROM (SELECT … WHERE id = ?2)`
subquery, which is what lets one statement do the work two used to. *"Read the source, sum into the
survivor, delete the source"* describes the same code in three **steps**, and counting those steps
as statements is where a second number comes from — it is a true sentence about a two-statement
function, and mixing the two spellings is how a reader ends up reconciling two numbers that were
never in disagreement. Say **two**.

**And the fold cannot disturb where a deck's copies are, which is the property that replaced the
guard.** The survivor is on the grain the source was landing on, the folder is the eleventh term
of that grain, so both rows are in the same folder by construction: a fold inside a deck's group
leaves the copies in that group, and a fold at the root cannot pull anything out of one. The old
statements existed to keep a *pointer* valid; there is no pointer now, only a placement.

**What moves in the entry fold**: the quantities and the tradelist quantities add, and the five
columns the reader typed themselves — what they paid, in what currency, when, where from, and
their note — are taken by the survivor **only where it has none**. That is `add_entry`'s
`ON CONFLICT` direction verbatim: the destination is the row the reader filed and annotated, and
inverting either `coalesce` would replace a note they wrote about the row they are keeping with
one about a row that no longer exists. `tags` and `condition_original` are deliberately absent,
exactly as they are from `add_entry`'s `DO UPDATE` — merging two curated sets is not something one
statement should decide, and `condition_original` is the provenance of *this* row's condition and
cannot describe a condition it was never written beside.

## The deck groups, `Recently removed`, and what v25 converted

Two kinds of folder belong to the app rather than to the reader, and v25 is the rung that creates
them:

- **one `deck` folder per deck**, named after it and pointed at it by `collection_folders.deck_id`
  — the group. `idx_collection_folder_deck` is unique on that column, so a deck has at most one.
  **Archived decks get one too**: archiving is a flag and not a delete, an archived deck still
  holds its cards, and leaving it out of the conversion would have lost exactly the copies nobody
  is looking at.
- **one `removed` folder for the whole database**, `Recently removed` — where copies go when they
  leave the collection's shelves without leaving the database. `idx_collection_folder_removed` is
  unique on `kind` where `kind = 'removed'`, so the single `INSERT` that makes it is also the
  proof that there is one.

`create_deck` makes a group for every deck since, so "every deck has a group" is a property of
both the rung and the command rather than of the rung alone.

### The conversion is what stops the release feeling like a regression

The rung had one job that could not be got wrong: **every former claim becomes a placement.** A
reader who upgrades and finds their decks empty has lost years of filing to a release note, and
there is no second copy of `deck_allocations` anywhere to recover it from. Four decisions in that
loop are each load-bearing.

**It runs in Rust, not in SQL, because it splits rows.** One statement cannot both create the
placement in the group and reduce the row the copies came out of, and the clamp below is not
expressible over a table that same statement is writing to.

**`min(claim, row)`, and the clamp is not optional.** The old ledger could out-claim a row that was
later stepped down — nothing refused it, because `deck::owned_by_oracle` applied
`min(a.quantity, e.quantity)` at *read* time and the stored overclaim never showed on screen.
Reading the claim literally here would invent copies the reader does not own, permanently, with
nothing left to compare against afterwards. The source can also be **gone** by the time its claim
comes up, because an earlier claim on the same row may have taken every copy and a row holding
nothing is deleted rather than left at zero (v24's rule) — that is a normal outcome and is read
through `.optional()`, not an unwrap.

**Ascending by `id`, which is first-claim-first-served.** The order only matters where two decks
claimed the same row and the copies do not stretch to both — and that state was reachable, because
a claim was a *reservation* and could overlap while a placement is **custody** and cannot. One of
the two decks has to lose, and the older claim is the one with the better story.

**The placement carries every provenance column**, not just the grain: condition and
`condition_original`, purchase price and currency, acquired-at, acquisition source, serial number,
grading, tags, notes, `needs_review`, `tradelist_quantity` and the original `created_at`. The
copies in the deck are the same physical cards — bought on the same day, for the same money, in
the same condition, with the same note on the sleeve — so a bare row here would be the upgrade
quietly deleting a history that took years to accumulate. `ON CONFLICT` on the eleven-term grain
rather than a plain insert, because two claims on one entry from **one** deck are one placement
(two decks are two placements, which the folder term keeps apart).

**Order is the whole of the step's correctness: insert the folders, convert, then drop.** Dropping
the ledger before reading it destroys the very thing being converted. `DROP TABLE deck_allocations`
takes `idx_deck_allocations_grain` and `idx_deck_allocations_entry` with it, which is why neither
is named. `ALTER TABLE decks DROP COLUMN is_built` is a drop rather than a keep because a kept
column nothing writes is a column somebody reads by accident — and SQLite refuses `DROP COLUMN` on
an indexed column, so it was checked (2026-08-23) that nothing indexes `is_built`, a failure that
would otherwise have landed at a real reader's first upgrade and in no test starting from a fresh
database. The `app_meta` row `deck_driven_collection` goes in the same statement: that switch asked
whether the decks *are* the collection, which this rung answers yes to permanently, so a key
nothing writes any more would have sat in that table forever.

### The two writes, and why a deck group is not a drop target

`collection_alloc.rs` holds the only pair in the crate that moves a row across the deck boundary:

```text
         collection_to_deck                 deck_to_collection
binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
```

**A card reaches a deck's group only through `collection_to_deck`, which also writes the
`deck_cards` row.** That is why `set_entry_folder` refuses a `deck` destination and the page offers
no ring on a deck group: a bare drag would file copies into the group and leave the deck's list
saying nothing about them — a placement with no deck card behind it, which reads to the reader as
cards that vanished into a deck that does not play them. The refusal is the command's, not
`refile_entry`'s; the write underneath carries no kind fence at all, which is exactly what lets
these two file into the two folders a reader may not point at.

**Taking a copy out of another deck's group decrements that deck's live list too.** The copies are
custody rather than a reservation, so a deck that loses them loses the card. `MoveOutcome.fromDeck`
carries the name because that side effect lands on a deck the reader is not looking at, and the UI
says so before the press. Rows are taken from the other deck's list oldest first and there may be
several — one printing can sit in two categories of one deck — and the take is **clamped at what
is there rather than refused**, because the group and the list can legitimately disagree (an import
writes a list without moving copies) and refusing would leave the copies half moved over a
disagreement this write did not cause.

**A deck card with no backing copies just goes away when it is cut, and that is the answer
[issue #209](https://github.com/Msgaihede/mtg-grimoire/issues/209) could not find.** That issue
asked whether a deck card needs a per-card provenance flag — *did this copy come out of the
collection, or was it typed in from a search?* — and could not answer it, because nothing in the
old model recorded the difference. The group **is** the record: a card added from search is an
intention to buy, the reader never owned it, there is nothing in any folder behind it, and cutting
it therefore puts nothing on their desk. No flag, no column, no migration — the question stopped
being askable when placement replaced claim.

**A theory row is refused outright.** A theory list is a plan and a plan holds no cards, so there
is nothing in any folder to give back; the alternative is a press that reports success and moves
nothing, which reads as a card that vanished. The same fact one level up is why
`attribute_owned` zeroes every `theory` row rather than serving it last.

Each refusal is a sentence rather than a constraint failure, `deck::set_folder`'s rule — a `CHECK`
or a foreign key names the table and not the mistake, and `PRAGMA foreign_keys` is per-connection
anyway:

| Constant | Sentence |
| --- | --- |
| `THEORY_HOLDS_NOTHING` | A theory list is a plan, and a plan holds no cards. |
| `NOT_THAT_MANY` | There are not that many copies to move. |
| `ZERO_MOVE` | Moving copies needs a quantity of at least one. |
| `ALREADY_HERE` | Those copies are already in this deck. |
| `DECK_CARD_GONE` | That card is not in this deck any more. |
| `NO_DECK_GROUP` | That deck has no folder to hold its cards. |
| `NO_REMOVED_FOLDER` | There is no Recently removed folder to file these into. |

The last two describe a hand-edited database — every deck gets a group and every database gets one
`Recently removed` — and `NO_DECK_GROUP` is deliberately only on the way **in**: cutting a card
from a deck whose group is missing is a deck with no backing copies, which the rule above already
answers, and a reader must always be able to cut a card. Four more sentences are borrowed rather
than re-spelled — `collection::GONE`, `deck::GONE` (through `touch_deck`, which doubles as the
deck fence), `deck_meta::CATEGORY_GONE` and `deck_meta::CATEGORY_WRONG_DECK`.

**The split is forward and the source row is the half that travels.** `collection_folders::
take_copies` steps the source down to exactly the copies that are moving, `refile_entry` files
*that* row into the destination (folding it into whatever already holds the grain there), and the
remainder is then re-inserted into the folder the source has just left. That order is forced by the
grain: a remainder written *before* the move would collide with the source itself, which is the one
row in that folder holding that grain. `tradelist_quantity` is **split rather than duplicated** —
the moving copies take `min(tradelist, quantity)` and the remainder keeps the rest — because
duplicating it would put a card on the trade list twice by moving it.

**There is one of it, and there were two.** `collection_alloc` wrote this split first, for the deck
boundary's two commands, as a private `move_copies`; the category writes then needed the same rule
and could not reach a private item, so it was spelled a second time in `collection_folders`. Two
implementations of one rule disagree the first time either changes, and this rule moves the
reader's cards — so the twin was deleted at fan-in and both commands call `take_copies`, which sits
beside the merge it is built on and the fence-free refile it extends.

### The history a cut writes, and the undo it deliberately does not

Cutting a card from the **live** list used to go through `deck_set_card_quantity`, which wrote a
`deck_audit` row and a `deck_undo` step like every other deck write. Routing the press through
`deck_to_collection` took both away, and the two halves of that are not equally negotiable.

**The history row is not optional, and it is the old one verbatim.** A command that replaces
another must write what that one wrote, or a deck's log skips exactly the press a reader goes
looking for. So a whole row cut records `remove` with `{ category, quantity, reason: null }`, part
of one records `quantity` with `{ category, from, to }`, `delta` is negative in both, and the card
carries its stored name so the line still reads once the printing has left `cards`. `auditText.ts`
needs no new arm and a deck's history reads continuously across a change of command the reader
cannot see. **It is recorded even when nothing moved** — a deck card nobody owned still left the
deck, and the history is a record of the *deck*.

**The undo step is deliberately absent, and this is the decision on the page.** A cut changes two
rows in two tables: the `deck_cards` row, and a `collection_entries` row now sitting in `Recently
removed`. `deck_undo` can express the first and only the first — a step names cells of `deck_cards`
and *restores rows*, never running a command backwards, and its four primitives touch no collection
table at all. Three things follow:

- **The half-step is the state that must not ship.** Filing an `Op::Cards` beside the audit row
  would put the list back and leave the copies where they went, so a deck would claim four copies
  its own group no longer holds while the reader — who pressed Ctrl+Z and watched the row reappear
  — believed the cut was reversed. That is worse than no undo, because the wrong number is one the
  reader has been given a reason to trust.
- **The other half cannot be taught to the journal.** `take_copies` files the copies through the
  merge, so the source row may have been *folded into* whatever `Recently removed` already held and
  no longer exists to restore; putting them back is a quantity moved between two folders, which is
  a command run backwards, and it can fail for reasons that are nobody's bug (the reader filed them
  in a binder, or sold them) while `MISSING_ROW` is the module's one failure and is documented as a
  bug at a call site.
- **The absence is visible, and the way back is better than Ctrl+Z.** The Undo button's name *is*
  the change it would reverse — "Undo — Removed 2 × Lightning Bolt", read from `next_undo` — so a
  cut that files no step leaves the button naming the press *before* it and never offers one it
  cannot deliver. The copies are in `Recently removed`, and the standing sentence at the foot of the
  deck (`CUT_CARDS_NOTE`) says so.

  **Say the consequence plainly, because the button's name is only visible to somebody reading
  it: a cut does not advance the undo cursor, so the previous step remains the one Ctrl+Z will
  take.** Cut a card and press Ctrl+Z and the *older* change is reversed — the rename, the add,
  the pile move before it — not the cut, and not nothing. The label is honest about that the whole
  time; a keyboard user who never looks at it is the one this sentence is for. It is not a
  keystroke that fails, it is a keystroke that succeeds at something else.

  **The cost, stated plainly, and it got smaller on 2026-08-23.** A cut still cannot be reversed
  from the keyboard. What changed is that `collection_to_deck` — the write that restores **both**
  halves in one press — now has a caller: the deck builder's **Collection Search** tab. A deck
  group is still deliberately not a drop target (see
  [the fence](#a-deck-group-is-not-a-drop-target)), so the recovery is not a drag; it is a press.
  **What it costs now**, spelled out because "one press" is only true if you know where the press
  is: open the search column on the deck you cut from, stay on the Collection tab, clear the
  **only unallocated** default or leave it — `Recently removed` is on the *unallocated* side, so
  the cut copies are in the default list — find the row and press **Add**. That is one press over
  a list the reader is already looking at, against the two it used to be (add the card again from
  the card search, then re-file its copies out of `Recently removed` by hand). It is still not
  Ctrl+Z, and the reason it is not is above. **The card is never lost** — that is the whole of
  what the holding area guarantees.

`a_cut_is_not_offered_to_undo_and_files_no_step` is what holds this — it drives a stepper press,
then a cut, and asserts the cursor has not moved. Adding the half-step turns it red.

**`collection_to_deck` writes its own history row as of 2026-08-23, and files no step, for the
same two reasons.** The row was deferred while nothing called the command: a hole nothing could
reach is not a hole a reader can fall into. The Collection Search tab is what reaches it, so the
deferral expired with it. The row is `deck::add_card`'s **verbatim** — kind `add`, payload
`{ category, quantity }`, `delta` positive, the card's stored name — because filing a card into a
deck from the collection *is* an add and a reader cannot see which command ran; `auditText.ts`
needs no new arm and the deck's history reads continuously across the two. `quantity` is the
copies that **moved**, never the total the `ON CONFLICT` arm landed the row on.

The undo step stays absent, and here the asymmetry genuinely does not bite: a reader who files the
wrong card cuts it, which is one press and fully recorded. Both directions are therefore on the
fake's `NO_UNDO_STEP` too, so a story cannot quietly grow a step the crate does not write.

**Both commands are in `deck_audit`'s crate-wide sweep as of 2026-08-23**
(`every_deck_write_leaves_exactly_one_audit_row`, 28 cases). They were not for two PRs, which is
the whole cautionary tale: the sweep exists to catch "a new deck write records nothing", these two
*are* deck writes, and their rows were held only by `collection_alloc`'s own tests — so the sweep
that is supposed to be structural would have gone green through their removal. The cross-deck case
is the second in that list to owe **two** rows, and the only one whose rows land in two different
decks' histories.

### Collection Search, and the first caller `collection_to_deck` ever had

**Shipped 2026-08-23, spec §7.2.** The deck builder's docked search column has two tabs —
`Collection` and `All cards` — and **it opens on `Collection`**. That default is the whole product
decision: a deck is built out of cards you have, so a search of everything Scryfall has published
is the thing one press away rather than the thing in front of you. Until this landed there was no
way to search a collection from a deck at all, and `collection_to_deck` had been registered,
tested and reachable from nothing for a whole release. **This is what calls it.**

**The list's grain is the collection's, not the card search's** — one row per printing, finish and
condition, each saying where that copy is filed — because the press is about a *copy* and not
about a card. The root is drawn as the word `Collection` rather than a blank cell: an empty
"where is this" reads as data that failed to arrive, where the root is the ordinary place for a
copy to be.

**`CollectionQuery.allocation` gets its first sender here, and the default is `unallocated`.** The
field has existed since v25 and every caller written before folders gets `All` by omission. The
tab sends the other word, so what a reader who has pressed nothing sees is the copies **no deck is
holding** — the root, a binder they made, and `Recently removed`, all three being cards on the
desk. That is what makes the list answer "what can I build with today" rather than "what do I
own". `All cards` on the toggle beside it widens it to every row.

**Where a copy is filed decides which of three presses the Add button makes**, and this is the
piece to get right:

| Where the copy sits | What Add does |
| --- | --- |
| The root, a binder, `Recently removed` | Moves silently. One press. |
| This deck's own group | Cannot move — `ALREADY_HERE` refuses it in words. |
| **Another deck's group** | **Confirms first, naming that deck.** |

The third row is the one that needs a sentence: the side effect lands on a deck the reader is not
looking at. Taking the copies decrements that deck's live list as well as emptying its group,
because copies are custody rather than a reservation and a deck that loses them loses the card.
`MoveOutcome.fromDeck` carries the name **after** the fact as well as before it, so the
confirmation and the result say the same thing. Note that this app's confirmations carry no
`dialog` or `alertdialog` role — a test or a CDP pass finds this one by its text.

**Which pile a press files into is decided before the press and named on the button**, which is
the promise the card-search tab's Add already makes. A named default category is used as it
stands; `AUTO_CATEGORY` goes through `autoCategoryFor` over the row's type line — the documented
floor for a database whose oracle tags have never been downloaded. **Where that rule names a pile
the deck has not got, it falls back to the deck's main pile rather than creating one**, and what
keeps that honest is that the button names the pile before the press. It used to be forced as
well: `collection_to_deck` took a category **id** and there was no id to send for a pile that did
not exist yet. **That is no longer true** — the command takes a `collection_alloc::Pile`, an id
**or** a name, since 2026-08-23, and the name arm resolves through `category_for_name` inside the
move's own transaction exactly as `deck_add_card` does. The tab still sends an id, because a tab
whose Add button names its destination has one in hand; the arm exists for the `All cards` tab's
owned add, which files by what a card *does* and so can name a pile the deck has never had. A
call carrying both is refused in words (`BOTH_PILES`) rather than silently preferring one.

**A move is one deliberate press, so nothing here is optimistic.** `src/lib/query.ts` caches 30 s,
which means a mounted query merely *marked* stale never refetches — the collection list, the
folder summary and the deck are each invalidated, not just their roots. PR 2 of this series
shipped a ghost row by getting exactly that wrong.

**The `All cards` tab grew an own/need toggle at the same time and it was deleted on 2026-08-25**
(`NormalSearchAdd.ts`, gone with it). Its default was `need` — a `deck_cards` row and nothing else,
which reads as missing — and `own` moved a **free** copy the reader already had into the deck's
group, or recorded a new one there when there was none, choosing by the deleted allocator's own
preference order: exact printing, then another printing of the same oracle card, real copies before
proxies, then entry id.

**What retired it is the tab above rather than a change of mind about the write.** `own` was
`collection_to_deck` reached silently: it chose a copy out of rows the reader was not looking at,
and where it found none it filed a *new* collection row for a card they had only searched for. The
Collection tab reaches the same command with the copy on screen and the donor deck named in the
question — so the feature is the tab, and a second, quieter entrance to it was a liability rather
than a shortcut. Every add from the deck editor now writes a list row and claims nothing about the
reader's cardboard.

**The import's "Add cards to collection" box is the third surface and it does _not_ file into the
group** — see [import-export.md](import-export.md#the-deck-arms-add-cards-to-collection-box), where
the missing argument is written down beside the formats.

### Deleting a deck sends its cards to `Recently removed`

A `deck_cards` row is an intention and dies with the deck. A row in the deck's **group** is a card
the reader physically owns, so `delete_deck` re-files it into `Recently removed` **by hand, one at
a time, and before the `DELETE`** — `delete_folder`'s rule borrowed rather than re-argued. Left to
the DDL, `collection_folders.deck_id`'s CASCADE takes the group and
`collection_entries.folder_id`'s SET NULL scatters the cards to the root, which is both the wrong
destination and a rewrite of the grain's eleventh term with nothing saying what it will land on.

It goes through `refile_entry` rather than `set_entry_folder` for the reason above: the command
refuses a `removed` destination, and is right to. This is the app saying it, not a reader
asserting it.

**The reachable collision is a printing already sitting in `Recently removed`** — which is every
second deck delete of a card the reader plays in two decks — and one at a time is what makes the
second arrival *merge* into the first instead of raising `UNIQUE constraint failed: index
'idx_collection_grain'`. **Two of the deck's own rows cannot collide with each other**, and an
earlier draft of this page said they could: two rows in one folder already differ in one of the
grain's first ten terms, or they would be one row. The sub-tree walk is still a `WITH RECURSIVE`
rather than a single-folder read, because the DDL permits a folder nested under a group even though
`create_folder` and `move_folder` both refuse to make one — the day a command permits it, the
alternative is not a wrong number but a sub-tree's worth of cards scattered to the root.

### Deleting a category, emptying a list, or importing over one sends its cards there too

**The same act in bulk, and there are four of them.** `deck_meta::delete_category` (in its cascade
arm), `deck::clear_category`, `deck::clear_variant` and `import::commit_import`'s `replace` arm each
take a whole set of `deck_cards` rows out at once, and every `live` row in that set may have copies
sitting in the deck's group behind it. Left where they were, those copies would stay filed under a
deck that has never heard of them — invisible on the collection page under a folder for a pile
that is gone, and unavailable to every other deck for ever. That is the feature's central invariant
broken quietly: **a copy in a deck's group is backed by a deck card in that deck.**

So all four release the copies first, in the caller's own transaction and before anything is
deleted, through **`deck::release_live_copies`** — one loop over `deck::release_group_copies` that
reads the doomed rows `ORDER BY id` before the `DELETE` that dooms them, taking `category_id` as an
`Option`: `Some(id)` is one pile and `None` the whole variant. **The helper is where the `live`
question is asked**, rather than at each of the four call sites, and it exists because it was not:
the import's `replace` arm ran `clear_variant`'s exact `DELETE` with no release beside it until
2026-09-01 (issue #336), so the same delete left a reader's copies in two different places depending
on which press made it. **`release_group_copies` under it is still the crate's one copy of the
walk and `deck_to_collection` calls it too** — the single-card cut spelled the same backing query
and the same greedy loop inline until this round, and what the cut has that this does not is only
the `deck_cards` write, the history row and the `MoveOutcome` it answers. Four rules the one copy
holds: the deck's group is looked up and an absent one means "holds nothing" rather than a
refusal; rows are taken **oldest first**; the take is **clamped** at what the group actually
holds, because a list and a group can legitimately disagree; and `Recently removed` is resolved
only when there is something to file, so a hand-edited database still lets a pile be cleared.

**It matches on the oracle card, not on the printing, and that was a stranding bug while the walk
existed twice.** `deck_swap_printing` and `deck_set_card_finish` rewrite a `deck_cards` row's
identity and touch no collection table, so after "Use this printing" the group goes on holding the
*old* printing's row. Matched exactly, the release then found nothing: the deck card went away and
the copies stayed filed under a deck that no longer listed them. Upgraded readers meet it without
pressing anything, because the allocator v25 replaced matched candidates by oracle id and the
conversion faithfully files a printing the deck does not list. The arms are the exact printing and
finish **first**, then any other row in the group holding the same `cards.oracle_id` — which is
`owned_by_oracle`'s "a Bolt is a Bolt" read from the other end, since a deck that *counts* an
Alpha Bolt toward an M10 line has to be able to give that copy back. The ordering is what keeps
every cut of a card nobody ever swapped exactly what it was. The join to `cards` is a `LEFT JOIN`
so a row whose printing has left the corpus is still releasable by the exact arm, and a deck card
that is itself an orphan degrades to exactly that arm.

Three scopes are decisions rather than details:

- **`live` only.** A theory row is a plan and no folder backs one — `THEORY_HOLDS_NOTHING` is a
  refusal one card at a time and simply an empty loop here. **Since 2026-09-01 none of the four
  asks that question itself**: `release_live_copies` takes the variant and does nothing unless it
  is `live`, so the fence cannot be dropped by a fifth site the way the release itself was dropped
  by the fourth.
- **`delete_category`'s move arm releases nothing.** Those cards are still in this deck, one pile
  over, so the group is still exactly where their copies belong. It is fenced on
  `move_to_category_id.is_none()` and the release runs *before* the move's own `DELETE`, rather
  than leaning on that `DELETE` having emptied the pile already — an ordering an edit three
  statements away can undo without meaning to.
- **The count each confirmation quotes is `deck_cards`, never the copies that moved.** The two
  differ wherever the group holds fewer copies than the list claims, and what the dialog warns
  about is what leaves the deck.

**Undo restores the list and not the custody**, which is worth knowing rather than rediscovering:
`deck_undo` puts the `deck_cards` cells back, while the copies stay in `Recently removed`. An
undone delete therefore reads with its owned counts at zero until the reader files them again.
Teaching the journal about collection rows would be a change to what a step *is* — the argument in
full is under "The history a cut writes, and the undo it deliberately does not" above.

**All four of these do file a step where `deck_to_collection` does not**, and the difference is what
the `deck_cards` half is worth on its own. A cleared or deleted pile — or a list an import has
replaced — is many rows in an order and a filing nothing else records, so the step is the only way
back to it; one cut card is a single stepper press away from being put back by hand, and the
copies are one drag from being back where they were. Neither restores custody, so both leave the
same honest, representable state: a deck that wants cards it does not currently hold.

The split itself is `collection_folders::take_copies`, which is where a partial row move lives:
`refile_entry` moves a row **whole**, and a pile that claims 3 of the 4 copies the group holds for
a grain needs the source stepped down, refiled, and the remainder re-inserted behind it. It is the
crate's one copy of that rule — `collection_alloc` carried a private twin until fan-in, and the
note under "The two writes" says what happened to it.

## `delete_folder` re-files one row at a time

`collection_entries.folder_id` is SET NULL, and for one press that looks like the whole answer:
one `DELETE`, every card in the sub-tree back at the root. **It is not, because that cascade
rewrites a grain term** — and a write that changes an entry's grain has to say what it will land
on. Every other write in the crate does. Left to `idx_collection_grain`, the delete reaches the
reader as `UNIQUE constraint failed`, with the folder still standing and nothing moved, in two
shapes:

- a card in the sub-tree and an **unfiled** row for the same printing at the same grain — the state
  every writer that cannot name a folder produces: a quick add from the search, an import, the
  reconciler's fold;
- **two sub-tree rows colliding with each other**, needing no root row at all. `Binder/A` and
  `Binder/B` each holding the same printing land on one grain the moment both reach the root.

So the sub-tree's entries are collected and re-filed **one at a time** through `refile_entry`, with
`set_entry_folder`'s merge rule rather than a second copy of it, inside the transaction and
**before** the folder row goes. By the time the `DELETE` runs, every card beneath it is already at
the root, so the `SET NULL` has nothing left to rewrite and nothing left to collide on.

**One at a time is what answers the second shape**, and it is the reason this is a loop rather than
one statement: the first row to reach the root becomes the row the next one merges into. A batch
update would present both to the index at once.

**The second shape is this command's own and does not carry over to a deck's group.** It needs two
*sub-folders*, and a user folder can have them; a deck group cannot, because `create_folder` and
`move_folder` both refuse a parent the app owns. Two rows filed directly in one folder already
differ in one of the grain's first ten terms, or they would be one row — so on the deck-delete path
the collision that is actually reachable is a printing **already waiting in `Recently removed`**.
Same loop, different reason, and
[the deck groups](#deleting-a-deck-sends-its-cards-to-recently-removed) is where that one is
written down.

Three smaller decisions inside it:

- The doomed sub-tree is walked **in SQLite**, by a `WITH RECURSIVE`, because the cascade this
  stands in front of is itself recursive and the two must agree about which folders are doomed —
  **including any the app owns**. Nothing filters on `kind`, because the CASCADE does not, and a
  walk that did would leave those folders' cards to `SET NULL` and the very collision this
  function exists to answer.
- `UNION` and never `UNION ALL`. A `parent_id` cycle that arrived some other way — a hand-edited
  database, a restored backup — makes the duplicate-row check converge where `UNION ALL` would
  loop.
- `ORDER BY e.id`, so the row a merge folds into is decided by the table and not by the planner.

`parent_id`'s CASCADE onto its own table is still the DDL's work and still one statement — a folder
inside a deleted folder has nowhere else to be, and no grain is involved. **It therefore still
depends on `PRAGMA foreign_keys` being ON**, which is per-connection; `db::open` sets it for every
connection the app hands out, and a test that opens its own has to say so itself.

An id that resolves to nothing is a **success**, `deck_meta::delete_folder`'s rule: the caller
wanted that folder gone, and it is gone. The one id that is not is a folder the app owns.

## Zero quantity deletes the row, and what that costs

**This reverses a documented decision, and the reversal is recorded here rather than lost.** A
collection row taken to zero is now removed: `set_quantity(id, 0)` deletes and answers
`EntryChange { removed: true }`, the v24 rung deletes every stored zero row, and the importer's
`set` mode does the same. The reason is the folder: with `folder_id` in the grain, a row holding no
copies is indistinguishable from a row somebody filed and emptied, and "the reader owns none of
these" is not a filing decision worth keeping a slot for.

**The cost is real and was accepted deliberately.** The row's `condition`, `condition_original`,
purchase price and currency, acquired-at, acquisition source, notes and tags **go with it** — which
is precisely what the previous behaviour was preserving. The rule it replaces said so in as many
words: taking a stepper to zero was "the reader saying *I have none of these today*, not *forget
everything I recorded about them*", and the story of a card that took years to accumulate survived
the day it was traded away. It no longer does. Removal used to be `remove_entry` and only ever
`remove_entry`; it is now either.

`CHECK (quantity >= 0)` stays on the column. The guard is the command, and an intermediate zero
inside a transaction is still legal.

Two things simplify with it, and both were previously ways for the app to disagree with itself:
`summarise`'s split between `total_cards` (which sums quantity) and `unique_cards`/`entries` (which
count rows) stops being able to diverge, and the search facet's `owned` dimension — with
`collection_source::owns_printing`'s `EXISTS` — stops reading a zero row as owned.

The wishlist has been the opposite since it shipped, by table CHECK (`quantity > 0`): a wish for
none of something is not a wish. The two tables now agree, where they used to be a deliberate
asymmetry.

**The two _controls_ agree as of 2026-09-01 as well**, which they did not on the day the tables
did. The wishlist's steppers floored at `1` and removal was a separate press, on the argument that
a held Decrease would be a one-way door with no undo; the collection's floored at `0` and zero was
the only removal its table offered. That asymmetry is gone with [issue #284](https://github.com/Msgaihede/mtg-grimoire/issues/284)
— every stepper over either list now floors at `0`, and zero deletes on both. What the wishlist
keeps that the collection never had is the named route beside it: `Remove from wishlist` is still a
button in the wish's own panel, because a destructive act a keyboard reader can find without
holding a button down is worth the second control. [wishlist-folders.md](wishlist-folders.md)
carries that half.

## The copies control belongs to a normal folder, in both views

**2026-09-01, [issue #284](https://github.com/Msgaihede/mtg-grimoire/issues/284).** The collection's
**wall** grew a stepper, which it had never had — the table was the only place a copy count could be
changed since the page shipped, and a reader in the view that opens by default had to switch views
to fix a miscount. What came with it is a fence neither view had: **a stepper is drawn only where
every copy behind it is at the root or in a folder the reader made.** A deck's group and `Recently
removed` draw the number as plain text and say why.

**The fence is the app's and not the crate's, and that asymmetry is deliberate.**
`collection::set_quantity` takes an entry id and asks nothing about where the row is filed; it will
step a row in a deck's group as readily as one at the root, and the section above is why that
remains correct at the command layer — a deck's count is a `sum()` over its own group at read time,
so the number is never *wrong*, only surprising. What the fence buys is that the surprise is not one
press away. Stepping a copy out of a deck's group from the collection page is the reader changing
what a deck holds from a screen that does not mention the deck, and
`collection_folders::set_entry_folder` already refuses the *move* for exactly that reason
(`ENTRY_IN_A_DECK`). This is that boundary drawn one write over. Putting it in the command instead
was considered and rejected: `set_quantity` is what the importer's `set` mode, the reconciler's fold
and `take_copies`' split all go through, and every one of them has a legitimate reason to write a
number onto a row in a group.

**The predicate is positive, never a blocklist.** `folderId === null || userFolderIds.has(folderId)`
rather than "not a deck group and not `Recently removed`" — so a fourth `collection_folders.kind`
added later defaults to *fenced* rather than to editable. It is the shape the page's
`canMakeFolder` already had for the `New folder` card, and the two now read as one rule about what
a folder the reader made is allowed to do.

**On the wall it is every copy behind the art, not any.** A tile is a printing in one finish, and
folder is one of the terms that merges into it — so while Flatten is on, which is the default, one
tile can carry copies from a binder and from a deck's group at once. The stepper's number is the
tile's *sum*, so a tile that mixed them would move a total that is partly untouchable. `canFile`
asks the same question of the same rows and answers `any`, which is not an inconsistency: a drag
moves copies the reader has picked out of a list, and this moves a number they have not.

**No page-level branch was needed for "standing inside a deck group", and that is worth knowing
rather than rediscovering.** Not flattened, the query is scoped to `folderId`, so every row on the
wall is in that folder and the per-tile rule fences every tile of its own accord. The per-tile rule
is the one that does all the work, because Flatten starts `true`.

**In the table the fence is a prop rather than a lookup**, `quantityBlocked?: (row) => string | null`
— the *sentence*, not a boolean, because a control that vanishes without saying why is worse than
one that refuses in words. The page supplies it from the same predicate the wall uses, one helper
feeding both, so the two drawings of one list cannot drift into two answers about what may be
edited. It is optional, so a story or a read-only mount draws what it always drew. The sentences are
the grammar of `blockedReason`, which is what `PickCopies` greys a row with — one voice for "not
here, and here is what to do instead":

| Where the row is | What the table says |
| --- | --- |
| a deck's group | `In <deck>. Cut the card from the deck to change how many you hold.` |
| `Recently removed` | `In Recently removed. Move it back to your collection to change how many you hold.` |
| anything else fenced | `In <folder>. Move it into one of your own folders to change how many you hold.` |

**The third arm names no mechanism, and that is the fence's positive spelling showing through.**
It is reached only by a fourth `kind` — and a fourth kind wearing the deck sentence would tell the
reader to cut a card from a deck that does not exist. It is also, for the length of one query, what
a row in the reader's own binder gets: `useCollectionFolderList` starts empty, and "empty" is a
cabinet nobody has filed as well as one that has not loaded, so until the census answers every
*filed* row is outside the predicate. That was chosen over the other direction deliberately — a
briefly wrong sentence corrects itself, and a stepper standing live over a deck's copies for the
same window writes a number that does not. The root needs no census, which is most of a wall.

The blocked number carries that sentence as `sr-only` text beside it rather than only as the
tooltip's `aria-describedby`: the panel opens on pointer-enter or on the **anchor** taking focus, a
`<span>` takes no focus, and the row's tab stop is the row — so the tooltip alone would have been
pointer-only. `describes: false` then keeps an open panel from describing a sentence the
accessibility tree already holds, which is the `<abbr>` cell's argument one column over.

## `folder_summary` answers direct counts, and no row at all for an empty folder

`collection_folder_summary(marketplace)` returns `{ folderId, cards, value }` per folder, and three
things about its shape are load-bearing.

**The counts are direct — this folder's own copies, never its sub-folders'.** The tree sums the
children on the TypeScript side, in `buildFolderTree`, which already does that arithmetic for the
deck gallery and the wishlist. SQL that walked the tree here would be a second implementation of a
thing that is written and tested, and two implementations of one figure disagree the first time
either changes. The consequence a caller has to know: a folder holding two full sub-folders and
nothing of its own answers `0 cards` here, so a folder card is handed the recursive total and
never the raw row.

**A folder with nothing filed directly in it produces no row at all** — the query is
`WHERE folder_id IS NOT NULL … GROUP BY folder_id`, so an empty folder simply is not in the answer,
and the root, which is not a folder, has no tile to draw either. **The parenthetical that used to
close that sentence — "what is at the root is what the unfiltered table already shows" — stopped
being true on 2026-08-26** and is recorded here rather than quietly deleted, because it was the
reason nobody had asked for a root tile: the table at the root now shows the copies filed
*nowhere*, not every copy, so the root has a count of its own that no tile carries and no summary
row answers. See
[The root is the ungrouped cards](#the-root-is-the-ungrouped-cards-and-flatten-is-the-whole-binder). **A page therefore cannot build its folder tree from this
command.** `collection_folder_list` is the census — flat, every kind, `ORDER BY sort_order, id` —
and the summary is a lookup layered onto it. A card whose folder has no summary row falls back to
a zeroed total and draws `0 cards`, which is correct rather than an error state: an empty drawer is
where the next card goes.

**`cards` is copies and not rows** — `sum(quantity)`, which is `CollectionSummary::total_cards`'
arithmetic. **`value` is `None` rather than `0.0`** when the marketplace prices nothing in the
folder, which is where this parts company with the page header's `coalesce(…, 0.0)`: a tile is a
small number beside a name with no room for the header's "n unpriced" note, so a folder full of
cards the feed has never heard of would otherwise read as a folder worth nothing. `None` draws an
em dash, which is this app's answer for a price it does not have.

Every figure is `collection.rs`'s own arithmetic rather than a second spelling of it: the unit
price is `sorting::price_expr` over `collection::ENTRY_FINISH` — the *entry's* finish, which is why
the entries are aliased `e` and `cards` is aliased `c`, both part of that constant's contract. A
folder's subtotal and the page header's total are one piece of arithmetic and cannot disagree. The
join is `collection::from_sql`'s, and a `LEFT JOIN` for its reason: an entry whose printing has
left the corpus is exactly what the denormalised columns exist for, and an inner join would drop
those rows out of the tile that most needs them.

`folder_summary` names `collection_entries` in its own `FROM`, which `collection_source`'s module
doc lists as something only three statements in the crate do. It is now a fourth, for
`collection::from_sql`'s reason: it reads the entries as its rows rather than asking a question
about them.

## The way back up is a tile on the wall, and inside `Recently removed` it is the target that was missing

Issue #283 was reported against the wishlist and the cabinet here has exactly the same shape, so
the tile is one component drawn by all three walls —
`src/components/ParentFolderCard.tsx`, wrapped here by `CollectionParentFolderCard`, which holds
the copy target and the folder target. The whole argument is in
[wishlist-folders.md](wishlist-folders.md); what is worth writing down here is the two things this
cabinet has that the wishlist's does not.

**Inside `Recently removed` the tile is a destination the wall could not draw.** That level
substitutes the reader's own top level for its own children — the substitution #209 asked for, so a
reader standing in a pile of copies that just left a deck has their binders under the pointer
rather than only a row menu. Every one of those tiles files a copy *into* a binder; the one
destination missing was the **root**, which is where a copy that belongs in no binder goes, and it
was reachable only from the breadcrumb. The tile names it `Collection` — `ROOT_LABEL`, the
breadcrumb's own word — and files there.

**And it is the one page where the "already there" refusal is reachable.** In that same level every
folder card on the wall is a **root** folder, so its parent is already the destination the tile
names; without the clause each of them would raise a ring that shuffled it to the end of the level
it is in. `upPlacement` asks it, along with the three refusals `folderPlacement` already makes —
both ends a folder the reader made, no move into itself or into what it holds, and
`reorderedLevel`'s own no-op.

**Where it is not drawn: inside a deck group.** The wall's gate is unchanged
(`cabinet && (wall.length > 0 || canMakeFolder)`), and a deck group answers no to both — nothing
nests under it and `create_folder` refuses it as a parent — so no wall is drawn there and no tile
with it. That is the right answer rather than an omission: a copy may not be dragged **out** of a
deck group at all (`canMoveCopy`'s third clause, since the deck would go on listing a card whose
copies had walked off), so a lone tile in an otherwise empty band would be a ring that refuses
every card in the group — the invitation to a gesture that does nothing that `wall` declines to
make one paragraph up. The breadcrumb is still the way out of one, as it always was.

## The wall names its own folders, and the strip kept two of its four jobs

**2026-09-03.** The tile that makes a folder and the card that holds one both answer their naming
gesture **on themselves** now. `New folder` and a folder card's `⋯ → Rename…` used to raise a
bordered strip under the breadcrumb — a box with its own edge, an input, `Create folder` and
`Cancel` spelled out in words, and, on a create, a line reading *in Collection* to say which level
the strip was about — and every piece of that re-established a context the wall on screen already
carried. The name is typed on the line the folder's name will occupy instead, at the same track
and the same footprint, so nothing above the wall opens and nothing in the wall reflows.
`src/components/FolderNameField.tsx` is the shape, [frontend-design.md](frontend-design.md) is the
whole argument, and the wishlist's cabinet took the same change on the same day
([wishlist-folders.md](wishlist-folders.md)). Four things belong here, because they are facts
about this cabinet rather than about the field.

**The naming tile inherits `canMakeFolder`'s fence, so the app's own folders never grow one.** The
wall is drawn where `cabinet && (wall.length > 0 || canMakeFolder)`, and a deck group answers no
to both — nothing nests under it, and `create_folder` refuses it as a parent — so there is no wall
inside one and therefore nowhere for a field to open. `Recently removed` is the same. That is
§"The copies control"'s positive predicate reaching a third control: a fourth
`collection_folders.kind` added later gets **no** naming tile by default, rather than one whose
only outcome is `FOLDER_NOT_YOURS`.

**The pinned strip is untouched for the same reason it carries no `⋯`.** Its cards are the app's
own folders and every write in `collection_folders.rs` refuses them, so there was never a rename
on one to move — the argument is §"The app's own folders in the card menu"'s, unchanged.

**A rename keeps `folderFace`'s figures line, em dash included.** `12 cards · $340.00` stays under
the field, inside the same dashed edge with only its colour moved to `border-accent` — a folder
being renamed is still a container, so the dash stays and the create tile's **solid** edge is the
whole of what tells the two shapes apart. It keeps the `—` of a summary that has not answered yet
too, which is right for the reason the card draws it: "still counting" and "empty" are two
different answers, and a rename is not the moment to collapse them.

**The strip survives for `Move to folder…` and `Delete…`, and that residue is the rule rather
than a leftover.** The answer to "into which folder" is a list of the *other* folders, and the
answer to "delete this?" is the two-halved sentence §"What driving the shipped window found"
measured — *its cards move back to your collection; folders inside it are deleted*. Neither is a
name typed on a line, and neither has a tile of its own to be drawn on.

One consequence in the page itself: `openPanel` gained a level clause —
`flatten || (panel?.kind === "newFolder" && panel.parentId !== folderId) ? null : panel` — because
a create panel that outlives a walk into another folder used to be merely confusing about which
level it meant, and is now a layer with **no field on screen at all**, still swallowing the Escape
that should have walked the reader back out.

**The geometry is measured; the shipped window is not.** Headless Edge over the built stylesheet
on 2026-09-03 put all four states in one row and read **62px** and one `top` for every tile,
`y = 34` for the `⋯` and for both ✓ / ✕ pairs, and `border-style` computing `solid` on the two
create shapes against `dashed` on the two rename shapes — the method and the full table are in
[frontend-design.md](frontend-design.md). What no headless page can settle is where the caret is
after each way out of the field, and the app lock was held elsewhere all session, so this cabinet
has not been driven in the real app. The pass recorded below is a v24 one that predates the change
entirely — see the correction attached to its harness note.

## The refusals are sentences, not constraint failures

`deck::set_folder`'s reasoning, twice over: **a constraint failure names the table and not the
mistake**, and `PRAGMA foreign_keys` is a per-connection setting in any case. `collection_entries.
folder_id` and `collection_folders.parent_id` *are* real foreign keys between user tables, so a
write naming a folder that is gone does fail on its own — with `FOREIGN KEY constraint failed`, and
only while that pragma happens to be on.

| Refusal | Sentence | Where |
| --- | --- | --- |
| The folder is gone | `That folder is not there any more.` (`deck_meta::FOLDER_GONE`) | Every write that names a folder id |
| The move writes a loop | `A folder cannot be moved inside itself.` (`deck_meta::FOLDER_CYCLE`) | `move_folder` |
| The folder is the app's | `That folder is the app's own and is not yours to change.` (`FOLDER_NOT_YOURS`) | Every write, both ends |
| The card is in a deck | `Those copies are in a deck. Cut the card from the deck to get them back.` (`ENTRY_IN_A_DECK`) | `set_entry_folder`, on the row it was given |

The first two are borrowed from `deck_meta` rather than re-spelled — a reader who has met "That
folder is not there any more." in the deck gallery and on the wishlist must meet the same sentence
here, and `deck_meta::CATEGORY_WRONG_DECK`'s doc is the standing rule that a second copy of a
refusal is a second thing to drift.

**The last two are local, because they are a fact this cabinet has and the other two do not.**
`deck_folders` and `wishlist_folders` carry no `kind` column at all, so there is no sentence in
either module to reach for. And the schema could not say it anyway: the DDL CHECKs that a `deck`
folder names a deck and that the kind is one of three, but nothing in it says who may *edit* a row,
or whose copies a row is holding, and a CHECK that could would fire as
`CHECK constraint failed: collection_folders`.

Each property of that fence is a decision, and they read in pairs — the folder end, then the row
end:

- **It guards both ends of a move.** `move_folder` reads the *subject* first — a folder the app
  owns is refused whether or not the parent it was aimed at exists — and the destination second.
  That is the opposite order from `wishlist_folders::move_folder`, which checks the destination
  first and lets a missing subject fall out of `changed == 0`; that shape cannot answer
  `FOLDER_NOT_YOURS`, because it never reads the row.
- **Nothing may be filed *into* a `deck` or `removed` folder by hand.** `create_folder` refuses a
  parent that is one, and `set_entry_folder` refuses a destination that is one. Those two folders
  say something the *app* is responsible for — that a deck holds these copies, that these copies
  have left the collection — and a reader dragging a card into one would be asserting it without
  any of the writes that make it true. Since v25 that is not hypothetical: a card filed into a
  group by hand would be a placement with **no `deck_cards` row behind it**, which is a deck
  holding copies it does not play.
- **Nothing may be filed *out* of a `deck` folder by hand either**, and that end took longer to
  notice. `set_entry_folder` reads the row's *current* folder and refuses a `deck` one with
  `ENTRY_IN_A_DECK` — *"Those copies are in a deck. Cut the card from the deck to get them
  back."* — a sibling sentence rather than `FOLDER_NOT_YOURS`, because the reader is not changing
  anything about the folder: they are taking a card out of it, and a refusal that names the wrong
  noun is worse than a generic one. A copy walking out of a group leaves the deck listing a card
  whose copies are gone, which is the invariant the category cascade broke from the other side.
  The frontend's `canFile` already refused the drag; that made the *page* the only guard, and the
  command was one careless caller away from being the last one.
  **`removed` is deliberately not fenced as a source**: taking a cut card out of the holding area
  and filing it in a binder is what that folder is for.
- **`refile_entry` carries no such fence**, and the absence is deliberate: it is what lets
  `collection_alloc.rs`'s two writes, and `deck::delete_deck`, file into exactly those two folders.
  The fence belongs to the *command*, not to the write — and the distinction is **who is asking**,
  not which table is touched: `set_entry_folder` is the reader's own filing gesture, and a silent
  drag must not be a second, unrecorded route out of a deck. Neither `refile_entry` nor
  `deck_to_collection` may ever grow this fence; both would stop a card being cut at all.

The cycle walk climbs `parent_id` from the **proposed** parent and is bounded at
`MAX_FOLDER_DEPTH` (64). **The budget is not about depth.** This walk is what keeps the tree
acyclic, so it cannot assume it already is — a cycle that arrived some other way would send the
`candidate == id` arm past every folder in the loop forever, because none of them is the folder
being moved. It matters more here than in a page-level check: this runs inside `spawn_blocking`
**while holding the app-wide write lock**, so an unbounded climb would not hang one command, it
would deadlock every write in the app for the life of the process. Exceeding the budget is answered
as a cycle, which is the only thing a chain that long can be.

The cycle walk cannot stand in for either kind check, either: `optional()?.flatten()` folds "no
such folder" and "that folder is at the root" into one `None`, so the climb ends on the first hop
and an id nothing answers to would sail through.

## The root is the ungrouped cards, and Flatten is the whole binder

**Until 2026-08-26 this cabinet had a root that was also the whole binder**, and the two could not
be told apart by any press. `useCollection` sent no `folderId`, `CollectionQuery::folder_id` reads
an absent one as *every folder* (spec §8.4), and so the level a reader stood on at the top of the
tree listed every copy they owned — including the ones filed in drawers whose cards were drawn
directly underneath it. The folder wall said "these are drawers" and the list under it had already
emptied them onto the floor.

It now works the way [the wishlist's](wishlist-folders.md) does. **The root is the copies filed
nowhere, and `Flatten` is the control that puts every folder on screen at once**, captioning each
tile with the drawer its copies sit in. Since v25 every card in a deck lives in that deck's group,
so a reader with built decks sees a much smaller root than they used to — that is the cabinet
working, not a regression, and the header figures are taken over the same scope so they still
describe what is on screen rather than contradicting it.

### The wire was widened, not flipped, and that was the whole design

The obvious change is to make `folder_id: None` mean the root, which is `WishlistQuery`'s
convention and the better shape read cold. **It was not done, and the reason is the blast radius of
getting it wrong.** Four callers ask this query the wide question today by saying nothing:

| Caller | What an accidental narrowing would have cost |
| --- | --- |
| `mirror::read`'s `Source::WholeCollection` | The plain-text backup — the copy a reader falls back on when the app will not open — would hold the handful of cards nobody filed |
| `useExportScope`'s sweep | "Export everything, ignoring the filters" would export the root |
| The deck editor's Collection Search | The panel would stop offering any card already in a binder |
| The importer's preview | The fold would miss every existing copy that had been filed |

A flip makes *"nobody updated this caller"* the failure mode, and every one of those failures is
silent — a shorter list looks exactly like a shorter list. So the root arrived as a **third state**
instead:

| `folder_id` | `root_only` | Answers |
| --- | --- | --- |
| `Some(id)` | ignored | That folder's direct members |
| `None` | `true` | `e.folder_id IS NULL` — the root, and only the root |
| `None` | `false` (the default) | **Every folder there is** — unchanged, so an unasked question keeps today's answer |

`root_only` defaults `false`, so all four callers above kept their behaviour without being touched.
The arbitration is an exhaustive `match` on the pair rather than a chain of `if`s, so a fourth
state cannot be added without the compiler naming every site that has to decide about it.

**`root_only` is `WishlistQuery::flatten` read from the other end.** That field widens the root to
everything; this one narrows everything to the root. They are the same axis approached from the two
different defaults their surfaces were born with.

### The export's escape hatch needs no second field, and the reason changed

`everythingFilters` returns `{ marketplace }` and nothing else, so it strips `folderId` and
`rootOnly` together — landing on "every folder", which is exactly what *Export everything* means.
The wishlist cannot do this: stripping its `folderId` lands on the **root**, so its sweep has to
say `flatten: true` a second, explicit way.

The conclusion here ("stripping is sufficient") is the same one that stood before the root
narrowed, but **its reason is not**, and the difference is worth keeping: it used to hold because
there was only one field and absent meant wide. It holds now because *both* fields strip to their
wide default. A third folder field added later without that property would break the escape hatch
while this sentence still looked true.

### What the page draws, and what it puts away

`Flatten` is one flag, `cabinet`, and it governs three things at once — the breadcrumb, the
reader's own folder wall, and the pinned strip of deck groups and `Recently removed`. All three are
*filing*, and a list that is ignoring the filing should not be surrounded by controls for it. The
cards are all still there, each captioned with its drawer.

Two consequences that are easy to miss and are each pinned by a test:

- **The wall is drawn whenever the cabinet is, not when it holds folders.** Gated on the folder
  count, a reader with an empty cabinet had no way to make their first folder once `+ New folder`
  moved into the wall. It also means the wall is on screen *before* the folder list answers, so a
  `findByRole("list", { name: "Folders" })` resolves one card early.
- **The `Recently removed` refile sentence had to follow the wall.** `folderId` survives a press of
  Flatten by design, so `inRemoved` stayed true under a page drawing no folder cards at all, and
  the caption invited a drag onto targets that were not there.

## The page, and the drag payload's own key

The collection page is the wishlist's page ported, and the pieces it reuses are named in
[wishlist-folders.md](wishlist-folders.md) rather than re-argued: folder cards in the grid, a
breadcrumb whose **segments are also drop targets** (without them a drag could only ever push cards
deeper, never back out), `DROP_RING` on every eligible folder the moment a row leaves its tile and
`DROP_OVER` on the one under the pointer, and `DROP_MARK_ROOM` on the wall's scroller so a card
flush against the content edge does not lose the outer 2 px of its ring for the whole drag.

## The wall's grain is the printing **and** the finish

2026-08-26, out of
[2026-08-26-card-chin-and-exact-prices-design.md](../superpowers/specs/2026-08-26-card-chin-and-exact-prices-design.md).
The storage grain has had eleven terms since v24 and did not move; what moved is what a **tile**
is. A foil and a played nonfoil of one printing are two objects at two prices sharing only a set
and a number, so they are two tiles — and every other grain term still merges. Condition, language
and **folder** are all one object seen from more than one place, and the table beside the wall is
where a reader gets those apart.

**There are two folds of the collection into tiles, not one, and both split.** The collection page
folds rows in `CollectionPage`'s `tiles` memo; the deck editor's docked Collection tab folds the
same rows in `collectionTiles.ts`'s `foldCopies`. They were written apart and keyed the same way, so
splitting one alone would have made two drawings of one collection disagree about what a tile *is*.
Both key on `` `${cardId}:${finish}` `` now, through **one** `tileKeyOf`, in `src/lib/tileKey.ts`.
Each fold stamps a tile with it and each wall builds the ring composite back out of the pane's card
and finish with it, so the two ends of that ring cannot be two spellings of one string — both are
plain `string` and nothing in the type system relates them, which is why a missed spelling would be
a wall where pressing a tile rings nothing at all, silently and with nothing red. The `?? "nonfoil"`
that makes the two ends meet is spelled there once, for both walls.

**It was written out twice before that module existed, byte for byte, each copy carrying a doc
block arguing that the duplication is what must not happen.** `src/lib/` is where the survivor went
rather than either feature: an import between `features/collection` and `features/decks` would be a
dependency in the wrong direction for one of the pair whichever way it pointed.

**The key uses the raw `row.finish`, never the narrowed one.** `collection_entries.finish` is TEXT
with a CHECK rather than an enum the frontend knows, so a row spelling a word this build cannot name
keys as its own word and gets a tile of its own instead of being folded in with the plain copies it
is not. Such a tile cannot be rung — the wall's composite spells `nonfoil` for an unnameable finish
— which is strictly better than every tile of a printing being indistinguishable, and it affects
**0 live rows**. The value handed to `CollectionTile.finish` and to `openCardAsFinish` *is* narrowed
against `FINISHES`, so an unknown word marks the art with nothing rather than with a sheen no
stylesheet has.

**What it changes for the card menu — and it is not the bug the design doc claimed.**
`CollectionTile.finishes`, the JSON list `CardMenuTarget.finishes` takes, now holds **at most one
entry**: one where the stored word is a finish this build knows, the empty list where it is not.
`buildCardMenu` records a single-finish list without asking, so an add from a foil tile files a
**foil**. Before the split the same helper answered a *two*-element list for a printing held in both
finishes and the menu opened a submenu — which was the honest thing to say about a tile that merged
two objects, not a wrong answer. **The design doc's claim that a reader owning two foils and no
nonfoil "currently gets a silent nonfoil entry" does not hold against the code it was written
about**: `ownedFinishes` answered `["foil"]` for that reader and the menu recorded foil. The one
path that does land on a silent `nonfoil` is `finishChoices`' empty-list fallback, and it is reached
only by a finish word this build cannot name — **0 live rows**, before the split and after it. What
the split actually removes is the *question*, and the reach described two paragraphs down.

**`foldCopies` lost a question rather than answering one.** `CopyTile.finish` used to be
`finishes.size === 1 ? [...finishes][0] : null`, because a tile holding a foil and a nonfoil could
not honestly be marked as either. Splitting the key removes the case: every tile is one finish, so
the field is never `null` for a group that has entries. `pickCopy` is unchanged and now ranks within
one finish, so a foil tile's add can no longer reach for a nonfoil copy.

**`copiesByCard` became `copiesByTile`, and that rename is the second half of the fix.** The map of
"which rows are behind this picture" was keyed by the *card*, which was correct for exactly as long
as a tile was all of a printing's finishes. The moment the finish joined the grain, a foil tile's
`Move to` reached the plain copies while the badge in the corner of that same tile counted one —
a control acting on cardboard the reader is not pointing at, with the tile itself saying otherwise.
**No test went red either way.** It is keyed by `tileKeyOf` now, and `entryIdsOf` takes `tile.key`
rather than `tile.id`.

**What is still a list rather than a single id is the point of that map.** One finish of one
printing is still several rows — they differ in grade, in language and in folder — so a drag still
hands a folder every one of them and the reader still answers which. The split narrowed *which* rows
sit behind a picture; it did not turn the several into one. The two `cardId`s in the drag payload
stay `tile.id` deliberately: a drop onto a **deck** is `deck_add_card(deckId, cardId, …)`, which
names a printing and takes no finish, and the tile half's `cardId` is what a folder card and a
breadcrumb caption say the reader is filing. Only the *rows* are the finish's.

**`CardGrid` gained `GridCard.key` for this and nothing else changed on the other walls.** It
defaults to `id`, so six of the seven walls pass none and are untouched. `id` stays what fetches the
art, what a press opens and what `onSelect` is about; `key` is what the ring compares, what
`data-grid-index` walks and what the picked set remembers.

**The pane's side of that composite is the store's `paneFinish`.** Two openers set it —
`openCardAsFinish`, the collection wall's, and `openCardFromDeckSearch`, *widened* to carry the
docked Collection tab's finish rather than the app gaining a fifth opener — and `setSelectedCardId`
clears it in its existing `set`, so a press from a surface that names no finish cannot leave a stale
seed behind. `viewPrinting` deliberately touches neither it nor the deck context: browsing printings
inside the pane keeps the reader's foil view. `CardDetailPane` then seeds that view from
`paneFinish === "foil" || paneFinish === "etched"` — narrower than "a finish was named", so a foil
tile opens showing the sheen and a nonfoil one opens plain.

**The card walk is deliberately not split.** `listWalkStops` de-duplicates by `cardId`, so a
printing held in two finishes publishes one stop. That is correct: the walk drives the printings
modal's chevrons, which step through *printings*, and a modal that visited the same printing twice
in a row would be stepping through something the reader cannot see a difference in. It is built from
`tiles` rather than from `rows` so the orphan fallback name survives, and the de-duplication lands
on the same list either way.

**And the tile now quotes a price** — `CollectionTile.unitPrice`, taken off the group's **first
row** rather than reduced across it, because every row behind a tile now names the same printing
*and* the same finish and so carries the same figure. It is the entry's own per-finish price
(`sorting::price_expr` over `ENTRY_FINISH`) and never `cards.price_usd`, which is a
`usd → usd_foil → usd_etched` fallback chain and would quote a plain copy at its foil's rate.

### What it costs, measured on the dev database 2026-08-26

Against `src-tauri/target/debug/data/mtg.db` — 275 collection entries over 272 printings, out of
116 843 live `cards` rows:

| Question | Answer |
| --- | --- |
| Collection printings held in more than one finish | **0 of 272** |
| Printings sold in more than one finish | **57 576 of 116 843** (49.3 %) |
| The whole corpus as finish-rows | **174 661** (+49.5 %) |

**The first row is the honest thing to say about this change: on this database it splits nothing
today.** It is a rule about what a tile *means*, taken before a reader's first foil makes it
visible. Everything it removes — a `Move to` reaching copies the tile is not about, a submenu asking
which of two objects drawn as one, a badge counting copies the picture does not stand for — needs a
printing held in two finishes before any of it can be seen, and there is not one yet.

**The last two rows are why the split stopped at the owned surfaces.** Search, Tags and the
printings modal still draw one tile per printing: a browse answers "what cardboard exists", and
half the corpus would appear twice for a scan half again as large. Owned surfaces answer "what do I
have", where the finish is the difference between two objects the reader can hold. The wishlist and
the decks already split by finish before any of this.

## The wall drags too, and a tile is not a row

Until 2026-08-26 only the collection's **table** was a drag source. The wall registered nothing,
and that was a recorded product call rather than an oversight — `CardGrid`'s `dragPayload` note and
`CollectionPage`'s `tileTarget` both said why: a tile merges every entry for one printing **across
finishes, conditions, languages and folders**, so it has no `entryId`, and `CollectionDrag`
requires one. The same reasoning is why a tile's right-click menu had no `Move to` row while a
table row's did.

The wall is a drag source now, and the three decisions that made it one:

**A tile answers under a _third_ key**, `collectionTileSource`, carrying `{ cardId, name, copies }`
where each copy is `{ entryId, folderId }`. Widening `CollectionDrag.entryId` into a list is the
change that looks smaller and is not: a table row really does carry one entry, so the widening
would make every target, every test and every `canDrop` reason about a list to say a thing about a
single row. `readCollectionDrop` is what a target that takes either asks, and `CollectionDrop` is
its discriminated answer — the union rather than the tile alone, because a folder's answer about
one row is a different sentence from its answer about nine copies filed in five places.

**A folder takes a tile when _any_ copy behind it could move, never only when all of them could.**
A printing filed in two drawers with one of them this one is the ordinary case, and a folder that
refused the whole tile for it would strand the copy that genuinely has somewhere to go. (The
example here was "held in two finishes" until 2026-08-26, when the finish joined the wall's grain
and that case became two tiles. The rule is unchanged — condition, language and folder still put
several rows behind one picture.)

**More than one row behind the art is a question, not a guess.** One copy files on the drop, which
is the common case and where a dialog would be a press for a choice with one answer. Two or more
opens `PickCopies` — every copy as _finish · condition · language · folder · count_, all ticked,
with the ones that cannot move greyed and carrying their reason in their own accessible name.
Since 2026-08-26 the copies behind one tile can no longer differ in **finish**, so that first term
is the same word down the whole list — which narrows the question without answering it, and is a
redundancy rather than a wrong answer.
A copy in a deck's group is refused by `set_entry_folder` (`ENTRY_IN_A_DECK`) and says so; a copy
already in the destination says that instead. The confirm button counts **copies, not rows**,
because a reader is filing cardboard. It is a centred modal rather than an anchored panel for the
reason `src/CLAUDE.md` gives for a consulted surface — and because it is the only shape both doors
can use: a drop has no opener element, and the menu's panel has already closed by the time a row's
handler runs. **Both doors set the same state**, which is the point: this page's drag and its menu
have already drifted once (the settle sets), and a second implementation of "which copies?" is that
mistake one layer up.

## The app's own folders in the card menu

`buildCollectionTargetItems` filtered to `kind = 'user'`, so the deck groups and `Recently removed`
never appeared as destinations. They appear now under **Add to → Collection**, and only there.

**`Decks ▸ <deck>` routes to the deck's own add, never to a folder write.** `set_entry_folder`
refuses a `deck` destination in words, and the refusal is right: filing into a group by hand would
claim the deck holds those copies without writing the `deck_cards` row that makes it true. The
deck's add does both halves in one transaction, so the row calls that — which makes it the write
`Add to → Deck` already makes, reached from the cabinet the reader was looking at. It files into
the **live** list without asking, because this row is filing rather than deck-building; a reader
who means the plan has the deck picker one row up, which still asks.

**It is drawn only under `Add to`, and only where the reader already has folders.** Not under
`Move to`, because that row is labelled *Move* while the write adds a copy, and a destination
picker may not mislabel its own write. Not for a reader with no folders, because
`Add to → Collection` has always been a single press for them, and forking the commonest path in
the app to describe a cabinet they do not have — with `Add to → Deck` sitting one row above it the
whole time — is a cost paid by everybody. That one cost a test to learn: `CardDetailPane`'s refusal
case clicks through to a finish on a printing with no folders, and the extra rung swallowed the add.

**`Recently removed` is drawn greyed, and it cannot become a destination.** The sanctioned route in
is `deck_to_collection`, which addresses a `deck_cards` row — and **schema v25 dropped
`deck_allocations`**, so a collection entry carries no link to one. Since v18 a deck may hold one
printing in two categories, so there is not even an unambiguous row to guess at: picking one would
be the app choosing a category the reader never named, which is the same class of guess the tile
question above exists to refuse. The row says so and names the cut in the deck editor instead,
because a greyed row that gives no reason teaches nothing.

Three things are this page's own:

**A collection drag answers under its own key**, `collectionSource`, never `dnd.ts`'s `dragSource`.
A collection row genuinely *is* both things — a card you can put in a deck, and a row you can file
— and both have to keep working from one tile. `deckDrag.ts`'s precedent is a different value under
the *same* key, which is right for decks because a deck is never a card, and wrong here: sharing
the key would force this module's mark onto the card payload, `dnd.ts`'s reader would see only
whichever mark won, and the other reader would be lied to. `wishDrag.ts` made the same call one
list over. The payload's three fields are read one by one rather than cast — this is the app's edge
with the drag library's untyped store, and "it type-checked" means nothing there — and `folderId`
is on it so a target can refuse **before** the drop: the folder a row already sits in draws no ring
at all, rather than a ring leading to a write that moves nothing and bumps `updated_at`.

**A folder move is not optimistic**, and that is a bug not repeated rather than a preference. The
wishlist shipped with `setFolder` removing the row optimistically from every cached list page and
then invalidating only the folder summary and the card search — so nothing ever put it back where
it went, the folder card read `1 wish` while the folder's own contents read "Nothing filed here
yet", and it cleared only on reload. A folder move is one deliberate press, not a held stepper, and
an optimistic insert would have to guess the destination's sort position and page. Invalidate and
re-read — and invalidate the **list itself**, not only its root: `src/lib/query.ts` caches 30 s, so
a mounted query that is merely marked stale never refetches.

**The app's own folders are a pinned, flat, locked section, and every one of those three words is
a decision** (`PinnedFolders.tsx`). *Pinned*, because it is drawn at every level rather than only
at the root — that is how a reader reaches `Recently removed` from three drawers down without
walking back out, and a section that moved as you navigated is not one anybody can learn the
position of. *Flat*, because `parent_id` is `NULL` on every row v25 creates and no command can nest
anything under one, so there is no tree to build and the summary's **direct** count is the whole
count: asking `subtotalsOf` to add up children here would be an answer computed from a tree these
rows are deliberately not in. *Locked*, because every write in `collection_folders.rs` refuses a
folder that is not `kind = 'user'` — a `⋯` menu here would be three rows that each end in
`FOLDER_NOT_YOURS`, and a control whose only outcome is a sentence explaining that it does not work
teaches nothing its absence would not have. Both kinds nevertheless answer their two questions
through **`folderFace`**, exported from `CollectionFolderCard.tsx` rather than re-spelled, because a
second spelling of "12 cards · $340.00" is a second chance for one wall to disagree with the wall
under it.

**Neither kind is a drop target, and the two refusals are not the same refusal.** A **deck group**
is refused up here, on the page, because a copy reaches one only through `collection_to_deck`,
which writes the `deck_cards` row in the same transaction — a bare drag would call
`collection_set_folder`, which knows nothing about decks, and file the copy into the group with no
deck card behind it. **`Recently removed`** is refused a layer lower: `set_entry_folder` calls
`user_folder` on its destination, so that write is refused whatever the page draws. A ring is a
promise, and a ring over a target the backend always says no to is a promise the next press breaks.

**Dragging a copy *out* of `Recently removed` is the whole point of it**, and is the "so you can
sort them back into your collection" half of [#209](https://github.com/Msgaihede/mtg-grimoire/issues/209):
the source side carries no fence, so a row standing there files into any folder the reader made.
`CollectionPage`'s `canFile` is where the matching half is written — a copy may not be dragged out
of a **deck group** either, because taking it back is `deck_to_collection`'s job and that write
also cuts the deck's list.

The card menu's `buildCollectionTargetItems` mirrors `buildWishlistTargetItems` including both of
its rules, which differ from the deck picker's: **root first and never omitted**, and **a leaf
folder is a plain action while a folder with children is a submenu whose first item is itself** —
so a parent folder is always pickable. Empty folders are **kept**, the opposite of `deckLevel`,
which drops a folder with no deck under it: an empty drawer is where the next card goes. Deck
groups and `Recently removed` are filtered out (`kind === "user"`), because copies reach those only
through `collection_alloc.rs`'s two writes and never through a folder press. `Move to → folder` for a collection row calls
`collection_set_folder`, the same command the drag writes through, so a drag and a menu press merge
on a taken grain identically — and the menu exists because a drag-only affordance is half a
feature, and it is the half a keyboard cannot use. **One command and, since the review of this
branch, one mutation**: `useSetCollectionFolder` in `src/features/collection/useCollectionFolders.ts`
owns the write and the keys it settles, and the two callers pass in nothing but what they do about a
refusal (the page's banner, the menu's `CardMenuRefusal`). They were two mutations for a day and had
already drifted — the menu's settled `["decks"]` and the drag's did not, so one gesture left a built
deck's claims stale or fresh depending on which hand made it.

## The importer's fold, and what it was

`import-export.md` described the collection importer's fold as **latent, not live**: it folded on
`(cardId, finish, condition)` while the storage grain was ten columns, and `commit_import`
hard-coded altered/signed/proxy/misprint/serial/grading to their defaults, so a re-import could
never land on the reader's altered or graded row and wrote a **second, all-defaults entry beside
it**. It was latent only because no shipped surface let a reader set any of the six.

**A folder in the grain is what would have made it live**, and it was fixed here rather than left
for the surface that would trip it. Once an import can land in a deck's group, it targets a grain
the reader's own filed row does not hold and the same second-row-beside-it failure follows without
anybody ever ticking "Altered". So the fold key became every grain term the importer can vary —
nine of the eleven — and `commit_import` carries the six flag columns rather than defaulting them.
See [import-export.md](import-export.md), where the section records the fix and its date.

**The two terms the fold key omits, it omits exactly.** `lang` is a function of `card_id`
(`add_entry` copies it off `cards` at write time and never takes it from the file), and `folder_id`
is always the root — the importer cannot name a folder, because an imported file says nothing about
this reader's filing. That is the wishlist importer's decision made again. Neither term can
separate two items the other nine fold together.

## The wipe

`reset::clear_collection` empties `collection_entries` **and then** `collection_folders`, and needs
the second statement rather than getting it by cascade: `collection_entries.folder_id` is SET NULL,
so a wipe that stopped at the entries would hand the reader an empty filing cabinet to take apart
one drawer at a time. Entries first, because `collection_folders.parent_id` CASCADEs onto itself
and clearing the folders first would be a second cascade running under the statement that matters.

**Then two more statements, and this is where it stops being the wishlist's twin: `Recently
removed` and one group per surviving deck are rebuilt in the same transaction.** Since v25 those
rows are not the reader's filing at all — they are *where the app puts cards*. Both
`collection_alloc` writes look their destination up by `deck_id` and by `kind` and refuse in words
when it is not there, so a database swept and left bare is one where **no deck can ever hold a card
again and nothing can be put aside** — permanently, because those rows are created by a migration
and a machine already at head never runs one again. Nothing self-repairs and nothing goes red.

Sweeping and rebuilding, rather than deleting `kind = 'user'` only: the app's folders are where
cards *were*, and a wipe that left a `Recently removed` full of nothing while claiming to have
emptied the collection would be keeping the shape of a thing it had just thrown away. **Archived
decks get a group like every other**, v25's rule verbatim — leaving them out would be the button
quietly deciding which decks may hold cards afterwards.

The returned count stays the count of **cards** deleted, which is what the reader is being told
about; a folder is where a card was kept rather than a card, and the rebuilt rows are the cabinet
rather than what was in it.

## What driving the shipped window found

### v25 and Collection Search — not driven yet

**The deck groups, `Recently removed`, the two moves and the Collection Search tab have not been
driven in the shipped window at the time of writing, and there are deliberately no figures here
for them.** The pass belongs after the code lands, and a number written before it would be a guess
with a date on it, which is worse than a gap. **This section is waiting rather than empty**, and
the two PRs before this one left it in exactly this state and were right to.

What it owes an answer to, at least:

- The upgrade of a **real v24 database with claims in it** — a copy of the main checkout's
  `mtg.db`, because a worktree is a fresh install and can never show an upgrade bug.
- The pinned section drawn at a level other than the root, and a drag onto a deck group being
  refused rather than silently written.
- A cut card with no backing copies leaving nothing behind.
- **Collection Search:** the tab strip at `MIN_PANEL_WIDTH_PX` in the real window rather than
  headless over `dist/`'s stylesheet; a row leaving the unallocated list on the press it was
  added by; and the cross-deck confirmation — its wording, and that the *other* deck's list has
  really lost the card afterwards.
- ~~**The own/need toggle**, both paths~~ — deleted on 2026-08-25 before this list was ever
  driven. Every add from the editor is a list row now; the Collection tab is the only way a copy
  moves into a deck's group from the search column.
- **The import box ticked**, and where the copies land — see the note below the checkbox, which
  says the root and not the deck's group.
- **The naming tiles** (2026-09-03, §"The wall names its own folders"), which are a separate
  change and owe a pass of their own — but only for the half a headless page cannot reach. The
  footprint, the corner pair and the two border styles were measured in headless Edge over the
  built CSS that day; what is still owed is where the caret is after each of Escape, the ✕, an
  outside click and a committed write, the blur discard against a real pointer rather than a
  synthesised `relatedTarget`, and a name long enough to need the truncation.

Fill this in from the running window, not from the suite.

### v24 — one pass, 2026-08-23

One CDP pass over `3036e18`, on **Windows**, `tauri dev` (**debug**), at 1920×1080, against a
worktree database carrying the full 116,700-card corpus. Every claim below was read out of the
running window or out of SQLite beside it, not derived.

**The lead finding is the one this section exists for, and the suite could not see it.** Stepping
a one-copy row to zero deleted it in SQLite and **left it on screen as a ghost** — the header read
`Cards 0` beside a list still showing the row, and pressing `+` on it answered "that row is gone".
`setQuantity`'s handler ignored `change.removed`, and `settle()` deliberately skips re-reading the
list, so nothing ever took the row away. It is the reversal of §"Zero deletes the row" biting at
the one place that did not follow it.

**The unit tests could not have caught it, and that is the part worth remembering.**
`CollectionPage.test.tsx` mocked `{ quantity: 0, removed: false }` — *a response the backend has
been unable to produce since v24*. A mock that encodes a state the system no longer has is not a
weak test, it is a test asserting the opposite of the truth, and it will stay green forever. The
fix reads `change.removed` and drops the row; `ZeroDeletesTheRow` in `CollectionPage.stories.tsx`
now pins it against the fake, where the mock cannot lie.

**Everything else measured clean, first time:**

| Checked | Read back |
| --- | --- |
| `+ New folder` → `Create folder` | `Binder A folder, 0 cards` |
| `Add to → Collection → Nonfoil → Binder A` | `collection_entries.folder_id = 1`, **not** the root — the nested add of [#215](https://github.com/Msgaihede/mtg-grimoire/issues/215) working end to end, menu → ipc → Rust → SQLite |
| The folder card after that add | `Binder A folder, 1 card, $0.32` — `folder_summary` live |
| The row's trailing cell | `Binder A` (the `Actions` → `Folder` column) |
| Stepping to zero, after the fix | row leaves the list, header `0`, folder card back to `0 cards`, no `role="alert"` |
| The delete confirmation | *"Delete "Binder A"? Its cards move back to your collection; folders inside it are deleted."* — **both halves said out loud**, which is the whole point: "and everything in it" would be wrong about the half that matters |
| After confirming | `collection_folders` empty, and the card **survives at `folder_id = NULL`** — SET NULL doing its job |

**The finish branch composes above the folder branch, as designed** — `Add to → Collection` is a
submenu of finishes, and each finish is itself a submenu of `Collection` (the root, first) then the
folders. Three levels for a two-finish card, which is the cost of not asking two questions at once.

Three harness facts, two inherited and one new. The collection page is a **div/grid table**, so
query `[role=row]` and `[role=gridcell]`, never `tbody tr` — `document.querySelectorAll('table')`
answers `0` on a page plainly showing one. `cdp.mjs` has no right-click, so a synthetic
`MouseEvent('contextmenu', { bubbles, clientX, clientY, button: 2 })` on `[data-grid-index]` opens
the card menu, and each submenu needs `pointerenter` + `mouseover` + `focus()` + `click()`
together. **New: the folder-name field is controlled, so assigning `.value` writes a character
React never sees** — go through
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` and then dispatch
`input`, or the submit stays disabled over a box that visibly contains a name.

**One correction to that note, made 2026-09-03 without a new pass.** The controlled-input trap is
unchanged, but the field is no longer a strip under the breadcrumb and its submit no longer prints
`Create folder` — it is a ✓ in the naming tile's own corner, carrying that string as its
accessible name. So find it by accessible name, never by text; `cdp.mjs`'s `click` takes CSS and
only `text` matches text, so a pass that matched the words will now find nothing on a control
plainly on screen. The table above is left as it was read on `3036e18`: it is the record of that
build, not a description of this one.

## Deliberately out of scope

- **Folders in import and export.** The seven formats carry cards, and a folder is not one — see
  [import-export.md](import-export.md), where the same decision is recorded beside the formats.
  This is `wishlist-folders.md`'s decision made again, deliberately and for the same reason.
- ~~**The deck builder's two search tabs and the import "add cards to collection" toggle**~~
  (spec §7.2 and §7.4) — **shipped 2026-08-23**, the PR after this cabinet's, because both of them
  needed a deck's group to exist first. See
  [Collection Search, and the first caller `collection_to_deck` ever had](#collection-search-and-the-first-caller-collection_to_deck-ever-had)
  below. `ipc.collectionToDeck` is no longer callerless; the note telling a future reader not to
  delete it as unused has come out with the state that made it necessary.
- **Per-folder price summaries beyond `folder_summary`'s two numbers**, and any change to the
  wishlist's own folders. Both are spec §2's "out", and neither is a thing this cabinet needs to
  work.

## Where the code is

| Path | What is in it |
| --- | --- |
| `src-tauri/src/schema.rs` | The v24 and v25 steps, `COLLECTION_GRAIN`, `COLLECTION_FOLDER_KINDS`, `UNDO_V24`, `UNDO_V25`, `schema_at_23`, `v24_database`, and the whole-schema `ON DELETE` inventory |
| `src-tauri/src/collection_folders.rs` | The seven commands, `set_entry_folder` and its two fences, `refile_entry`, `take_copies` (the split), `merge_entry`, `folder_summary`, `FOLDER_NOT_YOURS`, `ENTRY_IN_A_DECK` |
| `src-tauri/src/collection_alloc.rs` | `collection_to_deck` and `deck_to_collection` — the only pair that moves a row across the deck boundary — `take_from_deck_list`, `MoveOutcome`, the cut's history row and the argument for its missing undo step, and the seven refusal sentences |
| `src-tauri/src/collection.rs` | The grain's other ten terms, `set_quantity`'s zero-delete, `update_entry`'s merge, `fold_entry`, `EntryChange`, `ENTRY_FINISH`, `Allocation` |
| `src-tauri/src/deck.rs` | `owned_by_oracle` and `attribute_owned` — owned/missing as a sum over the group — `delete_deck`, which re-files into `Recently removed`, and `release_group_copies`, the crate's one walk over a group's rows — oracle-matched, exact printing first — which `deck_to_collection` calls for its one row and `release_live_copies` loops for the four bulk sites (`clear_category`, `clear_variant`, `deck_meta::delete_category`'s cascade arm, `import::commit_import`'s `replace` arm), carrying the `live` fence for all of them |
| `src-tauri/src/reset.rs` | `clear_collection` — entries, then folders |
| `src-tauri/src/reconcile.rs` | `fold_into_existing`, which calls `fold_entry` as `merge_entry` does, and `collision_target`, the crate's other eleven-term probe |
| `src/lib/folderTree.ts` | `buildFolderTree` and friends, shared with the deck gallery and the wishlist, **unchanged** |
| `src/features/collection/collectionDrag.ts` | Both payloads under their own keys, the row and the tile that offer them, the targets that take either |
| `src/features/collection/PickCopies.tsx` | The question a drop asks when the art stands for more than one row |
| `src/lib/tileKey.ts` | `tileKeyOf` — **the one place** `` `${cardId}:${finish}` `` is spelled, and the `?? "nonfoil"` the ring composite meets a tile's key on. Both folds and both walls call it |
| `src/features/collection/CollectionPage.tsx` | The `tiles` memo, `copiesByTile`, `entryIdsOf` — the wall's own printing-and-finish grain, keyed through `tileKeyOf` |
| `src/features/decks/collectionTiles.ts` | `foldCopies` — the *other* fold of the same rows, split the same way and keyed through the same `tileKeyOf` |
| `src/features/search/CardGrid.tsx` | `GridCard.key` and `tileKey` — a tile's identity where it differs from its card's |
| `src/features/collection/CollectionFolderCard.tsx` | The tile, `folderFace`, its `rename` branch, and its stories beside it |
| `src/components/FolderNameField.tsx` | The one naming field, both shapes, `FOLDER_CARD_HEIGHT` and `useFolderFieldReturn` |
| `src/components/NewFolderCard.tsx` | The tile that makes a folder, and the field it becomes |
| `src/components/ParentFolderCard.tsx` | The up-one-level tile all three cabinets draw, and its stories |
| `src/features/collection/PinnedFolders.tsx` | The app's own folders — pinned, flat and locked — `DECK_KIND`, `REMOVED_KIND`, and neither one a drop target |
| `src/features/card/cardMenu.tsx` | `buildCollectionTargetItems` — `Add to → Collection`, and `Move to → folder` |
| `src/features/transfer/import/destinations/collection.ts` | `grainKey` — the importer's fold, now every grain term it can vary |
| `src/lib/ipc.ts` | `MoveOutcome`, `collectionToDeck` and `deckToCollection`, and `CollectionQuery.allocation` — whose two words nothing sent until Collection Search |
| `src/features/decks/DeckSearchPanel.tsx` | The two tabs, `DEFAULT_DECK_SEARCH_TAB` (`collection`) and `DECK_SEARCH_TAB_KEY` |
| `src/features/decks/CollectionSearchTab.tsx` | The list, `landingCategory`, and the confirmation that names the other deck |
| `src/features/decks/useCollectionSearch.ts` | `collection_list` with `allocation`, `CopySource`'s three answers, and the invalidation a move fires |
| `src/features/decks/useDeck.ts` | `setQuantity`, which routes a **live** decrease through `deckToCollection`, and `invalidateCollection`, which fires only when the outcome says copies moved |
| `src/features/decks/DeckEditor.tsx` | `setQuantityAt` — the app's one removal path, and where the `CutFrom` row is looked up |
