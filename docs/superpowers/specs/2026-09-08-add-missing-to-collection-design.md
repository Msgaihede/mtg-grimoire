# Add missing to collection

Raised in conversation on 2026-09-07, not from an issue: *"We need to implement a 'Send missing
cards to collection' from the deckbuilder. The user should be presented with a preview before
adding the cards, same way we have a 'Send to wishlist'."* No schema change. This is the design;
[decks-storage.md](../../reference/decks-storage.md) is the page that will hold the record of what
ships.

**The one sentence: the deck already knows what it is short of, and this is the press for the
copies the reader has just bought.** Everything below is a consequence of that — *just bought*
means the cardboard exists and the database has never heard of it, which is a **create** and not a
move, and it is the only one of the three answers to a shortfall that is.

## 1. The press, and the row of three it completes

`DeckStats`' missing band (`src/features/decks/DeckStats.tsx:748`) draws the shortfall and two
buttons beside it. Its own doc calls them *"two presses because the shortfall has two answers"*.
There were always three, and the third has existed per-card since 2026-09-03 — a deck card's
right-click carries `Collection ▸ Quick add N copies`, which is
`deck_quick_add::quick_add` (`src-tauri/src/deck_quick_add.rs:266`) — with no deck-wide form and
no preview. This adds both.

| Press | Answers | What it does to cardboard |
| --- | --- | --- |
| `Pull from collection` | copies you already own, loose | **moves** it |
| **`Add missing to collection`** | copies you have **just bought** | **creates** it |
| `Send missing to wishlist` | copies you still have to buy | writes a list |

**The order is that table's and is the recommendation.** The band's existing comment argues the
pull goes first because *"a hole a reader can fill out of their own binder is one they should be
offered before they are offered a shopping list for it"*. The new press belongs in the middle for
the same argument read one step on: own it → just got it → have not got it. Putting it last would
place "record what you bought" after "add it to a shopping list", which is the two states in the
wrong order.

**Three buttons is not a width problem here.** The band is
`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1`, so it wraps rather than overflowing — which
is exactly why the pull was put in this row rather than in the editor's header, where the ribbon
measured 825px against ~729 available. Nothing about the third button changes that argument.

## 2. Wording

The button reads **`Add missing to collection`** (approved 2026-09-07; the brainstorm proposed
`Send missing to collection` and it was renamed). `Add` rather than `Send` is what kills the
ambiguity the brainstorm flagged: this control sits next to `Pull from collection`, and a reader
who parses the pair as opposites is wrong — one moves, one creates. *Add* is the verb the
collection page already uses for the thing that makes a row (`AddToCollection.tsx`), so the word
carries the meaning before the dialog explains it.

The dialog is titled `Add missing to collection` and its subtitle says the rest in words:

> Records copies you have just acquired into this deck's own folder. Nothing is moved out of your
> collection.

The file names follow the button rather than the brainstorm: `AddMissingToCollectionDialog.tsx`
and `addMissingPlan.ts`.

## 3. Rust

### 3.1 One shortfall walk, three callers — `deck::live_shortfall`

The walk that turns a deck into *"what is it short of"* is written twice today and this feature
would write it a third time:

- `deck_pull::plan` (`src-tauri/src/deck_pull.rs:305`) — folds at `(card_id, finish)`, keeps the
  deck's read order, skips inactive piles, collects category names.
- `deck::missing_to_wishlist` (`src-tauri/src/deck.rs:4610`) — folds at `oracle_id` into a
  `BTreeMap`, skips inactive piles, skips rows with no `oracle_id`.

Both open on `get_deck(conn, deck_id, LIVE, Marketplace::default())`, both compute
`quantity - owned_quantity`, both skip `!category_active`. Extract:

```rust
/// One printing-and-finish the live list is short of, before anything is folded onto it.
pub struct ShortfallRow {
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: Option<String>,
    pub short: i64,
    pub categories: Vec<String>,
    pub image_uris: Option<BTreeMap<String, String>>,
}

pub fn live_shortfall(conn: &Connection, deck_id: i64) -> Result<Vec<ShortfallRow>, String>;
```

Three callers, each folding its own thing onto it:

- **`deck_pull::plan`** maps each row into a `PullRow`, attaches candidates, and drops the rows
  with none.
