/**
 * What Settings is made of, and how a reader finds one part of it.
 *
 * The page was one scroll of twelve panels until 2026-09-03 — ordered by what a press costs,
 * which is a real rule and still the rule *inside* a group, but an ordering only helps somebody
 * who already knows what they are scrolling towards. This module is the other half: six groups
 * a reader picks from, and a keyword per panel so that typing the word they actually have in
 * mind ("dropbox", "tcgplayer", "patreon") lands on the panel that answers it.
 *
 * **Pure, and separate from both components that draw it**, because the two things worth
 * getting wrong here are decidable without a DOM: which panels a group holds, and which panels
 * a query matches. `SettingsNav` draws the rail and `SettingsPage` draws the pane; neither
 * decides anything this file has an answer for.
 */

/**
 * Every panel Settings can draw, as a closed union.
 *
 * **Closed on purpose, and it is the only fence available on this side.** {@link PANELS} is a
 * total `Record` over it, so a twelfth panel that reaches the page without a title, a group and
 * a keyword line is a compile error rather than a section that silently belongs to no group and
 * can be found by nothing. `ReviewPanel`'s `TABLE_LABEL` is the same shape for the same reason.
 *
 * The ids are the panels' own `SettingsSection` stems, character for character, so the heading
 * id in the shipped window and the entry here cannot come apart.
 */
export type PanelId =
  | "updates"
  | "prices"
  | "combos"
  | "sync"
  | "review"
  | "hidden-tags"
  | "data-folder"
  | "backup"
  | "cache"
  | "web-storage"
  | "errors"
  | "danger";

/** The six entries in the rail. */
export type GroupId = "updates" | "carddata" | "sync" | "tags" | "storage" | "errors";

/** What the rail's badge counts, where a group has one. */
export type BadgeId = "review" | "errors";

type PanelMeta = {
  /** The panel's own heading, repeated here only so search can match it. */
  readonly title: string;
  /** The rail entry this panel is drawn under. */
  readonly group: GroupId;
  /**
   * The words a reader would type to look for this panel, beyond its own title.
   *
   * Names of things on the panel — marketplaces, services, file formats — and the words for
   * what it does, never component names. `matches` folds these together with the title and the
   * group's label, so none of those three needs repeating here.
   */
  readonly keywords: string;
  /** Drawn only on the web build, where `WebStoragePanel` has something to say. */
  readonly webOnly?: true;
};

/**
 * Every panel, with the group it belongs to and what it can be found by.
 *
 * **Declaration order is drawing order within a group** — `Object.keys` on string keys answers
 * insertion order — so this one literal carries both facts and they cannot drift apart. The
 * order inside `storage` is the page's old top-to-bottom order unchanged, which is the "ordered
 * by what a press costs" rule surviving the regrouping: the folder names itself, the backup
 * writes files, the cache throws away bytes the app fetches again, and the three clears are
 * last.
 */
export const PANELS: Record<PanelId, PanelMeta> = {
  updates: {
    title: "Updates",
    group: "updates",
    keywords: "version release notes changelog check download install about restart",
  },
  prices: {
    title: "Prices",
    group: "carddata",
    keywords:
      "marketplace currency money value tcgplayer cardmarket card kingdom mana pool " +
      "cardtrader usd eur feed pricelist",
  },
  combos: {
    title: "Combos",
    group: "carddata",
    keywords: "spellbook commander bracket infinite interaction two-card download refresh",
  },
  sync: {
    title: "Sync",
    group: "sync",
    keywords:
      "devices pair pairing code six digits qr scan membership patreon supporter relay " +
      "group leave rename phone",
  },
  review: {
    title: "Needs review",
    group: "sync",
    keywords: "conflict conflicts resolved kept folder loop looks fine queue",
  },
  "hidden-tags": {
    title: "Hidden tags",
    group: "tags",
    keywords: "show again unhide scryfall tagger oracle illustration art mute",
  },
  "data-folder": {
    title: "Data folder",
    group: "storage",
    keywords: "path where database images appdata directory disk location",
  },
  backup: {
    title: "Backup",
    group: "storage",
    keywords: "mirror text files export archive zip rebuild dropbox onedrive copy",
  },
  cache: {
    title: "Local cache",
    group: "storage",
    keywords: "clear images downloads space disk temporary",
  },
  "web-storage": {
    title: "This browser",
    group: "storage",
    keywords: "opfs quota persistent storage site data eviction",
    webOnly: true,
  },
  errors: {
    title: "Errors",
    group: "errors",
    keywords: "log faults failed rate limited timeout refused problems clear",
  },
  danger: {
    title: "Clear data",
    group: "storage",
    keywords: "delete empty reset collection wishlist decks danger wipe start over",
  },
};

