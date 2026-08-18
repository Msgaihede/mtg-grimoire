/**
 * How the printings modal narrows one card's list, and what its controls are built from.
 *
 * Here rather than in Rust because every rule below is a judgement about meaning — is a
 * `borderless` border colour a treatment? is an unnamed set its code? does English come first? —
 * and CLAUDE.md puts those in TypeScript. Rust hands over one row per paper printing, newest
 * first; every conclusion drawn from them is on this page.
 *
 * **Nothing here throws on a string it has never seen.** `finishes` and `frameEffects` are JSON
 * columns copied from Scryfall, and Scryfall adds frame effects without asking. An unknown value
 * simply matches no treatment, exactly as `DeckHistoryDialog`'s `auditBand` files an unknown audit
 * kind under "other" rather than dropping it: a filter that threw would take the whole wall down
 * over a cosmetic field.
 */
import type { Printing } from "@/lib/ipc";

/**
 * The seven treatments worth a chip.
 *
 * Each is a *different field*, which is why this is a hand-written list rather than a derivation:
 * `foil` and `etched` come out of the `finishes` array, `promo` and `fullArt` are booleans,
 * `borderless` is a border colour, and `showcase`/`extendedart` are members of `frameEffects`.
 * The chip's label is what a Magic player calls the thing, not what the column does.
 */
export const TREATMENTS = [
  { id: "foil", label: "Foil" },
  { id: "etched", label: "Etched" },
  { id: "promo", label: "Promo" },
  { id: "fullart", label: "Full art" },
  { id: "borderless", label: "Borderless" },
  { id: "showcase", label: "Showcase" },
  { id: "extendedart", label: "Extended art" },
] as const;

export type Treatment = (typeof TREATMENTS)[number]["id"];

/** What the modal's controls are, as one value. */
export interface PrintingFilter {
  /** Matched against the set name, the set code, the collector number and the artist. */
  text: string;
  /** Set codes, as `cards.set_code` stores them — lowercase. */
  sets: string[];
  /** Scryfall two-letter language codes. */
  langs: string[];
  /** ORed with each other, ANDed with everything else — see {@link filterPrintings}. */
  treatments: Treatment[];
}

/** Nothing narrowed. What the modal opens on, and what "Clear all" restores. */
export const EMPTY_PRINTING_FILTER: PrintingFilter = {
  text: "",
  sets: [],
  langs: [],
  treatments: [],
};

/** Whether anything is narrowed — what decides the count line's wording and the Clear control. */
export function isFilterActive(filter: PrintingFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.sets.length > 0 ||
    filter.langs.length > 0 ||
    filter.treatments.length > 0
  );
}

/**
 * The printings that survive every control, in the order they were given.
 *
 * **The order is the caller's and is never touched.** The modal hands over a list that has already
 * been through `buildPrintingGroups` for the reader's chosen sort, so a sort here would silently
 * override a decision made one component up.
 *
 * The four controls are ANDed; the treatments are ORed *among themselves*, which is the one
 * asymmetry and the one a reader expects: pressing Foil and Promo asks for the premium printings,
 * not for the printings that are both.
 */
export function filterPrintings(
  printings: readonly Printing[],
  filter: PrintingFilter,
): Printing[] {
  const needle = filter.text.trim().toLowerCase();
  const sets = new Set(filter.sets);
  const langs = new Set(filter.langs);
  return printings.filter((p) => {
    if (needle !== "" && !matchesText(p, needle)) return false;
    if (sets.size > 0 && !sets.has(p.setCode)) return false;
    if (langs.size > 0 && !langs.has(p.lang)) return false;
    if (filter.treatments.length > 0 && !filter.treatments.some((t) => hasTreatment(p, t))) {
      return false;
    }
    return true;
  });
}

/**
 * The four fields that differ between two printings of one card.
 *
 * The card's own `name` is deliberately absent: it is identical on every row of this list, so
 * matching it would either pass everything or nothing. The modal's placeholder says which four
 * these are, because a search box that silently ignores what you typed is worse than no box.
 */
function matchesText(p: Printing, needle: string): boolean {
  return (
    (p.setName?.toLowerCase().includes(needle) ?? false) ||
    p.setCode.toLowerCase().includes(needle) ||
    p.collectorNumber.toLowerCase().includes(needle) ||
    (p.artist?.toLowerCase().includes(needle) ?? false)
  );
}

