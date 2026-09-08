/**
 * Which of the three kinds a deck is — the one place `theoryEnabled` and `virtualOnly` are read
 * together, and the only thing any surface should branch on.
 *
 * **Two booleans on the wire, one word here.** `decks.theory_enabled` and `decks.virtual_only`
 * are separate columns because that is what the schema could grow without rewriting a synced
 * field list — `capture::TABLES` spells its columns by hand and dropping one is the direction
 * `src-tauri/CLAUDE.md` has no rule for. But they are not two independent questions the way the
 * three theory *marks* are: a deck is exactly one of these, and the fourth combination is
 * unrepresentable because Rust writes the other column in the same patch. So the pair is folded
 * into a word once, here, and nothing else in the app asks a deck whether it is `virtualOnly &&
 * !theoryEnabled`.
 *
 * | Kind | `theoryEnabled` | `virtualOnly` |
 * | --- | --- | --- |
 * | `regular` | `false` | `false` |
 * | `theory` | `true` | `false` |
 * | `virtual` | `false` | `true` |
 *
 * **`virtual` wins the impossible row**, and it is worth saying which way rather than leaving it
 * to argument order. A database that somehow holds `true, true` came from a build or a peer this
 * one does not know, and of the two readings the safer is the one that shows the reader *less*
 * of their collection: reading it as `theory` would put a deck that may be tracking cardboard it
 * does not own back in front of every owned count and every wishlist button.
 */

import type { DeckRow } from "@/lib/ipc";

/**
 * The three kinds, as one word each.
 *
 * `theory` rather than `theoryAndActual` because the stored column is `theory_enabled` and this
 * is the value's name, not the label's — {@link DECK_KIND_LABEL} is where the reader's words
 * live. That split is `DeckVariant`'s: `live` is still the column and `Actual` is the tab, and
 * renaming a value to match a label is a migration bought with nothing.
 */
export type DeckKind = "regular" | "theory" | "virtual";

/**
 * The two columns a kind is written as — what {@link deckKindPatch} answers and what
 * {@link deckKind} reads back.
 *
 * Structural rather than `Pick<DeckRow, …>` so a **draft** can be passed too: the settings form
 * holds a value that is not a `DeckRow` and has never been one, and at create there is no row to
 * pick from at all.
 */
export interface DeckKindFlags {
  theoryEnabled: boolean;
  virtualOnly: boolean;
}

/** The kinds in the order the reader meets them, and the order the button group paints. */
export const DECK_KINDS: readonly DeckKind[] = ["regular", "theory", "virtual"];

/**
 * What each kind is called on screen.
 *
 * `Theory + Actual` is the tile badge's own words rather than the settings switch's old
 * `Theory deck`, because the badge and the control are now naming the same three-way choice and
 * a reader who sets one should recognise the other. **Not run through `sortOptions`**: these are
 * three fixed positions in a group, not an option list, and the order is an argument (see
 * {@link DECK_KINDS}).
 */
export const DECK_KIND_LABEL: Record<DeckKind, string> = {
  regular: "Regular",
  theory: "Theory + Actual",
  virtual: "Virtual",
};

/**
 * One line each, for the caption under the group.
 *
 * **Each says what the kind _is_ and then what pressing it _costs_**, and the second half is the
 * half that had to be argued for. It reads oddly on the kind the deck already is — "switching to
 * it" addressed to a reader who switched last week — and it is worth that, because the sentence
 * is only *read* by somebody deciding whether to press. This is the switch's own shape from
 * before it was a group: that caption described both of its directions unconditionally too.
 *
 * **`virtual` is the reason the rule exists rather than an instance of it.** Its press is the
 * only one of the three that moves the reader's *cardboard* — the deck's group is emptied into
 * `Recently removed` — and a control that quietly refiles a collection is exactly what a caption
 * is for. `theory`'s press moves cards between two lists and says so; `regular`'s moves nothing
 * and therefore promises nothing.
 */
export const DECK_KIND_HINT: Record<DeckKind, string> = {
  regular: "One list, checked against the cards you own.",
  theory:
    "A plan beside the list you have actually sleeved up. Switching to it makes the deck you " +
    "have the plan, and starts the actual list empty.",
  virtual:
    "A deck you track without owning the cards — no collection or wishlist, and no missing " +
    "counts. Switching to it files any copies this deck holds into Recently removed.",
};

/** Which kind this deck is. See the module doc for the table and for the impossible row. */
export function deckKind(deck: DeckKindFlags): DeckKind {
  if (deck.virtualOnly) return "virtual";
  return deck.theoryEnabled ? "theory" : "regular";
}

/**
 * The patch that makes a deck this kind — **both columns, always**.
 *
 * Naming only the column that changed would leave the other standing, and the two spell one
 * choice: a `theory` deck patched to `virtual` with `{ virtualOnly: true }` alone would be the
 * `true, true` row this module exists to keep out of the database. Rust writes the pair
 * defensively for the same reason; this is the same rule on the near side, so the two agree
 * rather than one relying on the other.
 *
 * Both fields are always present, so the result drops straight into a `DeckPatch` or a
 * `DeckInput` with no spreading.
 */
export function deckKindPatch(kind: DeckKind): DeckKindFlags {
  return { theoryEnabled: kind === "theory", virtualOnly: kind === "virtual" };
}

/**
 * Does this deck read the collection and the wishlist at all?
 *
 * The question ~10 surfaces used to ask as `variant === "live"` and now have to ask about the
 * deck as well: a virtual deck's rows *are* live rows, so the variant no longer answers it. One
 * predicate rather than `deckKind(deck) !== "virtual"` spelled at each site, because the sites
 * are not asking which kind the deck is — they are asking whether to draw an owned count, and a
 * fourth kind that also owned nothing would want them all to move together.
 */
export function tracksCollection(deck: DeckKindFlags): boolean {
  return !deck.virtualOnly;
}

/**
 * The kind of a whole {@link DeckRow}, for the callers that have one.
 *
 * A convenience over {@link deckKind} and not a second definition — it exists so the gallery and
 * the card menu, which hold rows and not drafts, do not each spell the `Pick`.
 */
export function rowKind(deck: Pick<DeckRow, "theoryEnabled" | "virtualOnly">): DeckKind {
  return deckKind(deck);
}
