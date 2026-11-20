/**
 * The **Deck colors** widget's judgement — which colour combination each deck is filed under,
 * which decks are counted at all, and the order they stand in inside a combination — as pure
 * functions, so every rule can be read and tested without a render around it.
 *
 * The widget is a reader's colour-coverage sheet kept for them: every one of Magic's 32 colour
 * combinations, each with the decks that play it, the empty ones drawn empty. It replaces a
 * spreadsheet a reader kept by hand, so its rows are the rows such a sheet has — the five mono
 * colours and colourless, the ten pairs, the ten triples, the five four-colour combinations and
 * the one five-colour — and it fills them from the decks themselves.
 *
 * ## What colour a deck is
 *
 * **The command zone's colour identity first, the cards' printed colours otherwise.** A Commander
 * deck *is* its commander's colour identity — that is the rule the format builds the deck by, and
 * the column a reader's sheet sorts by — and it is the right answer even while the deck is half
 * built: an Alesha deck holding only red cards so far is still a Mardu deck. The identity is
 * Rust's fact (`deck_commander_identities`, the union of every card in the deck's active
 * `commander` piles, so partners and backgrounds fold together). A deck with no commander — a
 * Modern list, a Commander deck nobody has named a commander for yet — is filed by the colours
 * its cards' mana costs ask for, which is the gallery's own colour bar (`deck_pip_costs` through
 * `deckPips.ts`), with `{C}` left out: a colourless pip is a demand for a kind of mana, not a
 * colour, so a mono-white deck with one Eldrazi in it is still Mono White.
 *
 * **Both read the list the gallery's tile reads** (`tileList`): a `THEORY ONLY` deck — a plan
 * with nothing in its Actual list yet — is filed by its plan, exactly as its tile is coloured by it.
 *
 * **A deck with neither is not colourless.** An empty deck, or one of nothing but lands, has said
 * nothing about its colours yet; filing it under Colorless would put a fact on the sheet that is
 * not true. It is counted apart ({@link DeckColorsView.uncoloured}) and named in the summary line.
 */
import type {
  DeckCommanderIdentity,
  DeckFolder,
  DeckPipCosts,
  DeckRow,
  HomeWidget,
} from "@/lib/ipc";
import { folderDescendants } from "@/lib/folderTree";
import { compareLabels } from "@/lib/options";
import type { PipCounts } from "@/lib/mana";
import { tileList } from "@/features/decks/deckCover";
import { deckPips, tilePips } from "@/features/decks/deckPips";
import { widgetConfig } from "./layout";
import { pickOf, toggleOnOf } from "./widgetSettings";

/** The five colours, in the order every Magic product prints them. */
export const WUBRG = ["W", "U", "B", "R", "G"] as const;
export type ColorLetter = (typeof WUBRG)[number];

/**
 * A combination's key: its letters in {@link WUBRG} order run together — `"WU"`, `"BRG"` — and
 * `""` for colourless. One spelling, so a commander answering `"UW"` and a pip count answering
 * U-then-W land in the same row.
 */
export type ComboKey = string;

/** One row of the sheet. */
export interface Combo {
  key: ComboKey;
  /** What Magic players call it — `Azorius`, `Mardu`, `Witch-Maw`. */
  name: string;
  /** How many colours: `0` for colourless. */
  size: number;
  /** Its place in the colour pie's own order — the order Wizards and every deckbuilding site list
   *  the guilds and the shards by. */
  pie: number;
}

/**
 * Every combination, in colour-pie order: the mono colours, colourless, the five allied pairs and
 * then the five enemy ones, the five shards and then the five wedges, the four-colour
 * combinations by the colour each one lacks, and all five.
 *
 * **Four colours are the Nephilim's names** — `Glint-Eye` lacks white, `Dune-Brood` blue,
 * `Ink-Treader` black, `Witch-Maw` red, `Yore-Tiller` green — which is what the community calls
 * them and what a reader's sheet abbreviates (`Glint`, `Yore`).
 */
