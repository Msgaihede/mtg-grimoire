import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

/**
 * What a drag is carrying, and the only shape a drop target here will act on.
 *
 * Three kinds, because there are three things a drop can mean: a printing that is not in the
 * deck yet (`deck_add_card`, which folds into whatever the category already holds), a row that
 * is (`deck_move_card`, which takes every copy with it), and a card picked up **anywhere else
 * in the app** — a search tile, a collection row, a wish, a printings row. A target reads the
 * kind rather than guessing from what is on screen, so the search panel and a category column
 * can never be mistaken for each other.
 *
 * `"card"` and `"search-card"` mean the same thing to a category (one copy, added) and are two
 * kinds all the same: the panel's tile is *inside* the editor and the other four surfaces are
 * not, and the day a target wants to know which wall a card came from — the sidebar's own
 * entries are the first — the answer has to be in the payload rather than deduced from where
 * the pointer happens to be.
 *
 * Every drag into a deck has a click path beside it — the panel's Add button, the toolbar's
 * quick add, and the quick-add on every surface that carries a `"card"`. Speed, not capability,
 * with **one measured exception**: a printings row dragged to the sidebar's Decks entry adds
 * that printing to the open deck, and the card pane offers no button that does it (its quick-add
 * writes the collection or the wishlist, and "Use this printing" *replaces* a row the deck
 * already has). So this gesture is the one route with no click equivalent **on the surface it
 * starts from** — the deck is not closed to the keyboard, because the docked panel's Add takes
 * any printing that panel's own search can reach. If that detour stops being acceptable, the
 * answer is a button in the pane, not a rule here.
 *
 * **`"deck-card"` is carried by every card in every view**, through `cardControl.tsx`'s
 * `useDeckCardDrag` — one registration, four surfaces, so a card picked up in the table means
 * exactly what the same card picked up in the stack means.
 *
 * **The two adding kinds carry a `typeLine`, and `"deck-card"` deliberately does not.** A drop
 * that adds may have no category to land in — the sidebar's Decks entry is a nav item several
 * views away from the deck, with no column for a reader to have pointed at — and the rule that
 * files it is `autoCategoryFor`, which reads a type line and nothing else. Carrying the line in
 * the payload is what lets that rule run without a round trip: every one of the five sources
 * has it in hand at registration (`CardSummary`, a collection row, a wish, the pane's
 * printings, the panel's tile).
 *
 * **`"deck-card"` still does not carry one, and the reason changed on 2026-08-15.** It used to
 * be that a move or a removal names its category by construction, so there was nothing to
 * compute — and then the quick zones' `Auto` gave a deck card a drop that *is* computed, which
 * looked like the argument for widening the payload. It is not: the four sources above are
 * outside the editor and have only what they carry, while a `"deck-card"` drag is a row of the
 * deck the editor is drawing, so the editor is already holding the type line, the tags query and
 * the card's current pile. Sending a copy along would be a second spelling of a fact one
 * component away, and the one that goes stale is the copy.
 *
 * `null` is a real value here and means the app does not know — an orphaned row whose printing
 * has left `cards`. `autoCategoryFor` answers `Uncategorised` for it, which is the honest pile.
 */
export type DragPayload =
  | { kind: "search-card"; cardId: string; name: string; typeLine: string | null }
  | { kind: "deck-card"; cardId: string; name: string; fromCategoryId: number }
  | { kind: "card"; cardId: string; name: string; typeLine: string | null };

/**
 * Where a payload was let go: one of the deck's categories, the tray that takes cards out, or
 * the quick zone that files a card by what it does.
 *
 * **`"auto"` is a target rather than a category id, because there is no id to name.** The pile
 * an auto add lands in is decided *per card* by `autoCategoryFor` — over a type line and the
 * card's Oracle tags — and that rule runs inside `useDeck.addCard`, one layer above this one.
 * Spelling it as a category here would mean inventing an id for a pile that may not exist yet.
 */
export type DropTarget =
  { kind: "category"; categoryId: number } | { kind: "remove" } | { kind: "auto" };

/**
 * The write a drop means — named for the command it becomes, and carrying nothing the editor
 * does not already need to send.
 *
 * Addressed by the slot (`cardId` + category) rather than by `deck_cards.id`, like every other
 * write in this feature: a stale row id is the difference between emptying the slot the
 * reader dropped and emptying one that has since been refilled.
 */
export type DeckWrite =
  | { write: "add"; cardId: string; categoryId: number }
  /**
   * One copy, filed by what the card *does* — the quick zones' `Auto`, and the same write the
   * toolbar's `Add to → Auto (by what it does)` makes.
   *
   * A separate arm rather than an `add` with a sentinel id, because it carries a different
   * thing: `categoryId` names the pile and this names the **card**, leaving the pile to
   * `autoCategoryFor`. The type line travels because the payload already has it — see
   * {@link DragPayload} — and `null` is a real answer that files under `Uncategorised`.
   */
  | { write: "auto-add"; cardId: string; typeLine: string | null }
  /**
   * Re-file a card the deck already holds by what it *does* — the quick zones' `Auto` for a
   * `"deck-card"` drag.
   *
   * **An address and not a destination**, which is what makes it a separate arm from `"move"`:
   * the pile is not known here and cannot be, because the rule that names it reads the card's
   * Oracle tags over IPC. `from` travels because a move needs the slot it is leaving, and the
   * type line does not, because the caller is holding the row this addresses.
   */
  | { write: "auto-refile"; cardId: string; from: number }
  | { write: "move"; cardId: string; from: number; to: number }
  | { write: "remove"; cardId: string; categoryId: number };

