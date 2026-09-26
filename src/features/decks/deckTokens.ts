/**
 * The tokens and emblems a deck needs, as the panel draws them.
 *
 * **Rust supplies the facts and this file draws every conclusion**, which is the same boundary
 * the rest of the deck builder keeps. Rust resolves each deck card's `all_parts` against the
 * corpus and joins on whatever the reader stored against that token; what it hands over is
 * true whether or not anything is ever rendered. Which printing to draw, how many copies the
 * stepper starts at, whether a dismissed token is on screen at all and the order the wall
 * reads in are all decisions, and they live here — in one function, with one test file, so
 * that changing a rule is one edit and not four components disagreeing.
 *
 * **The table stores deviations only** (spec §4). A token nobody touched has no row at all, so
 * `cardId`, `quantity` and `state` all arrive `null` in the ordinary case and every one of
 * them needs a fallback. Those fallbacks are written with `??` and must stay that way: `||`
 * agrees with `??` on every value the reader can produce except one, and that one — a
 * quantity of 0 — is a decision they made on purpose.
 *
 * **Nothing here fetches, and nothing here can be unavailable.** The feature reads the corpus
 * the app already has, so unlike the Tagger datasets or the price feeds there is no
 * never-fetched floor to fall back to: a deck that derives nothing derives nothing.
 */

import { WALL_CARD_VARIANT, type ImageVariant } from "@/lib/images";
import type { DeckTokenRow, DeckTokenState, TokenSource } from "@/lib/ipc";

/**
 * The wire shape, re-exported from its one home.
 *
 * It was mirrored here while `ipc.ts` was being written in parallel, under a banner asking for
 * exactly this at fan-in: `ipc.ts` is the hand-written mirror of the crate and `ipc.test.ts` is
 * the fence on it, so a second copy in this file was a second thing that could drift and a
 * thing the fence could not see. Re-exported rather than re-pointed at every importer, so the
 * panel, the hook, the picker and the test beside this file keep importing from here.
 */
export type { DeckTokenRow, DeckTokenState, TokenSource };

/**
 * How many copies a token the reader has never touched shows.
 *
 * **A floor, deliberately, and never a guess.** Reading *"create two 1/1 white Soldier
 * tokens"* out of oracle text is defeated by `create X`, by *for each*, by copy-tokens and by
 * repeatable makers like Krenko, and a number the reader has to correct is worse than one they
 * raise. It is stored as an *absent* quantity rather than as a 1, so moving this constant
 * later moves every untouched token with it.
 *
 * Typed `number` rather than left as the literal `1`: a consumer that seeds a `useState` from
 * it would otherwise get a state of type `1` and be unable to set anything else.
 */
export const DEFAULT_TOKEN_QUANTITY: number = 1;

/** One token or emblem, resolved — every field is what to draw, with no fallback left to do. */
export interface DeckTokenView {
  oracleId: string;
  name: string;
  typeLine: string | null;
  layout: string;
  /** What to draw: the reader's pick, else the resolver's. */
  printingId: string;
  /** What to show in the stepper. */
  quantity: number;
  sources: TokenSource[];
  derived: boolean;
  state: DeckTokenState;
  /** True when the reader has deviated — drives the "reset" affordance. */
  overridden: boolean;
  /** {@link tokenSubtitle}'s line, or `null` where there is nothing to say. */
  subtitle: string | null;
  /**
   * The one URL the band's tile needs, or `null` for the no-art frame.
   *
   * **Resolved here for the band**, so its wall does no lookup and cannot pick a different
   * variant from the walls beside it: {@link WALL_CARD_VARIANT} is what every wall of card faces
   * in this app draws, and a second call site choosing for itself is the pairing failure
   * `images.ts` records — each variant is its own URL and its own cache directory, so a surface
   * asking for one nothing pre-warms fetches cold for ever with nothing on screen to say so.
   *
   * **It is the whole of what this module concludes about the picture.** `CardArt` ignores it
   * on the desktop, where `mtgimg://` reaches the local cache; on the web target and on
   * Android it is the picture. `null` is the honest answer for a printing the backend refused
   * a URI for, and never a reason for a caller to build one. The token *pile* is the one
   * surface that does not read it — see {@link DeckTokenView.imageUris}.
   */
  imageUrl: string | null;
  /**
   * The row's whole picture map, passed through beside {@link DeckTokenView.imageUrl} and
   * **not a second conclusion about it**.
   *
   * The token pile draws the deck's own `DeckCardFace`, and that component picks its own
   * variant — `DECK_CARD_VARIANT`, the whole printed card the stacked view draws — off the map,
   * which is what keeps a token and a deck card in one pile on one variant and one pre-warm.
   * Narrowing to {@link WALL_CARD_VARIANT} here would hand it the wrong picture; choosing
   * `DECK_CARD_VARIANT` here would be this module deciding a view's variant. `null` for a row
   * with none, and for a row from a build that predates the field.
   */
  imageUris: Partial<Record<ImageVariant, string>> | null;
  /**
   * The effective printing's chin facts and price — {@link DeckTokenRow.setCode} and its five
   * neighbours, resolved by Rust off the printing {@link DeckTokenView.printingId} names and
   * **passed through untouched**. What the chin prints from them (the finish word, the em dash,
   * the currency) is the drawing's conclusion and not this module's: a view keyed on a stored
   * fact can be tested against the fact, and a second decision here would be a second place a
   * Treasure's price could come to disagree with the picker's.
   *
   * `unitPrice` is one copy at the marketplace the read was asked for, `null` where it quotes
   * none; the pile's heading multiplies it by {@link DeckTokenView.quantity}, and nothing sums it
   * into the deck's own totals.
   */
  setCode: string | null;
  collectorNumber: string | null;
  setName: string | null;
  rarity: string | null;
  finishes: string | null;
  unitPrice: number | null;
}

