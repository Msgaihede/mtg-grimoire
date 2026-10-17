/**
 * Decks: the rows and their detail, categories, labels and folders, the cards in a deck, theory and the deck's tokens, notes, to-dos, history, undo, pulls and quick adds, and the formats a deck is checked against.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `deckCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Finish } from "../finish";
import type { MarketplaceId } from "../marketplace";
import type { CardFilters, TokenPrinting } from "./cards";
import type { EntryChange } from "./collection";
import type { DeckCombo } from "./combos";
import { invoke } from "./invoke";

/**
 * What a deck category *is for* — `schema::CATEGORY_KINDS`, which `deck_categories.kind`'s
 * own CHECK is built from.
 *
 * **This is not the category's name.** A category is a row the user makes, renames, reorders
 * and switches off; its `kind` is the fixed word the rules read, and only four of the five
 * are predefined (one `Commander`, one `Sideboard`, one `Companion`, one `Maybeboard` per
 * deck). Every category a user makes is a `main` one, and a deck may own any number.
 *
 * **The governing rule, and the one sentence to read before writing anything that counts
 * cards: the switch decides whether a pile counts *at all*; the kind decides only whether it
 * is played *beside* the deck or *in* it — and only `side` and `companion` are beside it.**
 * So a deck's size is every active category of kind `main`, `commander` or `maybe`, which
 * reads odd until the alternative is written out: an active Maybeboard that was part of the
 * card pool and part of the allocator's claims but not part of the size reported a singleton
 * error under a count that still said 100.
 *
 * `maybe` therefore exists for exactly one reason — to name the predefined Maybeboard and
 * seed it inactive. Nothing here says "counts toward nothing" any more;
 * {@link DeckCategory.isActive} does.
 */
export type CategoryKind = "main" | "side" | "commander" | "companion" | "maybe";

/**
 * Who made a category — `deck_categories.origin`, schema v15.
 *
 * **Rust records the provenance as a fact; this layer draws the conclusion from it.** `'auto'`
 * is written by `category_for_name`, the find-or-create the add and import paths file a card
 * with; `'user'` by `create_category` (the panel's "New category" button) and by the four seeds
 * in `ensure_predefined_categories`. `category_for_name` **finds before it creates**, so a pile
 * the reader made keeps `'user'` for ever even once the app starts filing cards into it.
 *
 * That last sentence is the entire reason this is a column and not a name list. "Ramp", "Draw",
 * "Removal" and "Lands" are exactly what a person calls their own piles, and
 * `DECK_CATEGORY_GRAIN` is `(deck_id, variant, name)` — one pile per name per list — so a rule
 * reading the *name* would quietly take over the pile a reader made deliberately. **The name is the
 * user's; the kind is what the rules read**, and provenance is the same kind of fact as the
 * kind.
 *
 * No CHECK behind it (`ALTER TABLE ADD COLUMN` cannot add one) and no Rust validation either,
 * which is the deliberate difference from `decks.last_variant`: `origin` is never supplied by a
 * caller, so there is no untrusted value to fence.
 */
export type CategoryOrigin = "user" | "auto";

/**
 * The two decks every deck secretly is — `schema::DECK_VARIANTS`.
 *
 * `live` is what is actually sleeved up: the gallery's card count, the deck's own collection
 * group and every write that moves cardboard — the pull, the record, the "send missing to the
 * wishlist" button — all read it and nothing else. `theory` is what the deck is being built
 * toward — a plan, which holds no cardboard and appears on no tile. The two are separate rows
 * of `deck_cards`, so a change tried out in Theory can never silently overwrite the deck as it
 * stands.
 *
 * **The variant is also which pool an owned count is read from, since 2026-09-09** (issue
 * #435). A plan holding no cardboard is a fact about *writes*; it stopped being a reason to
 * report `0` owned on every row of one. See {@link DeckCard.ownedQuantity} for the two pools
 * and why they differ.
 */
export type DeckVariant = "live" | "theory";

/**
 * Which object a deck row plays — `deck_cards.finish`, schema v18.
 *
 * **`null` is the regular copy, and `"nonfoil"` is not in this type.** Rust's
 * `deck::normalise_finish` maps the word to NULL at the one command boundary and the column's
 * CHECK makes any other path a hard error, because two spellings of "regular" would be two rows
 * on `DECK_CARD_GRAIN` that draw identically on screen and sum apart. Narrowing it here means a
 * surface cannot send the spelling that does not exist.
 *
 * It is the same shape `soleFinish` in `packages/ui/lib/finish.ts` already answers in, and for the same
 * reason: nonfoil is the finish a price is assumed to be, so it is the one that needs no word.
 *
 * **This is part of a deck row's address, not just its content.** A foil copy and a regular copy
 * of one printing in one pile are two rows, so every card command carries it.
 */
export type DeckFinish = Exclude<Finish, "nonfoil"> | null;

/**
 * One category of one deck: a named pile the user owns.
 *
 * Schema v8 replaced the fixed five-word zone with these. The four predefined ones
 * (`schema::PREDEFINED_CATEGORIES`) are seeded with every list and cannot be renamed or
 * deleted; everything else is the user's, and `kind` is `main`.
 */
export interface DeckCategory {
  id: number;
  deckId: number;
  /**
   * **Which of the deck's two lists this pile belongs to** — user schema v53 (issue #561).
   *
   * Until then a pile was the deck's and both lists shared one set, so a column made on Theory
   * appeared on Actual and switching the Sideboard off on one switched it off on the other. The
   * two lists are separate versions of the deck, and the theory diff is the only thing that
   * joins them — so each list has its own piles, its own four predefined zones, its own names,
   * order and switches, and a `deck_cards` row only ever points at a pile of its own list.
   */
  variant: DeckVariant;
  /** As the user wrote it — a column heading, and what every refusal about a card in it says. */
  name: string;
  kind: CategoryKind;
  /**
   * Who made this pile — {@link CategoryOrigin} — and, beside `kind`, the only thing
   * `grouping.ts`'s `drawsWhenEmpty` reads.
   *
   * `'auto'` means the app made it while filing a card and the reader never asked for it, so it
   * is drawn only while it holds one: *Ramp* arrives with the first ramp spell and goes with
   * the last. `'user'` is a pile made with intent — **including the four seeded zones**, which
   * the schema writes as `user` because nobody wants the Sideboard disappearing — and it draws
   * until the reader deletes it. There is no hide flag and none is wanted; delete is the
   * removal, and {@link DeckCategory.isActive} still means "counts toward nothing" rather than
   * "goes away".
   *
   * Rows that predate v15 were backfilled by a one-time name guess, which is the one place this
   * field is not evidence: both ways of being wrong are mild and self-correcting.
   */
  origin: CategoryOrigin;
  /**
   * **`categoryActive` is the whole of what `maybe` used to mean.** A card in an inactive
   * category counts toward no deck size, no copy limit and no legality check, and it is handed
   * nothing out of the pool its list draws on — so its {@link DeckCard.ownedQuantity} is always
   * `0`, **on both lists**. That survived 2026-09-09 (issue #435) untouched: a theory row reads
   * a real owned count now, but a switched-off pile reads `0` in either variant, because
   * `attribute_owned` checks `category_active` before the row is allowed to draw on anything.
   * The Maybeboard is simply the one predefined category seeded inactive; a user category
   * switched off behaves identically, and nothing in the engine or the stats needs to know
   * which is which.
   *
   * Settable on **every** category, `commander` included: deactivating that one is a legal
   * (if unwise) thing to do, and the validation engine reports a missing commander, which is
   * the honest cost. The only kind-based refusal in the backend is against *renaming* and
   * *deleting* a predefined category, and it never reaches this field.
   */
  isActive: boolean;
  sortOrder: number;
  /**
   * Copies filed here **in the variant that was asked for** — `sum(quantity)`, not a row count.
   * Two printings at 2 and 3 copies read 5.
   *
   * A pile holds cards of its own {@link DeckCategory.variant} only (issue #561), so this is
   * every copy it holds — the number a list row draws **and** the number a delete confirmation
   * quotes. Until v53 those were two numbers, because a pile was shared between the lists.
   */
  cardCount: number;
  /** Nonfoil unit price × copies over the same variant, at the marketplace the read named;
   *  `null` when nothing here has a price there. A partial sum rather than nothing, and two
   *  marketplaces' totals over one pile are legitimately not a conversion of each other — each
   *  omits the copies *it* cannot price. */
  totalPrice: number | null;
}

/**
 * A label's stored colour: `#rrggbb`, the colour itself.
 *
 * **It was a palette token — `gold`, `ember`, … — until 2026-08-20**, and rows written before
 * then still hold one. `features/decks/labelColors.ts` owns both ends of that: what the picker
 * writes, and the six retired words it still reads. Nothing here changed shape, because nothing
 * here ever described one.
 *
 * **Deliberately `string` and not a union**, which is the one place this file declines to
 * narrow a Rust `String`. `deck_labels.color` carries no CHECK — the backend validates only
 * that it is non-empty, because picking what a colour *is* belongs to the webview
 * (CLAUDE.md's Rust/TS boundary). A union here would make a colour written by a newer build a
 * **type error at the read**, when the behaviour that was actually designed is a fallback:
 * `labelColorCss` answers the default for any string it cannot read, so an unknown colour is a
 * visible dot rather than a crash. The alias exists to say all of that at every field that
 * holds one.
 */
export type LabelColor = string;

/**
 * One label **in use in one list of one deck** — a mark a card can carry, at most one per card.
 *
 * The "at most one" is the `deck_cards.label_id` column itself and nothing else — there is no
 * join table and no constraint to relax if that ever changes.
 *
 * **It carried a `deckId` until schema v21 and no longer can**, because there is no such fact:
 * a label is one app-wide row ({@link GlobalLabel}) and what a deck has is not a list of labels
 * but a list of cards, some of which wear one. So this row is a label *and* a fact about the
 * deck and variant it was read by — which is why `deckLabelList` cannot answer a label nothing
 * is wearing, and why `deckLabelAll` exists.
 */
export interface DeckLabel {
  id: number;
  name: string;
  color: LabelColor;
  /** Copies carrying it, `sum(quantity)` like {@link DeckCategory.cardCount}, and scoped to
   *  the same deck **and variant** the read asked by. Never zero: a zero would mean the row is
   *  not in this list at all, and then it is not in the answer. */
  cardCount: number;
}

/**
 * One label as a thing in itself — every label there is, worn or not.
 *
 * **The whole list is app-wide, and that is the feature rather than a convenience.** A label
 * was per-deck until schema v21: `Cut candidate` in four decks was four rows, four colours and
 * four things to rename. It is one row now, so recolouring it recolours it everywhere, and a
 * name a label already holds cannot be taken by a second one — compared with
 * {@link labelNameKey}'s normalisation, not by the word.
 *
 * This replaced `TagSuggestion`, which had a name and a colour and no id, because picking one
 * *copied* it into the deck you were in. Picking one now **uses** that very label. That name is
 * left spelled as it was: the type was deleted at schema v21 and never carried the newer word,
 * so `TagSuggestion` is what a reader digging for it in the history will actually find.
 */
export interface GlobalLabel {
  id: number;
  name: string;
  color: LabelColor;
  /** Copies wearing it anywhere — every deck, both variants. `0` for a label nothing wears,
   *  which is a row this list can answer and {@link DeckLabel} never can. */
  cardCount: number;
  /** Decks with at least one card wearing it — what a delete confirmation quotes, because the
   *  reach of that press is the app's and not the open deck's. */
  deckCount: number;
}

/**
 * One folder of the deck gallery's filing tree.
 *
 * **Flat rows; the tree is the reader's to build from `parentId`** — `deck_folders` has no
 * notion of depth and `deck_folder_list` takes no deck id, because a folder belongs to no
 * deck: it files them, the way a directory files files.
 *
 * Two cascades worth knowing before drawing a delete confirmation, and they point opposite
 * ways. `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so deleting a folder
 * takes its sub-folders with it. `decks.folder_id` is `ON DELETE SET NULL`, so the decks
 * inside surface at the root, filed nowhere, otherwise untouched. A confirmation that said
 * "and everything in it" would be wrong about the half that matters.
 */
export interface DeckFolder {
  id: number;
  /** The folder this one sits inside, or `null` for the root of the tree. */
  parentId: number | null;
  name: string;
  sortOrder: number;
}

/**
 * Which pile a card is being filed into — `collection_alloc::Pile`, and the same choice
 * `deckAddCard` spells as a `categoryId`/`categoryName` pair.
 *
 * **One of the two, and the type is what says so.** An id is a drop onto a column the reader
 * pointed at; a name is the add path's "file it where this card belongs", found-or-created by
 * the backend through `category_for_name` — which is the only write that marks an invented pile
 * `origin: "auto"`, so it arrives with its first card and goes with its last. `deckAddCard` lets
 * an id win when both arrive, because a drag genuinely carries both; nothing sends both here, so
 * the command refuses that pair in words and this union makes it a type error before it can be
 * sent. The `?: undefined` halves are what stop `{ id, name }` satisfying either member — a bare
 * `{ id: number } | { name: string }` accepts an object carrying both, because excess-property
 * checking against a union allows any property some member declares.
 */
export type DeckPile = { id: number; name?: undefined } | { name: string; id?: undefined };

/**
 * What a move across the deck boundary did — `collection_alloc::MoveOutcome`.
 *
 * The two writes it answers are the **only** pair in the crate that moves a collection row into
 * or out of a deck's group, which is what makes "this deck holds this card" a fact about where
 * the row sits rather than a sum somebody has to remember to compute. Everything a caller has to
 * do afterwards is here, and none of it is guessable from the arguments that went in.
 */
export interface MoveOutcome {
  /**
   * The collection row the copies ended up in — **the destination's id, which is not the id the
   * caller handed in whenever the write merged**, exactly like {@link EntryChange.id} off a
   * refile. A caller holding the old id after a fold is holding a row that has been deleted.
   *
   * `null` when nothing moved, and that is an answer rather than a failure: a deck card nobody
   * owned just goes away. A card added from search is an intention to buy — the reader never
   * had it, so nothing lands on their desk when it is cut, and the group **is** the record of
   * which is which.
   */
  entryId: number | null;
  /**
   * Set when the copies came out of **another deck**, so the UI can say which one it took them
   * from after the fact as well as before it. Never set by {@link ipc.deckToCollection}, where
   * the deck they came out of is the one the reader is looking at.
   */
  fromDeck: string | null;
  /**
   * The `deck_cards` row {@link ipc.collectionToDeck} wrote — the only thing a caller has to
   * point at once the copies have landed.
   *
   * An owned add lands a row the editor has never seen, and the id is not derivable from the
   * arguments either: the write folds into whatever pile already held the printing, so a second
   * add of the same card into the same category answers the **first** row's id. Without it the
   * landed glow has no subject and a press that worked reads as one that did nothing.
   *
   * **`null` from {@link ipc.deckToCollection}**, where the caller handed the id in and still
   * holds it — and where a whole cut has deleted the row it named.
   */
  deckCardId: number | null;
  /**
   * How many copies actually **moved**, which is not always what was asked. Never more; less
   * wherever the deck list wanted more than the group held — a list and a group can disagree,
   * because an import writes a list without moving a single card.
   *
   * So this is the number a message quotes, never the argument that was sent.
   */
  quantity: number;
}

/**
 * One printing the live list is short of, and every copy on the reader's desk that could fill
 * it — `deck_pull::PullRow`, the read half of {@link ipc.deckPullPlan}.
 *
 * **The shortfall is folded to the printing, never to the pile.** The same card short in two
 * categories is one row here for the sum, because what a reader is short of is *cardboard* and
 * custody is a fact about the deck rather than about a column — {@link categories} names the
 * piles for them to read and is never a term in the arithmetic. That is
 * `deck_missing_to_wishlist`'s fold, one grain narrower.
 *
 * **A row with no candidate is left out entirely**, so {@link candidates} is never empty and a
 * plan of zero rows means "nothing here can be filled". That is the ordinary answer rather than
 * an error: the issue this feature came from says in as many words that not every card in a deck
 * will have a collection option.
 */
export interface DeckPullRow {
  /** The printing the deck lists. Every candidate matches it exactly — see {@link finish}. */
  cardId: string;
  /** The deck row's stored name, which is the one name an orphan still has. */
  name: string;
  setCode: string;
  collectorNumber: string;
  /**
   * The finish the folded deck rows **play**, where `null` is nonfoil — `deck::normalise_finish`'s
   * spelling, so this reads as {@link DeckCard.finish} does.
   *
   * **Played, not stored**: a row's stored finish, else the printing's sole finish — `playedFinish`
   * on this side. The two differ only for a printing sold in one non-regular finish, where an
   * unsaid row can be no other object: an unsaid row of a foil-only printing is a `"foil"` row
   * here, and one held once unsaid and once as `"foil"` is **one** row. So a {@link DeckCard} is
   * matched to a row by `pullPlan.ts`' `deckCardPullKey` and never by its stored finish, which
   * would look for `null` and find nothing.
   *
   * **Candidates match it exactly, and that is the deliberate narrowing this feature took**
   * (2026-09-03). A deck's owned count is attributed at the *oracle* grain — a LEA Bolt filed in
   * the group makes an M10 line read as owned — so matching on the printing and the finish fills
   * strictly fewer holes than the app itself would count. The trade is that nothing is ever
   * pulled that is not the exact piece of cardboard the list names, and the dialog says so.
   */
  finish: DeckFinish;
  /** Copies of this printing and finish the live list still wants, over its **active** piles. */
  short: number;
  /** The piles that are short, in the deck's own order. For the reader; never for the write. */
  categories: string[];
  /** Every copy that could fill it, best first — see {@link DeckPullCandidate}. Never empty. */
  candidates: DeckPullCandidate[];
}

/**
 * One collection row that could fill a hole — `deck_pull::PullCandidate`.
 *
 * **Nothing filed in a deck's group is ever a candidate**, which is the issue's "only pull cards
 * that are not already in another deck folder" and is `collection::Allocation::Unallocated`'s
 * rule verbatim rather than a second spelling of it: the root, a folder the reader made and
 * `Recently removed` are all cards on their desk. This deck's own group is excluded by the same
 * clause, and has to be — those copies are already counted in {@link DeckCard.ownedQuantity},
 * so offering them would be offering to fill a hole with the thing already in it.
 *
 * **The order is the pre-pick, and it is chosen rather than incidental**: the root first, then
 * `Recently removed`, then the reader's own folders in their `sortOrder`, and oldest row first
 * inside each. It ranks by how little of the reader's filing a pull disturbs — the root is a
 * decision nobody has made and the holding area is the app's own transient bin, where a named
 * binder is a decision somebody made on purpose. The tiebreak is `take_copies`' own rule.
 */
export interface DeckPullCandidate {
  /** The `collection_entries` row. What a {@link DeckPullPick} points at. */
  entryId: number;
  /** Copies this row holds, whole. A pick may take fewer, never more. */
  quantity: number;
  /** Where it sits, or `null` at the root. */
  folderId: number | null;
  /** What to call that place, or `null` at the root — which the UI words, not the backend. */
  folderName: string | null;
  /** `"user"` or `"removed"`; `null` at the root. Never `"deck"` — see this type's own doc. */
  folderKind: string | null;
  /** The copy's own facts, which are what tell two candidates of one printing apart. */
  condition: string;
  lang: string;
  altered: boolean;
  signed: boolean;
  proxy: boolean;
  misprint: boolean;
  grading: string | null;
  serialNumber: string | null;
}

/** Copies to take out of one collection row — `deck_pull::Pick`, the write's whole input. */
export interface DeckPullPick {
  entryId: number;
  /** At least one, and never more than the row holds or the deck is short of. */
  quantity: number;
}

/** What a pull moved — `deck_pull::PullOutcome`. */
export interface DeckPullOutcome {
  /** Copies that changed folder. */
  copies: number;
  /**
   * Rows of the plan that got at least one copy — so **printings *and* finishes**, at
   * {@link DeckPullRow}'s own grain, and not distinct printings.
   *
   * The distinction is only ever visible for a deck short of one printing in two finishes, which
   * is two rows in the dialog and counts two here. It is spelled out because the three places
   * that count this have to agree: the crate's own `wanted.len()`, the Storybook fake's handler,
   * and `pullPlan.ts`'s `cards` — which is what the dialog's footer previews *before* the press.
   * A grain mismatch between the preview and this outcome would show up only on that one deck,
   * as a sentence quoting a number the reader had just been shown a different version of.
   */
  cards: number;
}

/**
 * One card the live list is short of, and where else the reader owns it — `deck_pull::ElsewhereRow`,
 * what {@link ipc.deckOwnedElsewhere} answers a row of (issue #986).
 *
 * **The grain is the oracle card, one coarser than {@link DeckPullRow}'s**: this is "do I own the
 * card at all, and where?", so every printing and finish counts. A card owned nowhere else is
 * left out, so a missing key is the whole of "you own none".
 */
export interface DeckOwnedElsewhere {
  oracleId: string;
  /** Root first, then the reader's folders, then other decks, then `Recently removed`. Never
   *  empty, and never this deck's own group — what sits there is already in the figure. */
  places: DeckElsewherePlace[];
}

/** One place holding copies of a card — `deck_pull::ElsewherePlace`. */
export interface DeckElsewherePlace {
  /** The folder, or `null` at the root. */
  folderId: number | null;
  /** The folder's name — a deck's group is named by its deck — or `null` at the root, which the
   *  UI words. */
  name: string | null;
  /** `"user"`, `"deck"` or `"removed"`; `null` at the root. */
  kind: string | null;
  /** Copies held there, every printing and finish of the card together. */
  quantity: number;
}

/**
 * One wishlist line a quick add could take copies off — `deck_quick_add::QuickAddWish`, the whole
 * of what {@link ipc.deckQuickAddWishes} answers.
 *
 * **Two reads answer this shape, and they match differently.** {@link ipc.deckQuickAddWishes}
 * (`deck_quick_add::card_wishes`, issue #511) answers **every** wish for the card — another
 * printing, another finish, or any printing at all — because the per-card press always opens a
 * picker and the reader chooses which line the copies came off. {@link DeckMissingRow.wishes}
 * (`deck_quick_add::wishes`) is the narrow read — the exact printing, and a finish the copies
 * satisfy — because the deck-wide batch clears a lone match *without* asking.
 *
 * **The order is the pre-pick.** The wide read puts the pressed printing first and a satisfied
 * finish second; both then rank the root first, the reader's own folders in their `sortOrder`,
 * and the oldest row inside a tie. A dialog opens on the head of the list.
 */
export interface DeckQuickAddWish {
  /** `wishlist_entries.id` — what {@link ipc.deckQuickAddToCollection}'s `wishId` points at. */
  id: number;
  /** Copies the wish asks for, whole. A press takes at most this many and deletes the row when
   *  it takes them all. */
  quantity: number;
  /** Where it sits, or `null` at the root. */
  folderId: number | null;
  /** What to call that place, or `null` at the root — which the UI words, not the backend. */
  folderName: string | null;
  /** The printing the wish names, or `null` for a wish that takes any printing of the card. */
  cardId: string | null;
  /** The wish's stored name — the one name every wish has. */
  name: string;
  /** The printing's set code and collector number as the wish stored them, `null` on an
   *  any-printing wish. */
  setCode: string | null;
  collectorNumber: string | null;
  /** The finish the wish asks for in the **wishlist's** spelling, or `null` for any finish. */
  preferredFinish: "nonfoil" | "foil" | "etched" | null;
}

/**
 * What a quick add recorded — `deck_quick_add::QuickAddOutcome`.
 *
 * **What was written, never the argument that was sent**, which is {@link MoveOutcome}'s rule: a
 * sentence quotes this. The two numbers are separate halves of one press and either can be zero
 * without the other being wrong.
 */
export interface DeckQuickAddOutcome {
  /** Copies recorded into the deck's own group. */
  copies: number;
  /**
   * The `collection_entries` row they landed in, **after the grain fold** — so a second press on
   * one line raises the row already in the group rather than making a second one, and both
   * presses answer the same id.
   */
  entryId: number;
  /** Copies taken off the wish, and `0` when the press named none. Never more than the wish
   *  held. */
  wishCopies: number;
}

/**
 * One printing the live list is short of, and every wishlist line those copies could take down —
 * `deck_missing::MissingRow`, the read half of {@link ipc.deckMissingPlan}.
 *
 * **The third answer to a shortfall, and the only one that _creates_ cardboard.**
 * {@link ipc.deckPullFromCollection} moves copies the reader already owns and
 * {@link ipc.deckMissingToWishlist} writes a shopping list; this one records copies they have
 * just bought, so the `collection_entries` row behind it was never there.
 *
 * **The fold is {@link DeckPullRow}'s, term for term** — `(cardId, finish)`, the deck's own read
 * order, inactive piles skipped, {@link categories} naming the piles for the reader and never a
 * term in the arithmetic. Both rows come off one walk in the crate (`deck::live_shortfall`), so
 * the two dialogs cannot come to disagree about what a deck is short of.
 *
 * **An orphaned printing is not in the plan at all, so this type has no "unrecordable" state.** A
 * `cardId` with no `cards` row is exactly what the write must refuse — the backend reads the set,
 * the collector number and the language off that row to file a copy — and a row the dialog could
 * only draw as an apology is left out instead. That is {@link DeckPullRow}'s empty-candidates
 * rule applied to a different reason for the same emptiness, and it is why an empty array is an
 * ordinary answer here rather than an error: a deck whose whole shortfall is printings the corpus
 * has dropped has nothing to record, which the dialog says in words.
 */