- **`deck_missing::plan`** (§3.3) attaches wishes and drops the orphans.
- **`missing_to_wishlist`** folds further into its `BTreeMap<oracle_id, (name, sum)>`, skipping
  `oracle_id: None`.

**Folding twice gives the same answer as folding once, and the reason is worth writing down**:
`oracle_id` is a property of the `cards` row, so every `(card_id, finish)` bucket of one printing
carries the same one, and summing per pair then per oracle id is the same sum. The `BTreeMap`
keeps its key order regardless of what order rows arrive in, so `add_wish` is still called in
oracle-id order and `touched` is still the same count — **this refactor must change no observable
behaviour of either existing command**, and `deck_pull`'s and `deck`'s existing tests are the
fence that says so. It lands as its own commit, ahead of the feature.

`&Connection` so both a bare connection and an open transaction fit — `plan` calls it on `conn`,
`missing_to_wishlist` on its `tx`, and both are `&Connection` today.

### 3.2 The new module — `src-tauri/src/deck_missing.rs`

A module of its own beside `deck_pull.rs` and `deck_quick_add.rs`, for the reason those two are
separate: `generate_handler!` takes the **last path segment** as the wire name, so
`deck_missing::commands::deck_missing_plan` registers as `deck_missing_plan` while the crate says
`deck_missing::plan`.

**The names do not collide with `deck_missing_to_wishlist`** (which lives in `deck.rs`) and read
as a set: `deck_missing_plan`, `deck_missing_to_collection`, `deck_missing_to_wishlist`.

Two error constants are **reused rather than respelled**, which is this crate's standing rule
(`collection::ZERO_ADD`, `collection_alloc::NOT_IN_DECK`):

- `deck_pull::NOT_SHORT_OF_THAT` — *"This deck is not short of that printing any more."*
- `deck_pull::MORE_THAN_MISSING` — *"That is more copies than this deck is short of."*

Two are new, because no existing sentence says what they say:

```rust
/// A press that records nothing is a write that did nothing dressed as one.
pub const NOTHING_PICKED: &str = "Pick at least one copy to add to your collection.";

/// The printing left `cards` between the read and the press — a corpus resync under an open
/// dialog. Distinct from NOT_SHORT_OF_THAT, which is about the deck; this is about the card.
pub const LEFT_THE_DATABASE: &str =
    "That printing has left the card database and cannot be recorded.";
```

### 3.3 The read — `deck_missing_plan`

```rust
pub struct MissingRow {
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: Option<String>,
    pub short: i64,
    pub categories: Vec<String>,
    pub image_uris: Option<BTreeMap<String, String>>,
    /// Every wishlist line these copies could take down, best first — `deck_quick_add::wishes`'
    /// answer for this printing and finish, verbatim. Empty is the ordinary answer.
    pub wishes: Vec<crate::deck_quick_add::QuickAddWish>,
}

pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<MissingRow>, String>;
```

`live_shortfall`, then per row `deck_quick_add::wishes(conn, &card_id, finish)` — the same
function the per-card menu calls, so the two entrances cannot come to disagree about what fills a
wish. Its predicate and its ordering are argued in that module's `WISH_SQL` doc and are not
re-decided here.

**Three things this read does *not* do, each deliberate:**

- **It does not drop a row because the reader could pull it instead.** A binder copy and a copy
  bought this morning are two different pieces of cardboard, and a plan that hid the second
  because of the first would refuse to record a card the reader is holding. The two presses
  overlap by design and the reader chooses.
- **It does not exclude a printing with zero matching wishes.** Most rows will have none; a wish
  is a bonus the press clears, never a condition of it.
- **It does drop an orphan** — a `card_id` with no `cards` row. This is the one filter, and it
  exists because it is exactly the write's own precondition:
  `collection::add_entry_filed` calls `printing_of` (`src-tauri/src/collection.rs:425`), which
  refuses with *"no card with the id `…` is in the card database"*. A row the write must refuse is
  a row the dialog can only draw as an apology, so — `deck_pull::plan`'s rule about candidates,
  applied to a different reason for the same shape of emptiness — it is left out. One prepared
  `SELECT 1 FROM cards WHERE id = ?1` for the whole plan, the way `plan` prepares `CANDIDATE_SQL`
  once.

  Note this is a **narrower** test than `missing_to_wishlist`'s `oracle_id.is_none()`: a card row
  can exist with a NULL `oracle_id`, which a wish cannot be written for but a collection entry
  can. The two commands' filters genuinely differ and neither is the other's typo.