/**
 * The mark that says a payload is one of this app's card drags, and its key.
 *
 * Named for the deck editor, where the contract was written and where every drop target still
 * lives; it is the app's card-drag mark now that four surfaces outside the editor carry one,
 * and the *string* is a fence rather than a description — renaming it would be a rename for
 * nothing.
 *
 * A drop target is handed whatever the drag is carrying, and the type it is handed is
 * `Record<string, unknown>` — the library's store is untyped by construction, because every
 * `draggable` in a window writes into it. A drag from *outside* the window cannot reach
 * these targets at all (a file or a selection from another app arrives through the library's
 * separate external adapter, whose drop targets are registered separately and are not these),
 * so this is not a fence against the desktop. It is a fence against **this app's own next
 * draggable**: the moment a second feature drags something, `{ kind, cardId, name }` from it
 * would otherwise be a card these zones would add.
 */
const MARK = "mtg-grimoire/deck-drag";
const MARK_KEY = "dragSource";

/**
 * Whether a value could be a `deck_categories.id`.
 *
 * Schema v8 turned the fixed five-word zone into a row the user owns, so the fence that used
 * to be an exhaustive `Record<DeckZone, true>` is now a shape check and nothing more — there
 * is no closed list of category ids to check against, and the payload is written by this
 * app's own draggables rather than by anything a reader can type. What is still worth
 * refusing is a value that would address *every* row or *no* row: a float, a NaN, a zero, a
 * negative, a string of digits. `Number.isSafeInteger` answers all of those in one call, and
 * refusing here is what keeps `deck_move_card` from being handed a `from` it cannot mean.
 */
function isCategoryId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A name is allowed to be empty — a row denormalizes whatever `cards` had — but an id is
 *  not: an empty `cardId` addresses every row and no row. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** What a draggable hands the adapter. Flat, so `canDrop` can read the kind without
 *  unwrapping anything. */
export function dragData(payload: DragPayload): Record<string, unknown> {
  return { [MARK_KEY]: MARK, ...payload };
}

/**
 * What a press inside a card does **not** start a drag from.
 *
 * A control marks itself, because the alternative — excluding every `button` — would take
 * the card's own name away as a place to grab a row (it is a button: the keyboard's way into
 * the card) and would make a search tile undraggable altogether, since its art is a button
 * covering nearly all of it. Fields are excluded outright whether marked or not: a press in a
 * text field is a text selection, never a drag.
 *
 * **Anything added inside a card that owns its own press marks itself `data-no-drag`.**
 */
export const NOT_A_DRAG = "[data-no-drag], input, select, textarea";

/**
 * The second DOM contract a deck card control carries: the **slot** it draws, as
 * `"<category id>:<card id>"` — the address every deck write is made to.
 *
 * How the card pane hands the caret back when it closes after a swap. An attribute rather than
 * a ref because the pane is not in the deck's tree and owns none of its elements — and least of
 * all *this* element, whose whole story is that the swap replaces it: the row it was drawn from
 * is deleted and the new printing's row is a different React key, so a ref taken when the pane
 * opened points at something unmounted by the time Escape is pressed. A slot is a question the
 * DOM can answer after the fact.
 *
 * Here rather than on a view, because it is a contract between two components that share no
 * tree; this module is already where a card control's DOM contracts live ({@link NOT_A_DRAG}
 * above).
 *
 * Written by `cardControl.tsx`'s `deckCardProps` and therefore by all four views — on the card's
 * own button, or on the row in the table, because what the pane does with it is hand the caret
 * back and the caret needs somewhere that takes focus. `App.test.tsx`'s "hands the caret back to
 * the deck's card after a swap" is the only test in the repo that notices it going missing,
 * which it did for exactly one task of the rebuild.
 */
export const DECK_CARD_ATTR = "data-deck-card";

/**
 * The value of {@link DECK_CARD_ATTR} for one slot — one spelling, both sides of the lookup.
 *
 * **No deck id, because one editor is mounted at a time**: `openDeckId` is a single id, and
 * `setOpenDeckId` clears `paneDeckContext` in the same write — so every marked control on the
 * page belongs to the deck the context names, and the pane's document-wide `querySelector` is
 * deck-scoped by construction. A category id is per-deck and unique across the whole table,
 * which makes this stronger than the zone word it replaces rather than weaker — but the deck
 * scoping is still the single open editor's, not this string's.
 */
export function deckCardSlot(categoryId: number, cardId: string): string {
  return `${categoryId}:${cardId}`;
}