export interface DeckMissingRow {
  /** The printing the deck lists, and half of what a {@link DeckMissingPick} names. */
  cardId: string;
  /** The deck row's stored name, which is the one name an orphan still has. */
  name: string;
  setCode: string;
  collectorNumber: string;
  /**
   * The finish the folded deck rows **play**, where `null` is nonfoil — `deck::normalise_finish`'s
   * spelling, so this reads as {@link DeckCard.finish} does. The word the copies are filed under
   * is the collection's own `nonfoil`, and the backend does that translation.
   *
   * **Played, not stored** — {@link DeckPullRow.finish}'s rule, off the same walk: a row's stored
   * finish, else the printing's sole finish. An unsaid row of a foil-only printing is a `"foil"`
   * row here, and the same printing held once unsaid and once as `"foil"` is one row, so a
   * {@link DeckCard} is matched to it by `pullPlan.ts`' `deckCardPullKey`.
   *
   * **It is the other half of the address, and that is the one structural difference from the
   * pull**: a {@link DeckPullPick} points at a `collection_entries` row that exists, where a
   * {@link DeckMissingPick} can only name the cardboard, because the row does not exist yet.
   */
  finish: DeckFinish;
  /** Copies of this printing and finish the live list still wants, over its **active** piles. */
  short: number;
  /** The piles that are short, in the deck's own order. For the reader; never for the write. */
  categories: string[];
  /**
   * Every wishlist line these copies could take down, best first —
   * {@link ipc.deckQuickAddWishes}' answer for this printing and finish, verbatim, so the
   * per-card menu and this dialog cannot come to disagree about what fills a wish. See
   * {@link DeckQuickAddWish} for the predicate, which is deliberately narrower than what a reader
   * might call a match. Empty is the ordinary answer: most cards a reader records are on no
   * shopping list.
   *
   * **Only a row with exactly one entry has its wish cleared.** A deck-wide press over thirty
   * rows cannot ask thirty questions, so the write re-reads this same predicate inside its own
   * transaction and acts only on an unambiguous answer — none, or two or more, is left standing.
   * That is why no wish id travels on {@link DeckMissingPick}: there is nothing for the reader to
   * pick between. The dialog states which of the three shapes a row is *before* the press, so
   * what did not happen is read rather than discovered.
   */
  wishes: DeckQuickAddWish[];
}

/**
 * Copies of one printing to record — `deck_missing::MissingPick`, the write's whole input.
 *
 * **Addressed by `(cardId, finish)` and never by an entry id**, which follows from what the press
 * is for: the row it creates has no id to name yet. That is the whole structural difference from
 * {@link DeckPullPick}, and it means both fields are load-bearing — neither can be inferred from
 * the other side of the wire.
 *
 * Duplicate picks for one address are summed by the backend and *then* checked against a re-plan,
 * so two picks of 3 against a shortfall of 4 are one refusal rather than two accepted writes.
 */
export interface DeckMissingPick {
  cardId: string;
  /**
   * The finish the deck row **plays**, `null` for nonfoil — {@link DeckMissingRow.finish}'s
   * spelling and its reading, so a pick names the address the plan row it answers carries.
   *
   * **A `null` on a printing sold in one non-regular finish is resolved by the backend to that
   * finish**, so `null` and `"foil"` on a foil-only printing are one pick either way. The frontend
   * sends the played finish anyway (`pullPlan.ts`' `deckCardPlanFinish`), so the pick says what
   * the plan says rather than relying on the other side to translate it.
   */
  finish: DeckFinish;
  /** At least one, and never more than the deck is still short of at that address. */
  quantity: number;
}

/**
 * What a batch recorded — `deck_missing::MissingOutcome`.
 *
 * **What was written, never the argument that was sent**, which is {@link MoveOutcome}'s rule and
 * {@link DeckQuickAddOutcome}'s: a sentence quotes this. All three numbers can be read on their
 * own and any of them can be zero without the others being wrong.
 */
export interface DeckMissingOutcome {
  /** Copies filed into the deck's own group. */
  copies: number;
  /**
   * Rows of the plan that got at least one copy — so **printings *and* finishes**, at
   * {@link DeckMissingRow}'s own grain, and not distinct printings.
   *
   * Spelled out for {@link DeckPullOutcome.cards}' reason exactly, because three places count it
   * and they have to agree: the crate's own `wanted.len()`, the Storybook fake's handler, and
   * `addMissingPlan.ts`'s `cards` — which is what the dialog's footer previews *before* the
   * press. The distinction is only ever visible on a deck short of one printing in two finishes,
   * which is two rows in the dialog and counts two here, so a grain mismatch would surface on
   * that one deck as a sentence quoting a number the reader had just been shown another version
   * of.
   */
  cards: number;
  /**
   * Copies taken off wishes, not a count of wish rows — {@link DeckQuickAddOutcome.wishCopies}'
   * unit. `0` when the press was made with the wishlist half switched off, and `0` for every row
   * whose match was ambiguous or absent, which is the design rather than a failure.
   */
  wishCopies: number;
}

/**
 * One card the plan asks for — {@link ipc.deckTheorySlots}' row, and the whole input to the deck
 * editor's theory tick.
 *
 * The hand-written mirror of `deck_theory::TheorySlot`. **Three fields since 2026-09-07, and the
 * third is the name** — the mark grew a second tier and the loose one needs an identity that
 * survives a different printing. What is still not here is every column the mark would have to be
 * told to ignore: the set, the price, the pile.
 *
 * **This interface was declared twice in this file until 2026-09-07**, identically, and nothing
 * went red: TypeScript *merges* two interfaces of one name rather than refusing them, so the
 * duplicate cost the build nothing and the doc comment above it — which described
 * {@link TheoryDiffRow}, not this — had drifted onto the wrong type. That is the hazard rather
 * than the merge: a field added to one declaration lands on the merged type either way, so the
 * comment a reader lands on need not be the one carrying the field, and the only thing merging
 * refuses is the same member spelled with two different types.
 */
export interface TheorySlot {
  /** `deck_theory.rs`'s own `group_key` — `` `${cardId}|${finish ?? ""}` ``, where the finish is
   *  the one the row **plays** (its own, else the printing's sole finish — issue #563).
   *  `features/decks/theoryMatch.ts` spells the same string for a **live** row and looks it up. */
  key: string;
  /**
   * The card's printed name, exactly as `cards.name` holds it — `null` for an orphan whose
   * printing has left the corpus and which therefore cannot be matched by name at all.
   *
   * **The second grain, and the loose tier's whole input.** {@link TheorySlot.key} above answers
   * *is this the printing I planned*; this answers *is this the card I planned*, which is the
   * question a reader holding a different Forest is asking. A name rather than an `oracleId`
   * because Scryfall omits that field on reversible cards — and an identity with a fallback
   * chain is two rules for the two sides of a comparison to disagree about.
   *
   * **Unfolded, and that is deliberate.** SQLite's `lower()` is ASCII-only and this side's
   * `toLowerCase()` is not, so a name folded in SQL and a live row folded in JS would spell two
   * keys for `Lim-Dûl's Vault` and the mark would go dark on exactly the cards whose absence is
   * hardest to notice. `theoryNameKey` in `features/decks/theoryMatch.ts` folds both sides, in
   * one language, and is the only place the rule is written.
   *
   * **`string | null` and never `string`**: an orphan is a real row of a real plan, so a mirror
   * that promised a name here would put `.toLowerCase()` on `undefined` in the one case the
   * feature exists to survive.
   */
  nameKey: string | null;
  /** How many copies the plan asks for, summed across every active pile it filed them in. */
  quantity: number;
}

/**
 * One card the **theory** list wants more of than the live list has — a line of the plan's
 * shopping list.
 *
 * **One direction only**, and that is the design rather than an omission: what live has and
 * theory dropped is a cut the reader already made, and it needs no row. Inactive categories
 * are excluded from *both* sides, so a card parked in either Maybeboard is neither wanted nor
 * owned for this purpose.
 *
 * The comparison is on the **exact card — `(cardId, finish)`**, and it was the oracle card
 * until 2026-08-20. A plan that names the foil retro-frame Sol Ring is a plan for that piece of
 * cardboard: neither a different printing of it nor the regular copy in the live list answers
 * it, and the two objects are separate lines here, priced apart. An orphan needs no special case
 * under that rule — its `cardId` is its identity like everything else's.
 *
 * **Which pile a card is in is not compared at all.** Placement is not possession, so a card the
 * two lists file differently is no difference, and each side is summed across its categories
 * before they are subtracted — the row is captioned by the category the editor lists first
 * purely so the shopping list reads.
 *
 * **So neither `cardId` nor `finish` is unique on its own**: a list is keyed by the pair.
 */
export interface TheoryDiffRow {
  /** The printing **the theory row names**, which is the printing the reader would be buying.
   *  When the same card is filed in two theory categories this is the first row's category.
   *  **Not unique across the list** — pair it with {@link TheoryDiffRow.finish} to key a
   *  render. */
  cardId: string;
  name: string;
  /** The category the theory row is filed under — the pile this card is wanted *for*, which is
   *  what makes a shopping list readable ("2 more Ramp, 1 more Removal"). */
  categoryName: string;
  /** How many more copies theory wants than live has. **Always positive**: a card live has as
   *  many of is not on this list, and one it has more of is a cut rather than a purchase. */
  quantity: number;
  /** What one copy of this printing costs at the marketplace the read named —
   *  {@link DeckCard.unitPrice}'s rule, so a foil-only printing is quoted at its foil rate
   *  rather than reading as unpriced. Never `cards.price_usd`, the same chain precomputed for
   *  the search's sort, which nothing here sums. */
  unitPrice: number | null;
  setCode: string;
  collectorNumber: string;
  /**
   * Which **object** this line is for — the finish the theory row **plays**, so `null` is the
   * regular copy. That is `deck_cards.finish` where the row stored one and the printing's sole
   * finish where it did not: an unsaid row of a foil-only printing reads `foil` here, because it
   * can be no other object (issue #563, `deck_theory::played_finish`).
   *
   * **Half of the row's identity**, with {@link TheoryDiffRow.cardId}: a foil Sol Ring and a
   * regular one are two pieces of cardboard to go and find, two rows in `deck_cards`, and two
   * different prices — {@link TheoryDiffRow.unitPrice} is already quoted per finish, so folding
   * them would be one line charged at whichever of the two came first.
   */
  finish: DeckFinish;
  /**
   * Copies of **this printing, in this finish**, the collection holds that **no built deck has
   * claimed** — the number that turns "I need two more of these" into "and one is in the box
   * already". It answers on the row's whole identity because the comparison above does, which is
   * also what keeps the strip's plain sum of this field honest: any wider answer counts one
   * binder copy once per row that could have used it.
   *
   * **A display field, and never a term in an arithmetic.** It is deliberately not netted out
   * of {@link TheoryDiffRow.quantity}, least of all by `deckTheoryMissingToWishlist`:
   * `quantity` has already subtracted the live list and this number has not, so an unbuilt
   * deck's own live copies read as spare here — right for a person, wrong for a subtraction.
   *
   * **It did _not_ follow {@link DeckCard.ownedQuantity} across on 2026-09-09** (issue #435),
   * and the reason is that same subtraction. A theory *row* now counts every copy the deck
   * could use, this deck's own group included, because nothing has been subtracted from it;
   * `quantity` here is already `wanted − held`, so folding the group into this field would
   * count the copies the live list is holding **twice** — once as gone from the shortfall and
   * once as spare beside it. Two questions, two pools, and the shopping list keeps the narrower
   * one on purpose.
   */
  ownedSpare: number;
  /**
   * How many of this row's {@link TheoryDiffRow.quantity} the **live list already plays as a
   * different printing or finish of the same card** — the copies that are an upgrade rather
   * than a hole.
   *
   * The diff compares the exact card, so a plan naming one Sol Ring against a deck sleeving
   * another is a full row here and reads as a card the reader has not got. For buying, that is
   * right — they would still have to find it. For *playing*, it is not: the deck runs. This
   * field is the difference between the two readings, and it is what the dialog's
   * `Missing` / `Different printing` filter is computed from.
   *
   * **Never greater than {@link TheoryDiffRow.quantity}, and 0 for an orphan.** Copies are
   * claimed per oracle card, in the list's own reading order, out of a pool the backend sizes
   * as *live copies of that card minus the ones an exact line already matched* — so one live
   * Bolt cannot excuse two rows, and a row whose printing has left the card database has no
   * oracle card to be matched by.
   *
   * A row can be **partly both**: theory 2× art A against live 1× art B is `quantity: 2`,
   * `heldAsOtherPrinting: 1` — one copy to find, one already on the table. Such a row shows
   * under both filters at its full quantity, because the full quantity is what a press writes.
   */
  heldAsOtherPrinting: number;
  /**
   * **A token the plan holds more of than the deck** rather than a card (managed tokens spec
   * §3.7) — a `(card_id, finish)` of a token entry, the plan's entries (implicit rows included)
   * less the deck's, at the card rows' own grain and by their own subtraction. Such a row is filed
   * under **Tokens & Emblems**, `ownedSpare` counts that printing's loose copies, and
   * `heldAsOtherPrinting` the deck's other printings of the same token.
   *
   * What Compare's views filter on: **Tokens** is these rows alone, **All** is every row, and
   * **Missing** and **Different printing** are card rows only. A send to the wishlist files such a
   * row as a wish pinned to its printing, its finish the preferred one.
   *
   * Required rather than optional, because an absent flag reads `undefined` — falsy — and would
   * file every token row as a card row with nothing red anywhere; `ipc.test.ts` names it on both
   * sides.
   */
  isToken: boolean;
}

/**
 * What one `deck_audit` row says happened — `schema::AUDIT_KINDS`, narrowed.
 *
 * A `String` on the Rust struct and a CHECK constraint in SQL, a union here: the database
 * is the enforcement and this is the mirror, which is the same arrangement
 * {@link CategoryKind} and {@link DeckVariant} are in.
 *
 * The nine split three ways, and the split is why {@link DeckAuditEntry.cardId} is nullable:
 * `add`/`remove`/`quantity`/`move`/`swap` are about **one card**; `category` and `folder` are
 * about a pile or a filing cabinet; `deck` is about the deck itself.
 *
 * **`label` is on both sides of that line**, which is the trap: one kind covers a card wearing
 * a label (`cardId` set) *and* the label itself being created, renamed or deleted (`cardId`
 * `null`, plus an `action` verb in the payload). They share a kind because they share a
 * subject. A renderer that could not see the verb reports "deleted the Cut candidate label" as
 * "labelled as Cut candidate" — `auditText.ts` switches on `action` first for exactly that
 * reason.
 */
export type DeckAuditKind =
  "add" | "remove" | "quantity" | "move" | "swap" | "label" | "category" | "folder" | "deck";

/**
 * One line of a deck's history — **what happened, not how to say it.**
 *
 * The whole design of this table is in {@link DeckAuditEntry.payload}: Rust records the
 * facts inside the transaction that made the change, and `features/decks/auditText.ts`
 * turns them into the sentence a person reads. A row that stored the sentence would be a
 * history that has to be migrated the day the wording changes, and one that could not be
 * re-rendered in another language or at another length at all.
 *
 * Recorded **inside** the caller's transaction, always: an audit row that committed while
 * the change it describes rolled back is a history that lies.
 */
/**
 * What the deck editor's two reversal buttons would do — each the history row it would put
 * back, or `null` when there is nothing there.
 *
 * The **entry** rather than a sentence, because a sentence is domain logic: `auditText.ts`
 * words it, and the button reads "Undo — Removed 2 × Lightning Bolt" by asking that module the
 * same question every row of the history drawer goes through.
 *
 * **The two halves are not symmetrical, and the asymmetry is the design.** `undo` is a fact
 * about the deck: Rust stamps `deck_undo.undone_at`, so the cursor persists and undo carries on
 * below where it stopped after a restart. `redo` is answered only for an id this webview hands
 * *in* — the reader's position in a session, thrown away with the window.
 */
export interface DeckUndoState {
  undo: DeckAuditEntry | null;
  redo: DeckAuditEntry | null;
}

export interface DeckAuditEntry {
  id: number;
  deckId: number;
  /** Unix **seconds**, like {@link DeckRow.updatedAt} — not milliseconds. `auditText`'s
   *  day grouping multiplies by 1000 exactly once, where the `Date` is built. */
  at: number;
  /**
   * Which of the deck's two lists the change was made to — **for the kinds that are about a
   * list at all.** `deck_audit.variant` is `NOT NULL` with a CHECK over the two, so every row
   * has to carry *something*, and for four kinds that something is filler.
   *
   * It is a fact for `add`/`remove`/`quantity`/`move`/`swap`, for the card-side half of
   * `label`, and for the one `deck` row that records a theory copy (which deliberately says
   * `theory`).
   * It is **filler for the rest**: a category write, a folder filing, a label being created or
   * deleted and every other `deck` field all record the column's DDL default, `live`, because
   * none of them is a fact about one variant's cards. `deck_audit::DECK_LEVEL` is literally
   * `DECK_VARIANTS[0]`.
   *
   * So **do not filter a history by variant** — a Theory reader who did would be shown every
   * category rename and deck setting they had ever changed, and a Live reader would lose half
   * their history to nothing more than a CHECK constraint. {@link DeckAuditEntry.cardId} draws
   * the same line one field down, and for the same reason.
   */
  variant: DeckVariant;
  kind: DeckAuditKind;
  /**
   * The card the change was about, **softly** referenced like every card id in a user table
   * — and `null` for the three kinds that are about no card at all (`category`, `folder`,
   * `deck`), and for the half of `label` that is about the label itself rather than a card
   * wearing it.
   */
  cardId: string | null;
  /** Denormalized at write time, for the reason `deck_cards.name` is: a history line still
   *  names its card the day that printing leaves the card database. */
  cardName: string | null;
  /**
   * **JSON text**, not an object — `payload TEXT NOT NULL CHECK (json_valid(payload))`, so
   * it arrives as a string and is parsed by the one module that reads it.
   *
   * The shape depends entirely on {@link DeckAuditEntry.kind}, and the shapes are written out
   * in `features/decks/auditText.ts`, which is the only place in the app that looks inside
   * this string. It is deliberately schemaless here: adding a fact to one kind is a change to
   * a sentence rather than a migration, which is what a log of "all changes" needs in order to
   * survive being useful. Roughly, by kind:
   *
   * | kind | payload |
   * |---|---|
   * | `add` | `{ category, quantity }` |
   * | `remove` | `{ category, quantity, reason }` |
   * | `quantity` | `{ category, from, to }` |
   * | `move` | `{ from, to }` — category **names**, not ids |
   * | `swap` | `{ category, fromSet, toSet, folded }` |
   * | `label` | `{ label, previous }` on a card; `{ action, label, previous }` on the label |
   * | `category` | `{ action, name, previousName, cards }` |
   * | `folder` | `{ action, folder }` — `folder` is `null` for the root |
   * | `deck` | `{ field, from, to }` — and `{ field: "theory", copied }` from a writer since removed |
   *
   * **Read every field as optional, including the ones that table shows.** Several payloads
   * are narrower than they look — a category `reorder` emits `{ action }` alone, because every
   * pile moved and there is no one pile to name — and the writer is still growing: this build
   * may be older *or* newer than the one that wrote a row, since a database outlives the app.
   * `deck.field` today is `name | format | cover | notes | note | built | theory | description |
   * archived`, and `cover` records the literal `"custom"` for an uploaded image rather than a
   * card id. Parse defensively and be total over unknowns, which is what `auditText.ts` does
   * and why nothing in it throws.
   *
   * **`notes` and `note` are two different words and neither may be folded into the other.**
   * `notes` is the v8 column, written until schema v43 and **still on that list although
   * nothing writes it any more** — audit rows are durable, so every history row from before v43
   * still says it, and dropping the word would demote years of history to a default sentence.
   * `note` is one row of the notes band ({@link DeckNote}), and its payload carries two keys the
   * others do not: an `action` (`create | edit | delete | attach | detach`) and the note's
   * `note` title, plus a `card` name on the two attachment actions and `null` otherwise. The
   * body is never recorded, for the reason the old field's sentence gave: a note is a paragraph
   * nobody wants in a one-line history.
   *
   * Values are recorded **as stored**: a set code inside a `swap` is the lowercase
   * `cards.set_code` it came from, not the capitals a tile draws. Casing is the renderer's.
   */
  payload: string;
  /**
   * Signed **copies**, for the day header's `+7 / −6` roll-up: `+n` on an add, `−n` on a
   * remove, the difference on a quantity change. `0` on everything else.
   *
   * **There used to be a fourth case, and it went with its writer.** A `deck` row of
   * `{ field: "theory", copied }` carried `+copied` here — the theory list's copy-from-live
   * command, which seeded the plan from the actual list and was the one exception to "card kinds
   * move the number, deck kinds do not". It was removed on 2026-09-27 without ever having had a
   * caller in the app, so no shipped database was given such a row; the roll-up sums whatever a
   * row carries and `auditText.ts` still renders the payload, so one would read rather than break.
   *
   * Zero is the common case and means "this changed no card count", never "nothing
   * happened" — a rename, a reorder, a move, a labelling and a printing swap all record `0`.
   */
  delta: number;
}

/**
 * One line of the home page's activity feed — **what happened, not how to say it.**
 *
 * {@link DeckAuditEntry}'s design with a scope instead of a deck, and the sentence is drawn the
 * same way: Rust records the facts inside the transaction that made the change, and
 * `packages/ui/features/home/` turns them into the words a person reads. A row that stored the sentence
 * would be a history to migrate the day the wording changes.
 *
 * **It is two tables read as one, and that is the shape of every field below.** The `collection`
 * and `wishlist` rows come from `activity`; the `deck` rows come from `deck_audit` and are the
 * same rows the deck history drawer draws — so a change that writes a deck audit row writes no
 * `activity` row, and appears here exactly once rather than twice. The consequence worth writing
 * down: **the `id`s collide across the two tables**. Nothing joins on them, and a key on this side
 * is `scope` plus `id`.
 */
export interface ActivityEntry {
  /** Unique **within its own table**, not across the feed — see above. */
  id: number;
  /** Unix **seconds**, like {@link DeckAuditEntry.at} — not milliseconds. The feed is ordered
   *  `at DESC, id DESC`, because `unixepoch()` has one-second resolution and one press can write
   *  two rows inside one second. */
  at: number;
  /**
   * Which cabinet the change was made in — one of `"collection" | "wishlist" | "deck"`.
   *
   * A raw `string` rather than that union, for {@link ipc.getMarketplace}'s reason: **Rust stores
   * strings and TypeScript owns the vocabulary**, so the narrowing lives in `packages/ui/features/home/`
   * beside the renderer that switches on it, and a scope a newer build wrote reaches this side as
   * what it is rather than as a parse error. {@link DeckAuditEntry.payload} makes the same trade
   * one field over.
   */
  scope: string;
  /**
   * What was done — and **the vocabulary depends on the scope, so the two are not one list**. An
   * `activity` row carries one of `add`, `remove`, `quantity`, `move`, `edit`, `folder`, `import`
   * or `clear`; a `deck` row carries `deck_audit`'s own {@link DeckAuditKind}, which shares four
   * of those words and adds five of its own. A renderer that switched on `kind` before `scope`
   * would read a deck's `folder` as a collection's.
   */
  kind: string;
  /** The deck the change was made to — **non-`null` only on a `deck`-scoped row**, which is to
   *  say only on a row that came from `deck_audit`. Every `activity` row carries `null`, because
   *  that table records changes made to no deck at all and the column is a `NULL` literal in the
   *  half of the union that reads it. */
  deckId: number | null;
  /** The printing the change was about, softly referenced like every card id in a user table.
   *  `null` wherever the change was about no one card — a folder rename, an import, a clear. */
  cardId: string | null;
  /** Denormalized at write time, for {@link DeckAuditEntry.cardName}'s reason: a feed line still
   *  names its card the day that printing leaves the card database. */
  cardName: string | null;
  /** **JSON text**, not an object — {@link DeckAuditEntry.payload}'s contract verbatim, including
   *  its instruction to read every field as optional and be total over unknowns. The shape
   *  depends on `scope` and `kind`, and `packages/ui/features/home/` is the only place in the app that
   *  looks inside this string. */
  payload: string;
  /** Signed **copies**, and `0` where the change is not about copies — an edit, a folder rename,
   *  a move. {@link DeckAuditEntry.delta}'s rule: zero means "this changed no card count", never
   *  "nothing happened". */
  delta: number;
}

/**
 * One new deck, as the "New deck" dialog sends it — **the whole deck, in one INSERT**.
 *
 * Rust carries `#[serde(default)]` so both strings are optional on the wire, but they stay
 * required here: a deck with no name is refused in words (`"A deck needs a name."`), and a
 * blank `formatKey` is not an error but a *decision* — it means `casual`, which is
 * `decks.format_key`'s own DDL default. A call site that wants casual should say so.
 *
 * Everything below `formatKey` is a field the "New deck" dialog now offers, and they travel
 * together on purpose: create-then-patch-then-file is three transactions and a half-made deck
 * to unwind by hand when the second one fails — the trap {@link ipc.deckImportCommit} exists to
 * avoid. One call, one row.
 *
 * **And one audit row.** A deck's birth stays the single `{field:"name", from:null, to:name}`
 * however many fields it was born with. {@link ipc.deckUpdate} writes one row per changed field
 * because each of those is an event; being born is one event.
 *
 * **Nothing here follows {@link DeckPatch}'s `coalesce` rule, because this is an INSERT.**
 * There is no previous value to leave alone: an absent field means the column's own default,
 * and for {@link DeckInput.folderId} that difference is the whole meaning of the field.
 */
