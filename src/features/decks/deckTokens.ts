/**
 * The tokens and emblems a deck needs, as the panel draws them.
 *
 * **Rust supplies the facts and this file draws every conclusion**, which is the same boundary
 * the rest of the deck builder keeps. Rust resolves each deck card's `all_parts` against the
 * corpus and joins on whatever the reader stored against that token; what it hands over is
 * true whether or not anything is ever rendered. Which entries the stacks draw, the order the
 * wall reads in, the key each tile is drawn under and the name each control answers to are all
 * decisions, and they live here — in one function each, with one test file, so that changing a
 * rule is one edit and not four components disagreeing.
 *
 * **A wire row is one _entry_ since user schema v52** — one printing, in one finish, of one
 * token, in the list the read named (token stacks spec §4.2) — and Rust resolves it: an
 * untouched token arrives as one **implicit** row at the resolver's default printing and
 * `deck_tokens.quantity ?? 0`, and a token with entries arrives as exactly those. So the
 * fallbacks this file used to draw (`cardId ?? defaultCardId`, `quantity ?? 1`) are Rust's now,
 * and what is left here is the grain the wall keys on ({@link DeckTokenView.entryKey}), the order
 * it reads in, which entries the deck's stacks draw ({@link pileTokens}) and which tokens nothing
 * in the deck makes ({@link isHandAdded}).
 *
 * **Nothing here fetches, and nothing here can be unavailable.** The feature reads the corpus
 * the app already has, so unlike the Tagger datasets or the price feeds there is no
 * never-fetched floor to fall back to: a deck that derives nothing derives nothing.
 */

import { FINISH_LABEL, FINISHES, type Finish } from "@/lib/finish";
import type { DeckTokenRow, DeckTokenState, TokenSource } from "@/lib/ipc";
import { tileKeyOf } from "@/lib/tileKey";

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
 * How many copies a token the reader has never touched shows — the `0` in Rust's
 * `deck_tokens.quantity ?? 0` for an implicit entry (`implicit_quantity`).
 *
 * **Zero since managed tokens spec §3.1, because a token is something the reader starts to
 * use.** It was `1` — a floor, on the argument that reading *"create two 1/1 white Soldier
 * tokens"* out of oracle text is defeated by `create X`, by *for each* and by repeatable makers,
 * so a number the reader raises beats one they correct. That argument still rules out a guess;
 * what it did not survive is the pile, which drew every token a deck *could* make whether or not
 * the reader ever sleeved one. At 0 the band still lists them all, and a token reaches the stacks
 * the moment the reader counts it. **A legacy count is still honoured**: a quantity a reader set
 * before v52 is the `deck_tokens.quantity` this falls back from, and reads as itself.
 *
 * **Rust applies it** — a wire row's quantity is already effective — so this is the TypeScript
 * spelling of that fact, kept for the one reader that has to answer it itself: the Storybook
 * fake, which mirrors the resolver.
 *
 * Typed `number` rather than left as the literal `0`: a consumer that seeds a `useState` from
 * it would otherwise get a state of type `0` and be unable to set anything else.
 */
export const DEFAULT_TOKEN_QUANTITY: number = 0;

/**
 * The three `cards.layout` words that make a printing a token **by themselves** —
 * `deck_tokens::TOKEN_LAYOUTS`. A `Set` for {@link isTokenLayout}'s one lookup.
 */
const TOKEN_LAYOUTS: ReadonlySet<string> = new Set(["token", "double_faced_token", "emblem"]);

/**
 * The two layouts a token *can* wear without being one — `deck_tokens::TWO_SIDED_LAYOUTS`, the
 * half of {@link isTokenPrinting} the type line answers. Six printings in the debug corpus are
 * tokens under them (five `flip` Role tokens and the `reversible_card` Mechtitan) against 119 real
 * cards (Jace, Kytheon, the double-sided basics), measured by the crate on 2026-09-26.
 */
const TWO_SIDED_LAYOUTS: ReadonlySet<string> = new Set(["flip", "reversible_card"]);

/**
 * Whether a `cards.layout` word is a token's **on its own** — `token`, `double_faced_token` or
 * `emblem` — and **the TypeScript twin of `deck_tokens::is_token_layout`**, for drawing.
 *
 * **Not the routing question, and it answers `false` for six real tokens.** A `flip` Role token
 * or the `reversible_card` Mechtitan is a token by its type line and not by its layout, so a
 * caller deciding whether a printing *is* a token asks {@link isTokenPrinting}. This answers the
 * narrower question a surface asks about a row the crate has already filed as a token.
 *
 * **It routes nothing in the app.** A token dropped on a pile or added from the search column is
 * filed as a token entry by Rust, at `deck::add_card` and `collection_alloc::collection_to_deck`,
 * because no drag payload and no add call carries the card's layout (measured 2026-09-26) — a
 * router here would have to thread it through six call sites and would miss the seventh.
 *
 * Absent (`null`, `undefined`) is not a token.
 */
