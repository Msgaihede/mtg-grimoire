/**
 * What finish a scanned card lands in — the one conclusion drawn from the scanner's two facts
 * about it.
 *
 * **Rust measures, TypeScript decides.** The session hands over the decided printing's finishes
 * from the corpus and the collector line's separator as it measured it (a ★ on a foil, a • on a
 * non-foil); which of those wins, and when neither is enough, is this module's and nobody
 * else's. `tray.ts` never sees the Defaults popover's `detect`: the page asks {@link trayFinish}
 * as each card lands and hands the reducer a finish, or `unknown`.
 */
import { FINISH_LABEL, FINISHES, type Finish } from "@/lib/finish";
import type { ScannerDecision, ScannerFinishPref, ScannerTrayFinish } from "../types";

/** The Defaults popover's policy word — `scanner::DETECT_FINISH`, and not a finish. */
export const DETECT: ScannerFinishPref = "detect";

/** A tray row the scanner could not settle the finish of. */
export const UNKNOWN_FINISH: ScannerTrayFinish = "unknown";

/** What the popover's menu calls each choice. `Detect` first, because it is the default. */
export const FINISH_PREF_LABEL: Record<ScannerFinishPref, string> = {
  detect: "Detect",
  ...FINISH_LABEL,
};

/** What a tray row's finish control calls each value. */
export const TRAY_FINISH_LABEL: Record<ScannerTrayFinish, string> = {
  ...FINISH_LABEL,
  unknown: "Unknown",
};

/** Is this row's finish one the collection can file? `unknown` is the one that is not. */
export function isKnownFinish(finish: ScannerTrayFinish): finish is Finish {
  return finish !== UNKNOWN_FINISH;
}

/** One of the collection's finishes, or `null` for a word Scryfall has and this app does not. */
function asFinish(word: string): Finish | null {
  return (FINISHES as readonly string[]).includes(word) ? (word as Finish) : null;
}

/**
 * The finish a new tray row takes for this decision.
 *
 * **A fixed preference is the whole answer** — Nonfoil, Foil or Etched in the Defaults popover is a
 * reader saying "this pile is all one finish", and nothing the camera reads overrules them.
 *
 * **Under `detect`, three rungs, first answer wins:**
 *
 * 1. **A printing that exists in exactly one finish is that finish** — no read needed, and no
 *    misread can argue with it. A foil-only promo is foil whatever the separator looked like.
 * 2. **The separator, when it read `foil` or `nonfoil`, and only if the printing exists in that
 *    finish.** A star on a printing the corpus says was never foil is a misread, not a discovery,
 *    and the honest answer to a contradiction is to ask. An **empty** finish list is the corpus
 *    saying nothing, not a printing that exists in no finish, so it constrains nothing and the
 *    mark stands on its own.
 * 3. **Otherwise `unknown`** — no mark read, a mark between a dot and a star, or a contradiction.
 *
 * **Etched is never inferred from the mark**: the mark knows star from dot and nothing else, so a
 * star says foil and never which foil. Etched arrives by rung 1 — an etched-only printing — or by
 * the reader's hand.
 *
 * **An ambiguous decision skips rung 1 and the check in rung 2.** Its `finishes` belong to the
 * printing it wears provisionally, which the reader has not yet agreed to, and a pick among its
 * choices would leave the row stamped with a finish drawn from a printing it is no longer. The
 * separator is a fact about the cardboard, not about the printing, so it still stands — alone.
 */
export function trayFinish(pref: ScannerFinishPref, decision: ScannerDecision): ScannerTrayFinish {
  if (pref !== "detect") return pref;

  const provisional = decision.outcome === "ambiguous" && decision.choices.length > 0;
  const finishes = provisional ? [] : decision.finishes;

  if (finishes.length === 1) {
    return asFinish(finishes[0]) ?? UNKNOWN_FINISH;
  }

  const reading = decision.finish_mark?.reading ?? "unknown";
  if (reading === "foil" || reading === "nonfoil") {
    return finishes.length === 0 || finishes.includes(reading) ? reading : UNKNOWN_FINISH;
  }
  return UNKNOWN_FINISH;
}