An empty vector is the ordinary answer: a deck whose whole shortfall is orphaned printings has
nothing here and is not an error. The dialog says so in words (§5.2).

### 3.4 The write — `deck_missing_to_collection`

```rust
pub struct MissingPick {
    pub card_id: String,
    pub finish: Option<String>,
    pub quantity: i64,
}

pub struct MissingOutcome {
    pub copies: i64,
    /// Rows of the plan that got at least one copy — printings **and finishes**.
    pub cards: i64,
    /// Copies taken off wishes, not a count of wish rows — `QuickAddOutcome::wish_copies`' unit.
    pub wish_copies: i64,
}

pub fn to_collection(
    conn: &Connection,
    deck_id: i64,
    picks: &[MissingPick],
    clear_wishes: bool,
) -> Result<MissingOutcome, String>;
```

**The pick is addressed by `(card_id, finish)`, not by an entry id**, and that is the structural
difference from the pull: a pull points at a `collection_entries` row that exists, and this one
names cardboard that does not yet.

The steps, in this order, each of them a rule:

1. **Empty picks refused before the transaction opens** — `NOTHING_PICKED`. A refusal that has
   already begun a write is a rollback the reader pays for; `quick_add` and `collection_to_deck`
   both open this way.
2. **`deck::touch_deck`**, which doubles as the deck fence: a stale editor hears `deck::GONE`
   rather than something about cards. A press that changes what the deck holds is a change to the
   deck.
3. **`deck::deck_group`**, else `collection_alloc::NO_DECK_GROUP`. One group per deck since schema
   v25; `None` is a hand-edited database, and filing at the root instead would record copies no
   deck claims.
4. **Re-plan inside the transaction** — `plan(&tx, deck_id)`, orphan filter included. The dialog's
   answer is a round trip old, which is `deck_pull::from_collection`'s discipline and
   `take_wish`'s: nothing the caller sent is trusted.
5. **Every pick checked against that re-plan, all of them, before anything is written.**
   `quantity <= 0` → `collection::ZERO_ADD`; no row at that `(card_id, finish)` → the card exists
   but the deck is not short of it, `NOT_SHORT_OF_THAT`; the card has left `cards` →
   `LEFT_THE_DATABASE`; the picks for one row summing past its `short` → `MORE_THAN_MISSING`.
   **Duplicate picks for one key are summed and then checked**, so two picks of 3 against a
   shortfall of 4 are one refusal and not two accepted writes.
6. **`collection::add_entry_filed` per row**, with `DECK_WRITE_FOLDERS` and
   `EntryInput { card_id, finish, condition, quantity, folder_id: Some(group), ..Default::default() }`
   — `quick_add`'s step 5 exactly, including `..Default::default()` so a purchase price or a
   source this press did not ask for is not invented. The grain fold is that function's: a second
   press on the same line raises the row already in the group.
7. **The wishes, when `clear_wishes`** — for each written row, `deck_quick_add::wishes(&tx, …)`
   re-read inside the transaction, and copies taken off **only when exactly one line matches**.
8. **One `deck_audit` row** for the whole press (§3.6), then commit.

**All-or-nothing**, `deck_pull::from_collection`'s rule and for its reason: this write files no
`deck_undo` step, so a half-applied batch has no press that takes it back. One transaction.

**The wish rule is "exactly one, or leave it alone", and it is why the wire carries no wish id.**
`quick_add` takes one `wish_id` because a right-click can open a picker; a deck-wide press over
thirty rows cannot ask thirty questions, and the brainstorm settled this as *no nested picker*. So
the write re-asks `WISH_SQL` and acts only on an unambiguous answer:

- **one** matching line → `min(recorded, wish.quantity)` off it, deleting the row when that takes
  the lot (`wishlist_entries.quantity` is `CHECK (quantity > 0)`).
- **none, or two or more** → untouched, and the dialog said so before the press.

A consequence worth stating: **this write has no stale-wish refusal.** `WISH_GONE` and
`WISH_WRONG_CARD` exist because `quick_add` is *pointed at* a line; this one chooses inside the
transaction, so a line that vanished under the dialog is simply not among the matches and the
press carries on. The reader is told what happened by the count in the outcome, not by a refusal.