export interface DeckInput {
  name: string;
  /** A `format_specs.key`. Validated against the table, not by a foreign key — see
   *  {@link FormatSpec}. Blank means `"casual"`. */
  formatKey: string;
  /**
   * Which platform the deck is for, or `"any"` for none in particular.
   *
   * Optional here and `#[serde(default)]` in Rust, so a caller that has not thought about it
   * makes exactly the deck it always made: absent is blank is `"any"`, the column's own DDL
   * default. **The format is not checked against it** — a Modern deck may say Arena, because
   * the game narrows a *picker* and never the deck.
   */
  gameKey?: DeckGame;
  /**
   * The one-line blurb the gallery tile shows — **a caption, and the only prose a create
   * carries**. The "New deck" dialog fills this now that it hosts the whole settings form;
   * before that it sent name and format alone, and a blurb could only arrive afterwards
   * through {@link ipc.deckUpdate}.
   *
   * **It used to be half a pair, and the other half is gone from here.** `decks.notes` was the
   * deck's notebook and this its caption; schema v43 replaced that one column with rows —
   * {@link DeckNote} — and no create can carry one. A note is written *after* the deck exists,
   * one at a time, through {@link ipc.deckNoteCreate}; the deck's birth stays one INSERT.
   */
  description?: string;
  /**
   * Point the new deck's cover at a printing's art crop — **the whole of what a cover is**.
   *
   * `coverKind` is not settable here and does not need to be: it keeps its DDL default,
   * `card_art`, which is the only kind there is. A deck born with this field already draws its
   * cover and needs no follow-up, so a create is one call again — see {@link DeckCoverKind}
   * for what the second call used to be and why it is gone.
   *
   * A soft reference like every card id in a user table: nothing checks the printing is in
   * `cards`, and an orphaned cover heals on the next sync.
   */
  coverCardId?: string;
  /**
   * Which folder to file the new deck in — and **absent is the top level, deliberately**.
   *
   * **{@link DeckPatch.folderId}'s `coalesce` trap does not apply here, and a reader who knows
   * that rule will assume it does.** A patch writes `coalesce(?n, folder_id)`, which reads a
   * bound NULL as "leave it", so no patch can un-file a deck and {@link ipc.deckSetFolder} is
   * the only command that reaches the root. This is an INSERT with nothing to leave: omitting
   * `folderId` writes the root because that is what the caller asked for. Nothing about
   * `deckSetFolder` changes — it is still the way to un-file a deck that already **exists**.
   *
   * Typed `number | undefined` rather than `number | null` for the same reason: there is one
   * way to say the root here, which is to leave it out. A form whose draft holds
   * `number | null` sends `folderId ?? undefined`.
   *
   * Fenced by a real foreign key — `decks.folder_id REFERENCES deck_folders(id)`, enforced
   * because both are user tables — so a folder id that is not there is refused by SQLite
   * rather than checked in Rust.
   */
  folderId?: number;
  /**
   * Whether the new deck keeps a theory list beside its live one.
   *
   * **At create this sets the column and moves nothing**, because a deck being born has no live
   * cards to move. Contrast {@link DeckPatch.theoryEnabled}, where switching it on makes the
   * deck the reader already has into the plan and leaves the live list empty — there is nothing
   * here for that to move, so the two routes differ in what they *do* and agree exactly on what
   * a new deck ends up with.
   *
   * Worth knowing one step further out: the patch acts on the **transition** off → on, so a deck
   * born with theory already on has made that transition at birth and no later patch will ever
   * move anything for it. Its plan fills through the ordinary card writes aimed at the `theory`
   * variant, the same as any other list — there is no command that copies a live list built up
   * afterwards into it. One existed, never had a caller, and was removed on 2026-09-27.
   */
  theoryEnabled?: boolean;
  /**
   * Whether the new deck is one the reader tracks without owning the cardboard. See
   * {@link DeckRow.virtualOnly}, where the kind is argued in full.
   *
   * **At create this sets the column and releases nothing**, for {@link DeckInput.theoryEnabled}'s
   * reason one field up: a deck being born holds no copies, so the transition work the patch
   * does — filing the group's cardboard into `Recently removed` — has nothing to act on. What a
   * create *does* skip is the deck group itself: a virtual deck is born without one, where the
   * patch route has to take an existing one away.
   *
   * Sending it with `theoryEnabled: true` is a caller's bug and not a third kind. Rust writes
   * the two columns so the pair can never both be set; there is no combination to spell here
   * that {@link deckKind} cannot read back.
   */
  virtualOnly?: boolean;
}

/**
 * An edit to one deck. Every field is optional: absent means "leave it"
 * (`coalesce(?n, column)`, {@link EntryPatch}'s rule).
 *
 * **Absent is the only way to say "leave it", so `null` cannot say "clear it".** Every column
 * below is written with `coalesce(?n, column)`, which reads a bound NULL as *unchanged* — so
 * there is no patch that clears a cover, empties a description, or files a deck back at the
 * **root** of the folder tree. The last of those is a thing the app actually needs, which is
 * why {@link ipc.deckSetFolder} is a command of its own: it takes `folderId: number | null`
 * and `null` there means the root. A reader looking for "un-file this deck" wants that
 * command and will not find it here.
 *
 * Un-filing through a patch would need a double-`Option` (absent versus null) across this
 * whole struct — a change to make once and deliberately, not as a side effect of adding a
 * field.
 *
 * **The rule is this struct's, not the deck module's.** {@link DeckInput} carries the same
 * field names and is an INSERT, where an absent `folderId` really does mean the top level —
 * see {@link DeckInput.folderId}, which says so at the field.
 */
/**
 * Which Compare view a deck's managed wishlist follows — `decks.managed_wishlist_mode` (user
 * schema v49), and `managed_wishlist::MODES` in the crate. `other` is the dialog's
 * `Different printing`. The words and their order are `features/decks/managedWishlist.ts`'s.
 *
 * **Four words, and tokens are not one of them since user schema v57** (issue #617). v55 made
 * `tokens` a fifth mode and had All file the plan's tokens too, which tied two questions into one
 * press: *which card copies does this folder want* and *does it want the tokens at all*. A reader
 * who wanted Missing cards and the tokens had no word for it. The token half is its own switch
 * now — {@link DeckRow.managedWishlistTokens} — and fills the `Tokens` subfolder under any of the
 * three views; v57 turned every `tokens` deck into `missing` with that switch on, and every `all`
 * deck kept its tokens by the same switch.
 */
export type ManagedWishlistMode = "off" | "all" | "missing" | "other";

/**
 * How a deck keeps its tokens — `decks.token_mode`, user schema v52, `NOT NULL DEFAULT
 * 'managed'` and closed by a `CHECK` on exactly these three words.
 *
 * `managed` and `collection` draw the Tokens & Emblems pile in the four deck views; `hidden`
 * takes it out of all four (the band stays, so the mode can be changed back). **PR 2's control
 * draws `managed` and `hidden` only** — `collection` is in the `CHECK` from the start so PR 3
 * adds a button and a behaviour and no rung, and a Collection button that behaved exactly like
 * Managed would be a control that lies about what it does.
 */
export type TokenMode = "managed" | "collection" | "hidden";

export interface DeckPatch {
  name?: string;
  formatKey?: string;
  /** Which platform the deck is for. `"any"` is a value like any other and is written like
   *  one — absent still means "leave it", which is why the column is not nullable. Setting it
   *  moves no format, and setting a format moves no game. */
  gameKey?: DeckGame;
  /** The one-line blurb the gallery tile shows — a caption, and since schema v43 the **only**
   *  prose on this patch: the deck's notebook is rows now ({@link DeckNote}) and is written
   *  through the eight note commands rather than through here. Both dialogs write this one: the
   *  "New deck" one through {@link DeckInput.description} at birth, the settings one through
   *  here. */
  description?: string;
  /** Point the cover at a printing's art crop — the one way a cover is set. Sending it also
   *  writes `coverKind` as `card_art`, which is what it already was: see
   *  {@link DeckCoverKind} for why that write is a leftover rather than a branch. */
  coverCardId?: string;
  /** Filed away: sorted last in the gallery, never deleted. This is what a gallery's
   *  "remove" should reach for — `deckDelete` really deletes. */
  archived?: boolean;
  /**
   * Which folder the deck is filed in.
   *
   * **This field can file a deck, and cannot un-file one** — by the rule above, `null` here
   * means "leave it". {@link ipc.deckSetFolder} is the command that reaches the root.
   */
  folderId?: number;
  /**
   * Whether this deck keeps a theory list beside its live one.
   *
   * **Switching it on _moves_ the live list into theory**, in the same transaction: the deck
   * the reader has built becomes the plan, and the live list starts **empty**. A plan is what a
   * deck is being built toward, and the honest starting point for one is the deck as it stands
   * — so the cards go there rather than being duplicated into two lists that then drift apart.
   * The deck's {@link DeckRow.lastVariant} is left at `"theory"` with them, so the editor opens
   * on the list the cards are now in.
   *
   * It used to *copy*, and no longer does; nothing in the backend copies one list into the
   * other now. The explicit copy command that outlived the switch never had a caller and was
   * removed on 2026-09-27.
   *
   * Switching it off **keeps every row** — it hides a switch, it does not delete a list, and
   * nothing in the backend ever deletes a `theory` row except the ordinary card writes the
   * reader makes against it.
   *
   * **Setting it clears {@link DeckPatch.virtualOnly} in the same write**, because the two are
   * one three-way choice wearing two columns — see {@link DeckRow.virtualOnly}.
   */
  theoryEnabled?: boolean;
  /**
   * Whether this deck is one the reader tracks without owning the cardboard. See
   * {@link DeckRow.virtualOnly}, where the kind is argued in full.
   *
   * **Switching it on files the copies the deck's group holds into `Recently removed` and takes
   * the group away**, in the same transaction. Unlike {@link DeckPatch.theoryEnabled} above it
   * moves not one `deck_cards` row — every card stays in the list and the variant it was in,
   * which is the whole reason a reader may press this and press it back. What moves is the
   * *cardboard*: a deck that has stopped counting what it owns must not go on holding copies
   * that are then invisible on the Collection page and unavailable to every other deck.
   *
   * **Switching it off gives the deck its group back, empty.** The copies are not fetched from
   * `Recently removed` — that is the reader's own filing to redo, exactly where
   * `Clear actual list…` leaves it — because nothing recorded which of them came from here.
   *
   * **It clears {@link DeckPatch.theoryEnabled} in the same write**, for the reason above.
   */
  virtualOnly?: boolean;
  /**
   * Whether this deck draws the **green** theory mark — the live row that is the printing the
   * plan named. See {@link DeckRow.theoryMarkExact}, where the whole rule is written.
   *
   * `decks.theory_mark_exact`, schema v38, and a **reading** preference like
   * {@link DeckPatch.separateXGroup} below: switching it writes one column and touches not one
   * `deck_cards` row. Unlike {@link DeckPatch.theoryEnabled} above it moves nothing at all —
   * every card stays in the list it was in, and only what is drawn over them changes.
   *
   * `coalesce(?n, column)` like every other key here, so absent means "leave it" and there is no
   * third state to spell. A `boolean` has nothing to clear, so unlike
   * {@link DeckPatch.folderId} that costs this field nothing.
   */
  theoryMarkExact?: boolean;
  /** Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   *  not name. See {@link DeckRow.theoryMarkName}, and {@link DeckPatch.theoryMarkExact} above
   *  for why the two are separate fields here rather than one three-valued one. */
  theoryMarkName?: boolean;
  /** Whether this deck draws the **red** theory mark — a live row the plan does not ask for at
   *  all. See {@link DeckRow.theoryMarkUnplanned}, and {@link DeckPatch.theoryMarkExact} above
   *  for the rules all three share. `decks.theory_mark_unplanned`, schema v39. */
  theoryMarkUnplanned?: boolean;
  /** Which Compare view this deck's **managed wishlist** follows, or `"off"`. See
   *  {@link DeckRow.managedWishlist}; `decks.managed_wishlist_mode`, schema v49. A word outside the
   *  four is refused by name. */
  managedWishlist?: ManagedWishlistMode;
  /** Whether this deck's managed wishlist also files the plan's **tokens**, in a `Tokens`
   *  subfolder. See {@link DeckRow.managedWishlistTokens}; `decks.managed_wishlist_tokens`,
   *  schema v57. Absent leaves it, as every field here does — and it is written whatever the mode,
   *  so a deck whose mode is `off` can hold it on for the day a view is picked again. */
  managedWishlistTokens?: boolean;
  /**
   * Gather this deck's `{X}` spells under a heading of their own instead of counting each at
   * the mana value Scryfall gives it. See {@link DeckRow.separateXGroup} — a **reading**
   * preference, so switching it writes one column and touches not one `deck_cards` row.
   */
  separateXGroup?: boolean;
  /**
   * Whether the editor's **Tokens & Emblems** area is expanded. See
   * {@link DeckRow.tokensOpen} — a per-deck reading preference, so switching it writes one
   * column and touches not one `deck_cards` row.
   *
   * **It rides this patch and not {@link ipc.deckSetViewState}**, which is the shape
   * `separate_x_group` is in and not the one the three `last*` columns are in, even though this
   * column sits beside all four. The two commands differ in what a write *costs*: this one moves
   * `updated_at` and writes a history line, and that one deliberately does neither. So the choice
   * is worth stating rather than inheriting — a disclosure a reader opens once and leaves open is
   * a handful of audited writes over a deck's life, where the tab, the grouping and the sort are
   * written on every press and would fill the history with how somebody was looking at the page.
   */
  tokensOpen?: boolean;
  /**
   * Whether the editor's **Deck stats** band is expanded. See {@link DeckRow.statsOpen} — a
   * per-deck reading preference, so switching it writes one column and touches not one
   * `deck_cards` row.
   *
   * **It rides this patch and not {@link ipc.deckSetViewState}**, for the argument spelled out on
   * {@link tokensOpen} beside it: the two commands differ in what a write *costs*, and a
   * disclosure a reader opens once and leaves open is a handful of audited writes over a deck's
   * life, where a tab or a sort is written on every press.
   */
  statsOpen?: boolean;
  /**
   * Whether the editor's **Notes** band is expanded. See {@link DeckRow.notesOpen} — a per-deck
   * reading preference, so switching it writes one column and touches neither a `deck_cards`
   * row nor a `deck_notes` one.
   *
   * **It rides this patch and not {@link ipc.deckSetViewState}**, for the argument spelled out
   * on {@link tokensOpen} two fields up, and it is the third disclosure to take that answer.
   *
   * **Opening the band is not reading the notes and writing one is not opening the band.** This
   * boolean says whether the section is unfolded; the notes themselves are rows, written by the
   * eight `deckNote*` commands and never by a patch. A caller that reached for this to save a
   * note is reaching for {@link ipc.deckNoteCreate}.
   */
  notesOpen?: boolean;
  /**
   * Whether the Deck stats band's **Mana curve** splits its bars into creatures and
   * noncreatures. See {@link DeckRow.curveCreatures} — a per-deck reading preference, so the
   * `Creatures` toggle writes one column and touches not one `deck_cards` row.
   *
   * **It rides this patch and not {@link ipc.deckSetViewState}**, for the argument spelled out
   * on {@link tokensOpen}: a toggle a reader sets once and leaves is a handful of writes over a
   * deck's life, where a tab or a sort is written on every press.
   */
  curveCreatures?: boolean;
  /**
   * Whether the editor's **To-do** band is expanded. See {@link DeckRow.todosOpen} — a per-deck
   * reading preference, so switching it writes one column and touches neither a `deck_cards` row
   * nor the checklist itself.
   *
   * **It rides this patch and not {@link ipc.deckSetViewState}**, for the argument spelled out
   * on {@link tokensOpen}, and it takes {@link notesOpen}'s answer one band down.
   *
   * **Opening the band is not writing a list, and writing a list is not opening the band.** The
   * lists are rows of `deck_todo_lists` (user schema v59, which replaced #672's single
   * `decks.todos` column), written by {@link ipc.deckTodoListCreate} and
   * {@link ipc.deckTodoListUpdate} and never by a patch — a caller that reached for this to save a
   * to-do is reaching for those. The home widget's deck heading is the one caller that sends this
   * from outside the editor: it opens a deck with its band expanded, and sends `true` only when
   * {@link DeckTodoListEntry.todosOpen} says it is shut.
   */
  todosOpen?: boolean;
  /**
   * How the deck keeps its tokens. See {@link DeckRow.tokenMode} — `decks.token_mode`, user
   * schema v52, which replaced v47's `token_stack` switch. Writing it touches no `deck_cards`,
   * `deck_tokens` or `deck_token_printings` row, and in PR 2 no collection row either.
   *
   * **It writes a history row and an undo step, which `tokenStack` never did** — Rust records
   * `field: "tokenMode"` with the two words, and `deck_undo::DECK_FIELDS` names the column so
   * Ctrl+Z puts the mode back. A mode is an arrangement the reader chose, the footing
   * {@link tokenRailIndex} below stands on, rather than a disclosure. A word outside
   * {@link TokenMode} is refused in words.
   */
  tokenMode?: TokenMode;
  /**
   * Where the **Tokens & Emblems** pile sits in the rail. See {@link DeckRow.tokenRailIndex} —
   * `decks.token_rail_index`, user schema v51.
   *
   * **`-1` is a value and not an absence**, which is `defaultCategoryId`'s footing and the reason
   * the column is `NOT NULL DEFAULT -1` rather than nullable: this patch reads an absent key as
   * *leave it* (`coalesce(?n, column)`), so a nullable "last" could never be written back once
   * the reader had moved the pile. Moving it to the last slot sends `-1`; the top is `0`.
   *
   * **Like {@link tokenMode} one field up, it writes a history row and an undo step** — Rust
   * records `field: "tokenRail"` when the index moves — because a pile dragged to a new slot is
   * an arrangement the reader made, like a category's `sortOrder`, and Ctrl+Z puts it back.
   */
  tokenRailIndex?: number;
  /**
   * Which of this deck's categories an add that names none lands in. See
   * {@link DeckRow.defaultCategoryId} — `0` is `AUTO_CATEGORY` and is a **value**, not an
   * absence: sending it puts the deck back on "by what the card does".
   *
   * That is the one thing to know about this field against the rest of the patch. Every other
   * key here reads absent as "leave it" (`coalesce(?n, column)`) and has no way to say "clear
   * it" — {@link ipc.deckSetFolder} exists because `folderId` cannot. This column needs no such
   * command, because its cleared state is a number.
   *
   * A non-zero id must name a category **of this deck's live list**; Rust refuses anything else
   * by name, a theory pile included, since no foreign key says so.
   */
  defaultCategoryId?: number;
  /**
   * Which bracket the reader says this deck is — `1`–`5`, or {@link AUTO_BRACKET} (`0`) to hand
   * the question back to the estimate. See {@link DeckRow.bracket}.
   *
   * **`0` is a value here, not an absence**, exactly as `defaultCategoryId`'s is one field up:
   * absent means "leave it" (`coalesce(?n, column)`, this struct's rule), so sending `0` is the
   * only way to say "back to Auto" — and, like that field, this one needs no
   * {@link ipc.deckSetFolder}-shaped escape command, because its cleared state is a number.
   *
   * Rust refuses anything outside `0..=5` **by name** rather than clamping it. A `6` is a
   * caller's bug or a hand-written IPC call, and quietly storing `5` for it would put a bracket
   * on the deck header that nobody chose.
   */
  bracket?: number;
  /**
   * The deck's whole tag list, in the reader's order — see {@link DeckRow.tags}; `decks.tags`,
   * user schema v62 (issue #834).
   *
   * **The list replaces, it does not merge**, and that is what lets this key clear the column
   * where most keys on this patch cannot: absent still means "leave it", and `[]` is a value —
   * "no tags" — where a `null` would be read as unchanged.
   *
   * Rust tidies what it is handed and the row it answers with is the list as stored: each tag is
   * trimmed with its inner runs of whitespace closed to one space, empty ones are dropped, and a
   * tag that repeats an earlier one whatever its capitals is dropped too, so the first spelling
   * wins. Nothing is refused. It writes a history row (`field: "tags"`, both lists) and an undo
   * step, and only when the tidied list differs from the stored one.
   */
  tags?: string[];
}

/**
 * `decks.cover_kind` — **a column with one live value, kept as a union because the column's
 * own CHECK still has two.**
 *
 * `card_art` means {@link DeckRow.coverCardId}'s art crop, and it is the whole of what a cover
 * is. `custom` meant a picture the reader picked off disk, re-encoded beside the database and
 * served by the image protocol at `<origin>/cover/<deckId>`; **that half is deleted** — the
 * command, the route, the encoder and the directory are all gone, and a migration flips every
 * surviving `custom` row to `card_art`.
 *
 * **Why the word is still in the type.** The mirror's job is to say what can come back out of
 * the row: `cover_kind`'s CHECK is `IN ('card_art','custom')` and is not rewritten by the
 * migration, and `cover_kind` is a synced field, so a device still on an older rung can put
 * the retired word on the wire. Narrowing this to a single-member union would make that arrival
 * a type error rather than a value nothing branches on, which is the wrong shape for a
 * hand-written mirror that nothing type-checks against the crate.
 *
 * **Nothing in the app may branch on it, and that is the deletion's whole point.** A tile, a
 * preview and a picker each drew one of two pictures off this field; they draw the card's art
 * crop unconditionally now, which is what every *receiving* device already drew — the file
 * never survived a sync, because the path was stored absolute. So a `custom` row that reaches
 * this build from an old one draws its card art, which is the same picture that device's
 * neighbours were already showing it.
 */
export type DeckCoverKind = "card_art" | "custom";

/**
 * Where a card can be played, as Scryfall spells it — `schema::GAMES`, and the vocabulary of a
 * {@link FormatSpec.games} entry.
 *
 * Three words and not four: these are Scryfall's own, `cards.games` already carries them, and a
 * fourth platform is a word no card in this database holds.
 */
export type Game = "paper" | "arena" | "mtgo";

/**
 * What a deck's own game answer may be — {@link Game}, plus the word for a deck that has not
 * been pinned to a platform. `schema::DECK_GAMES`.
 *
 * **`"any"` is a stored value and not an absence**, which is why `decks.game_key` is `NOT NULL`
 * with a `DEFAULT 'any'` rather than nullable: {@link DeckPatch} is written with
 * `coalesce(?n, column)`, so a bound NULL means *leave it* and could never have said "back to
 * Any". `decks.default_category_id`'s sentinel argument, one column over.
 */
export type DeckGame = Game | "any";

/**
 * The stored answer meaning **the estimate stands** — {@link DeckRow.bracket} on a deck whose
 * reader has not answered the bracket question themselves, and the one entry in a bracket picker
 * that is not a bracket.
 *
 * `0`, because the Commander Format Panel numbers its brackets `1`–`5` and a sixth number can
 * never collide with one of them. That is `AUTO_CATEGORY`'s argument
 * (`features/decks/autoCategory.ts`) made against a different table — there the sentinel is safe
 * because `deck_categories.id` is an `INTEGER PRIMARY KEY` and rowids start at 1 — and it lands
 * the same way: **a sentinel of `0` can never be mistaken for a real value**, so the column can
 * carry "nobody has said" as a number rather than as an absence.
 *
 * **It is a value, not an absence**, and that is the whole reason `decks.bracket` is
 * `INTEGER NOT NULL DEFAULT 0` (schema v26) rather than nullable. {@link DeckPatch} is written
 * with `coalesce(?n, column)`, so a bound NULL reads as *unchanged* — a nullable column would
 * have made "put it back to Auto" unreachable through the patch without a double-`Option` across
 * the whole struct. `decks.default_category_id` and `decks.game_key` are the same decision on
 * either side of it; `decks.folder_id` is the column that did **not** make it, and
 * {@link ipc.deckSetFolder} is what that costs — a whole command whose only job is to reach a
 * state the patch cannot spell.
 *
 * Rust spells the same number `deck::AUTO_BRACKET`, and the two are one vocabulary on purpose: a
 * sentinel that meant "unset" on one side of the IPC and "auto" on the other is exactly the
 * mismatch that once filed every quick add on a fresh deck into the seeded Commander pile.
 *
 * **It is not the estimate and never becomes one.** The estimate is drawn on this side from the
 * deck's own cards (`features/decks/validation/bracket.ts`) and is stored nowhere; this column
 * says only whether the reader has overruled it.
 */
export const AUTO_BRACKET = 0;

