import { describe, expect, it } from "vitest";
import {
  GROUP_ORDER,
  GROUPS,
  matches,
  PANELS,
  panelsOn,
  searching,
  visiblePanels,
  type GroupId,
  type PanelId,
} from "./nav";

/**
 * Every source file in the app, as text. The same `?raw` glob `src/lib/layers.test.ts` sweeps
 * z-index utilities with, and for its reason: this project has no `@types/node` and cannot reach
 * `node:fs`, so Vite is the only thing here that can read a file off disk.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * One `<SettingsSection …>` opening tag, whole.
 *
 * `[^>]` matches a newline, so a tag broken over four lines is one match; `(?=[\s/>])` is what
 * keeps a hypothetical `<SettingsSectionHeader>` out, and the leading `<` is what keeps
 * `</SettingsSection>` out. The `id` is pulled off the matched tag afterwards rather than in this
 * pattern, so a tag that carries no literal `id` is *found and reported* instead of silently
 * skipped — see the `dynamic` list below.
 */
const OPENING_TAG = /<SettingsSection(?=[\s/>])[^>]*>/g;

/** The stem, off a matched opening tag. */
const ID_ATTR = /\bid="([^"]+)"/;

/**
 * The same source with its comments taken out, which is what makes the sweep robust against a
 * false hit.
 *
 * This repo keeps its *reasoning* in prose, and the prose quotes markup freely — `panelChrome.tsx`
 * writes `<h2 id="updates-heading">` in a doc comment, and `nav.ts` names `SettingsSection` in
 * one. A comment that quoted a whole `<SettingsSection id="…">` would otherwise read as a
 * thirteenth panel that nothing draws. Block comments first (which is where every JSDoc and every
 * `{/* … *\/}` in a panel lives), then line comments — the `[^:]` guard is so a `mtgimg://` in a
 * sentence does not swallow the rest of its line.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `SettingsSection` stem the shipped tree actually draws, and the tags that carry none. */
function sweep(): { ids: Set<string>; dynamic: string[] } {
  const ids = new Set<string>();
  const dynamic: string[] = [];

  for (const [path, source] of Object.entries(SOURCES)) {
    // A test names an id to assert on it and a story draws a panel to look at it; neither is the
    // shipped tree, and a demo section in either would read here as a panel `nav.ts` had missed.
    if (path.includes(".test.") || path.includes(".stories.")) continue;

    for (const tag of withoutComments(source).match(OPENING_TAG) ?? []) {
      const id = ID_ATTR.exec(tag)?.[1];
      if (id === undefined) dynamic.push(`${path}: ${tag}`);
      // A Set, because one panel may draw its heading at more than one site: `BackupPanel` has
      // two `id="backup"` returns, the folder variant and the archive variant, and they are one
      // panel rather than two.
      else ids.add(id);
    }
  }

  return { ids, dynamic };
}

/**
 * The rail, written out rather than read back off `GROUPS`.
 *
 * An expectation computed from the thing it is checking passes against any defect, which is a
 * mistake this repo has made and paid for. Everything below that names an order or a membership
 * is a literal for that reason.
 */
const RAIL: GroupId[] = ["updates", "carddata", "sync", "tags", "storage", "errors"];

/** Which panels each rail entry holds, in the order the pane draws them, on a **web** build. */
const UNDER: Record<GroupId, PanelId[]> = {
  updates: ["updates"],
  carddata: ["prices", "combos"],
  sync: ["sync", "review"],
  tags: ["hidden-tags"],
  storage: ["data-folder", "backup", "cache", "web-storage", "danger"],
  errors: ["errors"],
};

describe("the settings rail", () => {
  /**
   * **The claim nothing else in the build can check.** `nav.ts` says its ids are the panels' own
   * `SettingsSection` stems "character for character" — but the stem is a `string` prop, so a
   * `PanelId` that no heading answers to type-checks perfectly and costs the reader a rail entry
   * that scrolls to nothing. The two sides are only ever compared here.
   */
  it("names an id for every SettingsSection the tree draws, and none it does not", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing agrees with everything.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const { ids, dynamic } = sweep();

    // A tag whose id is an expression is invisible to a text sweep, so the sweep would quietly
    // under-report rather than go red. Fail on it by name instead.
    expect(dynamic).toEqual([]);

    // Both sides are subjects: the shipped tree on one, the closed union on the other.
    expect([...ids].sort()).toEqual(Object.keys(PANELS).sort());
  });

  it("has six entries, in declaration order", () => {
    expect(GROUP_ORDER).toEqual(RAIL);
    expect(GROUP_ORDER).toHaveLength(6);
    // `GROUP_ORDER` is derived from `GROUPS`, so this is what would catch the two coming apart —
    // an entry with a label and no place in the rail, or the reverse.
    expect(Object.keys(GROUPS)).toEqual(RAIL);
  });

  it("files every panel under an entry, and leaves no entry empty", () => {
    const under: Partial<Record<GroupId, PanelId[]>> = {};
    for (const id of panelsOn(true)) {
      (under[PANELS[id].group] ??= []).push(id);
    }

    expect(under).toEqual(UNDER);

    // An entry drawn over nothing is a rail row that answers a press with an empty pane.
    expect(RAIL.filter((group) => (under[group] ?? []).length === 0)).toEqual([]);
  });
});