/**
 * A card that can be picked up — and a press on one of its controls that is a press on the
 * control, not on the card.
 *
 * **Why this exists at all.** A whole deck row is draggable, and a deck row is full of
 * controls: a stepper, a menu trigger, the menu itself. Chromium starts a drag from the
 * nearest draggable *ancestor* of whatever was pressed, and the drag library adds no
 * exclusion of its own — so without this, a press on the stepper's `−` plus five pixels of
 * travel is a drag of the whole row, the click that was meant is never delivered, and letting
 * go over the remove tray takes every copy out of the deck with nothing to undo it.
 * **Measured in the running window before it was fixed** (2026-08-05): 4 copies moved zones
 * from a press on `−`.
 *
 * `canDrag` is asked at `dragstart` and is handed the pointer's coordinates rather than what
 * it pressed, so the press is remembered here: `mousedown` always precedes `dragstart` (a
 * native drag is a mouse gesture — Chromium starts none from touch), and the listener is in
 * the **capture** phase on the card itself so a control that stops the press from propagating
 * cannot hide it from this.
 */
export function cardDraggable({
  element,
  payload,
  notFrom = NOT_A_DRAG,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a row that has been renumbered since it mounted still carries
   *  what it is now. */
  payload: () => DragPayload;
  /** Overridable for the one case where the default is wrong — nothing today. */
  notFrom?: string;
}): () => void {
  let onControl = false;
  const press = (event: Event) => {
    const target = event.target;
    onControl = target instanceof Element && target.closest(notFrom) !== null;
  };
  element.addEventListener("mousedown", press, true);
  const stop = draggable({
    element,
    canDrag: () => !onControl,
    getInitialData: () => dragData(payload()),
  });
  return () => {
    element.removeEventListener("mousedown", press, true);
    stop();
  };
}

/**
 * The payload a drop target may act on, or `null` for everything else.
 *
 * Field by field rather than a cast: this is the app's boundary with the drag library's own
 * store, and the one place where "it type-checked" means nothing at all.
 */
export function readDragData(data: Record<string, unknown>): DragPayload | null {
  if (data[MARK_KEY] !== MARK) return null;
  const { kind, cardId, name, fromCategoryId, typeLine } = data;
  if (!isId(cardId) || typeof name !== "string") return null;
  if (kind === "search-card" || kind === "card") {
    // A type line is normalised to `null` rather than refused, and that is the difference
    // between this field and the two above it: `cardId` and `name` decide *what* is being
    // dropped and a bad one has to stop the drop, while this only decides which pile the card
    // lands in — and `autoCategoryFor` already has an answer for not knowing. A source that
    // sends nothing (or sends rubbish) files under `Uncategorised` instead of failing to drop.
    return { kind, cardId, name, typeLine: typeof typeLine === "string" ? typeLine : null };
  }
  if (kind === "deck-card" && isCategoryId(fromCategoryId)) {
    return { kind, cardId, name, fromCategoryId };
  }
  return null;
}

/**
 * What a drop should write, or `null` when it should write nothing.
 *
 * One rule, asked twice: a target asks it in `canDrop` — so a drop that would mean nothing
 * never lights up and never accepts the card — and asks it again on the drop itself, because
 * the two questions can be a second apart and only the second one writes.
 */
export function dropWrite(payload: DragPayload, target: DropTarget): DeckWrite | null {
  if (target.kind === "remove") {
    // Nothing to remove: a search result — or a card from any other wall — is a printing in
    // the database, not a row in this deck. The tray is only drawn for a deck-card drag for
    // the same reason.
    if (payload.kind !== "deck-card") return null;
    return { write: "remove", cardId: payload.cardId, categoryId: payload.fromCategoryId };
  }
  if (target.kind === "auto") {
    // **A card already in the deck is re-filed rather than refused** (changed 2026-08-15). This
    // used to return `null` on the argument that `"deck-card"` carries no `typeLine`, so there
    // was nothing for `autoCategoryFor` to read — true about the *payload* and the wrong place
    // to conclude anything from it. The editor is holding the row, type line and all; the fact
    // was never missing, only absent from the one channel this function can see. So the answer
    // here is the **address** of the card to re-file, and the caller supplies the fact, exactly
    // as it already does for the pile a `"move"` lands in.
    if (payload.kind === "deck-card") {
      return { write: "auto-refile", cardId: payload.cardId, from: payload.fromCategoryId };
    }
    return { write: "auto-add", cardId: payload.cardId, typeLine: payload.typeLine };
  }
  if (payload.kind === "search-card" || payload.kind === "card") {
    // One copy, exactly as the panel's Add button sends — and `deck_add_card` folds, so
    // dropping the same card twice is two copies rather than a refusal. The two kinds are one
    // write here: where a printing was picked up does not change what putting it in a category
    // means.
    return { write: "add", cardId: payload.cardId, categoryId: target.categoryId };
  }
  // Back where it came from is not a move: it would touch the deck, reallocate and bump
  // `updated_at` to leave the list exactly as it was.
  if (payload.fromCategoryId === target.categoryId) return null;
  return {
    write: "move",
    cardId: payload.cardId,
    from: payload.fromCategoryId,
    to: target.categoryId,
  };
}