export function isTokenLayout(layout: string | null | undefined): boolean {
  return layout !== null && layout !== undefined && TOKEN_LAYOUTS.has(layout);
}

/**
 * **Whether a printing is a token or an emblem** — the TypeScript twin of
 * `deck_tokens::is_token_printing`, the question both of the crate's add paths route on and the
 * one `add_printing_in` refuses everything else by (`NOT_A_TOKEN`). The Storybook fake routes and
 * refuses on this; the app itself routes nothing ({@link isTokenLayout}'s second paragraph).
 *
 * Two halves, in the crate's order:
 *
 * 1. **The layout alone**, for {@link TOKEN_LAYOUTS} — {@link isTokenLayout}.
 * 2. **The type line, for {@link TWO_SIDED_LAYOUTS}** — a `flip` or `reversible_card` printing is
 *    a token when its type line, **or any face of it**, begins `Token` or `Emblem`. The corpus
 *    stores a two-faced printing's line as its faces joined by ` // `, so the faces are the
 *    ` // ` segments and nothing is parsed. Scryfall writes the `Token` supertype first, which is
 *    why a case-sensitive prefix is the whole test.
 *
 * Any other layout is never a token, whatever its line says — a `normal` card whose line starts
 * `Token` is not read as one. An absent layout or an absent line answers `false`.
 */
export function isTokenPrinting(
  layout: string | null | undefined,
  typeLine: string | null | undefined,
): boolean {
  if (isTokenLayout(layout)) return true;
  if (layout === null || layout === undefined || !TWO_SIDED_LAYOUTS.has(layout)) return false;
  return lineNamesAToken(typeLine);
}

/** Whether a type line, or any ` // ` face of it, begins `Token` or `Emblem` —
 *  `deck_tokens::line_names_a_token`. */
function lineNamesAToken(typeLine: string | null | undefined): boolean {
  if (typeLine === null || typeLine === undefined) return false;
  return typeLine
    .split(" // ")
    .some((face) => face.startsWith("Token") || face.startsWith("Emblem"));
}

/** `deck_tokens::HELPER_LAYOUTS` — the layouts a game helper is filed under. */
const HELPER_LAYOUTS: ReadonlySet<string> = new Set(["token", "double_faced_token"]);

/** `deck_tokens::OTHER_GAME_SET_TYPES` — the set types whose helpers belong to another game. */
const OTHER_GAME_SET_TYPES: ReadonlySet<string> = new Set(["memorabilia", "minigame"]);

/**
 * **Whether All tokens lists a printing: a real token or emblem, or a game helper** — the
 * TypeScript twin of `deck_tokens::is_listed_token`, for the one reader that answers
 * `token_printings` itself: the Storybook fake.
 *
 * Two arms, in the crate's order:
 *
 * 1. **A token or an emblem** — a token or two-sided layout **and** a type line naming a `Token` or
 *    `Emblem` face.
 * 2. **A game helper** — a `token` or `double_faced_token` printing outside a `memorabilia` or
 *    `minigame` set, with a face whose type line is exactly `Card` (The Monarch, Day // Night,
 *    Undercity // The Initiative) and no checklist's `this card to represent `, **or** a face
 *    beginning `Dungeon` (the dungeons a venturing deck brings, issue #670), **or** a face-down
 *    reminder whose text says `face-down` (Manifest, Morph, the Cyberman).
 *
 * The reader's rule (2026-09-28): keep what a deck brings to the table in an ordinary game, leave
 * out advertising, checklists, minigames and other games' cards, and keep anything in doubt. The
 * crate's doc has the corpus counts and why no name list is needed. Case-sensitive throughout, as
 * the crate's `instr` is. `setType` is the set's `set_type`, `null` where it is unknown, which
 * lists a helper. {@link isTokenPrinting} stays the routing question.
 */
export function isListedToken(
  layout: string | null | undefined,
  typeLine: string | null | undefined,
  oracleText: string | null | undefined,
  setType: string | null | undefined,
): boolean {
  if (layout === null || layout === undefined) return false;
  if ((isTokenLayout(layout) || TWO_SIDED_LAYOUTS.has(layout)) && lineNamesAToken(typeLine)) {
    return true;
  }
  if (!HELPER_LAYOUTS.has(layout)) return false;
  if (setType !== null && setType !== undefined && OTHER_GAME_SET_TYPES.has(setType)) return false;
  const text = oracleText ?? "";
  const faces = (typeLine ?? "").split(" // ");
  const helperFace = faces.some((face) => face === "Card");
  const dungeon = faces.some((face) => face.startsWith("Dungeon"));
  return (
    (helperFace && !text.includes("this card to represent ")) ||
    dungeon ||
    text.includes("face-down")
  );
}