### 3.5 Where this departs from the approved brainstorm

The brainstorm said `quick_add`'s seven steps would be extracted into a `record_one(&tx, …)` that
both the per-card command and the batch call, *"so there stays one implementation of 'file copies
into a deck group and take a wish down'"*. **Reading the code, that extraction does not fit and
should not be forced**, and this is flagged rather than quietly dropped:

- The **fences differ**. `quick_add` calls `deck::plays_card`, else `NOT_IN_DECK`. The batch's
  re-plan is a strictly stronger check — a card the deck does not play has no shortfall row — so
  calling `plays_card` too would be a second fence for a case the first already covers, and a
  second sentence for one mistake.
- The **wish halves differ**, per §3.4: one is named, one is chosen.
- What is genuinely written twice is the eight-line `EntryInput` + `add_entry_filed` call.

So the shared unit is that, and only that:

```rust
/// File copies into a deck's group. The one spelling of the `EntryInput` a deck-boundary
/// create uses, so a column added to that struct cannot mean two things in two modules.
pub(crate) fn record_copies(
    tx: &Connection,
    group: i64,
    card_id: &str,
    finish: &str,
    condition: Option<&str>,
    quantity: i64,
) -> Result<crate::collection::EntryChange, String>;
```

in `deck_quick_add.rs` (which owns the idea), called by `quick_add`'s step 5 and by the batch's
step 6. If that reads as too small a piece to be worth a function, the alternative is to leave
`quick_add` untouched and let the batch spell the `EntryInput` itself — say so and it will be cut.

### 3.6 The audit row, and why `AUDIT_KINDS` stays at nine

`deck_audit.kind`'s CHECK cannot be altered — SQLite has no `ALTER … CHECK` — so a tenth word
rebuilds every reader's whole deck history for a spelling. This is the fifth reuse of an existing
kind with a payload key nothing else writes:

```json
{ "quickAdd": { "copies": N, "wishes": M } }
```

on kind `move`, `card: None`, `delta: 0` — byte for byte what `quick_add` writes, with the totals
of the batch. `auditText.ts`'s `quickAddLine` (`src/features/decks/auditText.ts:407`) already
renders it as *"Recorded N copies for this deck"* + *"M copies off your wishlist"*, which reads
correctly for a batch, so **`auditText.ts` needs no change and no new word**.

**One row, not N.** The history drawer is a reader's record of what they did, and they did one
thing. `delta` is 0 and honest: the *list* gained nothing — the deck asked for four copies before
the press and asks for four after it.

### 3.7 The commands

```rust
pub mod commands {
    // deck_missing_plan — read-only connection, no marketplace: nothing in the answer is priced.
    // deck_missing_to_collection — collection_source::with_write_owned, NOT bare with_write.
}
```

`with_write_owned` for `deck_quick_add_to_collection`'s reason, which this write owes even more
plainly: the facet index's `owned` dimension counts `collection_entries` **rows**, and this is a
command that makes several of them in one press.

**Nothing sync-specific to write.** `collection_entries` and `wishlist_entries` carry capture
triggers installed by `prepare_database`, so the ops are logged by the same machinery that logs
`quick_add`'s — a batch inside one transaction is captured row by row exactly as a loop of single
presses would be.

Registered in `src-tauri/src/desktop.rs` beside the pull's pair, and in **both** places in
`src-tauri/src/web/route.rs` (the name list at the top and the dispatch `match`).

## 4. The wire

`src/lib/ipc.ts` gains the hand-written mirrors, field for field, each with the doc that carries
the reasoning from the reader's end:

```ts
export interface DeckMissingRow { cardId; name; setCode; collectorNumber;
  finish: DeckFinish; short; categories: string[];
  imageUris?: Partial<Record<ImageVariant, string>> | null;
  wishes: DeckQuickAddWish[] }              // the existing type, reused

export interface DeckMissingPick { cardId: string; finish: DeckFinish; quantity: number }
export interface DeckMissingOutcome { copies: number; cards: number; wishCopies: number }

deckMissingPlan: (deckId) => invoke<DeckMissingRow[]>("deck_missing_plan", { deckId })
deckMissingToCollection: (deckId, picks, clearWishes) =>
  invoke<DeckMissingOutcome>("deck_missing_to_collection", { deckId, picks, clearWishes })
```

