/**
 * The two sentences the reader's half of the Scanner is made of: what the scanner is doing right
 * now, and what the filters are narrowing it to.
 *
 * `verdictText.ts` is the developer panels' vocabulary — votes, leads, distances — and **none of
 * those words may reach here**. The reader's view never shows a vote, a lead or a distance; it
 * says what to do next, in the order a person holding a card would need to hear it.
 */
import type { ScanFilters, ScanMode, ScannerResolution, ScannerVerdict } from "@/lib/ipc";

/**
 * The card the tray just took, as the status line words it — `null` until one has landed.
 *
 * `bumpedTo` is the row's new quantity when the add folded into the newest row, and `null` for a
 * row of its own: a second copy reads as a count, a new card as its printing.
 */
export type LastAdded = {
  name: string;
  setCode: string;
  collectorNumber: string;
  bumpedTo: number | null;
} | null;

/**
 * One line under the camera.
 *
 * **The order is the whole rule, and every rung above a later one is a reason that one cannot be
 * true.** No hashes means nothing can be named, so it outranks everything, a card in frame
 * included. No card in frame outranks every sentence *about* a card. A resolve that found nothing
 * or found several outranks "added", because a reader told a card was added while the tray is
 * waiting on them would stop looking at it. And the two "hold steady" rungs are what is left.
 *
 * `lastResolution` is the page's latch of the last non-null `verdict.resolution`, **cleared when a
 * frame has no quad** — a resolve is reported on one frame only, and the sentence has to outlive
 * that frame for as long as the same card is still in front of the camera, and not a moment
 * longer. The two outcome rungs therefore sit *below* the no-card rung by construction.
 *
 * The ambiguous rung and the added rung ask `tracked.committed` as well, so neither sentence
 * reaches a card the tracker has not settled on: a stale latch from the last card is exactly
 * what the new card's first frames would otherwise read.
 */
export function statusLine(
  verdict: ScannerVerdict | null,
  mode: ScanMode,
  lastAdded: LastAdded,
  hasBundle: boolean,
  lastResolution: ScannerResolution | null,
): string {
  if (!hasBundle) {
    return "The scanner has no card hashes loaded, so it can find a card but not name it.";
  }
  if (verdict === null || verdict.quad === null) return "Point the camera at a card";
  if (lastResolution?.outcome === "not_found") {
    return "No match — try better light, or clear the filters";
  }
  const committed = verdict.tracked?.committed === true;
  if (lastResolution?.outcome === "ambiguous" && committed) return "Pick a printing below";
  if (lastAdded !== null && committed) {
    if (lastAdded.bumpedTo) return `Added ${lastAdded.name} again — ×${lastAdded.bumpedTo}`;
    const printing = [lastAdded.setCode.toUpperCase(), lastAdded.collectorNumber]
      .filter((part) => part !== "")
      .join(" ");
    // A card with no label has no printing to name, and "Added Unknown card — " with a dash
    // pointing at nothing reads as a sentence that lost its ending.
    return printing === "" ? `Added ${lastAdded.name}` : `Added ${lastAdded.name} — ${printing}`;
  }
  if (mode === "exact" && verdict.lock?.phase === "locked" && !committed) {
    return "Hold steady — reading the card…";
  }
  return "Hold steady";
}

/** A set list as a trigger can say it: up to two codes by name, a count past that. */
function setsPart(sets: readonly string[]): string {
  if (sets.length === 0) return "Any set";
  if (sets.length > 2) return `${sets.length} sets`;
  return sets.map((code) => code.toUpperCase()).join(", ");
}

/** The release window, in the dates the reader typed — ISO, because that is what a date field
 *  hands back and what a set list prints. `null` when neither end is set. */
function datesPart(from: string | null, to: string | null): string | null {
  if (from !== null && to !== null) return `${from} – ${to}`;
  if (from !== null) return `from ${from}`;
  if (to !== null) return `until ${to}`;
  return null;
}

/**
 * What the Filters button says: `Any set`, `HOB, LTR`, `HOB · from 2023-06-23`,
 * `3 sets · 2020-01-01 – 2024-12-31`.
 *
 * **Two codes and then a count**, because the trigger shares a wrapping row with three other
 * controls and a reader scanning a pile rarely narrows to more than a pair; past two, the codes
 * are in the popover a press away and the number is the fact worth a glance. An empty date string
 * is treated as no date — a cleared `type="date"` field reports `""`, not `null`.
 */
export function filterSummary(filters: ScanFilters): string {
  const from = filters.released_from === "" ? null : filters.released_from;
  const to = filters.released_to === "" ? null : filters.released_to;
  const dates = datesPart(from, to);
  const sets = setsPart(filters.sets);
  return dates === null ? sets : `${sets} · ${dates}`;
}
