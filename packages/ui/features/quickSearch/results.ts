import { matches as settingMatches, PANELS, GROUPS, type PanelId } from "@/features/settings/nav";
import { queryToken } from "@/features/wishlist/wish";

/**
 * The header's quick search (issue #1098) — what it finds, and in which order, as pure functions
 * over rows the app already reads. `useQuickSearch` asks for the rows and `QuickSearch` draws the
 * answer; nothing here knows about either.
 *
 * **The groups are a fixed order, and the order is the issue's rule rather than a ranking**: a
 * card the reader owns or wishes for is never drawn under the same card found in the whole corpus,
 * so the corpus's group comes after both lists, whatever answered first and however well it
 * matched. Settings are last because they are the one group that is not about cards at all.
 */
export const GROUP_ORDER = ["decks", "collection", "wishlist", "cards", "settings"] as const;

export type QuickGroupId = (typeof GROUP_ORDER)[number];

export const GROUP_LABELS: Record<QuickGroupId, string> = {
  decks: "Decks",
  collection: "Collection",
  wishlist: "Wishlist",
  cards: "All cards",
  settings: "Settings",
};

/** Rows per group. Enough to pick from at a glance; a reader after the eleventh match is asking
 *  the page the group leads to, which every group's rows open. */
export const GROUP_LIMIT = 6;

/** What a press on a result does — every target is a store action `QuickSearch` maps one to one. */
export type QuickTarget =
  | { kind: "deck"; id: number }
  | { kind: "deckFolder"; id: number }
  | { kind: "folder"; scope: "collection" | "wishlist"; id: number }
  | { kind: "reveal"; scope: "collection" | "wishlist"; folderId: number | null; query: string }
  | { kind: "search"; text: string }
  | { kind: "setting"; panel: PanelId };

/** Which glyph a row wears — a fact about the thing found, not about where it opens. */
export type QuickItemKind = "deck" | "folder" | "card" | "searchAll" | "setting";

export interface QuickItem {
  /** Unique across every group — the option's DOM id and the active row are keyed on it. */
  key: string;
  kind: QuickItemKind;
  label: string;
  /** Dim text after the label — a folder's path, a printing and where it is filed. */
  detail?: string;
  target: QuickTarget;
}

export interface QuickGroup {
  id: QuickGroupId;
  label: string;
  items: QuickItem[];
}

/**
 * How well `name` answers `query`, or `null` for not at all — lower is better.
 *
 * `0` the whole name, `1` its start, `2` the start of one of its words, `3` anywhere. A query of
 * several words needs every word somewhere in the name (`bolt light` finds Lightning Bolt) and is
 * ranked by the first. Case and the curly apostrophe Scryfall's names carry are folded, so a
 * reader typing `urza's` finds `Urza’s Saga`.
 */
export function rankName(name: string, query: string): number | null {
  const hay = fold(name);
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return null;
  if (!words.every((w) => hay.includes(w))) return null;
  const whole = words.join(" ");
  if (hay === whole) return 0;
  if (hay.startsWith(whole)) return 1;
  if (hay.split(/[\s,/-]+/).some((part) => part.startsWith(words[0]))) return 2;
  return 3;
}

/**
 * Rows a backend search already chose, **name matches first** and the rest after in the order they
 * came. The collection's and the corpus's text search read type lines and rules text too, so
 * `bolt` answers a card that merely mentions one; those stay, under the cards that are called it.
 */
function nameFirst<T>(rows: readonly T[], query: string, nameOf: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i, rank: rankName(nameOf(row), query) ?? 9 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.row);
}

function fold(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").trim();
}

/** Keeps the rows that match, best first, ties in the order they came — which is each source's
 *  own order (a deck list arrives most recently touched first). */
function ranked<T>(rows: readonly T[], query: string, nameOf: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i, rank: rankName(nameOf(row), query) }))
    .filter((x): x is { row: T; i: number; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.row);
}

/** The fields of a folder this module reads — the three cabinets' rows all carry them. */
export interface FolderLike {
  id: number;
  parentId: number | null;
  name: string;
}

/** A folder's names from its cabinet's root, `›`-joined — `Binders › Trade`. A parent missing from
 *  the list (or a loop) ends the walk rather than throwing. */
export function folderPath(folders: readonly FolderLike[], id: number): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  const seen = new Set<number>();
  let at = byId.get(id);
  while (at !== undefined && !seen.has(at.id)) {
    seen.add(at.id);
    names.unshift(at.name);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return names.join(" › ");
}

/** The fields of a deck this module reads (`DeckRow`'s). */
export interface DeckLike {
  id: number;
  name: string;
  formatName: string | null;
  archived: boolean;
  folderId: number | null;
}

/**
 * The Decks group: decks, then deck folders.
 *
 * **With nothing typed it is the recent decks** — the list arrives most recently touched first,
 * which is the one recency the app keeps for a deck — and archived ones are left out, because a
 * deck put away is not one the reader is coming back to. Typed, an archived deck is found like
 * any other and says so.
 */
export function deckItems(
  decks: readonly DeckLike[],
  folders: readonly FolderLike[],
  query: string,
  limit = GROUP_LIMIT,
): QuickItem[] {
  const deckItem = (deck: DeckLike): QuickItem => ({
    key: `deck:${String(deck.id)}`,
    kind: "deck",
    label: deck.name,
    detail: [
      deck.formatName,
      deck.folderId === null ? null : folderPath(folders, deck.folderId),
      deck.archived ? "Archived" : null,
    ]
      .filter((part) => part !== null && part !== "")
      .join(" · "),
    target: { kind: "deck", id: deck.id },
  });
  if (query.trim() === "") {
    return decks
      .filter((d) => !d.archived)
      .slice(0, limit)
      .map(deckItem);
  }
  const found = ranked(decks, query, (d) => d.name).map(deckItem);
  const drawers = folderItems(folders, query, (f) => ({
    key: `deckFolder:${String(f.id)}`,
    target: { kind: "deckFolder", id: f.id },
  }));
  return [...found, ...drawers].slice(0, limit);
}

