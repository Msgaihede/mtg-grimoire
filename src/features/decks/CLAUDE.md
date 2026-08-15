# src/features/decks — the deck builder

**Validation is TypeScript** (spec §3). Rust supplies **facts** (`DeckCardRow`: per-printing
`legalities`, `color_identity`, P/T, `ever_uncommon`, `game_changer`); TS draws **every**
conclusion. The storage side — tables, the card commands, the allocator, the audit log —
is [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md) and
[src-tauri/CLAUDE.md](../../../src-tauri/CLAUDE.md).

## The validation layer

`validation/` is the whole of it:

| File            | Owns                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `engine.ts`     | Size, copy limits, restricted semantics, legality                              |
| `singleton.ts`  | Exact-phrase exceptions, **re-derived from oracle text and never a card list** |
| `commanders.ts` | Eligibility, partners, colour identity                                         |
| `companions.ts` | Companion rules                                                                |
| `bracket.ts`    | **Advisory only — `engine.ts` does not import it**                             |

- `oldschool` is the one printing-sensitive legality key, and it comes out right with no special
  case because each row carries its own printing's answer.
- `format_specs` is data seeded in a migration, never an engine branch. `restricted_semantic`
  (`max_one` | `banned_as_commander`) is **never inferred from the key**.

## The category model

- **The name is the user's; the kind is what the rules read.** `deck_cards.category_id` points at
  a row the user names, reorders, switches off and deletes; the fixed word survives only as that
  row's `kind` — `main | side | commander | companion | maybe`, narrowed in TS as `CategoryKind`.
- **`origin` is a second fact of exactly that kind, and it says who _made_ the pile.**
  `deck_categories.origin` (schema v15) is `'auto'` where the app invented a column while filing a
  card and `'user'` where the reader pressed "New category" — the four seeded zones included, which
  the schema writes as `user`. It arrives as `DeckCategory.origin`, becomes `CardGroup.isAuto`, and
  the one rule that reads it is `drawsWhenEmpty`. **The test is provenance, never the name.**
  `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so a deck holds one pile per name, and
  `category_for_name` _finds_ before it creates — a reader's own "Ramp" keeps `'user'` however many
  ramp spells the app later files into it. "Ramp", "Draw", "Removal" and "Land" are exactly what a
  person calls their own piles, so a name list would take over the one pile they were most
  deliberate about; that is the case a stored column gets right for free, and it is why this is a
  column. The four writers and the one-time backfill:
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **`is_active = 0` is the whole of what `maybe` used to mean**, and **nothing anywhere may
  branch on the kind being `maybe`.** An inactive category counts toward nothing — not size, not
  copies, not legality — and the allocator claims no copy for it. That was measured: the old
  shape looked correct and was wrong the first time a user deactivated a pile of their own.
- **`SIZE_KINDS` is `main`, `commander` and `maybe`** — the switch decides whether a pile counts
  at all; the kind decides only whether it is played _beside_ the deck or _in_ it, and only
  `side` and `companion` are beside it (CR 100.4a; EDH's companion is "effectively a 101st
  card"). It is written in **three places that must stay one rule**: `engine.ts`'s constant,
  `deck.rs`'s `DECK_SELECT` subquery behind `DeckRow.card_count`, and the Storybook fake's copy.
- **An add that names no category is filed by what the card _does_; an add that names one is
  untouched** — so every _drag_ overrides the rule by construction. The rule is `autoCategoryFor`,
  applied on **`useDeck.addCard`'s single definition**. Three steps, in this order: a front-face
  type line saying `Land` is **pinned to `Land` before tags are consulted**; else the first of
  **thirteen** Oracle-tag buckets whose anchor slugs the card's tags reach (Removal, Ramp,
  Recursion, Draw, Tutor, Protection, Anthem, Stax, Tokens, Sacrifice, Lifegain, Mill, Burn — the
  order _is_ the rule); else the old card-type answer. `null` (an orphan, or a layout with no
  bucket word) is `Uncategorised`; **absent** is `DEFAULT_CATEGORY_NAME`.
- **The empty slug list is the floor, not an error**, and every path preserves it: a database that
  has never downloaded the taxonomy, a card Tagger has never tagged, an unknown printing and a
  refused tag read all file by type line. **Nothing about categorising a card may fail an add** —
  `useDeck`'s `oracleTagsFor` catches and answers `[]`, and its doc comment says not to turn that
  into a rethrow. The one place that refuses instead is the **Categories dialog's** bulk action
  ("File cards by what they do", `CategoriesDialog.tsx`), whose blast radius is every loose card
  in the deck rather than one.
- **That bulk action can now take a column off the desk, and nobody had written that down.** "File
  cards by what they do" empties `useDeckMeta`'s `LOOSE_PILES` — `DEFAULT_CATEGORY_NAME` and
  `Uncategorised` — and `Uncategorised` is a name the app files under, so the pile it empties is an
  `auto` one and its heading goes with its last card. Nothing breaks and nothing is lost: the row
  is still there, still in the Categories dialog, and it comes back with the next card the rule
  cannot place. `Main deck` is the other loose name and the v8 migration's own pile, which the v15
  backfill deliberately leaves `user` — so an old deck's main column keeps drawing under the same
  press.
- **The tags are read at the rule, and that is a deliberate reversal.** This used to say the fact
  travels from the call site so no add pays a round trip — true while the fact was a type line the
  drag payload already carried. **No list DTO carries a slug list**: `CardSummary`, `CollectionRow`
  and `WishRow` say what a card _is_, and `CardSummary` has no `oracleId` either, so the four drag
  sources have nothing to carry. `ipc.oracleTagsForPrintings` is called in the one arm that needs
  it — a named `categoryId` and an absent `typeLine` both make **no** call — and it costs one
  local-SQLite round trip on a deliberate user act. **Match its answers by `cardId`, never by
  position**: blank and duplicate ids are dropped, so the array can be shorter than the request,
  and a deck holding one card in two categories sends that id twice.
- **The Land pin exists because there is no `land` tag.** Lands are a card type, not a function, and
  **618 of 1 196 land cards (51.7%) carry a functional tag** — Prismatic Vista is `tutor`, Savai
  Triome `card-advantage` — so without the pin a deck's mana base scatters across a dozen piles.
  The pin lives **inside `autoCategoryFor`** and no call site may short-circuit it; a caller that
  checked the type line first would be a second copy of the rule.
- **Recursion outranks Draw on purpose**, and it looks wrong: `regrowth` has _two_ parents,
  `recursion` and `card-advantage`, so Eternal Witness and Regrowth match both. **Burn is last and
  tiny for the same kind of reason** — `burn-creature`'s parents are `removal-burn` and
  `removal-creature`, so Removal claims Lightning Bolt first. Neither is a defect to tidy.
- **Where an unfiled add lands is a _deck setting_, not editor state** (changed 2026-08-15).
  `decks.default_category_id` (schema v16), read as `DeckRow.defaultCategoryId`, written through
  the ordinary `deckUpdate` beside the format and the theory switch, and asked in
  **`DeckSettingsForm`**. It was a `useState` in `DeckEditor` with an `Add to` select on the
  docked search panel's header row, and both halves of that were wrong: a reader who pointed it
  at their Sideboard lost the choice the moment they closed the deck, and the *other* surface it
  governed — the toolbar's quick-add field — drew no control at all, so the only way to find out
  where a quick add would land was to read that field's label. The editor now derives
  `targetCategoryId` from the row and the panel takes it read-only.
- **`AUTO_CATEGORY` is `0`, it lives in `autoCategory.ts`, and that zero fixed a real bug** — a
  deck's seeded categories are in `PREDEFINED_CATEGORIES` order, so a clamp to `categories[0]`
  put every quick add on a fresh deck into **Commander**. Zero now _means_ auto and nothing
  overwrites it. Rust spells the same number `deck::AUTO_CATEGORY` and the column is
  `NOT NULL DEFAULT 0`: **a sentinel rather than a nullable reference, deliberately**, because
  `DeckPatch`'s `coalesce(?n, column)` reads a bound NULL as "leave it" — a nullable column could
  not have said "back to Auto" without a command of its own, which is the price `folder_id` pays
  through `deckSetFolder`. What it costs instead is the two clean-ups no foreign key is doing:
  `deck_category_delete` puts a deck filing by the deleted pile back to `0`, and `duplicate_deck`
  **remaps** the id onto the copy's own categories.
- **An id the deck's `categories` does not carry reads as `AUTO_CATEGORY`, and that is a _read_
  rather than the repairing write the old clamp was.** There is nothing to repair — the backend
  cleans up at the delete — so what is left is the one commit where the deck row and the category
  list disagree, and Auto is where the deck already is.
- **The list is every pile, active and inactive.** `isActive` means "counts toward nothing"
  (size, copy limits, legality, the allocator) and has never meant "cannot be filed into"; a
  switched-off Maybeboard is exactly the pile a reader building a shortlist wants adds to land
  in. The option is marked `(off)` and the row's caption says what that costs, which is the fact
  most likely to surprise somebody who set this weeks ago.
- **The history row names the pile, never its id** — `defaultCategory`, resolved to the name in
  `record_deck_edit` at the moment it is true, `null` for Auto. `record_filed`'s rule for a folder
  path, applied to the only other column pointing at a row with a name of its own.
- **The X pile is a _heading_, not a category, and its key says so.** `X_GROUP_KEY` is `"mv-x"`
  and shares the `mv-…` namespace deliberately: it is one more mana-value heading, so no
  `deck_cards.category_id` points at it, nothing can be dropped into it, and it is gone the moment
  the reader groups by something else. Exported beside `X_GROUP_NAME` (`"Mana value X"`) so that
  no chart, story or test re-spells either one.

## Deck settings, and the two surfaces that draw them

Everything a deck carries that is not a card in it — name, format, description, notes, cover,
folder, theory, and **where an unfiled add lands** — is **one component, `DeckSettingsForm`,
drawn by two hosts** (2026-08-14). The "New deck" dialog used to ask two questions and leave the
reader to configure the deck they had just made; it now asks all of them.

- **`defaultCategoryId` is the one field of `DeckSettingsValue` the two hosts do not both ask
  about, and the asymmetry is the honest one** (2026-08-15). The row is drawn only when a
  `categories` prop arrives, and `CreateDeckDialog` passes none: `deck_create` seeds the four
  zones in the same transaction that makes the deck, so at create there is no pile to offer and
  no id to write. The question is not answerable yet rather than answerable and skipped — an
  empty select offering only `Auto` would be a control that reads as a choice and is not. The
  field stays **required on the value** so that the shape does not change with the host; the
  create draft holds `AUTO_CATEGORY`, sends nothing, and the column's `DEFAULT 0` agrees.

- **The form owns no mutation and imports no hook that reaches the backend** — not `useDeck`,
  not `useDeckFolders`, not `useFormatSpecs`. Every value and every write arrives as a prop, and
  that is precisely what lets `CreateDeckDialog` render it **before the deck exists**. The rule is
  checkable rather than aspirational: `DeckSettingsForm.test.tsx` renders it with no
  `QueryClientProvider` at all, so a stray query fails the suite rather than the review.
- **Two callbacks, because the two hosts commit differently.** `onChange` fires for every change
  including each keystroke; `onCommit` fires only for the three text fields, when the reader is
  finished with one. `DeckSettingsDialog` writes on `onChange` for the controls that settle in a
  single act (format, theory, folder, cover) and on `onCommit` for name/description/notes — which
  is exactly its old behaviour, **no Save button and not meant to have one**.
  `CreateDeckDialog` merges `onChange` into a draft and **does not pass `onCommit` at all**:
  there is nothing to write until Create.
- **`useDeckField` is the edit host's hook, not the form's** (`useDeckField.ts`, moved out
  whole). It holds the draft, commits on blur, and commits again on the dialog's _close_ rather
  than its unmount — the panel outlives the flag by the length of its fade, and a write waiting
  on an animation races the editor's teardown. The form is controlled and knows none of this.
- **`deck_create` takes a whole deck now**, so the create dialog is one command and one
  transaction. Four of its rules are _not_ `deck_update`'s — no `coalesce`, so an absent
  `folderId` really is the top level; `coverKind` is not settable; theory **moves** nothing (the
  patch route's `move_live_into_theory` has no live list to act on at birth); and a
  birth is **one** audit row however many fields it was born with. All four, and the reasons:
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **A new deck starts on the format the reader last created one in, and the whole rule is one
  pure function.** `newDeckFormat(picker, lastFormat)` in `useNewDeckFormat.ts`: the remembered
  key **if the picker holds it**, else `FIRST_DECK_FORMAT` (`commander`) if the picker holds
  that, else `DEFAULT_FORMAT`. The membership tests are the point — a `<select>` whose value is
  not among its options shows the wrong row and silently re-formats the deck on the reader's
  first other change — and they close two real cases: a format that left the seed (`format_key`
  is deliberately not a foreign key, and migrations re-seed `format_specs`), and **the one launch
  where `format_specs` has not answered yet**, where the picker is `[]` and both dialogs already
  fall back to a single `Casual` option. That last arm is what makes the _value_ fall back with
  them, and it is why no fallback rendering had to change. **Commander rather than
  `DEFAULT_FORMAT` for a reader with no history**, because `casual` answers a different question
  — "this deck was given no format" — and is `decks.format_key`'s DDL default, which stays what
  it is.
- **`DecksPage` resolves that answer and hands it down; neither dialog fetches it.** The gallery
  is mounted long before **New deck** is pressed, so by press time the value is real and
  `CreateDeckDialog`'s `Panel` seeds its draft in a **lazy `useState` initializer** — mount-only,
  no effect, so nothing can land on top of a format the reader has already picked, and no
  `useEffect` would be able to tell "the answer arrived" from "they have not touched it yet".
  Closing unmounts the draft, so every reopen asks again. `defaultFormatKey` is **required** on
  `CreateDeckDialog` (a host that has not thought about it must not quietly get Casual) and
  **optional** on `ImportDeckDialog`, which draws a format select only for a `new` target — the
  editor imports into a deck that already has a format and passes nothing. The query key is
  `["decks", "lastFormat"]`, under the root every `useDecks` mutation invalidates, so a create
  refreshes it for free.
- **The gallery's no-deck state is the two words `No decks`.** It was a paragraph explaining what
  a deck is and what the app would do with one; the affordance was never the words — `New deck`
  sits in the heading row above, where it is on every other visit. No `max-w-prose`: that width
  belongs to prose.
- **The cover picker searches every printing, not just the deck's own cards**
  (`DeckCoverPicker`). One grid, two modes: an empty search box offers the deck's cards, a query
  offers results. It exists because a deck being _created_ has no cards to take art from, and it
  improves the settings dialog for free. `collapse: false` because different printings are
  different art and collapsing hides the choice being made; `playableOnly: false` because art
  series and tokens are some of the best crops and a cover is not a card you cast.
- **The tiles do not credit the illustrator, and that is the documented exception, not an
  oversight.** `CardSummary` carries no `artist`; `CardStack`, `GridView`, `TheoryDiffDialog` and
  the original `ChoiceTile` all draw the same crop uncredited, justified by every crop sitting
  inside a control that names its card. The **preview** is strict at both surfaces: no artist, no
  picture. At create there is no `DeckRow` to read one from, so the host fetches it with
  `card_detail` — the credit arrives with the picture and never before it.
- **The upload arm is the one thing a create cannot do in one call**, because
  `deck_set_cover_image` takes a path _and a deck id_. It runs after the create; if it is
  refused, the dialog holds the deck it made, says so, and turns its button into **Open deck** —
  a created deck is never lost, and pressing again never makes a second one.
- **`CAPTION` and `FIELD` live in `formFields.ts`**, not in `cardControl.tsx`: that module's
  subject is a deck card drawn as a control and it pulls in the drag machinery, which a dialog
  asking for a deck's name has no business importing.

## Writes

- **A write to what is _in_ a deck goes through a `useDeck` mutation — but the refused-write family
  stopped being all of one hook's on 2026-08-14.** `DeckEditor`'s `newestWrite([...])` takes
  **every `useDeck` mutation but `rememberView`** — update (rename, cover, Built toggle, the
  `Split X` chip), add-card, set-quantity, move, set-tag, missing-to-wishlist, swap-printing — and
  **the `useDeckMeta` writes a right-click can now reach**, which are the tag create and a
  category's rename, switch and delete. Read the array rather than a number here; a count stood in
  this bullet and went stale twice. The X chip is a **deck-row** write riding the same `update` as
  the other three, so it is not a mutation of its own and it touches not one `deck_cards` row.
  `rememberView` is the one exclusion, for the reason stated on its definition. **The menus are
  what grew the family**: `setTag` sat outside it for as long as nothing in the app could reach it,
  and `useDeckMeta`'s writes had no control in this view at all — they were the Categories dialog's,
  which draws its own sentence for its own observer. A write a reader can now make from a card's
  menu or a pile's heading is a write whose refusal has to be said somewhere, and **the menu that
  started it has closed by the time an answer arrives**. `useDeckMeta`'s observer here is a
  *different* one from the dialog's — TanStack shares a query's cache between observers and a
  mutation's state with nobody — so this banner speaks only for presses made out here.
- **There is no remove mutation.** The tray's drop, the stepper's zero **and the card menu's
  `Remove card`** are all `setQuantity(…, 0)`, because zero removes a deck row. That third caller
  (2026-08-15) is what makes the rule worth restating: a menu row called "Remove card" is exactly
  the shape of thing somebody adds a `remove` mutation for, and it needs none — it goes through
  `DeckEditor`'s `setQuantityAt`, so it inherits the optimistic patch, the rollback and the
  hand-off of the caret to the pile the card just left. **No confirmation on it**, deliberately:
  one card is one add to put back, and the reader can see which one it was.
- **Emptying a whole pile is a command, and that is the one write that is _not_ a loop over
  `setQuantity`** (`useDeck.clearCategory` → `deck_category_clear`, 2026-08-15, behind a heading's
  right-click `Clear stack…`). The rows are all in hand, so the loop would compile — and would be
  a transaction, an allocator run and a `["decks"]` invalidation **per card**, plus a history line
  each for one press. It is `deck_import_commit`'s argument applied to the reverse operation, and
  [decks-storage.md](../../../docs/reference/decks-storage.md) carries the rest.
  **It is scoped to the variant on screen**, which is the exact reverse of `deleteCategory`: that
  one cascades through both lists, so its confirmation quotes `cardCountAllVariants`, while the
  clear's quotes `cardCount` and says in words that the other list is untouched. Getting those two
  numbers the wrong way round in either dialog mis-states a destructive press.
  **Both destructive rows ask first, and the type is what enforces it**: `CategoryMenuDeps` carries
  an `askClear` and an `askDelete` and neither mutation, so the menu structurally cannot reach
  either write — `buildDeckMenu`'s fence around a deck, twice over.
- **A move has two routes: a drag, and the card's right-click `Move to`** (changed 2026-08-14, and
  again later the same day). Every deck card used to carry a native `Move…` `<select>` beside its
  stepper, listing every other category of the deck; it was removed whole, which left `moveCard`
  reachable only through `DeckEditor`'s `applyDrop`, and the two costs written down at the time
  were **no keyboard path to moving a card at all** (a caret cannot drag; stepping to zero and
  adding again elsewhere is a different write and loses the slot) and **no way into a pile with no
  drawn heading** (a heading that is not drawn is not a drop target). `deckCardMenu.tsx`'s
  `Move to` closes both, and it is the **replacement** for that control rather than a duplicate of
  the drag: **Shift+F10 → `Move to` is the keyboard path** — a menu only a mouse could open would
  have restored nothing — and the submenu is built from `DeckEditor`'s `categories`, every category
  the deck has in `sortOrder`, never from the drawn groups. So it reaches the one pile a drag still
  cannot: an `auto` pile that has gone empty, which draws no heading because nobody asked for it.
  The card's own pile is **drawn and greyed with a reason** rather than dropped, so the list stays
  findable by position, and the categories are **not** put through `sortOptions` — a reader's piles
  must not read in one order on the desk and another in this menu.
- **The refusal rule lives on the single definition in `useDeck.ts`, never on a call site** — two
  definitions would be two places to keep one rule. The two surfaces outside the editor
  (`useSwapFromPane`, `useSidebarDrops`) borrow a mutation whole and own only their own reporting.
- The deck _row_ is a different hook: the gallery's `useDecks` owns create, update, remove and
  duplicate.
- **Switching the theory list on _moves_ the live deck into it — it does not copy it.** What the
  reader has built is the plan, so it becomes the theory list and `live` starts empty and fills as
  they acquire cards; the same write sets `last_variant = 'theory'`, so the editor lands where
  the deck now is instead of on a blank page nobody emptied. Only on the false→true transition,
  and only when the theory list is empty. **The rule it replaces copied**, on the reasoning that
  an empty theory list beside a full live one reads as data loss. Right danger, wrong half:
  nothing is deleted either way — the two lists are the same table — and what the copy actually
  handed the reader was two identical lists with no way to tell which one they were editing.
  `deck_theory_copy_from_live` is unchanged and still means "copy what is sleeved up into the
  plan".
- **`src/features/decks/auditText.ts` is the only thing that reads the audit payload, and the only
  thing that words it** — a sentence is domain logic and the table has to survive the day the
  wording changes. `deck_audit` has no `summary` column and never will.
- **The audit field for the X split is `"xGroup"`, the one multi-word field name in that switch,
  and the drift is silent.** Every other arm is a single lowercase word, so this is the first place
  `deck.rs`'s spelling and `auditText.ts`'s can part company with nothing going red: the `default`
  arm answers an unrecognised field with "Changed the deck", which is true of every deck edit and
  therefore never fails. **Deriving it from the column gives `separateX`, which is wrong** — the
  Storybook fake guessed exactly that before it was corrected — so `auditText.test.ts` pins the
  right word _and_ the wrong-but-plausible one. Copy the word from `deck.rs`; never re-derive it.
- **A deck card's unit price is that printing's nonfoil price at the selected marketplace** — a
  deck names a printing, not a finish. `cards.price_usd` is a fallback chain across finishes and
  is never summed. **One `unitPrice` per row, not a pair**: the marketplace is in `useDeck`'s
  query key, so switching re-reads the deck, and `deckStats`, `buildGroups`, `sortCards` and
  `diffTotals` take no `Currency` at all any more — a heading, the rows under it and the strip
  above them cannot be about different money, by construction.

## Import

`import/` is `parse.ts` (text → lines), `plan.ts` (lines + the printings Rust resolved + **their
Oracle tag slugs** → piles, a commander, tallies), `useDeckImport.ts` (the writes) and
`ImportDeckDialog.tsx` (two steps, one panel, nothing written until Import).

- **`plan.ts` stays pure and takes the slugs as an argument.** The tag read is chained inside
  `useDeckImport`'s `resolve` mutation, after `deck_import_resolve` and in the **same**
  `mutationFn` — **one** `oracleTagsForPrintings` over the deduped matched ids for the whole list,
  never one per line. Putting it there rather than in the planner is what closes the tally-flicker
  hole _by construction_: the dialog crosses to step two in that mutation's `onSuccess`, so the
  preview is never reached holding only the printings and there is no window in which a type-line
  tally is on screen waiting to be redrawn. A refused tag read files the whole list by type line
  and never costs the reader their paste. The Rust half and every measurement:
  [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md).

- **One parser for every export, and every rule in it is a _per-line_ rule.** A format detector
  would have to choose a reader before it had read anything, and would be wrong about exactly the
  lists somebody has edited by hand. So an unfamiliar mixture is read line by line rather than
  refused whole.
- **`//` is a comment only at the _start_ of a line.** `1 Branchloft Pathway // Boulderloft
Pathway` is one card and there are seven such names in the reference list alone, so a `//` found
  anywhere else is part of the name and must never be cut.
