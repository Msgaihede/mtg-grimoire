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

/* ------------------------------------------------------------------------------------------
 * The wire shape, mirrored locally.
 *
 * **To be replaced at fan-in** with `import type { DeckTokenRow, DeckTokenState, TokenSource }
 * from "@/lib/ipc";` plus a re-export of the same three names, so that every importer of this
 * module — the test beside it included — keeps working unchanged. It is declared here because
 * `ipc.ts` is being written in parallel by another task and blocking on it would have bought
 * nothing: these three shapes are pinned in the plan and in the spec, and `ipc.test.ts` is the
 * fence that keeps the Rust side honest about them either way.
 * ---------------------------------------------------------------------------------------- */

/** Whether a stored token row is a plain override, a dismissal, or a hand-added extra. */
export type DeckTokenState = "auto" | "hidden" | "manual";

/** A deck card that makes a token — the answer to "why is this here". */
export interface TokenSource {
  cardId: string;
  name: string;
}

/**
 * One token or emblem a deck needs, with the reader's stored override joined on.
 *
 * `cardId`, `quantity` and `state` are all `null` when the reader has not deviated — the table
 * stores only deviations. The effective values are this module's conclusion; this is the fact.
 */
export interface DeckTokenRow {
  oracleId: string;
  name: string;
  typeLine: string | null;
  layout: string;
  defaultCardId: string;
  sources: TokenSource[];
  derived: boolean;
  cardId: string | null;
  quantity: number | null;
  state: DeckTokenState | null;
  /**
   * The four fields a token needs to be told apart from another token of the same name.
   *
   * **`power` and `toughness` are strings and must never be parsed as numbers.** Scryfall
   * writes `*`, `1+*` and `∞`, and the corpus holds a real `*`-over-`*` Elemental — a token whose
   * size is an expression rather than a number is not a defect to normalise away.
   *
   * `colors` is Scryfall's letters (`""` is genuinely colourless; `null` is *not known*, which
   * is a different sentence and is why the type is nullable rather than defaulted).
   */
  power: string | null;
  toughness: string | null;
  colors: string | null;
  oracleText: string | null;
  /**
   * Where the **resolved printing's** picture is, per variant — the web build's and the
   * phone's only way to draw one, since neither has `mtgimg://` to ask.
   *
   * Optional and nullable both, which is `CardSummary.imageUris`' shape and for its reason: a
   * printing whose only URL is Scryfall's `soon.jpg`, or one on a host this app will not fetch
   * from, carries **nothing** rather than a URL. {@link deckTokenViews} folds it to the single
   * string a tile draws, so nothing downstream of this file indexes it again.
   */
  imageUris?: Partial<Record<ImageVariant, string>> | null;
}

/* ---------------------------------- end of the mirror ------------------------------------- */

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
   * The one URL the tile needs, or `null` for the no-art frame.
   *
   * **Resolved here rather than passed as a map**, so the panel does no lookup and cannot pick
   * a different variant from the walls beside it: {@link WALL_CARD_VARIANT} is what every wall
   * of card faces in this app draws, and a second call site choosing for itself is the pairing
   * failure `images.ts` records — each variant is its own URL and its own cache directory, so a
   * surface asking for one nothing pre-warms fetches cold for ever with nothing on screen to
   * say so.
   *
   * **It is the whole of what this module concludes about the picture.** `CardArt` ignores it
   * on the desktop, where `mtgimg://` reaches the local cache; on the web target and on
   * Android it is the picture. `null` is the honest answer for a printing the backend refused
   * a URI for, and never a reason for a caller to build one.
   */
  imageUrl: string | null;
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
