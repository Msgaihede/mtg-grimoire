/**
 * **Which finish a card is shown as, and the words for changing it** — shared by the card modal's
 * finish buttons (`CardModalArt`) and the finish rows of its right-click menu (`cardMenu.tsx`'s
 * `finishPick`), so the two can never offer different finishes or name them two ways (issue
 * #1679). The deck card menu's `Set as …` rows borrow the word ({@link finishChoiceWord}), so a
 * Surge Foil reads `surge foil` on all three (issue #1690).
 *
 * Presentation rules rather than domain logic: what a printing *is* stays in `@/lib/finish`, and
 * this file only decides what the reader is offered about it.
 */
import { Gem, RectangleVertical, Sparkles } from "lucide-react";
import { FINISH_LABEL, parseFinishes, recordableFinishes, type Finish } from "@/lib/finish";
import type { DeckFinish } from "@/lib/ipc";
import { finishTreatments } from "@/lib/treatment";

/**
 * The finishes a reader can switch between on this printing — every finish it lists, or none.
 *
 * **Every finish, and only where there are two or more** (issue #1679). The modal's row used to
 * be a single foil toggle, which could only ever be about one shiny finish: a printing sold
 * nonfoil, foil *and* etched had to pick one of its two shiny answers for the toggle to be about
 * (issue #1561's `own`), and a foil+etched printing — no plain copy to toggle back to — had no
 * control at all. One choice per finish answers both, in the printing's own order (Scryfall's,
 * which is `FINISHES`': plain, then the premium treatments).
 *
 * A single-finish printing gets none: there is nothing to switch to, and `soleFinish` — which
 * states what the cardboard simply *is* — already speaks for it. An unknown list (`[]`) gets none
 * either, because nothing is known to offer.
 */
export function switchableFinishes(finishesJson: string | null): Finish[] {
  const finishes = parseFinishes(finishesJson);
  return finishes.length >= 2 ? finishes : [];
}

/**
 * The finish the card modal opens showing.
 *
 * The deck row's (or the copy's) own finish first — `null` there is the regular copy — then the
 * finish the opening surface named, where this printing was made in it, then the most ordinary
 * finish the printing is sold in, which is `recordableFinishes`' first answer: `nonfoil` for
 * nearly every printing and `foil` for a foil+etched one.
 *
 * Exported because two readers need the same answer from the same inputs: the art column seeds
 * its own view from it, and the modal's host reads it for the right-click menu's rows until the
 * reader has picked a finish (`viewedFinish`).
 */
export function seededFinish(
  finishesJson: string | null,
  deckRow: { finish: DeckFinish } | null,
  openedAs: Finish | null,
): Finish {
  if (deckRow !== null) return deckRow.finish ?? "nonfoil";
  const listed = parseFinishes(finishesJson);
  if (openedAs !== null && (listed.length === 0 || listed.includes(openedAs))) return openedAs;
  return recordableFinishes(finishesJson)[0];
}

/**
 * The glyph a finish choice draws: `FinishMark`'s own two for the shiny finishes, and a plain
 * card for the regular one, which has no mark of its own anywhere else because nothing needs to
 * say a card is ordinary — but a choice beside two glyphed ones needs a picture too.
 */
export const FINISH_GLYPH: Record<Finish, typeof Sparkles> = {
  nonfoil: RectangleVertical,
  foil: Sparkles,
  etched: Gem,
};

/**
 * **The word a finish choice names its finish by**, lower-case — and for the foil copy that is
 * *the kind of foil* where the printing names one: `surge foil`, `mana foil`, `oil slick raised
 * foil` (issue #1690).
 *
 * The card modal's price cell under the buttons already read `Surge Foil  $1.33` while the button
 * over it said `Set as foil`, so one panel named one piece of cardboard two ways. This is the
 * cell's word (`finishTreatments`, first match in `CARD_TREATMENTS` order, `PAIRS` first) with
 * two fences the cell does not need:
 *
 * - **A foil word only, never a trait.** A choice tells two finishes of one printing apart, and
 *   a trait — Serialized, Scroll, Poster — is true of the cardboard in *every* finish, so it
 *   cannot: a serialized printing would offer `View as serialized` twice.
 * - **On `foil` only.** Etched is etched whatever else the printing is called, which is
 *   `foilEffect`'s rule too: the press puts the etched drawing on the picture, so the word for
 *   it is `etched`. The plain copy never carries a foil word (`finishTreatments`' fence).
 *
 * Shared with the deck card menu's `Set as …` rows (`deckCardMenu.tsx`), so a deck card names its
 * foil the way the modal over it does. `nonfoil` answers `nonfoil`; a write arm that wants
 * `regular` says so itself.
 */
export function finishChoiceWord(finish: Finish, promoTypes: string | null): string {
  const kind =
    finish === "foil" ? finishTreatments(promoTypes, finish).find((t) => t.foil) : undefined;
  return (kind?.label ?? FINISH_LABEL[finish]).toLowerCase();
}

/**
 * What a finish choice says, and it says what the press **does** — always naming the finish it
 * is the choice for (issue #1679), and the kind of foil the printing is where it has one
 * ({@link finishChoiceWord}, issue #1690).
 *
 * `Set as …` where the press writes (a deck row, or a collection copy being edited) and
 * `View as …` where it only changes the picture, because those are two different acts and a
 * label naming only the visible half would be a control that quietly edits a deck. **`regular`
 * rather than `FINISH_LABEL.nonfoil`** on the write arm: "set as nonfoil" is not a thing anybody
 * says, and `Regular` is the word the deck card's own menu uses for the same choice. The view arm
 * keeps the wording the pane shipped with.
 *
 * `promoTypes` is the printing's `promo_types` column, as stored. **Required rather than
 * defaulted**, because a caller that forgot it would go on compiling and quietly put `Set as
 * foil` back over a Surge Foil — the bug this parameter exists to fix.
 */
export function finishChoiceLabel(
  finish: Finish,
  writes: boolean,
  promoTypes: string | null,
): string {
  if (writes)
    return `Set as ${finish === "nonfoil" ? "regular" : finishChoiceWord(finish, promoTypes)}`;
  return `View as ${finishChoiceWord(finish, promoTypes)}`;
}