export const COMBOS: readonly Combo[] = [
  ["W", "Mono White"],
  ["U", "Mono Blue"],
  ["B", "Mono Black"],
  ["R", "Mono Red"],
  ["G", "Mono Green"],
  ["", "Colorless"],
  ["WU", "Azorius"],
  ["UB", "Dimir"],
  ["BR", "Rakdos"],
  ["RG", "Gruul"],
  ["WG", "Selesnya"],
  ["WB", "Orzhov"],
  ["UR", "Izzet"],
  ["BG", "Golgari"],
  ["WR", "Boros"],
  ["UG", "Simic"],
  ["WUB", "Esper"],
  ["UBR", "Grixis"],
  ["BRG", "Jund"],
  ["WRG", "Naya"],
  ["WUG", "Bant"],
  ["WBG", "Abzan"],
  ["WUR", "Jeskai"],
  ["UBG", "Sultai"],
  ["WBR", "Mardu"],
  ["URG", "Temur"],
  ["UBRG", "Glint-Eye"],
  ["WBRG", "Dune-Brood"],
  ["WURG", "Ink-Treader"],
  ["WUBG", "Witch-Maw"],
  ["WUBR", "Yore-Tiller"],
  ["WUBRG", "WUBRG"],
].map(([key, name], pie) => ({ key, name, size: key.length, pie }));

const COMBO_BY_KEY: ReadonlyMap<ComboKey, Combo> = new Map(COMBOS.map((c) => [c.key, c]));

/** The combination a key names. Every canonical key has one — there are exactly 32. */
export function comboOf(key: ComboKey): Combo {
  const combo = COMBO_BY_KEY.get(key);
  if (combo === undefined) throw new Error(`Not a colour combination: "${key}"`);
  return combo;
}

/**
 * Any run of colour letters as a {@link ComboKey}: deduplicated, in WUBRG order, every other
 * character dropped. Case-insensitive, because nothing guarantees the case a corpus row arrives in.
 */
export function comboKey(letters: Iterable<string>): ComboKey {
  const seen = new Set<string>();
  for (const letter of letters) seen.add(letter.toUpperCase());
  return WUBRG.filter((c) => seen.has(c)).join("");
}

/** A combination's colours, one letter each. */
export function comboLetters(key: ComboKey): ColorLetter[] {
  return WUBRG.filter((c) => key.includes(c));
}

/** One section of the sheet: the combinations of one size, and what it is called. */
export interface ComboGroup {
  /** How many colours — `1` for the mono section, which also holds colourless (`0`). */
  size: number;
  label: string;
  combos: readonly Combo[];
}

/** The order the combinations inside a section are listed in — the widget's `sort` pick. */
export type ComboOrder = "alpha" | "pie";

const GROUP_LABEL: Record<number, string> = {
  1: "Mono",
  2: "Two colors",
  3: "Three colors",
  4: "Four colors",
  5: "Five colors",
};

/**
 * The sheet's sections, in order.
 *
 * **Colourless sits at the foot of the mono section**, where a reader's own sheet puts it: it is a
 * one-row answer to the same question the mono rows answer — *which single identity is this deck
 * built around* — and a section of its own holding one row would be a heading over a heading.
 *
 * `alpha` lists the pairs, triples and four-colour combinations by name; `pie` keeps
 * {@link COMBOS}' colour-pie order. The mono colours are WUBRG in both, because that order *is*
 * their name — nobody's sheet lists Black before White.
 */
export function comboGroups(order: ComboOrder): ComboGroup[] {
  return [1, 2, 3, 4, 5].map((size) => {
    const members = COMBOS.filter((c) => (size === 1 ? c.size <= 1 : c.size === size));
    const combos =
      order === "alpha" && size > 1
        ? [...members].sort((a, b) => compareLabels(a.name, b.name))
        : members;
    return { size, label: GROUP_LABEL[size], combos };
  });
}

