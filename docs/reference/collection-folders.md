# The collection's folders, and the eleventh term of its grain

Schema **v24 and v25**, [issue #215](https://github.com/Msgaihede/mtg-grimoire/issues/215) — and
**v33**, which gave a folder a property that changes what the app *offers* rather than where a
card sits, under [issue #365](https://github.com/Msgaihede/mtg-grimoire/issues/365). The
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

**And since v33 a drawer can be set aside.** A locked folder is one the app stops *offering* what
is in — out of what the deck builder will put in a deck, and out of the spare count a bracket
estimate plans with — while the reader goes on reaching it exactly as before: they can open it,
drag into it, drag out of it, rename it, move it, back it up and export it. It is one column, no
index and no new grain term, because whether a drawer is set aside is not part of what makes two
rows the same row. [The lock](#the-lock-stops-the-app-offering-and-never-stops-the-reader-reaching)
is the whole of it.

**That sentence said "out of the collection's own lists" for six days, and #436 is why it does
not.** A locked drawer's copies left the flattened wall and left the reader's card count, unique
count and total value with them — and a card set aside is still a card they own. The page counts
them, prices them and lists them; what it does instead is **mark** them.
[#436's own section](#436-took-the-collection-page-off-the-excluded-list) is that whole story, and
it is the correction most likely to be undone by somebody tidying.

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
already answers `Filed`. **That held until v33**, and the correction belongs here rather than in a
footnote: the module now carries one function that is this cabinet's alone, `lockedFolderIds`,
because `locked` is a column no other folder table has — see
[the lock](#the-lock-stops-the-app-offering-and-never-stops-the-reader-reaching). Everything the
tree arithmetic does is still generic and still shared. Nothing new is named `folderTree.ts`: a
case-insensitive filesystem
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

**History (2026-09-26):** there is no pinned section any more — the app's folders are shelves under
a `Decks` label, ordered by name in `buildShelves` and never by `sort_order`, so the `kind` fence
still matters for the reader's sequence and nothing reads the app folders' numbers at all. See
[Shelves](#shelves-2026-09-26).

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

### The add path has a folder default now, and the eleventh term is what makes that safe

**Since 2026-09-07 the `+` on a card can file into the folder the reader is standing in**, and it
is the grain above that turns that from a risk into an ordinary add. `EntryInput.folderId` has been
on the wire since v24 and `useCardMenuDeps` has always passed it; `AddToCollectionButton` never did,
which is why every `+` in the app filed at the root. It now takes optional `folderId`,
`folderNodes`, `folderName` and `lockMode`, and the collection page's docked search column passes
all four — so a reader filing a binder adds from the sidebar without leaving the folder, where
before they left the page, filed at the root, came back and moved what they had just filed.

**Read the eleventh term as the licence for this rather than as a constraint on it.** A default
destination is only sane where a second destination is a second row: with `coalesce(folder_id, 0)`
in the grain, adding a printing the reader already owns *elsewhere* writes a new row in the folder
on screen and touches the old one not at all. Without the term the same press would land on the
existing row and raise its quantity, so the copies filed last week would silently **move** into
whatever folder happened to be open — a default that quietly undoes filing decisions, which is
exactly the failure v24 was built to make impossible. The grain came first and the folder default
is what it was for.

**Three fences around it, each of which could have been the other way:**

- **A flattened page defaults to the root.** Flatten means *show me everything*; the breadcrumb
  reads `Collection · all folders`, there is no folder on screen to be standing in, and the page
  passes `folderId: null` rather than whatever `useCollection` still holds underneath. The
  collection ships flattened, so out of the box the sidebar behaves exactly as the `+` always has,
  and the default starts working the moment a reader opens a folder. **History (2026-09-26):**
  Flatten is deleted, so this fence went with it — the page always passes the level it stands on
  (the docked search column's `folderId` in `CollectionPage.tsx`), which is the shelf at the top
  of the wall. See [Shelves](#shelves-2026-09-26).
- **Absent and `null` are different on the wire**, and the page sends `null` explicitly. Absent
  sends no `folderId` field at all — which is what `SearchPage` and the Tags page still do, and why
  they were untouched by this — where `null` sends `folderId: null` and *names* the root as the
  destination.
- **Only `user` folders are offered.** The override picker is handed the page's own
  `buildFolderTree(userFolders, [])`, the filtered tree that already existed: deck groups and
  `Recently removed` are kinds the cabinet draws and nothing may be filed into by hand, and
  `collection::add_entry` refuses a `deck` folder outright in any case.

**A tile dropped on a folder card takes the same path**, and it answers `useSidebarDrops.ts`'s
standing objection rather than dodging it. That file refuses to make the sidebar's Collection entry
a drop target because *"`collection_add` carries a finish, a condition and a language that a drop
cannot answer, and a drop that invented 'NM nonfoil' would write facts the reader never said"* —
sound, and already answered elsewhere: the card menu's own add writes `MENU_CONDITION`, which is
`CONDITION_NOT_SET`. **An add that names no grade records that nobody named one, which is a fact,
where `NM` would be a guess dressed as one** — and since schema v35 `NONE` is the column's own
default, so the drop is writing what the database would have written anyway. A drop here writes
`MENU_CONDITION`, `quantity: 1` and the finish the printing actually exists in, onto a **named
folder the reader pointed at**; the sidebar entry stays as it is, because that one would have to
guess a destination as well as a grade.

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

**`set_entry_printing` is the third side of the same fact** (issue #564, 2026-09-27) — the one
write that reaches `card_id` after a row exists, behind the card modal's `Edit` on the collection
surface. A copy moved onto a printing the same folder already holds at the same finish and
condition folds into that row through `fold_entry`, and the answer names the survivor, which the
modal follows. It refuses a printing of a *different* card, and it does not check the target's
`finishes` — `add_entry` does not either — so the modal refuses a foil copy onto a printing with no
foil before it writes. The modal opens read-only and stays that way until `Edit` is pressed, because
a foil toggle or a printing row that wrote on its first press would change what the reader owns
while they were only looking.

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

## The lock stops the app offering, and never stops the reader reaching

**Schema v33, [issue #365](https://github.com/Msgaihede/mtg-grimoire/issues/365), raised from
Discord.** The design is
[2026-09-03-locked-collection-folders-design.md](../superpowers/specs/2026-09-03-locked-collection-folders-design.md);
this section is the record of what shipped. `locked` is the first column this cabinet has gained
that changes **nothing** about where a card sits — every other one of them files something.

**And read [#436](#436-took-the-collection-page-off-the-excluded-list) before you read the four
lists below**, because it moves the first of the two exclusions into the untouched table. The
heading of this section survives it intact — a lock still stops the app offering and never stops
the reader reaching — but *who* it stops the app offering to narrowed from "every list this app
draws" to "a deck".

**And since 2026-09-08 the lock has a second reader that is neither offering nor reaching:
publishing.** A share refuses a locked folder outright rather than publishing it empty, and drops
every locked drawer *inside* whatever it does publish — through `LOCKED_FOLDER_IDS`, this page's
own single copy of the inheritance rule, so a share and the wall's badge can never disagree about
which drawers are set aside. That is the one place where getting the lock wrong puts a reader's
cards on a public page, and
[collection-sharing.md](collection-sharing.md) carries both ways of getting it wrong.

**A locked folder is a drawer the reader has set aside, so the app stops *offering* what is in it
without ever stopping them reaching it.** Every decision below is a consequence of that split:
*offering* is what a search result, an availability figure and a shopping list do, and *reaching*
is what a drag, a click into the drawer, a backup and an export do. The two piles the issue
describes are the same shape — cards held for a trade, and cards in a display case — and until v33
this cabinet could not tell either apart from a binder.

### The column, and why the upgrade is invisible

```sql
ALTER TABLE collection_folders ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
```

**`NOT NULL DEFAULT 0`, and the default is the answer rather than a placeholder** — which is
[v24's third trap](#the-v24-steps-four-traps) read the same way round. Every folder that already
exists is unlocked, so a reader who never presses Lock cannot tell the rung ran, and there is no
state a repair or a seed has to reach afterwards. The unset value is not a lie a `DEFAULT` is
telling; it is the answer.

**`ADD COLUMN` and never a rebuild**, which is worth checking rather than assuming on a table that
ends in a `CHECK`: SQLite splices the new text in **before** that `CHECK`, on the `updated_at`
line, exactly where v29's `sync_uid` and `needs_review` landed. Read back out of a migrated
database with `node:sqlite` on 2026-09-03: `updated_at INTEGER NOT NULL, sync_uid TEXT,
needs_review TEXT, locked INTEGER NOT NULL DEFAULT 0,`. `USER_SCHEMA_SQL` wears that exact shape
because `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares string for string,
and a retyped DDL is a fresh install disagreeing with an upgraded one.

**No index, and the absence is the decision.** `locked` is in no grain, in no unique index and in
no sort — it is read once per folder and *interpreted*, never searched on — so the schema's index
count does not move and the eleven-term grain does not either. **Whether a drawer is set aside is
not part of what makes two rows the same row**, which is the whole reason this feature could be
one column: a lock changes what the app says about a card, never which row that card is.

**`INTEGER` in the table, `bool` on the struct, and the read is `!= 0` rather than rusqlite's
`bool`.** The four booleans on `EntryGrain` are deliberately read as `i64` because that struct
hands its values straight back to a collision probe, and a probe compares what is *stored*. This
one is interpreted rather than handed back, so `CollectionFolder.locked` is a `bool` and
`folder_row` asks `r.get::<_, i64>(…)? != 0`. The column carries no `CHECK`, so a hand-edited
database can hold a `2` — and **a `2` is locked**, which is the only reading of a non-zero that is
not a refusal, and the one that fails safe: the failure worth foreclosing is a set-aside drawer
quietly rejoining what the app offers. `set_folder_locked` can never be the source of such a
value, because rusqlite binds a `bool` as 0 or 1.

### The lock inherits down the tree, and is never stored twice

**A folder inside a locked folder is locked.** The reader locks a drawer and gets the drawer,
including whatever they have nested in it. It is computed over ancestry and never stored per row,
for the reason a stored copy always gives: it would be a second copy of a fact the parent already
holds, and the two disagree the first time a folder moves.

In SQLite that is a recursive CTE, spelled **once** — `collection_folders`' `LOCKED_FOLDER_IDS`, a
self-contained `SELECT` that drops straight into an `IN (…)` and binds nothing:

```sql
WITH RECURSIVE locked_folders(id) AS (
    SELECT id FROM collection_folders WHERE locked <> 0
    UNION
    SELECT f.id FROM collection_folders f
      JOIN locked_folders l ON f.parent_id = l.id
)
SELECT id FROM locked_folders
```

All three readers — `collection::scope`, `deck_theory::OWNED_SPARE_SQL` and
`collection_source::Availability::and_arm` (which arrived with issue #349 and is what carries the
lock into the deck builder's search badge and, since 2026-09-09, into a `theory` row's owned
figure) — interpolate that fragment rather than carrying a copy, and `effectively_locked` asks it
of one id in the same `?1 IN (…)` shape, so **the fence a press meets is literally the same SQL as
the term that drops a folder's copies out of a list**. A second copy in any of those modules is how
the page's list and the counts beside it would come to disagree about which drawers are set aside.

**`UNION` and never `UNION ALL`**, which is [`delete_folder`'s sub-tree
walk](#delete_folder-re-files-one-row-at-a-time)'s reason rather than a new one: `move_folder`
refuses to write a cycle, so only a hand-edited database or a restored backup can hold one, and the
duplicate-row check is what makes the walk converge where `UNION ALL` would run forever.
`locked <> 0` rather than `locked = 1`, `folder_row`'s reading of the same column. Folder counts
are tens, so none of this was worth measuring against the grain — and none of it has been.

**On the TypeScript side it is `lockedFolderIds` in `src/lib/folderTree.ts`, and no call site may
re-derive it.** `CollectionFolder.locked` is the folder's *own* flag and is never the answer: the
badge, the greyed Lock/Unlock row, the greyed Delete and the drag confirmation are four surfaces
about the **effective** lock, and one reading the raw field would draw an unmarked drawer inside a
locked one — making the inheritance invisible exactly where it matters. It floods **downward** from
the locked rows rather than walking each folder's ancestors upward, `folderDescendants`' reason:
one breadth-first pass with a visited set costs one sweep per level instead of one per folder, and
the visited set terminates on a corrupt cycle the same way the `UNION` does.

**That helper is what makes `folderTree.ts` no longer "reused unchanged", and
[the sentence above](#the-table-and-the-three-on-delete-actions) has been corrected rather than left
standing.** It is deliberately *not* generic — `readonly CollectionFolder[]`, no type parameter —
because neither `DeckFolder` nor `WishlistFolder` carries a `locked` column, there is no wishlist
equivalent of this feature and none planned, and a generic would invite exactly the widening the
design refused.

### What locking changes, in four lists

**The organising rule, and it is the whole design in one line: a statement that says what the
reader *has* is untouched; a statement that says what is *available* excludes.**

**And the rule had to be applied a second time before it was right — see
[what #436 corrected](#436-took-the-collection-page-off-the-excluded-list) below, which moves the
first of the two exclusions into the untouched table.** What follows is the shape as it stands.

**Excluded, first — the deck builder's Collection Search tab, and only when asked.** One term in
`collection::scope`, the `WHERE` shared by any list, its count and its header, pushed in the same
correlated shape the `Unallocated` arm uses:

```sql
(e.folder_id IS NULL OR e.folder_id NOT IN (WITH RECURSIVE … SELECT id FROM locked_folders))
```

`e.folder_id IS NULL` comes first for `scope`'s existing reason: the root is where most copies are
and is not a folder to look up, and a `NOT IN` over a NULL is NULL rather than true, so the root
would drop out of the list that is mostly root. The term is pushed only when `folder_id.is_none()`,
and **that guard is what makes "except inside the folder" true** — standing in a locked drawer, or
in a subfolder of one, *names* it, and a named folder is served whole. That is
[`root_only`'s own rule](#the-wire-was-widened-not-flipped-and-that-was-the-whole-design) applied to
a second field, so the three-state convention gains no fourth state. **Who asks**: the deck
builder's Collection Search tab, and nothing else since 2026-09-09 — the collection page asked
until [#436](#436-took-the-collection-page-off-the-excluded-list). **Who does not**: the mirror,
the export sweep and the web route's passthrough — which is
[the default](#the-default-is-false-and-the-default-is-the-whole-of-the-safety) below, and the
most important paragraph in this whole section.

**And the `IS NULL` arm carries no weight until a locked folder exists, which is a trap rather
than a nicety.** `x NOT IN (<empty set>)` is **TRUE** in SQLite even where `x` is NULL — the
NULL-propagating behaviour everyone reaches for that arm to guard against only appears once the
subquery returns a row. So a test that locks nothing, or that counts a root copy while nothing is
locked, passes **whether the arm is there or not**. It was caught on the way in: the mutation that
deleted the arm from `OWNED_SPARE_SQL` stayed *green* against the obvious test, and the shape that
actually fails is a root copy added **after** the lock. `a_locked_folders_copies_are_not_spare`
is written that way and says so; a future arm on either statement owes the same shape, or the
guard is decoration with a test agreeing that it works.

**Excluded, second — "what can I build with".** `deck_theory::OWNED_SPARE_SQL` already excluded a
deck's group by exactly this device, and its doc already argued the point this feature needed: *a
deck on a table has its cards, so a copy filed in a deck's group is not one this plan can count
on.* A card in a display case is not one a plan can count on either. It gains a locked arm beside
the deck arm, with an `IS NULL` half of its own, because the two conditions are ANDed and each has
to let the root through on its own.

**That arm is unconditional, unlike `exclude_locked` one module over, and the asymmetry is
deliberate rather than an oversight.** No backup and no export reads this figure. `owned_spare` is
a **display** field — "for a reader, beside a price", forbidden by its own doc from being a term in
any arithmetic — so widening it cannot move a number anywhere else, where widening a *list* read is
precisely how a whole-collection backup silently loses rows. It was the one ownership-shaped
statement in the crate that changed, and it could change because it was never an ownership
statement.

**A second one joined it a month later, and it is the same sentence read from another chair.**
`collection_source::Availability::ForDeck` — the deck builder's card search, issue #349 — drops a
locked drawer's copies from the `×N` on every tile and from the Owned chip beside them, for
`owned_spare`'s reason exactly: *a card in a display case is not one this deck can count on.* It
is a **request scope** rather than a statement, which is what keeps the rule below intact: the
three fragments still count a locked copy for every caller that has not named a deck, and only the
one surface whose question is "what can I build with today" gets the narrower answer. The arm it
does **not** share with `OWNED_SPARE_SQL` is the asking deck's own group, which stays counted — a
plan cannot count on the sleeved deck's cards, and the deck builder's own search can, because they
are its.

**Refused — one folder write, in words.** `delete_folder` refuses a folder that is **effectively**
locked, with `FOLDER_IS_LOCKED` — *"That folder is locked. Unlock it before deleting it."* — a
sentence in this module's existing grammar rather than a `CHECK` or a constraint failure. The reason
is what that press does: it
[re-files every card in the sub-tree to the root](#delete_folder-re-files-one-row-at-a-time), which
silently undoes exactly the filing the lock was protecting. A subfolder of a locked parent is
refused for the same reason, because it scatters the same cards. **So is an unlocked folder with a
locked one anywhere beneath it** — `FOLDER_HOLDS_LOCKED`, *"A folder inside that one is locked.
Unlock it before deleting this one."* — because deleting `Binder` re-files a locked `Binder/Graded`
exactly as deleting `Graded` would; that check asks the same `doomed` sub-tree the re-filing walks
(`DOOMED_FOLDERS`). Both checks come **first**, before the function's own transaction, and each
answers `false` for an id nothing answers to — so "a folder that is not there is a success"
survives being asked second. The menu greys `Delete…` for all three, naming *unlock it first*, *a
folder above it is locked* or *a folder inside it is locked*.

**Rename and move do not refuse, and that is a decision rather than an omission.** Neither disturbs
a card. A drawer the reader could not re-title or re-file would be a lock on the *folder*, where
this one is a lock on what the folder offers. **Nor is there any fence on filing cards in and out**:
the issue is explicit that moving copies must always be possible, `set_entry_folder` gains nothing,
and a locked folder is a `user` folder on both of the counts that command already checks. The
warning is the UI's and it is a confirmation rather than a refusal — a drag onto a locked folder, or
out of one, confirms and names it, because a drop target is a rectangle a pointer can land on by
mistake; an explicit menu pick does not, because the reader has just named the folder in the press
they made. And the UI greys Delete with its reason in the row's accessible name rather than letting
the press reach the sentence at all, which is `PinnedFolders.tsx`'s standing rule: a control whose
only outcome is a sentence explaining that it does not work teaches nothing its absence would not
have.

**Untouched — every statement that says what the reader HAS.** Named one at a time, because
"excluded from search" can be read onto any of them and each is a deliberate no. (No count here:
a count in prose is a fact about a tree, and this table has already gained a row once.) This table
is worth more than the two exclusions above it: every row in it is untouched *by design*, so nothing
goes red if somebody later "tidies" the exclusion into `collection_source`, and
`a_locked_folders_copies_are_still_owned` is the fence for the whole of it.

**The first row is the one this table gained by being got wrong**, and it is at the top rather than
the bottom because it is the row a reader of this page most needs to have read: the collection page
was on the *excluded* list for six days.
[#436](#436-took-the-collection-page-off-the-excluded-list) is that whole story.

| Site | Why it does not change |
| --- | --- |
| **the collection page's list, its count and its header** | What the reader owns, in the one place whose whole subject is what they own. Excluded from 2026-09-03 to 2026-09-09 and put back by [#436](#436-took-the-collection-page-off-the-excluded-list) — `useCollection` sends no `excludeLocked` on either query, and `asks neither its list nor its header to leave out a locked drawer` is the fence. The copies carry a **lock mark** instead: the wall's caption and the table's Folder cell. |
| `collection_source::owns_printing` / `copies_of_printing` / `copies_of_oracle` | The card search's owned pip and both owned badges. A graded card is a card you own; a search that stopped saying so would be the app lying about cardboard on the reader's shelf. **Unchanged in the fragments themselves** — the exclusion issue #349 added lives in the `Availability` a caller passes, so only a request naming a deck gets it, and `a_locked_folders_copies_are_still_owned` is the assertion that it stayed there. |
| `index::CardIndex.owned`, through `collection_source::owned_rowids` | The Owned/Missing facet pair. Same reason, and it has to agree with the pip beside it or the greying contradicts the badge. |
| `deck::owned_by_printing` | Structurally cannot see one of these folders at all — the paragraph below. |
| `import::match_columns` / `MATCH_ORDER` | Which printing a pasted line resolves to. Ranking by owned copies is a guess about *which cardboard the reader means*, and a locked copy is still their cardboard. |
| `collection_folders::folder_summary` | The per-folder tile. A locked folder's own tile must count its own contents, or the badge sits above a lie. |
| `images::prewarm_keys` | Cache warming. Excluding would make the drawer slow to open, for nothing. |
| `reconcile.rs` | Repoints rows onto new printings and never writes `folder_id`. A locked folder's card that Scryfall has renumbered still needs repointing — the lock is about *offering*, and upkeep is not an offer. |

**`deck::owned_by_printing` (`owned_by_oracle` before 2026-09-07) is the row that earns its own
sentence, because it is the first question a
reader of this page will ask.** It counts only rows filed in *that deck's own group* — `JOIN
collection_folders f ON f.id = e.folder_id … WHERE f.deck_id = ?1` — and a locked folder is a
`kind = 'user'` folder, so its copies have never been in any deck's group and have never counted
toward a deck's owned or missing. **Locking a folder therefore cannot move a _live_ deck's owned or
missing figures in either direction**, and no part of this feature touches that statement. It is
also why locking needed no thought about `attribute_owned` or the deck editor's live counts: they
are all sums over a group a locked folder is not.

⚠️ **That stopped being true of the _theory_ list on 2026-09-09**
([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)), and it is the one place the
lock reaches a deck's owned figure. A `theory` row is attributed from
`deck::available_by_printing` — `collection_source::Availability::ForDeck`'s pool — which counts
the root, the deck's own group and everywhere else that is neither another deck's group nor
**effectively locked** (`LOCKED_FOLDER_IDS`). So locking a drawer *lowers* a plan's owned figure
by whatever it holds, and unlocking it raises it back — read off the statement, not driven in the
window. That is the pool behaving as designed rather than a leak: a card the reader has set aside
is not one their plan can count on, which is the same sentence `deck_theory::OWNED_SPARE_SQL` and
the deck builder's search badge already made. Nothing about the **live** list moved — its pool is
still the group alone.

### The default is `false`, and the default is the whole of the safety

**`exclude_locked` is a new `CollectionQuery` field defaulting to `false`, and this is the failure
the entire feature is shaped around.** It is
[`root_only`'s argument](#the-wire-was-widened-not-flipped-and-that-was-the-whole-design) verbatim,
one field along: an unasked question keeps today's answer, so a caller nobody updated cannot
silently lose rows.

**The callers whose silence must go on meaning "everything" are not hypothetical.** The plain-text
mirror and the export sweep both page through `list_entries`, and `mirror/read.rs` already says in
words that a whole-collection backup is "the one read that must never ask" the narrowing question.
An unconditional term in `scope` would have made **every backup and every CSV export silently omit
the reader's locked cards**: no error, no empty page, no `error_log` row — just a file on disk
missing exactly the cards its reader was most careful about, discovered at the moment the app will
not open and the mirror is all there is. That is the worst failure available in this feature, and a
field that has to be *asked for* is what forecloses it.
`a_query_that_never_asks_still_sees_a_locked_folders_copies` is the fence around that silence, and
it is worth more than either exclusion test beside it.

The web route's passthrough is on the same list for the same reason, and the two surfaces named
above are the only senders there are.

**Since #436 there is exactly one caller that asks**, which makes this default carry more than it
did: `useCollectionSearch`'s `DEFAULT_EXCLUDE_LOCKED`. There is no longer a second sender whose
behaviour would hint that the first had stopped asking, so the constant's own doc comment is the
whole of the coupling and `a_query_that_never_asks_still_sees_a_locked_folders_copies` the whole of
the fence.

### #436 took the collection page off the excluded list

**Schema unchanged, query unchanged, one caller stopped asking** —
[issue #436](https://github.com/Msgaihede/mtg-grimoire/issues/436), raised from Discord six days
after #365 shipped. It is the sharpest correction this feature has had and the one a later reader
is most likely to try to undo, so it gets its own section rather than a footnote.

**What was reported.** *The full collection count at the top should include cards in locked
categories. For example, "38 cards 12 unique value $120" should include locked cards because they
are still owned for overall collection analytics, even if they should not be available for other
collection management purposes.*

**What was wrong.** The organising rule above — *a statement that says what the reader has is
untouched; a statement that says what is available excludes* — is right, and the collection page
had been filed on the wrong side of it. `useCollection` sent `excludeLocked: true` on **both** its
queries, so locking a drawer took its copies off the flattened wall *and* out of the reader's card
count, unique count and total value. The eight-row table above was assembled by asking "which
statements say what the reader **has**?" and the answer missed the one surface whose entire
subject is that question. The lock is about what the app offers a **deck**; it was never about what
the reader owns, and the page had been reading it as both.

**Both queries moved together, and that is the part that could not be split.** `collection::scope`
is one predicate list — the page, its count and its header share it — so widening the header alone
would have put *38 cards* over a wall drawing 26, which is a worse sentence than the one being
fixed. The issue asked only for the header; the header could not be answered on its own.

**What did not move**, and every one of these is what "not available for other collection
management purposes" means:

| Still excludes | Question it answers |
| --- | --- |
| `useCollectionSearch`'s `DEFAULT_EXCLUDE_LOCKED` | The deck builder's Collection Search tab — *what can I put in this deck today.* Unconditional, no control, and now the **only** sender of the flag there is. |
| `deck_theory::OWNED_SPARE_SQL` | The bracket estimate's spare count — *what can this plan count on.* |
| `collection_source::Availability::ForDeck` | The deck's card search, its `×N` and its Owned chip (#349). |
| `share::snapshot`'s `LOCKED_FOLDER_IDS` | What a published snapshot carries. A share refuses a locked folder outright and drops every locked drawer inside what it does publish. |
| `delete_folder`'s `FOLDER_IS_LOCKED` and `FOLDER_HOLDS_LOCKED` | The one folder write that is refused — on a lock at, above or anywhere beneath the folder pressed — because it re-files the sub-tree to the root. |

**Absence stopped saying "set aside", so a mark had to start**, and the swap is the whole of the
UI side. A copy in a locked drawer is drawn wearing a `Lock`:

- **the flattened wall's caption** — `WishFolderCaption` gained a `locked` prop, so the `Folder`
  glyph *swaps* rather than doubling (`CardGrid` budgets one line for that strip and positions its
  virtual rows from the budget), and the `sr-only` preposition leads with `Locked,` because a glyph
  is not an accessible name;
- **the table's Folder cell** — `CollectionTable.folderLocked`, a caller-supplied predicate in
  `quantityBlocked`'s way, drawing a `role="img"` glyph named `Locked`.

**History (2026-09-26):** both marks went with the surfaces that drew them — shelves draw no caption
under a tile, and `WishFolderCaption` itself was deleted in the branch's final review (W-M6) once
nothing drew it; the table dropped its Folder column because every row now sits under the band
that names its drawer (`columnsFor`'s doc in `CollectionTable.tsx`). A set-aside copy is marked
by its **shelf** instead: a locked folder's heading wears the `Lock` (`ShelfHeading`'s `Locked`
glyph), and the table's band is that same heading. The rest of this subsection is the record of the
two marks as they shipped on 2026-09-09. See [Shelves](#shelves-2026-09-26).

**The wall's mark answers on *any*, and the asymmetry with the caption beside it is deliberate.** A
tile merges every copy of one printing in one finish across drawers, so it can stand for a copy in
a display case and a copy loose at the root at once. `filedIn` refuses to *name* one of several
drawers, because naming one claims the others are somewhere they are not; `tileLocked` marks when
**any** of them is set aside, because the opposite failure is available there — a set-aside copy
quietly rejoining what the wall offers is the one direction this feature may not fail in, and it is
`folder_row`'s *"a `2` is locked"* reading arriving at a second site.

**What the table's glyph costs, measured.** The Folder column is a fixed `4.5rem`, so the lock
comes out of the folder *name* and out of nothing else. Measured 2026-09-09 over the shipped
`dist/assets/index-*.css` in headless Edge (a `file://` harness over the real `CollectionTable`
markup, at the four list widths the column's own header argues about — 616, 736, 936 and 1264):

| Row | Folder cell | Lock | Name box | Clipped |
| --- | --- | --- | --- | --- |
| at the root (`—`) | 72 px | — | 12.0 px | no |
| `Trade binder`, unlocked | 72 px | — | 67.6 px | no |
| `Display case`, locked | 72 px | 12 px | 56.0 px | yes |

Identical at all four widths, because the column does not flex. **The glyph costs the name
11.6 px and the cell absorbs it**: `scrollWidth − clientWidth` is **0** on the cell *and* on the
row at every width, so nothing spills and no horizontal scrollbar appears. What the reader loses
is about one character of a folder name — `Display c…` becomes `Display …` — against a
`whenClipped` tooltip that has always carried the whole of it. On a row that is set aside the lock
is the more important of the two facts, which is why that is paid rather than avoided.

**The wall's caption costs nothing at all**, and for a reason worth stating rather than measuring
again: the `Folder` glyph is *replaced* by `Lock` at the same `size-[calc(0.75rem*…)]`, and the
word that travels with it is `sr-only` — absolutely positioned, contributing no width. `CardGrid`'s
`CAPTION_HEIGHT` budget is therefore untouched, which is the whole reason the glyph swaps instead
of doubling.

**Both sides are effective-lock reads and neither re-derives it**, which is
[the inheritance rule](#the-lock-inherits-down-the-tree-and-is-never-stored-twice)'s standing
requirement: `CollectionPage` computes `lockedIds` once and hands it to the caption closure and to
the table's predicate, so the wall, the table, the folder badge, the two greyed menu rows and the
drag confirmation are six surfaces over one answer.

**The three-line trap for whoever revisits this.** Every test here has to assert the copy is
*present* **and** *marked*. One that asserted only the mark goes green over a wall that has lost
the row it was marking; one that asserted only the row goes green over the #365 behaviour with a
mark bolted on. `a locked drawer's copies, counted and marked` in `CollectionPage.test.tsx` is
written in those pairs and says so, and both marks were mutation-checked on the way in — flipping
`tileLocked`'s `some` to `every` and forcing `folderLocked` to `false` each turned the block red.

### The automated action the issue named had already been deleted

**The issue asked for exclusion "from all automated actions, such as moving cards into a deck folder
when they are added to a deck" — and the code it names had been deleted before the issue was
answered.** `addOwnedCopies` hunted the binder for a free copy when a card was added to a deck; it
went on **2026-08-25** with the own/need pair that was its only way in, and
`src/features/decks/useDeck.ts` carries its tombstone — the record is under
[Collection Search](#collection-search-and-the-first-caller-collection_to_deck-ever-had). Today
`deck::add_card` writes a `deck_cards` row and moves **no** `collection_entries` row at all, and
there is no path left that files a copy into a deck's group without the reader pointing at that copy
on screen.

**So the clause landed on `owned_spare` rather than on a fence, and it is written down here because
the next reader of this page will otherwise go looking for the fence that is not there.** The
general form of what the example was reaching for is *do not offer a set-aside copy*, and the one
statement that offers copies without anybody asking is the spare count behind the bracket estimate.
A guard on `deck::add_card` would have been a fence around a gesture nobody can make.

### The other `locked` in this cabinet, and which one changed its word

**`PinnedFolders.tsx` used *locked* first, and it means very nearly the opposite.** Its doc said the
app's own folders were *"pinned, flat and locked"*, where locked meant no rename, no delete, no move
and no `⋯` at all — because every write in `collection_folders.rs` that edits a *folder* refuses
one that is not `kind = 'user'`. A folder locked under #365 is still the reader's own drawer: still theirs to
rename, to move, to file cards into and out of, still dashed, still a drop target both ways, and
still carrying its full menu.

**The doc comment is what changed, not the feature's name.** A reader's menu says *Lock* and the
issue reporter said *locked*, so the column, the field and the UI keep the word; that paragraph's
third word became **fixed**, and it gained a sentence naming the difference.
[The pinned strip's own section](#the-apps-own-folders-in-the-card-menu) below carries the corrected
word. The reason is worth stating plainly rather than leaving to the rename: two meanings of one
word inside one cabinet is how a later reader concludes the pinned band is what #365 shipped — and
the folders that would then look set-aside are the app's own, which are the two kinds a reader may
not lock at all.

**Nor can they be locked, and that is the same fence rather than a new one.** `set_folder_locked`
opens with `user_folder`, so a deck's group and `Recently removed` refuse with `FOLDER_NOT_YOURS`
like every other folder write: a deck group is already fixed, `Recently removed` is a holding area,
and a lock on either would be a control with nothing to say. **Unlocking is likewise not always
visible**, and the menu is where that is answered: the write touches the folder's own flag only, so
clearing the flag on a child of a locked parent changes what the row says and not what the reader
sees — that row is greyed with its reason rather than reporting a success the badge contradicts.

**History (2026-09-26):** `PinnedFolders.tsx` draws nothing now — the strip became the `Decks`
shelves — and keeps only the vocabulary (`DECK_KIND`, `REMOVED_KIND`, `pinnedFolders`). The word
argument above holds for those shelves' headings unchanged. See [Shelves](#shelves-2026-09-26).

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
later stepped down — nothing refused it, because the deck's owned read (`owned_by_printing` now,
`owned_by_oracle` before 2026-09-07) applied
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

`collection_alloc.rs` holds the pair in the crate that moves a row across the deck boundary:

```text
         collection_to_deck                 deck_to_collection
binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
                                     ▲   ▲
        deck_pull_from_collection ───┘   └─── deck_quick_add_to_collection
        (moves cardboard that exists)         (records cardboard that did not)
```

**A third write joined them on 2026-09-03 and is deliberately not a member of the pair** —
`deck_pull.rs`'s `deck_pull_from_collection`, [issue #351](https://github.com/Msgaihede/mtg-grimoire/issues/351),
whose whole record is in [decks-storage.md](decks-storage.md#the-pull-filling-a-hole-the-list-already-has).
It travels the same left-hand arrow and writes **no** `deck_cards` row, which is exactly what
makes it a third thing rather than a bulk `collection_to_deck`: it only ever fills a hole a
`deck_cards` row **already declares**, so the number of copies the group holds rises to meet a
list that was already asking for them.

**A fourth joined them the same day and is the only one that does not move a row at all** —
`deck_quick_add.rs`'s `deck_quick_add_to_collection`,
[issue #350](https://github.com/Msgaihede/mtg-grimoire/issues/350), recorded in
[decks-storage.md](decks-storage.md#the-quick-add-recording-cardboard-nobody-had-written-down).
The other three take copies that are already somewhere and put them somewhere else; this one
**creates** the `collection_entries` row, filed in the group on the way in, for a reader who has
just bought the cardboard their deck was short of. That is why its arrow starts nowhere: there is
no source folder, and the total the reader owns actually changes — the one difference on this page
that reaches the search wall's Owned badge rather than only the census.

**A card reaches a deck's group only through those four, and every one of them answers for the
deck card behind the copies.** `collection_to_deck` writes that row; `deck_pull_from_collection`
refuses any pick the list is not already short of; `deck_quick_add_to_collection` refuses outright
unless the live list already plays the card. That is why `set_entry_folder` refuses a
`deck` destination and the page offers no ring on a deck group: a bare drag would file copies into
the group and leave the deck's list saying nothing about them — a placement with no deck card
behind it, which reads to the reader as cards that vanished into a deck that does not play them.
The refusal is the command's, not `refile_entry`'s; the write underneath carries no kind fence at
all, which is exactly what lets these file into the two folders a reader may not point at.

**The fourth write reaches the group through a different door, and that door now has two callers.**
The three above *move* a row, so they go through `refile_entry`/`take_copies`, which carry no kind
fence. A write that **creates** a row has to go through `collection::add_entry`, and that one
refuses a `deck` folder outright (`FOLDER_NOT_YOURS`) exactly as `set_entry_folder` does.
`collection::add_entry_filed` is the private door that takes the fence as a parameter and
`collection::DECK_WRITE_FOLDERS` — `user` and `deck`, and deliberately never `removed` — is the
widened set. **`import::commit_import` was its first caller and `deck_quick_add` is its second**,
and what each answers for is the same shape read two ways: the importer writes the deck's list in
the same press, so the list and the copies behind it arrive together or not at all; the quick add
checks that the list **already** says so, through the `deck::plays_card` fence issue #358 put on
`collection_to_deck`. Neither is a reader naming a folder they may not name, which is the thing
the public door exists to refuse. The constant carried the name `IMPORT_FOLDERS` until 2026-09-03
and was renamed with the second caller: a constant called `IMPORT_` that a non-import write passes
is a name that would have to be read past every time.

### And since 2026-09-03 the deck has to already play the card — issue #358

**`collection_to_deck` used to write the `deck_cards` row it needed, and now it refuses instead**
(`collection_alloc::NOT_IN_DECK`, *"That deck does not play this card. Add it to the deck first,
then file your copies."*). Filing is **assigning copies to a list**, not joining a card to a deck.
[Issue #358](https://github.com/Msgaihede/mtg-grimoire/issues/358) asked for it in the reader's own
terms — *"do not allow cards to be added to a deck folder in collection management if the card does
not exist in the deck itself"* — and the reason it is worth a fence rather than a habit is the
paragraph above read backwards: the invariant that makes a group meaningful is *every copy in a
deck's group is backed by a row in that deck's list*, and the one write that could create a placement
had been allowed to satisfy it by writing the other half itself. That is not wrong in the way a
bare drag is wrong — nothing was ever left dangling — but it made a **filing gesture** into a
**deck-building gesture**, and the reader who pointed at a drawer got a card added to a deck they
were not looking at.

**The match is on the oracle card** — `deck::PLAYED_KEY`, `coalesce(c.oracle_id, dc.card_id)` over
`deck_cards dc LEFT JOIN cards c`. A deck that lists the Commander 2021 *Sol Ring* plays Sol Ring,
so an Alpha copy in the reader's binder is a copy of something that deck plays; a printing-exact
fence would refuse the filing for a reason nothing on screen could explain. **The printing is the
fallback and not the other way round**: `cards.oracle_id` is nullable and a `deck_cards` row
outlives its printing leaving the corpus, so an orphan is matched by its own id — and a fallback
that reached for the printing *first* would silently make every match printing-exact, which is a
rule that looks correct on the one card anybody tests it with. **This answers a different question
from attribution — does the deck play this card at all, never which copies count toward it — and
until 2026-09-07 it was `release_group_copies`'s own fallback rule reused rather than re-spelled.**
Owned/missing narrowed to the exact `(card_id, finish)` that day, which made the fallback a bug
in `release_group_copies` rather than a fix — [decks-storage.md](decks-storage.md) carries the
whole change — so PLAYED_KEY is the rule's only home now.

**Live only.** Nothing is filed into a plan (`THEORY_HOLDS_NOTHING`), so a card the deck merely
*plans* to play is refused exactly as one it has never heard of is. Untouched by 2026-09-09's pool
split, which changed what a plan may **count** and not what it may hold.

**The fence sits after `touch_deck` and before the pile resolves, and the order is the rule.**
A gone deck still answers `deck::GONE` — *"that deck is gone"* and *"that deck does not play this"*
are different things to tell a stale editor — and the fence has to come before the `Pile::Name` arm
because that arm **writes**: a category nobody has made yet is created there, and a refusal landing
after it is the empty-column-after-a-failed-press defect the rollback exists for. Being asked first
means there is nothing to roll back rather than something rolled back correctly.
`a_filing_refused_by_the_folder_rule_leaves_no_pile_behind` is the pin, a sibling of the one that
was already there.

**One error-ordering change came with it and is deliberate**: `source_of` was hoisted up beside the
fence, so a caller sending a dead **entry** id *and* a dead **category** id now hears
`collection::GONE` where it used to hear `deck_meta::CATEGORY_GONE`. The entry is what the reader
pointed at, so it is the better sentence — and the only alternative is splitting the source read
from the fence, which puts the fence back after the writing arm.

**Two surfaces say it early, and both fail closed.** The deck editor's Collection tab greys a tile
whose card the open deck does not play, naming the Card search tab as the route; the card menu's
`Decks ▸` rows grey a deck that does not play it. Both read the census through
`useDeckPlays`/`useDecksPlaying`, and **an unanswered census greys everything** — `stepperByTile`'s
direction one page over, for its reason: "the answer has not arrived" and "the deck plays nothing"
are the same empty set, and only one of them may make a card pressable.

**What this does not reach is the drag.** A tile dragged from that tab into a deck column goes
through `deck_add_card`, which writes a `deck_cards` row and moves no copies at all — so it cannot
put a card in a deck folder and #358's invariant does not apply to it. It is the two-press route to
the same place: add the card to the deck, then file the copies, which is now the only order there is.

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

**A theory row is refused outright.** A theory list is a plan and nothing is ever filed into a
plan, so there is nothing in any folder to give back; the alternative is a press that reports
success and moves nothing, which reads as a card that vanished.

**The sentence is about custody and only about custody, which is a narrower claim than it was
until 2026-09-09** ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). This
paragraph used to end *"the same fact one level up is why `attribute_owned` zeroes every `theory`
row rather than serving it last"*, and that half is repealed: a plan's rows now count the copies
the reader could put behind them, out of a pool of their own
([decks-storage.md](decks-storage.md) carries the two pools). `THEORY_HOLDS_NOTHING` is what is
left, and it is exact — counting what could fill a slot is not custody of what fills it, and a
theory row still has nothing to hand over because it was never given anything.

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
  take.** Cut a card and press Ctrl+Z and the *older* change is reversed — the rename, the pile
  move before it — not the cut, **provided the deck still holds what that change left**. When the
  older change touched the card that was cut (the stepper's +1, the add), the press is refused
  (`RETIRED`) and that step is retired: its rows would bring back a card whose copies are in
  `Recently removed`. The label is honest the whole time; a keyboard user who never looks at it is
  the one this sentence is for. The rule is `deck_undo`'s, in
  [decks-storage.md](decks-storage.md).

  **The cost, stated plainly, and it got smaller on 2026-08-23.** A cut still cannot be reversed
  from the keyboard. What changed is that `collection_to_deck` — the write that restores **both**
  halves in one press — now has a caller: the deck builder's **Collection Search** tab. A deck
  group is still deliberately not a drop target (see
  [the fence](#the-two-writes-and-why-a-deck-group-is-not-a-drop-target)), so the recovery is not a
  drag; it is a press.
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

**Since 2026-09-03 there is a question asked _before_ that one, and it is about the card rather
than the copy** — issue #358. A tile whose card the open deck's live list does not play is greyed
with *"… is not in this deck — add it from the Card search tab first"*, whichever of the three rows
above its copies fall under. The two are deliberately **separate axes and not a fourth arm of
`CopySource`**, which is the shape decision worth recording:

* `CopySource` is a fact about a **copy** and `pickCopy` *ranks* it, so a `notPlayed` arm would
  have to be filtered like `here` — and a tile whose every candidate is filtered reads as
  `add === null`, which this tab already words as *"already in this deck"*. That sentence over a
  card the deck has never held is the one refusal a reader cannot act on.
* Both can be true at once and they say different things. *"Taking it from Mono-Red Aggro"* is the
  **cost**; *"add it from the Card search tab first"* is the **route**. One enum would force a rank
  between two unrelated facts.
* One is decided by a rule over rows, the other by the card's identity.

So `PlayState` (`plays | notPlayed | unread | unreadable`) sits beside `sourceOf` on the hook's
return, and the Add button's existing refusal ladder asks the census first, the fence second and
the copy third. **The tab is assign-only now**: it answers *which copies I own back this deck's
list*, and adding a card the deck does not play is the Card search tab beside it.

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

**It matched on the oracle card, not on the printing, until 2026-09-07 — the fix for a stranding
that a different function now prevents at the source.** `deck_swap_printing` and
`deck_set_card_finish` rewrite a `deck_cards` row's identity and touch no collection table, so
after "Use this printing" the group used to go on holding the *old* printing's row. Matched
exactly, the release then found nothing: the deck card went away and the copies stayed filed
under a deck that no longer listed them. Upgraded readers met it without pressing anything,
because the allocator v25 replaced matched candidates by oracle id and the conversion faithfully
filed a printing the deck did not list. The old arms were the exact printing and finish **first**,
then any other row in the group holding the same `cards.oracle_id` — `owned_by_oracle`'s "a Bolt
is a Bolt" read from the other end, since a deck that *counted* an Alpha Bolt toward an M10 line
had to be able to give that copy back.

**The fallback is a bug now rather than a fix, because owned/missing stopped counting that way on
the same day.** A deck may legitimately list both LEA Bolt and M10 Bolt, with the group holding
both; cutting the LEA line short and falling back to the oracle match would give back M10 copies
the M10 line still claims — the same stranding bug read in the finish dimension too, one arm
over. `deck::release_unclaimed_copies(tx, deck_id, variant)` is what replaced the fallback:
`swap_printing` and `set_card_finish` each call it, inside their own transaction, right after
rewriting a row's identity — sweeping the group for whatever the new identity does not claim at
`(card_id, finish)` and filing it into `Recently removed` before anything can strand. Reading the
*finished* list against the group this way answers the plain case and a folded swap
(`SwapResult.folded`) with one query, where a targeted release on the old identity alone would
have to reason about the fold to get the quantity right. `release_group_copies` narrows back to
the exact `(card_id, finish)` match and nothing looser, so the crate's one walk stops needing to
reach for the oracle card at all — the ordering that used to keep every cut of a card nobody ever
swapped exactly what it was now has nothing left to order. **The `LEFT JOIN cards` went with the
fallbacks**: the backing query reads `collection_entries` alone, on `folder_id`, `card_id` and
`finish`. The join was only ever there to hand the oracle arm an `oracle_id` to compare, and the
`LEFT` so that a row whose printing has left the corpus still matched the exact arm while the
oracle one degraded to `NULL`. With no arm asking for an oracle id there is nothing to join to,
and an orphan is *more* releasable than before rather than less — the deck row and the collection
row name the same `card_id`, so the match holds whether or not the corpus still knows the
printing.

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

### The honesty rule, and what v36 did to bring every file under it

> **A deck's group holds only copies its live list claims at `(card_id, finish)`.**

That sentence is what owned/missing's 2026-09-07 grain narrowing (above and in
[decks-storage.md](decks-storage.md)) and this section's sweep are both making true, and keeping
true. **"Claims" means every live `deck_cards` row, switched-off piles included** —
`attribute_owned` hands an inactive pile no copies, so it is tempting to read its rows as
claiming nothing, but then flipping a category off would *evict that pile's cards from the
deck*, turning a display switch into a press that moves cardboard. Custody follows what the list
**names**; the switch only decides what is counted. `release_live_copies` already works this
way — its query filters by `category_id` and never by `category_active` — so this is the file's
existing rule rather than a new one.

**Schema v36 is the one-time pass that brings every file made before 2026-09-07 under it.** The
v25 conversion "replaced matched candidates by oracle id, so the conversion routinely files a
printing the deck does not list" (above) — tolerable while the read counting a deck's copies was
the same oracle-grain match the conversion made, and no longer tolerable once the read narrowed:
every such file now has a group holding copies its list does not claim at the new grain. The rung
sweeps every `collection_folders` row with `kind = 'deck'` and moves what no live `deck_cards`
row claims into `Recently removed`, splitting a partly-claimed row rather than moving it whole —
the same shape `take_copies` gives every other release in this file. **It carries its own SQL and
its own arithmetic rather than calling `take_copies` or `release_unclaimed_copies`**, because a
migration step is history the day it ships and app code it called would silently change what an
old file is converted into the next time either function's logic moves — the v25 rung is the
model, and it inlines `take_copies`' split with both clamps for the same reason. The folder kinds
are spelled as the literals `'deck'` and `'removed'` rather than read through
`COLLECTION_FOLDER_KINDS`, for the reason `COLLECTION_GRAIN` is never interpolated into a probe:
a rung that read the constant would convert a v35 file differently the day the constant is
reordered.

**The copies land in `Recently removed` and not at the root, and where they land is
load-bearing.** `Recently removed` is ranked **second** in `deck_pull::CANDIDATE_SQL`'s
`ORDER BY CASE` — after the root, before the reader's own folders — so the first press of
`Import missing cards from collection…` offers those very copies straight back for every line
that genuinely matches them, and the lines that do not match are honestly missing. A reader who
upgrades is not left holding a state they cannot act on, which is what makes the rung acceptable
rather than merely correct. A missing `Recently removed` folder skips a deck's move rather than
failing the whole rung — a rung that errors blocks startup, and a hand-edited file without that
folder must still open.

**The residual is the same one the read side carries.** A device on an older build can still
push a `collection_entries.folder_id` that mismatches its own live list, and nothing runs this
sweep on a sync — `release_unclaimed_copies` is idempotent and cheap, so the state is curable,
but this design does not mechanise curing it. [decks-storage.md](decks-storage.md) names it as
a known gap rather than a mechanism, and it is named here for the same reason.

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
wanted that folder gone, and it is gone. **Two kinds of id are not**: a folder the app owns
(`FOLDER_NOT_YOURS`), and — since v33 — one the reader has set aside (`FOLDER_IS_LOCKED`, on the
*effective* lock, or `FOLDER_HOLDS_LOCKED`, on a lock anywhere in its sub-tree — both asked before
this function's own transaction opens). The second is this whole
section read as a refusal: what a delete does to a locked folder is scatter its sub-tree to the
root, which is exactly the filing the lock was protecting. See
[the lock](#the-lock-stops-the-app-offering-and-never-stops-the-reader-reaching); the "not there is
a success" rule survives being asked second because `effectively_locked` answers `false` for an id
nothing answers to.

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

**The workbench held a row that contradicted this until 2026-09-08**
([issue #425](https://github.com/Msgaihede/mtg-grimoire/issues/425)), and it is worth reading as
what the two simplifications above actually rest on. Neither reader checks the quantity; both are
licensed by the *absence* of zero rows, maintained by a different module. `.storybook/fake/`'s
`starter` seed carried one anyway — from before this reversal, under a comment stating the old rule
verbatim — so the fake and the crate disagreed wherever *owned* was asked as an existence question.
What that cost was one screen contradicting itself about one card: the combo panel's
`ComboPiece.owned` sums quantities while its *I own every piece* filter tests presence, both correct
against a healthy database, and against that fixture the two answered differently — **Not owned** on
a piece line inside a combo the same screen was offering as fully owned, with nothing erroring. The
symptom was closed by fencing `combos::OWNED_CTE` with `AND e.quantity > 0`, deliberately redundant
and documented as such; the fixture followed later. The measurement the rule is checked against is
the live dev database's **0 zero-quantity rows out of 276**, and the rule the fake now carries is
that a shared seed states what the app can produce and nothing else — a test that needs the
impossible row builds it locally. `.storybook/CLAUDE.md` has it, and `world.test.ts` sweeps every
seed for it.

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
removed` drew the number as plain text and said why. **`Recently removed` left that fence on
2026-09-24** ([issue #506](https://github.com/Msgaihede/mtg-grimoire/issues/506)) and a deck's group
did not; [Managing `Recently removed`](#managing-recently-removed--issue-506) below is why.

**Where it stands moved on 2026-09-03** —
[issue #348](https://github.com/Msgaihede/mtg-grimoire/issues/348) reported that the walls matched
the deck builder's control in neither style nor location, so both walls took the deck stack's
column: 36px, standing on end in the tile's right margin, through `CardGrid`'s `column` slot. The
fence below is untouched by that and is the half worth reading; the geometry is in
[frontend-design.md](frontend-design.md#one-quantity-control-on-a-card-face-on-all-three-surfaces-2026-09-03-issue-348).

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

**The predicate is positive, never a blocklist.** It names what may be stepped — the root, a folder
the reader made, and since issue #506 `Recently removed` — rather than "not a deck group", so a
fourth `collection_folders.kind` added later defaults to *fenced* rather than to editable. **Until
2026-09-24 it was `readersOwnLevel`**, `folderId === null || userFolderIds.has(folderId)`, the
shape the page's `canMakeFolder` already had for the `New folder` card, and the two read as one
rule about what a folder the reader made is allowed to do. **They are two predicates now, because
they answer two questions.** `readersOwnLevel` still answers *may something be filed here* — the
drop target and the `New folder` card — and `Recently removed` is still no destination, since
filing a copy into it by hand would assert that it left the collection without the write that
makes that true. The quantity predicate, `countEditable`, answers *may this count be changed from here*, and a copy
in `Recently removed` belongs to no deck, so nothing about a deck is changed behind the reader's
back by stepping it.

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

**History (2026-09-26):** both paragraphs above describe a wall that is gone. Flatten is deleted,
and since shelves a tile is one folder's, so no tile can mix a binder with a deck's group and
"every copy behind the art" and "the tile's folder" are one question (`stepperByTile`'s doc in
`CollectionPage.tsx`).
The fence itself is unchanged. See [Shelves](#shelves-2026-09-26).

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
| anything else fenced | `In <folder>. Move it into one of your own folders to change how many you hold.` |

**The table had a `Recently removed` row until 2026-09-24** — *"In Recently removed. Move it back
to your collection to change how many you hold."* — and it was deleted rather than reworded,
because since issue #506 a row there draws a stepper and has nothing to refuse.

**The last arm names no mechanism, and that is the fence's positive spelling showing through.**
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

## Managing `Recently removed` — issue #506

**2026-09-24, [issue #506](https://github.com/Msgaihede/mtg-grimoire/issues/506).** Until this date
`Recently removed` was a folder a reader could look into and drag out of and do nothing else to: no
stepper, no way to delete a copy there short of filing it back out first and deleting it where it
landed, and no way to empty it. A holding area that only fills is a pile, so three controls came at
once — and every one of them is fenced by the same distinction the copies control drew in the first
place.

**The fence was always about deck custody, and `Recently removed` holds no deck's cards.** A deck's
count is a `sum()` over its group, so stepping a group's copy from the collection page changes what a
deck holds from a screen that does not mention the deck — that is the whole of why the stepper was
fenced. A copy in `Recently removed` has already left its deck: `deck_to_collection` or
`delete_deck` cut the `deck_cards` row before filing it there, so no list reads it. Its count is the
reader's to change like any binder's. The old sentence for it — *move it back to your collection* —
sent the reader on a detour whose only purpose was to reach a control the fence had hidden for no
reason.

- **Steppers.** The quantity predicate grew `Recently removed` as a third positive arm (see
  [the copies control](#the-copies-control-belongs-to-a-normal-folder-in-both-views)). Stepping a
  copy there to zero deletes the entry, as it does anywhere — the same `collection_remove` write.
  **Deck groups stay fenced**, with their sentence unchanged.
- **`Remove from collection` in the card menu.** `cardMenu.tsx` takes an optional `removeCopies`
  dep and draws `Remove from collection` — `Remove N cards from collection` over a pick — only when
  it is wired; a surface that does not wire it draws no row, rather than a greyed one. The
  collection page wires it only where the quantity predicate holds for **every** row behind the
  target, and for every target in a pick: the root, the reader's folders and `Recently removed`,
  never a deck group, and never a flattened tile that mixes one in. One press removes every entry
  behind the tile through `collection_remove`, with no confirmation — it is the stepper taken to
  zero in one gesture rather than a new kind of write, and the activity feed records it the same
  way.
- **`Clear…` inside `Recently removed`.** Standing in that level, not flattened, with cards in it,
  a `Clear…` button sits beside the *Drag a card onto a folder…* sentence and opens a confirmation
  strip — the strip's shape, the wishlist's `Clear…` from issue #471 being the precedent. Confirming
  calls **`collection_removed_clear`** (`collection_folders::clear_removed`), which deletes every
  entry filed in the removed folder in one transaction, answers the entry count, writes one
  activity row for the whole clear, and refuses with `NO_REMOVED_FOLDER` when the folder is
  missing. It touches nothing in a deck group, nothing in a reader's folder, and no `deck_cards` row
  — a clear is not a way to change a deck. This one confirms where the menu row does not because it
  is aimed at the whole folder, not at the cards the reader is pointing at.

**History (2026-09-26):** "never a flattened tile that mixes one in" and "not flattened" describe a
state that no longer exists — Flatten is deleted and no tile mixes folders — and the
*Drag a card onto a folder…* sentence went with the folder band. `Clear…` sits on the path row
beside `ShelfToolbar` while the reader stands in `Recently removed` (`inRemoved` in
`CollectionPage.tsx`).
The `New folder` card and the pinned strip the next paragraph names are gone as well: Add folder
is on the path row and on the reader's own headings, and a `Recently removed` heading carries no
`⋯`. See [Shelves](#shelves-2026-09-26).

**`clear_removed` is the first write aimed *at* `Recently removed` by the reader, and it did not
open the folder to edits.** The folder is still no destination (`readersOwnLevel` still answers the
drop and the `New folder` card, and `set_entry_folder` still refuses a `removed` destination), still
cannot be renamed, moved, deleted or locked, and the pinned strip still carries no `⋯`. What the
reader may now do is empty it — which deletes entries, and leaves the folder standing for the next
cut.

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

**History (2026-09-26):** the tile and the `Recently removed` substitution are both gone with the
folder band. Moving a copy or a folder up is a drop on a path segment, and #209's drag back into a
binder happens at the root, where `Recently removed` is a shelf beside the binders' headings — see
[Shelves](#shelves-2026-09-26), which records that move.

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

**History (2026-09-26):** the `New folder` tile and the folder cards are gone. **Add folder** is on
the path row and on every heading of the reader's own folders, the name is typed on the heading
where the folder will appear, and Rename is a button on the heading — see
[Shelves](#shelves-2026-09-26). The strip still holds `Move to folder…`, `Delete…` and `Clear…`.
The `openPanel` level clause below lost its `flatten` arm and became `onThisWall`: a naming field
closes when its heading is no longer on the wall (`onThisWall` in `CollectionPage.tsx`).

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
`readersOwnLevel` reaching a third control — the filing predicate, which issue #506 split from the
quantity one precisely so `Recently removed` could draw steppers and still grow no folder: a fourth
`collection_folders.kind` added later gets **no** naming tile by default, rather than one whose
only outcome is `FOLDER_NOT_YOURS`.

**The pinned strip is untouched for the same reason it carries no `⋯`.** Its cards are the app's
own folders and every write in `collection_folders.rs` that edits a folder refuses them, so there
was never a rename on one to move — the argument is §"The app's own folders in the card menu"'s,
unchanged. Issue #506's `Clear…` does not dent it: that button empties the folder's *entries*, and
it stands in the level the reader has walked into, not on the pinned card.

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
| The folder is set aside | `That folder is locked. Unlock it before deleting it.` (`FOLDER_IS_LOCKED`) | `delete_folder` only, on the **effective** lock |
| A folder inside it is set aside | `A folder inside that one is locked. Unlock it before deleting this one.` (`FOLDER_HOLDS_LOCKED`) | `delete_folder` only, on any folder in the sub-tree it re-files |

The first two are borrowed from `deck_meta` rather than re-spelled — a reader who has met "That
folder is not there any more." in the deck gallery and on the wishlist must meet the same sentence
here, and `deck_meta::CATEGORY_WRONG_DECK`'s doc is the standing rule that a second copy of a
refusal is a second thing to drift.

**`FOLDER_HOLDS_LOCKED` is the lock refusal read downward**: the delete re-files every folder
beneath the one pressed, so a locked `Binder/Graded` is scattered by deleting `Binder` exactly as
by deleting `Graded`. It asks the same `doomed` sub-tree the re-filing walks
(`DOOMED_FOLDERS`), and the menu greys `Delete…` with *a folder inside it is locked* before the
press can reach it.

**The last four are local, because each is a fact this cabinet has and the other two do not.**
`deck_folders` and `wishlist_folders` carry no `kind` column at all and no `locked` one either, so
there is no sentence in either module to reach for. And the schema could not say any of it anyway:
the DDL CHECKs that a `deck` folder names a deck and that the kind is one of three, but nothing in
it says who may *edit* a row, or whose copies a row is holding, or which drawer the reader has set
aside — and a CHECK that could would fire as `CHECK constraint failed: collection_folders`.

**`FOLDER_IS_LOCKED` and `FOLDER_HOLDS_LOCKED` are on exactly one write, and the narrowness is
the decision** ([the lock](#the-lock-stops-the-app-offering-and-never-stops-the-reader-reaching)):
a delete scatters the whole sub-tree to the root and undoes the filing the lock was protecting —
whether the lock is on the folder pressed, above it or below it — where rename and
move disturb no card at all and `set_entry_folder` must go on filing copies in and out — the issue
asked for that in as many words.

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
- **`refile_entry` carries no such fence**, and the absence is deliberate: it is what lets the
  three writes that *move* a row across the deck boundary — `collection_alloc.rs`'s pair and
  `deck_pull_from_collection`, all three through `take_copies` — and `deck::delete_deck` file into
  exactly those two folders. (The fourth, `deck_quick_add_to_collection`, creates its row instead
  and reaches the group through `add_entry_filed`'s parameterised fence, one section up.)
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

**History (2026-09-26):** neither half of this heading is true any more. The root draws every card
the reader owns — Not sorted first, then every folder as a shelf — and Flatten is deleted. The wire
this section designed is unchanged and its table still describes `CollectionQuery` exactly; the
page asks with `shelves` instead. See [Shelves](#shelves-2026-09-26), directly below.

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

## Shelves (2026-09-26)

**Since 2026-09-26 the wall at any level is every card at and below it, one shelf per folder.**
The design is
[2026-09-26-folder-shelves-design.md](../superpowers/specs/2026-09-26-folder-shelves-design.md),
and every *why* this section does not repeat is there. Until then every level was a drill-down that
drew a folder's **direct** members and nothing below it — the root sent `rootOnly: true` whenever
Flatten was off — so a reader who filed everything stood on a page holding a band of folder cards
and no cards at all. The sections above that describe that wall (the folder band, the `New folder`
tile, the up-one-level tile, the pinned strip, Flatten) are the record, and each carries a
**History (2026-09-26)** line pointing here. The wishlist took the same wall the same day; what is its own is in
[wishlist-folders.md](wishlist-folders.md#shelves-2026-09-26).

**Vocabulary, fixed by the spec so it cannot drift.** A **shelf** is one folder's section of the
wall: its **heading** and the cards filed directly in it. **Not sorted** is the shelf of copies
filed in no folder — `UNFILED_SHELF` in TypeScript (`src/lib/shelves.ts`), `0` on the wire — and
the only shelf that is not a folder. The button is **Add folder**, never "New folder".

### What the wall is

`buildShelves` (`src/lib/shelves.ts`) decides the whole order, and it is TypeScript's:

- **At the root, Not sorted comes first**, and is drawn only once the counts say it holds
  something (`visibleShelves`). **Then the reader's folders, depth-first** — a shelf
  before its subfolders' shelves, siblings in `buildFolderTree`'s `sortOrder, name, id`. **Then, at
  the root only, the app's own under a `Decks` label**: every deck group by name, then `Recently
  removed`.
- **Inside an opened folder** the level's own cards come first under no heading, because the path
  row already names the folder — a `headless` shelf, never collapsed — and its
  subfolders follow, starting again at depth 0. No app-owned group is drawn below the root.
- **Collapse starts from the kind** (`defaultCollapsed`): a reader's folder and Not sorted
  open, a deck group and `Recently removed` shut, because they are built decks and a holding area
  rather than binders. The reader's own overrides are one `app_meta` row, `shelf_folds`, kept
  [per window](multi-window.md#app_meta-which-rows-follow-and-which-stay). **Any active search or
  filter suspends collapse and writes nothing**: every shelf with a match opens, every shelf with
  none is hidden, and a folder whose matches are all below it keeps its heading as their container.
  **The fold controls say so rather than going quiet** (the final review's C-I2): while a filter is
  on, a heading's chevron, **Expand all** and **Collapse all** are `aria-disabled` with the reason
  *Folding is paused while filtering* as their description (`FOLD_PAUSED_REASON`, handed to
  `ShelfToolbar` and every `ShelfHeading` as `foldPaused`), stay in the tab order, and a press
  writes nothing. Until then the chevron here stored a fold the reader could not see, and Expand
  all and Collapse all wrote on both pages. Driven on 2026-09-27 (debug build, re-check 2): on both
  pages all three were `aria-disabled` and still tabbable, the sentence showed on hover and on
  keyboard focus, clicks and an Enter changed nothing, and `app_meta.shelf_folds` was
  byte-identical afterwards.
- **Indentation stops at three levels** (`MAX_SHELF_INDENT`); a deeper heading keeps the
  third level's indent and names its path from the ancestor on the cap. `SHELF_INDENT_PX` is 32 per
  level on the grid and the table alike (`SHELF_INDENT_PX`, `src/lib/shelfLayout.ts`).
- **An empty folder is a heading over a dashed drop box, and only a reader's folder with nothing
  drawn inside it gets one** (`layoutShelves`). A folder whose cards are
  all in its subfolders draws its heading and no box; Not sorted, a deck group and `Recently
  removed` never draw one.

**The path row** is the breadcrumb on the left and `ShelfToolbar` on the right — **Add folder**,
**Expand all**, **Collapse all** — with Add folder gated by
`canMakeFolder`, which is `readersOwnLevel` exactly as the `New folder` tile was. Expand
all and Collapse all reach every shelf below the level, app-owned ones included, and skip the
headless one, which has no chevron to reopen it with (`foldAll` in
`collectionShelfModel.ts`). **A reader's-folder heading carries Add folder, Rename and `⋯`;
a deck group or `Recently removed` heading carries its chevron, its title, its figures and its
`→` and nothing a press could be refused for**, because every folder write refuses those two kinds in words
(`headingFor` in `CollectionPage.tsx`). Not sorted has a chevron and plain text. Add folder
draws a heading whose name is the naming field, last among its siblings, under the id
`NEW_FOLDER_SHELF` (`-1`, `collectionShelfModel.ts`), which never reaches the wire. The field is
`FolderNameField` at `size="heading"`: a 36px frame inside the 40px row, with ✓ and ✕ on the
row's centre line.

**A heading's name folds its shelf, and the way into the folder is a `→` at the row's far right**
(issue #599, 2026-09-28), which reverses the spec's decision 6 (*clicking a folder's title opens
it; there is no Open button*). Readers aimed at the name to fold a shelf and were walked into the
folder instead, and the 24px chevron beside it was the smaller target of the two. So the name is
a second fold control — `aria-expanded`, refused with the chevron's `aria-disabled` and
`FOLD_PAUSED_REASON` while a filter is on, but never dimmed, since greying every name under every
filter costs the wall its legibility — and hovering it lights the chevron (a named `group/shelf` on
the row, `group-has-[[data-shelf-title]:hover]` on the chevron), so the reader sees they are one
control. **Open** is a ghost `SHELF_ICON_BUTTON`, named `Open <folder>` with the tooltip *Open
folder*, drawn on every heading but Not sorted's — deck groups, `Recently removed` and managed
wishlist folders included — and **last in the row, after the `⋯`**, so it stands in one column
whether or not a heading carries Add folder, Rename and a menu. **The lead segments of a heading
past the indent cap still open their ancestors**: they are a path rather than this shelf, and are
underlined on hover as links where the name is not. **The chevron went from 24px to 32px** around a
20px glyph — the most the 38px content box holds with a pixel either side — and
`SHELF_RAIL_OFFSET_PX` moved from 11 to **21** with it (`1 + 4 + 16`: the row's border, its `px-1`
and half the chevron). 11 had been written as *under the parent chevron's centre* and was 6px left
of the 24px one's; it would have been 10px left of the new one. **A create clears any fold stored under the id it answers** (the final
review's R-M2): `collection_folders.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so a new
folder can be handed a deleted folder's id, and would otherwise open shut, or open, the way the
deleted one was left. A create whose id has nothing stored writes nothing to the folds.

**The status line above the path row keeps its slot** — `min-h-4 text-xs`, silent or not, still
`role="status"` — so the `Updating…` a write's refetch shows for 40–80 ms moves nothing below
it. The live re-check (2026-09-26, debug build) found that 16px line coming and going after every
write and throwing the grid's reveal 16px off through Chromium's scroll anchoring — and, very
likely, the fold anchor's three drops that settled 16px low, which carry the same signature. Both
pages spell it the same. **Re-check 2 confirmed both** (2026-09-27, debug build): through a far
Move up the wall's page offset held at 262 in every frame while `Updating…` showed, and the three
drops that had settled 16px low landed exactly where they were released (503/503 and 371/371 here,
419/419 on the wishlist).

### The wire: `shelves`, an ordered list the crate never builds

`CollectionQuery::shelves: Option<Vec<i64>>`, serde-defaulted to `None`, beside `root_only` in
`collection.rs`. **Present, it replaces the folder question outright**: `folder_id`, `root_only`
**and `exclude_locked`** are not read, which is `root_only`'s own named-folder rule applied to a
list. Rows come back in **list position first**, then the reader's sort, then the `e.id` tiebreak.
`0` names the unfiled shelf, an id no folder answers to matches nothing and refuses nothing — a
folder deleted in another window is a shelf with no rows — and an empty list answers nothing
rather than everything. **Absent is the old answer byte for byte**: the plain-text mirror, *Export
everything*, the importer and the deck builder's Collection Search send no list and kept their
behaviour untouched — and the share snapshot never reads through this query at all.
`shelves_win_over_folder_id_root_only_and_exclude_locked`,
`an_unknown_shelf_id_returns_no_rows_and_no_error` and
`a_query_without_shelves_answers_exactly_what_it_did_before` are the fences.

**The page sends two lists** (`useCollection`). The list query asks for the shelves
drawn **open** (`shelvesToFetch`) — a shut shelf's cards, and those of every
shelf under it, are never fetched. The summary, the counts and the export sweep ask for **every**
shelf at and below the level, shut ones included (`shelvesToCount`, riding
`filters`). So `Cards`, `Unique`, `Value` and `For trade` describe the whole wall
whatever is folded, and Export pressed inside a folder exports that folder and everything under it,
which is what is on screen. Nothing is asked until the folder census answers (`censusReady`): before
it the list would be Not sorted alone, the empty page drawn for one round trip.

**No app code sends `rootOnly: true` any more.** The field stays on the wire and its default is
still what keeps an unasked query wide; the only senders left are two `CollectionPage.stories.tsx`
fixtures that read the root the way any other caller would.
[The three-state table](#the-wire-was-widened-not-flipped-and-that-was-the-whole-design) still
describes the query exactly. It no longer describes the page.

**Why TypeScript builds the list** is the spec's decision 10, and
[`folder_summary`'s rule](#folder_summary-answers-direct-counts-and-no-row-at-all-for-an-empty-folder)
one step further: the tree already lives in `buildFolderTree`, and SQL orders siblings
`sort_order, id` where the tree orders them `sortOrder, name, id`. With the list arriving from one
side, only one of them ever decides.

**Two statement shapes, decided in Rust from the list itself** — the measurement below is why.
`collection::shelf_term` asks `e.folder_id IN (SELECT j.value FROM json_each(?))` when the list
leaves out `0`, which `idx_collection_folder` can search, and keeps `shelf_member`'s
`coalesce(e.folder_id, 0) IN (…)` — a scan — when the list names `0`, because only the `coalesce`
finds a NULL and every index plan measured for that list lost to the scan. The position is
`shelf_position`, an `instr` over one bound comma-wrapped string (`,3,0,12,`, from `shelf_order`)
whose first occurrence keeps a shelf named twice at its first place. Each binds one string whatever
the list's length, so a statement's text does not vary with it and nothing a caller sent is
interpolated. The wishlist shares all three over `w.folder_id`: `wishlist::wishlist_scope` calls
`shelf_term`, and `wishlist::list_statements` binds `shelf_order` for `shelf_position`. Both
halves are fenced where the page runs them: `a_list_without_the_unfiled_shelf_is_searched_through_the_folder_index`
asserts `EXPLAIN QUERY PLAN` on `list_entries`' own count and page statements, and
`a_list_naming_one_shelf_twice_answers_its_first_place` pins the first-occurrence rule — each with a
wishlist twin. **The peeks call `shelf_term` too since the final review (R-M3)**, on both pages:
`fill_peek` builds its statement for the shelves the counts answered, so a peek inside a folder
searches `idx_collection_folder` where it used to scan the table through `shelf_member`'s
`coalesce`. `a_peek_without_the_unfiled_shelf_is_searched_through_the_folder_index` pins its plan,
and `a_wishlist_peek_without_the_root_is_searched_through_the_folder_index` the wishlist's.

### `collection_shelf_counts`

One `ShelfCount` per **non-empty** shelf, over `scope` — the search and every filter included, so a
count and the list it sizes describe the same rows (`collection::shelf_counts`). The struct is
defined once in `collection.rs` and `wishlist.rs` imports it, `BreakdownRow`'s arrangement.

| Field | On the collection |
| --- | --- |
| `folderId` | the shelf; `0` is Not sorted |
| `tiles` | `count(DISTINCT card_id \|\| '/' \|\| finish)` — what the wall draws for that shelf |
| `copies` | `sum(quantity)` |
| `value` | `sum(quantity × unit price)` at the query's marketplace; `null` when nothing in the shelf is priced, never `0` |
| `unpriced` | the unpriced entries' **copies** — the unit of the heading's `42 cards` and of `CollectionSummary::unpriced` |
| `peek` | up to `SHELF_PEEK` (4) card ids, one per printing, by card name then id — **unfiltered** |

**It is what places every heading before a page of cards has arrived**: `layoutShelves` sizes each
shelf from `tiles`, and a slot whose page has not landed draws an empty 5:7 frame. It is also what
hides a shelf with no match under a filter, and what a heading's figures are summed from. **A
heading states its subtree, not its own row** — `rolledUp` adds every shelf's count into each of
its ancestors (`collectionShelfModel.ts`), so a folder whose cards are all in subfolders does
not read `0 cards` over twelve — and under a filter it reads `3 of 42 cards`, the `42` coming from
`collection_folder_summary` plus `subtotalsOf` (`shelfStat`). **The peek is the only
picture a shut shelf has**, because its cards are never fetched: `fill_peek` answers every shelf in
one `row_number()` window statement, and `peekOf` walks the shut shelf and everything under it.

### A tile is one folder's: the eleventh term reaches the wall

**The grain has carried the folder since v24, and the wall did not until shelves** (the spec's
decision 11). [The wall's grain](#the-walls-grain-is-the-printing-and-the-finish) was the printing
and the finish, and the folder was one of the terms that merged, so one tile could carry copies from
a binder and from a deck's group at once. **A tile now belongs to one shelf.** Its key is
`tileKeyOf(cardId, finish, folderId)`, spelled `` `${cardId}:${finish}@${folderId}` ``, where a copy
filed nowhere reads `@unfiled` and `null` and `0` are one key (`src/lib/tileKey.ts`; the
`tiles` memo in `CollectionPage.tsx`). **The ring key is `tileKeyOf(cardId, finish)`, with
no folder** (the tile's `ringKey`), compared by `CardGrid` against a `selectedId` the page builds
the same way — so opening a card rings **every** tile of that printing on screen, one per shelf.
**The third argument is optional and absent is byte-identical**, which keeps `collectionTiles.ts`'s
`foldCopies` — the deck editor's docked collection column, a wall with no shelves — merging across
folders as it always has.

What that retired, and what it did not:

- **The stepper's "every copy behind the art" clause** ([the copies
  control](#the-copies-control-belongs-to-a-normal-folder-in-both-views)) can no longer meet a mixed
  tile: every row behind a tile shares its folder, so "every row" and "the tile's folder" are one
  question (`stepperByTile`'s doc in `CollectionPage.tsx`). The loop still asks per row,
  which costs nothing.
- **`Remove from collection`'s "never a flattened tile that mixes one in"**
  ([issue #506](#managing-recently-removed--issue-506)) is the same clause from the menu's side and
  went the same way.
- **The lock mark moved to the heading.** #436's two marks — the flattened wall's caption and the
  table's Folder cell — went with the surfaces that drew them, and a locked folder's heading wears
  the `Lock` (`ShelfHeading`'s `Locked` glyph).
- **Not retired: a tile is still several rows.** Condition, language and the grain's other terms
  still merge, so a drag still
  hands a folder every row behind the art and `PickCopies` still asks which; its folder column now
  reads one drawer down the whole list.

### Flatten was deleted, not hidden

The spec's decision 2: keeping Flatten as a "no headings" mode was weighed against Shelves being
the only way either wall is drawn, and lost. The root now puts every card on screen, which was the
whole of what Flatten was for, and a second drawing of the same cards is a second set of answers to
which copies a control reaches. **Deleted in `6fb98daa`**: `FilterBar`'s `flatten` prop, the store's
`collectionFlattened` flag (it started `true` here and `false` on the wishlist),
`useFlattenPersistence`, the `flatten_state` / `set_flatten_state` commands and the whole
`src-tauri/src/flatten.rs` module. **The `app_meta` row they kept, `flatten`, is read by nothing now
and deleted by nothing either** — no rung was owed for a key nobody asks for. What survives is the
wire: `CollectionQuery::root_only` and `WishlistQuery::flatten` stay fields, and the wishlist's
*Export everything* still sends `flatten: true`.

### One behaviour moved rather than survived: #209's drag back

**Standing inside `Recently removed`, the wall used to substitute the reader's own top level for its
own children**, so a copy that had just left a deck could be dragged straight back into a binder
([the section that recorded it](#the-way-back-up-is-a-tile-on-the-wall-and-inside-recently-removed-it-is-the-target-that-was-missing)).
Shelves has no band to substitute into, and a level draws what is at and below it. **The same drag
now happens at the root**, where `Recently removed` is a shelf under `Decks` on the same wall as
every binder's heading: open it and drag from it onto a heading. It starts shut, so the gesture is
one chevron press longer than it was.

### A folder drag folds the wall, on the grid only

A reader's folder is moved by dragging its heading — before, inside or after by `folderDrag.ts`'s
vertical edge zones — and Move up / Move down in the `⋯` are the non-drag path. **For the length of
that drag every shelf folds to its heading** (`foldedForDrag` in `collectionShelfModel.ts`), a
render-time override that writes nothing.

**The carried heading stays under the pointer through the fold, the unfold and the drop, and the
wall keeps it there rather than the page.** `useFoldAnchor` (`src/features/shelves/useFoldAnchor.ts`)
is the page's half: it records the press, the pointer and the fold into `shelfCarry`
(`src/features/shelves/shelfCarry.ts`), which is module state because there is one pointer.
`CardGrid` is the wall's half. It answers each `ShelfAnchorRequest` from its own layout
(`rowStartOf` and `anchorPlan`, in `src/lib/shelfLayout.ts`), keeps the carried heading's row drawn
whatever its virtual window says, and adds temporary room where a folded wall is too short to put
the heading at the pointer. After a drop it goes on re-anchoring the moved heading as the new order
arrives, for up to `SETTLE_MS` (2 s); a wheel, a key or a press ends that sooner.

**Why the wall is a live-pass finding** (FAIL 4, 2026-09-26, debug build). The anchor was first a
page-side scroll by the heading element's measured box, and it failed three ways at once. During a
drag dnd-kit promotes that element to a `position: fixed` copy at the pointer, so its box is never
its slot. The fold's own render still used the old scroll offset, so the heading's row was
virtualised away in that very commit, which also lost dnd-kit's feedback element. And the page's
layout effect runs after the wall's. `shelfCarry`'s own doc carries the argument, and
[the live record](#folder-shelves--four-passes-2026-09-26-and-2026-09-27) has the
figures before and after. **A moved heading gets no drop animation** (`useShelfDragSource` passes
`folderDraggable` `animateDrop: false`): dnd-kit aims its floating copy at the slot measured when
the drag began, which a far move has already re-laid out, so the copy slid away from the heading for
2–4 frames (live re-check, new finding 3). Re-check 2 (2026-09-27, debug build) found the copy gone
from the first frame after the release in four far drops on both pages.

**The room below a folded wall is measured from the end of the wall's own rows, not from the end
of the page** (re-check 2's finding A, 2026-09-27, debug build; fixed in `2ece040d`). Both
cabinets set the wall in a flex row beside the docked search column, whose dock is
`sticky top-0 self-start` and made as tall as the scrollport by `useDockHeight` — and it keeps
that height when the panel collapses to its rail. A folded wall shorter than that row sat in a row
the dock decided: 766px of folded wishlist in a 988px row. Room added after the wall grew the wall
inside the row's slack, `main`'s scroll end never moved, and the virtualiser clamped the fold at
scrollTop 222, so a heading pressed at y=512 near the end of the wall was held 78–126px under the
pointer for the whole drag (Escape still ended exact). The collection escaped only because its
folded root, 1,289px, is taller than the row; a shorter cabinet had the same failure waiting.
`anchorPlan` now takes an optional `end` — where the wall's own rows end in the scroll content,
which `CardGrid` passes as `rowsTop + layoutHeight(…)` and which defaults to `content` — and
sizes the room below as `max(wanted − most, wanted + viewport − end)`, so the rows reach the
scrollport's bottom at the wanted offset whatever stretches around the wall. The second half of
the same mechanism: once the row has swallowed room, the page less the whole room underestimates
the page, so a request that may add room takes the whole room off, and one that may not — an
Escape, an unfold — leaves it on and lets the browser's own end clamp it.

**Re-check 3** (2026-09-27, debug build, at `2ece040d`, 3 of 3 pass): the same wishlist press
folded to scrollTop 300 with the slot at 518, the pointer's 518, held through a 150px hover, and
ended with Escape at 374/374 and a drop at 419/419. A short cabinet staged inside `Binder`, its
last heading pressed at y≈300, folded to 416 with the slot at the pointer's 306, where the old
arithmetic would have clamped it about 194px low; Escape 462/462, drops 371/371 and 757/757. The
collection root's deep folds and drops stayed exact. After every unfold the page's height and the
wall's end were what they had been before the press. What the room costs is blank space below the
last folded heading for the length of the drag — about 350px on that wishlist and 746px in that
cabinet.

**Known and accepted: an Escape at the very end of a level can come back 2px short** (re-check 2's
finding C, 2026-09-27, debug build). `Recheck CT`, the last heading of `Binder`'s level, returned
at 897 against a pointer of 899; every other Escape in that pass and in re-check 3 landed exactly
on the pointer.

**The table does not fold** — the page hands `useFoldAnchor` `false` there — because `VirtualTable`
keys its rows by position, so folding under a carried heading would remount it and end the drag.
**It keeps the carried band drawn instead** (the final review's S-I3): the page reads the drag in
flight (`useDragRecord` and `readFolderDrag`) and passes that band's index as `VirtualTable`'s
`keepRow`, which a `rangeExtractor` keeps in the rendered range however far the table scrolls.
Without it, a band dragged past the overscan unmounted its own drag source. The table's paging rule
reads the virtual window's own last row, never a kept row parked below it. Driven on 2026-09-27
(debug build, re-check 2): a band carried up through about 3,800px of autoscroll stayed connected,
with its floating copy, the whole way, and landed where its `before` line said.

### The table draws bands, and stops at the edge of what has loaded

The same shelves, as heading rows spanning every column — `VirtualTable`'s `band` — with the sticky
bar pinned under the column header (`stickyBand`). **While pages remain, `shelvedRows` stops after
the shelf holding the last loaded row** (`shelvedRows` in `CollectionTable.tsx`). A shelf's count is
in *tiles* and the table draws *entries*, so the edge is found from rows; without it every later
band stood over rows that were not there, and `VirtualTable`, which asks for the next page when the
rows it has drawn run low, counted those bands as rows and asked late. The wishlist's `shelfTable`
reached the same rule first.

**A heading that has to be shown past that edge is paged to** (the final review's C-I1). The page
names it as `revealShelfId`: Add folder's draft, or a heading a caret request is waiting for. While
the layout holds that shelf, its band is not among the drawn rows and pages remain, an effect asks
for the next page, and asks again as each lands. Before this, Add folder on any list longer than a
page drew no field at all in the table, while the invisible field still held the Escape rung, and
later paging mounted it and pulled the caret and the scroll with it.

### The banded table's focus, reveal and Top

Four things about a table with a sticky band, all `VirtualTable`'s
(`src/components/table/VirtualTable.tsx`) and all shared with the wishlist:

- **The tab stop is the element that scrolls.** A band holds buttons and a drop target, and a
  `role="table"` may own only rows and row groups, so with `stickyBand` the scroller becomes a
  `role="group"` named by the table's label, with `tabIndex={0}`, and the table is no longer a
  stop. A Tab onto it scrolls nothing. The first live pass measured a Tab onto the inner table
  moving the list 855 → 191; the re-check measured 855 → 855.
- **The table draws its own focus frame**, `FRAME_FOCUS`: a 2px accent outline at a −1px offset,
  straddling the 1px border, on whichever element is the frame, the scroller and the stop in that
  shape. Until then the table drew only the base layer's `outline: auto` around the inner table,
  whose top edge sat under the sticky header and whose bottom was thousands of pixels down the
  scroll: two faint 1px lines, which is no focus indicator (WCAG 2.4.7, first pass check 11). The
  scroller also takes a `scroll-padding-top` of the header plus the band, so a row that takes focus
  comes to rest clear of both.
- **`revealIndex` scrolls a row into view and never moves focus.** The page passes the band of a
  heading a caret request is waiting for, or of Add folder's draft, which a virtualised table has
  not mounted. It lands clear of the header and the band, and the heading then takes the caret
  itself as it is drawn ([the caret a heading is owed](#the-caret-a-heading-is-owed)).
- **Top hands the caret on rather than dropping it** (the final review's S-I1). The page draws no
  bar over a heading, so Top landed the list on the first heading, the bar unmounted with the caret
  inside it, and the caret fell to `<body>`. Now a caret that fell is handed to the first control
  of the row at the header's edge — the first heading's chevron — or to the scroller where that row
  has none. A caret that anything else claimed in the same commit is left where it is. Re-check 2
  (2026-09-27, debug build) pressed Top by click and by Enter, in the table and the grid on both
  pages: 8 of 8 left the caret on the first row's chevron at scrollTop 0.

### The grid: the sticky bar's room, Top, and a caret across a zoom

- **The sticky bar's height is one number**, `SHELF_STICKY_HEIGHT` (36, `src/lib/shelfLayout.ts`).
  `ShelfStickyBar` takes it as its inline height and a sectioned `CardGrid` reserves it as the
  virtualiser's `scrollPaddingStart`, so a revealed or walked-to row lands below the bar rather than
  half under it (the final review's S-M2). In re-check 2 (2026-09-27, debug build) the headings the
  re-check had found half under the bar landed flush under it at 128–168.
- **A revealed heading brings its empty box with it.** When the row after the heading is that
  shelf's empty box, the wall scrolls to the box — except for a heading above the window, where
  aligning the heading to the top already brings the box in under it (S-M5).
- **Top hands the caret on** (S-I1, the grid's half). The bar unmounts at scrollTop 0, so a caret
  in it fell to `<body>`. Now, once the bar has gone, a caret that fell moves to the first control
  of the wall's first row, with `preventScroll`.
- **A focused tile keeps the caret through a zoom that changes the column count.** The first pass
  lost it across a column change (FAIL 6: tile 6 here, tile 18 on the wishlist). The fix wave kept
  it for a tile whose row stayed drawn but not for one deep in the wall: in the re-check, tile 63
  lost it and the page scrolled to the tile with the caret on `<body>`, because the one retry was
  spent by the tile-height `measure()` commit before the scroll event drew the row. `caretChase`
  replaced the retry (S-I2). The tile is re-checked on every commit until it is drawn, the
  reader's caret moves elsewhere, the tile leaves the list, a new re-layout happens, or
  `CARET_CHASE_COMMITS` (8) run out. A focused tile whose row stayed drawn but ended off-screen (the
  re-check's tile 40, at −491…−175) is scrolled back into view after the column change
  (`keepInView`). **Re-check 2** (2026-09-27, debug build): tile 63 kept the caret through one
  Ctrl+wheel step (scrollTop 6192 → 5070, the tile at 128–444), and so did the wishlist's tile 60.
  The caret landed on the third React commit after the wheel on both pages, against the budget of
  8, and tile 40 came back into view at 128–444.

### The level on screen trails the level asked for

**Walking to a level nothing has cached draws the previous level whole until the new one has
answered, then switches in one render.** `useCollection` keeps the last level whose figures, shelf
counts and first page all answered for their own keys — `shown`, a `ShownLevel` — and while a walk
is in flight (`held`) it serves the level, its shelves, counts, rows, figures, scroll key and
export filters from that frame. `answered()` means not pending and not the previous key's
placeholder. A refusal counts as an answer, so a failing read ends the hold and the page says so.
The frame is a copy rather than `keepPreviousData`'s placeholders because the three reads cache
apart: the list is keyed on the sort and the folds, and the figures and counts are not. Held on the
placeholders alone, a walk under another sort drew the new figures over the old wall. A level
already cached switches in the render that asked for it.

**The hook publishes both levels.** `folderId` is the level drawn, and everything drawn reads it.
`requestedFolderId` is the level asked for, and only navigation reads it: Escape's step up (two
presses in quick succession are two levels) and the render-phase hand-offs. `levelHeld` stops the
page paging past the held rows. `useWishlist` holds the same frame, less the figures its page has no
read of its own for.

Measured in the shipped window (debug build, 1920×1080, 2026-09-26): the first pass saw 36–106 ms,
2–6 frames, of a wall missing its level's own leading row under the child level's figures — Deep
Four → Showcase read `Cards 5 · $13.55` — before the cards popped in above the first heading
(FAIL 14). The re-check saw every walk from a never-read level switch in one frame, with no frame
mixing two levels, and re-check 2 (2026-09-27, debug build) saw the same on all five walks it drove,
at 148–190 ms.

**A level deleted elsewhere is walked away from** (the final review's C-M4). While the asked level
is in the folder list, the page remembers its trail (`levelTrail`, root-most first). Once the list
has answered without it — another window deleted it, or a synced device — the page opens the
nearest surviving ancestor, or the root. Both writes are render-phase and terminate, because each
lands on a level the list holds. Before this, the reader stood on an empty wall with an inert path
row and only Escape to leave by. A folder deleted before this page ever drew it has no trail and
goes to the root.

### The caret a heading is owed

**After Add folder in a heading, Move up or Move down, Move to folder… and Delete…, the caret is
handed back to a heading that may not be drawn.** The wall is virtualised. A new folder's field is
revealed at the end of its parent's subtree, which scrolls the parent's heading out of the window,
and a move carries the heading past a neighbour's whole subtree. So the element the page remembered
is often detached, and `focus()` on a detached node is a silent no-op. The first pass found exactly
that (check 8, 2026-09-26): after Add folder in `Binder`, and after each Move up or Move down, the
caret went to `<body>`.

The contract has two halves, both shared with the wishlist:

- **The page half is `useHeadingCaret`** (`src/features/shelves/useHeadingCaret.ts`), one machine
  for both pages. It was two verbatim copies until the final review (C-M7 / W-M5), and they had
  already drifted once. The page records which heading's control is owed the caret as a
  `CaretBack`: the shelf, `"add"` or `"manage"`, the pressed element, and the level drawn, the level
  asked and the view the request was made in. A request is asked at the press (`ask`, a fresh id)
  and recorded when its moment comes (`record`): after a successful write, or on a keyboard cancel
  of Add folder. It is refused if something newer was asked or a layer opened meanwhile
  (`supersede`), and dropped on a level change, drawn or asked, and on a view change. A move is
  decided at the folder list's first answer after the write: in its planned order (`order`, for
  Move up / down) or filed under its destination (`into`, for Move to folder…), it goes on; if not,
  it is dropped rather than left to fire on some later read. Both views then bring the heading into
  view — the grid's `revealShelfId`, the table's `revealIndex` — and `caretFor` hands that one
  heading its `caret` prop.
- **The heading half is `useTakeHeadingCaret`** (`headingCaret.ts`), one layout effect that both
  heading components call with their own row. The heading takes the caret the moment it is drawn
  with a request on it — **only while nothing else has it** (`<body>`, or still the pressed
  element) and **once per request** (`claim`, which spends it). The control is found inside the
  heading's own row (`HEADING_CARET_CONTROL`) and never across `document`, because during a reorder
  two rows can briefly stand for one folder. `claim` setting the page's state from this effect is
  the one documented exception to the no-`setState`-in-an-effect rule: it is an event only that
  commit can see, guarded and loop-free.

| Gesture | Where the caret goes |
| --- | --- |
| Add folder in a heading: commit, Escape or ✕ | that heading's Add folder |
| Add folder in a heading: a blur that discards it | the same, decided one task later (`afterBlur`), and only if the caret is still nowhere |
| Add folder on the path row: commit | the path row's Add folder, with `preventScroll`, so the page stays on the folder just made |
| Add folder on the path row: a blur that discards it | the same one-task decision, with `preventScroll`; Escape and ✕ return it at once |
| Move up / Move down | the moved heading's `⋯` |
| Move to folder… into a heading this wall draws open, or onto the level itself | the moved heading's `⋯` |
| Move to folder… anywhere else, and Delete… | the `⋯` of the heading the folder was filed under, or the path row's Add folder where it stood at the top of the level (`leave`, the final review's C-M5) |

**A blur waits one task** because during a blur the caret is on `<body>` whether or not a click is
about to put it somewhere, and Blink blocks a click's own focus change when a `focusout` handler
moves focus. The path row's blur went straight to `dismiss` until the final review (C-I3 / W-I1),
and the re-check measured what that cost on both pages: a click on a tile above the path row's draft
closed the field, moved the caret to the path row's Add folder, scrolled the page to 0 and
swallowed the click. The heading's draft already waited, and the re-check measured that too: a
click on a tile below it left the scroll alone and the caret on the tile.

**Measured after the fix wave** (the re-check, debug build, 1920×1080, 2026-09-26): the caret
landed on the heading's own control in **22 of 22** cases across the grid and the table on both
pages, including headings that had been virtualised away, and the table's reveal landed clear of the
header and the band every time. In the grid, 4 of 9 cases left the heading only partly on screen —
half under the sticky bar after a far Move up and after the wishlist's commit, and 6px past the
window's bottom after this page's far Move down. The re-check traced all four to the `Updating…`
line, which now keeps its slot, and the bar's height is now the grid's scroll padding.

**Re-check 2 drove the final review's half** (2026-09-27, debug build, at `cf8553c0`). The four
grid cases landed flush under the bar at 128–168 with the caret on the control, and the far Move
down at 924–964 with its empty box, 972–1068, in view too. Move to folder… and Delete… never left
the caret on `<body>`: into an open heading it went to the moved heading's `⋯` (revealed at
924–964 here), into a collapsed one to the `⋯` of the heading the folder left, after deleting a
child to the parent's `⋯`, and after deleting a root folder on the wishlist to the path row's Add
folder. A click on a tile above the path row's draft opened that tile's card with the scroll held
(8079 here, 9580 on the wishlist) and left the caret on the tile after Escape; the path row's commit
kept the scroll too, with the new folder in view at 924–964.

### A card lands only where the pointer is

**Every shelf target takes a drop only while the pointer is inside it** — headings, empty boxes and
path segments — through `useDndDropTarget`'s `pointerOnly` (`src/lib/dndTarget.ts`, set by
`useShelfDropTarget`). dnd-kit's default detector falls back to the carried card's *rectangle* when
the pointer is in no target, which is right for a tall deck pile and wrong for a 40px heading laid
between rows of tiles that are not targets at all. The first pass measured it (2026-09-26, debug
build): a card released on tile 50 of `Foils` was added to `Showcase`, the heading 22px below. In
the re-check the same release filed nothing and the heading only armed. `pointerOnly` is asked
twice: by the detector on every collision pass, and again at the release against the target's own
rect as it is then (`containsPointer`). The second ask is there because the collisions follow a
scrolling wall about one update behind, and a heading that autoscroll carried past a still pointer
stayed the target up to 16px after it had passed (re-check, new finding 5); in re-check 2
(2026-09-27, debug build) three cards released with the target still on a passed heading and the
pointer 4px outside it filed nothing. The folder half takes
the same rule, because the table does not fold during a folder drag, and a heading carried over card
rows would otherwise land beside whichever heading it overlapped. What that gives up is a folder
dropped in the 8px gap between two folded headings, which now lands nowhere.

**Known and accepted: during autoscroll a heading becomes the target only after about 30px of
travel under a still pointer** (re-check 2's finding B, 2026-09-27, debug build). A card released
14px into a heading that autoscroll was carrying past filed nothing, because the operation's target
was still `null`; at 30px it filed, twice. It fails safe — the release files nowhere rather than
into the wrong shelf — and it is probably also why one table run in that pass, with the pointer
left still on `Binder`'s band when the scroll stopped, landed nothing.

**The sidebar joined in the final review.** The re-check found the navigation rail's Wishlist entry
taking a card whose pointer was on the wall's first tile column, and adding a wish at the root (new
finding 1): the rail sits flush against the page's left edge. `useSidebarDropTarget`
(`src/components/useSidebarDrops.ts`) now passes `pointerOnly`, which covers both drawings of the
navigation. The deck editor's own targets keep the default detector. In re-check 2 (2026-09-27,
debug build) a card held 1.2s on the wishlist's first tile, overlapping the Wishlist entry, left
the target `null` and filed nothing, while a release on the entry itself still added a wish.

**The sticky bar is the one shelf target drawn over the others**, so it is an `overlay` instead
(`useShelfStickyDropTarget`): the same pointer-inside detector, ranked `CollisionPriority.Highest`.
Headings and table bands scroll underneath it, and dnd-kit ranks two pointer collisions by distance
to each centre and never by paint order, so a heading half under the bar used to take the drop
(the final review's S-M1).

**The landing mark is the landing the release makes, from the first frame.** `useFolderDropTarget`
read dnd-kit's `position.current` in its `dragmove` listener, which the library writes a microtask
after dispatching the move. So a heading arrived at in its bottom quarter showed the `inside` wash
with no line, and the release then landed `after` (re-check, new finding 4, on the table). The
listener now reads the move's own point, and re-check 2 (2026-09-27, debug build) saw the `after`
line drawn one frame, 7ms, after the pointer arrived, with no nudge, and the release land `after`.

### What the `shelves` query costs — measured 2026-09-26, in a test harness on Windows

**Not in the shipped window.** Two measurements, both on the same Windows 11 Pro machine (AMD
Ryzen 9 5900X) with SQLite 3.53.2 bundled through rusqlite 0.40.1, and both by a temporary
`#[ignore]` harness (`shelves_bench.rs`, deleted after each) that called the crate's own functions
on `db::open_read` after `prepare_database`:

- **The first measurement, at `3efd50b0`** — the code before the fix.
- **The re-measure, of the fix as committed in `0604eff0`** — taken from the working tree just
  before that commit, with `collection.rs` at blob `a0f92a99` and `wishlist.rs` at `3dc09c83`,
  which are the blobs the commit holds. The harness called `list_entries`, `shelf_counts` and
  `summarise` as they stand and re-implemented nothing of the fix.

**debug** is `cargo test`, the `tauri dev` profile; **release** is `cargo test --release`. Three
warm-up calls, then twenty timed; every figure is a median. Two data sets, both byte copies of
`src-tauri/target/debug/data/`: the real one — 277 entries in 7 folders, migrated from user v46 to
v51 on the copy — and the same copy with 100,000 entries seeded into user tables only, 100,277 in
all, 30,001 of them unfiled, 57 folders to depth 6, so the root sends 58 ids. The re-measure took
fresh copies and re-seeded them from the same deterministic seed, and the seeded copy came out the
same: the same entry, unfiled and folder counts, the same depth, the same deep folder and subtree,
and the same row totals in every case.

**The plan's gate was `shelves` at no more than 3× `rootOnly`'s median. The first measurement
tripped it, and found a second regression the gate had not asked about:**

| 100k copy, before the fix (`3efd50b0`) | debug | release |
| --- | --- | --- |
| The root wall (58 ids) against `rootOnly` | 4.51× | 3.72× |
| One folder four levels down, 120 rows, `shelves=[id]` against `folderId=id` | 25× | 33× |

The two causes are different. The root wall reads 100,277 rows where `rootOnly` reads 30,001, and
paid a correlated `json_each` position lookup per row on top. **A folder below the root lost
`idx_collection_folder`**, because `coalesce(folder_id, 0) IN (…)` cannot use it: `EXPLAIN QUERY
PLAN` read `SCAN e` for every `shelves` statement against `SEARCH e USING INDEX idx_collection_folder`
for `rootOnly` and `folderId`.

**The fix is the two builder changes above, and no schema rung.** The harness first timed candidate
variants of `list_entries`' own statements, string-edited and asserted to answer the same total and
the same first-page ids in the same order. That **prediction** for the chosen pair was 2.79× (debug)
and 2.70× (release) for the root wall and 1.06× and 0.98× for the deep folder, with `instr` alone
taking the root wall's statements from 1643 to 1021 ms (debug) and from 1263 to 902 ms (release).
An expression index on `coalesce(folder_id, 0)` was timed too, though not the same way: it was
created on the seeded copy and read through `list_entries` with the crate's SQL unchanged, rather
than as an edited statement. It was refused: it gained nothing the builder change does not, it cost
20–26% on the whole-root list, and it would have been a user-schema rung. **The re-measure of the
committed code confirmed the prediction:**

| 100k copy, after the fix (`0604eff0`) | debug | release |
| --- | --- | --- |
| The root wall, against `rootOnly` | 1041.6 ms / 375.6 ms = **2.77×** | 916.0 ms / 339.4 ms = **2.70×** |
| The 120-row folder, against `folderId` | 2.229 ms / 2.050 ms = **1.09×** | 1.048 ms / 1.006 ms = **1.04×** |

**What is left of the root's ratio is row count.** Over the same 100,277 rows the root wall is now
*faster* than a list with no folder term at all — the old Flatten query — at 0.93× (debug) and 0.90×
(release) of it. The deep folder and its subtree plan `SEARCH e USING INDEX idx_collection_folder`
again; the root list names `0` and scans by design; no plan shows a `MULTI-INDEX OR`.

**On the real dev database the whole question is milliseconds, and its ratio is not the gate's.**
After the fix the root's `shelves` list took 3.8 ms debug and 1.8 ms release, and the list, the
counts and the summary together about 7.4 ms debug and 3.7 ms release. **It still reads about 12×
`rootOnly` there** (12.6× debug, 12.2× release), and that is a row-count artefact rather than a
regression: 277 rows against the 1 this database has unfiled. Over the same rows it is 1.23× and
1.17×. So the gate passes at 100k and is simply not the right question at 277 rows — nobody should
read it as passing everywhere.

⚠️ **Open: `collection_shelf_counts` is the largest read on a very large collection, and the fix
does not touch it.** At the 100k root (58 shelves) it took **2.9 s debug and 2.5 s release** in the
re-measure (3.06 s and 2.44 s in the first). **`fill_peek` was 45% and 47% of it in the first
measurement** (1.38 s and 1.15 s) and was not timed apart in the re-measure: the peek groups every
scoped row by `(shelf, card_id)` and fetches `cards.name` for each before the window cuts to four.
Inside a 7-shelf, 8,813-row subtree it took 271 ms debug and 221 ms release (first measurement
only); on the real database 2.6 ms and 1.3 ms after the fix. The list, the counts and the summary
all take the one `db_read` mutex, so they run in series. The likeliest next step — ask for a peek
only for the shelves whose heading is shut, since only a shut heading draws one — changes
`ShelfCount`'s contract across both pages, is not built, and has no figure behind it.

**The wall has been driven in the shipped window since this section was first written** — a first
pass and a re-check on 2026-09-26, and two more re-checks on 2026-09-27, all on the debug build.
What they measured is in [the live record](#folder-shelves--four-passes-2026-09-26-and-2026-09-27),
and what each finding changed is in the subsections above. None of them measured the query's cost,
which is the harness's figures above and nothing else.
## The page, and the drag payload's own key

**History (2026-09-26):** the folder cards are headings now and wear the same two marks —
`DROP_EDGE` on the heading's own always-present transparent edge, `DROP_OVER` under the pointer
(`ShelfHeading`'s `dropMark`) — and a breadcrumb segment takes a folder as well as a copy. See
[Shelves](#shelves-2026-09-26).

The collection page is the wishlist's page ported, and the pieces it reuses are named in
[wishlist-folders.md](wishlist-folders.md) rather than re-argued: folder cards in the grid, a
breadcrumb whose **segments are also drop targets** (without them a drag could only ever push cards
deeper, never back out), a mark on every eligible folder the moment a row leaves its tile and
`DROP_OVER` on the one under the pointer, and `DROP_MARK_ROOM` on the wall's scroller.

**That mark is `DROP_EDGE` rather than `DROP_RING`, and both marks sit on the card's own
`<button>` face** — changed 2026-09-03, after a reader reported the affordances as bulky, as
overlapping neighbouring content, and as not lining up with the dashed outline they appeared to
sit on. All three were the same cause: the ring was drawn on the wrapping `<li>` and a ring is a
box shadow painted *outside* the border box, so it stood 2 px proud of a dashed rectangle it never
touched. A folder card already owns an outline, so it does not need a second one — its own dash
turns faintly gold instead, and there is no longer a pair of edges that could fail to agree. The
drop *registrations* did not move and could not: dnd-kit keeps one target per element, and the
`<li>` and the slot inside it are the two boxes the card drag and the folder drag are registered
on and measured against. **`DROP_MARK_ROOM` stays on the scroller for `FOCUS`'s sake**, not the
ring's — an inset ring cannot be clipped, a half-drawn focus indicator is a WCAG 2.4.7 failure.
`src/lib/dropMarks.ts` carries the whole reasoning.

## The wall's grain is the printing **and** the finish

**History (2026-09-26):** on the collection page the folder joined the tile too. Its tiles key on
`tileKeyOf(cardId, finish, folderId)` (the page's `tiles` memo), so the same printing in two
folders is a tile on each shelf, and only `foldCopies` — the deck editor's docked collection
column — still keys on the printing and the finish alone (`foldCopies` in
`features/decks/collectionTiles.ts`). The ring is still the two-part key on both walls; on the
collection wall it is a tile's own `ringKey`. See
[A tile is one folder's](#a-tile-is-one-folders-the-eleventh-term-reaches-the-wall). Sentences below
that this changed are corrected where they stand.

2026-08-26, out of
[2026-08-26-card-chin-and-exact-prices-design.md](../superpowers/specs/2026-08-26-card-chin-and-exact-prices-design.md).
The storage grain has had eleven terms since v24 and did not move; what moved is what a **tile**
is. A foil and a played nonfoil of one printing are two objects at two prices sharing only a set
and a number, so they are two tiles — and every other grain term merged. Condition, language and,
until shelves, **folder** were all one object seen from more than one place, and the table beside
the wall is where a reader gets those apart. Since shelves the collection page splits a tile on the
printing, the finish and the folder, and merges every other grain term — condition and language, and
the altered, signed, proxy, misprint, serial and grading terms with them; the deck editor's docked
column still merges the folder too.

**There are two folds of the collection into tiles, not one, and both split.** The collection page
folds rows in `CollectionPage`'s `tiles` memo; the deck editor's docked Collection tab folds the
same rows in `collectionTiles.ts`'s `foldCopies`. They were written apart and keyed the same way, so
splitting one alone would have made two drawings of one collection disagree about what a tile *is*.
Both keyed on `` `${cardId}:${finish}` `` from 2026-08-26, through **one** `tileKeyOf`, in
`src/lib/tileKey.ts`; since shelves the collection page passes the folder as that function's third
argument and `foldCopies` does not. Each wall builds the ring composite back out of the pane's card
and finish with the two-part call, and each tile carries the same two-part string to be compared
against it — the tile's key on the docked column, the tile's `ringKey` on the collection wall — so
the two ends of that ring cannot be two spellings of one string. Both are plain `string` and nothing
in the type system relates them, which is why a missed spelling would be a wall where pressing a
tile rings nothing at all, silently and with nothing red. The `?? "nonfoil"` that makes the two ends
meet is spelled there once, for both walls.

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
printing is still several rows — they differ in grade and in language, and until shelves in folder
too — so a drag still hands a folder every one of them and the reader still answers which. The
split narrowed *which* rows sit behind a picture; it did not turn the several into one. The two
`cardId`s in the drag payload stay `tile.id` deliberately: a drop onto a **deck** is
`deck_add_card(deckId, cardId, …)`, which names a printing and takes no finish, and the tile half's
`cardId` is what a drop target and a breadcrumb segment say the reader is filing — a folder card
until shelves, a heading since. Only the *rows* are the finish's.

**`CardGrid` gained `GridCard.key` for this and nothing else changed on the other walls.** It
defaults to `id`, so a wall that passes none is untouched. `id` stays what fetches the
art, what a press opens and what `onSelect` is about; `key` is what `data-grid-index` walks and what
the picked set remembers, and what the ring compares — **unless a tile carries a `ringKey`**, which
the collection wall's has since shelves (`GridCard.ringKey`), so one printing on two shelves is two
keys and one ring.

**The open card's side of that composite is the store's `paneFinish`.** Two openers set it —
`openCardAsFinish`, the collection wall's, and `openCardFromDeckSearch`, *widened* to carry the
docked Collection tab's finish rather than the app gaining a fifth opener — and `setSelectedCardId`
clears it in its existing `set`, so a press from a surface that names no finish cannot leave a stale
seed behind. `viewPrinting` deliberately touches neither it nor the deck context: browsing printings
inside the modal keeps the reader's foil view. `CardDetailModal` reads that field and hands it to
`CardModalArt` as `openedAs`, which seeds the view from `openedAs === "foil" || openedAs ===
"etched"` — narrower than "a finish was named", so a foil tile opens showing the sheen and a
nonfoil one opens plain. (The field is still spelled `paneFinish`: it was the docked
`CardDetailPane`'s until that surface was deleted on 2026-09-03, and the store name outlived it.)

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

**That union is what made the search sidebar's drop nearly free on 2026-09-07.** A third arm —
`{ kind: "new"; card: SearchCardDrag }`, for a printing nobody owns yet, carrying
`searchCardSource` — is one line on the type and one branch in `readCollectionDrop`, and it
reached `useCollectionDropTarget`, `CollectionFolderCard`, `CollectionParentFolderCard` and
`CollectionBreadcrumb`'s `Segment` with **no component edits at all**. The wishlist had no
discriminator and had to grow one; the cost of that comparison is written up in
[wishlist-folders.md](wishlist-folders.md). The precedence is stated rather than left to the marks:
a record carrying both an entry mark and a search mark reads as **the entry**, because an existing
copy being moved outranks a new one being added — only one of them can be true of a real drag, and
the narrower fact is the one to act on. The three marks are disjoint by construction, so that order
is a convention that no live drag can exercise.

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
claim the deck holds those copies without writing the `deck_cards` row that makes it true. So the
row hands over a **deck id** and the caller owes it the sanctioned command — which makes it the
write `Add to → Deck` already makes, reached from the cabinet the reader was looking at. It files
into the **live** list without asking, because this row is filing rather than deck-building; a
reader who means the plan has the deck picker one row up, which still asks.

⚠️ **This paragraph said "the deck's add does both halves in one transaction" until 2026-09-03,
and that was simply false.** `deck_add_card` writes `deck_cards` and **files no copies** —
`useDeck.ts`'s own `addCard` says so at its site, *"this write touches `deck_cards` and nothing
else"* — so the row records an *intention* and moves no `collection_entries` row anywhere. It never
produced a dangling placement, because it produced no placement at all; what it did produce was a
card added to a deck from a menu whose subject was the collection's cabinet. The same sentence was
in `useCardMenuDeps.ts` and is corrected there too.

**Since #358 the row greys for a deck that does not play the card**, with the reason
`"not in this deck"`, and the submenu became **`kind: "lazy"`** to afford it. That is the file's own
rule rather than a new one: `useDecksPlaying` is a backend read, and a right-click on a wall of
forty tiles must fire no query — so the census runs when the reader expands `Decks` and never when
the menu merely opens. **For a picked set, a deck must play _every_ target**, not any: a press makes
one write per target, and a row that half-works is a failure the reader cannot see. While the census
is in flight the body draws a note rather than pressable rows, for
[the fail-closed reason above](#and-since-2026-09-03-the-deck-has-to-already-play-the-card--issue-358).
`Recently removed` and the "omit `Decks` where there are no groups" rule are untouched.

**It is drawn only under `Add to`, and only where the reader already has folders.** Not under
`Move to`, because that row is labelled *Move* while the write adds a copy, and a destination
picker may not mislabel its own write. Not for a reader with no folders, because
`Add to → Collection` has always been a single press for them, and forking the commonest path in
the app to describe a cabinet they do not have — with `Add to → Deck` sitting one row above it the
whole time — is a cost paid by everybody. That one cost a test to learn: the docked pane's refusal
case clicked through to a finish on a printing with no folders, and the extra rung swallowed the
add. **That test went with `CardDetailPane.test.tsx` on 2026-09-03 and has no successor**, so the
rule is currently guarded by `cardMenu.tsx`'s comment rather than by a build.

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

**The app's own folders are a pinned, flat, fixed section, and every one of those three words is
a decision** (`PinnedFolders.tsx`). *Pinned*, because it is drawn at every level rather than only
at the root — that is how a reader reaches `Recently removed` from three drawers down without
walking back out, and a section that moved as you navigated is not one anybody can learn the
position of. *Flat*, because `parent_id` is `NULL` on every row v25 creates and no command can nest
anything under one, so there is no tree to build and the summary's **direct** count is the whole
count: asking `subtotalsOf` to add up children here would be an answer computed from a tree these
rows are deliberately not in. *Fixed*, because every write in `collection_folders.rs` that edits a
folder — rename, move, delete, lock — refuses one that is not `kind = 'user'` — a `⋯` menu here
would be rows that each end in `FOLDER_NOT_YOURS`, and a control whose only outcome is a sentence
explaining that it does not work teaches nothing its absence would not have. **`clear_removed`
(issue #506) is the one write in that file aimed at an app folder on purpose, and it is not a
folder edit**: it deletes the entries filed in `Recently removed` and leaves the folder standing,
and its button lives inside the level rather than on this strip, which still has no `⋯`.

**History (2026-09-26):** *pinned* is gone. The app's folders are shelves under the `Decks` label
at the root only (spec §3.1), so reaching `Recently removed` from three drawers down is a walk back
to the root again; *flat* and *fixed* still hold, and are why those headings carry no Add folder,
Rename, `⋯` or drag. See [Shelves](#shelves-2026-09-26).

**That third word was *locked* until v33, and it was renamed rather than kept.** #365 gave the
reader a lock of their own, and the two are very nearly opposites: a folder locked by a reader is
still theirs to rename, to move, to file cards into and out of, and still carries its full `⋯`
menu — what it loses is being *offered*, not being touched. Two meanings of one word inside one
cabinet is how a later reader concludes this pinned band is what #365 shipped, so the band's word
moved and the feature kept the one the menu and the issue both say. See
[the lock](#the-lock-stops-the-app-offering-and-never-stops-the-reader-reaching). Both kinds
nevertheless answer their two questions
through **`folderFace`**, exported from `CollectionFolderCard.tsx` rather than re-spelled, because a
second spelling of "12 cards · $340.00" is a second chance for one wall to disagree with the wall
under it.

**Neither kind is a drop target, and the two refusals are not the same refusal.** A **deck group**
is refused up here, on the page, because a copy reaches one only through the three writes that
answer for the deck card behind it — `collection_to_deck`, which writes that row in the same
transaction, and `deck_pull_from_collection`, which refuses any pick the list is not already short
of. A bare drag would call `collection_set_folder`, which knows nothing about decks, and file the
copy into the group with no deck card behind it. **`Recently removed`** is refused a layer lower: `set_entry_folder` calls
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
through the four writes that cross the deck boundary — `collection_alloc.rs`'s pair,
`deck_pull_from_collection` and `deck_quick_add_to_collection` — and never through a folder press. `Move to → folder` for a collection row calls
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

### Folder shelves — four passes, 2026-09-26 and 2026-09-27

**All on the debug build** (`npm run tauri dev` in the branch's worktree), in a 1920×1080 window at
DPR 1, driven with real CDP input and read back with DOM and rect probes, per-frame
`requestAnimationFrame` samplers, and `user.db` over `node:sqlite`. The data was a byte copy of the
main checkout's dev `data/` folder, migrated from user v46 on its first launch, with folders staged
through the app's own IPC into the copy only. On this page that was `Binder`, with
`Foils › Showcase › Deep Four › Deep Five` nested inside it, and `Trade`, with every copy filed.

**The first pass** (17:00–17:55, the branch at `e5f874d8`) ran spec §8's fourteen checks on both
pages and found **8 pass and 6 fail**, plus one fail outside the list. **The re-check** (21:45–22:25,
at `7201901e`) re-drove every fail after a fix wave of five commits — `30e1d170`, `94f9d4e4`,
`b012116c`, `c590b53a` and `7201901e` — and found **6 pass and 2 fail**. On this page:

| Check | First pass | Re-check |
| --- | --- | --- |
| A card released on a shelf's tiles (found outside the list) | **FAIL**: filed into the nearest heading — tile 50 of `Foils` went into `Showcase`, 22px below | **PASS**: the heading armed only, and nothing was filed |
| 4 — a folder drag folds, anchors, lands and unfolds | **FAIL** on the anchor: the fold jumped to the folded wall's clamp (scrollTop 222), the heading sat 96–402px from the pointer and was unmounted for a frame, and Escape ended at 222 with the heading about 4,600px away | **PASS**: the fold lands in one frame, the heading is in every frame, across both pages Escape put it back under the pointer 3 of 3 times, and 3 of 7 drops settled 16px low |
| 6 — Ctrl+wheel, and the caret across a column change | **FAIL**: tile 6 lost the caret going from 4 to 5 columns | **FAIL** on a deep tile: tile 6 kept it both ways, tile 63 lost it |
| 8 — the caret after Add folder and Move up / Move down | PASS, with the caret on `<body>` wherever the heading had been virtualised away | **FAIL** on visibility: the caret right in 22 of 22 cases (both pages), with 4 of the grid's 9 leaving the heading partly under the sticky bar or 6px off-screen |
| 10 — the name field in the 40px heading | **FAIL**: a 42px frame 1px proud top and bottom, ✓ and ✕ 3px above the centre line | **PASS**: a 36px frame at the row's top + 2, and every item on the centre line (0px), in the grid and the table |
| 11 — the table: band, focus, popup, Top, paging | **FAIL** on the table's own focus ring: two faint 1px lines, and a Tab moved the list 855 → 191 | **PASS**: a whole 2px frame on four sides, and a Tab left 855 at 855 |
| 14 — walking up a level | **FAIL**: 36–106 ms of a wall missing its own leading row under the child's figures | **PASS**: every walk in one frame |

The rest passed on the first pass and were not re-driven. **1**: the root full, reading
`Cards 340 · Unique 273 · Value $3,890.20`, equal to `collection_summary` and to the database.
**2**: the sticky bar flush at 0.0px under `main`'s top and 36px tall over twelve wheel steps,
naming each shelf as its heading passed under it; its path opened `Foils`, whose figures read 18 = 8
+ 5 + 3 + 2. **3**: a card dragged from the docked search onto a heading that mounted mid-drag,
armed on arrival and filed. **5**: the arrows across a short last row and across headings, and a
Shift range across two shelves. **7**: a search inside a collapsed `Binder` opening its ancestors
and shutting it again when cleared. **9**: collapse kept per window, both ways. Check 13's failure
was the wishlist's — this page drew the same dashed box in both views — and check 12 is the
wishlist's alone.

**The re-check's new findings** went to the branch's final review with the two fails, and each is
answered in [Shelves](#shelves-2026-09-26): the sidebar's Wishlist entry taking a stray card
(`pointerOnly`), a 16px `Updating…` line throwing the reveal and the drop anchor off after every
write (the status line keeps its slot), the drop animation flying the floating heading toward a
stale slot for 2–4 frames (`animateDrop: false`), the table's landing mark lagging one pointer move,
a heading left the target up to 16px after autoscroll carried it past a still pointer (the release
check), and a focused tile left off-screen by a zoom (`keepInView`).

**Re-check 2** (2026-09-27, the branch at `cf8553c0`, after the final review's fix wave and a merge
of `main` that took the copy to user schema v52) drove thirteen items — the two fails above, the six
new findings, the final review's table carry, both Tops, the path row's draft, Move to folder… and
Delete…, the fold pause, and a regression sweep over everything that had passed — and passed
**13 of 13**. Its figures are written into [Shelves](#shelves-2026-09-26), beside each mechanism.
Beside the checklist it found three things:

- **A, fixed.** A fold that needs room below a wall shorter than the row the docked search column
  stretches clamped at scrollTop 222, and held the heading 78–126px under the pointer — on the
  wishlist, and waiting on any short cabinet here.
  [The fold section](#a-folder-drag-folds-the-wall-on-the-grid-only) has the cause and the fix,
  `2ece040d`.
- **B, known and accepted.** During autoscroll a heading becomes the target only after about 30px
  of travel under a still pointer, so a release 14px into a passing heading files nowhere. It fails
  safe.
- **C, known and accepted.** One Escape, of the last heading in `Binder`'s level, came back 2px
  short (897 against a pointer of 899); every other came back exact.

**Re-check 3** (2026-09-27, at `2ece040d`) drove finding A's fix on the wishlist and on a short
cabinet staged inside `Binder`, and re-drove the root's deep folds and drops: **3 of 3 pass**, with
the slot on the pointer through every fold, hover, Escape and drop, and the page's height and the
wall's end back to what they were before the press after every unfold.

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
- **The lock** (v33, §"The lock stops the app offering"), which owes a whole pass and has had
  none — **no figure anywhere in that section was measured in a running window, and none is
  quoted**. What it owes: the badge on a folder locked by an *ancestor* rather than by its own
  press, since that is where the inheritance is either visible or invisible; the greyed Delete
  and the greyed Unlock reading their reasons out of their accessible names; the drag
  confirmation in both directions, found by its text because this app's confirmations carry no
  `dialog` role; a locked drawer's copies gone from the page and still there when the reader
  stands *inside* it; and the one that matters most — an export and a mirror pass over a
  collection with a locked folder in it, which is the failure the whole design is shaped around
  and the one no screenshot shows.
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
- **A wishlist lock, a per-card lock, and a password on the folder lock.** The wishlist is a
  shopping list and nothing on it is "set aside"; the folder is the unit
  [#365](https://github.com/Msgaihede/mtg-grimoire/issues/365) asked for and a per-card flag would
  be a twelfth grain term nobody has asked for; and locking is reversible in one press, so it
  protects against an accident rather than against a person — which is also why the lock press
  itself asks nothing.

## Where the code is

| Path | What is in it |
| --- | --- |
| `src-tauri/src/schema.rs` | The v24 and v25 steps, the v34 rung that adds `locked`, the v36 rung that sweeps every `kind = 'deck'` folder to the exact-grain rule, `COLLECTION_GRAIN`, `COLLECTION_FOLDER_KINDS`, `UNDO_V24`, `UNDO_V25`, `UNDO_V34`, `schema_at_23`, `v24_database`, and the whole-schema `ON DELETE` inventory |
| `src-tauri/src/collection_folders.rs` | The folder commands, `set_entry_folder` and its two fences, `refile_entry`, `take_copies` (the split), `merge_entry`, `folder_summary`, `set_folder_locked`, `LOCKED_FOLDER_IDS` and `effectively_locked` (the lock's inheritance, spelled once), `FOLDER_NOT_YOURS`, `ENTRY_IN_A_DECK`, `FOLDER_IS_LOCKED`, `FOLDER_HOLDS_LOCKED` and the `DOOMED_FOLDERS` sub-tree it and the delete share |
| `src-tauri/src/collection_alloc.rs` | `collection_to_deck` and `deck_to_collection` — the pair that moves a row across the deck boundary and back — `take_from_deck_list`, `MoveOutcome`, the cut's history row and the argument for its missing undo step, and the seven refusal sentences |
| `src-tauri/src/deck_pull.rs` | The third crossing (2026-09-03, issue #351): `deck_pull_plan` and `deck_pull_from_collection` — filling a hole the list already declares, writing no `deck_cards` row. Candidate eligibility, the pre-pick order, the all-or-nothing batch, and the `move` history row. Recorded in [decks-storage.md](decks-storage.md#the-pull-filling-a-hole-the-list-already-has) |
| `src-tauri/src/deck_quick_add.rs` | The fourth crossing (2026-09-03, issue #350): `deck_quick_add_wishes` and `deck_quick_add_to_collection` — the only one that *creates* a row rather than moving one. The seven-step order, `WISH_GONE` and `WISH_WRONG_CARD`, the wishlist predicate and why it drops the any-printing arm, and the fourth `move` history row. Recorded in [decks-storage.md](decks-storage.md#the-quick-add-recording-cardboard-nobody-had-written-down) |
| `src-tauri/src/collection.rs` | The grain's other ten terms, `set_quantity`'s zero-delete, `update_entry`'s merge, `fold_entry`, `EntryChange`, `ENTRY_FINISH`, `Allocation`, `CollectionQuery::exclude_locked` with `scope`'s term for it, and `add_entry_filed` with `DECK_WRITE_FOLDERS` — the private door that takes the folder fence as a parameter, and its two callers. Since 2026-09-26 also `CollectionQuery::shelves`, the shelf term builders `wishlist.rs` shares, `ShelfCount`, `shelf_counts`, `fill_peek` and `collection_shelf_counts` |
| `src-tauri/src/deck_theory.rs` | `OWNED_SPARE_SQL` — "what can I build with", and the first ownership-shaped statement the lock changed, unconditionally |
| `src-tauri/src/collection_source.rs` | The three scoped fragments, `copies_by_printing_and_finish` (the whole statement, 2026-09-09) and `Availability` — the second thing the lock reaches, as a **scope a caller passes** rather than a statement: `ForDeck` drops another deck's group and every locked drawer, keeping the asking deck's own group, and has two readers that must stay one pool — the deck builder's card search (issue #349) and a `theory` row's owned figure (issue #435) |
| `src-tauri/src/deck.rs` | `owned_by_printing` (`owned_by_oracle` before 2026-09-07), `available_by_printing` (the plan's wider pool, 2026-09-09) and `attribute_owned` — a `live` row's owned/missing as a sum over the group, a `theory` row's over everything this deck could use, both keyed `(card_id, finish)`, with `get_deck` the one line that picks — `delete_deck`, which re-files into `Recently removed`, `release_unclaimed_copies` — the sweep `swap_printing` and `set_card_finish` each call after rewriting a row's identity — and `release_group_copies`, the crate's one walk over a group's rows — exact `(card_id, finish)` only since the oracle-grain fallback left it the same day — which `deck_to_collection` calls for its one row and `release_live_copies` loops for the four bulk sites (`clear_category`, `clear_variant`, `deck_meta::delete_category`'s cascade arm, `import::commit_import`'s `replace` arm), carrying the `live` fence for all of them |
| `src-tauri/src/reset.rs` | `clear_collection` — entries, then folders |
| `src-tauri/src/reconcile.rs` | `fold_into_existing`, which calls `fold_entry` as `merge_entry` does, and `collision_target`, the crate's other eleven-term probe |
| `src/lib/folderTree.ts` | `buildFolderTree` and friends, shared with the deck gallery and the wishlist, and `lockedFolderIds` — the one function there that is this cabinet's alone |
| `src/features/collection/collectionDrag.ts` | Both payloads under their own keys, the row and the tile that offer them, the targets that take either |
| `src/features/collection/PickCopies.tsx` | The question a drop asks when the art stands for more than one row |
| `src/lib/tileKey.ts` | `tileKeyOf` — **the one place** `` `${cardId}:${finish}` `` is spelled, and the `?? "nonfoil"` the ring composite meets a tile's key on. Both folds and both walls call it. Its optional third argument, the folder, is the shelved wall's (2026-09-26) |
| `src/features/collection/CollectionPage.tsx` | The `tiles` memo, `copiesByTile`, `entryIdsOf` — the wall's own grain, keyed through `tileKeyOf` on the printing, the finish and, since shelves, the folder — and the wall's shelves, headings and path row |
| `src/features/decks/collectionTiles.ts` | `foldCopies` — the *other* fold of the same rows, split the same way and keyed through the same `tileKeyOf` |
| `src/features/search/CardGrid.tsx` | `GridCard.key` and `tileKey` — a tile's identity where it differs from its card's |
| `src/features/collection/CollectionFolderCard.tsx` | `folderFace` and `CollectionFolderTotals` — the folder card's figures line, kept for the home page's Folders widget. The card itself went with the folder band on 2026-09-26 |
| `src/components/FolderNameField.tsx` | The one naming field, both shapes, `FOLDER_CARD_HEIGHT` and `useFolderFieldReturn` — drawn on a shelf heading since 2026-09-26 |
| ~~`src/components/NewFolderCard.tsx`~~ | **Deleted 2026-09-26** with the folder band. Add folder is `ShelfToolbar` and `ShelfHeading` |
| `src/components/ParentFolderCard.tsx` | The up-one-level tile — drawn by no cabinet since 2026-09-26, with its stories kept; the deck gallery's `FolderCard` imports its words (`UP_ONE_LEVEL`, `upCardName`) |
| `src/features/collection/PinnedFolders.tsx` | `DECK_KIND`, `REMOVED_KIND` and `pinnedFolders` — the vocabulary. The pinned strip it drew became the `Decks` shelves on 2026-09-26 |
| `src/lib/shelves.ts` | `buildShelves`, `defaultCollapsed`, `shelvesToFetch`, `shelvesToCount`, `visibleShelves`, `UNFILED_SHELF` — the order, the folds and the two id lists, shared with the wishlist |
| `src/lib/shelfLayout.ts` | `layoutShelves` — the shelves as heading, tile, label and empty rows at one column count — and the heights and indent constants |
| `src/features/shelves/` | `ShelfHeading`, `ShelfStickyBar`, `EmptyShelf`, `ShelfLabel`, `ShelfToolbar`, `useShelfFolds`, `useShelfDrag`, `useFoldOnFolderDrag`, `useFoldAnchor` — shared by both pages |
| `src/features/collection/collectionShelfModel.ts` | This cabinet's reading of the shelves: `shelfFolderOf`, `DRAFT_SHELF`, `rolledUp`, `shelfStat`, `foldAll`, `peekOf`, `keepShelf`, `foldedForDrag` |
| `src/features/collection/CollectionShelfParts.tsx` | The heading, the empty box and the sticky bar, each wired to the drags this cabinet answers |
| `src-tauri/src/shelffolds.rs` | The `shelf_folds` `app_meta` row — `shelf_folds` and `set_shelf_folds` |
| `src/features/card/cardMenu.tsx` | `buildCollectionTargetItems` — `Add to → Collection`, and `Move to → folder` |
| `src/features/transfer/import/destinations/collection.ts` | `grainKey` — the importer's fold, now every grain term it can vary |
| `src/lib/ipc.ts` | `MoveOutcome`, `collectionToDeck` and `deckToCollection`, and `CollectionQuery.allocation` — whose two words nothing sent until Collection Search |
| `src/features/decks/DeckSearchPanel.tsx` | The two tabs, `DEFAULT_DECK_SEARCH_TAB` (`collection`) and `DECK_SEARCH_TAB_KEY` |
| `src/features/decks/CollectionSearchTab.tsx` | The list, `landingCategory`, and the confirmation that names the other deck |
| `src/features/decks/useCollectionSearch.ts` | `collection_list` with `allocation`, `CopySource`'s three answers, and the invalidation a move fires |
| `src/features/decks/useDeck.ts` | `setQuantity`, which routes a **live** decrease through `deckToCollection`, and `invalidateCollection`, which fires only when the outcome says copies moved |
| `src/features/decks/DeckEditor.tsx` | `setQuantityAt` — the app's one removal path, and where the `CutFrom` row is looked up |
