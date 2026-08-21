/**
 * What is unusual about a piece of cardboard, read from Scryfall's `promo_types`.
 *
 * A finish says *how shiny* a copy is and there are exactly three of them — `cards.finishes`
 * holds 8 distinct values across the live 116 712-row database and every one is built from
 * `nonfoil`, `foil` and `etched`. What it cannot say is *which kind* of shiny, and that is
 * issue #160: a Surge Foil, a Halo Foil and an ordinary foil were one `Sparkles` glyph with one
 * word behind it. Scryfall answers in a different column — `promo_types`, already ingested
 * (`card_row.rs`) and stored (`schema.rs`), and until this module never read on this side.
 *
 * **A treatment is therefore an annotation on a finish and never a fourth finish.** Nothing here
 * touches `Finish`, `collection_entries.finish`, its `CHECK`, or any import format: a Surge Foil
 * copy is a `foil` copy that is also a Surge Foil, which is what the reader's data already says.
 *
 * **The table is hand-written because naming is a judgement**, which CLAUDE.md puts in
 * TypeScript. Rust hands over the column verbatim; every conclusion drawn from it is on this
 * page. An unrecognised member matches nothing and is dropped — Scryfall adds promo types
 * without asking, and 113 distinct ones are live today.
 */
import type { Finish } from "./finish";

/**
 * One named treatment: the word Scryfall stores, the word a Magic player says, and **which of
 * the two kinds it is**.
 *
 * `foil: true` describes the *shiny copy* of a printing. `foil: false` describes the cardboard,
 * in whatever finish you hold it — a serialized card is serialized either way.
 */
export interface Treatment {
  /** The `promo_types` member this is read from, exactly as Scryfall spells it. */
  id: string;
  /** What a Magic player calls it. The label a mark, a tooltip and a price row all show. */
  label: string;
  /** Whether it describes the foil copy ({@link finishTreatments} fences on this). */
  foil: boolean;
}

/**
 * Every treatment this app names, **foil words first**, each with its live paper count on
 * 2026-08-21 (116 712 rows synced 2026-08-18).
 *
 * The order is load-bearing twice over: {@link cardTreatments} returns matches in table order,
 * so the foil word leads the label a printing carrying both kinds gets — `doublerainbow` +
 * `serialized` reads "Double Rainbow Foil · Serialized", which is the right way round for a mark
 * standing where a *finish* glyph stood.
 *
 * ## The 25 foil words — 5 013 printings
 *
 * **Not one of them appears on a nonfoil-only printing** (checked per word against the corpus),
 * which is what makes {@link finishTreatments}' fence free: a foil word can be withheld from a
 * plain copy without ever silencing a printing that had nothing else to say.
 *
 * `embossed` is the one whose name was settled from the data alone rather than from a card in
 * hand — 99 printings, foil-only on every row, 80 of them Adventures in the Forgotten Realms
 * Promos. If a reader who owns one says it is a stock rather than a foil, move it down to the
 * traits; nothing else has to change.
 *
 * ## The 7 traits — 1 133 printings
 *
 * These are not foiling and the mark says so by outliving the finish: `glossy` is on 5 nonfoil
 * rows, `plastic` on 18, `poster` on 40. Including them is a deliberate widening of what the
 * corner chip means, from "this is shiny" to "this object is unusual" — the wider reading is
 * what issue #160 was answered with, and it is the half that reaches the **1 718 printings whose
 * finishes include `nonfoil`** and which therefore draw no mark at all today.
 *
 * Union: **5 428 of 107 355 paper printings, 5.1 %** — which is why a mark on one is information
 * rather than decoration, the same test `soleFinish` applies when it declines to mark the 53 224
 * printings that merely *have* a foil version.
 */
export const CARD_TREATMENTS: readonly Treatment[] = [
  // Foil words, commonest first. The count is a fact about 2026-08-18's sync, not a fence —
  // nothing reads it, and a resync moves every one of them.
  { id: "surgefoil", label: "Surge Foil", foil: true }, // 2 509
  { id: "galaxyfoil", label: "Galaxy Foil", foil: true }, // 376
  { id: "silverfoil", label: "Silver Foil", foil: true }, // 369
  { id: "ripplefoil", label: "Ripple Foil", foil: true }, // 349
  { id: "doublerainbow", label: "Double Rainbow Foil", foil: true }, // 289
  { id: "rainbowfoil", label: "Rainbow Foil", foil: true }, // 193
  { id: "halofoil", label: "Halo Foil", foil: true }, // 159
  { id: "firstplacefoil", label: "First Place Foil", foil: true }, // 137
  { id: "embossed", label: "Embossed Foil", foil: true }, // 99
  { id: "textured", label: "Textured Foil", foil: true }, // 98
  { id: "stepandcompleat", label: "Step-and-Compleat Foil", foil: true }, // 76
  { id: "raisedfoil", label: "Raised Foil", foil: true }, // 67
  { id: "fracturefoil", label: "Fracture Foil", foil: true }, // 61
  { id: "manafoil", label: "Mana Foil", foil: true }, // 60
  { id: "gilded", label: "Gilded Foil", foil: true }, // 48
  { id: "confettifoil", label: "Confetti Foil", foil: true }, // 38
  { id: "neonink", label: "Neon Ink", foil: true }, // 28
  { id: "oilslick", label: "Oil Slick Foil", foil: true }, // 25, always paired — see PAIRS
  { id: "chocobotrackfoil", label: "Chocobo Track Foil", foil: true }, // 25
  { id: "invisibleink", label: "Invisible Ink", foil: true }, // 14
  { id: "dazzlefoil", label: "Dazzle Foil", foil: true }, // 7
  { id: "dragonscalefoil", label: "Dragon Scale Foil", foil: true }, // 5
  { id: "facetfoil", label: "Facet Foil", foil: true }, // 3
  { id: "cosmicfoil", label: "Cosmic Foil", foil: true }, // 2
  { id: "singularityfoil", label: "Singularity Foil", foil: true }, // 1
  // Traits: true of the cardboard in any finish.
  { id: "poster", label: "Poster", foil: false }, // 364
  { id: "scroll", label: "Scroll", foil: false }, // 359
  { id: "serialized", label: "Serialized", foil: false }, // 299
  { id: "thick", label: "Thick Stock", foil: false }, // 96
  { id: "plastic", label: "Plastic", foil: false }, // 28
  { id: "glossy", label: "Glossy", foil: false }, // 7
  { id: "metal", label: "Metal", foil: false }, // 6
];