/** The colours a pip count asks for — WUBRG only; `{C}` is a kind of mana, not a colour. */
function pipCombo(pips: PipCounts): ComboKey {
  return WUBRG.filter((c) => pips[c] > 0).join("");
}

/** Every deck's colours, from the two reads, before any deck is filed. */
export interface DeckColorSources {
  identities: ReadonlyMap<number, DeckCommanderIdentity>;
  /** `tilePips`' answer: each deck's pips from the list its tile is drawn from. */
  pips: ReadonlyMap<number, PipCounts>;
}

/**
 * The two reads folded into lookups — `deck_commander_identities` by deck, and `deck_pip_costs`
 * through the gallery's own `deckPips` and `tilePips`, so a deck's colours here are the colours
 * its tile is drawn in.
 */
export function colorSources(
  decks: readonly DeckRow[],
  identities: readonly DeckCommanderIdentity[],
  pipCosts: readonly DeckPipCosts[],
): DeckColorSources {
  return {
    identities: new Map(identities.map((row) => [row.deckId, row])),
    pips: tilePips(decks, deckPips(pipCosts, "live"), deckPips(pipCosts, "theory")),
  };
}

/**
 * The combination a deck is filed under, or `null` when it has said nothing about its colours yet.
 * See the module doc for the order of the two sources.
 */
export function deckCombo(deck: DeckRow, sources: DeckColorSources): ComboKey | null {
  const identity = sources.identities.get(deck.id);
  const commander = tileList(deck) === "theory" ? identity?.theoryIdentity : identity?.identity;
  if (commander !== undefined && commander !== null) return comboKey(commander);
  const pips = sources.pips.get(deck.id);
  return pips === undefined ? null : pipCombo(pips);
}

/** Which decks the widget counts — the registry's `scope` pick. */
export type DeckColorsScope = "all" | "chosen";

/**
 * The reader's folder whitelist.
 *
 * `folderIds` are deck folders; `unfiled` is the root of the tree, which has no id of its own and
 * so is a switch beside the list. `subfolders` is whether ticking a folder also counts every
 * folder under it — **on unless the reader turned it off**, because a whitelist of `Commander`
 * that silently skipped `Commander › Bracket 4` would be the surprise, and a reader who files old
 * decks in `Commander › Retired` can turn it off and tick the others.
 */
export interface FolderWhitelist {
  folderIds: number[];
  unfiled: boolean;
  subfolders: boolean;
}

/** The whitelist as stored, narrowed: an id that is not an integer answers to no folder. */
export function folderWhitelist(widget: HomeWidget): FolderWhitelist {
  const stored = widgetConfig(widget, {
    folderIds: [] as number[],
    unfiled: false,
    subfolders: true,
  });
  return {
    folderIds: stored.folderIds.filter((id) => Number.isInteger(id)),
    unfiled: stored.unfiled === true,
    subfolders: stored.subfolders !== false,
  };
}

/** The scope this widget counts. A stored word no option carries reads as `all`. */
export function colorsScope(widget: HomeWidget): DeckColorsScope {
  return pickOf(widget, "scope") === "chosen" ? "chosen" : "all";
}

/**
 * Which decks are on the sheet, before any is filed.
 *
 * Archived decks only when the reader asked for them (`archived`, off by default: a deck put away
 * is not one a reader is counting toward a colour). Under `chosen`, a deck counts when it is filed
 * in a ticked folder — or under one, while `subfolders` is on — or at the root while `unfiled` is
 * ticked. A ticked id naming a folder that has since been deleted matches nothing, and is not
 * written away: a write on render would be a page editing itself while being read.
 */