/** One deck as the gallery shows it. */
export interface DeckRow {
  id: number;
  name: string;
  formatKey: string;
  /** From `format_specs`, so the gallery never re-derives a display name. `null` when the
   *  key is one the seeded table no longer carries — a LEFT JOIN, so the deck still lists. */
  formatName: string | null;
  /**
   * Which platform the deck is for — `"any"` on every deck that predates schema v18 or has
   * never been asked.
   *
   * **No `gameName` beside it, unlike {@link DeckRow.formatName}**: a format's display name is
   * a seeded cell the gallery would otherwise re-derive, while a game's is four words in a
   * picker's own list (`GAME_OPTIONS`). There is no table to read one from.
   */
  gameKey: DeckGame;
  description: string | null;
  coverCardId: string | null;
  /**
   * `card_art` on every deck this build can produce. See {@link DeckCoverKind}: the second
   * word survives in the column's CHECK and on the sync wire, and **nothing may branch on
   * it** — a cover is {@link DeckRow.coverCardId}'s art crop and nothing else.
   */
  coverKind: DeckCoverKind;
  /**
   * The cover printing's illustrator, `null` when `cards` has no row for it.
   *
   * Read here so a tile can obey Scryfall's image policy: an `art` crop has no printed
   * frame, so wherever one is shown the artist must be credited. Task 11's ruling is that a
   * cover with no artist is **not drawn** — an orphaned cover heals on the next sync.
   *
   * It is about {@link DeckRow.coverCardId} and only that — the backend's
   * `LEFT JOIN cards c ON c.id = d.cover_card_id` — so it is `null` exactly when a cover
   * cannot be drawn, and the credit and the picture are one condition rather than two that
   * have to be kept in step. They were two while a deck could wear a file instead.
   */
  coverArtist: string | null;
  archived: boolean;
  /**
   * `live` copies in **active** categories of kind `main`, `commander` or `maybe` — what "a
   * 60-card deck" means in a caption, and the **same cards the validation engine sizes a deck
   * by**: `SIZE_KINDS` in `features/decks/validation/engine.ts`. One definition, so a tile and
   * the format check beside it never answer the same question with two numbers. The kind list
   * here and that constant are the same three words, and a change to one is a change to both.
   *
   * Three exclusions, and they are {@link CategoryKind}'s governing rule applied. The
   * sideboard and the companion are *beside* the deck rather than in it (CR 100.4a; EDH calls
   * a companion "effectively a 101st card", which is exactly the card a 100-card caption must
   * not add). A **theory** row is a plan and appears on no tile. And an **inactive** category
   * counts toward nothing whatever its kind, which is how a switched-off Maybeboard stays out
   * without `maybe` being excluded — a Maybeboard switched *on* counts like any other pile.
   */
  cardCount: number;
  /** Unix seconds. The gallery's sort key, and every card write moves it — including a
   *  removal that found nothing to remove. */
  updatedAt: number;
  /** Which folder the deck is filed in, or `null` for the root of the tree. Filing is
   *  {@link ipc.deckSetFolder}, which is the only write that can put it back at `null`. */
  folderId: number | null;
  /**
   * Whether this deck keeps a theory list beside its live one.
   *
   * Read on the row as well as written through {@link DeckPatch}, because a switch the app can
   * set and never see is a switch nothing can draw: the editor's Live/Theory control **is**
   * this boolean. Without it every reader would have to guess from whether one of the two
   * lists happens to be empty — and an empty list says nothing at all here, since enabling the
   * switch *moves* the live list into theory and quite deliberately leaves live empty.
   */
  theoryEnabled: boolean;
  /**
   * Whether this deck is one the reader tracks **without owning the cardboard** — an MTGO or
   * Arena list, a proxy pile, a deck they are only reading about. `decks.virtual_only INTEGER
   * NOT NULL DEFAULT 0`, schema v40, and `false` on every deck that predates it, which is the
   * state every existing deck is in.
   *
   * **It is the third deck kind, and the three are two booleans rather than an enum.** Regular
   * is `theoryEnabled: false, virtualOnly: false`; Theory + Actual is `true, false`; Virtual is
   * `false, true`. Rust refuses the fourth combination by writing the other column in the same
   * patch, so `true, true` is unrepresentable — see `deckKind` in
   * `features/decks/deckKind.ts`, which is the one place that folds the pair into a word and
   * the only thing any surface should branch on.
   *
   * **A virtual deck keeps one `live` list, and that is deliberate rather than incidental.** It
   * reads as "a plan with no actual version" — no variant switch is drawn, so the reader never
   * meets the word *Actual* — but the rows stay in the variant every other read already counts.
   * {@link DeckRow.cardCount} and the gallery's colour bar both count `variant = 'live'`, so a
   * virtual deck whose cards sat in `theory` would report **0 cards under an empty bar on every
   * tile, forever**. This is the same rule that kept `live` as the stored word when the tab was
   * renamed `Actual`: the label moved and the value did not.
   *
   * **What it turns off is every reading of the collection and the wishlist**, which is the
   * whole of the feature. There is no owned count, no missing count, no shortage mark, no
   * `Pull from collection`, no `Add missing`, no `Send missing to wishlist`, no Collection tab
   * in the deck's own search panel. Rust refuses each of those writes by name
   * (`deck::VIRTUAL_HOLDS_NOTHING`) rather than answering an empty list, because an empty
   * shortfall and a deck that owns nothing by definition are the same JSON and very different
   * sentences.
   *
   * **A virtual deck has no `collection_folders` group**, and that is where the isolation
   * actually comes from rather than from a branch at each reader: `owned_by_printing` joins the
   * deck's group, so with none there every owned figure is `0` with nothing asking why.
   * Switching a deck to virtual files the copies its group held into `Recently removed` first —
   * the reader still owns the cardboard, it is simply no longer filed under a deck that has
   * stopped counting it.
   */
  virtualOnly: boolean;
  /**
   * Whether this deck draws the **green** theory mark — the live row that is the printing the
   * plan named.
   *
   * `decks.theory_mark_exact INTEGER NOT NULL DEFAULT 1`, schema v38. Per **deck**, which is
   * {@link DeckRow.separateXGroup}'s argument below and {@link DeckRow.theoryEnabled}'s above:
   * whether a substitute printing is worth a mark is a statement about how *this* deck is being
   * built, so two decks may disagree and a duplicate must carry the answer across.
   *
   * **Off does not mean unmarked.** An exact row on a deck with this off is re-resolved as a
   * loose one and draws blue, with blue's own number — `features/decks/theoryMatch.ts` carries
   * that rule, because which mark a row earns is a *conclusion* and conclusions are this side's.
   * Turning the strict mark off is a reader asking for less precision, not for less information.
   *
   * Read on the row as well as written through {@link DeckPatch}, for
   * {@link DeckRow.theoryEnabled}'s reason exactly: a switch the app can set and never see is a
   * switch nothing can draw.
   */
  theoryMarkExact: boolean;
  /**
   * Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   * not name. See {@link DeckRow.theoryMarkExact}, whose every rule this shares.
   *
   * **Three booleans rather than one many-valued field**, which is the schema's own argument
   * carried onto the wire: a ladder cannot spell blue *without* green, and blue
   * without green is a real answer — a reader who cares that a card is present and not which
   * printing it is.
   *
   * **All off is a real answer too, and is not a spelling of {@link DeckRow.theoryEnabled}
   * being off.** A deck with a plan and no marks at all is a reader who wants the two lists side
   * by side and no colour on either; a deck with no plan has no second list to compare against.
   */
  theoryMarkName: boolean;
  /**
   * Whether this deck draws the **red** mark on a Live card the plan does not ask for at all —
   * a stand-in, a spare or an experiment. `decks.theory_mark_unplanned`, schema v39.
   *
   * **The third of three independent switches**; see {@link DeckRow.theoryMarkExact} for the
   * rules all three share, and {@link DeckRow.theoryMarkName} for why they are three fields.
   *
   * **It is the one mark with no number.** Green and blue count a live row against what the
   * plan asks for; here the plan asks for nothing, so there is no count to draw and the mark is
   * an X. Which mark a row earns is still a *conclusion* and stays on this side —
   * `features/decks/theoryMatch.ts` — and this boolean is only whether the deck draws it.
   */
  theoryMarkUnplanned: boolean;
  /**
   * Which of the deck's two lists the editor was last reading — the tab the reader left this
   * deck on, restored when they open it again.
   *
   * Written by {@link ipc.deckSetViewState} and by nothing else, which is what keeps it honest:
   * **looking at a tab is not editing a deck**, so that command moves no `updatedAt`, writes no
   * history row and reallocates nothing. `deckUpdate(id, { theoryEnabled: true })` leaves it at
   * `"theory"`, because that write moves the deck's cards there.
   *
   * A deck whose {@link DeckRow.theoryEnabled} is `false` can still carry `"theory"` here — the
   * switch being turned off does not rewrite it — so a reader is put back on **Live** whatever
   * this says when the deck keeps no plan. There is no list to get back from otherwise.
   */
  lastVariant: DeckVariant;
  /**
   * The editor's `Group by` as the reader left it: `GroupBy`'s vocabulary
   * (`category | manaValue | type`), and `"category"` on a deck nobody has changed it on.
   *
   * **Typed `string` and deliberately not narrowed on the wire**, unlike
   * {@link DeckRow.lastVariant} beside it. The vocabulary is TypeScript's — `GroupBy` lives in
   * `features/decks/grouping.ts`, and this file may not import from `features/` — and, more to
   * the point, a database outlives the app: a word a *future* build stops offering has to
   * degrade to the default rather than putting the editor in a mode nothing can leave. The
   * narrowing is `asGroupBy`, which answers `"category"` for anything it has not heard of. The
   * same arrangement `getMarketplace` and `printingGroupBy` are in — see this file's header.
   */
  lastGroupBy: string;
  /**
   * The editor's `Sort` as the reader left it: `SortBy`'s vocabulary
   * (`alphabetical | manaCost | price | type`), and `"alphabetical"` by default.
   *
   * `string` for {@link DeckRow.lastGroupBy}'s reason, and narrowed the same way — `asSortBy` in
   * `features/decks/sorting.ts`, which answers `"alphabetical"` for a word this build does not
   * offer.
   */
  lastSortBy: string;
  /**
   * Whether this deck's curve gathers the `{X}` spells under a heading of their own.
   *
   * `decks.separate_x_group INTEGER NOT NULL DEFAULT 0`, schema v13 — per **deck**, because it
   * is an answer about a particular curve: a storm list where half the spells are `{X}` reads
   * quite differently from an aggro deck with one Fireball in it, and a single app-wide setting
   * would make the reader re-decide every time they opened a different deck.
   *
   * **It is a reading preference and changes nothing about what is in the deck.** It moves a
   * card between two headings — `buildGroups`' `separateX` and the curve the stats strip counts
   * — and reaches no rule: not size, not copies, not legality, not the allocator. Nothing in
   * `validation/` has heard of it and nothing there should.
   *
   * It is not one of the three `last*` fields above, and the split is the point: those are how
   * the reader was *looking* at this deck a moment ago, written by a command that moves no
   * `updatedAt`, while this is an answer about the deck's own curve and rides the ordinary
   * {@link ipc.deckUpdate} with the rename and the format.
   */
  separateXGroup: boolean;
  /**
   * Whether the editor's **Tokens & Emblems** area is expanded — `decks.tokens_open INTEGER NOT
   * NULL DEFAULT 0`, schema v35, and `false` on every deck that has never been opened, which is
   * the state every existing deck is in.
   *
   * **Per deck rather than app-wide**, because whether a reader wants the token wall in front of
   * them is an answer about a particular deck: a Commander list built on Treasure and Wurms
   * wants it open, and the Modern deck that makes nothing at all cannot use it. A single setting
   * would make them re-decide every time they changed deck.
   *
   * **Collapsed by default is the whole of what the column buys.** The area resolves its list on
   * every deck open whether or not it is drawn, so this decides one thing: whether a reader who
   * never sleeves tokens pays one header row for the feature or a wall of them.
   *
   * Read on the row as well as written through {@link DeckPatch}, for {@link theoryEnabled}'s
   * reason — a setting the app can write and never see is a setting nothing can draw.
   */
  tokensOpen: boolean;
  /**
   * Whether the editor's **Deck stats** band is expanded — `decks.stats_open INTEGER NOT NULL
   * DEFAULT 1`.
   *
   * **The default is the one place this does not mirror {@link tokensOpen}, and the difference is
   * the whole reason to state it.** The token wall was new when its column landed, so a collapsed
   * default cost no reader anything they already had. The stats band has been on screen for every
   * deck since 2026-08-14 with **no control that hides it** — so a `DEFAULT 0` here would not be a
   * default, it would be a feature silently removed from every deck in the database on upgrade.
   * `1` is today's behaviour exactly, and the disclosure is purely additive: what a reader gains
   * is the ability to put two screens of charts away, which is what the band's own history says
   * they wanted when it was a 280px aside with a toggle.
   *
   * **Per deck rather than app-wide**, for {@link tokensOpen}'s reason one column over: whether a
   * reader wants four charts in front of them is an answer about a particular deck — a list being
   * tuned wants them, a finished one does not — and a single setting would make them re-decide on
   * every deck they opened.
   *
   * Read on the row as well as written through {@link DeckPatch}: a setting the app can write and
   * never see is a setting nothing can draw.
   */
  statsOpen: boolean;
  /**
   * Whether the editor's **Notes** band is expanded — `decks.notes_open INTEGER NOT NULL
   * DEFAULT 0`, schema v43, and `false` on every deck that predates it, which is the state
   * every existing deck is in.
   *
   * **The default is v37's answer and not v42's, and the two rungs asked the same question.**
   * {@link statsOpen} above took `DEFAULT 1` because the stats band was already on screen for
   * every deck on every disk, so a `0` would have hidden something a reader had been looking at
   * for months. The Notes band is **new** — no deck has ever drawn one — so a collapsed default
   * takes nothing from anybody, and {@link tokensOpen} is the precedent character for
   * character.
   *
   * **Per deck rather than app-wide**, for {@link tokensOpen}'s reason two columns over:
   * whether a reader wants a deck's prose in front of them is an answer about a particular deck.
   *
   * Read on the row as well as written through {@link DeckPatch}: a setting the app can write
   * and never see is a setting nothing can draw.
   *
   * **This is the whole of what `decks` still says about notes.** The v8 `notes` column is gone
   * at v43 and its paragraph was discarded rather than migrated — the notes themselves are rows
   * now ({@link DeckNote}), read with {@link ipc.deckNotes} and never carried on this row,
   * because a deck's tile and its gallery read want a row and not a notebook.
   */
  notesOpen: boolean;
  /**
   * Whether the Deck stats band's **Mana curve** splits each bar into creatures and noncreatures
   * — `decks.curve_creatures INTEGER NOT NULL DEFAULT 0`, user schema v56, and `false` on every
   * deck that predates it.
   *
   * **The default is {@link notesOpen}'s answer and not {@link statsOpen}'s**: the split is new,
   * so off is exactly the chart every deck already draws and the upgrade changes nothing on
   * screen. **Per deck**, for {@link statsOpen}'s reason — whether a reader wants the curve
   * broken down is an answer about a particular list. What counts as a creature, and how a split
   * bar draws, are the page's (`DeckStats`); Rust stores the one bit.
   *
   * Read on the row as well as written through {@link DeckPatch}: a setting the app can write
   * and never see is a setting nothing can draw.
   */
  curveCreatures: boolean;
  /**
   * Whether the editor's **To-do** band is expanded — `decks.todos_open INTEGER NOT NULL
   * DEFAULT 0`, user schema v58, and `false` on every deck that predates it.
   *
   * **{@link notesOpen}'s twin one band down, and `DEFAULT 0` for its reason**: the band is new,
   * so a collapsed default takes nothing from anybody. **Per deck**, for {@link tokensOpen}'s
   * reason — whether a reader wants a deck's checklist in front of them is an answer about a
   * particular deck.
   *
   * Read on the row as well as written through {@link DeckPatch}: a setting the app can write
   * and never see is a setting nothing can draw.
   *
   * **The lists themselves are not on this row, and that is the point of the split.** They are
   * rows of `deck_todo_lists`, many to a deck since user schema v59 — #672's single `decks.todos`
   * column was converted into one row titled `To-do` and dropped — and a gallery tile or a deck
   * menu has no use for bodies it would carry on every read. They travel only through
   * {@link ipc.deckTodoLists} and {@link ipc.everyDeckTodoList} — which is {@link notesOpen}'s
   * arrangement for the notes, where the row says whether the band is open and never what is
   * written in it.
   */
  todosOpen: boolean;
  /**
   * Which of the Compare dialog's three views this deck's **managed wishlist** follows — `all`,
   * `missing` or `other` (Different printing) — or `off` for no folder
   * (`decks.managed_wishlist_mode`, user schema v49, `DEFAULT 'off'` —
   * [issue #512](https://github.com/Msgaihede/mtg-grimoire/issues/512)). The folder is rewritten
   * by Rust after every change to the deck.
   *
   * **It only does anything on a `Theory + Actual` deck**: a regular deck has no plan to be
   * short of and a virtual one owns no cardboard, so the column is read but ignored for both
   * and a deck switched to either loses its folder. Always one of the four words: Rust reads a
   * word it does not know as `off`.
   */
  managedWishlist: ManagedWishlistMode;
  /**
   * Whether this deck's managed wishlist files the plan's **tokens** as well as its cards —
   * `decks.managed_wishlist_tokens INTEGER NOT NULL DEFAULT 0`, user schema v57
   * ([issue #617](https://github.com/Msgaihede/mtg-grimoire/issues/617)). On, every token row the
   * Compare dialog's Tokens view lists is a wish in a **`Tokens` subfolder** inside the deck's
   * folder, at its whole quantity, **whichever of the three views {@link managedWishlist}
   * names**; off, the deck's folder holds card wishes and nothing else.
   *
   * **It is a switch beside the mode and not a fifth mode**, which is what it was from v55 to v56:
   * the card view and the tokens are two answers a reader gives separately, and one word could only
   * give both at once. **A mode of `off` makes no folder whatever this says**, and the column is
   * kept rather than cleared, so picking a view again brings the tokens back as they were. v57
   * set it on for every `all` deck (All used to carry tokens) and every `tokens` one (which
   * became `missing`); a new deck starts with it off.
   */
  managedWishlistTokens: boolean;
  /**
   * How this deck keeps its tokens — `decks.token_mode TEXT NOT NULL DEFAULT 'managed'`, user
   * schema v52, closed by a `CHECK` on the three words of {@link TokenMode}. It replaced v47's
   * `token_stack` boolean in the same rung.
   *
   * **`hidden` takes the Tokens & Emblems pile out of all four views** (Stacks, Grid, Text and
   * Table); `managed` and `collection` draw it. The band is drawn in every mode, so a reader can
   * always switch back. **Every deck starts on `managed`** — the ones whose stack was off before
   * the upgrade included, which was the reader's own answer — so after v52 every deck that makes
   * tokens shows a token pile in its rail.
   *
   * The pile is drawn in the view layer from the same answer the band draws and never enters
   * `deck.cards`, so it counts toward nothing — size, piles, stats or validation. Carried by
   * `deck_duplicate`, synced with the rest of the row, audited as `tokenMode` and undoable — see
   * {@link DeckPatch.tokenMode}.
   */
  tokenMode: TokenMode;
  /**
   * Where the **Tokens & Emblems** pile sits in the rail — `decks.token_rail_index INTEGER NOT
   * NULL DEFAULT -1`, user schema v51 — as **the number of rail piles drawn above it**.
   *
   * **`-1` is last**, which is where the pile has always been drawn and where every deck that
   * predates the column keeps it. So is any value the rail no longer reaches: a count stored when
   * the rail held four piles means nothing once two of them are switched back on, and the pile
   * draws last rather than nowhere or at a stale slot. That clamp is the view layer's conclusion
   * on read and never a write — the stored number is a fact, not a promise about today's rail.
   *
   * **A count rather than an anchor pile**, because an anchor would be a category id on a synced
   * row (needing the sync's `sync_uid` translation), and switching the anchor pile on would move
   * the tokens somewhere the reader cannot account for. Carried by `deck_duplicate`, synced with
   * the rest of the row, audited as `tokenRail` and undoable — see
   * {@link DeckPatch.tokenRailIndex}.
   */
  tokenRailIndex: number;
  /**
   * Which of this deck's categories an add that names no pile lands in — `decks.default_category_id`,
   * schema v16, and **`AUTO_CATEGORY` (`0`) for "let the card's own text decide"**.
   *
   * Read on the row for {@link theoryEnabled}'s reason — a setting the app can write and never
   * see is a setting nothing can draw — and it is the deck editor's "Add to" answer: the docked
   * search panel's Add button and the quick-add field both file by it. It is chosen in **deck
   * settings** and nowhere else; it was a `useState` in `DeckEditor` until then, which is why a
   * reader who set it lost it the moment they closed the deck.
   *
   * Zero can never collide with a real pile — `deck_categories.id` is an `INTEGER PRIMARY KEY`,
   * so rowids start at 1 — and Rust spells the same sentinel `deck::AUTO_CATEGORY`.
   *
   * **It names a _live_ pile** — Deck settings offers the live list's — and since user schema
   * v53 (issue #561) the plan has piles of its own, so on the Theory tab the editor carries it
   * across **by name** to the plan's pile of that name (`defaultCategory.ts`), else Auto.
   *
   * **An id the list's `categories` does not carry, and no name carries across, reads as Auto**,
   * and no writer has to arrange that: deleting a pile puts every deck filing by it back to zero
   * in the same transaction, and a duplicate is remapped onto its own copy of the pile.
   */
  defaultCategoryId: number;
  /**
   * Which bracket the reader has told this deck it is — `decks.bracket INTEGER NOT NULL
   * DEFAULT 0`, schema v26, and {@link AUTO_BRACKET} (`0`) on every deck that has never been
   * asked, which is the state every deck is born in.
   *
   * **A Commander bracket is a self-declaration**, so this column is the reader's own answer and
   * not a measurement. The estimate is a separate thing that lives entirely on this side —
   * `features/decks/validation/bracket.ts` reads the deck's cards and is stored in no column —
   * and what the two are for *together* is the mismatch: an estimate is a **floor**, since every
   * bracket restriction is "not allowed below bracket N", so a set bracket **under** that floor
   * is the one thing worth saying out loud on a deck header.
   *
   * Read on the row as well as written through {@link DeckPatch}, for {@link theoryEnabled}'s and
   * {@link defaultCategoryId}'s reason — a setting the app can write and never see is a setting
   * nothing can draw. The bracket control on the deck header **is** this number, and without it a
   * reader who set one would find the header still showing the estimate.
   *
   * It is not one of the three `last*` fields above, and the split is {@link separateXGroup}'s:
   * those are how the reader was *looking* at this deck a moment ago, written by
   * {@link ipc.deckSetViewState}, which moves no `updatedAt`; this is an answer **about the
   * deck** and rides the ordinary {@link ipc.deckUpdate} with the rename and the format. That is
   * also why {@link ipc.deckDuplicate} carries it across — a copy of a bracket-3 deck is a
   * bracket-3 deck, where a copy of a deck someone last read on the Theory tab is not a deck
   * anybody has read at all.
   */
  bracket: number;
  /**
   * The reader's own tags for this deck, in the order they added them — `decks.tags TEXT NOT
   * NULL DEFAULT '[]'`, user schema v62 (issue #834), and `[]` on every deck that predates it.
   *
   * **A deck tag is free text and nothing else**: `No Gamechangers`, `Meme`, `Budget`. It is not
   * one of Scryfall's Tagger tags (`otag:` / `atag:`, which describe a *card*) and not a deck
   * **label** (`deck_labels`, the coloured mark on one card in one deck) —
   * `docs/agent/DOMAIN_VOCABULARY.md` has the whole set. Its nearest relative is the collection's
   * free-text `tags` column, and it is stored the same way, a JSON array in one column, so it
   * syncs with the rest of the row. It arrives here already parsed.
   *
   * **There is no table of tags.** The suggestions the tag field offers are the tags decks
   * currently wear, read off {@link ipc.deckList} by `deckTags.ts`' `tagsInUse` — so a tag no
   * deck wears any more is simply gone, with nothing to tidy up.
   *
   * {@link ipc.deckDuplicate} carries it, for {@link bracket}'s reason: a copy of a `Meme` deck
   * is a `Meme` deck.
   */
  tags: string[];
  /**
   * `decks.sync_uid` — the deck's identity on every device in the group, and the key a deck share
   * is published under (`deck:<syncUid>`, issue #1032; `features/decks/deckShare.ts`).
   *
   * **`null` is a deck that cannot be shared yet rather than an error** — `CollectionFolder`'s
   * `syncUid` rule: the column is nullable, and a share keyed on {@link id} would name a deck no
   * other device can find.
   */
  syncUid: string | null;
}

/**
 * What one deck's cards are worth, at the marketplace the caller named.
 *
 * **Every deck at once, and one argument** — {@link ipc.deckPipCosts}' shape and its reason: the
 * caller is drawing a gallery, and a per-deck read would be a round trip per tile for one figure.
 * `deck_get` prices a deck properly and rolls up every category, and none of that is this.
 *
 * **Every deck gets a row**, archived and empty ones included — the one difference from
 * {@link DeckPipCosts}, which is absent for a deck with nothing to say. A `LEFT JOIN` rather than
 * a `GROUP BY` over the cards, so the caller can index by id with no missing-key branch and decide
 * for itself what an archived deck is worth drawing.
 */
export interface DeckValue {
  deckId: number;
  /**
   * Summed over the copies the marketplace has a price for — **`null` when that is none of them**,
   * which is {@link BreakdownRow.value}'s rule and not a zero: a deck of unpriced cards is an em
   * dash, and a deck of tokens really is worth nothing.
   *
   * The pile is {@link DeckRow.cardCount}'s exactly, so the value and the count on the tile beside
   * it are two readings of one list: the **live** variant, in **active** categories of kind
   * `main`, `commander` or `maybe`. A sideboard, a companion, a theory row and every pile the
   * reader switched off are outside it.
   */
  value: number | null;
  /** Copies in that pile with no price for their finish — {@link CollectionSummary.unpriced}'s
   *  rule: the figure above is worth less than it looks wherever this is not zero, and the two
   *  travel together. */
  unpriced: number;
}

/**
 * One distinct printed cost in one deck, and how many copies are paying it.
 *
 * **A cost *string*, not a counted pip, and that is the Rust/TypeScript boundary rather than a
 * shortcut.** What a `{W/U}` is worth to a colour bar is a display decision — a hybrid is one
 * pip of each half here because the bar answers *what does this deck want*, and a build that
 * decided otherwise would be changing a picture rather than a fact — so the counting lives in
 * `@/lib/mana`'s `countPips`, over the one `{…}` tokeniser this app already has. Rust supplies
 * the facts; TypeScript draws the conclusions, and a cost string is the fact.
 *
 * It is also the cheaper wire. The costs in a deck repeat heavily (every basic is the same
 * empty cost, every Sol Ring the same `{1}`), so folding by the string before it crosses turns a
 * row per card into a row per *distinct* cost: 90 rows for the whole of the dev database's four
 * decks, measured 2026-09-07.
 */
export interface PipCost {
  /**
   * The printed cost as `cards.mana_cost` holds it — `"{1}{R}"`, `"{2/W}"`, and for a split or
   * double-faced card the whole one-string form `"{1}{R} // {1}{U}"`, which `countPips` reads
   * end to end.
   *
   * **Never null and never empty**: a cost with no symbols in it is a **land**, it can
   * contribute no pip, and there is no reason to ship one row per basic. An **orphaned** deck
   * row is absent for a second reason — the read joins `cards` inwards, so a printing that has
   * left the corpus has no cost to report and contributes nothing rather than a blank.
   */
  cost: string;
  /** How many copies of cards printing this cost the deck's pile holds, summed — the weight the
   *  bar gives it. `deck_cards.quantity`, not a row count, so four Lightning Bolts are four red
   *  pips rather than one. */
  copies: number;
}

/**
 * Every deck's colour bar, in one read — {@link ipc.deckPipCosts}' per-deck entry.
 *
 * The pile is `DeckRow.cardCount`'s exactly: the **live** variant, in **active** categories of
 * kind `main`, `commander` or `maybe`. So the bar and the card count on the tile beside it are
 * two readings of one list, and a deck the reader has left on **Theory** shows its plan in the
 * editor and its live list here — the tile is a fact about the deck, the editor a fact about
 * what is on screen.
 *
 * **A deck with nothing to say is absent from the answer rather than present and empty**, which
 * is what a `GROUP BY` gives and what the caller must be written for: an all-lands pile and a
 * deck that has never been filled read alike, and both draw no bar at all rather than an empty
 * rule.
 */
export interface DeckPipCosts {
  deckId: number;
  /** Folded by cost string with the copies summed, so a cost appears once. Order is the
   *  backend's and nothing downstream may depend on it — the bar sums the whole list before it
   *  draws anything. */
  costs: PipCost[];
}

/**
 * One card of a deck, as the bracket estimator needs it and no wider.
 *
 * `estimateBracket` (`features/decks/validation/bracket.ts`) reads exactly five fields off a
 * card and takes the combos as a second argument, so this shape is the *whole* of its input —
 * which is what makes a gallery-wide bracket affordable at all. The alternative is `deck_get`
 * per deck, the heaviest read in the feature, for a number that fits in a caption.
 */
