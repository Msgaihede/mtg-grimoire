# Quick collection actions on a deck card — issue #350

[Issue #350](https://github.com/Msgaihede/mtg-grimoire/issues/350) asks for three rows on a deck
card's right-click, on a **live** row whose owned count is short of what the deck plays:

- **Quick add to collection** — record the copies and file them in the deck's own group.
- **Quick add and remove from wishlist** — the same, then take the copies off a matching wish;
  prompt when several wishes match.
- **Quick pull from collection** — move copies the reader already owns loose into the deck;
  prompt when several folders could supply them.

**The third is half-built already.** [Issue #351](https://github.com/Msgaihede/mtg-grimoire/issues/351)
shipped `deck_pull_plan` / `deck_pull_from_collection` and `PullFromCollectionDialog` on
2026-09-03, with every candidate rule this issue asks for — "not already in another deck folder"
is `collection::Allocation::Unallocated` verbatim, and the dialog *is* the prompt. What is missing
is a **per-card** entrance: today the only opener is the deck-wide button in the stats band. So
this plan wires that entrance and builds the first two bullets.

## Decisions taken before any code (2026-09-03, the reader's own calls)

1. **A quick add files the whole shortfall, and the row names the number.** `Quick add 4 copies`
   on a `0/4` line, `Quick add 1 copy` on a `3/4` one. The count comes from the row the reader
   right-clicked — `max(0, quantity − ownedQuantity)`, which is exactly the `3/4` `CardStack.tsx`
   draws — so the menu never quotes a number the card is not wearing. The alternative considered
   was one copy per press; it costs four presses on the deck somebody has just finished buying.
2. **The wishlist half matches the exact printing and finish.** `w.card_id = :cardId AND
   (w.preferred_finish IS NULL OR w.preferred_finish = :finish)` — which is `wishlist::OWNED_SQL`'s
   *own* first arm with the any-printing arm dropped, rather than a second opinion about what fills
   a wish. So the narrowing is on the **printing**: a wish for "any printing" of the card is left
   standing, exactly as the pull leaves an Alpha Bolt out of an M10 line, and for the same trade —
   nothing is ever taken off a shopping list that is not the piece of cardboard the reader just
   recorded. A NULL `preferred_finish` still matches, because the list itself says "a wish that
   names no finish takes any of them"; excluding it would refuse the commonest wish there is.
3. **A prompt only when the answer is ambiguous.** One matching wish → removed, no dialog. Several
   → a picker. One pull candidate → pulled, no dialog. Several, or none → the dialog, which already
   words the empty case (`NOTHING_TO_PULL`).
4. **The three rows live in a `Collection ▸` submenu.** The deck card menu already carries thirteen
   rows; three more flat would make it sixteen on every card. Greyed with a reason rather than
   hidden — every card of this surface can be short, so an absent row would read as a bug.

## The shape of the write

`collection_add` **refuses** a `deck` folder outright (`FOLDER_NOT_YOURS`) and must go on
refusing: filing into a group asserts *this deck holds these copies*, which only a write that
answers for the `deck_cards` row behind them may say. `collection::add_entry_filed` is the private
door that takes the fence as a parameter, and `IMPORT_FOLDERS` is the widened set the deck
importer already passes. The quick add is the **second** caller of that door and the **fourth**
crossing of the deck boundary:

```text
         collection_to_deck                 deck_to_collection
binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
                                     ▲   ▲
        deck_pull_from_collection ───┘   └─── deck_quick_add_to_collection
        (moves cardboard that exists)         (records cardboard that did not)
```

It is the first of the four that **creates** copies rather than moving them, which is the whole of
why it needs its own invalidation set (`OWNED_WRITE_KEYS`, not the narrower `["collection"]` the
three movers take) and why `NOT_IN_DECK` is the fence that keeps issue #358's invariant true:
*every copy in a deck's group is backed by a row in that deck's list.*

---

## Task 1 — Rust: the module, the two commands, the audit row

**Files:** `src-tauri/src/deck_quick_add.rs` (new), `src-tauri/src/lib.rs`,
`src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs`, `src-tauri/src/collection.rs`.

### `deck_quick_add.rs`

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct QuickAddWish {
    pub id: i64,
    pub quantity: i64,
    pub folder_id: Option<i64>,
    pub folder_name: Option<String>,   // None at the root; the UI words it
}

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct QuickAddOutcome {
    pub copies: i64,      // what was recorded
    pub entry_id: i64,    // the row, after the grain fold
    pub wish_copies: i64, // taken off the wish; 0 when none was named
}

pub fn wishes(conn: &Connection, card_id: &str, finish: Option<&str>)
    -> Result<Vec<QuickAddWish>, String>;

pub fn quick_add(
    conn: &Connection, deck_id: i64, card_id: &str, finish: Option<&str>,
    condition: Option<&str>, quantity: i64, wish_id: Option<i64>,
) -> Result<QuickAddOutcome, String>;
```

`finish` is the **deck row's** finish — `None`/`"nonfoil"` are the regular copy, through
`deck::normalise_finish`; the collection word is `normalise_finish(..)?.unwrap_or("nonfoil")`.

**`wishes`** — one statement, `LEFT JOIN wishlist_folders`:

```sql
SELECT w.id, w.quantity, w.folder_id, f.name
  FROM wishlist_entries w LEFT JOIN wishlist_folders f ON f.id = w.folder_id
 WHERE w.card_id = ?1 AND (w.preferred_finish IS NULL OR w.preferred_finish = ?2)
 ORDER BY (w.folder_id IS NOT NULL), f.sort_order, w.id
```

The root first, then the reader's folders in their own `sort_order`, oldest row first inside a tie
— `deck_pull::PullCandidate`'s order and its argument (rank by how little of the reader's filing
the write disturbs), borrowed rather than re-decided.

**`quick_add`**, one transaction, in this order — the order *is* the rule, `collection_to_deck`'s
discipline:

1. `quantity <= 0` → refuse. Reuse `collection::ZERO_ADD` if it is public; widen it to
   `pub(crate)` rather than spelling a second sentence.
2. `deck::touch_deck(&tx, deck_id)?` — doubles as the deck fence, so a stale editor's dead deck id
   hears `deck::GONE` and not `NOT_IN_DECK`.
3. `deck::plays_card(&tx, deck_id, card_id)?` → else `collection_alloc::NOT_IN_DECK`. This reads
   the **live** list only, so a card the deck merely *plans* is refused here with no theory fence
   of its own — say so in a doc comment, it is not an omission.
4. `deck::deck_group(&tx, deck_id)?` → else `collection_alloc::NO_DECK_GROUP`.
5. `collection::add_entry_filed(&tx, &input, collection::DECK_WRITE_FOLDERS)` with
   `folder_id: Some(group)`, `finish`, `condition`, `quantity`, and every other `EntryInput` field
   at its empty value. The grain fold is that function's, so a second quick add on the same line
   raises the row already in the group rather than making a second one.
6. If `wish_id` is `Some`: re-read the wish **inside** the transaction and re-check it against
   the same predicate `wishes` used — the pull's discipline, because the dialog's answer is a
   round trip old. Gone → `WISH_GONE`; no longer a match → `WISH_WRONG_CARD`. Then
   `take = min(quantity, wish.quantity)`; `take == wish.quantity` deletes the row, otherwise
   `wishlist_entries.quantity -= take`.
7. One `deck_audit` row: `kind = 'move'`, `card_id` NULL, `delta = 0`, payload
   `{"quickAdd": {"copies": N, "wishes": M}}`. **`AUDIT_KINDS` stays at nine** — SQLite has no
   `ALTER … CHECK`, so a tenth word rebuilds every reader's history for a spelling;
   `deck_import_commit`, `deck_undo` and `deck_pull` each reached that conclusion first, and this
   is the fourth reuse. `delta` is 0 and honest: the deck's *list* gained nothing.

New sentences in this module (each a sentence, never a constraint failure):

| Constant | Sentence |
| --- | --- |
| `WISH_GONE` | That wishlist line is not there any more. |
| `WISH_WRONG_CARD` | That wishlist line is not for this card. |

### `collection.rs`

- `add_entry_filed` → `pub(crate)`.
- `IMPORT_FOLDERS` → **renamed** `DECK_WRITE_FOLDERS` and made `pub(crate)`, with its doc updated
  to name **both** callers (the deck import and the quick add). A constant called `IMPORT_` that a
  non-import write passes is exactly the rot this repo greps for. Six call sites plus a test
  comment near line 5155.
- `ZERO_ADD` → `pub(crate)` if it is not already.

### Registration

Grep `deck_pull_plan` across `src-tauri/` and mirror **every** site: `lib.rs`'s `pub mod`
(a module `lib.rs` never names makes every test in it vacuous), `desktop.rs`'s
`generate_handler!`, and `web/route.rs`'s **two** places — the command-name list near line 119 and
the `match` arm near line 1180. The read takes `sync::lock_db_read`; the write takes
`collection_source::with_write_owned`, because it creates a `collection_entries` row and the facet
index's `owned` dimension counts rows.

### Tests (inline `#[cfg(test)]`, this crate's convention)

The copies land in the group and nowhere else; a second press folds on the grain rather than
making a second row; a deck that does not play the card is refused (`NOT_IN_DECK`) and **leaves
nothing behind**; a gone deck answers `deck::GONE` and not `NOT_IN_DECK`; a theory-only card is
refused; zero copies are refused; a named wish is decremented, and deleted at zero; a wish that
has moved on is refused **and the whole press rolls back** (no copies recorded); a wish for
another printing is refused; a `preferred_finish IS NULL` wish matches; a `foil` wish does not
match a nonfoil press; an any-printing wish (`card_id IS NULL`) is **not** offered; the audit row
is written with `delta = 0` and no `card_id`.

---

## Task 2 — TypeScript: the wire, the hook, and the pure decision

**Files:** `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/features/decks/useDeck.ts`,
`src/features/decks/useDeck.test.ts`, `src/features/decks/quickAdd.ts` (new),
`src/features/decks/quickAdd.test.ts` (new), `src/features/decks/auditText.ts`,
`src/features/decks/auditText.test.ts`, `src/features/card/useCardMenuDeps.ts` (export one const).

### `ipc.ts`

```ts
export interface DeckQuickAddWish { id: number; quantity: number;
                                    folderId: number | null; folderName: string | null }
export interface DeckQuickAddOutcome { copies: number; entryId: number; wishCopies: number }

deckQuickAddWishes: (cardId: string, finish: DeckFinish) =>
  invoke<DeckQuickAddWish[]>("deck_quick_add_wishes", { cardId, finish }),
deckQuickAddToCollection: (deckId: number, cardId: string, finish: DeckFinish,
                           condition: string, quantity: number, wishId: number | null) =>
  invoke<DeckQuickAddOutcome>("deck_quick_add_to_collection",
    { deckId, cardId, finish, condition, quantity, wishId }),
```

Argument names are matched **by name** by `invoke`, so add rows to `ipc.test.ts`'s mirror the way
the pull's are written — including the `?raw` cross-check against `deck_quick_add.rs`.

### `useCardMenuDeps.ts`

Export `MENU_CONDITION` (currently a private `"NM"`). The quick add records a copy at the same
condition every other menu add does, and two spellings of that default drift the first time either
changes. One line of change; do not move the constant.

### `useDeck.ts`

`quickAddToCollection` mutation, taking `{ card, quantity, wishId }`. It is the **one write in
this hook that can create a collection row**, so it takes `query.ts`'s `OWNED_WRITE_KEYS` and not
the narrower `invalidateCollection` the three movers share — the comment at the deleted `own` add
(around line 374) says exactly why, and this is the write that brings that case back. Plus
`["wishlist"]`, because the second arm can delete a wish.

`quickAddWishes` is **not** a hook — it is fetched imperatively at the press
(`queryClient.fetchQuery`), so a right-click still fires nothing. Export a `quickAddWishesQuery`
options factory from `useDeck.ts` so the editor and any test build the same key:
`["wishlist", "forPrinting", cardId, finish ?? ""]`.

### `quickAdd.ts` — the pure half

```ts
/** What the row the reader right-clicked is short of. Exactly the `3/4` CardStack draws. */
export function quickAddShort(card: DeckCard): number

/** Why the three rows are greyed, or `null` when they are live. */
export function quickAddBlock(card: DeckCard): "theory" | "nothing-missing" | null

/** What to do with the wishes a press found. */
export type WishChoice =
  | { kind: "none" } | { kind: "one"; wish: DeckQuickAddWish }
  | { kind: "many"; wishes: readonly DeckQuickAddWish[] };
export function chooseWish(wishes: readonly DeckQuickAddWish[]): WishChoice

/** Whether a pull of this card needs the dialog, and the picks when it does not. */
export type PullChoiceForCard =
  | { kind: "ask" } | { kind: "take"; picks: DeckPullPick[] };
export function choosePull(rows: readonly DeckPullRow[], card: DeckCard): PullChoiceForCard
```

`choosePull` finds the row whose `pullKey` matches `pullKey(card)` (reuse `pullPlan.ts`'s
exported `pullKey` — it takes `Pick<DeckPullRow, "cardId" | "finish">`, which a `DeckCard`
satisfies). **Ambiguous is `candidates.length >= 2`**, nothing else: a lone candidate holding
fewer copies than the shortfall is still unambiguous — take what there is. No row at all → `ask`,
so the dialog's own `NOTHING_TO_PULL` does the explaining rather than a second sentence here.

### `auditText.ts`

A `quickAdd` payload branch, read **before** the per-card branches and beside `pull`'s, for
`pull`'s reason: the `move` arm would render it as "Moved a card" — a sentence about a card the
row has not got. Copies in the sentence, wishes in the detail:
`Recorded 4 copies for this deck` / detail `1 copy off your wishlist` (omit the detail at zero).
**`wishes` in the payload counts _copies_ off one wish line, never lines** — the write takes at
most one `wish_id` — so the detail says `copies`. The plan said `1 wish cleared` until the
boundary was implemented and both sides flagged the ambiguity.

---

## Task 3 — The menu

**Files:** `src/features/decks/deckCardMenu.tsx`, `src/features/decks/deckCardMenu.test.tsx`.

Three optional deps, each a callback — this builder stays pure and every write arrives as an
argument, `cardMenu`'s and `categoryMenu`'s contract:

```ts
quickAdd?: (card: DeckCard, copies: number) => void;
quickAddAndUnwish?: (card: DeckCard, copies: number) => void;
pullCard?: (card: DeckCard) => void;
```

Absent → the whole `Collection ▸` item is **not built**, which is the surface saying it wired no
writes (`moveItem`'s absence rule). Present → one submenu, placed after `moveItem` and before the
zone rows, because it is filing like `Move to` and the zone rows are claims:

```text
Collection            ▸  LibraryBig
    Quick add 4 copies             Plus
    Quick add 4 and remove from wishlist   HeartOff
    ─────────
    Pull 4 from your collection    PackageOpen
```

Singular grammar for one copy (`Quick add 1 copy`, `Pull 1 from your collection`); use `plural`
from wherever this feature already spells it (`PullFromCollectionDialog` has one).

**All three rows stay singular about the right-clicked card even when a set is picked**, and that
is a statement rather than an omission — `finishItem`'s argument: the count in each label is a
fact about *one row's* shortfall, and a set of four rows short by four different amounts has no
one number to name. Say so in the builder's doc.

**Greyed with a `reason`**, per `quickAddBlock`:

| Block | `reason` |
| --- | --- |
| `theory` | `a plan holds no cards` |
| `nothing-missing` | `nothing missing` |

Grey the three rows, not the parent — the parent staying live is what lets a reader read the
reason. Verify `HeartOff` and `PackageOpen` exist in the installed `lucide-react` before using
them; substitute from what the repo already imports if not.

---

## Task 4 — The editor, the two dialogs

**Files:** `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckEditor.test.tsx`,
`src/features/decks/DeckEditor.stories.tsx`, `src/features/decks/QuickUnwishDialog.tsx` (new)
+ test + stories, `src/features/decks/PullFromCollectionDialog.tsx` + its test and stories.

### `PullFromCollectionDialog`

Two new optional props and nothing else moves:

- `cardName?: string | null` — when set the subtitle reads
  `Copies of {cardName} you already own — into {deckName}` instead of the deck-wide sentence.
- The editor passes **already-filtered** `rows`; the dialog does no filtering. Keeping the filter
  at the caller is what stops this component growing an opinion about a `PullKey`.

### `QuickUnwishDialog` (new)

Opened only for `{ kind: "many" }`. Lists the matching wishes — folder name, or `Wishlist` for the
root, the same word the wishlist page uses for `folder_id IS NULL`; and each row's quantity — as a
radio group, first pre-selected (the backend's order is the pre-pick, exactly as the pull's is).
Confirm → the mutation with that `wishId`. **Cancel does nothing at all**, including the add: the
reader asked for both halves and got neither, which is the only answer a cancel can honestly give.
Built on `Dialog.tsx`, one `onDismiss`/`onClose` pair like its neighbours.

### The wiring

Two new `Layer` arms, each with the payload the opener cannot re-derive:

```ts
| { kind: "quickUnwish"; card: DeckCard; copies: number; wishes: readonly DeckQuickAddWish[] }
| { kind: "pull"; card?: DeckCard }   // widened: absent is the deck-wide button
```

`layerMatches` already asks about payloads (`export`'s arm), so the stats-band opener stays
`{ kind: "pull" }` and the per-card one carries the card.

The three handlers:

- **`quickAdd(card, copies)`** → mutate with `wishId: null`. No read, no dialog.
- **`quickAddAndUnwish(card, copies)`** → `await queryClient.fetchQuery(quickAddWishesQuery(...))`,
  then `chooseWish`: `none` → mutate with `null`; `one` → mutate with that id; `many` → open the
  layer. A failed read must reach the editor's banner — it is a read the reader pressed for, and
  a silent nothing is the worst answer.
- **`pullCard(card)`** → `await queryClient.fetchQuery(pull-plan options)`, then `choosePull`:
  `take` → `deck.pullFromCollection.mutate(picks)`; `ask` → open `{ kind: "pull", card }` with the
  rows filtered to `pullKey(card)`.

Hoist the pull plan's query options into a shared factory in `useDeck.ts` so `usePullPlan` and
this `fetchQuery` cannot disagree about the key — a second spelling here is a fetch that never
shares the dialog's cache.

The caret: these presses come from a menu, and `ContextMenu`'s `run` focuses the opener **before**
it calls `onSelect`, so read `document.activeElement` for the hand-back exactly as `openAddLabel`
already does.

---

## Task 5 — The Storybook fake

**Files:** `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`.

`deck_quick_add_wishes` (read) and `deck_quick_add_to_collection` (write), against the fake's own
tables and with the **same** refusals the crate words — a fake that cannot refuse is a fake that
lets a story pass on a press the app would reject. Model them on the `deck_pull_plan` /
`deck_pull_from_collection` pair at lines ~6526 and ~9876. Seeds and a fault for each refusal, per
`.storybook/CLAUDE.md`.

---

## Task 6 — The record

**Files:** `docs/reference/decks-storage.md`, `docs/reference/collection-folders.md`,
`src/features/decks/CLAUDE.md`, `src-tauri/CLAUDE.md`.

- `decks-storage.md` — a section after "The pull": the quick add as the **fourth** crossing and
  the first that creates copies; the two commands; the wishlist predicate and why it is
  `OWNED_SQL`'s first arm; the audit reuse; and the two-press cost when one card is short in two
  piles (the count is the *row's*, deliberately, because it is the number on screen).
- `collection-folders.md` — the ASCII pair diagram in "The two writes, and why a deck group is not
  a drop target" gains a fourth arrow, and the sentence "A third write joined them on 2026-09-03"
  gains its fourth. Say plainly that `add_entry_filed`'s widened fence is now passed by two
  callers and what each answers for.
- `src/features/decks/CLAUDE.md` — the `Collection ▸` submenu under **Writes**, the three rows,
  why they stay singular under a picked set, and the two greyed reasons.
- `src-tauri/CLAUDE.md` — the new module in whatever table lists the crate's modules.

**Re-count anything you change.** A prose-only edit routes to neither CI job, so nothing goes red
when a list rots; do not write down a number a build already answers.

---

## Fan-in

`npm run verify` is run **once**, by the dispatcher, after every task reports — not inside any of
them. A subagent's slice compiles against a tree its siblings are still changing.
