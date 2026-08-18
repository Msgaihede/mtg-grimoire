/**
 * The card-detail domain logic: which printings share artwork, how a reader asked the
 * printings list to be grouped, which formats are worth a chip, how many sides a card really
 * has, and how one printing row becomes a card menu's target.
 *
 * Here rather than in Rust because CLAUDE.md puts domain logic in TypeScript — and
 * because every rule below is a judgement call about meaning (is a null illustration a
 * group? is a split card two-sided? is a set's date its earliest card's?) that wants fast
 * tests around it. Rust hands over *facts* — one row per printing, in
 * `released_at DESC, set_code ASC, collector_number ASC, id ASC`, capped at 400 — and every
 * conclusion drawn from them is on this page.
 *
 * The finish vocabulary used to live here too. It left for `@/lib/finish` when the
 * collection and the quick-add popup needed it: a card-detail module is the wrong place to
 * keep something three features read, and the second copy of it had already appeared in
 * `CardDetailPane`.
 */
import type { FinishPrices, Printing } from "@/lib/ipc";
import type { CardMenuTarget } from "./cardMenu";

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
 * How a reader asked the printings list to be grouped.
 *
 * A union rather than a free string because the value round-trips through storage and through
 * a `<select>`, and neither of those can be type-checked: a mode that is renamed or dropped
 * goes on living in a settings row for as long as that row survives. {@link isPrintingGroupBy}
 * is the only door back in from an unvalidated string, and
 * {@link DEFAULT_PRINTING_GROUP_BY} is what a value that fails it falls back to.
 */
export type PrintingGroupBy = "artist" | "released" | "price" | "set";

/**
 * The four modes, in the order the selector offers them, each carrying the word for one of
 * its own groups.
 *
 * The `noun` is what the pane's summary sentence counts — "12 printings, 4 artists" — and it
 * is deliberately `null` for `price`, the one mode that makes no groups at all: it is a single
 * sorted list, and there is no unit to count. Keeping the word beside the option rather than in
 * a `switch` in the pane is what stops the list of modes and the sentence describing them from
 * drifting apart; a mode added here arrives complete or it does not type-check.
 *
 * This array is also the membership test {@link isPrintingGroupBy} runs, so it is the single
 * place a fifth mode has to be added.
 */
export const PRINTING_GROUP_BY_OPTIONS: readonly {
  value: PrintingGroupBy;
  label: string;
  /** What one group is, for the summary line — null when the mode makes no groups. */
  noun: { one: string; many: string } | null;
}[] = [
  { value: "artist", label: "Artist", noun: { one: "artist", many: "artists" } },
  {
    value: "released",
    label: "Release date",
    noun: { one: "release date", many: "release dates" },
  },
  { value: "price", label: "Price", noun: null },
  { value: "set", label: "Set", noun: { one: "set", many: "sets" } },
];

/**
 * What the picker opens on, and what an unreadable stored value falls back to.
 *
 * `artist` because it is what the pane grouped by before there was anything to pick — the
 * reader who never opens the selector sees exactly the list they saw yesterday.
 */
export const DEFAULT_PRINTING_GROUP_BY: PrintingGroupBy = "artist";

/**
 * Narrows an unvalidated string (an `app_meta` row, a `<select>` value) to a mode.
 *
 * Written against {@link PRINTING_GROUP_BY_OPTIONS} rather than a second literal list, because
 * a hand-maintained copy of the union is exactly the thing that survives a rename: a `switch`
 * or an `includes` over its own array of strings still compiles perfectly after a mode is gone.
 */
export function isPrintingGroupBy(value: string): value is PrintingGroupBy {
  return PRINTING_GROUP_BY_OPTIONS.some((option) => option.value === value);
}

/** One heading and the printings under it. */
export interface PrintingGroup {
  /** Stable React key, unique within the returned array. */
  key: string;
  /** The heading text, or `null` for a mode that makes no groups. */
  heading: string | null;
  printings: Printing[];
}