/**
 * Treatments Scryfall spells as two members of one array but a player says as **one name**.
 *
 * The only live pair is Phyrexia: All Will Be One's Oil Slick Raised Foil — 25 printings, every
 * one carrying `oilslick` *and* `raisedfoil`, and both are in the table above, so without this
 * the mark would read "Oil Slick Foil · Raised Foil" as though the card were two things.
 *
 * Checked before the table and it consumes both members, so neither can also match singly. A
 * pair whose members are not both in {@link CARD_TREATMENTS} needs no entry here — the one that
 * is in the table simply wins on its own, which is why Duskmourn's 5 `textured` +
 * `doubleexposure` rows are absent: `doubleexposure` is a showcase frame the app already reads
 * through `frame_effects`, so "Textured Foil" is already the whole of the foil answer.
 */
const PAIRS: readonly { members: readonly [string, string]; treatment: Treatment }[] = [
  {
    members: ["oilslick", "raisedfoil"],
    treatment: { id: "oilslickraisedfoil", label: "Oil Slick Raised Foil", foil: true },
  },
];

/**
 * Every treatment a printing carries, in {@link CARD_TREATMENTS} order — foil words before
 * traits, so `[0]` is the name worth saying where there is room for one.
 *
 * **Says nothing about which copy the reader holds**, which is {@link finishTreatments}' job.
 * This answers about the printing, and it is what a filter chip wants: "does this row have a
 * special foil at all".
 *
 * 718 printings carry a word *and* a trait; `silverfoil` + `scroll` is 349 of them and
 * `doublerainbow` + `serialized` 267, so a list rather than a single answer is the common case
 * and not the exotic one.
 */
export function cardTreatments(promoTypesJson: string | null): Treatment[] {
  const raw = new Set(jsonList(promoTypesJson));
  if (raw.size === 0) return [];
  const found: Treatment[] = [];
  for (const { members, treatment } of PAIRS) {
    if (members.every((m) => raw.has(m))) {
      found.push(treatment);
      for (const m of members) raw.delete(m);
    }
  }
  for (const t of CARD_TREATMENTS) if (raw.has(t.id)) found.push(t);
  return found;
}

/**
 * The treatments true of **a copy in this finish** — what every mark in the app is drawn from.
 *
 * A foil word is withheld from a plain copy, and that fence is the whole reason the two kinds
 * exist. 1 434 printings carrying a foil word are also sold in plain nonfoil (`silverfoil`'s 369
 * Lord of the Rings rows are all of them), and marking the plain one "Silver Foil" would be the
 * same class of claim `soleFinish` already refuses to make when it declines to mark a printing
 * merely *sold* in foil.
 *
 * `finish === null` — a wall tile for a printing sold in both, where the app knows no finish —
 * takes the same answer as `nonfoil`: traits only. That is what lets the widened reading reach a
 * printing that draws nothing today without inventing a foil nobody named.
 *
 * A caller draws a mark when this is non-empty **or** the finish itself is markable; the two
 * conditions are independent, which is why this returns the treatments rather than a decision.
 */
export function finishTreatments(
  promoTypesJson: string | null,
  finish: Finish | null,
): Treatment[] {
  const all = cardTreatments(promoTypesJson);
  if (finish === "foil" || finish === "etched") return all;
  return all.filter((t) => !t.foil);
}

/**
 * The one word for a treated copy, or `null` — what a price row and a finish list show.
 *
 * The first treatment only, because these sit where a single finish word sat: the card pane
 * prints `Silver Foil  $4.20` on a row that has one column for it, and `Silver Foil · Scroll`
 * there would push the price out of the row. The joined reading is {@link treatmentTitle}'s and
 * belongs in a tooltip, which has the room.
 */
export function treatmentName(treatments: readonly Treatment[]): string | null {
  return treatments[0]?.label ?? null;
}

/**
 * Every treatment, joined the way the app joins card facts everywhere else — `" · "`.
 *
 * A tooltip and an accessible name, where there is room to say all of it: "Double Rainbow Foil ·
 * Serialized" is two true things about MUL 133z and dropping either would be a smaller answer
 * than the reader's own card. Same separator as `FoilOverlay`'s chip title, which joins the
 * crown and the finish, so a chip that ends up carrying both reads as one sentence.
 */
export function treatmentTitle(treatments: readonly Treatment[]): string | null {
  return treatments.length === 0 ? null : treatments.map((t) => t.label).join(" · ");
}

/**
 * A JSON string array as a list of strings — `[]` for null, for junk, and for a payload that
 * parsed into something that is not an array of strings.
 *
 * `promo_types` is copied verbatim from Scryfall's bulk file and is nullable; nothing between
 * the download and here validates it. Answering `[]` is what makes an unreadable row simply
 * carry no treatment instead of taking a wall of cards down over a cosmetic column — the same
 * rule, and the same shape, as `printingFilters.ts`' reader of `finishes` and `frame_effects`.
 */
function jsonList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