describe("panelsOn", () => {
  it("leaves the browser panel out of a desktop build, in declaration order", () => {
    expect(panelsOn(false)).toEqual([
      "updates",
      "prices",
      "combos",
      "sync",
      "review",
      "hidden-tags",
      "data-folder",
      "backup",
      "cache",
      "errors",
      "danger",
    ]);
  });

  it("puts it back on a web build, in the same order", () => {
    expect(panelsOn(true)).toEqual([
      "updates",
      "prices",
      "combos",
      "sync",
      "review",
      "hidden-tags",
      "data-folder",
      "backup",
      "cache",
      "web-storage",
      "errors",
      "danger",
    ]);
  });
});

describe("matches", () => {
  /**
   * The rule the module is explicit about: every word of the query has to appear *somewhere*,
   * rather than the whole query appearing as one run of characters. `Prices`' keyword line reads
   * "…card kingdom mana pool…", so the substring "kingdom card" is nowhere in it and a
   * whole-query match would answer nothing to a reader who typed the marketplace's name the way
   * round they think of it.
   */
  it("takes the query's words in any order", () => {
    expect(matches("prices", "kingdom card")).toBe(true);
    expect(matches("prices", "card kingdom")).toBe(true);
  });

  it("wants every word, not any word", () => {
    // "dropbox" is Backup's and nothing else's, so one word of this pair lands and one does not.
    expect(matches("prices", "kingdom dropbox")).toBe(false);
  });

  it("matches a word as a prefix of one, and inside one", () => {
    // A prefix: "market" against "marketplace".
    expect(matches("prices", "market")).toBe(true);
    // Inside: "book" against "spellbook", which is the half a `startsWith` would lose.
    expect(matches("combos", "book")).toBe(true);
  });

  /**
   * The group's label is folded into the haystack rather than repeated into each panel's keyword
   * line, so this is what says the fold happened: `Backup`'s own title and keywords contain no
   * "storage" — the word can only have come from `Storage and data`.
   */
  it("finds a panel by a word in its group's label", () => {
    // A premise rather than the expectation: if the word were in the panel's own line, the
    // assertion under it would pass without the label ever being read.
    expect(`${PANELS.backup.title} ${PANELS.backup.keywords}`.toLowerCase()).not.toContain(
      "storage",
    );
    expect(matches("backup", "storage")).toBe(true);
  });

  it("finds a panel by a word in its title", () => {
    expect(matches("review", "needs review")).toBe(true);
  });

  it("finds nothing for a word that is nowhere", () => {
    expect(panelsOn(true).filter((id) => matches(id, "kubernetes"))).toEqual([]);
  });
});

describe("searching", () => {
  it("does not count an empty box, or one holding only spaces", () => {
    expect(searching("")).toBe(false);
    expect(searching("   ")).toBe(false);
    expect(searching(" \t\n ")).toBe(false);
  });

  it("counts a box with a word in it, however it is padded", () => {
    expect(searching("a")).toBe(true);
    expect(searching("  sync  ")).toBe(true);
  });
});

describe("visiblePanels", () => {
  it("draws exactly the group's panels when there is no query", () => {
    for (const group of RAIL) {
      expect(visiblePanels(group, "", true)).toEqual(UNDER[group]);
    }
  });

  it("still draws the group's panels when the box holds only spaces", () => {
    expect(visiblePanels("carddata", "   ", true)).toEqual(["prices", "combos"]);
  });

  /**
   * **A query outranks the group.** A reader standing on `Updates` who types "dropbox" is asking
   * the page a question, not asking `Updates` a question — so the answer is drawn wherever it
   * lives, and the panels of the group they happen to be standing on are no longer privileged.
   */
  it("answers past the selected group when there is a query", () => {
    // Standing on `Updates`, which holds no panel that matches: the answer comes from `storage`.
    expect(visiblePanels("updates", "dropbox", false)).toEqual(["backup"]);
    // Standing on `storage`, whose other four panels do not match and are therefore gone.
    expect(visiblePanels("storage", "dropbox", false)).toEqual(["backup"]);
  });

  it("keeps the search's answers in declaration order, across groups", () => {
    // "clear" is in `Local cache`'s line, in `Errors`', and in `Clear data`'s — three panels from
    // two groups, and `errors` comes between `cache` and `danger` in the page's own order.
    expect(visiblePanels("updates", "clear", false)).toEqual(["cache", "errors", "danger"]);
  });

  it("answers nothing rather than falling back to the group", () => {
    expect(visiblePanels("storage", "kubernetes", false)).toEqual([]);
  });

  it("gates the browser panel on the build, with a query and without one", () => {
    expect(visiblePanels("storage", "", false)).toEqual([
      "data-folder",
      "backup",
      "cache",
      "danger",
    ]);
    expect(visiblePanels("storage", "", true)).toEqual([
      "data-folder",
      "backup",
      "cache",
      "web-storage",
      "danger",
    ]);

    // "opfs" is the browser panel's word and nothing else's, so the desktop answer is empty
    // rather than merely shorter.
    expect(visiblePanels("storage", "opfs", false)).toEqual([]);
    expect(visiblePanels("storage", "opfs", true)).toEqual(["web-storage"]);
  });
});