/**
 * Folder rows for one cabinet, matched on their own names and drawn with the path they sit at —
 * which is also what makes a managed wishlist's `Tokens` child readable: `Folder in Burn`.
 */
export function folderItems<F extends FolderLike>(
  folders: readonly F[],
  query: string,
  address: (folder: F) => Pick<QuickItem, "key" | "target">,
): QuickItem[] {
  if (query.trim() === "") return [];
  return ranked(folders, query, (f) => f.name).map((folder) => {
    const parent = folder.parentId === null ? "" : folderPath(folders, folder.parentId);
    return {
      ...address(folder),
      kind: "folder",
      label: folder.name,
      detail: parent === "" ? "Folder" : `Folder in ${parent}`,
    };
  });
}

/** One copy record, as the collection and the wishlist both answer them (their rows' shared
 *  fields, with the nullable ones each list has). */
export interface CardRowLike {
  cardId: string | null;
  name: string | null;
  folderId: number | null;
  setCode: string | null;
  collectorNumber: string | null;
  lang?: string | null;
  quantity: number;
}

/**
 * The query a list's box reveals one printing with — `!name e:set cn:N lang:x`, the box's own
 * syntax and `collectionQueryOf`'s, so the reader lands on a filter they can read. A row with no
 * printing (an any-printing wish) is its name alone.
 */
export function printingQuery(row: CardRowLike): string {
  const card = `!${queryToken(row.name ?? "")}`;
  if (row.setCode === null || row.collectorNumber === null) return card;
  return [
    card,
    `e:${queryToken(row.setCode)}`,
    `cn:${queryToken(row.collectorNumber)}`,
    ...(row.lang ? [`lang:${queryToken(row.lang)}`] : []),
  ].join(" ");
}

/**
 * A list's card rows, **one per printing per folder**: a list answers one row per copy record, so
 * a card held foil and non-foil in one binder is two rows there and one place to be revealed
 * here, its quantities summed. Each row reveals its card in the folder it is filed in.
 */
export function cardItems(
  scope: "collection" | "wishlist",
  rows: readonly CardRowLike[],
  query: string,
  folderName: (folderId: number | null) => string,
  limit = GROUP_LIMIT,
): QuickItem[] {
  const merged = new Map<string, { row: CardRowLike; quantity: number }>();
  for (const row of nameFirst(rows, query, (r) => r.name ?? "")) {
    const key = `${row.cardId ?? `name:${row.name ?? ""}`}@${String(row.folderId)}`;
    const seen = merged.get(key);
    if (seen) seen.quantity += row.quantity;
    else merged.set(key, { row, quantity: row.quantity });
  }
  return [...merged.entries()].slice(0, limit).map(([key, { row, quantity }]) => ({
    key: `${scope}:${key}`,
    kind: "card",
    label: row.name ?? "Unknown card",
    detail: [
      row.setCode === null
        ? "Any printing"
        : `${row.setCode.toUpperCase()}${row.collectorNumber === null ? "" : ` #${row.collectorNumber}`}`,
      folderName(row.folderId),
      `×${String(quantity)}`,
    ].join(" · "),
    target: { kind: "reveal", scope, folderId: row.folderId, query: printingQuery(row) },
  }));
}

/** The fields of a corpus card this module reads (`CardSummary`'s, and `RecentCard`'s). */
export interface CorpusCardLike {
  cardId: string;
  name: string;
  setCode: string;
}

/**
 * The All cards group: with text typed, a first row that runs the whole search on the Search page,
 * then the corpus's own matches, each opening the Search page on that card's exact name. With
 * nothing typed, the cards the reader opened last.
 */
export function corpusItems(
  cards: readonly CorpusCardLike[],
  query: string,
  limit = GROUP_LIMIT,
): QuickItem[] {
  const text = query.trim();
  const rows = nameFirst(cards, text, (card) => card.name)
    .slice(0, limit)
    .map((card): QuickItem => ({
      key: `card:${card.cardId}`,
      kind: "card",
      label: card.name,
      detail: card.setCode.toUpperCase(),
      target: { kind: "search", text: `!${queryToken(card.name)}` },
    }));
  if (text === "") return rows;
  return [
    {
      key: "searchAll",
      kind: "searchAll",
      label: `Search all cards for “${text}”`,
      target: { kind: "search", text },
    },
    ...rows,
  ];
}

/** The Settings group — the Settings page's own search (`matches`) over the panels this edition
 *  draws, so a word that finds a panel there finds it here. Nothing with nothing typed. */
export function settingItems(panels: readonly PanelId[], query: string): QuickItem[] {
  if (query.trim() === "") return [];
  return panels
    .filter((id) => settingMatches(id, query))
    .map((id) => ({
      key: `setting:${id}`,
      kind: "setting",
      label: PANELS[id].title,
      detail: GROUPS[PANELS[id].group].label,
      target: { kind: "setting", panel: id },
    }));
}

/** The groups in {@link GROUP_ORDER}, empty ones dropped. */
export function groupsOf(sections: Partial<Record<QuickGroupId, QuickItem[]>>): QuickGroup[] {
  return GROUP_ORDER.flatMap((id) => {
    const items = sections[id] ?? [];
    return items.length === 0 ? [] : [{ id, label: GROUP_LABELS[id], items }];
  });
}