/**
 * The printings list, cut into headed groups the way the reader asked for.
 *
 * **Every ordering here is stable, and none of it touches the caller's array.** Rust hands the
 * page over already sorted (`released_at DESC, set_code ASC, collector_number ASC, id ASC`), so
 * the incoming order *is* information: it is what decides the order inside every group, and in
 * three of the four modes it is the only thing that does. `Array.prototype.sort` has been
 * stable by specification since ES2019 — this module relies on that rather than re-deriving it
 * with an index tie-break — and every sort below runs on a fresh array, never on `printings`,
 * which belongs to React Query's cache and would be a mutation of shared state.
 *
 * The four modes, and why each is what it is:
 *
 * * **`artist`** — by the `artist` field, alphabetically, with the unattributed last. This is a
 *   deliberate change from {@link groupByIllustration}, which the pane headed with the first
 *   printing's artist: two *different artworks* by one artist made two identically headed
 *   groups there, and make one group here. The pane still calls `groupByIllustration` for the
 *   count of distinct artworks, which is a different question and still worth asking.
 * * **`released`** — one group per distinct `releasedAt`, newest first, which is this app's
 *   default direction everywhere and already the order the rows arrive in.
 * * **`price`** — no groups: one list, cheapest first, because the whole point of the mode is a
 *   single ranking a reader can read straight down.
 * * **`set`** — by `setCode`, sets in release order. A set has no date of its own on
 *   {@link Printing}, so it is taken from the cards; see {@link buildSetBuckets}.
 */
export function buildPrintingGroups(
  printings: readonly Printing[],
  mode: PrintingGroupBy,
): PrintingGroup[] {
  switch (mode) {
    case "artist":
      return groupByArtist(printings);
    case "released":
      return groupByReleaseDate(printings);
    case "price":
      return sortByPrice(printings);
    case "set":
      return groupBySet(printings);
  }
}

/**
 * The lowest of a printing's finish prices, or `null` when it has none at all.
 *
 * "Cheapest across finishes" rather than the nonfoil price, because a printing can exist in
 * exactly one finish — an etched-only or foil-only promo is priced in that column and nowhere
 * else — and ranking those at the bottom of a price sort would put the expensive ones there
 * with the unpriced ones.
 *
 * Negative and non-finite values are treated as *absent*, not as a very low price. These
 * numbers come from bulk pricelists rather than from Scryfall's own blob (see
 * `src/lib/marketplace.ts` and the price-feed research), and a `-1` or a `NaN` that reached the
 * comparator would sort a garbage row to the top of the list — the single most visible place a
 * feed's bad row could land. `Number.isFinite` is what catches `NaN`, since `NaN < 0` is false.
 */
export function cheapestPrice(prices: FinishPrices): number | null {
  let cheapest: number | null = null;
  for (const value of [prices.nonfoil, prices.foil, prices.etched]) {
    if (value === null || !Number.isFinite(value) || value < 0) continue;
    if (cheapest === null || value < cheapest) cheapest = value;
  }
  return cheapest;
}

/**
 * How a date-headed group renders its heading — `"5 Aug 1993"`.
 *
 * **An explicit locale and an explicit UTC time zone, both load-bearing.** The locale, because
 * a heading that read differently in the test runner, in Storybook and in the shipped window
 * would make every assertion about it a machine-specific one. The time zone, because
 * `releasedAt` is a *calendar date* with no time in it: `new Date("1993-08-05")` is parsed as
 * midnight **UTC**, and a formatter left on the local zone renders that instant in local time —
 * which anywhere west of Greenwich is the evening of the 4th. The date would be printed one day
 * early for every card in the game, on the machines least likely to be the ones testing it.
 */
const RELEASE_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** The key of the single group `price` mode returns. Fixed: there is only ever one. */
const PRICE_GROUP_KEY = "price:all";

/**
 * The key of the trailing "unknown" group, in the two modes that have one.
 *
 * Not `` `artist:${something}` ``: an artist really named "unknown" would collide with a
 * sentinel built out of the same prefix, and two React children with one key is a silent
 * reconciliation bug rather than an error. The hyphen is what keeps these out of the space the
 * `prefix:value` keys live in.
 */
const ARTIST_UNKNOWN_KEY = "artist-unknown";
const RELEASED_UNKNOWN_KEY = "released-unknown";

/**
 * Group by artist, named artists alphabetically and the unattributed last.
 *
 * `localeCompare` with an **explicit `"en"`** and not a bare one: the bare call reads the host's
 * default locale, so the same list could order differently in the shipped window than in the
 * suite. `sensitivity: "accent"` is the case-insensitive comparison asked for — it still
 * separates accented letters, which are the difference between two real illustrators' names,
 * and only folds case.
 *
 * Printings whose `artist` is null go to one group at the end. Unlike a null `illustrationId`
 * — which {@link groupByIllustration} refuses to merge, because it would be claiming unrelated
 * cards share an artwork — merging these claims nothing: the group is headed "Artist unknown"
 * and says exactly what it is, a list of printings whose credit the data does not carry.
 */
