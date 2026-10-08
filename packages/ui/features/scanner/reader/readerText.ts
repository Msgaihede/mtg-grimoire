/**
 * What the reader's half of the Scanner says: the Match strip above the camera — where the
 * scanner has got to with the card in front of it — and what the filters are narrowing it to.
 *
 * `verdictText.ts` is the developer panels' vocabulary — votes, leads, distances — and **none of
 * those words may reach here**. The reader's view never shows a vote, a lead or a distance; it
 * says what to do next, in the order a person holding a card would need to hear it. A bar and a
 * card's name are not that vocabulary: the bar is `barFill`'s number and nothing of how it was
 * reached, which is the one thing this file takes from that one.
 */
import type {
  ScanFilters,
  ScanMode,
  ScannerChoice,
  ScannerLabel,
  ScannerResolution,
  ScannerVerdict,
} from "@/lib/ipc";
import { barFill } from "../verdictText";

/**
 * The two modes, in the order a reader meets them: the quick one first.
 *
 * The hints say what each mode *does for the reader* and never how — no hashes, no tiers, no
 * bursts. Those words belong to the developer panels, and a reader choosing between two scans needs
 * only to know which one pins the printing. Here rather than in `ScanBar`, so the phone page's
 * switch says the same two words and the same two sentences.
 */
export const SCAN_MODES: readonly { id: ScanMode; label: string; hint: string }[] = [
  { id: "fast", label: "Fast", hint: "Recognizes cards by their picture. Fastest for mixed piles." },
  {
    id: "exact",
    label: "Exact",
    hint: "Also reads the name and collector number to identify the exact printing.",
  },
];

/**
 * What the picture says while recognition is stopped — both Scanner surfaces', so the press it
 * names is the one each of them draws.
 */
export const SCANNING_STOPPED = "Scanning stopped. Press Start scanning to resume.";

/**
 * Under the list of cameras, on both surfaces. **"Device", not "computer"**: the choice is a row
 * of `app_meta` that never syncs, which is true of a phone and of a desktop alike, and the phone
 * face draws this sentence too.
 */
export const CAMERA_CHOICE_NOTE =
  "Switching restarts the camera. Your choice is remembered on this device.";

/** The unrestricted filter — what *Clear* sets, spelled once for both Scanner surfaces. */
export const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/**
 * The card the tray just took, as the strip names it — `null` until one has landed.
 *
 * `bumpedTo` is the row's new quantity when the add folded into the newest row, and `null` for a
 * row of its own: a second copy reads as a count, a new card as its printing. `replaced` is a
 * second opinion that rewrote the newest row's printing rather than adding a copy — a switch to
 * Exact on the card Fast named — and reads as an update, never as another add.
 */
export type LastAdded = {
  name: string;
  setCode: string;
  collectorNumber: string;
  bumpedTo: number | null;
  replaced: boolean;
} | null;

/** How the strip's pill is coloured, and so what kind of news the row it leads is. */
export type StripTone = "idle" | "progress" | "done" | "attention" | "error";

/**
 * Everything the Match strip draws, as one value — so every state it can be in is a return of
 * {@link matchStrip} and `MatchStrip` decides nothing but how each field looks.
 */
export interface StripState {
  /** The pill: a word, or a count of printings, saying where the scanner has got to. */
  word: string;
  tone: StripTone;
  /** The card, in display type; `null` where there is none to name, and the sentence takes its place. */
  name: string | null;
  /** The printing beside it, `SET NUMBER` as the tray spells it; `null` where none is named. */
  printing: string | null;
  /** What to do next — the reader's one line. */
  sentence: string;
  /** 0..1, the bar. */
  fill: number;
  /** The bar in the accent rather than dim: the scanner has settled on a card. */
  committed: boolean;
  /** Where the bar's hairline sits: the right-hand end, or a fraction of the way along. */
  threshold: "end" | number;
}

/**
 * **`0.7` is `TrackerOptions::commit_confidence` (`crates/card-scanner/src/track.rs`, `0.70`)
 * written a second time, with nothing keeping the two in step.** The crate does not send the
 * threshold on the verdict — `TrackedView` carries `decide_at` for the vote rule and no equivalent
 * for this one — so the only alternatives were a field on the wire or a literal with its coupling
 * named. If that constant moves, move this: a hairline in the wrong place is a bar that commits
 * visibly early or late, and nothing in either suite can see it. The vote rule needs no literal —
 * its bar *is* `decide_at`, so the line is the right-hand end.
 */
const COMMIT_CONFIDENCE = 0.7;

/**
 * A printing as the tray spells it: the set upper-cased, then the number. `null` for a card with
 * no label, which has no printing to name — an empty mono span beside the name would be a gap
 * pointing at nothing.
 */