export function decksInScope(
  decks: readonly DeckRow[],
  folders: readonly DeckFolder[],
  widget: HomeWidget,
): DeckRow[] {
  const archived = toggleOnOf(widget, "archived");
  const live = decks.filter((deck) => archived || !deck.archived);
  if (colorsScope(widget) === "all") return live;
  const list = folderWhitelist(widget);
  const counted = new Set<number>(list.folderIds);
  if (list.subfolders) {
    for (const id of list.folderIds) {
      for (const under of folderDescendants(folders, id)) counted.add(under);
    }
  }
  return live.filter((deck) =>
    deck.folderId === null ? list.unfiled : counted.has(deck.folderId),
  );
}

/** The reader's arrangement: deck ids, earliest first. Only the order *within* a combination is
 *  ever read, so one list serves all 32 rows. */
export function deckOrder(widget: HomeWidget): number[] {
  return widgetConfig(widget, { deckOrder: [] as number[] }).deckOrder.filter((id) =>
    Number.isInteger(id),
  );
}

/**
 * A combination's decks in the order they are drawn: the reader's arrangement first, then every
 * deck they have not placed, by name — so a new deck joins the end of its row rather than
 * shuffling the ones a reader put in order.
 */
export function arranged(decks: readonly DeckRow[], order: readonly number[]): DeckRow[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...decks].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return compareLabels(a.name, b.name) || a.id - b.id;
  });
}

/**
 * The arrangement to store after a row is put in a new order.
 *
 * The row's ids are taken out wherever they stood and appended, in their new order: only the order
 * *within* a combination is ever read, so where a row's ids sit among another row's is nothing, and
 * every deck in the row is placed from now on — including the ones that were standing in the
 * by-name tail — so the row the reader just arranged is the row they get back. Ids naming no deck
 * any more are dropped on the way through, which is a write the reader asked for rather than one
 * made on render.
 */
export function rearranged(
  order: readonly number[],
  row: readonly number[],
  existing: ReadonlySet<number>,
): number[] {
  const inRow = new Set(row);
  return [...order.filter((id) => !inRow.has(id) && existing.has(id)), ...row];
}

/** One combination as the widget draws it. */
export interface ComboRow {
  combo: Combo;
  decks: DeckRow[];
}

/** One section, with how many of its combinations have a deck. */
export interface GroupView {
  group: ComboGroup;
  rows: ComboRow[];
  covered: number;
}

/** Everything the body draws. */
export interface DeckColorsView {
  groups: GroupView[];
  /** Combinations with at least one deck, of {@link COMBOS}' 32. */
  covered: number;
  /** Decks filed under a combination. */
  placed: number;
  /** Decks in scope that have said nothing about their colours yet. */
  uncoloured: DeckRow[];
}

/**
 * The whole sheet: every deck in scope filed under its combination, each row in the reader's
 * arrangement, each section in the chosen order — empty rows included, because an empty row is
 * the sheet's whole point: it is the combination the reader has no deck in yet.
 */
export function deckColorsView(
  decks: readonly DeckRow[],
  sources: DeckColorSources,
  order: readonly number[],
  comboOrder: ComboOrder,
): DeckColorsView {
  const byCombo = new Map<ComboKey, DeckRow[]>();
  const uncoloured: DeckRow[] = [];
  for (const deck of decks) {
    const key = deckCombo(deck, sources);
    if (key === null) {
      uncoloured.push(deck);
      continue;
    }
    const list = byCombo.get(key) ?? [];
    list.push(deck);
    byCombo.set(key, list);
  }
  let covered = 0;
  let placed = 0;
  const groups = comboGroups(comboOrder).map((group) => {
    const rows = group.combos.map((combo) => ({
      combo,
      decks: arranged(byCombo.get(combo.key) ?? [], order),
    }));
    const groupCovered = rows.filter((row) => row.decks.length > 0).length;
    covered += groupCovered;
    placed += rows.reduce((sum, row) => sum + row.decks.length, 0);
    return { group, rows, covered: groupCovered };
  });
  return { groups, covered, placed, uncoloured };
}