export interface BracketCardRow {
  /**
   * What the estimator dedupes on and what it *names* — a game changer, a mass-land-denial card
   * or an extra-turn card is disclosed to the reader by this string, because a reader who
   * disagrees with the estimate has to be able to see which card caused it.
   *
   * **`deck_cards.name`, the row's own denormalized column, and not `cards.name`** — the same
   * one {@link DeckCard.name} carries. Two reasons, and the second is why it matters here: it is
   * the only name an *orphaned* row has at all, and the editor's own panel dedupes on that same
   * column, so a gallery reading the live `cards` row would fold a re-worded printing
   * differently from the editor looking at the same deck.
   */
  name: string;
  /**
   * `cards.game_changer` — the Commander Format Panel's own list, delivered by a sync and
   * hardcoded nowhere on this side.
   *
   * **A plain `boolean` where {@link DeckCard.gameChanger} is nullable**, because the read
   * coalesces: a `deck_cards` row whose printing has left the corpus knows nothing about itself,
   * and "nothing known" and "not a game changer" are the same answer to the only question asked
   * of this field. The estimator tests `=== true` either way.
   */
  gameChanger: boolean;
  /** The front face's rules text, which the mass-land-denial and extra-turn greps read. `null`
   *  for an orphaned row, exactly as {@link DeckCard.oracleText} is. */
  oracleText: string | null;
  /** `cards.faces`, the raw JSON array — the *back* faces' rules text, which the same two greps
   *  read after parsing it. A card whose extra turn is printed on face two is still an
   *  extra-turn card. `null` for a single-faced card and for an orphan alike. */
  faces: string | null;
  /**
   * Whether the pile this row sits in is switched on — and it is **always `true`** on these
   * rows, because the read filters `cat.is_active = 1` before they cross.
   *
   * Carried all the same, because {@link BracketCardRow} is what `estimateBracket`'s
   * `BracketCardFacts` asks for and that type's first act is to filter on this field. A row
   * that omitted it would be a *different* type, needing a second shape and an adapter between
   * them, in exchange for one boolean per card.
   */
  categoryActive: boolean;
}

/**
 * One deck's whole bracket input — {@link ipc.deckBracketReads}' per-deck entry.
 *
 * The pile is **wider than {@link DeckPipCosts}'** and deliberately so: `variant = 'live'` and
 * `cat.is_active = 1`, in **every** category kind. That is what `DeckBracket` hands the
 * estimator today, filtered the same way, and the same ids it hands `combos_for_cards` — a
 * sideboard card is still a card the bracket rules see. (Commander has no sideboard, so a reader
 * who has filed cards there has filed them somewhere the estimate still has to look.)
 *
 * **One entry per requested id, in request order**, which is the half {@link DeckPipCosts} does
 * *not* share: that read is a `GROUP BY` and omits a deck with nothing to say, this one was
 * asked about particular decks and answers about each of them. An id with no deck behind it
 * answers an empty read rather than being dropped — a caller zipping the answer against the ids
 * it sent must not have the two come apart.
 */
export interface DeckBracketRead {
  deckId: number;
  /** `DISTINCT` over the pile, so a card in two piles of one deck is one row — which changes
   *  nothing, because the estimator dedupes by name anyway, and costs a deck's worth of
   *  duplicate oracle text on the wire. */
  cards: BracketCardRow[];
  /** Every combo the deck fully contains, already matched against the same cards — the fourth
   *  signal, and the one no amount of reading a card's own text could find. Empty on a database
   *  that has never fetched Commander Spellbook's file, which is a supported state: the estimate
   *  reads three signals instead of four. See {@link DeckCombo} and {@link ipc.combosForCards}. */
  combos: DeckCombo[];
}

/**
 * How a deck is being read, as the editor asks for it to be remembered: the tab, the grouping
 * and the sort.
 *
 * **Every field is optional and absent means "leave it"** ({@link DeckPatch}'s rule, one command
 * over). The editor writes the single control that moved, so pressing Sort can never write back
 * a stale grouping — and the three controls do not have to be read together at the call site.
 *
 * `groupBy` and `sortBy` are `string` rather than the unions that produce them, for the reason
 * {@link DeckRow.lastGroupBy} gives: the vocabularies belong to `features/decks`, and the round
 * trip has to survive a build that no longer offers one of their words.
 */
export interface DeckViewState {
  variant?: DeckVariant;
  groupBy?: string;
  sortBy?: string;
}

/**
 * One card in one category of one deck: what it is, what the validation engine needs to judge
 * it, and how much of it the user actually has.
 *
 * Three groups of fields, and the split is the design:
 *
 * * **The row's own identity** (`name`, `setCode`, `collectorNumber`, `lang`) — copied from
 *   `cards` at write time and never null since. A deck whose printing left the card database
 *   still says what it is holding.
 * * **The card facts**, every one nullable: `deck_cards LEFT JOIN cards`, so an orphaned row
 *   is listed with nulls rather than dropped — {@link CollectionRow}'s discipline, for its
 *   reason.
 * * **The availability numbers**, computed at read time and stored on no row.
 */
export interface DeckCard {
  /** `deck_cards.id`. Answered by the writes, but **never** what addresses one: every card
   *  command takes `(deckId, cardId, categoryId, variant, finish)`, the grain the unique index
   *  is on. */
  id: number;
  cardId: string;
  categoryId: number;
  /** The category's own name, denormalized into the read so a row can be drawn without a
   *  second lookup. */
  categoryName: string;
  /** **What the rules read.** The name is the user's and can be anything; this is the fixed
   *  word the engine sizes a deck, counts copies and judges a commander by. */
  categoryKind: CategoryKind;
  /** {@link DeckCategory.isActive}, copied onto the row — `false` means this card counts
   *  toward nothing at all. */
  categoryActive: boolean;
  /** Which of the deck's two lists this row is in. Every row of one read carries the same
   *  value; it is here so a caller holding a row can write it back. */
  variant: DeckVariant;
  /** The one label this row carries, resolved so a row can be drawn without a second lookup.
   *  All three are `null` together — deleting a label unlabels its cards rather than deleting
   *  them. */
  labelId: number | null;
  labelName: string | null;
  labelColor: LabelColor | null;
  quantity: number;
  /** Denormalized at write time, and the one name an orphaned row still has. */
  name: string;
  setCode: string;
  /**
   * The set's printed name, for a surface that shows the three-letter code and has room to say
   * what it stands for on hover — `PF26` is not a word anybody knows.
   *
   * **From `cards`, so `null` for an orphan**, unlike `setCode` beside it: the code, the
   * collector number and the name are denormalized onto `deck_cards` precisely so a printing
   * that has left the corpus is still listed and counted, and a set name is not part of that
   * promise. Draw the code alone when this is `null` rather than inventing one.
   */
  setName: string | null;
  collectorNumber: string;
  lang: string;
  /**
   * Which object this row plays — {@link DeckFinish}, so `null` is the regular copy.
   *
   * **Part of the row's address, not just its content.** A foil copy and a regular copy of one
   * printing in one pile are two rows since schema v18, so every card write carries it and a
   * write aimed at one must never find the other.
   *
   * What a surface draws is `card.finish ?? soleFinish(card.finishes)` — the reader's own
   * statement first, the printing's second. `soleFinish` says what the *object* is (a foil-only
   * printing) and deliberately says nothing about a printing sold in both; this says what the
   * deck plays, and it is the reader's.
   */
  finish: DeckFinish;
  /** A sentence when a sync could not keep this row's printing, `null` otherwise — the
   *  reconciler walks `deck_cards` too. */
  needsReview: string | null;
  oracleId: string | null;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  /**
   * The card's colours as **concatenated letters** — `"WU"`, not `["W","U"]`. This is not
   * JSON and `JSON.parse` will throw on it: `card_row` stores the letters, so the letters
   * are what comes back. Read it a character at a time.
   */
  colors: string | null;
  /**
   * Scryfall's precomputed `color_identity`, in the same letter form — `"WU"`, again not
   * JSON. Precomputed is the point: it already folds in DFC backs, adventures, colour
   * indicators and basic land types, so one subset check answers CR 903.5c and 903.5d
   * together.
   */
  colorIdentity: string | null;
  /**
   * Which colours of mana this card can **make** — Scryfall's `produced_mana`, in the same
   * concatenated-letter form as the two fields above and equally not JSON. A Command Tower is
   * `"WUBRG"`, an Island `"U"`, a Sol Ring `"C"`.
   *
   * **This is the only field in the deck read that answers what a card _makes_ rather than what
   * it costs**, and the two are what the stats band's Mana pips tile sets against each other: a
   * deck whose costs are 47% red and whose sources are 34% red is a deck that stumbles, and no
   * amount of reading `manaCost` or `colors` can see it. `colorIdentity` is not a substitute —
   * a Bojuka Bog's identity is black and it taps for black, but an Ancient Tomb's identity is
   * colourless and so is its mana, while a Dryad Arbor's identity is green because of a *land
   * type* rather than because of anything it produces.
   *
   * **Three values, and `""` and `null` are emphatically not the same answer.**
   * * `"WU"` — this card makes white or blue.
   * * `""` — this card makes **no** mana. Scryfall omits the key entirely for a Lightning Bolt;
   *   the ingest writes an empty string so that this case is a fact rather than a gap.
   * * `null` — **this row predates the column**, which is every row of a database that has not
   *   re-ingested since the corpus rung landed. The corpus is dropped and rebuilt by every sync
   *   and Scryfall regenerates the bulk file daily, so the state is short-lived — but it is a
   *   state, and a reader in it must be told the sources half is unanswered rather than shown a
   *   chart of zeroes. `deck::fill_unknown_produced_mana` narrows the window further by
   *   gunzipping `cards.raw` for exactly the null rows at read time; what survives that is a row
   *   whose printing has left the corpus, and an orphan has no answer to give.
   */
  producedMana: string | null;
  /**
   * JSON: **this printing's** legality blob, not the oracle card's. That is what makes Old
   * School come out right with no special case — `oldschool` is the one printing-sensitive
   * key (Serra Angel is legal from `lea` and not from `8ed`), and a deck card names a
   * printing.
   */
  legalities: string | null;
  /**
   * The printed power, **as text**, because that is what it is: `"*"`, `"1+*"` and a printed
   * `"0"` all ship in real data.
   *
   * `power` and `toughness` both `null` means *unknown*, never "no P/T box" — and CR 903.3
   * turns on exactly that difference. The backend repairs what it can before answering (it
   * gunzips `raw` for the rows that are missing a P/T *and* could have one), so a null pair
   * here is a card nothing could recover it for.
   */
  power: string | null;
  toughness: string | null;
  layout: string | null;
  rarity: string | null;
  /** JSON: the `card_faces` array verbatim. Per-face mana cost, MV and P/T live only here —
   *  Tiny Leaders' per-face MV cap and DFC commander fronts both read them. */
  faces: string | null;
  gameChanger: boolean | null;
  /**
   * JSON: the finishes this printing exists in (`["nonfoil","foil"]`), or `null` for an
   * orphan.
   *
   * A deck names a *printing* and never a finish, so this is **not** "which finish is in the
   * deck" — the model has no such concept, and `deck_cards` stores none. It answers the
   * narrower question a row's art can honestly carry: whether the printing itself leaves no
   * choice. Read it with `soleFinish` from `@/lib/finish`.
   */
  finishes: string | null;
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
  /** Printed at uncommon on **any** printing of this oracle card, which is what makes a
   *  Pauper Commander commander eligible. Computed, not read: the `paupercommander` legality
   *  key answers a different question (the 99). `false` for an orphan — nothing is known
   *  about a card that is not there. */
  everUncommon: boolean;
  /**
   * What one copy of this printing costs at the marketplace the read named.
   *
   * **The row's own finish where it names one** (schema v18), at that finish and no other —
   * the reader has said which object is in the sleeve, and quoting the plain copy's rate against
   * a foil row would be a price nobody published.
   *
   * **The printing's own figure where it does not**, which is every row that predates v18 and
   * every row a reader has not spoken about: the first finish that marketplace quotes it in,
   * `nonfoil → foil → etched`. Both arms are `sorting::deck_card_price_expr`.
   *
   * **It was the flat nonfoil rate until 2026-08-15, and that was a bug with a reader-visible
   * shape.** 13 515 foil-only and 892 etched-only printings have no nonfoil price at *any*
   * marketplace, so an Invocation, a Secret Lair or a set promo drew an em dash on its card
   * foot, was skipped by its pile's heading total and by the deck's, and did all of that beside
   * a search panel quoting the same printing.
   *
   * Still never `cards.price_usd`: that is this chain precomputed for the search's `ORDER BY`,
   * the numbers agree, and the column is the one nothing here may sum. A `null` is still the
   * answer and never a reason to reach for another marketplace's figure — an etched-only
   * printing has no euro price at all, because Scryfall has no `eur_etched` key.
   */
  unitPrice: number | null;
  /**
   * Copies of this exact printing and finish **this row can draw on**, attributed to it in the
   * read's own order.
   *
   * **Which copies those are is the _variant's_ question, and that is what changed on
   * 2026-09-09** ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). Two
   * pools, one field:
   *
   * * a **`live`** row draws on the deck's **own group and nothing else** — the
   *   `collection_entries` filed in the `collection_folders` row with `kind = 'deck'` and this
   *   deck's id. That is *custody*: what is in this box. Unchanged, and it is what every write
   *   in the editor still reads.
   * * a **`theory`** row draws on `collection_source::Availability::ForDeck(deckId)` — the very
   *   pool the deck builder's card search already counts by ({@link
   *   SearchRequest.availableForDeck}, issue #349). Every copy the reader owns that *this deck
   *   could use*: the collection root, **or** this deck's own group, **or** anywhere else that
   *   is neither *another* deck's group nor an **effectively locked** folder. `Recently
   *   removed` counts.
   *
   * **The two pools differ because the two lists are asked different questions.** A live list
   * is cardboard, so *what is in this box* is the honest question and custody is the honest
   * answer. A plan holds no cardboard and never will, so *what does this plan hold* has exactly
   * one answer — `0` — which is what this field said on every card of every plan until
   * 2026-09-09, and why a hundred-card plan with sixty-two of its cards already sleeved into
   * the deck's box read **100 of 100 missing** rather than *38 of 100*. The question worth
   * answering about a plan is *which of the copies I own could this plan use*, and the app
   * already knew how to compute that pool for the wall docked beside the deck.
   *
   * **Counting changed; writing did not.** A plan still holds no cardboard, so
   * `deck_pull_plan`, `deck_missing_plan` and `deck_missing_to_wishlist` all still read `live`
   * only, `collection_to_deck` still refuses a theory row, and the editor still draws no pull,
   * no record and no wishlist press on that tab. A truthful count is not a claim that there is
   * anything to move.
   *
   * **Both pools are scarce and both are spent down the read's order** — `min(remaining,
   * quantity)` per `(card_id, finish)` in `attribute_owned` — so two rows of one printing
   * cannot each claim the same copy, and the number a row shows must not depend on how a list
   * was displayed.
   *
   * **A sum over rows, and no longer a claim.** Schema v25 deleted `deck_allocations` and the
   * allocator with it: a card is in a deck because its `collection_entries` row sits in that
   * deck's `kind = 'deck'` folder. **Since 2026-09-07 the match is the printing, not the oracle
   * card**: `sum(quantity)` per `(card_id, finish)`. There is nothing to clamp any more and
   * nothing that can be out of date, which is what the old `min(claim, row)` existed for.
   *
   * **An orphaned printing counts now, where the oracle-grained version read it as 0.** A
   * `collection_entries` row whose `card_id` is not in `cards` has no oracle id to be grouped
   * by, so the old map dropped it; at the printing grain there is nothing to look up — the
   * pool's row and this deck's row name the same `card_id` — so the copy counts.
   *
   * The only one of this file's `ownedQuantity` fields that is about **this deck** rather
   * than about the reader's shelves as a whole: {@link CardSummary.ownedQuantity} is every
   * copy of one printing, {@link ImportMatch.ownedQuantity} is that same count taken per
   * decklist line (a wish carried a fourth until 2026-09-08 and no longer does), and this
   * one is what is in *this box* (live) or what *this box could be filled from* (theory) —
   * printing-grained (`(card_id, finish)`, not the oracle card — no more "a Bolt is a Bolt"
   * here), finish-**aware**, still condition-blind.
   *
   * Three things about the edges, and the middle one reverses what stood here:
   *
   * * a row whose `categoryActive` is `false` always reads `0`, **on both lists** — a
   *   switched-off pile is handed nothing out of either pool, so no "owned" badge belongs on
   *   that pile at all. That guard is untouched by any of the above;
   * * **a `theory` row is no longer zeroed.** This list used to say *a `theory` row always
   *   reads `0` too: a plan holds no cards, and `attribute_owned` zeroes every theory row
   *   explicitly rather than by luck*. That was the rule and it is history: the explicit zero
   *   is gone and the second pool stands in its place. The half of it that survives is why the
   *   conclusion is drawn in the read at all — a group is not scoped to a variant, so nothing
   *   about a table's shape was ever going to answer this;
   * * **live rows cannot double-count across decks; theory rows deliberately can.** A copy sits
   *   in exactly one folder, so it counts for exactly one deck's live list — which reverses the
   *   allocator era, where two decks sharing a card each carried their own claim and the claims
   *   could overlap. Two *plans* may each count the same loose copy, and that is right rather
   *   than a leak: neither is holding it, and each is honestly answering *this deck could use
   *   it*. What is left is the honest cost of custody on the live side: it is **as accurate as
   *   the reader's filing** — an unfiled collection reads as a deck full of red until they drag.
   */
  ownedQuantity: number;
}

/**
 * One deck and everything in it.
 *
 * One command rather than four, because the editor and the validation engine ask the same
 * question — *what is in this deck* — and a screen that draws a curve from one query, a
 * legality panel from another, an owned badge from a third and its column headings from a
 * fourth is a screen whose answers can disagree.
 */
export interface DeckDetail {
  deck: DeckRow;
  /** Category `sortOrder`, then the name the row carries, then row id. The read's own order,
   *  not the caller's: `ownedQuantity` is attributed along it, so the number a row shows must
   *  not depend on how a list was displayed. */
  cards: DeckCard[];
  /**
   * **Every** category of the deck, in `sortOrder`, never filtered by what happens to be in
   * it: an empty one still draws a column — that is where the next card goes — and an
   * inactive one always draws, which is the affordance for switching it back on.
   *
   * The counts are scoped to the variant that was asked for; the list itself is not, so
   * switching between Live and Theory changes what is in the columns and never which columns
   * there are.
   */
  categories: DeckCategory[];
  /** Every label of the deck, alphabetically — the palette a row's mark is picked from, which
   *  exists whether or not any row is wearing it. */
  labels: DeckLabel[];
}

/**
 * A token's own state — `deck_tokens.state`, **shared by both lists** since user schema v52
 * split the printings out into `deck_token_printings`: a dismissal is "not in this deck" and a
 * hand-added token is the deck's, whichever list the reader is looking at.
 *
 * The vocabulary is closed by a `CHECK` on the column rather than by convention, so this union
 * is the whole of it: `auto` is a token the deck derives, and `manual` is drawn whether anything
 * derives it or not — a token added by hand, which a cut can never take away because no card
 * made it.
 *
 * **`hidden` is still a word the wire can carry, and nothing on this side reads it** (managed
 * tokens spec §3.3). Dismiss is gone and a launch pass (`deck_tokens::retire_hidden`) turns every
 * dismissed token back into an ordinary one at 0 — but a peer on an older build can still write
 * the word, and one it syncs in after that pass has run arrives here before the next launch
 * retires it. Until then it is drawn like any other token: `deckTokens.ts` filters on nothing,
 * because a token that vanished with no control left to bring it back is worse than a stale word.
 */
export type DeckTokenState = "auto" | "hidden" | "manual";

/**
 * A deck card that makes a token — the answer to *why is this here*.
 *
 * A printing (`cardId`) rather than an oracle id, because that is what the deck holds and what
 * a surface has to draw or scroll to.
 */
export interface TokenSource {
  cardId: string;
  name: string;
}

/**
 * One entry of a token list, addressed by the two facts that are its grain beside the deck,
 * the list and the token — `(card_id, finish)`. What {@link ipc.deckTokenSetQuantity},
 * {@link ipc.deckTokenSwap} and {@link ipc.deckTokenRemove} name, with `null` standing for the
 * token's **implicit** entry in the first two (the third deletes a stored entry, and takes none).
 */
export interface TokenEntryKey {
  cardId: string;
  finish: Finish;
}

/**
 * An entry as it travels — **the grain's two fields and nothing else**, `null` kept as `null`.
 *
 * Rebuilt rather than forwarded because the natural thing to hand a token write is the view's
 * own `TokenEntryRef`, which also carries `oracleId` and `implicit`: serde would ignore the
 * extras, but a payload that says more than the command reads is a payload a later reader
 * trusts for the wrong fields.
 */
function tokenEntryArg(entry: TokenEntryKey | null): TokenEntryKey | null {
  return entry === null ? null : { cardId: entry.cardId, finish: entry.finish };
}

/**
 * One **entry** of a token or emblem a deck needs — one printing, in one finish, of one token,
 * in the list the read named (user schema v52, token stacks spec §4.2).
 *
 * **The token list is derived on every deck open and stored nowhere** — Rust inflates the `raw`
 * blob of each distinct card in the deck's *active* categories and reads `all_parts`. What the
 * reader stores is two tables: `deck_tokens` holds the token-level {@link state}, shared by both
 * lists, and `deck_token_printings` holds each list's entries.
 *
 * **A token with entries in the list answers one row per entry; a token with none answers one
 * _implicit_ row** — {@link implicit} `true`, {@link cardId} the resolver's default printing in
 * its default finish, {@link quantity} the legacy `deck_tokens.quantity ?? 0` (0 since managed
 * tokens spec §3.1: a token is something the reader starts to use). So every row is already the
 * effective answer, and Rust resolves it: a view that fell back from one field to another here
 * would be a second, stale copy of spec §4.2's rule 1. **A token nothing derives is the
 * exception** (spec §3.4): it has no default printing to stand for, so it answers rows only in a
 * list that holds an entry of it, and none — not even an implicit one — in a list that does not.
 *
 * **The rows of one token carry the same token facts** (name, type line, subtitle facts,
 * sources, state) and differ in the entry's own: the printing, the finish, the quantity, the
 * picture, the chin and the price. `deckTokenViews` sorts them together.
 *
 * `defaultCardId` is never null for a derived row and is **deterministic**: the printing the
 * most deck cards point at, ties broken by the same `released_at DESC, set_code ASC,
 * collector_number ASC, id ASC` tail `card_printings` orders by. Without that, one deck draws
 * different art on two opens — and an implicit entry is exactly that printing.
 */
export interface DeckTokenRow {
  /** The token — **the oracle card and not a printing**, which is what `deck_tokens` is grained
   *  on and what groups a token's entries. An entry's printing is {@link cardId}. */
  oracleId: string;
  name: string;
  typeLine: string | null;
  /** The resolved `cards` row's layout — `token`, `emblem` or `double_faced_token`. **This is
   *  what says an emblem is an emblem**, not the type line: the layout is a column and the type
   *  line is prose. */
  layout: string;
  /**
   * The four disambiguation fields. **A token's name does not identify it**: 104 token/emblem
   * names are shared by more than one `oracle_id` (measured 2026-09-07, debug corpus) —
   * `Elemental` by 31, `Spirit` by 22, `Soldier` by 13 — and `Wurmcoil Engine` alone makes two
   * tokens both called `Wurm 3/3`, separated only by Deathtouch against Lifelink. Without these
   * the panel draws indistinguishable tiles carrying identical accessible names, which is the
   * one bug a wall of tokens can have that neither suite can see.
   *
   * Power and toughness told 8 of 8 apart in both sampled names once colours and the oracle
   * text were beside them, so all four travel rather than a chosen one.
   *
   * **`power` and `toughness` are strings and not numbers**: Scryfall writes `*`, `1+*` and `∞`,
   * and a mirror that typed them numeric would read `NaN` for every such token.
   */
  power: string | null;
  toughness: string | null;
  /** The token's colours as **concatenated letters** — `"WU"`, not `["W","U"]` — which is
   *  {@link DeckCard.colors}' form and for its reason: `card_row` stores the letters, so the
   *  letters are what comes back, and `JSON.parse` throws on them. `""` is a colourless token,
   *  which most of them are. */
  colors: string | null;
  /** The rules text, which is what separates two same-named, same-statted tokens — the pair
   *  `Wurmcoil Engine` makes differ in this field and in nothing else a tile could draw. */
  oracleText: string | null;
  /** The printing the resolver names. Never null for a derived row. */
  defaultCardId: string;
  /** The deck cards that make it. **Empty for a `manual` row nothing derives** — which is the
   *  state a token is in after the card that produced it was cut. */
  sources: TokenSource[];
  /** `false` for a `manual` row this deck's cards produce nothing for. */
  derived: boolean;
  /**
   * The token's **effective** state, shared by both lists — `deck_tokens.state`, or `auto` where
   * the reader has stored none. Never `null` since v52: Rust resolves the absence, because an
   * entry row with no state would be a second spelling of the untouched token.
   */
  state: DeckTokenState;
  /**
   * **This entry's printing.** For an {@link implicit} entry it is {@link defaultCardId} — the
   * printing the resolver names — and for a stored one it is the printing the reader put in the
   * list. Every fact below the picture (the chin, the price) is this printing's.
   */
  cardId: string;
  /**
   * **This entry's finish** — `deck_token_printings.finish`, the collection's own three words and
   * never `null`: the column is `NOT NULL` on purpose, because SQLite's unique index treats every
   * `NULL` as distinct and a nullable finish would let one list hold one regular printing twice.
   * An implicit entry's is its printing's default, `deck_tokens::default_finish`: the **first**
   * finish the printing is sold in, in `FINISHES` order — `nonfoil` wherever it is sold that way,
   * `foil` for one sold only in foil and etched — and `nonfoil` where the corpus lists none. It is
   * what the chin names, what the sheen is drawn for and what {@link unitPrice} is read at.
   */
  finish: Finish;
  /**
   * How many copies of this entry the list wants — **effective**, resolved by Rust: a stored
   * entry's own `quantity`, or for an implicit entry the legacy `deck_tokens.quantity ?? 0`.
   * **`0` is a value** — rule 3 keeps a token's last entry at 0 rather than deleting it, so the
   * implicit default does not reappear under a reader who zeroed the only printing they had.
   */
  quantity: number;
  /**
   * `true` when this list holds **no entry** of the token and this row is the one Rust drew for
   * it — spec §4.2's rule 1. A write aimed at an implicit entry names it as `null`
   * ({@link ipc.deckTokenSetQuantity}, {@link ipc.deckTokenSwap}), and Rust materialises it in
   * this list only (rule 2).
   */
  implicit: boolean;
  /**
   * **This entry's printing's** chin — {@link cardId}, the same printing the pile draws the
   * picture of — so the token pile can draw the deck card's own foot: set · `#number` · finish ·
   * price (user schema v51's token pile, `deck_tokens.rs`).
   *
   * **All six are `null` together for a printing gone from the corpus**, which a stored entry
   * can outlive: the row still names its oracle card, and a chin with nothing to say is the
   * honest drawing of that. The finish the entry is held in is {@link finish}, a fact of the
   * entry rather than of the printing; `finishes` is what the printing is *sold* in.
   */
  setCode: string | null;
  collectorNumber: string | null;
  setName: string | null;
  rarity: string | null;
  /** The printing's finishes as **the JSON text `cards.finishes` stores** —
   *  `'["nonfoil","foil"]'` — for {@link DeckTokenRow.colors}' reason: it is what the column
   *  holds, and `parseFinishes` in `@/lib/finish` is the one reader of it on this side. */
  finishes: string | null;
  /**
   * What one copy of this entry costs at the marketplace {@link ipc.deckTokens} was asked for,
   * **at the entry's own {@link finish}** (user schema v52) — `sorting::price_expr` at that
   * finish, the set arm of {@link DeckCard.unitPrice}'s rule, with **no fallback across
   * finishes**: a foil Treasure quoted at the nonfoil rate is a price nobody published. That
   * reverses v51, when a token row stored no finish and was priced by the unsaid arm's
   * `nonfoil → foil → etched` chain; an implicit entry of a foil-only printing is `foil` by its
   * default finish, so the case that chain existed for still reads its foil price.
   *
   * `null` is **the em dash** — this marketplace does not quote this printing in this finish —
   * and never `0`. **Token prices never reach the deck's own totals**: a token is not a
   * `deck_cards` row, so the only sum this enters is the token pile's own heading.
   */
  unitPrice: number | null;
}

