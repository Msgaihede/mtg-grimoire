/**
 * What a deck's notes mean, as the surfaces that draw them need it.
 *
 * **Rust supplies the facts and this file draws every conclusion**, which is the boundary the
 * rest of the deck builder keeps. `deck_notes` hands over the rows — a title, a body, a sort
 * order and the oracle ids each note names — and every one of those is true whether or not
 * anything is ever rendered. What a *blank* title reads as, which cards carry a mark, and which
 * notes a card menu lists are decisions, and they live here, in one file with one test, so that
 * changing a rule is one edit and not four components disagreeing.
 *
 * **No command answers "which cards in this deck have notes".** The band has already read every
 * note and every note carries its oracle ids, so {@link notedOracleIds} builds that set from the
 * read the page has made. A second command would be a second source of truth for a fact already
 * in hand — and one that could be a frame behind the list beside it.
 *
 * **A note's title is derived and never stored empty-then-filled.** A stored derivation would go
 * stale the moment the body was edited and there is no writer that could notice, which is why
 * `deck_notes.title` is allowed to be `''` and this file answers the question instead.
 */

import type { DeckCard, DeckNote } from "@/lib/ipc";
import type { ImageVariant } from "@/lib/images";
import { OTHER, TYPE_BUCKETS, typeBucket } from "./deckBuckets";
import { noteToPlainText } from "./noteMarkdown";

/**
 * What a note with neither a title nor a body is called.
 *
 * Exported so the band, the card menu and the modal print the same three words: three call
 * sites each spelling their own fallback is three chances for them to drift, and a reader
 * seeing two different names for one note has no way to tell it is one note.
 */
export const UNTITLED_NOTE = "Untitled note";

/**
 * What to print on the one line a note gets.
 *
 * Three arms, in order: the stored title, the body's first line with its markup gone, and then
 * the honest admission. The middle one is why this is a function and not a field — a blank
 * title is legal, and the first line of what the reader actually wrote is a better name than
 * nothing at all.
 *
 * **Unmarked, and never truncated.** `## Mana base` answers `Mana base`, because a row that
 * printed the hashes would be showing a reader their own markup back. The length is left alone
 * for {@link noteToPlainText}'s reason: a clamp is a decision about how wide a row is, and the
 * band, a submenu and a modal row have three different answers.
 *
 * Takes a `Pick` rather than a whole {@link DeckNote} so that a `CardNote` — the `card_notes`
 * read, which carries a title and a body and no attachments — is named by this same function.
 * Two title rules for one kind of thing is exactly the drift this file exists to prevent.
 */
export function noteTitle(note: Pick<DeckNote, "title" | "body">): string {
  const stored = note.title.trim();
  if (stored) return stored;
  const [first = ""] = noteToPlainText(note.body).split("\n");
  return first.trim() || UNTITLED_NOTE;
}

/**
 * Every oracle id any of these notes names — the set the card marks read.
 *
 * A `Set` and not a list, because the only question ever put to it is `has`, once per card
 * drawn: a deck view draws hundreds of tiles and a linear scan per tile would make the mark
 * cost more than the card.
 *
 * The empty string is kept out for {@link notesForCard}'s reason: a card whose oracle id is
 * missing must not find one here by accident.
 */
export function notedOracleIds(notes: readonly DeckNote[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const note of notes) {
    for (const card of note.cards) {
      if (card.oracleId) ids.add(card.oracleId);
    }
  }
  return ids;
}

/**
 * The notes that name this card, in the order the deck holds them.
 *
 * ⚠️ **An absent oracle id answers nothing, and that guard is the point of the function.** An
 * orphan printing — one whose row the corpus no longer carries — has `oracleId: null`, and the
 * two natural ways to write this filter both answer *everything* for it: a loose `==` matches a
 * missing id against a missing id, and a `cards.every(...)` is vacuously true for every note
 * that names no card at all. Either one puts the whole deck's notes behind a card nobody wrote
 * one about.
 *
 * Returns a new array. The input is a query cache's own array and is never reordered in place.
 */
export function notesForCard(notes: readonly DeckNote[], oracleId: string | null): DeckNote[] {
  if (!oracleId) return [];
  return notes.filter((note) => note.cards.some((card) => card.oracleId === oracleId));
}