/**
 * One entry of a token list, resolved — every field is what to draw, with no fallback left to do.
 *
 * **One view per entry** (user schema v52): a token with a foil and a nonfoil Treasure in the list
 * is two views sharing an {@link oracleId} and differing in {@link printingId}, {@link finish},
 * {@link quantity} and everything below the picture. Every surface keys a tile on
 * {@link entryKey}, never on the oracle id.
 */
export interface DeckTokenView {
  oracleId: string;
  name: string;
  typeLine: string | null;
  layout: string;
  /** This entry's printing — Rust's resolved `cardId`, the resolver's default for an implicit
   *  entry. What the tile draws and what the chin describes. */
  printingId: string;
  /** This entry's finish — never `null`, the collection's own three words. What the chin names,
   *  what the sheen is drawn for and what {@link unitPrice} was read at. */
  finish: Finish;
  /**
   * `true` when this list holds no entry of the token and this is the one Rust drew for it. A
   * write aimed at it sends `null` for the entry, and Rust materialises it (spec §4.2 rule 2).
   *
   * **It is also the whole of whether Remove printing is drawn** (managed tokens spec §3.4), on
   * the band and the pile alike: `deck_token_remove` deletes one stored entry, and an implicit
   * one is not stored, so a Remove over it would be a press that changes nothing. The token's
   * state is no part of that.
   */
  implicit: boolean;
  /**
   * The tile's identity — `tileKeyOf(printingId, finish)`, the collection wall's own spelling,
   * because the grain is the same one: two copies of one printing in two finishes are two
   * objects. Unique within one list's answer by construction (`deck_token_printings` is unique on
   * `(deck, list, card, finish)`, and an implicit entry exists only where no stored one does).
   */
  entryKey: string;
  /** What to show in the stepper — Rust's effective quantity. `0` is a value. */
  quantity: number;
  sources: TokenSource[];
  /** Whether the deck makes this token — `false` is a token added by hand, which the wall marks
   *  (see {@link isHandAdded}). */
  derived: boolean;
  /**
   * The token's stored state, passed through and **read by nothing that draws**: `hidden` is a
   * dismissal an older peer can still sync in, and it is drawn like any other token until the
   * launch pass retires it (managed tokens spec §3.3).
   */
  state: DeckTokenState;
  /** {@link tokenSubtitle}'s line, or `null` where there is nothing to say. */
  subtitle: string | null;
  /**
   * The entry's chin facts and price — {@link DeckTokenRow.setCode} and its five neighbours,
   * resolved by Rust off the printing {@link DeckTokenView.printingId} names and **passed through
   * untouched**. What the chin prints from them (the finish word, the em dash, the currency) is
   * the drawing's conclusion and not this module's: a view keyed on a stored fact can be tested
   * against the fact, and a second decision here would be a second place a Treasure's price could
   * come to disagree with the picker's.
   *
   * `unitPrice` is one copy **at the entry's {@link finish}** at the marketplace the read was
   * asked for, `null` where it quotes none; the pile's heading multiplies it by
   * {@link DeckTokenView.quantity}, and nothing sums it into the deck's own totals.
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
    // The entry's own printing, finish and quantity, as Rust resolved them — an implicit entry's
    // are the resolver's default and `deck_tokens.quantity ?? 0` already. No fallback here: a
    // second one would be a second, stale copy of spec §4.2's rule 1.
    printingId: row.cardId,
    finish: row.finish,
    implicit: row.implicit,
    entryKey: tileKeyOf(row.cardId, row.finish),
    quantity: row.quantity,
    // Passed through rather than copied: the rows come straight off a React Query cache and
    // nothing downstream mutates them.
    sources: row.sources,
    derived: row.derived,
    state: row.state,
    subtitle: tokenSubtitle(row),
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
 * and the oracle id is what keeps one token's entries from interleaving with another's. Within
 * one token, {@link byEntry} orders the entries.
 */
function byEmblemThenName(a: DeckTokenView, b: DeckTokenView): number {
  const emblems = Number(isEmblem(a)) - Number(isEmblem(b));
  if (emblems !== 0) return emblems;
  const names = a.name.localeCompare(b.name, "en");
  if (names !== 0) return names;
  const subtitles = (a.subtitle ?? "").localeCompare(b.subtitle ?? "", "en");
  if (subtitles !== 0) return subtitles;
  const tokens = a.oracleId.localeCompare(b.oracleId, "en");
  if (tokens !== 0) return tokens;
  return byEntry(a, b);
}

/**
 * Collector numbers compared **as numbers where they are numbers** — `2` before `15` — and as
 * text where they are not (`15a`, `★`). Pinned to `"en"` for the reason the name comparison is.
 */
const COLLECTOR_ORDER = new Intl.Collator("en", { numeric: true });

/**
 * **One token's entries, in the order a reader looks for a printing**: set, then collector
 * number, then finish in `FINISHES` order (nonfoil, foil, etched) — spec §4.2 — so a token's
 * printings sit together and a foil copy sits right after its nonfoil twin.
 *
 * A printing gone from the corpus has no set and no number; its `null`s sort as empty text, in
 * front, which is a stable place rather than a meaningful one. The printing id is the final term
 * only so the comparator is total: two entries of one token cannot share a printing *and* a
 * finish, because that is the grain.
 */
function byEntry(a: DeckTokenView, b: DeckTokenView): number {
  const sets = (a.setCode ?? "").localeCompare(b.setCode ?? "", "en");
  if (sets !== 0) return sets;
  const numbers = COLLECTOR_ORDER.compare(a.collectorNumber ?? "", b.collectorNumber ?? "");
  if (numbers !== 0) return numbers;
  const finishes = FINISHES.indexOf(a.finish) - FINISHES.indexOf(b.finish);
  if (finishes !== 0) return finishes;
  return a.printingId.localeCompare(b.printingId, "en");
}

/**
 * What a token write needs to address one entry — the token, the entry's grain and whether it
 * is the implicit one. {@link entryRef} makes one out of a view; `useDeckTokens`' writes take it.
 *
 * **`implicit` is what turns into `null` on the wire**: an implicit entry is not stored, so a
 * write aimed at it names no `(cardId, finish)` and Rust materialises the default in this list
 * only (spec §4.2 rule 2). Its `cardId` and `finish` are the printing the resolver drew, and
 * **no write reads them**: `useDeckTokens`' `stored` answers `null` off `implicit` alone, and a
 * swap's destination is an argument of its own rather than anything on this reference. They are
 * carried because a reference is made from a view, and a stored entry's pair is its address.
 */
export interface TokenEntryRef {
  oracleId: string;
  cardId: string;
  finish: Finish;
  implicit: boolean;
}

/**
 * The four facts that address a view's entry, **and nothing else** — so a write is handed a
 * reference rather than a whole view, and a stale view cannot carry a quantity or a state into
 * a write by accident.
 */
export function entryRef(view: DeckTokenView): TokenEntryRef {
  return {
    oracleId: view.oracleId,
    cardId: view.printingId,
    finish: view.finish,
    implicit: view.implicit,
  };
}

/**
 * One entry's name folded into a verb, for a control's accessible name —
 * `Quantity of Treasure, <subtitle>, TMOM · 12, Foil` — and **the one spelling of it**: the band
 * (`DeckTokensPanel`) and the pile the four views draw (`views/TokenPile`) both call this, because
 * one entry is drawn on both surfaces at once and must not answer to two names on one screen.
 *
 * **The subtitle is in every one of them**, which is the whole of what keeps two `Wurm`s apart for
 * a reader who cannot see them. **So are the printing and the finish, since v52**, which is what
 * keeps one token's entries apart: a Treasure kept as a plain and a foil copy of one printing
 * shares its name and its subtitle, and only `Nonfoil` against `Foil` separates the two. The
 * printing is written as the chin under the picture writes it (`SET · number`), so what the ear
 * hears is what the eye reads; the finish is spelled on every entry, plain copies included,
 * because on this wall it is a grain term rather than a mark. A printing gone from the corpus
 * (its chin facts all `null`) says no printing and still says its finish. The name's head is
 * `<verb> <name>`, so `/^Change the art for Treasure/` finds every entry of the token.
 *
 * A name assembled from a tile's visible elements would not do: a `gap` between two flex children
 * runs their words together in the computed name, so each control spells its own — through this
 * one helper, so a control added later cannot be the one that forgets a term.
 */
export function tokenEntryName(verb: string, view: DeckTokenView): string {
  const printing = [view.setCode?.toUpperCase(), view.collectorNumber]
    .filter((part): part is string => part !== undefined && part !== null && part !== "")
    .join(" · ");
  return [
    `${verb} ${view.name}`,
    ...(view.subtitle === null ? [] : [view.subtitle]),
    ...(printing === "" ? [] : [printing]),
    FINISH_LABEL[view.finish],
  ].join(", ");
}

/**
 * The resolver's rows as the panel's tiles — **one per entry**, a token's entries together, and
 * **every row**.
 *
 * **Nothing is filtered, `hidden` included** (managed tokens spec §3.3). Dismiss is gone and a
 * launch pass retires the word, but a dismissal an older peer syncs in after that pass has run
 * reaches this function before the next launch does — and a token that left the wall with no
 * control anywhere to bring it back would be the one outcome worse than a stale word. So it is
 * drawn as the ordinary token it is about to become. `manual` rows stay whether the deck derives
 * them or not; that is the whole of what the word means.
 *
 * Returns a **new** array. The input is `readonly` and untouched, because it is a query
 * cache's own array and sorting it in place would reorder the cache under React.
 */
export function deckTokenViews(rows: readonly DeckTokenRow[]): DeckTokenView[] {
  return rows.map(viewOf).sort(byEmblemThenName);
}

/**
 * The tokens the deck's stacks draw: the ones the reader has counted (managed tokens spec §3.2).
 *
 * **Applied to the pile's list and nowhere else** — `DeckEditor`'s `tokenPile.tokens`. The band
 * lists every token the deck makes and every one added by hand, at whatever count, because it is
 * where a token is counted in the first place; Add printing and the live side of the plan's marks
 * read every row for the same reason. A token whose every entry is 0 draws nothing in the stacks,
 * and the pile's heading, which sums copies, is unchanged by the zeros it no longer lists.
 *
 * Entry by entry rather than token by token, so a Treasure kept as three plain copies and a foil
 * stepped to 0 draws one card. Order is kept, and the answer is a new array.
 */
export function pileTokens(views: readonly DeckTokenView[]): DeckTokenView[] {
  return views.filter((v) => v.quantity > 0);
}

/**
 * A token nothing in the deck makes — **`derived`, never `state`** (managed tokens spec §3.5).
 *
 * A derived token can be `manual` — kept by hand after a cut, or restored before this build — and
 * marking it *not made by deck* would be a false sentence about a token a card in the deck is
 * sitting there making. `derived: false` is the resolver's own answer to the only question the
 * mark asks.
 */
export function isHandAdded(view: Pick<DeckTokenView, "derived">): boolean {
  return !view.derived;
}

/**
 * The words on a hand-added token's badge — **`NOT MADE BY DECK`**, in capitals like the
 * `RULE BREAK` mark it stands in for, because it is drawn in that mark's place and style.
 */
export const NOT_MADE_BY_DECK = "NOT MADE BY DECK";

/** The badge's sentence for the pointer, naming the token — managed tokens spec §3.5's words. */
export function notMadeByDeckHint(name: string): string {
  return `Nothing in this deck makes ${name}. It was added manually.`;
}

/**
 * The accessible name of an entry's **Change the art** press — the band's tile picture, and the
 * pile's own art button in all four views — with the mark's words folded in for a hand-added
 * token. (The pile's card face opens the card details since issue #619, named by
 * {@link tokenCardName}.)
 *
 * **The badge is `aria-hidden`**, like every other mark on a card, so a mark drawn and not spoken
 * would be a fact that reaches sighted readers only; the words join the name instead, lower-cased
 * as a clause the way `deckCardName` folds a rule break. A derived token's name is exactly
 * {@link tokenEntryName}'s, so `/^Change the art for Treasure/` still finds every entry.
 */
export function tokenArtName(view: DeckTokenView): string {
  const name = tokenEntryName("Change the art for", view);
  return isHandAdded(view) ? `${name}, ${NOT_MADE_BY_DECK.toLowerCase()}` : name;
}

/**
 * The accessible name of the press that opens an entry's **card details** — the pile's card face
 * in Stacks and Grid, the line in Text, the name in Table (issue #619: a token in the stack opens
 * the card modal, as every deck card does).
 *
 * `Show details for …` rather than the bare token: the pile's card is a control beside the
 * entry's other three (the stepper, **Change the art**, Remove printing), and each of those is
 * named `<verb> <entry>` through {@link tokenEntryName} too, so the four read as four things one
 * entry can be asked. The badge's words are folded in exactly as {@link tokenArtName} folds them,
 * because this is the press drawn *over* the badge on the two card drawings.
 */
export function tokenCardName(view: DeckTokenView): string {
  const name = tokenEntryName("Show details for", view);
  return isHandAdded(view) ? `${name}, ${NOT_MADE_BY_DECK.toLowerCase()}` : name;
}