/**
 * One of a deck's notes — schema v43, and the row that replaced the single `decks.notes`
 * column.
 *
 * **A note belongs to a *deck*, and a card it names is a pointer it holds rather than a place it
 * lives.** That is the whole shape and it is what the issue asked for: attachments hang off the
 * note, so {@link ipc.deckNotes} is the complete list by construction and a note cannot become
 * invisible by acquiring a card. There is no per-card notes table to go looking for, and
 * {@link ipc.cardNotes} answers the card's question by reading these same rows from the other
 * end.
 *
 * **Attachments are by `oracleId`, never by a printing id** — `deck_tokens`' argument verbatim: a
 * printing id means nothing on the far device's shelf and an oracle id is Scryfall's. So a note
 * survives the reader swapping printings, a note written against the Theory list shows on the
 * Live one, and one note naming Lightning Bolt names it once however many copies the deck holds.
 *
 * Not on {@link DeckDetail} and not on {@link DeckRow}: a deck's read carries its cards, its
 * categories and its labels, and a notebook is neither a card fact nor something a gallery tile
 * draws.
 */
export interface DeckNote {
  id: number;
  /** The deck this note belongs to. `deck_notes.deck_id`, `ON DELETE CASCADE` — deleting a deck
   *  takes its notes and their attachments with it. */
  deckId: number;
  /**
   * The note's own heading, as the reader typed it — **one line, and legally empty**.
   *
   * Not to be confused with {@link DeckNote.body} below: this is what the band's row, the card
   * menu's submenu and the card modal's list can print without rendering anything, and it is
   * the *stored* string rather than the one drawn. **A blank title is an ordinary state**, and
   * what a reader sees for one is `noteTitle`'s conclusion in
   * `features/decks/deckNotes.ts` — the body's first line, or `Untitled note`. That derivation
   * is computed at render and stored nowhere: a stored one would go stale the moment the body
   * was edited, with no writer able to notice.
   */
  title: string;
  /**
   * The note itself — **CommonMark text**, in the narrowed dialect `features/decks/noteMarkdown.ts`
   * pins. Never HTML and never ProseMirror JSON.
   *
   * Not to be confused with {@link DeckNote.title} above: that is a line, this is the prose, and
   * nothing derives one from the other on this side of the wire. **It arrives as source, never
   * as markup** — the shipped CSP is `script-src 'self'` with no `dangerouslySetInnerHTML`
   * anywhere in `packages/ui/`, so a renderer that answered an HTML string could not be used at all.
   * `parseNoteBody` reads it into blocks for the three read-only surfaces, and the editor is
   * the only thing in the app that writes it.
   */
  body: string;
  /** Where the note sits in its deck's list. The reader's own arrangement, written by
   *  {@link ipc.deckNoteReorder} — {@link ipc.deckNotes} answers in this order, so no caller
   *  sorts. */
  sortOrder: number;
  /**
   * The cards this note names, each with the name to print — so a submenu or a chip needs no
   * second round trip for a word.
   *
   * **Empty is the ordinary case and says nothing is attached**, never that the read failed: a
   * note about the mana base names no card at all, which is exactly the note this feature exists
   * for. The marks a deck draws are `notedOracleIds`' `Set` built from these lists in
   * TypeScript, because the band already holds every note and a second command would be a
   * second source of truth for a fact already in hand.
   */
  cards: DeckNoteCard[];
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. Moves on an edit, an attach and a detach alike. */
  updatedAt: number;
}

/**
 * One card a note names: the identity, and the word to print for it.
 *
 * `oracleId` is the card **across every printing of it**, which is what a note attaches by —
 * see {@link DeckNote}. `name` is a convenience the backend joins from `cards`, and **it falls
 * back to the oracle id itself** where the corpus has no row for one: a note must not disappear
 * from a deck because a card left the reader's copy of Scryfall's data.
 *
 * `cardId` is a **representative printing**, resolved at read time so a note card can draw a
 * picture of what it names — the deck's own printing where the deck holds one, and any printing
 * the corpus has otherwise. It is never matched on, written, or synced, and the same row read
 * twice may honestly name two different printings. `cardId: null` is the orphan, and it draws the
 * empty frame rather than a broken image.
 */
export interface DeckNoteCard {
  oracleId: string;
  name: string;
  cardId: string | null;
}

/**
 * A note seen **from a card**, rather than from the deck that owns it — what
 * {@link ipc.cardNotes} answers.
 *
 * **The same rows as {@link DeckNote}, asking the opposite question.** A `DeckNote` answers
 * *what has this deck written*, and carries the cards it names; a `CardNote` answers *what has
 * been written about this card, anywhere*, and carries the **deck** it was found in instead —
 * which is the field that would otherwise be missing, since a card opened from the collection or
 * from search has no deck in hand at all. Nothing about the note differs between the two shapes;
 * what differs is which end of the join the caller already holds.
 *
 * It carries no `cards`, deliberately: the caller asked about one card and already knows which.
 * And no `sortOrder` — an order within one deck is meaningless in a list spanning several.
 */
export interface CardNote {
  id: number;
  /** The deck the note belongs to — the row the card modal's list opens. */
  deckId: number;
  /** That deck's name at the time of the read. The one field {@link DeckNote} has no use for,
   *  and the whole reason this is a second shape: a card can be in five decks and a bare id
   *  names none of them to a reader. */
  deckName: string;
  /** The stored heading, blank included — {@link DeckNote.title}'s rules and `noteTitle`'s
   *  fallback apply unchanged. */
  title: string;
  /** The CommonMark source — {@link DeckNote.body}'s rules apply unchanged, `parseNoteBody`
   *  included. */
  body: string;
}

/**
 * One of a deck's **to-do lists** — a row of `deck_todo_lists` (user schema v59, issue #688), as
 * {@link ipc.deckTodoLists} answers them for the editor's To-do band and
 * {@link ipc.deckTodoListCreate} answers the one it made.
 *
 * ⚠️ **A to-do list is still not a note**, and it now has exactly the shape a deck note has — a
 * title, a body, a card in a grid of cards — which makes the warning sharper rather than weaker.
 * A {@link DeckNote} attaches cards, is drag-reordered and is saved by a button; a to-do list
 * attaches nothing, autosaves, and its boxes tick in place on the band. They share `NoteEditor`,
 * the inline dialect and a card's *look*, and no table.
 *
 * **What it replaced.** #672 (user schema v58) kept one checklist per deck in one column,
 * `decks.todos`, with no id and no title — `deckId` was the whole of its address. v59 converted
 * every non-empty column into one row titled `To-do` and dropped the column, so a deck has many
 * lists now and a list is addressed by its own `id`. A single **to-do** is still a line of a
 * body and not a row anywhere: a tick names one by its source line in the `body` it read, and the
 * compare-and-set on {@link ipc.deckTodoListUpdate} is what makes that name safe to act on.
 */
export interface DeckTodoList {
  id: number;
  deckId: number;
  /** The reader's heading, stored as typed — `""` included, which draws as `Untitled list`
   *  (`todoMarkdown.ts`' `listTitle`) and is never stored as those words. */
  title: string;
  /**
   * The to-do document — headings, paragraphs and `- [ ]` / `- [x]` task lists, blocks separated
   * by one blank line, in the dialect `features/decks/todoMarkdown.ts` reads. `""` is a list with
   * nothing in it yet, which a list created with only a title is.
   *
   * It arrives as **source**, for {@link DeckNote.body}'s reason, and it is also the `expected` a
   * tick hands back to {@link ipc.deckTodoListUpdate} — so it must travel untouched: a caller that
   * trimmed it would be refused on every press.
   */
  body: string;
  /** Where the list sits among the deck's own, ascending — `max + 1` for a new one, so new lists
   *  go at the end. Nothing reorders lists yet; the column exists so a later reorder is a command
   *  rather than a rung. */
  sortOrder: number;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds — the list's own, moved by a write that changed its title or body. */
  updatedAt: number;
}

/**
 * One deck to-do list as the home page's `deckTodos` widget reads it — what
 * {@link ipc.everyDeckTodoList} answers: **every list in every deck whose body is not empty**,
 * most recently edited first.
 *
 * A second shape rather than {@link DeckTodoList} with a deck attached, `CardNote`'s reason: the
 * widget draws deck → list → to-dos across every deck at once, so it needs the deck's `name`,
 * `archived` and `todosOpen` beside each list and has no use for `sortOrder` or `createdAt`. With
 * them here it needs no second read to head a deck, to leave an archived deck's lists out, or to
 * decide whether pressing a heading must open the band first.
 */
export interface DeckTodoListEntry {
  /** The list's own id — what a tick from the widget writes through. */
  id: number;
  deckId: number;
  /** The deck's name at the time of the read — the widget's heading for the deck. */
  deckName: string;
  /** Whether the deck is archived. **Answered, not filtered**: an archived deck's to-dos are still
   *  the reader's, and whether the widget draws them is its own `Include archived decks` switch. */
  archived: boolean;
  /** {@link DeckRow.todosOpen}, carried here so the widget's heading press writes the disclosure
   *  only when it is shut — a deck whose band is already open costs no `deckUpdate` at all. */
  todosOpen: boolean;
  /** {@link DeckTodoList.title}, stored as typed. */
  title: string;
  /** {@link DeckTodoList.body} — **never empty here**, and the `expected` a widget tick sends back,
   *  so it must travel untouched. */
  body: string;
  /** {@link DeckTodoList.sortOrder} — the band's order, so the widget draws a deck's lists in the
   *  order the reader sees them on the deck rather than in the order they were last edited. */
  sortOrder: number;
  /** Unix seconds — the list's own `updated_at`. The widget's `Last edited` order dates a deck by
   *  its newest list. */
  updatedAt: number;
}

/**
 * What a printing swap answers: where the copies ended up, and whether they had company.
 *
 * The reason the swap has a return type of its own rather than the `EntryChange` its
 * neighbours share: two rows can become one. A category holds a printing at most once per
 * variant (the grain is `(deck, variant, category, card)`), so swapping onto a printing the
 * category already has *folds* — and a deck list that silently loses a line reads like a bug
 * unless something says so.
 */
export interface SwapResult {
  /** The target category already held that printing, so the two rows became one. */
  folded: boolean;
  /** What the row the copies now live in holds — the **sum**, when `folded`. */
  quantity: number;
}

/**
 * One row of `format_specs` — the rules as data (spec §6), handed to the TS engine whole.
 *
 * A new format is a seeded row rather than a code branch, and that is only true if nothing
 * decides here which cells matter. Seeded by the migration and by nothing else: a sync
 * cannot change this table, which is why it is not in `SYNC_INVALIDATED`.
 */
export interface FormatSpec {
  key: string;
  displayName: string;
  /** Whether the "New deck" picker offers it. `future` is the one row that is off — a
   *  format you can test against but not build for. */
  enabledInPicker: boolean;
  deckMin: number;
  /** `null` is CR 100.5: a 60-card format has a minimum and no maximum. */
  deckMax: number | null;
  /** `null` means unlimited — the two pseudo-formats (`casual`, `limited`) only. */
  maxCopies: number | null;
  /** `0` means *no sideboard*; `null` means *uncapped* — the two pseudo-formats, `casual` and
   *  `limited`, where Limited plays the rest of its pool and Casual caps nothing at all. */
  sideboardMax: number | null;
  singleton: boolean;
  requiresCommander: boolean;
  /** Which eligibility rule the commander zone is judged by, `null` for the formats that
   *  have no such zone. Two formats may share one rule (`predh` carries `edh`) — this is a
   *  rule name, not a format name. */
  commanderRule: "edh" | "brawl" | "oathbreaker" | "pdh" | "duel" | "tlr" | null;
  life: number;
  /**
   * What Scryfall's `"restricted"` legality means **in this format**, and it is never
   * inferred from the key: max one copy in vintage/timeless/oldschool, and *banned as
   * commander* in the two singleton formats that use it (duel, tlr), where "max one" would
   * be no restriction at all.
   */
  restrictedSemantic: "max_one" | "banned_as_commander";
  /** Whether `cards.legalities` carries a key for this format. `false` for `casual` and
   *  `limited`, which are not judged against a card pool at all. */
  hasLegalityData: boolean;
  /** A per-card mana-value ceiling. Only Tiny Leaders: Reborn has one (`3`). */
  maxManaValue: number | null;
  allowsCompanion: boolean;
  /** The order a picker shows them in — `format_specs` is read `ORDER BY sort_order`. */
  sortOrder: number;
  /**
   * Which platforms the format is playable on (schema v18) — an **array**, split by Rust out
   * of the one comma-joined cell `format_specs.games` stores.
   *
   * **Never empty**: a spec naming no platform would be a format no filtered picker could ever
   * offer, and the seeds write every row. It is the only input `pickerFormats`' game filter
   * reads, and it is a *fact* — which formats a picker then offers is the conclusion.
   */
  games: Game[];
  /**
   * Whether the validation engine judges a deck in this format **at all** (corpus schema 7).
   * `false` on one row, `unspecified` — a deck whose format nobody has chosen yet, which the
   * ManaBox import creates — and `validateDeck`/`validateForMarks` return no issues for it.
   * A cell rather than a key the engine knows, by the engine's own rule; `casual` is not this,
   * since it still holds a commander zone and a companion to their rules.
   */
  validates: boolean;
}