/** Whether one printing carries one treatment. Total over every field it reads. */
function hasTreatment(p: Printing, treatment: Treatment): boolean {
  switch (treatment) {
    case "foil":
      return jsonList(p.finishes).includes("foil");
    case "etched":
      return jsonList(p.finishes).includes("etched");
    case "promo":
      return p.promo;
    case "fullart":
      return p.fullArt;
    // The border colour rather than a frame effect: Scryfall models a borderless card as
    // `border_color: "borderless"`, and `frame_effects` says nothing about it.
    case "borderless":
      return p.borderColor === "borderless";
    case "showcase":
      return jsonList(p.frameEffects).includes("showcase");
    case "extendedart":
      return jsonList(p.frameEffects).includes("extendedart");
  }
}

/**
 * A JSON string array as a list of strings — `[]` for null, for junk, and for a payload that
 * parsed into something that is not an array of strings.
 *
 * The columns are copied verbatim from Scryfall and are nullable; nothing between the bulk file
 * and here validates them. Answering `[]` is what makes an unreadable row simply match no
 * treatment instead of taking the wall down.
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

/** One row of the set picker: the code the filter sends, the word the reader reads, the count. */
export interface SetOption {
  code: string;
  name: string;
  count: number;
}

/**
 * The sets these printings are in, most-printings first, ties in first-seen order.
 *
 * Built from the rows rather than from `ipc.setsList`, which answers with ~1050 sets — roughly
 * 1040 of which hold no printing of this card. A picker whose options are mostly empty is a
 * picker a reader has to search to use.
 *
 * A set with no `setName` on any of its rows is named by its **upper-cased code**, which is
 * `groupBySet`'s fallback in `printings.ts` and for its reason: the column is nullable per row,
 * and a three-letter code is what a Magic player calls a set anyway. The first *non-null* name
 * wins, so one nameless row does not rename a fully named set.
 */
export function setOptions(printings: readonly Printing[]): SetOption[] {
  const byCode = new Map<string, { name: string | null; count: number }>();
  for (const p of printings) {
    const seen = byCode.get(p.setCode);
    if (seen) {
      seen.count += 1;
      seen.name ??= p.setName;
    } else {
      byCode.set(p.setCode, { name: p.setName, count: 1 });
    }
  }
  return [...byCode.entries()]
    .map(([code, { name, count }]) => ({ code, name: name ?? code.toUpperCase(), count }))
    .sort((a, b) => b.count - a.count);
}

/** One row of the language picker. */
export interface LangOption {
  lang: string;
  count: number;
}

/**
 * The languages these printings are in — **English first**, then the rest by count.
 *
 * English is pinned rather than counted into its place because it is the language the rest of the
 * app is in and the one a reader narrowing to "just the normal ones" is reaching for. On a heavily
 * reprinted card it is also not the largest group, so leaving it to the count would bury it.
 *
 * The comparator pins by answering before it counts, which is a *total* order only because the
 * `Map` guarantees at most one `en` row: two of them would each claim to sort before the other,
 * and an inconsistent comparator is a sort whose answer depends on the engine. Written this way
 * rather than as a rank subtraction because the map key is the fence, and saying so here is
 * cheaper than a second expression that has to agree with it.
 */
export function langOptions(printings: readonly Printing[]): LangOption[] {
  const counts = new Map<string, number>();
  for (const p of printings) counts.set(p.lang, (counts.get(p.lang) ?? 0) + 1);
  return [...counts.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => (a.lang === "en" ? -1 : b.lang === "en" ? 1 : b.count - a.count));
}

/** One treatment chip: what it is, what it says, and how many rows it would leave. */
export interface TreatmentOption {
  id: Treatment;
  label: string;
  count: number;
}

/**
 * Every treatment with its count, **including the ones at zero**.
 *
 * Zero-count options are kept and drawn disabled rather than dropped, which is `facets.ts`' rule:
 * an option that vanishes reads as a control that broke, where a greyed one reads as a fact about
 * this card. The row of chips is also a fixed shape that way, so it does not reflow as the reader
 * narrows.
 */
export function treatmentOptions(printings: readonly Printing[]): TreatmentOption[] {
  return TREATMENTS.map(({ id, label }) => ({
    id,
    label,
    count: printings.reduce((n, p) => n + (hasTreatment(p, id) ? 1 : 0), 0),
  }));
}
