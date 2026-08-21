/**
 * How a printing has to be *turned* to be read, and which meld counterparts it offers.
 *
 * The sibling of `faceCount` in `./printings.ts`, and deliberately the question that one
 * does not answer. `faceCount` says how many physical **sides** a piece of cardboard has,
 * and it says `1` for `split`, `adventure` and `flip` because those layouts print two faces
 * on one side — so the pane offers no flip control for them and is right not to. But
 * "one side" does not mean "readable as it lies": three of this app's layouts print some of
 * their text at ninety or a hundred and eighty degrees to the rest, and a reader with no way
 * to turn the picture simply cannot read that half. This module is that second axis.
 *
 * Here rather than in Rust for CLAUDE.md's reason: Rust hands over *facts* — a layout string
 * and the `card_faces` blob — and every conclusion below is a judgement about what is printed
 * on the cardboard, drawn from those facts and testable in milliseconds. Nothing on this page
 * does I/O, and nothing imports React.
 *
 * Every rule was checked against the printed image of a named card and against the live
 * 116 590-row card database on **2026-08-21**; the counts are from that database.
 */
import type { CardFace } from "@/lib/ipc";

/** A quarter turn clockwise, a quarter turn counter-clockwise, or a half turn. */
export type CardTurn = 90 | -90 | 180;

/**
 * Whether this `split` printing is an **Aftermath** card, told from its second face's rules
 * text.
 *
 * A rules-text prefix is a horrible thing to branch on, and this is the one place in the app
 * licensed to do it, because the honest signals are both gone: Scryfall **retired the
 * `aftermath` layout** — all 347 live split printings carry `layout: "split"`, Aftermath and
 * classic alike — and moved the word into a per-face `keywords` array that this app has no
 * column for and does not sync. What is left is the printed text itself, where "Aftermath"
 * is a keyword ability and therefore the *first* word of the bottom half's box.
 *
 * The licence is a measurement rather than an argument: on 2026-08-21 this test agreed with
 * Scryfall's own `keywords` array on **347 of 347** live split printings — **0**
 * disagreements — 96 of them Aftermath. If a future sync adds a `keywords` column, this
 * function is what it replaces.
 *
 * A `split` row that arrived with fewer than two faces cannot be Aftermath: the whole
 * distinction is a fact about the second half, and a blob missing it is a broken download
 * rather than a differently printed card.
 */
function isAftermath(faces: CardFace[]): boolean {
  return faces.length >= 2 && (faces[1].oracleText?.startsWith("Aftermath") ?? false);
}

/**
 * How far this printing must be turned to be read, or `null` when it is already upright.
 *
 * Positive is clockwise, matching CSS's `rotate`, so the value is the angle a caller applies
 * to the image and not something to be negated on the way out.
 *
 * The four answers:
 *
 * - **`split` → `90`, or `-90` for Aftermath.** A classic split (`Assault // Battery`,
 *   `Fire // Ice`) prints both halves with their titles reading top-to-bottom down the left
 *   edge, so the whole card is turned clockwise to read either one. An Aftermath card
 *   (`Dusk // Dawn`) prints the top half **upright** and the bottom half reading bottom-to-top
 *   up the right edge, so that half is reached by turning counter-clockwise instead. Both
 *   checked against the printed image, 2026-08-21. See {@link isAftermath} for how the two are
 *   told apart and what that test cost to justify.
 * - **`planar` → `90`.** Plane and Phenomenon cards are printed sideways in exactly the way a
 *   classic split is — checked against `Llanowar`'s printed image on 2026-08-21, its title
 *   reading bottom-to-top up the left edge. 330 live printings.
 * - **`flip` → `180`.** Two faces on one physical side, the second printed upside down
 *   (`Akki Lavarunner // Tok-Tok, Volcano Born`). 45 live printings. **This is the layout the
 *   control exists for**: `faceCount` answers `1`, so the pane offers no flip, and with no turn
 *   the second half stays upside down forever — the only card in the app a reader cannot read
 *   at all.
 * - **everything else → `null`.** Explicitly including `transform`, `modal_dfc` and
 *   `reversible_card`, which have a genuine second *side* and are served by the pane's existing
 *   flip control — a turn there would rotate a face that is already the right way up — and
 *   `adventure`, whose second face is printed upright inside the first.
 *
 * `faces` is taken rather than a face count because only the split branch reads it, and it
 * reads the *text*: see {@link isAftermath}.
 */
export function cardTurn(layout: string, faces: CardFace[]): CardTurn | null {
  switch (layout) {
    case "split":
      return isAftermath(faces) ? -90 : 90;
    case "planar":
      return 90;
    case "flip":
      return 180;
    default:
      return null;
  }
}

/**
 * The shape `ipc.cardMeldParts` answers with — see `MeldRelation` in `src/lib/ipc.ts`.
 *
 * Structural rather than an import of that interface on purpose: this module draws
 * conclusions about a *shape*, and typing it that way keeps the card pane's DTO free to grow
 * a field without a second edit here, and keeps this page compilable against an `ipc.ts` that
 * is still being written.
 *
 * Three things the backend has already done, which the two selectors below rely on and must
 * not redo: the list is in **Scryfall's own order**, the card itself is **already excluded**,
 * and `combo_piece`/`token` entries are **already dropped**. What is deliberately *not*
 * assumed is the vocabulary — an unrecognised `component` is ignored here rather than
 * trusted, because Scryfall adds components without asking and a mystery relation drawn as a
 * meld half is a wrong answer where nothing at all is the safe one.
 */
type MeldLike = { id: string; name: string; component: string; artist: string | null };

/**
 * The melded card this printing is one half of, or `null` when this printing *is* the melded
 * card.
 *
 * The first `meld_result` in the list — first rather than only, because the vocabulary is
 * Scryfall's and a second one would be news.
 */
export function meldResultOf<T extends MeldLike>(relations: readonly T[]): T | null {
  return relations.find((relation) => relation.component === "meld_result") ?? null;
}

/**
 * The halves that meld into this printing — empty unless this printing *is* the melded card.
 *
 * **The `meld_result` guard is the whole of this function.** A meld *part*'s relations name
 * its sibling half as a `meld_part` too, and the pane does not offer the sibling: from
 * `Bruna` the reader wants Brisela, not Gisela. Measured on 2026-08-21:
 * `Bruna, the Fading Light` (`emn 15`) answers
 * `[Brisela (meld_result), Gisela (meld_part)]`, so {@link meldResultOf} → Brisela and this →
 * `[]`; `Brisela, Voice of Nightmares` (`emn 15b`) answers
 * `[Bruna (meld_part), Gisela (meld_part)]`, so {@link meldResultOf} → `null` and this → both.
 *
 * That asymmetry — the same `meld_part` component meaning "your sibling" from one end and
 * "your halves" from the other, told apart only by whether a `meld_result` is present — is
 * why these are two functions and not one.
 */
export function meldPartsOf<T extends MeldLike>(relations: readonly T[]): T[] {
  if (meldResultOf(relations) !== null) return [];
  return relations.filter((relation) => relation.component === "meld_part");
}