/**
 * Whether a row is an emblem.
 *
 * **The layout and not the type line.** `layout` is a column Scryfall fills and this app
 * stores; a type line is prose — `"Emblem — Elspeth"` is one shape of it, and a card whose
 * text merely mentions the word is not an emblem. Taking a structural answer from prose is how
 * the ordering rule below would quietly stop working.
 *
 * Takes the narrowest shape it needs so a caller holding a `DeckTokenRow`, a `DeckTokenView`
 * or a bare `cards` row can all ask.
 */
export function isEmblem(row: { layout: string }): boolean {
  return row.layout === "emblem";
}

/**
 * Scryfall's colour letters as words, in WUBRG order.
 *
 * The order is the array's rather than the string's, so `UW` and `WU` produce one subtitle:
 * they are the same two colours, and a tile that read them differently would invent a
 * distinction the cardboard does not have.
 */
const COLOR_WORDS: ReadonlyArray<readonly [letter: string, word: string]> = [
  ["W", "White"],
  ["U", "Blue"],
  ["B", "Black"],
  ["R", "Red"],
  ["G", "Green"],
];

/** A string that says something — `null` and whitespace are both "nothing to print". */
function present(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/** `null` for unknown, `"Colorless"` for the empty set, the words otherwise. */
function colorsAsWords(colors: string | null): string | null {
  if (colors === null) return null;
  const words = COLOR_WORDS.filter(([letter]) => colors.includes(letter)).map(([, word]) => word);
  return words.length === 0 ? "Colorless" : words.join(" ");
}

/**
 * A one-line disambiguator for a token whose name it shares with others.
 *
 * **A token's name does not identify it**, which is the whole reason this exists. Measured on
 * the debug corpus on 2026-09-07: 104 token and emblem names are carried by more than one
 * `oracle_id` — `Elemental` by 31, `Spirit` by 22, `Soldier` by 13 — and `Wurmcoil Engine`
 * alone makes two tokens both called `Wurm`, both 3/3, both colourless artifacts, separated
 * only by Deathtouch against Lifelink. Two tiles announcing the same accessible name is a bug
 * that has shipped on the collection wall once already, and neither suite can catch it: both
 * names are *correct*, merely not unique.
 *
 * **All three of colours, size and text are in the line, because each alone is insufficient.**
 * Text alone cannot separate the corpus's colourless 1/1 Soldier from its white one — neither
 * has any — and colours and size alone cannot separate the two Wurms. Dropping a term to
 * shorten the line re-opens exactly one of those two cases.
 *
 * The shape is `<colours> <power>/<toughness> · <oracle text>`, with any term that has nothing
 * to say left out and the whole thing `null` when none of them has anything — a Treasure reads
 * `Colorless · {T}, Sacrifice this token: Add one mana of any color.` and a vanilla white
 * Soldier reads `White 1/1`. The text is **not truncated here**: a clamp is a decision about a
 * tile's width, and one applied in this function would silently fold two tokens back together.
 *
 * Returns `null` for an emblem — its type line already names the planeswalker, so a second
 * line would repeat what the tile is drawing.
 *
 * `typeLine` is in the parameter shape and deliberately unread: the emblem test is the
 * **layout**, for {@link isEmblem}'s reason, and a type line's words are the name the tile sets
 * beside this line anyway. It stays in the `Pick` so a change to the wording can reach it
 * without every caller changing.
 */
export function tokenSubtitle(
  row: Pick<
    DeckTokenRow,
    "power" | "toughness" | "colors" | "oracleText" | "layout" | "typeLine"
  >,
): string | null {
  if (isEmblem(row)) return null;
  const size =
    present(row.power) && present(row.toughness) ? `${row.power}/${row.toughness}` : null;
  const head = [colorsAsWords(row.colors), size].filter(present).join(" ");
  // Oracle text arrives with Scryfall's own line breaks in it; a subtitle is one line.
  const text = (row.oracleText ?? "").replace(/\s*\n+\s*/g, " · ").trim();
  const parts = [head, text].filter((part) => part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/** One row's decisions, made once. */
function viewOf(row: DeckTokenRow): DeckTokenView {
  return {
    oracleId: row.oracleId,
    name: row.name,
    typeLine: row.typeLine,
    layout: row.layout,
    // `??` on both, and never `||`. A stored `""` is not reachable — `card_id` is either a
    // printing or NULL — but a stored 0 is, and it is a token the reader zeroed while keeping
    // the art they chose for it.
    printingId: row.cardId ?? row.defaultCardId,
    quantity: row.quantity ?? DEFAULT_TOKEN_QUANTITY,
    // Passed through rather than copied: the rows come straight off a React Query cache and
    // nothing downstream mutates them.
    sources: row.sources,
    derived: row.derived,
    state: row.state ?? "auto",
    // "There is something to reset", which is exactly the three stored columns. `quantity`
    // is compared against `null` rather than tested for truth for the reason above: 0 is a
    // deviation and the most easily lost one.
    overridden:
      row.cardId !== null ||
      row.quantity !== null ||
      (row.state !== null && row.state !== "auto"),
    subtitle: tokenSubtitle(row),
    // `??` for the absent key as well as for the null: `imageUris` is `Partial`, so a printing
    // that publishes only some variants has no entry at all for the rest.
    imageUrl: row.imageUris?.[WALL_CARD_VARIANT] ?? null,
    // The map itself, folded only from *absent* to `null`: the field is optional on the wire,
    // and one spelling of "no picture" is all a surface downstream should have to handle.
    imageUris: row.imageUris ?? null,
    // Facts about the effective printing, copied as they came — see `DeckTokenView.setCode`.
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    setName: row.setName,
    rarity: row.rarity,
    finishes: row.finishes,
    unitPrice: row.unitPrice,
  };
}

/**
 * Emblems last, then by name — and **then by subtitle, then by oracle id, because the name is
 * not a tiebreak**.
 *
 * An emblem is a one-off a deck may make once in a game; a pile of Treasures is what a reader
 * reaches for, so the things they touch sit where they can be touched. Within each half the
 * order is the name, compared with the locale pinned to `"en"` for the reason every `Intl`
 * call in this app pins it: the collation is part of what the app *does*, and a wall that
 * reorders itself on a different machine is one two readers cannot compare.
 *
 * **The last two terms are what make that promise true rather than nearly true.** Sorting on
 * the name alone leaves two same-named tokens tied, and a tie is resolved by whatever order
 * the backend happened to return — so `Wurmcoil Engine`'s two Wurms could swap places between
 * two opens of one deck, for a reason the reader cannot see. That is not hypothetical: it is
 * how this was found, and 104 token/emblem names are shared by more than one `oracle_id`
 * (debug corpus, 2026-09-07). The subtitle comes first of the two because it is the thing the
 * reader can actually read — Deathtouch before Lifelink is an order that means something —
 * and the oracle id is the final term only so that the comparator is total.
 */
function byEmblemThenName(a: DeckTokenView, b: DeckTokenView): number {
  const emblems = Number(isEmblem(a)) - Number(isEmblem(b));
  if (emblems !== 0) return emblems;
  const names = a.name.localeCompare(b.name, "en");
  if (names !== 0) return names;
  const subtitles = (a.subtitle ?? "").localeCompare(b.subtitle ?? "", "en");
  if (subtitles !== 0) return subtitles;
  return a.oracleId.localeCompare(b.oracleId, "en");
}

/**
 * The resolver's rows as the panel's tiles.
 *
 * `hidden` rows are dropped unless `showDismissed` — a dismissal is the reader saying "not in
 * this deck", so it has to actually leave the wall, and the affordance that brings it back is
 * the only way to undo it. `manual` rows stay whether the deck derives them or not; that is
 * the whole of what the word means.
 *
 * Returns a **new** array. The input is `readonly` and untouched, because it is a query
 * cache's own array and sorting it in place would reorder the cache under React.
 */
export function deckTokenViews(
  rows: readonly DeckTokenRow[],
  opts?: { showDismissed?: boolean },
): DeckTokenView[] {
  const showDismissed = opts?.showDismissed ?? false;
  return rows
    .map(viewOf)
    .filter((view) => showDismissed || view.state !== "hidden")
    .sort(byEmblemThenName);
}
