/**
 * What a deck's tile shows about it before its name — the cover it may draw and the badge that
 * says what kind of deck it is — with nothing about how a tile is pressed, dragged or renamed.
 *
 * **A module of its own because a second face draws decks.** `DeckTile`'s own note on
 * {@link coverUrl} asked for this: "if a third surface ever draws a cover, these three lines want
 * a shared home rather than a third copy". The phone gallery is that surface, and it draws its own
 * tile — the desktop's carries a hover tray, a drag source and an inline rename, none of which a
 * phone has — so the *rules* are what it shares, from here. `DeckTile.tsx` re-exports
 * {@link deckBadge} and {@link DeckBadge}, so nothing that imported them from there changed.
 */
import { cardImageUrl } from "@/lib/images";
import type { DeckRow } from "@/lib/ipc";
import { rowKind } from "./deckKind";

/**
 * What kind of deck this is, in one word — which of its two lists exist, or that it keeps no
 * cardboard at all. The one thing a tile can say about a deck that a card count cannot.
 *
 * Derived rather than stored, from fields `deck_list` already answers.
 * {@link DeckRow.cardCount} counts the **actual** list only, so a deck with theory switched on
 * and nothing in that list is a plan and not yet a deck: `THEORY ONLY`. One derivation, because
 * a badge and the editor's Theory/Actual switch must never disagree about which lists a deck
 * has.
 *
 * **A deck that keeps no plan wears no badge at all**, and that is the caption's `Any` argument
 * read across: one list is what every deck is born with, so a word for it would sit on nearly
 * every tile in the gallery and say nothing about the deck under it. The badge is here to mark
 * the deck that is *not* the ordinary case, and `null` is the answer for the deck that is.
 *
 * **A Virtual deck earns a word by exactly that test, and it is why widening this was not a
 * betrayal of the argument above** (issue #401). `regular` is still `null` and still for the
 * same reason. But a deck the reader tracks without owning the cardboard reads nothing off
 * their collection — no owned count, no shortage mark, no wishlist — so a tile that said nothing
 * would be a deck whose whole *relationship to the binder* is invisible until it is opened.
 * That is the badge's job: one list is unremarkable, and no cardboard is not.
 *
 * **It answers before the theory arms, and {@link rowKind} is what makes that structural.**
 * `theory_enabled` and `virtual_only` are two columns spelling one three-way choice, and the
 * impossible `true, true` row resolves to `virtual` in the one place that folds them — see
 * `deckKind.ts`, which argues why that is the safer of the two readings. Asking the flags here
 * in this file's own order would be a second answer to that question, agreeing today.
 *
 * `THEORY ONLY` is the state **switching the theory list on now produces**, rather than an
 * unusual one: the write moves the actual list into the plan and leaves it empty, so the badge
 * reads the deck the way the editor does from that moment.
 *
 * **`Actual` is the word and `live` is still the stored variant** — the split the editor's
 * switch argues, which this file only follows. Issue #357 was this badge still reading
 * `LIVE + THEORY` a week after the tabs stopped: the vocabulary a reader meets inside a deck and
 * the one on its tile are one vocabulary. A Virtual deck's rows are `live` rows too, which is
 * exactly why its badge cannot be built out of the variant either.
 */
export type DeckBadge = "VIRTUAL" | "THEORY + ACTUAL" | "THEORY ONLY";

export function deckBadge(deck: DeckRow): DeckBadge | null {
  const kind = rowKind(deck);
  if (kind === "virtual") return "VIRTUAL";
  if (kind === "regular") return null;
  return deck.cardCount === 0 ? "THEORY ONLY" : "THEORY + ACTUAL";
}

/**
 * Has this deck a cover the app is **allowed** to draw — a printing, and an illustrator to
 * credit it to? "No cover" means *you have not chosen one*; a deck that has chosen one and
 * cannot be handed its bytes says "No image", which is the same sentence a failed fetch gets and
 * the true one.
 *
 * **The illustrator half of this test survived the credit line's deletion, and it still means
 * what it said** (2026-09-07). The `Art by` row under the tile is gone, but the name did not go
 * with it — it moved onto the picture as {@link Cover}'s tooltip — so the condition this guard
 * enforces is unchanged: a crop is drawn only where the app can name who painted it. Reading
 * this the other way round is the mistake to avoid, and it is an easy one for a reader arriving
 * after that change: the guard was never *about* the line, it was about the crop.
 */
export function hasCover(deck: DeckRow): boolean {
  return deck.coverCardId !== null && deck.coverArtist !== null;
}

/**
 * A deck's cover as a URL — or `null` when it has none, or none this app may draw.
 *
 * **A cover this app cannot credit is not drawn at all, and that is as true after 2026-09-07 as
 * before it.** Scryfall's rule — `https://scryfall.com/docs/api`, under the image guidelines, and
 * *not* `docs/api/images`, which carries no artist rule at all any more — is that an `art` crop,
 * having no printed frame, may be shown only in an interface that names the illustrator. So if
 * the credit cannot be shown, neither can the crop. What changed is only *where* the credit is
 * shown: it is {@link Cover}'s tooltip rather than a line of text under the tile, so the artist
 * is still named and this condition still means exactly what it said.
 * `DeckRow.coverArtist` is `null` exactly when
 * the printing has left `cards`, and it comes back on the next sync that brings the printing
 * back, so this is a state that heals itself and never a picture permanently withheld. The frame
 * then says "No cover" rather than claiming a failure, because from the reader's side that is
 * what it is: nothing to show yet.
 *
 * **It used to be two arms and a `coverKind` test, and the deletion is what makes the rule above
 * unconditional.** A deck could also wear a picture the reader had chosen off disk, served at
 * `/cover/<deckId>` — and it carried *both* covers at once, since setting either left the other
 * alone, so `coverKind` was the only answer to which one was showing. Two things follow from its
 * going and both are simplifications rather than losses: the policy no longer has to be kept off
 * one of the arms (a reader's own photograph has no Scryfall illustrator, so an artist test there
 * would have hidden every custom cover — which read like a missing guard and was the opposite),
 * and a `custom` row arriving from a device on an older rung draws its card art, which is what
 * every device but the uploader already drew.
 *
 * `DeckCoverPicker`'s `CoverPreview` makes the same decision in the same words, which is the
 * point: the gallery and the dialog draw one picture and used to disagree about this exact case.
 * If a third surface ever draws a cover, these three lines want a shared home rather than a
 * third copy.
 */
export function coverUrl(deck: DeckRow): string | null {
  return deck.coverCardId !== null && deck.coverArtist !== null
    ? cardImageUrl(deck.coverCardId, 0, "art")
    : null;
}