- **The line splitter takes CRLF, a lone LF _and a lone CR_.** `/\r?\n/` — the obvious spelling —
  treats a carriage return on its own as nothing and `.` does not cross one, so a CR-only paste
  arrived as **one** row that matched nothing and the whole list came back as a single issue.
- **Nothing is ever silently dropped.** A line the parser cannot read becomes a `ParseIssue`
  carrying its number and its raw text, and one bad line never aborts the parse. The only lines
  that leave no trace are the ones making no claim — blanks and comments.
- **`plan.ts` makes every deck decision and the dialog makes none.** The pile is `autoCategoryFor`
  (the app's one rule, never copied — a plain add, a drag with no column under it and an imported
  line have to agree) and the commander is `commanderIneligibility`, the same rule the validation
  panel judges a built deck by. A looser "looks like a commander" test here would offer a card the
  panel then refuses.
- **`row.index` is the address, never the array position.** `deck_import_resolve` carries the
  caller's own index back precisely so the two can differ; reading `rows[i]` against
  `parsed.lines[i]` works today and mis-files the whole list the day anything filters between them.
- **`CardIdentity` is the card-level half of `CardFacts`, and `CardFacts` was deliberately _not_
  narrowed to it.** It exists so the importer can ask "could this be a commander?" about a card
  that is in no deck yet and therefore has no `id`, no `categoryKind` and no honest `quantity` to
  invent — but the engine really does read `categoryKind`, `categoryActive` and `quantity`, so a
  card in a deck is more than a card. Every existing caller passes a whole `DeckCard`, which
  satisfies a `Pick` of itself, so the widening changed no call site.
- **An import is not an add path and must never become one.** Routing a list through
  `useDeck.addCard` would be one transaction and one **allocator run per line**;
  `deck_import_commit` is one of each. `useDeckImport`'s fourth mutation, `importIntoNewDeck`, is
  `deck_create` then that commit with a **hand-rolled rollback** — two commands are two
  transactions, and a refused import must not leave half a deck in the gallery. The commit's
  refusal is what the caller hears, never the clean-up delete's.