type GroupMeta = {
  /** What the rail calls it. */
  readonly label: string;
  /** Which count, if any, rides on this entry. */
  readonly badge?: BadgeId;
};

/**
 * The rail, top to bottom.
 *
 * **Six entries and not twelve**, which is the whole point: a list as long as the page it
 * indexes is a second scroll rather than a way through the first. Where two panels answer one
 * question they share an entry — `Prices` and `Combos` are both optional bulk feeds of card
 * facts, and `Needs review` is what sync asks of a reader — and where a panel is the only
 * answer to its own question it gets an entry to itself.
 *
 * **`Clear data` has no entry of its own and sits at the foot of `Storage and data`.** The
 * three clears empty the part of the app the data folder holds, so that is the question they
 * answer; and `DangerZonePanel`'s distance is kept *inside* the pane, where it has always been,
 * rather than turned into a rail entry that would put "delete my collection" one press from
 * every visit to Settings.
 */
export const GROUPS: Record<GroupId, GroupMeta> = {
  updates: { label: "Updates" },
  carddata: { label: "Card data" },
  sync: { label: "Sync", badge: "review" },
  tags: { label: "Tags" },
  storage: { label: "Storage and data" },
  errors: { label: "Errors", badge: "errors" },
};

/** The rail's order, which is this file's declaration order and has no second home. */
export const GROUP_ORDER = Object.keys(GROUPS) as GroupId[];

/** Every panel, in drawing order. */
const PANEL_ORDER = Object.keys(PANELS) as PanelId[];

/**
 * The panels this build can draw.
 *
 * `isWeb` is passed in rather than read here so that this module stays a pure function of its
 * arguments and both answers are testable in one process. `SettingsPage` hands it
 * `isWebTarget()`, which is a build-time constant, so on desktop the browser panel is not
 * merely filtered out of the rail — nothing under it is ever constructed.
 */
export function panelsOn(isWeb: boolean): PanelId[] {
  return PANEL_ORDER.filter((id) => isWeb || PANELS[id].webOnly !== true);
}

/**
 * Everything a query is matched against for one panel: its group's label, its own title, and
 * its keywords, lowercased and joined.
 *
 * Built here rather than written into {@link PANELS} so that renaming a group or a panel moves
 * what it can be found by with it — a keyword line that had to repeat the title would be the
 * kind of prose that rots without any build noticing.
 */
function haystack(id: PanelId): string {
  const panel = PANELS[id];
  return `${GROUPS[panel.group].label} ${panel.title} ${panel.keywords}`.toLowerCase();
}

/**
 * Whether a panel answers a query.
 *
 * **Every word of the query must appear somewhere, in any order**, rather than the whole query
 * appearing as one run of characters. That is the difference between "kingdom card" finding
 * Prices and finding nothing, and it costs one `split`. Each word matches as a prefix of any
 * word in the haystack *or* anywhere inside it, so "price" finds "prices" and "pool" finds
 * "mana pool".
 *
 * An empty or whitespace-only query is not a search at all and this is never asked about it —
 * {@link searching} is the question to ask first.
 */
export function matches(id: PanelId, query: string): boolean {
  const hay = haystack(id);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => hay.includes(word));
}

/** Whether there is a query at all. A box holding only spaces is an empty box. */
export function searching(query: string): boolean {
  return query.trim() !== "";
}

/**
 * The panels to draw: everything this build has, narrowed either by the query or by the group.
 *
 * **A query outranks the group**, and that is the one rule worth stating out loud. A reader who
 * types "dropbox" while standing on `Updates` is asking the page a question, not asking the
 * `Updates` group a question, so the answer is drawn wherever it lives and the rail shows no
 * entry as current for as long as the box has words in it. Picking a group is what clears the
 * query — see `SettingsNav` — so the two states never both apply.
 */
export function visiblePanels(group: GroupId, query: string, isWeb: boolean): PanelId[] {
  const available = panelsOn(isWeb);
  if (searching(query)) return available.filter((id) => matches(id, query));
  return available.filter((id) => PANELS[id].group === group);
}
