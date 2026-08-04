/**
 * The card-detail domain logic: which printings share artwork, what a finish costs, and
 * which formats are worth a chip.
 *
 * Here rather than in Rust because CLAUDE.md puts domain logic in TypeScript — and
 * because every rule below is a judgement call about meaning (is a null illustration a
 * group? does a missing foil price fall back?) that wants fast tests around it.
 */
import type { Printing } from "@/lib/ipc";

/** Scryfall's finish enum. Never a boolean — `etched` is a third thing. */
export type Finish = "nonfoil" | "foil" | "etched";
const FINISHES: readonly Finish[] = ["nonfoil", "foil", "etched"];

/** The `prices` key each finish is worth. */
const PRICE_KEY: Record<Finish, string> = {
  nonfoil: "usd",
  foil: "usd_foil",
  etched: "usd_etched",
};

/**
 * The 23 legality keys in Scryfall's emission order.
 *
 * A display order, not a schema: the set grows (`tlr` is newer than most published field
 * lists, and `timeless`/`predh`/`oathbreaker` were all added over time), so anything not
 * in this list is rendered after it rather than dropped.
 */
export const FORMAT_ORDER = [
  "standard",
  "future",
  "historic",
  "timeless",
  "gladiator",
  "pioneer",
  "modern",
  "legacy",
  "pauper",
  "vintage",
  "penny",
  "commander",
  "oathbreaker",
  "standardbrawl",
  "brawl",
  "competitivebrawl",
  "alchemy",
  "paupercommander",
  "duel",
  "oldschool",
  "premodern",
  "predh",
  "tlr",
] as const;

/** Layouts whose `card_faces` are two *physical* sides. */
const TWO_SIDED = new Set([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "reversible_card",
  "art_series",
]);

/** Printings that share one illustration. */
export interface ArtGroup {
  illustrationId: string | null;
  printings: Printing[];
}

/**
 * Group printings by artwork, preserving the order they arrived in (newest first).
 *
 * Two printings differ in art iff `illustration_id` differs — `variation` is true on
 * 0.09% of cards and finds nothing. A **null** illustration is never grouped with another
 * null: the field is documented as missing on newly spoiled cards, so merging them would
 * claim a set of unrelated printings share an artwork.
 */
export function groupByIllustration(printings: Printing[]): ArtGroup[] {
  const groups: ArtGroup[] = [];
  const byId = new Map<string, ArtGroup>();
  for (const p of printings) {
    const existing = p.illustrationId === null ? undefined : byId.get(p.illustrationId);
    if (existing) {
      existing.printings.push(p);
      continue;
    }
    const group: ArtGroup = { illustrationId: p.illustrationId, printings: [p] };
    if (p.illustrationId !== null) byId.set(p.illustrationId, group);
    groups.push(group);
  }
  return groups;
}

/** The finishes a printing exists in. Unknown values are dropped, not guessed at. */
export function parseFinishes(json: string | null): Finish[] {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f): f is Finish => FINISHES.includes(f as Finish));
}

/**
 * What one finish of this printing costs in USD, or `null`.
 *
 * A lookup by finish, with **no fallback of any kind**. `price_usd` — the derived column
 * — is a nonfoil→foil→etched chain built for sorting, and using it here would price a
 * plain copy at foil rates. Values arrive as decimal strings because money is not a
 * float on the wire; `Number` is the last possible moment to make one.
 */
export function finishPrice(pricesJson: string | null, finish: Finish): number | null {
  const prices = safeParse(pricesJson);
  if (typeof prices !== "object" || prices === null) return null;
  const raw = (prices as Record<string, unknown>)[PRICE_KEY[finish]];
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The formats worth showing, in `FORMAT_ORDER`, with unknown keys last.
 *
 * `not_legal` is dropped: a card is not legal in most of 23 formats, and 20 grey chips
 * bury the three that carry information.
 */
export function legalityChips(legalitiesJson: string | null): { format: string; status: string }[] {
  const parsed = safeParse(legalitiesJson);
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, status]) => typeof status === "string" && status !== "not_legal",
  ) as [string, string][];

  const rank = (format: string) => {
    const i = FORMAT_ORDER.indexOf(format as (typeof FORMAT_ORDER)[number]);
    return i === -1 ? FORMAT_ORDER.length : i;
  };
  return entries
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([format, status]) => ({ format, status }));
}

/**
 * How many physical sides this printing has.
 *
 * Not the length of `card_faces`: `split`, `adventure` and `flip` all have two faces
 * printed on one side of one piece of cardboard, and offering to flip them would show a
 * card back. `meld` has no `card_faces` at all.
 *
 * `faces` is checked as well as the layout because the two can disagree — a two-sided
 * layout whose blob arrived with one face would otherwise offer a flip to
 * `card.faces[1]`, which is not there.
 */
export function faceCount(layout: string, faces: number): number {
  return TWO_SIDED.has(layout) && faces >= 2 ? 2 : 1;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