- **The file picker's own half is unverified**, for the reason `deck_set_cover_image`'s is:
  `dialog:allow-open` opens a native window CDP cannot reach. Path → text → preview is tested;
  click → path is not.
- **Driven in the shipped window 2026-08-12** (`npm run tauri dev`, a **debug** build): the
  gallery path end to end put **105 of 105** reference-list lines and all **117 copies** into a
  new deck, `deck_import_resolve` cost **120.4 ms** and `deck_import_commit` **7.9 ms** through
  `invoke` on that build, and the commander step offered **56** candidates — the list's 55
  legendary creatures plus a legendary Spacecraft with a P/T box. Every figure, the variant and
  audit checks, and the three resolver-side faults it found — all since fixed: a printing hint
  trusted over the card name, `MOXFIELD_LIST`'s fabricated hints, and `MATCH_ORDER` having no
  language term — are in
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **The preview's tally is counted over the _items_, never over the plan** — `tallyOf(items)`
  where `items` is `toImportItems(plan, commanderIds)`, so it recomputes on every press. There is
  deliberately **no `categories` field on `ImportPlan`**: the piles are a fact about what is being
  sent, and the commander choice is applied in `toImportItems` and nowhere else, so that is the
  only place a preview of it can be counted. `totalCards` stays on the plan, because the choice
  changes _which_ pile a card lands in and never _how many_ copies land. This was a live bug:
  measured 2026-08-12, the reference list previewed as **`117 cards · 6 categories`** with
  `Creature 56` and no Commander row while `deck_get` after the import read **7 categories**,
  `Creature 55`, `Commander 1`. Worst on the **`automatic`** arm, where the reader presses
  nothing — the dialog printed _"Krenko, Mob Boss goes in the command zone"_ directly above a
  tally filing him under `Creature`. `fromFile` was the one arm that agreed, because there the
  card already carries the Commander category name. The split `toImportItems`' doc calls
  deliberate is still right ("the plan is what the preview draws _while_ they are still
  choosing"); what was wrong is that the tally was ever part of the plan.
- **The layer contract holds and was measured, not assumed.** The dialog's scrim computes to
  `z-index: 45` from both entry points (`LAYER.overlay`, the rung the editor's other full-window
  surfaces share); one Escape closed the dialog and **left the card pane open**, handing focus
  back to the `Import cards` button that opened it, and a second Escape closed the pane; 22 Tab
  presses from the textarea produced 22 focus landings and **every one inside the dialog**.
- **Reduced motion is honoured on both halves, and only the live pass could show it.** Under
  emulated `prefers-reduced-motion: reduce`, the panel's `transform` at 60 ms was **`none`**
  against `matrix(0.9818…)` unemulated — `MotionConfig reducedMotion="user"` reduces `scale`
  because it is a transform, unlike the deck stack's `marginBottom` — while `opacity` kept
  animating (0.137), which is the weaker rule `lib/motion.ts` documents on purpose. No
  `useReducedMotion()` opt-out is owed here. The buttons' CSS half read
  `transition-property: none` **while `transition-duration` still read `0.12s`** — the false
  failure the harness contract warns about, reproduced exactly.
- **An import can be aimed at one pile, and it is a new argument on the import path rather than a
  new import path** (2026-08-14). A category heading's right-click opens the same dialog carrying
  `forcedCategoryName`, and the paste lands in that pile — **overriding `autoCategoryFor` and a
  section heading both**, which is consistent with the rule the importer already follows (an add
  that names a category is left untouched) and is what right-clicking a specific pile means. A
  heading is what somebody else's exporter wrote; the right-click is the reader pointing at a
  column of their own a moment ago, so the later and more specific naming wins. **The command zone
  still outranks it**, applied in `toImportItems` after the pile is chosen — a commander goes to
  the command zone whichever heading was right-clicked. It is applied in `categoryFor` and nowhere
  else, because **`plan.ts` makes every deck decision**;
  the dialog only reports it, in the step-two heading (`Into <pile> · <deck>`). The argument is
  **optional and defaults to today's behaviour**, so the toolbar's own Import passes nothing and is
  unchanged — which is what keeps a shared importer from being reshaped by one caller.

## Export

`export/` is the mirror of `import/`, and the split is the repo's boundary: `format.ts` is pure
(`(cards, format) => string` — no React, no hook, no IPC), `ExportDialog.tsx` is the surface (a
format picker, a live preview, Copy and Save as…), and Rust supplies only the file write. It is
category-level in this branch; the same `format.ts` is what a later deck-level export uses.

- **The cards are an argument the dialog never fetches**, and that is the whole of what makes a
  category export reusable as a deck export later — the set of cards is the caller's decision.
  `DeckEditor` derives them from the deck's own rows and **never from `shown`**: exporting "Removal"
  means the pile, not the four of it the toolbar's filter happens to be drawing.
- **`format.ts` is `parse.ts`'s rules read backwards.** `//` is part of a card name, so nothing
  here may cut one, and what this writes has to be something that parser reads — which is what the
  round-trip test pins. LF and a trailing newline always: the parser takes CRLF, a lone LF and a
  lone CR, but a file this app wrote should have one answer. **An empty list is an empty string in
  every format, CSV included** — a header row over no rows is a file claiming to be a decklist and
  is not one.
- **Rust writes the file, and that is a permission decision rather than a division of labour.**
  `save()` answers a *path*; writing bytes at it from the page would need an `fs:` permission this
  app grants nowhere, so `export_write_file` takes the path and the text — the same shape
  `deck_set_cover_image` has, for the same reason.
  [`src-tauri/CLAUDE.md`](../../../src-tauri/CLAUDE.md) has both.
- **`save()` resolves `null` on Cancel**, and writing that string to disk is the trap the guard in
  `handleSaveAs` exists to prevent. A refused write is **reported and does not close the dialog**:
  the reader's text is still on screen and still copyable, so the failure costs them nothing they
  cannot immediately retry.
- **The `Copied.` line is a claim about the clipboard's contents, so it is cleared the moment that
  claim could go stale.** Switching format redraws the preview and does nothing to the clipboard,
  which still holds the last text copied — so the format radios clear it on every press. And the
  clipboard write can itself be refused, because it is a real Tauri plugin command rather than a
  browser API, so it reports through the same `role="alert"` line a refused save uses.
- **The picker's own half is unverifiable**, exactly as the importer's `open` is:
  `dialog:allow-save` opens a native window CDP cannot reach and no test or browser can drive.
  Path → written file is covered; click → path is not.

## Views and interaction

- **The editor's chrome is one height, 36px, and the ribbon carries `py-1.5` that is not
  spacing** (2026-08-14). The header row is the **first child of the page scroller**, and the
  name field's ring is `outline-2 outline-offset-2` — 4px proud on every side — so with no
  padding its top lay outside the scroller's padding box, where a scroll container clips, and
  what survived ran into the shell's mana line. Six pixels is the ring's four and two to spare;
  **vertical only**, because horizontal padding would indent the back button and the deck's
  actions past the toolbar row beneath them, and `gap-x-3` already leaves the ring three times
  the room it asks for on that axis. The height is `FILTER_CONTROL`'s rather than a number this
  folder invented: `CONTROL` was 32px "so the two rows read as rows", but both rows have grown a
  `ToggleChip` since — `Built` in the header, `Split X` in the toolbar — and a `ToggleChip` is
  36, so the height meant to unify was drawing every plain press four pixels shorter than the
  chips beside it. **`text-xs` stays where it is, and that is the load-bearing half**:
  `FILTER_CONTROL` carries `text-sm`, but the header's actions block is **692px** at max-content
  and 14px glyphs put it near **760**, against the ~1017px a 1280×800 window leaves — the row is
  `flex-wrap`, so it does not overflow, it _wraps_, and a wrapped header costs 44px of deck
  height at the app's own default size. That is the regression `NAME_FLOOR` exists to keep out.
  Height was the axis with room; width was not.
  **Driven 2026-08-14** (`npm run tauri dev`, a debug build, at 1280×800 and 1920×1080): with the
  padding backed out in the page the ring's top sat **3.5px above** the scroller's padding box —
  clipped, and only a live pass sees it, because jsdom has no layout engine and a Storybook frame
  is not the page scroller; with the padding it clears by **2.5px** top and bottom, and at 1920 it
  clears the actions block beside it by **8.3px**. Every control in both rows measured **36px**
  after the change and the name field measured **35px**, untouched. **The header already wrapped
  to two lines at 1280 before any of this** — the actions block is **825px** here (**801** at the
  old sizes) against the **729** a 1002px ribbon can spare once `NAME_FLOOR` is honoured — so the
  wrap is not what this pass introduced, and the deck this was driven on carries both a
  `9 issues` chip and a `1 game changer` label, which the 692 figure above does not.
- **Four views** — `Stacks | Table | Text | Grid` (`DeckEditor`'s `VIEWS`) — crossed with three
  `Group by` modes (`category | manaValue | type`) and four sorts (`alphabetical | manaCost |
price | type`). An **inactive category stays its own group in all three grouping modes** — as long
  as it holds cards — and it stays that group _whole_: `buildGroups` appends it carrying its own
  `kind`, so a switched-off
  Sideboard is still `kind: "side"` under `manaValue` and `type`. Only the **derived** groups are
  `kind: null`. So anything that keys on a kind — `GroupHeader`'s `RULE` marker, the two column
  views' rail — still sees a sideboard in the two modes that otherwise have no categories
  in them, which is the right answer in both cases and is a special case in neither.
- **The toolbar asks those three questions with three identical `<select>`s** (changed
  2026-08-15). `View` was a four-button segmented group beside two selects, which made the control
  a reader reaches for most the one that looked unlike its neighbours and spent four buttons'
  width saying what a shut select says in one word. It is `VIEW_PICKER` now — `VIEWS` through
  `sortOptions`, so it reads `Grid · Stacks · Table · Text`, **not** the order the array is
  written in. That array is written default-first and the order carries no information, so this is
  no exemption from the app's option-list rule; the two that are (an order that _is_ the
  information, an order the reader arranged) are in [`src/CLAUDE.md`](../../CLAUDE.md). The view
  is still session state — `useState` in the editor, never `rememberView`, which remembers the
  variant, the grouping and the sort and not this. **Driven in the shipped window 2026-08-15**
  (debug build, 1280×800): all three selects at `top: 182`, 36px tall, on one line, and each of
  the four rows drew its own view with no horizontal overflow — the figures are in
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **The deck stats are a band at the foot of the editor, and there is no control that hides
  them** (changed 2026-08-14). They were a 280px aside on the desk row with a `Stats` toggle in
  the toolbar, and the aside's width was subtracted from `DECK_FLOOR` before the docked search
  panel was asked whether it fit — so opening Stats at 1280 with a card pane docked cost the
  reader their search, and the toggle existed to give that width back. Full width under the deck
  the four charts sit on one line and nothing on the desk is traded for them. Three consequences,
  each measured in the shipped window and none of them visible to a test:
  **(1)** the band sits **below the price strip**, because that strip is where the remove tray is
  drawn for the length of a drag (`-top-3` over the gap under the deck) and a band between them
  would put four charts between a card and the one drop that takes it out;
  **(2)** the editor is an `overflow-y-auto` **page** now — the deck, the strip and the band come
  to **886px** in the **702px** a 1280×800 window leaves (710 when it was measured, less the 8px
  the ribbon gained when the shell was enlarged on 2026-08-14; the same deck read **866** with the
  ribbon's padding and the 36px chrome backed out in the page, so those two cost 20px between
  them, and 847 is the figure they replace — an earlier sitting, a different deck), so the deck
  holds a `min-h-96` floor
  (**384px** = one whole stack card and its group heading) and the band's last ~145px is one
  scroll away, while at 1920×1080 nothing scrolls at all and the deck takes the surplus (**604px**).
  **That floor is on the view box rather than on the desk row since the bullet below on the views
  having no height, and under the table it is still on the row** — the reason is written there,
  and it is the difference between a floor and a ceiling. The figures in this paragraph are the
  band's arithmetic and are untouched by the move; what has changed is that a deck taller than
  702 now pushes the band down the page instead of being cut to fit above it;
  **(3)** `DECK_FLOOR` dropped **208 → 192**, because that page scroller is a second scrollbar the
  row's arithmetic did not count — the same 16px correction, for the same reason, as the drop from
  224 to 208. Without it the panel railed at 1280 with a card pane open (**602 − 400 = 202**), and
  `scrollbar-width: thin` is not an answer: it costs 10px instead of 15 and lands on **207**, one
  pixel short.
- **The docked panel's format filter opens on the open deck's format, and it is a _default_ rather
  than a constraint.** `DeckEditor` derives `DeckSearchPanel`'s `defaultFormat` from the loaded row
  and that row's `FormatSpec`, and `useCardSearch` seeds its `format` state from it, so the first
  request the panel makes is already the filtered one rather than a wall of illegal cards replaced
  a round trip later. The select's two pinned rows are `Any card` and `Any format`, widest first —
  the `Unplayable` chip that used to ride this row became the former on 2026-08-14, so the panel
  can be widened past legality without a second control. The reader may move it to any format or
  back to either of those, the panel adds
  whatever is pressed, and an illegal card is `validation/engine.ts`'s `RULE BREAK` on the card in
  the deck — **nothing about legality moved into the search**, and a wall that refused to offer a
  card would be this editor answering a rules question in the one place with no business answering
  it.
  **The fence is `FormatSpec.hasLegalityData`, and it is deliberately not a list of the keys that
  have it off.** `filters.rs`' `push_card_filters` answers a format key `legalities::LEGALITY_KEYS`
  does not carry with the literal SQL `0` — no rows, no error, and nothing on screen to tell it
  from a search that genuinely missed — and `casual` (which is `DEFAULT_FORMAT`, what every deck
  starts as) and `limited` are exactly that: `format_specs` rows with no legality key behind them.
  So a deck whose spec has no legality data, and a deck whose key left the seed at all
  (`formatSpecFor` answers `null`, because `decks.format_key` is not a foreign key), pass **no**
  default and the filter opens on `Any format`. Naming those keys here instead would be a second
  copy of a cell the seed already carries, in a table that grows by migration.
  **The default re-seeds when the deck's format changes, and survives `resetAll` only until it
  does.** The hook compares against the default it last _applied_ rather than against `format`,
  which is what makes all three halves true at once: the header's `Deck format` select re-points
  the panel beside it, a default that **arrives late** still lands (`useFormatSpecs` is a query, so
  on the first deck opened in a session the panel mounts before the seed has answered), and
  `resetAll` clears the filter to `""` without the deck's format bouncing back a beat after the
  reader cleared it. **An unlisted key is folded into the picker the way `pickerFormats`' `keep`
  is**, and for the same reason: the deck's own picker offers `format_specs` rows while this filter
  offers `FORMATS`, so a Brawl or an Oathbreaker deck's key is one no `<option>` holds — and a
  `<select>` whose `value` matches no option does not draw blank, it silently reports the first one
  — which since the `Unplayable` chip was merged into this select (2026-08-14) is **`Any card`**,
  the widest row it has, so the control would read "every card, art cards included" over a filtered
  wall rather than merely the wrong filter. **It counts as a filter and does not count as the
  reader having asked**: `activeFilterCount` includes it, so the panel opens showing `Reset all 1`
  and what is narrowing the wall is always visible and clearable, while `unfiltered` — which
  captions the empty result area and is the difference between "the database is still syncing" and
  "your search missed" — counts only a format that **differs from the default**. That is "the
  reader set it" in every case but one, and the exception is written at `formatIsReaderSet`: a
  reader who clears the filter and then picks the deck's own format back off the select reads as
  having asked nothing, so an empty answer there is captioned "waiting for the sync". Remembering
  the press instead would buy a caption in a case that also needs the database to be empty.
- **The variant tabs read `Theory | Live`, theory on the left.** That is where a deck now starts:
  switching the theory list on **moves** the live deck into the plan, so the left-hand tab is the
  one holding cards and `live` is the column that fills as the reader acquires them. Reading
  left to right is then plan → reality, which is the direction the difference readout beside it
  already counts in.
- **The editor reopens on the view the reader left, and the deck row is where that is kept.**
  `lastVariant`/`lastGroupBy`/`lastSortBy` come off `DeckRow` and go back through
  `useDeck`'s `rememberView` (`deck_set_view_state`), which touches no `updated_at`, writes no
  history and reallocates nothing — looking at a deck is not editing it. It is deliberately
  **not** `useAppStore`: `searchView` and `collectionView` are one session-wide answer about the
  _app_, and which list of a _particular_ deck the reader was reading is a fact about that deck.
  `cardZoom` used to be named in that pair and no longer belongs there — since 2026-08-14 it is one
  number **per card section** (`ZoomSection`) rather than one for the app, so the deck desk and the
  docked search column zoom apart. It lands between the two poles and on neither: session-scoped
  like the view toggles, but keyed by which _wall_ the reader is looking at, and still not a fact
  about a particular deck — every deck's desk shares the one `deck` entry, so it cannot answer what
  `lastVariant`/`lastGroupBy`/`lastSortBy` are asked. The two view toggles are what the argument
  above rests on, and they are unchanged.
- **The narrowing is TypeScript's, and that is the boundary rather than a missing constraint.**
  `ALTER TABLE ADD COLUMN` cannot add a CHECK, so Rust validates only `last_variant`, whose
  vocabulary the crate owns, and stores the other two verbatim as facts. `GroupBy` and `SortBy`
  are this layer's words, so `asGroupBy` (`grouping.ts`) and `asSortBy` (`sorting.ts`) narrow
  them on read and fall back to the default — a stored word nothing offers reopens the editor on
  `category`/`alphabetical` rather than in a state no control can draw.
- **`rememberView` is the one `useDeck` mutation that does not invalidate, and that is the
  interesting part.** The editor is already showing what the reader picked; this write only makes
  it survive the deck being closed, so there is nothing to re-read. Invalidating hands the editor
  back the three fields it _restores from_ a beat after the press, which is how a second press
  made inside that beat gets undone by the first one's echo. It is also outside `DeckEditor`'s
  refused-write family on purpose — **that family is writes to what is _in_ the deck**, and this
  one changes no card — so its failure is silent, the cost being a deck that reopens on its old
  tab.
- **`Split X` is a _modifier_ of the mana-value grouping and not a fourth mode.** The chip is
  drawn only under `groupBy === "manaValue"`, and it lives inside that select's own `gap-1.5`
  cluster rather than out in the toolbar's `gap-x-4`, because a control that persists across a
  grouping it has no effect on is a control the reader has to remember the scope of. The
  inertness is **structural, not a branch to keep in step**: `separateX` is passed to
  `manaValueBucket`, which only the one `manaValue` arm of `buildGroups` calls.
- **In a deck the X rule is _exclusive_; in search the same idea is _additive_, and the opposition
  is deliberate on both sides.** Here a card printing `{X}` is in the X group **and nowhere
  else** — a heading counts copies and sums prices, so a card in two groups makes the headings add
  up to more than the deck and nothing on screen says which one lied. In search the chips are an
  OR over rows, where finding a card twice is not a thing that can happen, so `{X}{B}{B}{B}`
  answers the mana-value-3 chip **and** the X chip. **Do not "fix" either one into agreeing with
  the other**; they are answering different questions about the same card.
- **X sorts at 9, and `mv-unknown` moved 9 → 10 to let it.** Like `8 or more`, X is open-ended
  rather than a number, so it belongs at the tail and not at the head where a reader counts their
  cheapest spells; `unknown` stays behind it because it is the absence of an answer rather than an
  answer. **The X test runs _before_ the `cmc === null` check**, which is the second half of the
  same rule: an `{X}` in the printed cost is knowledge, so a row with a null `cmc` and an X in its
  cost is X, never unknown.
- **`{X}` only, never `{Y}` or `{Z}`** — `hasVariableCost` in `src/lib/mana.ts`, going through
  that file's one `SYMBOL` regex rather than a second, looser spelling of what a symbol is.
  `validation/engine.ts`'s `symbolValue` scores all three as 0 and is right to: it answers _what
  is this cost worth_. A heading answers _what is this pile called_, and a `{Y}` un-card filed
  under X is a heading telling the reader a lie about the cardboard in front of them.
- **The switch is the _deck's_, not the editor's**: `decks.separate_x_group` (schema v13), read off
  the loaded row as `separateXGroup` and written through `useDeck.update` — **never `useState`**,
  and never `rememberView` either. Both halves of that matter. `groupBy` and `sortBy` are also
  remembered per deck now (`lastGroupBy`/`lastSortBy`), but they are remembered as _where the
  reader had got to_, which is why the command that stores them moves no `updated_at` and writes
  no history. Splitting the X spells out is a **change to the deck**, rides the same `deck_update`
  as the rename and the cover, and is audited as one. This one is an answer about a particular
  curve: a storm list where half the spells are `{X}` reads quite differently from an aggro deck
  with one Fireball in it. It reaches no rule — not size, not copies, not legality, not the
  allocator — and nothing in `validation/` has heard of it or should.
- **`DeckStats` honours the flag under _every_ grouping while the chip that sets it is drawn under
  one, and that is a decision with a known cost rather than an oversight.** `DeckEditor` reads the
  flag once and hands the same value to `buildGroups` and to `DeckStats`, because a curve counting
  `{X}{B}{B}{B}` as 3 beside a column headed `Mana value X` is two surfaces answering one question
  about one deck two ways — the failure this folder's rules keep naming. The deck's answer does
  not stop being true because the reader went back to their categories. So a reader grouped by
  `category` or `type` can see a split curve with **no control on screen to unsplit it**; the
  pairing is what must hold, and this is what it costs.
  **`lastGroupBy` narrows that cost to a session, and knowing which kind of gap it is decides
  whether it is worth repairing.** The grouping is stored on the deck too, so a deck left under
  `manaValue` reopens under `manaValue` and the chip comes back beside it — nobody _returns_ to a
  split curve with no control for it, which was the version of this worth worrying about. What is
  left takes a deliberate press in the same sitting: group by something else and the chip goes
  with the mode it belongs to, while the curve keeps answering for the deck. One press back
  brings it, and that press is now remembered.
- **The average mana value does not move when the flag flips**, and it is the one number the
  split deliberately does not reach. An `{X}` spell costs what it costs with X at zero
  (CR 202.3b) — `{X}{B}{B}{B}` is 3 — and the toggle is a display choice about which bar a card is
  drawn in, not a claim that the card stopped costing three. `DeckStatsSummary.variableCost` is
  `null` rather than `0` when the deck is not splitting, for the reason `averageManaValue` is
  `null` rather than `0` for a deck of nothing but lands: "there is no X bar" and "the X bar is
  empty" are different sentences, and the second is worth drawing. The bars still sum —
  `sum(curve) + (variableCost ?? 0) + unknownManaValue` is `nonlands` in both modes. The tenth
  bar's width arithmetic, and why the 280px panel did not grow to hold it, are in
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **Which empty piles draw is three classes and three answers, and `grouping.ts`'s
  `drawsWhenEmpty` is the whole of it.** A **predefined** zone answers by what the deck's format
  has: `commander` only where the format wants one, `companion` never, Sideboard and Maybeboard
  always. An **auto** pile — one the app made while filing a card, `origin: 'auto'` carried as
  `CardGroup.isAuto` — **never** draws empty: it arrives with its first card and goes with its
  last, because nobody asked for it and an empty `Ramp` the app invented is a heading about a card
  the deck does not contain. A pile the **reader** made always draws, until they delete it: a
  category typed by hand is a _place_, their empty `Ramp` is where the next ramp spell goes, and a
  column that vanished with its last card would move the layout under their hand and take its own
  drop target with it. **The rule is asked about empty piles only**: `buildGroups`'
  `cards.length > 0` arm runs in front of the call, so no answer here can hide cardboard — a Modern
  deck whose Commander pile still holds the card it was built around draws that pile.
  **Two rules preceded this one and each was right about the class it was looking at.** The first
  hid every empty pile bar the four seeded ones, on the argument that a category is a card's
  **function** now (`autoCategory.ts`: Removal, Ramp, Draw and ten more), so a deck accumulates
  columns faster than it fills them. The second drew every empty pile, on the argument that a pile
  the reader made is a place they mean to fill. Both arguments are true of different piles, and
  provenance is the fact that tells those piles apart — never the name, for the reason in
  **The category model** above.
- **Two of the four fixed zones are conditional now, and each is conditional for its own reason.**
  `commander` draws empty only where the deck's format has a command zone
  (`FormatSpec.requiresCommander`, off `useFormatSpecs`): an empty command zone is a fact about a
  deck's _validity_ only in a format that wants a commander, and in a Standard deck it is a heading
  about a rule that does not apply. `companion` never draws empty in any format: a companion is a
  card you either have or do not, so a slot for one is a slot for nothing until it is filled, and
  the heading arrives with the card. Sideboard, Maybeboard and every pile of the reader's own are
  unconditional. **`spec` is `null` twice over** — while the specs load, and for a deck whose
  `format_key` has left the seed — and `?? false` is the deliberate answer to both: no format
  opinion, no empty command zone, and the zone appears the moment it holds a card.
- **`drawsWhenEmpty` takes a `Pick<CardGroup, "kind" | "isAuto">` and an `EmptyGroupRules`, and
  still structurally cannot read the name.** `deck_category_create` takes `(deck_id, name)` and no
  kind, so `commander` and `companion` can only ever be the two seeded zones, while a pile a reader
  called "Sideboard" is a `main` like every other pile of theirs — and `categoryGroup` is the one
  place a name is consulted at all. Three tests and the three classes: companion, commander, then
  `!isAuto`. **`isPredefined` is not among them any more.** It was the whole of this rule once —
  the four seeded zones drew empty and nothing else did — and then the survivor test while a filter
  was running; both are gone, because Sideboard and Maybeboard now reach the last line and draw
  exactly as a pile of the reader's own does, "always, until it is deleted" being one answer for
  both. The field survives on `CardGroup` for `CategoriesDialog`'s Rename and Delete affordances and
  for nothing else, and its doc says so. Derived groups (`manaValue`, `type`) and strays are built
  _from_ cards, so an empty one never existed to hide; their `isAuto: false` is that fact rather
  than a claim about who made them.
- **Empty, inactive and who-made-it are three independent questions, and conflating any two is the
  mistake to avoid**: an inactive category _holding cards_ still draws, the empty seeded Maybeboard
  draws, and an empty auto pile stays out however active it is. **There is no per-category "hide"
  flag, none is wanted, and `isActive` is not one** — it means "counts toward nothing" (size, copy
  limits, legality, the allocator) and deliberately keeps drawing the pile, because the affordance
  for switching it back on is seeing what is in it. **Delete is the removal**, and the four seeded
  piles cannot be deleted at all. An auto pile that goes empty is not deleted and loses nothing:
  it is still a row, still in `DeckEditor`'s `categories`, still listed in the Categories dialog
  with its name, its order and its switch — it draws no heading until a card is in it again.
- **A filter decides nothing about which headings exist, and the rule that said it did has been
  deleted.** `EmptyGroupRules.narrowed` reported whether the toolbar's text field or a tag chip was
  running, and while one was, `isPredefined` was the test for an empty pile — so that typing three
  letters could not answer with twenty headings over three cards. **The auto rule subsumes it: that
  wall was always auto piles** (Removal, Ramp, Draw and the type buckets), and a pile the filter
  emptied _is_ an empty pile, so they stay out filter or no filter. What a filter leaves is the
  reader's own deliberate piles plus the fixed zones, which is the answer the flag was reaching for
  and is now the same answer as emptying a pile by hand. `EmptyGroupRules` keeps one member and
  `DeckEditor`'s memo passes only `requiresCommander`. **The flag's cost went with it**: an empty
  pile of the reader's own is a drop target under a filter again, which matters because the
  per-card `Move…` select was removed on 2026-08-14 and a drawn heading is the whole affordance a
  **drag** has for moving a card into an empty pile. The card's `Move to` menu is a second route
  and does not make this one optional: it is built from `categories` rather than from the drawn
  groups, so it is what covers the piles no heading is drawn for, while a drop target the reader
  can see is what a pointer reaches for first.
- **Nothing but a view reads the drawn groups, which is what makes a missing heading survivable.**
  `DeckEditor`'s `categories` is still _every_ category the deck has, in `sortOrder`, and it is what
  deck settings' "Add cards to" select, a card's `Move to` submenu and `CategoriesDialog` are built
  from — never the groups. **For an
  emptied auto pile that panel is the only surface it appears on at all**, so "every row, always" is
  load-bearing rather than tidy: it is where such a pile is found, renamed, reordered, switched or
  deleted. The panel has **no format branch and no origin branch** and must never grow one — its
  file header says so at the code, and both facts the desk leaves piles out by answer _when is an
  empty pile drawn_, never _what piles does this deck have_. **The filter belongs at
  `drawsWhenEmpty` and never in that array**: a format filter used to sit on the category list
  itself, and cutting a row out of it hid a pile the reader had built. The format came back one
  rung lower, and the comment on `const categories = deck.categories` says so at the site.
- **The per-card "Move…" select was removed on 2026-08-14, and a drawn heading is what replaced
  it — and then the card's right-click `Move to` replaced it properly, later the same day.** The
  select built from the `categories` array rather than from the drawn groups, so it reached a pile
  that had no heading; a *drop* target has to be on screen. For the two classes a reader files into
  deliberately the heading costs nothing — every pile of their own draws, filter or no filter, and
  so do the fixed zones — and deck settings' "Add cards to" is a third route to both. **The one pile with no
  drag route is an auto pile that has gone empty**, which is the class nobody asked for, and it is
  exactly why `Move to` is built from `categories` too: the pile is listed there whether or not a
  heading is drawn for it, by pointer and by keyboard alike. The next card the rule files there
  brings the heading back, and until then the pile is also still a row in the Categories dialog.
- Only `Stacks` and `Grid` fetch a picture, and it is the **whole card** —
  `cardImageUrl(…, DECK_CARD_VARIANT)`, which is `grid`, and which must stay paired with
  `images::prewarm_keys`' `DECK_PREWARM` arm in Rust. **Getting that pairing wrong is invisible**:
  the pre-warm reports success and every tile then fetches cold anyway.
- **The deck's views are given no height, and the page is the only thing in this editor that
  scrolls** (changed 2026-08-14, later the same day than the two bullets below). Stacks, Grid and
  Text grow to hold their content: piles overflow **down**, the box expands, the desk row expands
  with it and `DeckEditor`'s `overflow-y-auto` page takes the scroll. What that replaced was a
  view drawn as a `flex-1` item of a `min-h-0` desk with `overflow-auto` on it — so a deck with
  more piles than the window was tall was letterboxed inside the deck builder with the editor's
  own scrollbar an inch away, two scrollbars moving different things and nothing on screen saying
  which. `overflow-x-auto` survives on all three for the one case the wrapping bullets below
  reserve, and costs nothing: it implies `overflow-y: auto`, which can never find anything to
  scroll in a box with no height of its own.
  **`TableView` is the exception and is a difference in kind, not a case to tidy away.**
  `VirtualTable` mounts the rows in view and holds a spacer open for the rest; a scrollport is
  what it *is*, and given no height it draws its own scrollbar **and** the page's. So the desk row
  keeps `DECK_HEIGHT_FLOOR` under that one view and the view box keeps `min-h-0 overflow-auto` —
  the arrangement all four used to share.
  **`min-h-96` moved from the desk row to the view box, and that is the load-bearing half.** A
  flex item's automatic minimum size is what stops it being squeezed below its content, and a
  `min-height` number *replaces* that `auto` — so on the row it was a ceiling as well as a floor:
  measured live, 2 783px of piles in a desk box of 384, with the price strip and the stats band
  laid out over the deck rather than under it and the sticky search panel clamped to a 384px
  containing block. On the view it floors without capping. **jsdom has no layout engine, so
  nothing in the suite can see any of this.**
  Two things leaned on the old bounded desk and moved with it: the docked panel is
  `sticky top-0 self-start` at a **measured** height (the scroller's visible height less whatever
  of the desk still sits below its top — CSS has no unit for that), and the price strip goes
  `sticky bottom-0` for the length of a drag, so the remove tray drawn on it stays at the foot of
  the window instead of at the foot of a 7 000px deck. Every figure, at 1280×800 and 1024×600:
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **`Stacks` and `Text` wrap downward — neither view grows sideways any more**
  (changed 2026-08-14). Both lay a deck out in fixed-width boxes —
  `stackColumnWidth(zoom)`, 224px at 1×, and the text view's 300px — and both used to open the
  next column _to the right_, so a fifteen-category deck ran off the edge and put an X scrollbar
  across the whole desk. That is the one thing the 1024px floor forbids, reached by the one route
  `DECK_FLOOR` never measured: **192** is the width the deck side is _guaranteed_, and it does not
  hold even one column — nor did the 208 it dropped from, nor the 224 before that. That floor
  governs how the desk row is _divided_; it has never said anything about what happens inside
  the view's share of it. The row is a `flex-wrap` container now, so a box that will not fit goes
  **below** the line and the reader scrolls down, which the desk already did. **An `overflow` on
  the X axis stays** — one column zoomed past the desk's own width really is wider than its box,
  and clipping a card is worse than a scrollbar the reader asked for. Wrapping
  is what makes that the rare case instead of the ordinary one. (It was `overflow-auto` here and
  is `overflow-x-auto` since the bullet above: the *vertical* half of that class was the letterbox,
  and this reasoning is about the horizontal half, which is untouched.) **Driven 2026-08-14** on a seeded
  16-category deck: no X scrollbar at 1024, 1280 or 1920, the two wrap thresholds exact, and the
  rare case contained to the view rather than the page — every figure in
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **`Stacks` does not pack at all any more: every pile is a flex item of one wrapping box**
  (changed 2026-08-14, later the same day). Wrapping fixed the _sideways_ run and left the other
  half of the same bug standing, because `packColumns` fills a column to a **height** and knows
  nothing about the desk's **width**. So a tall window packed a six-pile deck into three tall
  columns and left half the desk blank beside them, while the same deck in a shorter window spread
  across all six and looked right — which is why it read to the reader as a zoom bug. `StackView`
  now maps `splitRail`'s `flow` straight into `flex flex-wrap gap-x-4 gap-y-5` items of
  `stackColumnWidth(zoom)` each, left to right in the reader's order, wrapping down. **The count of
  boxes is `flow.length` and nothing else** — no zoom, no desk height — and CSS decides how many sit
  on a line. `columnHeight` is gone from this view's props and `DeckEditor` no longer passes it;
  `DEFAULT_COLUMN_HEIGHT` and the view's `groupHeight` went with it. **`packColumns` is untouched
  and `TextView` still uses it**: a decklist line is 21px, so a column there holds thirty and
  filling one is what makes that view readable — the two views differ because a card is 300px tall
  and a line of text is not. **The price was a ragged foot**: a line is as tall as its tallest
  pile, so a 40-card Creature stack beside three one-card piles left space under the short ones
  that the pack would have filled — taken deliberately, because reading order became left-to-right
  in the order the reader sorted, which is what a `sortOrder` is _for_, and unspent width was the
  complaint. **The bullet below stopped paying it the next day**, keeping the order.
- **The flow is a masonry, not a row of wrapped lines** (2026-08-15, and the third form of one bug).
  A flex line is as tall as its tallest item, so the wrap above only moved the blank desk: a
  40-card Creature pile set the height of every short pile on its line, and the reader was looking
  at the empty part of it. The flowing box is `display: grid` with
  `grid-template-columns: repeat(auto-fill, stackColumnWidth(zoom))`, `grid-auto-rows: 1px`, and
  each pile placed by `grid-row: span <its own height + 20>` (`flowRowSpan`). **Grid's ordinary
  placement is the masonry**: it fills the first free cell at or after the cursor and never walks
  back up the page, so with pixel rows a wrapped pile starts at the foot of the pile _above_ it,
  and the reader's `sortOrder` still reads down the page — DOM order, tab order and what a screen
  reader hears are untouched, which is why this is a grid rather than N hand-assigned columns.
  Four things carry it:
  **(1) the column count is still CSS's** (`auto-fill` off a definite width), so nothing here
  measures the desk and the rule two bullets down survives whole;
  **(2) what _is_ measured is each pile** — a `useLayoutEffect` read on every render, before paint,
  plus a `ResizeObserver` per pile for the changes no render causes (a heading wrapping as the
  search panel is dragged). It cannot be computed: `stackHeight(n, zoom)` is exact for the stack
  and the heading above it wraps or does not;
  **(3) `items-start` is what makes that safe** — a grid item aligned to the start of its area is
  content-sized, so its height does not depend on the span it was given; stretch it, the default,
  and measure → span → measure oscillates;
  **(4) the vertical gutter cannot be a `row-gap`** — a grid gap is drawn at every row boundary an
  item crosses, so a `gap-y-5` here draws one 20px gutter per _pixel_ of a pile's height, silently.
  The 20 rides inside each span instead; `gap-x-4` is unchanged.
- **`STACK_ATTR` (`data-deck-stack`) marks one pile in the flow**, and it replaced
  `STACK_COLUMN_ATTR` (`data-stack-column`), which meant "a box `packColumns` produced". It sits on
  `StackGroup`'s own `<section>` — there is no wrapper box left — beside the inline `width` and the
  `grid-row` span it is placed by. **The rail's piles carry none of the three**, and one prop says
  so: `flowWidth` is absent there, because the rail is a `flex-col` box that carries the width for
  the piles in it and in which a grid row means nothing. (It used to be the `flex: 0 0 Npx` basis
  that was load-bearing here — a basis on a `flex-col` child is read down the main axis and becomes
  a _height_ — and that shorthand went with the flex flow.) It pairs with `RAIL_ATTR`
  (`data-deck-rail`) — the two boxes a pile can be in, named the same way.
- **The rail costs a column of flow, and at the app's own window that is the column.** Measured
  live: at 1280×800 with the search panel docked the view is **602px**, so the rail's 224 and the
  16px gap leave **362 — room for exactly one**. The same deck that used to show ~2.7 columns
  across a sideways scroll is thirteen stacked lines now. That is the trade and it was made
  deliberately: the reader asked for the piles played beside the deck to be somewhere fixed, and a
  pile they can always find is worth more than a column they have to scroll to. **It is also the
  number to check first** if the rail is ever widened or the columns narrowed. **The width did not
  move when the Maybeboard joined it** — the two piles share one rail, one column wide — so the 602,
  the 224, the 16 and the 362 are still exactly the measurements they were, taken on the date they
  were taken. What the second pile changes is the rail's _height_, and that a new deck's rail holds
  two empty piles rather than one; the thirteen lines were counted with the Maybeboard still in the
  flow. Nothing here has been re-driven.
- **The Sideboard and the Maybeboard are a rail pinned to the right of the flow, and neither is
  ever packed.** `splitRail` in `views/columns.ts` takes them out before the pack runs, on
  **`kind === "side" || kind === "maybe"` and nothing else** — the name is the user's
  (`DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so any pile may be called "Sideboard"), and the kind
  is what the rules read. Both were the greedy pack's worst case: a category like any other, so each
  landed wherever the run put it, which on a long sideways run was off the right-hand edge. **The
  Maybeboard is there for the same three reasons the Sideboard is** — it is played _beside_ the deck
  rather than in it, it is routinely big because it is where the cuts and the candidates accumulate,
  and it is the other pile a reader looks for by _position_, which for a category seeded last means
  the far end of a long run. **The split changed neither view's contract** — `TextView`'s
  `packColumns` is still greedy, in the reader's order, never reordering, never splitting a group,
  an over-tall group taking its own column, and `StackView` still maps `flow` straight through in
  that same order; both are simply handed fewer groups. The rail is drawn for an **empty** pile too: an empty pile is where
  the next card of that kind goes, and a rail that appeared with the first card would move the
  layout under the reader's hand. **No group with either kind is no rail at all** — and which groups
  carry the kind is `buildGroups`' answer, never a view's. Under `Group by` mana value or type the
  derived buckets are headings with `kind: null` and they flow, but **every switched-off category
  is appended as itself**, so a reader who turns the Sideboard off and then groups by mana value
  gets a rail beside a layout made almost entirely of headings — and the Maybeboard, seeded
  switched off, reaches the rail by that route almost every time. **Nothing here sorts the rail**:
  the Sideboard sits above the Maybeboard because that is where the reader's own `sortOrder` puts
  them, and a reader who reorders their categories gets the order they chose. The split reads `kind`
  and nothing else — not `isActive`, and never `groupBy`, which would push a deck concept into the
  one file here whose whole discipline is not knowing what a deck is. A group in the rail is the
  same `StackGroup`/`TextGroup` as a group in the flow, so its `aria` and its drop target come with
  it rather than being defined twice.
- **The narrow case is CSS, and has to stay CSS.** The flowing area carries a `minWidth` of one
  column, so when the desk cannot hold a column _and_ the rail side by side, the outer container's
  own `flex-wrap` drops the rail onto the next line — `ml-auto` is what keeps it on the right when
  it lands there, and a no-op at every other width. `min-w-0`/`flex-1` cannot say this, because a
  flex item that may shrink to nothing never wraps; a `ResizeObserver` could, and is refused —
  **this view has no business observing its own box** — the rule that outlived
  `DEFAULT_COLUMN_HEIGHT`, and which the masonry above does **not** weaken: what that observes is
  each _pile_, and how many piles fit on a line is still `auto-fill`'s answer, so the view still
  takes no measurement of the desk at all, in either axis. A second reading of the same box answers
  a frame behind the layout it is reacting to; a reading of something laid out _inside_ it does
  not. The widths, and the law behind all three of these bullets:
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **The rail is a plain flex child and nothing about it is sticky**, which is the one thing to read
  before reinstating anything. It was briefly `sticky right-0` over an opaque `bg-bg` at
  `LAYER.raised` with a leftward seam shadow, and all four existed for a single reason: to hold the
  rail in view **while the packed columns scrolled sideways underneath it**. The columns wrap
  downward now, so nothing passes under the rail — an opaque backdrop occludes nothing and a seam
  shadow draws a permanent divider across a layout in which nothing moves. `ml-auto` is the whole
  mechanism that is left. The rail therefore carries `RAIL_ATTR` (`data-deck-rail`) **only**:
  `STACK_ATTR` means "a pile drawn in the flow", and the rail's piles are by construction the ones
  that never reach it, so a sweep counting the deck's own piles goes on counting those. The
  constant is spelled for the _rail_ rather than for the Sideboard, because the Sideboard is no
  longer the only thing in it. `views.test.tsx` asserts
  those four absences alongside the classes, because reinstating a sticky rail is a two-word edit
  no other test would notice.
- **`commander` and `companion` are still not railed, and that is not an omission** — one card
  each, by construction, and railing either would spend a column's width on a pile that is read at
  a glance, permanently, in every deck. What the rail prevents at the other end is a drag with no
  destination on screen: the two railed piles sort last, so packed they were the far end of the
  run, and a card dragged out of the main deck had nowhere to be let go of. The rail is drawn only
  when a `side` **or** `maybe` group exists, and **that condition is real for a story and not for
  the app**: `PREDEFINED_CATEGORIES` seeds both into every deck, both draw whether or not anything
  is in them (neither is one of the two conditional zones, and the seed writes both `origin: 'user'`
  — a rules zone is a pile nobody has to earn), and a predefined pile cannot be deleted
  — so under `category` the rail is there from the moment a deck is created, holding two empty piles
  or two full ones. **It costs `stackColumnWidth(zoom)` beside the flow** — 224px at 1×, 434px at
  2×, both derived from that one function — which at 2× on a 1280px window is a third of the width;
  the second pile costs the rail height and no width at all. The wrap is what makes that bearable
  rather than what removes it: below one column plus the rail, the rail takes its own line instead.
  **The sticky rail's live figures went with the sticky rail** — the `position: sticky`,
  `z-index: 10` and occlusion readings taken on 2026-08-14 measured the one-commit implementation
  that was replaced. The wrapping rail has since been driven and its figures are in
  [frontend-design.md](../../../docs/reference/frontend-design.md). **The two-pile rail has been
  driven in Storybook over CDP and not in the shipped window** (2026-08-14): the rail held
  `["Sideboard", "Maybeboard"]` in that order with neither in a packed column. What that pass could
  not answer is anything about _size_ — a headless browser at a story's own viewport is not the
  app's window — so the rail's **height** remains the unmeasured thing, and its width was never in
  question.
- **A deck card is the whole card, and the app's marks are overlays on it.** The picture _is_ the
  card, so `deckCardName` on the button is the **only** name a screen reader gets — but the app
  draws a **printed-card frame under it** (name, cost, type line) that the picture paints over,
  because a lazy-loaded category is a wall of `<img>`s and the card is known before its bytes are.
  The frame is the same thing that says "No image", "Retrying…" or "No card".
- **The marks go left, and they used to go right** (changed 2026-08-13). Over the art go facts
  about the _deck_ — the quantity tag, the Game Changer banner, `RULE BREAK`. Under it goes the
  data line with facts about the _printing_. `QuantityTag` merges the tag and the copy count into
  one mark: the count printed on the tag's own colour, grey when there is no tag, so gold stays
  something a tag says. `TagDot` is unchanged on the other three views. It costs ~34px of printed
  name, knowingly; the app-drawn frame insets its own name band by exactly that width so a name
  _this app_ wrote is never clipped.
  **The box that mark is drawn in is `components/CountTag.tsx` and no longer this folder's**
  (2026-08-14): the slant, the 22px height, the mono face, the `aria-hidden` and the bare number.
  The search wall counts printings with the same object, so the grey moved with it —
  `NEUTRAL_COUNT_PAINT` is what `UNTAGGED_COLOR` became, and `QuantityTag` now passes `paint` for
  a tagged card and nothing at all for an untagged one. What stayed here is what makes this one a
  _tag_: the colour, the two-fact sentence in its `title`, and `LAYER.overlappingMark`.
- **The data line is a sibling of the button, not a child** — so unlike every mark over the art
  its text is genuinely announced rather than swallowed by the button's `aria-label`. It is the
  card's foot: a 28px bar under the face, ridden **4px** up so the face's clipped corners cover
  its square ones.
- **Every mark carries a `title`, and that is a second contract from the accessible name.**
  `deckCardName` is the whole of what a screen reader gets; a pointer user sees a 6px gem, a
  slanted colour tag and a crown, none of which is a word. Six sentences, pinned by
  `CardStack.test.tsx`: the tag (`"Fast mana · 2 in this pile"` — the tag and the count are one
  mark, so one title says both), `"Game changer"`, the rule break's own finding, the rarity
  (`RarityGem` grew a `title` for this; the stack draws no rarity text), the shortage, and the
  finish through `FinishMark`'s SVG `<title>`. **The seventh is missing on purpose**: the canvas
  wants the set _name_ behind the printing code, and `DeckCard` carries only `setCode` —
  `cards.set_name` exists but `deck_card_select` does not select it.
- **A card carries two marks beyond its own facts — _picked_ and _landed_ — and they are one
  vocabulary across all four views** (`cardControl.tsx`, 2026-08-14). Picked is the card the detail
  pane is open on: `SELECTED_CARD`, which is `ring-2 ring-accent`, character for character
  `components/CardArt`'s `selected` recipe, because the deck is answering the same question the
  search wall answers and a reader must not have to learn two vocabularies two clicks apart. Landed
  is a card the reader has just added, for **five seconds, fading the whole way**. Both are keyed the
  way the question is asked: picked by `cardId` (a pane is open on a _printing_, so a card filed in
  two piles is marked in both — `TableView` already did this and the other three now agree), landed
  by `deck_cards.id`, because `deck_add_card` **folds** and the row the write landed in is the one
  worth pointing at. `TextView` says picked as `SELECTED_ROW` and `TableView` keeps
  `VirtualTable`'s own quiet row colour, which all three of the app's tables share; what all four
  agree on is the **attribute**, `SELECTED_ATTR`/`LANDED_ATTR`, which is what `views.test.tsx`
  sweeps and what a CDP probe can ask. A class is a recipe and would go red for a change of taste.
- **The landed mark is gold with a glow since 2026-08-15, and it was parchment before that — but
  the half that is a _requirement_ is that it is drawn _inside_ the card's face.** The old rule
  read gold as taken four times over on this one surface — focus, the picked ring, and both halves
  of the drop affordance (`AppShell`'s `DROP_RING`/`DROP_OVER`) — with red the rule break's and
  green forbidden for anything that is not mana, leaving `--color-text`. The census was right and
  the answer was wrong: parchment is the app's **text** colour, so the mark was the same value as
  most of what is already on screen, and the reader reported not being able to see it. **What keeps
  the fourth gold apart is shape and place, not hue** — the other three are each a _line around the
  outside_ of a box, and this is a **filled face**: `border-accent`, a
  `from-accent/40 to-accent/12` wash, and an `inset` box-shadow glowing in from its own rim. A
  picked card wears a ring around an unwashed card; a landed card is lit through and wears no ring.
  **The glow is `inset` for a clipping reason and not a stylistic one**: the face is
  `overflow-hidden` (it clips the picture's corners), so an outward `box-shadow` or a
  `drop-shadow()` filter is cut off in `Stacks` and drawn in the other three views — one mark
  looking like two. Inside the face, because the mark has to be legible **from the middle of a
  stack**, where a card shows only the 34px of its own printed title bar that its successor has not
  painted over — an outset ring there has three of its four sides covered, while a border on an
  `inset-0` overlay leaves a bright hairline across the card's top and a lit strip under it, and an
  inset glow puts its brightest band on exactly that edge. `rounded-[inherit]` **emits no rule at
  all** (Tailwind validates an arbitrary `rounded-*` as a length and drops a bare keyword), so each
  surface passes the radius of the box it lays the mark over.
- **The five seconds live in `src/index.css` _and_ in `LANDED_MS`, and `cardControl.test.ts` is what
  holds them together.** They are two consumers rather than a copy — the stylesheet fades the mark
  (`--animate-card-landed`, held at full for the first two fifths then linear to nothing) and the
  constant unmounts it — and no expression can compute one from the other. **They were ten seconds
  until 2026-08-15 and were halved by the same change that made the mark gold**: ten was buying a
  quiet mark the time it needed to be found. The hold stayed at **two seconds** through the halving,
  because it measures the trip the reader's eye makes rather than a fraction of the total, so what
  was spent is fade (8s → 3s). **It is deliberately not
  in `src/lib/motion.ts`**: that module is a three-tier scale capped at 260ms and `motion.test.ts`
  fails any duration off it, correctly, because everything in it is a _transition_. This is a mark
  that decays. The map's **value is a nonce, not a timestamp**, and it is passed straight through
  as React's `key`: a CSS animation runs once per element, so a second add of a card still glowing
  would otherwise land in silence.
- **Every add path in the editor marks a row, and the panel needs a callback to do it.** The quick
  add and every drop go through `DeckEditor`'s `addTo`, which passes a per-call `onSuccess` — per
  call rather than on the mutation, because `useDeck.addCard`'s own `onSuccess` answers for every
  surface that borrows the hook, including `useSidebarDrops` with no editor on screen. The docked
  panel holds the mutation and presses it itself (which is what makes its Add button never
  disabled), so it takes `onAdded` and hands the row back. `useRecentAdds` holds one timer per row,
  restarted on each press, so a card added three times in quick succession glows once for five
  seconds from the last press. The import is deliberately outside all of this: 117 lit cards is not a mark.
- **A click on the desk puts the card down, and putting it down closes the pane** — one listener on
  the editor's root, `keepsSelection` deciding what counts. The two facts are one: the ring means
  "the pane is about this card", so a mark outliving the pane is a ring around nothing and a pane
  outliving the mark is a pane about a card the deck is not pointing at. The test is "not a card and
  not a control" rather than "not a button", because a card is **more than its button** — the stack
  card's data line is a sibling of it and the grid tile's control bar is a positioned span — which
  is why the outermost element of a card carries `CARD_BODY_ATTR`. Without that test the listener
  would undo the very press that made the selection: the card's own handler and this one run in the
  same event.
- **In `Stacks` the picked card is also the pile's _resting_ state** — `openIndex ?? selectedIndex`
  in `CardStack`. The hover still wins while there is one, so the flip-through is unchanged; what
  changed is what it falls back to. Reading a card in the pane used to mean watching it drop back
  into the pile the moment the pointer left the stack. **Still exactly one card open**, which the
  whole geometry note below is arithmetic about, and **still no dependency of `stackHeight` on any
  of it**. The cost is real and is paid knowingly: a picked card in the middle of a tall pile pushes
  its tail 293px out of the box for as long as it is picked, over whatever is on the next flex line
  — which is what the flip-through already did on hover, now held rather than transient.
- **`CardStack` is arithmetic, not taste.** The card's height is _derived_: a Magic card's aspect
  applied to the card's own width gives **293** of image, its two hairlines make that **295**, and
  the data line less its rise makes **319px**. The
  collapsed **−285px** margin leaves a **34px** reveal, a legibility floor for the overlaid tag
  rather than a fraction. The list gets a fixed `stackHeight(n) = 34(n−1) + 319 + 8`, and the open
  card's margin turns −285 into +8: a **293px** push-down of every later card, out of a box whose
  height does not change. **Those two hairlines are the card's own and they still paint**:
  `STACK_CARD_BORDER` is a length with two owners, and the pair that stopped painting on
  2026-08-14 is the group `<section>`'s, one level up in `stackColumnWidth`.
- **The stack's controls are revealed by the card being _open_, never by `group-hover:`**
  (`revealedWhenOpen`). A collapsed card's only hittable part is its 34px strip, so hovering it
  used to reveal a control bar hundreds of pixels below, behind three other cards. They are a
  vertical column in the card's right margin now — `DeckCardControls layout="card-column"`, which
  is also the only layout whose buttons carry a backing, because it is the only one drawn on art.
- **Every number in the two bullets above is the value at zoom 1×, which is where the reader starts
  and no longer where they stay.** Ctrl+wheel over the desk steps **the desk's own zoom** —
  `useAppStore`'s `cardZoom.deck`, one entry of a record keyed by card section
  (`src/lib/cardZoom.ts`), shared by the Stacks and Grid views because they draw the same pile —
  along a ten-stop ladder from 0.5× to 2×, so each of those constants now
  has a function beside it — `stackCardWidth`, `stackImageHeight`, `stackDataHeight`,
  `stackCardHeight`, `stackAdvance`, `stackCollapsedMargin`, `stackHeight(n, zoom)`, and
  `stackColumnWidth(zoom)` in `StackView` — and the bare constant survives as that function's
  documented base. **The desk's zoom is independent of the docked card search column beside it**:
  that column is its own section (`deckSearch`), so sizing the wall a reader is browsing no longer
  resizes the deck they are building, which is the whole reason the zoom stopped being one number
  on 2026-08-14. **Driven in the shipped window that day** (debug build, 1280×800, over
  `scripts/cdp.mjs`, both directions with the panel open): ctrl+wheel over a deck card took the card
  **208 → 229px** while the panel's tile held at **159px**, and ctrl+wheel over the panel took its
  tile **159 → 330px** while the deck card held at **229px**. The badge anchored to whichever of the
  two the gesture landed in — the desk's box read `top 263 / right 830` and the panel's wall
  `top 551 / right 1230`. Full figures in
  [frontend-design.md](../../../docs/reference/frontend-design.md).
  **Two of them are floors rather than proportions and they are the ones to know**:
  `stackAdvance` is `max(34, scaled(34, zoom))` and `stackDataHeight` is `max(28, scaled(28, zoom))`,
  so both grow going up and **hold at their base going down**. Each measures something laid over or
  inside the card — the quantity tag on the reveal strip, the type in the data line — and type does
  not shrink because a card did. Scaling either linearly is the mistake the floor exists to prevent:
  at 0.5× the reveal would be 17px under an unscaled tag, and the data bar would be 14px around 11px
  type. The same grow-only rule governs the grid view's caption and gutter and `CardGrid`'s caption
  strip: **anywhere a scaled budget has to contain unscaled chrome, the budget floors rather than
  scales.** `STACK_DATA_RISE` is the third kind — 4px at every zoom, because the 7px corner radius
  it hides the seam of is a Tailwind class that does not scale either.
- **The column is derived from the card, not the other way round** (it used to be: 14rem minus
  padding). `stackColumnWidth(zoom) = stackCardWidth(zoom) + padding + border`, with the chrome
  **added and never multiplied** — 6px of padding is 6px at every zoom, because padding is not part
  of a card. Scaling the two independently agrees at 1× and drifts at every other stop. 210 + 12 +
  2 = **224** at 1×, which is the `14rem` this replaced, exactly. **The `border` term is the
  `<section>`'s own hairline and it is `border-transparent`** (see the next bullet): a border box
  that paints nothing still occupies its 1px either side, so clearing the colour cost this sum
  nothing — while **deleting the class** would draw every card 2px wider than `stackCardWidth()`
  says it is, which is the one number the whole of `CardStack` is derived from.
- **A pile at rest has no edge, and the box that edge was drawn in is still there** (changed
  2026-08-14). `StackGroup`'s `<section>` is `border border-transparent` in **both** states, with
  a `bg-surface/60` wash under the inactive one; it used to be `border-border` active and
  `border-dashed border-border bg-surface/40` inactive. A column of card faces is already a
  rectangle with a hard edge, so an outline around it framed a frame, and fifteen of them read as a
  form rather than as a deck. **The cost is the one signal that told the two states apart**, so an
  inactive pile now says so three ways and an active pile says nothing at all: the wash, the dimmed
  name beside `GroupHeader`'s `INACTIVE` marker, and the pile's own `CardStack` at `opacity-60`.
  The drag marks needed no rework — `DROP_RING` is `ring-2`, and a ring is a box shadow **outside**
  the border box, so the highlight never read the border it appears to sit on. One thing to know if
  the lift ever regresses in switched-off piles only: **`opacity-60` makes that `<ul>` a stacking
  context**, and the `<ul>` is what takes `LAYER.raised` when a card opens.
  **Measured in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build at
  1280×800): every `<section>` computed `border-width: 1px` with `border-color: rgba(0, 0, 0, 0)` —
  the box survives, the line does not — the inactive pile computed a `0.6`-alpha wash with its
  `<ul>` at `opacity: 0.6` against an active pile's transparent and `1`, and during a drag every
  eligible pile computed its ring while only the pile under the pointer added `DROP_OVER`'s gold
  and the drag source added neither. Full figures:
  [frontend-design.md](../../../docs/reference/frontend-design.md).
- **`opacity-60` cannot be checked on an _empty_ pile — `CardStack` returns null for a group with
  no cards**, so a switched-off empty pile has no `<ul>` in the DOM at all and a probe reports it
  absent rather than 0.6. Move a card in before reading that signal (this cost the 2026-08-14 pass
  a read on the Maybeboard). An empty pile carries the other two signals only: the wash and the
  `INACTIVE` marker.
- **Exactly one card moves per step, and that is the whole reason the interaction works.**
  Opening card _N+1_ instead of _N_ leaves every other card's top unchanged. The reflow is one
  card sliding out of the stack, not a list resettling — and the pointer that armed it stays
  inside it for every frame.
- **The lift is state, not CSS, because pure CSS could not be given hover intent** (changed
  2026-08-12). The same arithmetic that makes one card move is what broke selection: after the
  first step the next card's strip sits ~34px below the pointer, so one continuous sweep armed
  four or five cards in ~60ms. `CardStack` holds `openIndex`, armed by `pointerenter` after a
  **80ms** dwell (`STACK_OPEN_DWELL_MS`) and closed after **180ms** (`STACK_CLOSE_DELAY_MS`),
  where arming another card cancels the pending close. **No new hit target was needed** — a
  closed card is overlapped 285px by its successor, so its only hittable part already _is_ its
  34px reveal strip. `LAYER.raisedOnHover`/`raisedOnFocus` are **gone**. The margin is no longer a
  Tailwind literal either — `motion` writes it inline, so the constants are the only place these
  numbers live.
- **The stack comes forward; a card in it never does.** The list takes `LAYER.raised` while
  anything is open, because the cards it pushes down leave its box on purpose. **No card carries
  a z-index at all** — they are `relative` siblings, so painting order is document order, and
  each card drawn over the one before it _is_ the stacked look. Raising the open card inverts
  that for the whole tail of the stack, on the first frame, while the cards after it are still
  293px from where they are going: it reads as the card jumping in front and the stack catching
  up around it. They uncover it instead. **jsdom paints nothing, so only the live pass can prove
  this** — see [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md).
  **`LAYER.raised` has one occupant in this view and that is deliberate**: the rail took the same
  rung for as long as it was an opaque sticky column, which made the two orderable only by document
  order. It is a plain flex child now and asks for no z-index at all, so an open card's list is the
  only thing raised here and there is nothing for it to be ordered against.
- **`data-stack-open` exists so a test or a `cdp.mjs --probe` can _count_ open cards** — the CSS
  lift was observable from neither.
- **`onFocus`/`onBlur` sit on the `<li>`, not the button**, which is `focus-within`'s old reach
  and is load-bearing: `DeckCardControls` is a _sibling_ of the button, so a caret stepping into
  the stepper would otherwise collapse the card out from under itself. The keyboard opens with
  **no dwell** — a caret is a deliberate act.
- **React never listens for `pointerenter`.** It synthesises enter/leave from
  `pointerover`/`pointerout`, so `fireEvent.pointerEnter` fires an event the component cannot
  hear and the test passes having called nothing — drive these with `fireEvent.pointerOver`/
  `pointerOut`. And **`userEvent` cannot be driven under Vitest fake timers at all**: RTL's
  `asyncWrapper` waits on a real `setTimeout` it only knows how to advance through _Jest_, so
  such a test hangs to its timeout rather than failing.
- **The stack's lift is `motion`-driven, so it has no CSS transition to probe** and its
  reduced-motion opt-out is `useReducedMotion()` — see [the Motion rules](../../CLAUDE.md) in
  `src/CLAUDE.md`. That hook reads its value once at mount, so emulating
  `prefers-reduced-motion` _after_ mount proves nothing about it.
- **The reflow runs on `slow` (260ms), not on the interaction tier** — `stackCard` in
  `src/lib/motion.ts`, changed 2026-08-14 from `base`. 293px is drawer distance, and a reader
  running down a stack watches the travel on _every_ step rather than once, so 180ms read as
  snapping. It is the same three tiers; only which rung this preset sits on changed. The
  **180ms** `STACK_CLOSE_DELAY_MS` is deliberately no longer equal to it: that one is gesture
  intent and has never been derived from the tween.
- **Four card surfaces outside the editor are drag sources, all through the one `cardDraggable`**,
  carrying `{ kind: "card"; cardId; name; typeLine }`. The `typeLine` is **normalised rather than
  validated** — `readDragData` refuses a bad `cardId` or `name`, but turns an unusable type line
  into `null`, because the pile is all it decides and `Uncategorised` is already the answer for
  not knowing. The remove tray narrows to `"deck-card"`, so a card from another wall never draws
  it.
- **A printings row in the card pane is clickable to view that printing** — `store.viewPrinting`
  sets `selectedCardId` _without_ clearing `paneDeckContext`, so the swap offers survive browsing.
  `setSelectedCardId` there instead silently kills the affordance at its one moment of use.
- The editor's full-window surfaces — Import, Categories, Tags, History, Theory diff, Deck
  settings, Export and the delete-category confirmation — are held in **one** piece of state, and
  the anchored format check rides in the same union, so at most one registration is ever enabled.
  **Count them off `Layer` in `DeckEditor.tsx` rather than from a number written here**; the list
  grew twice in one day when the menus landed, and a number in this bullet was wrong both times.
  The original reason for one slot was that `useDismissOnEscape` ordered exactly two rungs, so two
  `"inner"` peers open at once were not ordered at all; **that hook keeps a capture stack now**
  and would order them, and
  the one slot is still right — two of these open together is not a state anything here draws, and
  a union is what makes "never two" structural rather than remembered. **Three members carry a
  payload** — `export` and `deleteCategory` a category id, `import` an optional forced category
  name — which is the other thing a union buys: a second `useState` could hold a category id while
  a *different* layer was open. Each payload is an **id and never the cards**, because the deck is
  re-read after every write and a frozen array would answer about the deck as it was at the moment
  a menu row was pressed.
- **The two that were drawers are centred modals, and the search column deliberately is not**
  (changed 2026-08-14). **Two** surfaces were right-hand drawers and **three** dialogs came out of
  them: History was `AuditDrawer` and is `DeckHistoryDialog`; the piles and the labels were two
  sections of one `CategoriesPanel` drawer and are `CategoriesDialog` and `TagsDialog` now, each
  one press away instead of a press and a scroll, with `metaRows.tsx` as the shared row grammar
  the two of them draw with. Those three and `DeckSettingsDialog` — **four** surfaces — are built
  on one shell, `DeckDialog.tsx`; the editor's other two full-window overlays (Import cards, the
  theory difference) were never drawers, still carry their own copy of that chrome and are the
  next two to move onto the shell. **Five** is only the count of _toolbar buttons_. The
  reason for all of it is the desk row: every one of these is **consulted** — read, or
  edited and shut — and a right-hand drawer took the width it needed out of the deck for as long
  as it was up while giving the deck nothing. The card search column stayed a docked sidebar
  because it is the one surface here that is **worked out of**: its tiles are drag sources into
  the deck's own category columns beside it, so a scrim would end the drag path and cover the card
  pane a reader flips printings in. It opens **collapsed** instead, which is the same 602px
  argument answered the other way — the deck starts with the whole desk and one press on the rail
  gets the wall back. **Its body is mounted on the reader's press and merely _hidden_ when the
  editor rails it for want of width**, and those two must not be folded into one gate: `open` is a
  choice and `roomy` is a measurement, so mounting on both threw the reader's typed query,
  filters and format away on a _resize_ — opening the card pane at 1024 was enough. Never opened
  is still nothing mounted, which is what keeps the search off a deck nobody searched from.
  The app-wide form of this rule is in [`src/CLAUDE.md`](../../CLAUDE.md).
- **The docked panel's width is the reader's, dragged from its left edge** (2026-08-14).
  `ResizeHandle` is an ARIA window splitter — `role="separator"`, `aria-orientation="vertical"`, a
  `tabIndex`, `aria-valuenow`/`min`/`max` in **px**, arrows and Home/End for the keyboard — bounded
  by `min(half the window, what the desk can spare over DECK_FLOOR)` and floored at
  `MIN_PANEL_WIDTH_PX` (**206**: one 150px card plus the panel's border and padding, the wall's,
  and the wall's 15px scrollbar). It is the other half of the same complaint the zoom fixes —
  `CardGrid` sizes a tile from the reader's zoom and fits however many the wall holds, so bigger
  cards mean fewer of them and the two answers are zoom out or widen the column.
  - **The width is `useState` in this panel's root, beside `open`**, so it is per editor-open and
    deliberately not remembered — the same answer, for the same reason, as whether the panel is
    open at all. It **does** survive a collapse and a railing, because `OpenPanel` is what
    unmounts and the root is not.
  - **The caps clamp what is _drawn_ and never what was asked for.** A window narrowing, or a card
    pane opening beside the editor, is not the reader changing their mind, so it may not overwrite
    what they chose — write the clamped number into state instead and every momentary squeeze is
    permanent. A drag writes clamped, because there the bound is the edge they are pushing against.
  - **The rail's threshold is the panel's _minimum_ now, not its opening width**, which moved it
    from a desk of **592** to **414**. Across those 178px the panel draws squeezed rather than
    railing; driven at a desk of 450 it took 242 and left the deck exactly its 192. Below 414
    nothing changed — no room for a card is no room for a card search, and the disclosure still
    refuses in words.
  - **`DeckEditor` owns both measurements and hands down one number.** `maxWidth` is the editor's
    because the editor is what has the desk's `ResizeObserver` and the window's own width, which it
    reads as `document.documentElement.clientWidth` in the same callback — `innerWidth` would count
    the editor's page scrollbar and cap the panel 8px too wide (632 vs 640, measured). Every figure
    is in [frontend-design.md](../../../docs/reference/frontend-design.md).

## The quick add

`QuickAdd.tsx` — the toolbar field, its dropdown and its status line, one component. `DeckEditor`
keeps only the _decision_: which pile the add lands in (`targetCategoryId`, which since
2026-08-15 is the deck row's `defaultCategoryId` rather than a `useState`) and the write that
puts it there. `QuickAdd.test.tsx` covers the field itself; the Escape hand-off below is pinned in
`DeckEditor.test.tsx`, because that one is about the ladder rather than about this control. The
longer-form record of the two hand-rolled comboboxes and their shared panel is
[frontend-design.md](../../../docs/reference/frontend-design.md).

- **It is a shortcut over the docked panel's wall, not a second way of choosing a printing.** The
  search is `collapse: true`, so every suggestion is the newest printing of that name — the same
  one the panel offers first for the same text. A reader who cares which printing they get has the
  panel open beside them — one press on its rail, since it opens collapsed — so this field never
  grows a set column or a printing picker.
  `MAX_SUGGESTIONS` is **five**, and the ceiling is the reader's rather than the backend's: a list
  long enough to need a scrollbar has stopped being a shortcut and started being the wall again.
- **Three routes reach one write, and the third is the one that looks removable.** Enter on the
  highlighted suggestion, a click on a row, and — inside the debounce window, before any
  suggestion exists — a one-shot `limit: 1` search. That third route is the field's **original**
  behaviour and must not be deleted: the debounce is `DEBOUNCE_MS` (300ms, the same one the three
  list views use), and a reader who types a whole name and presses Enter inside it has no row to
  take. Losing it would make the dropdown a regression for exactly the readers who are fastest at
  this. It is also where the miss comes from — “No card found for …”, said in words and with the
  typed text kept, because the next action there is to correct it rather than to type the next
  card. Both requests are the same search differing only in `limit`, which is what keeps the
  top suggestion and the fallback's one hit the same card.
- **Enter takes a row only while the rows answer what is in the field _now_.** `fresh` is
  `debouncedText === text.trim() && !suggestions.isPlaceholderData`; when it is false Enter falls
  through to the one-shot search, which asks about the text that is actually there. The bug this
  prevents is adding the top hit for `sol r` while the field says `sol ring` — the debounce opens
  that window on every keystroke, so it is a real case rather than a theoretical one.
  `keepPreviousData` (there so the list does not blink empty between letters) is what makes the
  second clause necessary, and it is also why the rows are read off `text` rather than
  `debouncedText`: clearing the field changes the key to `""`, which the query is `enabled: false`
  for, so the last five rows would hang under an empty box for the rest of the session.
- **The Escape rung is `enabled: listOpen`, never `enabled: open`.** With the caret in a quick add
  whose list is closed, the press belongs to the card detail pane, which listens on `window` in the
  bubble phase — a capture-phase listener here would consume it and close nothing at all.
  `DeckEditor.test.tsx`'s "lets Escape through to the card pane when no layer of its own is open"
  focuses this very field and asserts the press arrives with `defaultPrevented` false. Escape here
  closes the list and hands focus to nobody: the field is not unmounting and is what the caret was
  in the whole time, so the hook's focus-hand-back clause has nothing to do.
- **The list is one more `"inner"` peer on this screen and deliberately outside the `Layer` union
  above**, kept apart by focus and click mechanics rather than by structure — the same arrangement
  as the docked panel's set filter. **Most of the editor's full-window surfaces are opened by
  pressing a button** — five of them in the toolbar (`Import cards · Categories · Tags · History
  · Deck settings`) and the theory diff from the "N cards differ" control beside the variant tabs
  — and pressing a button takes the focus out of this field, so the root's `onBlur` closes the list
  on the way.
- **Some of them arrive another way, and the rung this used to say was missing has since been
  built.** The export dialog, the delete-category confirmation and the clear-stack confirmation
  are opened from a category heading's right-click and have no _button_ in the view at all — the
  first editor surfaces with none, the affordance being the heading itself. Read the list rather
  than a count: it said "two" until `Clear stack…` landed on 2026-08-15. (A pile can still be
  deleted from the Categories dialog, which draws `DeleteCategory` for itself; that layer is the
  _heading's_ route to the same component. The clear has no second host — `ClearCategory.tsx` is
  the heading's alone, because there is no bulk surface that empties a pile.) This entry used to
  end "**that is the whole
  of what makes a third rung unnecessary**, so a future surface opened without moving the caret
  breaks it, and the fix is a depth in `useDismissOnEscape`, not a second `"inner"` and a hope".
  **That depth exists**: the hook keeps a stack of capture-phase registrations and only the token
  on top acts, so `"inner"` peers are ordered by mount depth rather than racing in registration
  order — which is what lets a context menu open over a dialog opened over the card pane and give
  one press to each. So the prediction was right and the remedy is the one it named; what is no
  longer true is that focus mechanics are all that hold this together. **The focus half holds for
  these two anyway rather than by luck**: `ContextMenu` focuses its own panel in a layout effect
  as it opens and hands the caret to the opener before it runs a row, so a right-click has already
  taken the caret out of this field before the dialog exists. What to check for the next surface is
  therefore narrower than it was — whether it registers its rung, not whether a button was pressed.
- **The query carries no `marketplace`, and that is a documented exception** to the app's rule that
  every price-bearing query carries it and has it in the key. A row draws a name, a mana cost and a
  set code and no price at all, so a currency switch has nothing to change about it, and putting
  the marketplace in the key would refetch five names for nothing every time one happened. The
  exception is valid only for as long as the rows stay priceless.
- **The caret never leaves the field, and two small things are what make that true**:
  `aria-activedescendant` moves the highlight instead of the focus — which is why the dropdown is
  a listbox and not a row of buttons, since a reader typing a name must not have to Tab into the
  answers to take one — and a row's `onMouseDown` refuses the focus a click would otherwise take,
  without which the click blurs the input, `onBlur` closes the list and the press lands on
  nothing. The highlight then follows **both** `onPointerMove` and `onMouseMove`, because the
  mouse and the keyboard must not disagree about which row Enter would take: React synthesises
  enter/leave from over/out and never listens for `pointerenter` at all, so a move event is the
  honest one.
- **The field is named for where the add lands, and a row is named by its own content.** The
  label is `Quick add a card to <pile>`, or bare `Quick add a card` under `AUTO_CATEGORY`, where
  there is no one answer because the pile is per card, so the name says only what it can promise
  — "Quick add a card to Auto (by what it does)" would name a _setting_ rather than what pressing it
  does. `DeckEditor.test.tsx` addresses the field by both names, so a reworded label is a suite
  failure. A row carries **no `aria-label`**: its name is the card's name, the cost's `sr-only`
  tokens and the set code, and a label carrying only the card's name would make the row
  indistinguishable from the docked panel's tile for the same card — an ambiguity that is real,
  because both are on screen at once.
- **Driven in the shipped window 2026-08-14** (`npm run tauri dev`, a **debug** build, 1280×800,
  against the real 116 703-card corpus): `sol` drew **5** rows with row 0 `aria-selected` and
  `aria-activedescendant` on it. The panel computes `z-index: 30` (`LAYER.popup`),
  `position: absolute` and `transform-origin: 0px 0px`; its left edge is **285** against the
  field's **285** and its top **199** against the field's bottom **195** — the `mt-1` — at 288px
  wide, with no right overflow and `documentElement.scrollLeft` **0**. Two ArrowDowns moved the
  highlight to index **2** with `document.activeElement` still the field, and Enter added _that_
  row rather than the top one, filed under `Creature` by its type line. A click on the fourth row
  added it, left the caret in the field, and drew the colour-identity rule break on the new card —
  so the click goes the same write-and-validate route the rest of the editor does. The miss read
  `No card found for “counterspellgoblin”.` with the field's text kept. **The Escape ladder holds
  one press per layer**: with the card pane open, the first press closed the list and left the
  pane, keeping the caret in the field, and the second closed the pane. At **1024** the field is
  208px and neither it nor the status line clips (`body.scrollWidth` 1024). The console recorder
  caught **5** entries and no error or warning.
- **Two things the pass did not cover.** Reduced motion on this panel was not emulated — it is the
  same `popup` preset inside the same `PopupPanel` as the set filter, whose reduction is already
  measured, so this would be re-measuring a shared component rather than this one. And the
  freshness guard is **unit-tested only**: reproducing a stale list live means winning a 300ms
  race by hand, which is what a test with a controlled clock is for.

## Known open bugs

Three, all found by driving the shipped window and **none of them fixed** — all from the
2026-08-11 builder pass: the title row collapsing the deck name at 1060–1350px, a custom deck
cover never appearing in the gallery, and Table view starving the card name. Detail:
[docs/reference/decks-live-findings.md](../../../docs/reference/decks-live-findings.md).

The 2026-08-12 import pass found four more and **all four are fixed**, each with a test that fails
against the code before it: the preview tally ignoring the commander choice (the `## Import`
section above — it is a TypeScript decision), and three resolver-side ones in
[docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md) with their
reproductions — a printing hint trusted over the card name, `MOXFIELD_LIST`'s fabricated hints,
and `MATCH_ORDER` having no language term.