function groupByArtist(printings: readonly Printing[]): PrintingGroup[] {
  const { known, unknown } = bucketBy(printings, (p) => p.artist);
  const groups = [...known.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { sensitivity: "accent" }))
    .map(([artist, list]) => ({ key: `artist:${artist}`, heading: artist, printings: list }));
  if (unknown.length > 0) {
    groups.push({ key: ARTIST_UNKNOWN_KEY, heading: "Artist unknown", printings: unknown });
  }
  return groups;
}

/**
 * Group by the exact release date, newest first, undated last.
 *
 * Grouped on the raw ISO string rather than on a parsed date: it is what the bucket key has to
 * be unique by anyway, it sorts chronologically under a plain string comparison because ISO
 * `YYYY-MM-DD` is ordered lexicographically, and it survives a value that is not a date at all.
 * Only the *heading* parses, and {@link releaseHeading} falls back to the raw string when the
 * parse fails — a row that arrived with a malformed date reads as that string rather than as
 * "Invalid Date".
 *
 * Compared with `<`/`>` rather than `localeCompare`, deliberately: these are machine strings,
 * not names, and collation has no business deciding whether 1993 came before 1994.
 */
function groupByReleaseDate(printings: readonly Printing[]): PrintingGroup[] {
  const { known, unknown } = bucketBy(printings, (p) => p.releasedAt);
  const groups = [...known.entries()]
    .sort(([a], [b]) => compareDescending(a, b))
    .map(([iso, list]) => ({
      key: `released:${iso}`,
      heading: releaseHeading(iso),
      printings: list,
    }));
  if (unknown.length > 0) {
    groups.push({
      key: RELEASED_UNKNOWN_KEY,
      heading: "Release date unknown",
      printings: unknown,
    });
  }
  return groups;
}

/** One ISO date as a heading, or the raw string when it is not one. See {@link RELEASE_DATE_FORMAT}. */
function releaseHeading(iso: string): string {
  // The explicit `T00:00:00Z` is the other half of the UTC rule: a bare `new Date("1993-08-05")`
  // happens to be parsed as UTC by the date-only form of the spec, but a bare
  // `new Date("1993-08-05T00:00:00")` is *local*, and the two are one keystroke apart. Saying it
  // outright leaves nothing for a later edit to get wrong.
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : RELEASE_DATE_FORMAT.format(date);
}

/**
 * No groups: every printing in one list, cheapest first, unpriced at the bottom.
 *
 * A `null` price sinks rather than sorting as zero — it is *unpriced at this marketplace*, which
 * is not the same claim as free, and the marketplace rule in `src/CLAUDE.md` is that a null is
 * the answer rather than a number to invent. Among themselves the unpriced keep the order they
 * arrived in, which is Rust's newest-first, so the tail of the list is still readable.
 *
 * An empty input answers `[]` rather than one empty group: a heading-less group holding nothing
 * is a rendered wrapper around no rows, and the pane's own "no printings" state is the thing
 * that should show instead.
 *
 * `cheapestPrice` is recomputed inside the comparator rather than memoised — it is a minimum
 * over three fields, and the list Rust answers with is capped at 400 rows.
 */
function sortByPrice(printings: readonly Printing[]): PrintingGroup[] {
  if (printings.length === 0) return [];
  const sorted = [...printings].sort((a, b) => {
    const left = cheapestPrice(a.finishPrices);
    const right = cheapestPrice(b.finishPrices);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  });
  return [{ key: PRICE_GROUP_KEY, heading: null, printings: sorted }];
}

/** A set, as the printings of it in this list describe it. */
interface SetBucket {
  code: string;
  /** The first non-null `setName` seen for the code. */
  name: string | null;
  /** The earliest non-null `releasedAt` seen for the code — the set's own date. */
  earliest: string | null;
  printings: Printing[];
}

/**
 * Group by set, sets newest first.
 *
 * **A set's date is the earliest date among its printings, not the first one seen.**
 * {@link Printing} carries no set-level release date, and the per-card dates inside one set
 * disagree: a promo, a prerelease stamp or a Secret Lair drop attached to a set is dated after
 * the set shipped. Taking the earliest is what makes "sets in release order" mean the order the
 * sets came out, rather than an order that a single late variant can push a set to the top of.
 *
 * A set none of whose printings carry a date sorts last, and equal dates are broken by
 * `setCode` ascending — so the answer never depends on which of two same-day sets Rust happened
 * to list first, which is the kind of dependency that makes a test pass on one fixture and fail
 * on the next.
 */