/**
 * One card a note can be told to name, as the picker draws it.
 *
 * **One entry per oracle id, because a note names a card and not a printing.** One note naming
 * Lightning Bolt names it once, however many copies, printings or finishes the deck holds — and a
 * picker offering the same card four times would be four presses that all did the same thing.
 *
 * It is no longer an alias of {@link DeckNoteCard}, which it was until the redesign: the picker's
 * row draws a picture, a printing and a type beside the name, and an attached card carries none of
 * those. The two are still built from one list and read side by side, which is why `oracleId` and
 * `name` are spelled the same way in both.
 */
export interface NoteCardChoice {
  oracleId: string;
  name: string;
  /** The printing this row draws — the **first** row the deck lists for this oracle id, which is
   *  the deck's own order and therefore the copy the reader is looking at. */
  cardId: string;
  imageUris?: Partial<Record<ImageVariant, string>> | null;
  setCode: string;
  collectorNumber: string;
  /** `deckBuckets.ts`' bucket for the **front** face — what the chips filter on. */
  typeBucket: string;
  /** Every copy of this card in the list handed in, folded. Drawn as `4×`; it names nothing and
   *  is never written — a note names a card, not a quantity of one. */
  copies: number;
}

/**
 * The deck's own cards, as the picker offers them.
 *
 * **A row with no oracle id is dropped rather than offered.** That is an orphan printing — a card
 * the corpus has since stopped carrying — and there is no id to attach; offering it would be a
 * press that could only be refused.
 *
 * **Both variants of a deck arrive here as one list**, which is the panel's own arrangement: the
 * band holds no `variant`, because `deck_notes` has no variant column and a note written against
 * the plan shows on the actual list too.
 */
export function attachableCards(cards: readonly DeckCard[]): NoteCardChoice[] {
  const byOracle = new Map<string, NoteCardChoice>();
  for (const card of cards) {
    if (card.oracleId === null) continue;
    const seen = byOracle.get(card.oracleId);
    if (seen) {
      seen.copies += card.quantity;
      continue;
    }
    byOracle.set(card.oracleId, {
      oracleId: card.oracleId,
      name: card.name,
      cardId: card.cardId,
      imageUris: card.imageUris,
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      typeBucket: typeBucket(card.typeLine),
      copies: card.quantity,
    });
  }
  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** The two rungs of the picker's radiogroup that are not a card type. Keys rather than labels at
 *  every call site, because the label is English and the key is the state. */
export const ALL_CHIP = "all";
export const NAMED_CHIP = "named";

/**
 * The picker's rungs, with a count on each: `All`, `Named`, then one per type the deck holds.
 *
 * **Cards and never copies.** Twenty Mountains are one row in this list and one thing a note can
 * name, so a chip reading `Land 20` beside a list showing one Land row would be two numbers for
 * one fact.
 *
 * **Types rather than piles**, which is where this parts company with the spec it was drawn from:
 * a type is a fact about the card and a pile is the reader's own filing, and `deck_categories` has
 * no unique index on the word, so two piles may legally share a name and fold into one chip that
 * stood for both. `typeBucket` reads the **front** face of a `//` line, which is the rule a modal
 * DFC needs.
 *
 * **`Named` is drawn at zero and the type chips are not.** Named is how a reader checks their own
 * work — *have I named anything yet* is a question a `0` answers — where a `Planeswalker 0` on a
 * burn deck is a rung that filters to an empty list nobody asked about.
 */
export function typeChipCounts(
  choices: readonly NoteCardChoice[],
  namedCount: number,
): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const choice of choices) {
    counts.set(choice.typeBucket, (counts.get(choice.typeBucket) ?? 0) + 1);
  }
  const order = [...TYPE_BUCKETS, OTHER];
  return [
    { key: ALL_CHIP, label: "All", count: choices.length },
    { key: NAMED_CHIP, label: "Named", count: namedCount },
    ...order
      .filter((label) => counts.has(label))
      .map((label) => ({ key: label.toLowerCase(), label, count: counts.get(label) ?? 0 })),
  ];
}