Both commands get a row in `ipc.test.ts`'s mirrors table — the opt-in fence that catches
Rust↔`ipc.ts` drift — and both get handlers in `.storybook/fake/db.ts`.

## 5. Frontend

### 5.1 `src/features/decks/addMissingPlan.ts`

Pure, no DOM and no query client. `pullPlan.ts`'s discipline exactly: the backend's rows are the
facts, the reader's state is only what **departs** from the default, and everything drawn is
derived.

```ts
export interface MissingChoice {
  readonly off: ReadonlySet<PullKey>;          // absence is ON
  readonly copies: ReadonlyMap<PullKey, number>; // absence is "all of it"
}
export const NO_MISSING_CHOICE: MissingChoice;
export function toggleRow(c, key, on): MissingChoice;
export function setCopies(c, key, n): MissingChoice;
export function planAddMissing(
  rows: readonly DeckMissingRow[], choice: MissingChoice, clearWishes: boolean,
): AddMissingPlan;
```

**`pullKey` is imported from `pullPlan.ts` rather than respelled.** It takes
`Pick<DeckPullRow, "cardId" | "finish">`, which a `DeckMissingRow` satisfies structurally, and its
`cardId|finish` grain is exactly this plan's grain too. A second spelling of that string is a
second thing to drift.

**The reader's departure is a copy count, where the pull's was a source.** That is the whole
difference between the two files: a pull chooses *which* copies, because they exist and sit
somewhere; this chooses *how many*, because they do not exist yet and the reader may have bought
two of the four.

`AddMissingPlan` carries the derived per-row state the dialog draws — `on`, `copies`, and a
`wish`, which is a **tagged union** rather than a record beside a bare string:

```ts
type RowWish =
  | { kind: "one"; clears: number; folderName: string | null }
  | { kind: "ambiguous"; matches: number }
  | null;
```

`kind` on both arms, because the dialog switches on it and a `typeof wish === "string"` test
against a `"ambiguous"` sentinel is a narrowing that reads as a mistake every time it is met. The
ambiguous arm carries its `matches` count for the same reason the one arm carries `clears`: the
sentence beside the row quotes a number, and a component recomputing it from `row.wishes.length`
would be a second place that number is decided. Plus the footer totals `picks`, `copies`,
`cards`, `wishesCleared`. Clamping lives here: a stored count above a
row's `short` is clamped rather than honoured, so a re-read that lowered a shortfall cannot leave
the footer previewing a press the backend will refuse.

### 5.2 `src/features/decks/AddMissingToCollectionDialog.tsx`

`Dialog.tsx` chrome. **It holds no query and no mutation** — rows and a narrowed write arrive as
props, exactly as `PullFromCollectionDialog` takes `rows` and `pull`. Four states of the body, and
none may be folded together: `loading`, `readError`, **empty**, and rows to review.

The empty state is the one that looks like a failure and is an ordinary answer: *"Nothing here can
be recorded — everything this deck is short of has left the card database."* That is the only way
a plan is empty while the button that opened it was drawn, and a blank panel reads as broken.

Per row: art, name, `FinishMark`, set/collector, the piles it is short in, and a stepper defaulted
to the full shortfall with the row ticked. Everything ticked on open, one press in the footer.

The wish line sits beside the row as a fact, never as a question:

- one match → *"clears 2 copies off a wish in Buy soon"* (the folder's name, or `Wishlist` at the
  root — the UI words that, not the backend, which is `QuickAddWish::folder_name`'s own rule)
- two or more → *"2 wishlist lines match — left alone"*
- none → nothing at all

Footer: a checkbox **`Also take these off my wishlist`**, on by default, and the press
`Add N copies to collection`. The checkbox is one control for the whole batch because the
per-row answer is already drawn beside each row; a reader who wants one row's wish kept unticks
the row's copies, not its wish.

### 5.3 `DeckStats`

A third button between the two, per §1. The prop is `onAddMissing: (() => void) | null` — **`null`
on the theory list**, absent rather than greyed, which is exactly what `onPull` does and for the
same reason: a plan holds no cards (`collection_alloc::THEORY_HOLDS_NOTHING`), so there is nothing
to be short of. Drawn only inside the `missing > 0` arm, like both its neighbours.

The class list is its neighbours', character for character, so the three cannot drift into reading
as a primary and two secondaries. Like the pull it takes `aria-haspopup="dialog"` and no
`aria-expanded` (the layer it opens is a full-window overlay, so no reader can observe the state),
and it takes no `disabled` from the wishlist write in flight — three independent writes about one
number.

**It gets no `spent` state.** `Send missing to wishlist` has one because pressing twice wishes for
the same copies again; this press cannot be repeated harmfully, because the second press re-plans
against a shortfall the first one just closed and finds nothing to offer.

### 5.4 `DeckEditor` and `useDeck`

- `DeckEditor` gets a `{ kind: "addMissing" }` layer arm — **no `card` field**, unlike the pull's:
  the per-card entrance already exists as `Collection ▸ Quick add N copies` and needs no dialog,
  so this layer has exactly one opener and `layerMatches` needs no narrowing clause for it.
- The plan is **fed rather than fetched**, `PullFromCollectionDialog`'s arrangement: a
  `missingPlanQuery` options factory plus `useMissingPlan(deckId, enabled)` in `useDeck.ts`, gated
  on `layer?.kind === "addMissing"`, keyed `["decks", "missingPlan", deckId]` under the deck root
  so the write that closes the holes refills it.
- The mutation `addMissingToCollection` invalidates **`OWNED_WRITE_KEYS`**, not the narrower
  `invalidateCollection` the three movers share — `quickAddToCollection`'s reason exactly, and the
  same case coming back: this creates rows, so `ownedQuantity` moves from 0 to N on tiles a 30 s
  `staleTime` would otherwise leave wrong for half a minute. `["wishlist"]` in that set is
  load-bearing here rather than incidental, because this write can delete a wish outright.
- No optimistic patch, and none to write: every number this moves is a sum the backend computes
  over rows in another table.
- The condition recorded is `MENU_CONDITION` (`src/lib/conditions.ts:85`), never a second spelling
  of the four letters — that constant moved once already, at schema v35.

## 6. Testing

**Rust.** `live_shortfall` extracted under `deck_pull`'s and `deck`'s existing tests, which must
pass untouched — that is the whole fence on the refactor. Then, new: the plan (inactive piles
skipped, the two-piles-one-printing fold, an orphan dropped, a row with no wishes kept, a card row
with NULL `oracle_id` kept where the wishlist would skip it) and the write (a partial pick, two
picks of one key summed then refused, over-picking refused, a stale `(cardId, finish)` refused,
`LEFT_THE_DATABASE` for a resynced-away printing, the fold onto an existing group row rather than
a second row, one wish taken, two wishes left alone, zero wishes fine, `clearWishes: false`
leaving a lone match standing, atomicity — a refusal at any step writes nothing).

**TypeScript.** `addMissingPlan.ts` as a truth table, including the clamp on a shrunk `short` and
the three wish shapes. Dialog tests for the four body states and the footer arithmetic;
`DeckStats` for the third button's presence, its absence on theory, and its absence at
`missing === 0`; `DeckEditor` for the layer arm; the `ipc.test.ts` mirror rows.

**Storybook.** Stories for the four states against the fake, with a seed carrying a two-finish
shortfall and a two-wish row, so the ambiguous case is drawable.

**The live window.** Both figures in the dialog footer checked against the deck's own missing
count, and the press verified in the real app — a UI task in this repo has never once been fully
answered by the suite.

## 7. What this deliberately does not do

- **No purchase price, source or acquired-at.** `quick_add` leaves provenance empty because *"a
  purchase price it invented would be provenance nobody entered"*, and a batch has even less claim
  to guess. The entry editor is where those go. Schema v36's optional acquisition price makes this
  tempting and it is still out of scope.
- **No per-row wish picker.** Two or more matches are left alone and said so; a dialog that
  interrogates a reader about four rows to record six cards is worse than the windows it replaces.
- **No mark on rows the reader could pull instead.** Genuinely useful and genuinely a second
  feature — it would need the candidate query this plan does not run. Easy to add later.
- **No entrance in `DeckSettingsDialog`.** The pull earns its third entrance there because that
  dialog opens from the gallery where there is no editor; a press that *creates* cardboard stays
  on the screen showing the shortfall it is about.
- **No `deck_undo` step**, for `quick_add`'s reason sharpened: undo restores rows of `deck_cards`,
  and this write touches none. The way back is the collection editor — the copies are a row the
  reader can see, in a folder named after the deck.