function groupBySet(printings: readonly Printing[]): PrintingGroup[] {
  return buildSetBuckets(printings)
    .sort((a, b) => compareDescending(a.earliest, b.earliest) || compareAscending(a.code, b.code))
    .map((set) => ({
      key: `set:${set.code}`,
      // The upper-cased code is a real fallback, not a defensive one: `set_name` is nullable on
      // the Rust side, and a three-letter code is what a Magic player calls a set anyway.
      heading: set.name ?? set.code.toUpperCase(),
      printings: set.printings,
    }));
}

/**
 * One bucket per set code, in first-seen order, each folding in the set's name and date.
 *
 * The name is the first **non-null** one rather than the first one: `setName` is nullable per
 * row, and heading a fully named set with its code because one row in it happened to arrive
 * without the name would be a worse answer than the one three rows down.
 */
function buildSetBuckets(printings: readonly Printing[]): SetBucket[] {
  const buckets = new Map<string, SetBucket>();
  for (const p of printings) {
    const bucket = buckets.get(p.setCode);
    if (!bucket) {
      buckets.set(p.setCode, {
        code: p.setCode,
        name: p.setName,
        earliest: p.releasedAt,
        printings: [p],
      });
      continue;
    }
    bucket.printings.push(p);
    bucket.name ??= p.setName;
    if (p.releasedAt !== null && (bucket.earliest === null || p.releasedAt < bucket.earliest)) {
      bucket.earliest = p.releasedAt;
    }
  }
  return [...buckets.values()];
}

/**
 * Bucket printings by a key that can be missing, keeping first-seen order.
 *
 * A `Map` because its iteration order is insertion order by specification — which is what
 * "first-seen" is — and a separate list for the nulls because a sentinel key in the same map
 * would be a string an artist or a date could in principle equal. Every bucket holds its
 * printings in the order they arrived; nothing here reorders anything.
 */
function bucketBy(
  printings: readonly Printing[],
  keyOf: (p: Printing) => string | null,
): { known: Map<string, Printing[]>; unknown: Printing[] } {
  const known = new Map<string, Printing[]>();
  const unknown: Printing[] = [];
  for (const p of printings) {
    const key = keyOf(p);
    if (key === null) {
      unknown.push(p);
      continue;
    }
    const bucket = known.get(key);
    if (bucket) bucket.push(p);
    else known.set(key, [p]);
  }
  return { known, unknown };
}

/** Newest first, with `null` — no date at all — always last, whichever side it is on. */
function compareDescending(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Plain code-unit order, for machine strings that no collation should have an opinion about. */
function compareAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/**
 * One printings row as a card menu's target — **the one adapter in the app that reads two
 * objects.**
 *
 * **The card supplies what a printing cannot.** A {@link Printing} says what a piece of cardboard
 * is — set, collector number, finishes — and carries no name, no oracle id and no type line,
 * because all three are facts about the *card* rather than about the printing. Taking them off the
 * card is the stronger answer rather than a workaround, and getting it wrong is invisible: the
 * menu still draws, "Copy card name" copies `undefined`, and a missing oracle id greys "View all
 * printings" with the fence's own sentence — *this printing has left the card database* — over a
 * card that is perfectly healthy.
 *
 * The `typeLine` in particular is load-bearing and is passed as `null` rather than omitted where a
 * caller has none. `useDeck.addCard` reads **absent** as "this caller has nothing to say" and files
 * the card under the default category with no rule run at all, where `null` still goes through
 * `autoCategoryFor` — so omitting the key would take the filing rule off a menu add that a drag of
 * the same row still gets.
 *
 * **Here rather than in either surface, because two build it now** — the card pane's printings
 * list and the printings modal — and a second copy is a second chance to drop a field silently.
 * The second parameter is a shape rather than a `CardDetail` for the same reason: the modal is
 * opened from a store request that carries a name and an oracle id and has never loaded a card.
 */
export function printingTarget(
  printing: Printing,
  card: { name: string; oracleId: string | null; typeLine: string | null },
): CardMenuTarget {
  return {
    cardId: printing.id,
    name: card.name,
    setCode: printing.setCode,
    collectorNumber: printing.collectorNumber,
    oracleId: card.oracleId,
    finishes: printing.finishes,
    typeLine: card.typeLine,
  };
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