function printingOf(set: string, number: string): string | null {
  const printing = [set.toUpperCase(), number].filter((part) => part !== "").join(" ");
  return printing === "" ? null : printing;
}

function labelPrinting(label: ScannerLabel | null): string | null {
  return label === null ? null : printingOf(label.set, label.number);
}

/**
 * The one card an ambiguous resolve's printings all belong to, or `null` when they are not one
 * card. A resolve can tie two names — a fuzzy read, a title several oracle cards share — and the
 * strip naming the first of them would tell the reader the card was settled when only its tray row
 * knows it was not.
 */
function sharedName(choices: readonly ScannerChoice[]): string | null {
  const names = new Set(choices.flatMap((c) => (c.label === null ? [] : [c.label.name])));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * The strip above the camera.
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
 * The ambiguous rung asks `tracked.committed` as well, so it never reaches a card the tracker has
 * not settled on: a stale latch from the last card is exactly what the new card's first frames
 * would otherwise read. **The added rung asks for this frame's decision too, and for the same
 * reason one step further on**: `lastAdded` is never cleared, so on a committed frame that has not
 * decided yet — Fast's one frame waiting on the read that confirms it, or Exact's tracker settling
 * before its resolve has answered — it is still the *previous* card, and the strip would call that
 * one matched over the card in the camera.
 *
 * **Exact is settled by its resolve, not by the tracker**, so an Exact commit with no decision
 * still reads as reading; Fast's decision *is* the commit, and its one unconfirmed frame reads as
 * matched on the tracker's leader.
 *
 * **A filed card is named from the tray's row, never from the hash's leader** — in Exact the
 * resolve can pin another printing than the one the tracker leads with, and the strip has to name
 * what was filed. The leader names the card only until then.
 */
export function matchStrip(
  verdict: ScannerVerdict | null,
  mode: ScanMode,
  lastAdded: LastAdded,
  hasBundle: boolean,
  lastResolution: ScannerResolution | null,
): StripState {
  const tracked = verdict?.tracked ?? null;
  const threshold: StripState["threshold"] =
    tracked?.rule === "confidence" ? COMMIT_CONFIDENCE : "end";
  const empty = { name: null, printing: null, fill: 0, committed: false, threshold };
  if (!hasBundle) {
    return {
      ...empty,
      word: "Can't identify",
      tone: "error",
      sentence: "Card hashes aren't loaded, so cards can be detected but not identified.",
    };
  }
  if (verdict === null || verdict.quad === null) {
    return { ...empty, word: "Looking", tone: "idle", sentence: "Point the camera at a card" };
  }
  if (lastResolution?.outcome === "not_found") {
    return {
      ...empty,
      word: "No match",
      tone: "error",
      sentence: "Try better lighting or clear the filters.",
    };
  }

  const committed = tracked?.committed === true;
  const decided = committed && verdict.decision !== null;
  const lead = tracked?.standings[0]?.label ?? null;
  const full = { fill: 1, committed: true, threshold };

  if (lastResolution?.outcome === "ambiguous" && committed) {
    const count = lastResolution.choices.length;
    return {
      ...full,
      word: count > 1 ? `${count} printings` : "Pick a printing",
      tone: "attention",
      name: sharedName(lastResolution.choices),
      // A card, not a printing: which printing is the question the tray is asking.
      printing: null,
      sentence: "Pick a printing in the tray",
    };
  }
  if (lastAdded !== null && decided) {
    // "Updated" rather than "Added" for a replaced row: the tray did not grow, and a reader told a
    // card was added after switching to Exact would go looking for the duplicate.
    const sentence = lastAdded.bumpedTo
      ? `Added again — ×${lastAdded.bumpedTo}`
      : lastAdded.replaced
        ? "Printing updated"
        : "Added · swap in the next card";
    return {
      ...full,
      word: "Matched",
      tone: "done",
      name: lastAdded.name,
      printing: printingOf(lastAdded.setCode, lastAdded.collectorNumber),
      sentence,
    };
  }
  if (decided || (committed && mode === "fast")) {
    // The decision's name before the leader's: a Fast title read that names a card overrides the
    // hash, so the two can differ, and the decision is what the tray is about to file.
    const label = verdict.decision?.label ?? lead;
    return {
      ...full,
      word: "Matched",
      tone: "done",
      name: label?.name ?? null,
      printing: labelPrinting(label),
      sentence: "Hold steady",
    };
  }

  const leaning = {
    tone: "progress" as const,
    name: lead?.name ?? null,
    printing: labelPrinting(lead),
    fill: barFill(tracked),
    committed: false,
    threshold,
  };
  if (mode === "exact" && verdict.lock?.phase === "locked") {
    return { ...leaning, word: "Reading", sentence: "Hold steady — reading…" };
  }
  return { ...leaning, word: "Matching", sentence: "Hold steady" };
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