/** The decks commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const deckCommands = {
  /** The gallery: every deck, archived last, most recently touched first. */
  deckList: () => invoke<DeckRow[]>("deck_list"),
  /**
   * Every deck's worth at once — see {@link DeckValue}, including which cards it counts and why
   * `null` is not zero.
   *
   * **Not on {@link DeckRow}**, deliberately: a price is a fact about a marketplace and a deck row
   * is not, so folding it in would make the gallery's own read change its answer with a setting
   * and invalidate on every marketplace switch. Its own command, its own query key, and a caller
   * that draws the tiles before the figures arrive.
   */
  deckValues: (marketplace: MarketplaceId) => invoke<DeckValue[]>("deck_values", { marketplace }),
  /**
   * Every deck's printed mana costs at once — the colour bar's facts, and the whole of them.
   *
   * **No argument, because the gallery draws every tile at once.** A per-deck read would be one
   * round trip per tile for a bar 4px high, which is the shape `deck_get` already has and the
   * reason this is not that command: `deck_get` prices every row and rolls up every category,
   * and none of it is a colour.
   *
   * **Cost strings rather than counted pips** — see {@link PipCost}, where the whole argument
   * is. In one sentence: what a `{W/U}` is worth to a bar is a display decision, so it belongs
   * on this side with the rest of them, and `@/lib/mana`'s `countPips` is where it is made.
   *
   * The pile is {@link DeckRow.cardCount}'s: the **live** variant, active `main|commander|maybe`
   * categories. So the bar and the count beside it can never disagree, and a deck left on Theory
   * reads its plan in the editor and its live list on the tile — see {@link DeckPipCosts}.
   */
  deckPipCosts: () => invoke<DeckPipCosts[]>("deck_pip_costs"),
  /**
   * The bracket estimate's facts, for the decks the caller names.
   *
   * **It takes deck ids rather than filtering to Commander in SQL, and that is the boundary
   * again.** Which formats have a command zone is `format_specs.commanderRule` — a TypeScript
   * question, asked through `useFormatSpecs` — so a `WHERE format_key = 'commander'` in the
   * backend would be a second opinion about a table this side is already reading, and it would
   * be wrong the day a format with a command zone is seeded. The caller decides which decks have
   * a bracket to estimate and asks about those.
   *
   * It is also what keeps the read proportional: 397 distinct cards and 59 KB of oracle text
   * across the dev database's four decks (measured 2026-09-07), and the gallery asks only about
   * the tiles that will draw a number.
   *
   * Every field `estimateBracket` reads and nothing else — see {@link BracketCardRow} for the
   * five, and {@link DeckBracketRead} for the pile, which is wider than the colour bar's.
   */
  deckBracketReads: (deckIds: number[]) =>
    invoke<DeckBracketRead[]>("deck_bracket_reads", { deckIds }),
  /**
   * One deck and everything in it, or `null` when no deck has that id — a gallery that has
   * not refreshed since another view deleted it asks for a deck that is not there.
   *
   * `variant` scopes the **cards, the categories, and the two counts on every label row** — it
   * is threaded into all three reads. Since user schema v53 (issue #561) each list has piles of
   * its own, so switching between the two lists can change the columns as well as the numbers in
   * them; which *labels* come back does not depend on it, only how many copies wear each.
   *
   * `marketplace` decides every price in the answer — each card's {@link DeckCard.unitPrice}
   * and each category's {@link DeckCategory.totalPrice} — so it is part of the question rather
   * than of the presentation, and it belongs in the caller's query key.
   */
  deckGet: (id: number, variant: DeckVariant, marketplace: MarketplaceId) =>
    invoke<DeckDetail | null>("deck_get", { id, variant, marketplace }),
  /**
   * Every token and emblem the deck's cards make — **one row per entry** since user schema v52,
   * and one implicit row for a token this list holds no entry of. See {@link DeckTokenRow}.
   *
   * **The token list is derived on every call and stored nowhere** — the backend inflates the
   * `raw` blob of each distinct card in the deck's *active* categories and reads `all_parts`,
   * which is ~5 ms for a 100-card deck. A stored list would need reconciling on every deck edit
   * *and* would go stale when a Scryfall sync changed a card's `all_parts`, with nothing to
   * notice.
   *
   * `variant` scopes it the way it scopes every other deck read, and **since v52 it scopes the
   * entries too**: each list has its own printings and counts (`deck_token_printings` is grained
   * on `(deckId, variant, cardId, finish)`), so a plan asking for a foil Treasure and a live list
   * holding a nonfoil one answer differently. The token's **state** is not scoped by it — a
   * dismissal is "not in this deck", whichever list the reader is looking at.
   *
   * **`[]` is an answer three times over** and never a failure: a deck whose cards make
   * nothing, a deck with no cards, and every failure shape behind the blob — an unknown id, a
   * `raw` that will not inflate or parse, a missing or non-array `all_parts`. A deck must not
   * fail to open over an area most decks use lightly.
   *
   * `marketplace` prices each row's effective printing — {@link DeckTokenRow.unitPrice} — so it
   * is part of the question, and it belongs in the caller's query key for {@link deckGet}'s
   * reason. It is `card_printings`' argument under the same name, so the art picker's grid and
   * the pile's chin quote one number for one printing.
   */
  deckTokens: (deckId: number, variant: DeckVariant, marketplace: MarketplaceId) =>
    invoke<DeckTokenRow[]>("deck_tokens", { deckId, variant, marketplace }),
  /**
   * **How many copies of one entry this list wants** — the stepper (spec §4.2 rules 2 and 3).
   *
   * `entry` is the entry's `(cardId, finish)`, or **`null` for the token's implicit entry**,
   * which Rust materialises in this list only — the resolver's default printing, inserted at
   * `quantity` — so a step on an untouched Treasure in the plan never touches the live list.
   * **`0` deletes the entry, unless it is the token's last one in this list**, which stays at 0:
   * the implicit default must not reappear under a reader who zeroed the only printing they had.
   *
   * Like every token write since v52 it files **one history row** (`deck` kind, `field: "token"`,
   * `action: "quantity"`) and **one undo step**, and touches no collection row.
   *
   * `entry` travels as an explicit key, `null` included — Tauri fills parameters by name and an
   * absent one is a refusal — and it is rebuilt from its two fields rather than forwarded, so a
   * caller handing in a wider object (a view's `TokenEntryRef`) sends only the grain.
   */
  deckTokenSetQuantity: (
    deckId: number,
    variant: DeckVariant,
    oracleId: string,
    entry: TokenEntryKey | null,
    quantity: number,
  ) =>
    invoke<void>("deck_token_set_quantity", {
      deckId,
      variant,
      oracleId,
      entry: tokenEntryArg(entry),
      quantity,
    }),
  /**
   * **Swap one entry to another printing and/or finish** — the art picker's press (rule 4).
   *
   * `from` is the entry being changed, or `null` for the implicit entry — which is never stored,
   * so the swap *is* its materialisation, **at the destination** and at its effective quantity,
   * rather than a stored default then moved; `to` is where it lands. Swapping an entry onto its
   * own printing and finish writes nothing. **Swapping onto a printing and finish this
   * list already holds folds the two**, quantities summed, on the grain — one tile, never two
   * rows that draw identically. The token's other entries are untouched: adding art B keeps
   * art A, and swapping A never reaches B.
   */
  deckTokenSwap: (
    deckId: number,
    variant: DeckVariant,
    oracleId: string,
    from: TokenEntryKey | null,
    to: TokenEntryKey,
  ) =>
    invoke<void>("deck_token_swap", {
      deckId,
      variant,
      oracleId,
      from: tokenEntryArg(from),
      to: tokenEntryArg(to),
    }),
  /**
   * **Add one copy of a printing, in a finish, to this list** — the band's *Add printing* picker
   * (rule 5), and the one token write that names a printing rather than a token: Rust resolves
   * the oracle id from it.
   *
   * A new printing-and-finish lands at quantity 1; one the list already holds steps up by 1. A
   * token whose entries were implicit is **materialised first** (rule 2), which is what makes
   * adding art B keep art A. **A token nothing in the deck makes becomes `manual`**, so it stays
   * on the wall whether or not a card ever derives it.
   */
  deckTokenAddPrinting: (deckId: number, variant: DeckVariant, cardId: string, finish: Finish) =>
    invoke<void>("deck_token_add_printing", { deckId, variant, cardId, finish }),
  /**
   * **Remove printing** — one stored entry of one token in this list, deleted unconditionally
   * (managed tokens spec §3.4). The one thing no other write does: a step to 0 keeps a token's
   * last entry (rule 3), and the command that took them all, `deck_token_reset`, is retired along
   * with Dismiss's `deck_token_state`.
   *
   * - **A derived token** whose last entry in this list goes falls back to its implicit entry,
   *   the resolver's printing at 0 — what Reset printings did.
   * - **A hand-added token** is drawn only in a list that holds an entry of it, so its last entry
   *   here takes it off this list's band; when neither list holds one its state returns to `auto`
   *   and it leaves the deck.
   *
   * **`entry` is never `null`**: an implicit entry is not stored, so there is nothing to delete
   * and the band draws no Remove on one. An entry this list does not hold is refused in words
   * (`ENTRY_GONE`). Journalled like every token write — one history row, *Removed Treasure's TMOM
   * #12 printing*, and one undo step that puts it back.
   */
  deckTokenRemove: (deckId: number, variant: DeckVariant, oracleId: string, entry: TokenEntryKey) =>
    invoke<void>("deck_token_remove", {
      deckId,
      variant,
      oracleId,
      entry: tokenEntryArg(entry),
    }),
  /**
   * **Every paper token and emblem printing in the game** — Add printing's `All tokens` (managed
   * tokens spec §3.6). See {@link TokenPrinting}: the `card_printings` row the picker already
   * draws, priced per finish at `marketplace`, with the token's own facts beside it.
   *
   * One statement over `cards` with `is_token_printing`'s predicate in SQL and **no index behind
   * it**, which is a decision rather than an omission: it runs on a press of the toggle, never per
   * keystroke — the picker narrows the answer it holds. The corpus answers ~3 245 printings over
   * ~1 078 tokens (measured on the debug corpus when the token feature landed), so the picker
   * lets the browser skip the groups off screen rather than drawing every one.
   */
  tokenPrintings: (marketplace: MarketplaceId) =>
    invoke<TokenPrinting[]>("token_printings", { marketplace }),
  /**
   * Every note on the deck, in the reader's own order, each with the cards it names.
   *
   * **The complete list, and that is the feature rather than an implementation detail.** A note
   * that names a card is still one of these rows — attachments hang off the note, so acquiring a
   * card cannot file a note away somewhere the band does not look. See {@link DeckNote}.
   *
   * **`[]` is an answer and never a failure**: a deck nobody has written about yet. It is also
   * the state this screen is hardest for, which is why the band puts its add field first.
   *
   * **Not scoped by {@link DeckVariant}**, unlike every other deck read here. A note attaches by
   * `oracleId`, and the Live list and the Theory list hold the same oracle ids — so a note
   * written against the plan is a note about the deck, and scoping it would make the same
   * sentence appear and disappear as the reader flipped a toggle.
   */
  deckNotes: (deckId: number) => invoke<DeckNote[]>("deck_notes", { deckId }),
  /**
   * Write a new note, with however many cards it names — **in one transaction**, so a note is
   * never briefly in the list without the card it was written about.
   *
   * `oracleIds` travels as an explicit key even when empty, `deckIdsPlaying`'s rule: Tauri fills
   * parameters by name and an absent one is a refusal rather than a default. An empty array is
   * the ordinary case — a note about the mana base names no card.
   *
   * Both strings may be `""`. A blank `title` is legal and is what the reader gets when they
   * type a body and no heading; what is *drawn* for one is `noteTitle`'s conclusion, never a
   * value stored here. See {@link DeckNote.title}.
   */
  deckNoteCreate: (deckId: number, title: string, body: string, oracleIds: string[]) =>
    invoke<DeckNote>("deck_note_create", { deckId, title, body, oracleIds }),
  /**
   * Edit a note's heading, its prose, or both — and **absent means "leave it"**, which is
   * {@link DeckPatch}'s rule one table over.
   *
   * **Both keys travel on every call, `null` included** — the rule the retired `deck_token_set`
   * was written to: Tauri fills parameters by name, so `undefined` is folded to `null` here —
   * with `??` and never `||`, because `""` is a **title the reader deliberately cleared** and
   * `||` would send it as "leave it alone". That is this command's `quantity: 0`.
   *
   * It does not touch the note's cards. Attaching and detaching are the two commands below,
   * because a set has no patch shape and a caller changing one card would otherwise have to
   * send the rest back unchanged.
   */
  deckNoteUpdate: (deckId: number, id: number, patch: { title?: string; body?: string }) =>
    invoke<DeckNote>("deck_note_update", {
      deckId,
      id,
      title: patch.title ?? null,
      body: patch.body ?? null,
    }),
  /** **This one really deletes** — the note and its attachments, by cascade. There is no
   *  archive here and no `coalesce` to hide behind: the old `decks.notes` column could never be
   *  emptied by a patch at all, so a multi-note model owns this path itself. The press is a
   *  destructive confirm, and the step is on the deck's undo stack. */
  deckNoteDelete: (deckId: number, id: number) => invoke<void>("deck_note_delete", { deckId, id }),
  /**
   * Name one more card on a note. Answers the **whole updated note**, so the band redraws from
   * one round trip.
   *
   * **Attaching a card the note already names is a success that adds no row** —
   * `idx_deck_note_cards_grain` is `(note_id, oracle_id)`, and the caller wanted that card
   * named. Two devices doing it converge on one row for the same reason.
   *
   * `oracleId` and not a printing id: see {@link DeckNote}. The picker offers the deck's own
   * cards, and the row **survives the card leaving the deck**, which is deliberate — a note
   * about a card you cut is the note most worth keeping.
   */
  deckNoteAttach: (deckId: number, noteId: number, oracleId: string) =>
    invoke<DeckNote>("deck_note_attach", { deckId, noteId, oracleId }),
  /** Stop naming a card on a note — the row goes, **the note stays**. That is the issue's
   *  central sentence read from the other end: a card is a pointer the note holds, so taking the
   *  last one away leaves an ordinary note with no cards rather than nothing. An oracle id the
   *  note does not name is a success: the caller wanted it unnamed. */
  deckNoteDetach: (deckId: number, noteId: number, oracleId: string) =>
    invoke<DeckNote>("deck_note_detach", { deckId, noteId, oracleId }),
  /** Rearrange the deck's notes: `ids` is the whole list in the order the reader put it, and
   *  `sort_order` is rewritten to match. Answers nothing — the caller has the order, since it is
   *  what it just sent. */
  deckNoteReorder: (deckId: number, ids: number[]) =>
    invoke<void>("deck_note_reorder", { deckId, ids }),
  /**
   * Every note naming this card, **in every deck** — the card modal's `Notes` row.
   *
   * **The one note read that is not deck-scoped**, and that is what it is for: a card opened
   * from the collection, from search or from another deck still answers *what have I written
   * about this card*, which is the question the modal exists to answer completely. Each row
   * carries the deck it was found in — see {@link CardNote}, and note that it is a different
   * shape from {@link DeckNote} rather than the same one twice.
   *
   * **`[]` is an answer and not a failure, and a caller may not draw it as silence.** No notes
   * for this card, the read in flight and the read *failed* are three different states that all
   * look like an empty list, which is `combosForCard`'s rule beside it on the same rail.
   */
  cardNotes: (oracleId: string) => invoke<CardNote[]>("card_notes", { oracleId }),
  /**
   * One deck's to-do lists, in `sort_order, id` — the To-do band's read. `[]` for a deck with none,
   * and for a deck that is not there, which the band draws the same way. **Refuses rather than
   * answering `[]` when the read fails**, because the band's dialogs autosave and must never write
   * over lists nobody could read.
   */
  deckTodoLists: (deckId: number): Promise<DeckTodoList[]> => invoke("deck_todo_lists", { deckId }),
  /**
   * Make a list at the end of the deck's own (`max(sort_order) + 1`) and answer it — the dialog's
   * first real change on a **New to-do list**, which is why a list opened and closed untouched is
   * never made. Refused with `deck::DECK_GONE` for a deck that is not there.
   */
  deckTodoListCreate: (deckId: number, title: string, body: string): Promise<DeckTodoList> =>
    invoke("deck_todo_list_create", { deckId, title, body }),
  /**
   * Change one list's title, body or both. **Every key is sent, `null` meaning _leave it_**, so a
   * change that names only the body is `title: null` on the wire — `??` and never `||`, or a blank
   * title the reader typed would travel as "leave it" and the old heading would come back.
   *
   * `expected` is a compare-and-set on the **body**: a tick passes the body it read and a moved
   * list is refused with `deck_todos::TODOS_CHANGED`; the dialog's autosave passes `null`. The
   * other refusals are `TODO_LIST_GONE` and `TODO_LIST_WRONG_DECK`, in that order, and a change
   * equal to what is stored writes nothing at all.
   */
  deckTodoListUpdate: (
    deckId: number,
    id: number,
    change: { title?: string | null; body?: string | null; expected?: string | null },
  ): Promise<void> =>
    invoke("deck_todo_list_update", {
      deckId,
      id,
      title: change.title ?? null,
      body: change.body ?? null,
      expected: change.expected ?? null,
    }),
  /** Delete one list, its to-dos with it. Idempotent: a list already gone is a success, since the
   *  caller wanted it gone. */
  deckTodoListDelete: (deckId: number, id: number): Promise<void> =>
    invoke("deck_todo_list_delete", { deckId, id }),
  /** Every list in every deck whose body is not empty, most recently edited first — the home
   *  widget's one read. Takes **no arguments at all**: see the case in `ipc.test.ts`. */
  everyDeckTodoList: (): Promise<DeckTodoListEntry[]> => invoke("every_deck_todo_list"),
  /**
   * The format the last deck made on this install was given — or `null` where no deck has ever
   * been made.
   *
   * **One `app_meta` row, written by `deck_create` and by nothing else.** That is what makes it
   * true of *every* way of making a deck rather than of one dialog's: the gallery's New deck
   * panel and the import dialog's into-a-new-deck arm both go through that command, so neither
   * has to remember to record anything and no third route can be added that forgets to. It
   * moves on a **create** and not on a re-format: the question it answers is what a reader
   * *starts* a deck on, which is a different fact from what their decks currently are.
   *
   * A bare `string` rather than a narrowed format key — the same shape, for the same reason, as
   * {@link getMarketplace} and {@link printingGroupBy} above. This is the **stored fact,
   * unvalidated**: `decks.format_key` is deliberately not a foreign key and `format_specs` is
   * re-seeded by migrations, so a key this build no longer offers really can come back out of
   * the row, and a row a newer build wrote must reach this side as the string it is. The
   * narrowing belongs to the module that owns the vocabulary, and here that vocabulary is
   * `format_specs` and that module is `@/features/decks/useNewDeckFormat` — whose
   * `newDeckFormat` tests the key against the picker and falls back rather than refusing.
   *
   * `null` is an answer and not a failure: it is the same sentence as "this reader has never
   * made a deck", which is precisely the case the default exists for.
   */
  deckLastFormat: () => invoke<string | null>("deck_last_format"),
  /**
   * Every card the deck's **live** list plays, as the keys a copy is matched against — the read
   * behind the rule that a copy may only be filed into a deck's own collection folder when that
   * deck already plays it.
   *
   * **A key is `coalesce(cards.oracle_id, deck_cards.card_id)`: the oracle card, with the
   * printing as the fallback for a row the card database has never heard of.** The oracle id is
   * what makes the rule mean what a reader means — a deck plays *Sol Ring*, not the Commander
   * 2019 printing of one — so a copy from any set is answered by a deck holding any other.
   * `cards.oracle_id` is nullable and a `deck_cards` row outlives a printing leaving the corpus,
   * so the fallback is what keeps an orphaned row addressable at all: matched printing to
   * printing, which is the strictest thing that can honestly be said about a card whose identity
   * nothing knows.
   *
   * **Build the same key on this side with `playKey`** from `@/features/decks/useDeckPlays` —
   * every DTO a filing surface holds carries both halves ({@link DeckCard},
   * {@link CollectionRow}, {@link CardDetail}), and a second spelling of the coalesce is one
   * rule two files would have to go on agreeing about.
   *
   * **The live list, and there is no `variant` argument on purpose.** A theory list is what a
   * deck is being built *toward* and holds no copies at all, so filing the reader's cardboard
   * into a group on the strength of a plan would put a physical card in a deck that does not
   * play it yet.
   *
   * `DISTINCT` and sorted by the key, so two runs over one deck answer in one order — a card
   * sitting in two piles is one entry, and the question is membership rather than a count.
   * **`[]` is an answer twice over**: a deck with an empty live list reads it, and so does a
   * `deckId` with no deck behind it — this is a fact about rows, and {@link ipc.deckGet} is
   * where "is there a deck" is asked.
   */
  deckPlayedKeys: (deckId: number) => invoke<string[]>("deck_played_keys", { deckId }),
  /**
   * Which decks play **every** one of these cards — {@link ipc.deckPlayedKeys} asked from the
   * other end, for a menu that has to grey the deck groups a selection may not be filed into.
   *
   * **`AND`, never `OR`, and that is the half a caller gets wrong.** A reader with four cards
   * picked is asking *which group can take this selection*, so a deck playing three of the four
   * must not offer a row that would refuse half the press. With one key the conjunction is
   * invisible, which is exactly why it is written down here.
   *
   * `keys` are {@link ipc.deckPlayedKeys}' own keys, built by `playKey`. **Sort and dedupe
   * before calling, and that is a caching rule rather than a correctness one** — the backend
   * dedupes for itself and the answer does not depend on the order, so what an unsorted list
   * costs is a second cache entry and a second round trip for one question
   * (`combosForCardsKey` in `lib/query.ts` states the same rule for the same reason).
   * `useDecksPlaying` does both for its callers.
   *
   * **An empty `keys` answers `[]` rather than every deck**, and that arm is the one worth
   * holding on to: a conjunction over nothing is vacuously true, so "every deck plays all of no
   * cards" is the tidy answer and precisely the wrong one for a menu — it would offer every
   * group for a selection there is nothing to check.
   */
  deckIdsPlaying: (keys: readonly string[]) => invoke<number[]>("deck_ids_playing", { keys }),
  /**
   * Make a deck — **the whole deck, in one INSERT**, with its four predefined categories and
   * its one birth row of history in the same transaction. Every field of {@link DeckInput}
   * travels in this one call rather than as a create followed by a patch and a filing, which
   * would be three transactions with a half-made deck to unwind between them.
   *
   * **There is nothing left that it cannot do.** A cover used to be the exception — a picture
   * off disk needed the id this call answers with, so the create dialog made the deck and then
   * uploaded, which is a two-step write with a deck-exists-but-has-no-picture state in the
   * middle. A cover is {@link DeckInput.coverCardId} now, a string, and it travels here.
   */
  deckCreate: (deck: DeckInput) => invoke<DeckRow>("deck_create", { deck }),
  /** Rename, re-format, cover and archive all arrive here. */
  deckUpdate: (id: number, patch: DeckPatch) => invoke<DeckRow>("deck_update", { id, patch }),
  /** **This one really deletes** — the deck, its cards and its claims, by cascade. Archiving
   *  is `deckUpdate(id, { archived: true })`, and it is what a gallery's "remove" wants.
   *  An id that resolves to nothing is a success: the caller wanted that deck gone. */
  deckDelete: (id: number) => invoke<void>("deck_delete", { id }),
  /** Copy the deck: its categories and labels as new rows, its cards in **both** variants
   *  remapped onto them — never `archived`. A copy is a draft. */
  deckDuplicate: (id: number) => invoke<DeckRow>("deck_duplicate", { id }),
  /**
   * File the deck under a folder — or, with `folderId: null`, back at the **root** of the
   * tree.
   *
   * **The one thing {@link DeckPatch} cannot express, and the reason this is a command rather
   * than a field.** A patch writes every column with `coalesce(?n, column)`, which reads a
   * bound NULL as "leave it": there is no patch that un-files a deck. Here `null` is an
   * argument with a meaning, and it must travel as an explicit key — Tauri fills parameters by
   * name and an absent one is a refusal, not a default.
   */
  deckSetFolder: (deckId: number, folderId: number | null) =>
    invoke<DeckRow>("deck_set_folder", { deckId, folderId }),
  /**
   * Remember how this deck is being read: which of its two lists, which `Group by`, which
   * `Sort`. Absent fields are left alone — see {@link DeckViewState}.
   *
   * **A third deck write that is not a {@link DeckPatch}, and for a reason of its own: looking
   * at a tab is not editing a deck.** It writes the three columns it was given and nothing
   * else — no `updatedAt`, so a deck the reader only *read* does not climb to the top of a
   * gallery sorted by when it was touched; **no history row**, because a `deck_audit` full of
   * "changed the sort to Price" is a history nobody can read the edits out of; and no
   * reallocation, because no card moved. A deck id that resolves to nothing is refused by name,
   * like every other deck write.
   *
   * Answers nothing. What it stored is on the next {@link DeckRow} — `lastVariant`,
   * `lastGroupBy`, `lastSortBy` — and the editor is already showing it, which is why nothing
   * here invalidates (`useDeck`'s `rememberView` says why at length).
   */
  deckSetViewState: (deckId: number, viewState: DeckViewState) =>
    invoke<void>("deck_set_view_state", { deckId, viewState }),
  /**
   * A deck's categories on their own — the same list `deckGet` already carries, for a panel
   * that wants it without the cards.
   *
   * `variant` picks **which list's piles** come back — each list has its own since user schema
   * v53 (issue #561), so a pile made on Theory is not a column on Actual — and scopes nothing
   * else, because a pile's counts are already its own list's. `marketplace` decides what
   * {@link DeckCategory.totalPrice} is a total *of*.
   */
  deckCategoryList: (deckId: number, variant: DeckVariant, marketplace: MarketplaceId) =>
    invoke<DeckCategory[]>("deck_category_list", { deckId, variant, marketplace }),
  /** A new category in **one of the deck's two lists**, always `kind: "main"` and always active,
   *  appended after that list's last one. Refuses a name the list already has — the grain is
   *  `(deckId, variant, name)`, so Theory and Actual may each hold a "Ramp" of their own. */
  deckCategoryCreate: (deckId: number, variant: DeckVariant, name: string) =>
    invoke<DeckCategory>("deck_category_create", { deckId, variant, name }),
  /**
   * Rename one category — `id`, not `deckId`, because a category names its own deck.
   *
   * **Refused for the four predefined ones** (`Commander`, `Sideboard`, `Companion`,
   * `Maybeboard`), and that refusal is what guarantees they still read those words: the rules
   * role is `kind`, but every heading, every refusal sentence and every payload in the history
   * quotes the *name*.
   */
  deckCategoryRename: (id: number, name: string) =>
    invoke<DeckCategory>("deck_category_rename", { id, name }),
  /**
   * Switch a pile on or off — {@link DeckCategory.isActive}, which is the whole of "counts
   * toward nothing".
   *
   * **Allowed on every kind**, the Commander included: the backend's predefined guard is
   * about renaming and deleting and never reaches this. It reallocates in the same
   * transaction, because an inactive category claims no copies — so this changes what the deck
   * has reserved without touching a single card.
   */
  deckCategorySetActive: (id: number, isActive: boolean) =>
    invoke<DeckCategory>("deck_category_set_active", { id, isActive }),
  /**
   * Write `sortOrder` from position in `ids`, and answer the whole list back in its new order.
   *
   * An id that is not this deck's — stale, or gone — is **silently skipped** rather than
   * failing the reorder over one entry, so a list that raced a delete still lands. Send every
   * id **of one list**: this is the order of that list's piles, not a move, and a list mixing
   * Actual's piles with Theory's is refused (issue #561).
   */
  deckCategoryReorder: (deckId: number, ids: number[]) =>
    invoke<DeckCategory[]>("deck_category_reorder", { deckId, ids }),
  /**
   * Delete a `main` category, with or without keeping its cards.
   *
   * **`moveToCategoryId` is the whole of the difference, and `null` is destructive**: an id
   * moves the cards first, in the same transaction, folding into whatever the target already
   * holds — `null` lets `ON DELETE CASCADE` take the cards with the category, which is what a
   * confirm dialog has to say out loud. One command for both, because a caller doing the move
   * and the delete as two round trips could lose the cards between them.
   *
   * A pile holds one list's cards (issue #561), so the move stays inside that list: the target
   * must be a pile of the same deck **and the same variant**. Refuses a predefined category, a
   * target belonging to another deck or the other list, and a move into itself.
   */
  deckCategoryDelete: (id: number, moveToCategoryId: number | null) =>
    invoke<void>("deck_category_delete", { id, moveToCategoryId }),
  /** The labels **this deck's list is wearing**, most-used first — `deckGet` carries the same
   *  list. `variant` scopes membership as well as the counts, because the live list and the
   *  theory list are treated as separate decks where labels are concerned. */
  deckLabelList: (deckId: number, variant: DeckVariant) =>
    invoke<DeckLabel[]>("deck_label_list", { deckId, variant }),
  /**
   * A new label, **app-wide**. Refuses a name any label already holds; the colour is `#rrggbb`
   * and the backend checks only that it is non-empty — see {@link LabelColor}.
   *
   * **`deckId` is nullable, and `null` is Settings' Appearance panel.** A label has been one
   * app-wide row since v21, so the deck was never what is being written — it is only what the
   * *side effects* need: the deck's `updated_at` and its entry in the history drawer. A call
   * from a page with no deck open has no deck to name, so it makes the label and records no
   * history and no undo step, which is the honest account of an edit that reaches every deck
   * wearing it.
   *
   * **Every existing caller passes a number and is unchanged** — `number` widens into
   * `number | null`, so this is the rare wire change with no call site to follow it.
   */
  deckLabelCreate: (deckId: number | null, name: string, color: LabelColor) =>
    invoke<GlobalLabel>("deck_label_create", { deckId, name, color }),
  /** Rename **and** recolour, **in every deck at once**: one command, both arguments required.
   *  There is no patch shape here, so a caller changing one sends the other back unchanged.
   *  `deckId` is nullable for {@link ipc.deckLabelCreate}'s reason — a rename made from Settings
   *  names no deck and writes no history. */
  deckLabelUpdate: (deckId: number | null, id: number, name: string, color: LabelColor) =>
    invoke<GlobalLabel>("deck_label_update", { deckId, id, name, color }),
  /** Delete a label **from the whole app**. It **unlabels its cards rather than deleting them**
   *  — `deck_cards.label_id` is `ON DELETE SET NULL` — in every deck wearing it, which is what
   *  {@link GlobalLabel.deckCount} exists for a confirm dialog to say first. `deckId` is
   *  nullable for {@link ipc.deckLabelCreate}'s reason, and a deckless delete still un-labels
   *  every card: what it costs is the history row, never the write. */
  deckLabelDelete: (deckId: number | null, id: number) =>
    invoke<void>("deck_label_delete", { deckId, id }),
  /** Take a label off **this deck's cards in one list**, leaving the label itself alone —
   *  the row-level act the app-wide list needed and the per-deck one never did. Answers how
   *  many rows lost it; zero is a success. */
  deckLabelRemoveFromDeck: (deckId: number, labelId: number, variant: DeckVariant) =>
    invoke<number>("deck_label_remove_from_deck", { deckId, labelId, variant }),
  /** Every label there is, most-used first — the only list that can answer a label no card is
   *  wearing. Takes no deck id at all; see {@link GlobalLabel}. */
  deckLabelAll: () => invoke<GlobalLabel[]>("deck_label_all"),
  /**
   * Put the one label a deck card carries on it, or take it off with `labelId: null`.
   *
   * A **card** write wearing a label command's name: it addresses the slot by the full grain
   * `(deckId, cardId, categoryId, variant, finish)` like every other card write, and answers
   * "that card is not in this deck's category any more" for a row that has since moved, folded
   * or been stepped to zero. A `labelId` belonging to another deck is refused before anything
   * is written.
   *
   * **`finish` is the fifth term and was sent here for months without arriving.** The command
   * declared no such parameter, Tauri drops a payload field a command does not name, and the
   * writer behind it addressed the row without one — so no foil or etched row in any deck could
   * be labelled at all. Fixed 2026-09-03; `ipc.test.ts` now pins the crate's parameter list
   * against the keys sent from here, which is the only place the two spellings meet.
   */
  deckCardSetLabel: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    finish: DeckFinish,
    labelId: number | null,
  ) =>
    invoke<void>("deck_card_set_label", { deckId, cardId, categoryId, variant, finish, labelId }),
  /** Every folder there is, flat — the tree is the reader's to build from `parentId`. No deck
   *  scoping, because a folder belongs to no deck: it files them. */
  deckFolderList: () => invoke<DeckFolder[]>("deck_folder_list"),
  /** A new folder, at the root with `parentId: null` or inside another one. */
  deckFolderCreate: (parentId: number | null, name: string) =>
    invoke<DeckFolder>("deck_folder_create", { parentId, name }),
  deckFolderRename: (id: number, name: string) =>
    invoke<DeckFolder>("deck_folder_rename", { id, name }),
  /**
   * Re-parent a folder — `parentId: null` moves it back to the root.
   *
   * Refuses a move into itself or into one of its own descendants, and that guard is not
   * cosmetic: `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so a cycle is a
   * graph SQLite's recursive cascade would walk forever the day the folder is deleted.
   */
  deckFolderMove: (id: number, parentId: number | null) =>
    invoke<DeckFolder>("deck_folder_move", { id, parentId }),
  /**
   * Place a whole level — **{@link ipc.collectionFolderReorder}'s contract verbatim, and read that
   * one before calling this**: `ids` is the *full* new list of `parentId`'s children in order, and
   * one transaction writes both `sort_order` (from position) and `parent_id` (from `parentId`), so
   * a drag that re-parents *and* places is never seen half done. Sending only the folder that
   * moved is the mistake the name invites.
   */
  deckFolderReorder: (parentId: number | null, ids: number[]) =>
    invoke<DeckFolder[]>("deck_folder_reorder", { parentId, ids }),
  /**
   * Delete a folder. **Its decks are not deleted** — `decks.folder_id` is `ON DELETE SET
   * NULL`, so they surface at the root, filed nowhere and otherwise exactly as they were.
   * Sub-folders *do* go with it. An id that resolves to nothing is a success.
   */
  deckFolderDelete: (id: number) => invoke<void>("deck_folder_delete", { id }),
  /**
   * One deck's history, newest first — `at DESC, id DESC`, because `unixepoch()` has
   * one-second resolution and a single click can write two rows inside one second.
   *
   * `limit` is **required and clamped into `1..=500`** by the backend: a cap rather than a
   * page cursor, because this table grows by one row per edit and a built deck is hundreds of
   * rows, not millions. The clamp is also what stops a `0` or a negative from meaning *no
   * limit at all*, which is exactly how SQLite reads a negative `LIMIT`.
   *
   * A deck that is not there answers an **empty list**, not an error: the history of a deck
   * that does not exist is nothing, and the rows cascade with it.
   */
  deckAuditList: (deckId: number, limit: number) =>
    invoke<DeckAuditEntry[]>("deck_audit_list", { deckId, limit }),
  /**
   * The home page's feed — every cabinet's recent changes, newest first, `at DESC, id DESC` like
   * the history above it.
   *
   * **It reads {@link ipc.deckAuditList}'s table as one half of itself**, which is why it sits
   * here: a `UNION ALL` over `activity` and `deck_audit`, so a deck edit appears once — in the
   * drawer *and* in the feed — rather than being logged twice. See {@link ActivityEntry} for what
   * that costs (colliding `id`s, and a `kind` vocabulary that depends on the `scope`).
   *
   * `limit` is **required and clamped into `1..=500`** by the backend, {@link ipc.deckAuditList}'s
   * rule and its reason: the clamp is what stops a `0` or a negative from meaning *no limit at
   * all*, which is exactly how SQLite reads a negative `LIMIT`.
   */
  activityRecent: (limit: number) => invoke<ActivityEntry[]>("activity_recent", { limit }),
  /**
   * What the deck editor's Undo and Redo buttons would do — see {@link DeckUndoState}.
   *
   * **`redoId` is the caller's**, because the redo stack lives in this webview and dies with
   * the window. Rust stamps `undone_at` so *undo* survives a restart and carries on where it
   * stopped; which of those undone changes the reader could still put back is their position
   * in a session, not a fact about the deck, and a database-backed redo would offer to
   * resurrect a fortnight-old branch of edits they had forgotten making.
   */
  deckUndoState: (deckId: number, redoId: number | null) =>
    invoke<DeckUndoState>("deck_undo_state", { deckId, redoId }),
  /**
   * Undo one change. `auditId` must be the deck's cursor — the id `deckUndoState` handed back
   * — or the call is refused in words rather than undoing something else.
   *
   * A deck write like any other: it moves `updated_at`, records its own history row and
   * reallocates. What it does *not* record is a step of its own, so pressing Ctrl+Z twice goes
   * back two changes rather than toggling one.
   */
  deckUndoApply: (deckId: number, auditId: number) =>
    invoke<void>("deck_undo_apply", { deckId, auditId }),
  /** Put back a change that was undone. Refused in words if it was not. */
  deckRedoApply: (deckId: number, auditId: number) =>
    invoke<void>("deck_redo_apply", { deckId, auditId }),
  /** What the plan wants and the deck does not have — see {@link TheoryDiffRow}. One
   *  direction only, on the exact card (printing **and** finish), categories not compared,
   *  inactive ones excluded from both sides. `marketplace` prices the shopping list, which is
   *  the whole point of drawing one. */
  deckTheoryDiff: (deckId: number, marketplace: MarketplaceId) =>
    invoke<TheoryDiffRow[]>("deck_theory_diff", { deckId, marketplace }),
  /**
   * Every card the plan asks for, as a {@link TheorySlot} each — `deck_theory.rs`'s own
   * `group_key` string and how many copies the plan wants, in no particular order and **one row
   * per planned card** (the piles are summed in the SQL).
   *
   * The deck editor's theory tick, and **the one question about the pair that
   * {@link ipc.deckTheoryDiff} cannot answer**: a card the reader has fully acquired is absent
   * from the diff and is still in the plan. See `features/decks/theoryMatch.ts`, which builds
   * the same string for a live row and looks it up.
   *
   * **Not a `deckGet` of the other variant**, deliberately: that read prices every row and rolls
   * up allocations, and `DeckEditor.test.tsx` pins that nothing may call it for the list the
   * reader is not looking at. This is three columns of one indexed scan and no marketplace.
   *
   * Inactive categories are excluded, which is `deck_theory_diff`'s rule and the same reasoning:
   * a card parked in the theory Maybeboard is not something the reader has decided to play.
   */
  deckTheorySlots: (deckId: number) => invoke<TheorySlot[]>("deck_theory_slots", { deckId }),
  /**
   * The printings of one deck, in either list, that answer every typed term of the editor's
   * `Filter this deck` box — `t:goblin`, `cmc>=3`, `-kw:flying`, a resolved `otag:` slug
   * (issue #621). Sorted, deduplicated card ids; a deck that is not there answers `[]`.
   *
   * **The terms and nothing else**: the box's free text is matched in the webview as it always
   * was, so there is deliberately no `text` here and Rust would ignore one. The filters are the
   * search's own (`filters::push_card_filters`, `filters::fts_match`), which is the whole reason
   * this is a round trip rather than a test over `DeckCard` — a deck row carries no keywords, no
   * artist and no tags, and a second implementation of the thirteen fields would drift.
   */
  deckQueryCards: (
    deckId: number,
    filters: Pick<CardFilters, "predicates" | "oracleTags" | "artTags">,
  ) => invoke<string[]>("deck_query_cards", { deckId, filters }),
  /**
   * Everything the **plan** is short of, onto the wishlist. Answers how many wishes were
   * touched, like its live twin.
   *
   * A second command rather than a variant argument on `deckMissingToWishlist`, because the
   * two are different questions: that one reads `live` and only `live` — what the deck as it
   * stands is short of — while this one reads the difference between the plan and the deck.
   * Neither nets out {@link TheoryDiffRow.ownedSpare}: it is a display field, and subtracting
   * it here would count the live list twice.
   *
   * **`only` narrows it to the rows the reader ticked** — `deck_theory.rs`'s own `group_key`
   * strings, `` `${cardId}|${finish ?? ""}` ``, which is the same spelling
   * {@link ipc.deckTheorySlots} answers in and `theoryMatch.ts` builds. Absent means the whole
   * difference, so the footer's untouched press and every older caller mean what they always
   * did. A key naming no row of the current difference writes nothing rather than refusing:
   * the diff is re-read inside the write, so a row the reader ticked and then acquired in
   * another window is simply not short any more.
   *
   * **An include list rather than an exclude list**, though the gesture it serves is exclusion.
   * The two differ only for rows that appeared between the read and the press — and those are
   * rows the reader never saw, so sending them would be the dialog acting on its own.
   *
   * **The wish is pinned to the printing the plan names** (2026-08-22), carrying its `foil` or
   * `etched` finish with it, which is the same rule the comparison itself has followed since
   * 2026-08-20: a plan naming a printing is a plan for that cardboard, and answering it with a
   * wish for any printing hands the reader back the substitution they were tracking. The
   * regular copy pins no finish — `null` is the unmarked case in `deck_cards`, and writing
   * `nonfoil` would split this wish from every other one the app makes for that card.
   *
   * Because a pinned wish and an any-printing one are **different rows** on the wishlist grain
   * `(oracleId, cardId, preferredFinish, folderId)`, a reader who pressed this before that
   * change keeps their old any-printing line and gains a pinned one. Nothing is lost or
   * double-counted; the upsert folds each into its own row. (**That grain has had four terms
   * since schema v23 and this sentence named three until 2026-09-09** — an omission that read
   * as harmless only while every wish this command wrote went to the same place, and a wrong
   * description of exactly the term `folderId` below turns on.)
   *
   * **`folderId` files the whole difference into one wishlist folder, and absent — or `null` —
   * is the root** (issue #437). The root is where every wish this command has ever written
   * landed, so a caller that passes nothing means precisely what it always did; what changed is
   * that the root is now a destination the reader *picked* rather than the only one there was.
   * `null` and absent are the same answer here on purpose: {@link WishInput.folderId} is
   * `number | null`, Rust takes `Option<i64>`, and a caller holding a nullable folder id should
   * be able to forward it without first turning it into `undefined`.
   *
   * **The fourth term of the grain is what makes this an _add_ and not a move**, and it is the
   * whole licence for offering a destination at all. `WISHLIST_GRAIN`'s `coalesce(folder_id, 0)`
   * means a card the reader already wants *somewhere else* gets a **second wish**, in the folder
   * this press named, with the old line untouched. Without that term the same press would land
   * on the wish they filed into `Ordered` last week and raise its quantity — the wish would
   * appear to move, and a filing decision made deliberately would be undone by a press about
   * shopping. Moving a wish between folders stays its own explicit act,
   * {@link ipc.wishlistSetFolder}, which is the distinction this argument must never blur.
   *
   * **A folder id naming nothing is refused in words ahead of the diff** — `FOLDER_GONE`, *That
   * folder is not there any more.* — which is the third of this command's three refusals, behind
   * "that deck is gone" and "that deck keeps no cardboard", because all three are different
   * mistakes and each is owed its own sentence. Up front rather than at the write, so a plan
   * that is short of nothing still refuses instead of answering `0`: `add_wish` fences the
   * column per row and a press that reaches it not once would otherwise report a success. A
   * dialog cannot tell "the folder you picked was deleted in another window" from "you already
   * own all of it" any other way, and those are two very different things to tell somebody who
   * has just pressed a button.
   */
  deckTheoryMissingToWishlist: (
    deckId: number,
    only?: readonly string[],
    folderId?: number | null,
  ) => invoke<number>("deck_theory_missing_to_wishlist", { deckId, only, folderId }),
  /**
   * Put copies into a category, folding on `(deck, variant, category, card)` — the drag-in
   * and the click-to-add write, and **not** the stepper's.
   *
   * **`categoryId` or `categoryName`, and at least one.** An id is a drop onto a column the
   * reader pointed at; a name is "file it where this card belongs", found-or-created — the
   * word being `autoCategoryFor`'s to compute, because which pile a Sol Ring goes in is
   * domain logic. Passing both uses the id. Passing neither is refused in words.
   *
   * It reads `cards` to denormalize the printing onto the new row, so it refuses a card the
   * database does not have: an orphaned deck row can be stepped and moved but never
   * re-added. `quantity` must be positive; zero is refused rather than treated as a removal.
   */
  deckAddCard: (
    deckId: number,
    cardId: string,
    categoryId: number | null,
    categoryName: string | null,
    variant: DeckVariant,
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_add_card", {
      deckId,
      cardId,
      categoryId,
      categoryName,
      variant,
      finish,
      quantity,
    }),
  /**
   * Put copies of one printing and finish into the deck's **other** list — the card menu's
   * `Add to actual` / `Add to theory` (issue #592) — filed in the pile there that stands for the
   * one the card is in now.
   *
   * **`variant` is the list the card goes _into_, and `fromCategoryId` is the pile it is in
   * _now_**, in the other list: the caller names the source and Rust finds the target through
   * `deck_meta::counterpart_in` — a zone by its kind, any other pile by its name, and a missing
   * one made there as a copy of the source. So the matching rule is written once, and the page
   * never guesses a pile of a list it is not drawing.
   *
   * Refuses in words where {@link ipc.deckAddCard} would, and three more: a deck that keeps no
   * plan (there is no other list), a pile that is not this deck's, and a pile already in the
   * list the card is going to. Otherwise it folds on the grain exactly as that command does.
   */
  deckAddCardToOtherList: (
    deckId: number,
    cardId: string,
    fromCategoryId: number,
    variant: DeckVariant,
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_add_card_to_other_list", {
      deckId,
      cardId,
      fromCategoryId,
      variant,
      finish,
      quantity,
    }),
  /**
   * An absolute quantity — **the stepper's write**, and the one that works on a row whose
   * printing has left the card database.
   *
   * `0` *removes* the row, which is now what all three lists do — the collection's row survived a
   * zero until schema v24 and no longer does — and here it needs no argument at all: a category
   * slot holds an intention and nothing else, and an intention stepped down to none of is
   * withdrawn. The answer then reads `removed: true` with `id: 0` when there was no row to
   * remove in the first place.
   *
   * Adjusts what is there; it does not create. Putting a card into a category is
   * `deckAddCard`.
   */
  deckSetCardQuantity: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_set_card_quantity", {
      deckId,
      cardId,
      categoryId,
      variant,
      finish,
      quantity,
    }),
  /**
   * Empty one category of one variant — a pile's right-click **Clear stack** — and answer the
   * **copies** it removed.
   *
   * One command rather than a `deckSetCardQuantity(…, 0)` per row, and the arithmetic is
   * `deckImportCommit`'s: a loop over a forty-card pile is forty transactions, forty history
   * rows and forty invalidations. This is one of each.
   *
   * **This variant only** — which, since a pile belongs to one list (user schema v53, issue
   * #561), is every copy the pile holds — `variant` is the pile's own. A clear leaves the pile
   * standing, so what it empties is the list the reader is looking at, and the confirmation says
   * so.
   *
   * An empty pile answers `0` and writes nothing at all: no history row, no `updated_at`, and
   * not one collection row moved.
   */
  deckCategoryClear: (deckId: number, categoryId: number, variant: DeckVariant) =>
    invoke<number>("deck_category_clear", { deckId, categoryId, variant }),
  /**
   * Empty **one whole list of one deck** — Deck settings' **Clear actual list…** and
   * **Clear theory list…** — and answer the
   * **copies** it removed: `sum(quantity)`, never a count of `deck_cards` rows.
   *
   * `deckCategoryClear` one grain wider, and it makes that command's arithmetic argument more
   * loudly rather than differently: a hundred-card deck emptied a pile at a time is a
   * transaction, a history row and an invalidation *per pile*, and one emptied a row at a time
   * through `deckSetCardQuantity(…, 0)` is a hundred of each. This is one of each.
   *
   * **The piles survive.** `deck_categories` is untouched, so every column the reader arranged
   * is still on the desk when the deck is empty — which is the whole difference between this and
   * a sweep of `deckCategoryDelete`, and what makes the press an *emptying* rather than a
   * demolition. It is also why nothing here cascades into the other list: a category is not
   * variant-scoped, and this command is.
   *
   * **This variant only, and the argument is the whole of what says which.** On `live` it is a
   * collection write too — the reader's owned copies are released back into `Recently removed`,
   * through the same walk a cut goes through — where a `theory` clear moves nothing at all,
   * because a plan holds no copies to release.
   *
   * An already-empty list answers `0`.
   */
  deckClear: (deckId: number, variant: DeckVariant) =>
    invoke<number>("deck_clear", { deckId, variant }),
  /**
   * Move every copy from one category to another **within one variant**, folding into whatever
   * the target already holds. The identity travels from the moved row, so an orphan can be
   * tidied out of the scratchpad like anything else.
   *
   * **Either `toCategoryId` or `toCategoryName`, and at least one** — `deckAddCard`'s two-arm
   * target, and the id wins when both arrive. An id is a drop onto a column the reader pointed
   * at; a **name** is the quick zones' `Auto`, found-or-created in the same transaction by
   * `category_for_name`, which is what makes a pile the app invents come out `origin: 'auto'`
   * and therefore stop being drawn once its last card leaves. The word is `autoCategoryFor`'s
   * and is computed here, never in Rust.
   *
   * Answers **the category the copies are now in**, which is the only way the name arm's caller
   * learns what was found or made — the caret follows a moved card to its new pile, so that id
   * is load-bearing rather than a convenience. A name that resolves to the pile the card is
   * already in writes nothing at all, answers that pile, and does not bump `updated_at`.
   */
  deckMoveCard: (
    deckId: number,
    cardId: string,
    fromCategoryId: number,
    toCategoryId: number | null,
    toCategoryName: string | null,
    variant: DeckVariant,
    finish: DeckFinish,
  ) =>
    invoke<number>("deck_move_card", {
      deckId,
      cardId,
      fromCategoryId,
      toCategoryId,
      toCategoryName,
      variant,
      finish,
    }),
  /**
   * Swap a deck card to **another printing of the same card**: same category, same variant,
   * same copies, folding into whatever that category already holds of the printing swapped
   * to. The card pane's "Use this printing".
   *
   * The one card write whose identity comes from a fresh `cards` lookup rather than from the
   * row being changed — a move keeps a printing the reader already chose, a swap *is* the
   * reader choosing a new one — so a `toCardId` that no longer resolves is answered as a sync
   * that raced the click, not as an orphan to preserve. The backend refuses two printings of
   * different cards outright; an orphaned `fromCardId` is the exception, because a printing
   * the database has lost has no oracle id to compare and is exactly the row a swap has to be
   * able to rescue.
   */
  deckSwapPrinting: (
    deckId: number,
    fromCardId: string,
    toCardId: string,
    categoryId: number,
    variant: DeckVariant,
    finish: DeckFinish,
  ) =>
    invoke<SwapResult>("deck_swap_printing", {
      deckId,
      fromCardId,
      toCardId,
      categoryId,
      variant,
      finish,
    }),
  /**
   * Split **some** of a deck row's copies onto another printing of the same card — the deck card
   * menu's `Split to new printing` (issue #934). {@link ipc.deckSwapPrinting} for part of a row:
   * `quantity` copies land on `toCardId` in the same pile, variant and finish, folding into a row
   * already there, and the rest stay. One write, so one history row and one Ctrl+Z.
   *
   * Refused in words for everything the swap refuses, and for a `quantity` below one or at or
   * above the row's own — a split leaves a row behind, and moving every copy is the swap.
   */
  deckSplitPrinting: (
    deckId: number,
    fromCardId: string,
    toCardId: string,
    categoryId: number,
    variant: DeckVariant,
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<SwapResult>("deck_split_printing", {
      deckId,
      fromCardId,
      toCardId,
      categoryId,
      variant,
      finish,
      quantity,
    }),
  /**
   * Change **which object** a deck row plays — the regular copy, the foil or the etched one.
   *
   * `deckSwapPrinting` one axis over, and the same shape for the same reason: the deck plays a
   * different physical object of the same card. It **folds** the same way, so setting a row to
   * a finish the pile already holds adds the quantities and takes the row that moved away, and
   * `SwapResult.quantity` is the sum.
   *
   * Refused in words for three things: a finish the row already is (`nonfoil` and `null` are
   * the same finish, so that pair is refused too), a finish the printing is not **sold** in,
   * and a row that is not in that pile.
   */
  deckSetCardFinish: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    fromFinish: DeckFinish,
    toFinish: DeckFinish,
  ) =>
    invoke<SwapResult>("deck_set_card_finish", {
      deckId,
      cardId,
      categoryId,
      variant,
      fromFinish,
      toFinish,
    }),
  /**
   * Everything this deck is short of, onto the wishlist. Answers how many **wishes were
   * touched** — one per oracle card, so the same card short in two categories is one wish for
   * the sum, and pressing twice raises a line rather than making a second one.
   *
   * Reads the `live` variant and skips inactive categories: a plan is not a shopping list,
   * and neither is a pile the reader switched off.
   *
   * `deckId`, where the four commands above take `id`: the odd one out, and Tauri matches by
   * name. It reallocates before counting — a button that shopped for cards already bought
   * would be worse than no button.
   *
   * **`folderId` files the whole shortfall into one wishlist folder, and absent — or `null` —
   * is the root** (issue #437). Every wish this command has written since it existed landed at
   * the root, so a caller that passes nothing is unchanged in meaning as well as in spelling;
   * the root is simply an option now rather than the absence of one. `null` and absent say the
   * same thing deliberately — {@link WishInput.folderId} is `number | null` and Rust takes
   * `Option<i64>`, so a caller holding a nullable folder id forwards it as it stands.
   *
   * **It is an add into that folder, never a move of a wish filed elsewhere**, and the reason is
   * the wishlist's storage grain rather than anything this command does: `(oracleId, cardId,
   * preferredFinish, folderId)`, whose fourth term arrived with schema v23. A card the reader
   * already wants in another folder gains a **second wish** here and keeps the first one at its
   * own quantity. Without that term this argument could not exist — the press would land on the
   * existing row and the wish would appear to migrate into whichever folder the reader happened
   * to name, undoing a filing decision as a side effect of shopping. The deliberate move is
   * {@link ipc.wishlistSetFolder} and stays a separate gesture.
   *
   * **A folder id naming nothing is refused in words up front** — `FOLDER_GONE`, *That folder is
   * not there any more.* — checked before the shortfall is walked and behind the virtual deck's
   * own refusal, so a deck that is short of nothing refuses rather than answering `0`.
   * `add_wish` fences the column too, but per row, and a press that never reaches it would
   * otherwise report a success: "the folder went away" and "you own it all already" would arrive
   * as the same silent `0`, and only one of them is good news.
   */
  deckMissingToWishlist: (deckId: number, folderId?: number | null) =>
    invoke<number>("deck_missing_to_wishlist", { deckId, folderId }),
  /**
   * What this deck is short of that the reader **already owns** — the read half of the pull, and
   * the mirror of {@link ipc.deckMissingToWishlist}'s question one grain narrower.
   *
   * The two are the same idea read in two directions: what you have not got goes on a shopping
   * list, what you have got is sitting in a binder and can be moved. Read-only, so it may be
   * asked whenever a dialog is open and re-asked after any write; it takes no variant and reads
   * the `live` list only, for that command's reason — a plan holds no cards.
   *
   * **An empty array is the ordinary answer**, not an error: a deck that is short of nothing, and
   * a deck whose shortfall is all cards the reader has never owned, are both zero rows.
   */
  deckPullPlan: (deckId: number) => invoke<DeckPullRow[]>("deck_pull_plan", { deckId }),
  /**
   * Where the reader owns the cards this deck is short of, **outside the deck's own group** —
   * the read that colours the editor's missing figure and names the places in its tooltip
   * (issue #986). Every other folder counts, another deck's included: the question is whether the
   * card is owned, not whether it is free to pull. Live list only, no marketplace — the pull
   * plan's reasons. A virtual deck is refused in words; the editor never asks for one.
   */
  deckOwnedElsewhere: (deckId: number) =>
    invoke<DeckOwnedElsewhere[]>("deck_owned_elsewhere", { deckId }),
  /**
   * Move owned copies into this deck's group, filling holes the list already has.
   *
   * **It writes no `deck_cards` row, and that is the whole difference from
   * {@link ipc.collectionToDeck}.** That command is "add this card to the deck", so it folds the
   * quantity into the list (`quantity = quantity + excluded.quantity`) as well as moving the
   * cardboard — pointing it at a 4-copy line the reader is 3 short of would make the line 7.
   * This one changes only *where the copies sit*, which is the only half a shortfall is about.
   *
   * **All-or-nothing.** One pick the backend re-reads and disagrees with — an entry that has
   * since moved into a deck, been folded away, or a hole another window has already filled —
   * refuses the whole batch in words and moves nothing. A half-applied pull is the state worth
   * refusing over: the copies would be somewhere other than either place the reader was looking
   * at, and this write files no undo step (see below), so there is no press that takes it back.
   *
   * **No undo step, for {@link ipc.deckToCollection}'s reason exactly.** `take_copies` files the
   * copies *through the merge*, so a source row may have been folded into whatever the group
   * already held and no longer exists to restore. The way back is the deck editor's Collection
   * Search tab, a card at a time — and the deck's history says the pull happened, which is what
   * makes the absence visible rather than silent.
   *
   * Answers what actually moved, which is what a sentence should quote.
   */
  deckPullFromCollection: (deckId: number, picks: DeckPullPick[]) =>
    invoke<DeckPullOutcome>("deck_pull_from_collection", { deckId, picks }),
  /**
   * Every wishlist line for this printing's **card** — any printing, any finish — that a quick
   * add could take copies off: the read half of {@link ipc.deckQuickAddToCollection}'s second arm
   * (issue #511).
   *
   * **It names no deck**, and that is the shape rather than an omission: a wish is a fact about
   * the reader's shopping list and about a printing, never about which deck the press came from.
   * The deck is what the *write* files the copies into.
   *
   * **Fetched imperatively at the press, not by a mounted hook.** A right-click that fired a
   * wishlist read per menu open would ask this question once per card the reader hovered past;
   * `useDeck`'s `quickAddWishesQuery` is the options factory both the press and any test build
   * the key from, so the two cannot disagree about it.
   *
   * **An empty array is the ordinary answer** — most cards a reader records are on no shopping
   * list. One row or more opens the picker, because which line a purchase settles is the
   * reader's call. See {@link DeckQuickAddWish} for the predicate and the order.
   */
  deckQuickAddWishes: (cardId: string, finish: DeckFinish) =>
    invoke<DeckQuickAddWish[]>("deck_quick_add_wishes", { cardId, finish }),
  /**
   * Record the copies a deck row is short of, filed straight into that deck's own group — and,
   * where `wishId` names one, take them off that wish in the same transaction.
   *
   * **The first of the five deck-boundary crossings that _creates_ cardboard rather than moving
   * it.** `collection_to_deck`, `deck_to_collection` and {@link ipc.deckPullFromCollection} all
   * move a row that already exists; this one writes a `collection_entries` row that was never
   * there, and {@link ipc.deckMissingToCollection} is the deck-wide form of the same press. That is the whole reason its caller takes `query.ts`'s `OWNED_WRITE_KEYS` rather than
   * the narrower collection root the three movers share: `CardSummary.ownedQuantity` moves from
   * 0 to N on the very tile the press was made on.
   *
   * **`collection_add` refuses a `deck` folder outright and must go on refusing.** Filing into a
   * group asserts *this deck holds these copies*, which only a write that can answer for the
   * `deck_cards` row behind them may say — so this command is fenced on the deck playing the
   * card (`NOT_IN_DECK`) and passes `collection::DECK_WRITE_FOLDERS` to the private door the
   * deck importer already uses.
   *
   * **The live list only.** A plan holds no cards, so a theory row is refused with no fence of
   * its own to explain it — the menu greys the row instead, which is where a reader can read the
   * reason.
   *
   * **`finish` is the deck row's** — `null` is the regular copy, {@link DeckFinish}'s
   * translation — and the collection word it is recorded under is `nonfoil`. `condition` is the
   * one decision this press makes for the reader — or rather the one it now declines to make,
   * because `MENU_CONDITION` is *not set*. Passed as that constant rather than as a second
   * spelling of whatever it currently holds.
   *
   * **One transaction, so a wish that has moved on rolls the copies back too.** The backend
   * re-reads the named wish against the same predicate {@link ipc.deckQuickAddWishes} used —
   * the dialog's answer is a round trip old — and refuses in words (`WISH_GONE`,
   * `WISH_WRONG_CARD`) rather than recording copies against a wish it could not find.
   */
  deckQuickAddToCollection: (
    deckId: number,
    cardId: string,
    finish: DeckFinish,
    condition: string,
    quantity: number,
    wishId: number | null,
  ) =>
    invoke<DeckQuickAddOutcome>("deck_quick_add_to_collection", {
      deckId,
      cardId,
      finish,
      condition,
      quantity,
      wishId,
    }),
  /**
   * What this deck is short of that could be **recorded** — the read half of the deck-wide add,
   * and the third answer to the question {@link ipc.deckPullPlan} and
   * {@link ipc.deckMissingToWishlist} answer the other two ways: own it, just bought it, have not
   * bought it.
   *
   * Read-only, so it may be asked whenever the dialog is open and re-asked after any write. It
   * takes no variant and reads the `live` list only, for those commands' reason — a plan holds no
   * cards — and no marketplace either, because nothing in the answer is priced.
   *
   * **An empty array is the ordinary answer**, not an error, and it means something specific
   * here: the button that opens the dialog is drawn only where the deck is short of something, so
   * zero rows is a shortfall made entirely of printings that have left the card database. See
   * {@link DeckMissingRow} for that filter, which is the write's own precondition rather than a
   * second opinion, and the dialog words it rather than drawing a blank panel.
   */
  deckMissingPlan: (deckId: number) => invoke<DeckMissingRow[]>("deck_missing_plan", { deckId }),
  /**
   * Record the copies this deck is short of into its own group, and take the unambiguous wishlist
   * lines down with them — the deck-wide form of {@link ipc.deckQuickAddToCollection}.
   *
   * **It _creates_ cardboard**, which is what separates it from
   * {@link ipc.deckPullFromCollection} standing beside it in the same band: a pull moves rows
   * that already exist, and a copy bought this morning is a `collection_entries` row that was
   * never there. The two presses overlap on purpose and the reader chooses — nothing is dropped
   * from either plan because the other could have filled it.
   *
   * **All-or-nothing**, {@link ipc.deckPullFromCollection}'s rule and for its reason: this write
   * files no `deck_undo` step, so a half-applied batch has no press that takes it back. The
   * backend re-plans inside its own transaction and refuses the lot in words — the dialog's
   * answer is a round trip old, and nothing the caller sent is trusted.
   *
   * **`clearWishes` is the whole of the wishlist half, and there is no wish id.** On, every row
   * with *exactly one* matching line has copies taken off it; none and two-or-more are left
   * standing, because a press over thirty rows cannot ask thirty questions. So this write has no
   * stale-wish refusal at all: a line that vanished under the dialog is simply not among the
   * matches and the press carries on, which is the opposite of
   * {@link ipc.deckQuickAddToCollection}'s `WISH_GONE`. See {@link DeckMissingRow.wishes}.
   *
   * Answers what was actually written, which is what a sentence should quote — and the deck's
   * history gets **one** row for the press rather than one per card, because the reader did one
   * thing.
   */
  deckMissingToCollection: (deckId: number, picks: DeckMissingPick[], clearWishes: boolean) =>
    invoke<DeckMissingOutcome>("deck_missing_to_collection", { deckId, picks, clearWishes }),

  /** The format rules as data, in picker order. Seeded by the migration, so this changes at
   *  most once per app version — cached for the session by `useFormatSpecs`. */
  formatSpecs: () => invoke<FormatSpec[]>("format_specs_list"),
};
