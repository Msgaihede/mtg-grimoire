# Locked collection folders

[Issue #365](https://github.com/Msgaihede/mtg-grimoire/issues/365), raised from Discord. Schema
**v33**. This is the design; [collection-folders.md](../../reference/collection-folders.md) is the
page that will hold the record of what shipped.

**The one sentence: a locked folder is a drawer the reader has set aside, so the app stops
*offering* what is in it without ever stopping the reader reaching it.** Everything below is a
consequence of that split — *offering* is what a search result and an availability figure do, and
*reaching* is what a drag, a click into the folder and a backup do.

The motivation in the issue is two piles that are the same shape: cards being held for a trade,
and cards in a display case. Both are owned, neither is available, and today the app cannot tell
either apart from a binder.

## 1. What the issue asked for, and the one clause that has already been built out from under it

The issue asks for three things — an indicator, exclusion from collection search results, and
exclusion "from all automated actions, such as moving cards into a deck folder when they are added
to a deck" — plus a fourth in its Proposed Solution: moving cards in and out is always allowed,
possibly with a warning.

**The named example no longer exists, and the spec has to say so rather than implement a ghost.**
`addOwnedCopies` hunted the binder for a free copy when a card was added to a deck; it was deleted
on 2026-08-25 with the own/need pair that was its only way in, and `src/features/decks/useDeck.ts`
carries its tombstone. Today `deck::add_card` writes a `deck_cards` row and moves **no**
`collection_entries` row at all. There is no code path left that files a copy into a deck's group
without the reader pointing at that copy on screen.

So the automated-action clause is not "stop the deck adder taking locked copies" — nothing takes
them. It is the general form of what that example was reaching for, and §4 is where it lands.

**A second thing follows and is worth stating because it is the answer to a question a reader will
ask.** `deck::owned_by_oracle` (`deck.rs:3966`) counts only rows filed in *that deck's own group*:

```sql
FROM collection_entries e
JOIN collection_folders f ON f.id = e.folder_id
JOIN cards c ON c.id = e.card_id
WHERE f.deck_id = ?1 AND c.oracle_id IS NOT NULL
```

A locked folder is a `kind = 'user'` folder, so its copies have never been in any deck's group and
have never counted toward a deck's owned/missing. **Locking a folder therefore cannot change a
deck's owned or missing figures, in either direction**, and no part of this design touches that
statement.

## 2. The column, and the word

```sql
ALTER TABLE collection_folders ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
```

`NOT NULL DEFAULT 0` so every existing folder is unlocked and the upgrade is invisible, which is
v24's third trap answered the same way: the unset value is not a lie a `DEFAULT` is telling, it is
the answer. No index — the column is not in any grain, any unique index or any sort, so
`the_user_schema_is_byte_identical_to_what_the_ladder_builds`' count of 62 does not move.

**`INTEGER` and read as `i64` at the row, `bool` on the struct.** The four booleans on
`collection_entries` are read as `i64` deliberately (`EntryGrain`'s doc) because that struct hands
values back to a probe. This one is *interpreted* rather than handed back, so it is a `bool` on
`CollectionFolder` and the read is `r.get::<_, i64>(6)? != 0` — a hand-edited `2` is locked, which
is the only reading of a non-zero that is not a refusal.

### The word `locked` is already taken in this codebase, and the collision is resolved by renaming the other one

`PinnedFolders.tsx`'s doc says **"Pinned, flat and locked, and every one of those three words is a
decision"**, where *locked* means the app's own folders have no rename, no delete, no move and no
`⋯` at all. That is very nearly the opposite of this feature: a folder locked under #365 is still
the reader's own drawer, still dashed, still a drop target both ways, still renameable and
movable.

**The doc comment is what changes, not the feature's name.** A reader's menu will say *Lock* and
an issue reporter will say *locked*, so the column, the field and the UI keep the word.
`PinnedFolders.tsx`'s third word becomes **fixed**, and the paragraph gains a sentence naming the
difference, because two meanings of one word inside one feature is how a later reader concludes
the pinned band is what #365 shipped.

## 3. Locking inherits down the tree

**A folder inside a locked folder is locked.** Stored per row, computed over ancestry — the reader
locks a drawer and gets the drawer, including whatever they have nested inside it. Storing an
inherited lock would be a second copy of a fact the parent already holds, and the two disagree the
first time a folder is moved.

**In SQL that is a recursive CTE, self-contained and binding nothing:**

```sql
WITH RECURSIVE locked_folders(id) AS (
    SELECT id FROM collection_folders WHERE locked <> 0
    UNION
    SELECT f.id FROM collection_folders f
      JOIN locked_folders l ON f.parent_id = l.id
)
```

`UNION` rather than `UNION ALL`, which terminates even if a hand-edited database holds the cycle
`move_folder` refuses to write. Folder counts are tens, so this is not a figure worth measuring
against the eleven-term grain.

**In TypeScript it is an ancestry walk**, and `src/lib/folderTree.ts` already walks ancestry for
the deck gallery and the wishlist. The effective-lock helper goes beside it and is used for the
badge, the greyed menu rows and the move confirmation — never re-derived at a call site.

## 4. What locking changes, in four lists

The whole design is which of these a locked folder's rows drop out of. **The organising rule: a
statement that says what the reader *has* is untouched; a statement that says what is *available*
or *on offer* excludes.**

### 4.1 Excluded — the collection's own lists, and only when asked

One term in `collection::scope` (`collection.rs:1531`), the `WHERE` shared by the page, its count
and the header, pushed in the same correlated shape the `Unallocated` arm uses at `:1595`:

```rust
if q.exclude_locked && q.folder_id.is_none() {
    p.wheres.push(
        "(e.folder_id IS NULL OR e.folder_id NOT IN (WITH RECURSIVE …))".to_owned(),
    );
}
```

Three things about that condition are each load-bearing.

**`exclude_locked` is a new `CollectionQuery` field defaulting to `false`, and the default is the
whole of its safety.** This is `root_only`'s argument verbatim: an unasked question keeps today's
answer, so a caller nobody updated cannot silently lose rows. The callers that must go on reading
everything are not hypothetical — **the plain-text mirror and the export sweep both page through
`list_entries`**, and `mirror/read.rs:64-70` already says in words that a whole-collection backup
is "the one read that must never ask" the narrowing question. An unconditional term in `scope`
would make every backup and every CSV export silently omit the reader's locked cards, raising
nothing. That is the worst failure available in this feature and the default is what forecloses it.

**`folder_id.is_none()` is what makes "except inside the folder" true.** Standing in a locked
folder — or in a subfolder of one — names it, and a named folder is served whole. This is
`root_only`'s own rule ("ignored entirely when `folder_id` names a folder") applied to a second
field, so the three-state convention gains no fourth state.

**`e.folder_id IS NULL` comes first**, `scope`'s existing reason: the root is where most copies
are and is not a folder to look up, and a `NOT IN` over a NULL is NULL rather than true, so the
root would drop out of the list that is mostly root.

Who sends it: **the collection page** and **the deck builder's Collection Search tab**. Who does
not: the mirror, the export sweep, and the web route's passthrough.

### 4.2 Excluded — "what can I build with"

`deck_theory::OWNED_SPARE_SQL` (`deck_theory.rs:314`) already excludes a deck's group by exactly
this device, and its doc already argues the point this feature needs: *"a deck on a table has its
cards, so a copy filed in a deck's group is not one this plan can count on."* A card in a display
case is not one a plan can count on either. It gains the locked arm beside the deck arm.

That is the one and only ownership-shaped statement that changes, and it changes because
`owned_spare` is a display field meaning *spare* — the doc calls it "for a reader, beside a price"
and forbids it from being a term in any arithmetic, so widening it cannot move a number anywhere
else.

### 4.3 Untouched — every statement that says what the reader HAS

Named individually, because "excluded from search" could be read onto any of them and each is a
deliberate no:

| Site | Why it does not change |
| --- | --- |
| `collection_source::owns_printing` / `copies_of_printing` / `copies_of_oracle` | The card search's owned pip and both owned badges. A graded card is a card you own; a search that stopped saying so would be the app lying about cardboard on the reader's shelf. |
| `index::CardIndex.owned` via `collection_source::owned_rowids` | The Owned/Missing facet pair. Same reason, and it must agree with the pip beside it or the greying contradicts the badge. |
| `wishlist::OWNED_SQL` | How much of a wish is already filled. A locked copy fills a want — the reader has it; buying a second is the mistake this figure exists to prevent. |
| `deck::owned_by_oracle` | Structurally cannot see a `user` folder at all (§1). |
| `import::match_columns` / `MATCH_ORDER` | Which printing a pasted line resolves to. Ranking by owned copies is a guess about *which cardboard the reader means*, and a locked copy is still their cardboard. |
| `collection_folders::folder_summary` | The per-folder tile. A locked folder's own tile must show its own contents or the badge sits above a lie. |
| `images::prewarm_keys` | Cache warming. Excluding would make the folder slow to open for no reason. |
| `reconcile.rs` | Repoints rows onto new printings and never writes `folder_id`. A locked folder's card that Scryfall has renumbered still needs repointing — the lock is about *offering*, and upkeep is not an offer. |

### 4.4 Refused — one folder write, in words

**Delete refuses a locked folder**; rename and move do not. Deleting re-files every card in the
sub-tree to the root (`delete_folder`, `collection_folders.rs:493`), which silently undoes exactly
the filing the lock was protecting. Rename and move disturb no card.

A new constant beside `FOLDER_NOT_YOURS`, in the module's existing grammar — a sentence, never a
CHECK and never a constraint failure:

```rust
pub const FOLDER_IS_LOCKED: &str =
    "That folder is locked. Unlock it before deleting it.";
```

It refuses on the **effective** lock, so a subfolder inside a locked parent is refused too — that
press scatters cards the same way.

**And the UI must not let the press happen.** `PinnedFolders.tsx`'s own rule is the standard here:
*"a control whose only outcome is a sentence explaining that it does not work teaches the reader
nothing they could not have been shown by its absence."* The pinned band answers that by omitting
the menu entirely; a locked folder keeps its menu, so Delete is **greyed with its reason in the
row's accessible name** — the grammar `blockedReason` already uses, and the thing a greyed menu
row is required to do here.

## 5. Moving cards in and out — always allowed, confirmed once

The issue is explicit that this must always be possible. **No Rust fence.** `set_entry_folder`
gains nothing: it already refuses a `deck` source and a non-`user` destination, and a locked
folder is a `user` folder on both counts.

The warning is the UI's, and it is a confirmation rather than a refusal, on the two presses that
cross the boundary:

- filing a card **into** a locked folder, and
- filing a card **out of** one.

Both name the folder. This app's confirmations carry no `dialog` or `alertdialog` role, so a test
or a CDP pass finds this one by its text — the same note the Collection Search tab's cross-deck
confirmation carries.

**A move *within* one locked folder's sub-tree is not confirmed**, because nothing has crossed the
boundary the reader drew.

## 6. The surface

### The badge
The folder card has exactly two slots today: the leading `Folder` glyph
(`CollectionFolderCard.tsx:370`) and the top-right `⋯` corner. The `⋯` is taken, so **the glyph
becomes a `Lock` when the folder is locked** — the same device `PinnedFolder` already uses to say
what kind of folder it is (`Layers` for a deck, `Inbox` for removed), passed as an `Icon` prop.

**And the word joins `folderFace`'s pair rather than being drawn beside it.** That function
(`CollectionFolderCard.tsx:134`) is the single place `shown` and `spoken` are built together, and
building them together is what stops the screen text and the accessible name drifting. A glyph
alone is not an accessible name.

**A folder locked by an ancestor draws the badge too.** It *is* locked; a badge that appeared only
on the folder the reader pressed Lock on would make the inheritance invisible exactly where it
matters.

### The menu
One row, `CollectionPage.tsx:1340`'s `folderRowMenu`, above the separator:

- **Lock folder** / **Unlock folder**, toggling on the folder's own flag.
- Greyed with its reason when an ancestor is locked — unlocking a child of a locked parent changes
  nothing, and a row that reports success while the badge stays is worse than a greyed one.
- **Delete…** is greyed with its reason when the folder is effectively locked (§4.4).

### The write
A new command, `rename_folder`'s shape exactly — the one existing "update one scalar" precedent:

```rust
pub fn set_folder_locked(conn: &Connection, id: i64, locked: bool)
    -> Result<CollectionFolder, String>
```

`user_folder(conn, id)?` first, so the app's own folders refuse with `FOLDER_NOT_YOURS` as every
other folder write does. Registered in **both** `desktop.rs`'s `generate_handler!` and
`web/route.rs`'s `COMMANDS` plus its match arm.

## 7. Sync

**One line**: `"locked"` joins `fields` in the `collection_folders` capture `Spec`
(`sync_engine/capture.rs:145`). It is not a counter, not a parent and not part of any unique
index, so `apply.rs`'s `META` needs no edit and merge is plain last-writer-wins per field — which
is right, because "is this drawer set aside" is a decision, and the last device to make it wins.

There is no wire version to bump; the only version that moves is `USER_SCHEMA_VERSION`.

**The ordering trap**: `capture.rs`'s `every_column_a_spec_names_exists_on_its_table` goes red if
the spec names `locked` before the rung creates it. Schema first.

## 8. Testing

- **Rust, `collection_folders.rs`'s in-file module**, house naming: `locking_a_folder_locks_the_folders_inside_it`, `a_locked_folder_refuses_to_be_deleted`, `a_locked_folder_can_still_be_renamed_and_moved`, `a_card_can_still_be_filed_into_and_out_of_a_locked_folder`, `collection_folder_set_locked_refuses_a_folder_the_app_owns`.
- **Rust, `collection.rs`**: `a_locked_folders_copies_drop_out_of_a_flattened_list`, `standing_in_a_locked_folder_still_lists_its_copies`, and the one that matters most —
  `a_query_that_never_asks_still_sees_a_locked_folders_copies`, which is the mirror's and the
  export's guarantee.
- **Rust, `schema.rs`**: `v33_adds_the_locked_column`, `the_v32_fixture_carries_none_of_v33`.
- **Rust, `deck_theory.rs`**: `a_locked_folders_copies_are_not_spare`.
- **`ipc.test.ts`**: `CollectionFolder` joins `plainMirrors` — the struct is on neither list today,
  and the block's own doc says adding a row is the whole of the fix and costs one line. The
  command-name pin gains the eighth wrapper.
- **Storybook**: the fake's `FakeCollectionFolder`, `toCollectionFolder`, the seeds and a
  `collection_folder_set_locked` handler, plus its `FOLDER_IS_LOCKED` refusal on delete.

**The gap this feature can fall into, named so a test is written for it:** every figure in §4.3 is
untouched *by design*, which means no test fails if somebody later "tidies" the exclusion into
`collection_source`. `a_locked_folders_copies_are_still_owned` — asserting the card search's owned
badge counts them — is the fence for the whole of that table, and it is worth more than any of the
exclusion tests.

## 9. What this deliberately does not do

- **No wishlist equivalent.** The issue is about the collection, the wishlist is a shopping list
  and nothing about it is "set aside".
- **No lock on the app's own folders.** A deck group is already fixed and `Recently removed` is a
  holding area; locking either is a control with no meaning.
- **No per-card lock.** The folder is the unit the issue asked for, and a per-card flag is a
  twelfth grain term nobody has asked for.
- **No password, no confirmation on the lock press itself.** Locking is reversible in one press
  and protects against accident rather than against a person.
