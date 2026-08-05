/**
 * The card-detail domain logic: which printings share artwork, which formats are worth a
 * chip, and how many sides a card really has.
 *
 * Here rather than in Rust because CLAUDE.md puts domain logic in TypeScript — and
 * because every rule below is a judgement call about meaning (is a null illustration a
 * group? is a split card two-sided?) that wants fast tests around it.
 *
 * The finish vocabulary used to live here too. It left for `@/lib/finish` when the
 * collection and the quick-add popup needed it: a card-detail module is the wrong place to
 * keep something three features read, and the second copy of it had already appeared in
 * `CardDetailPane`.
 */
import type { Printing } from "@/lib/ipc";

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
