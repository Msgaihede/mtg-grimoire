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

/**
 * **There is no exemption list any more, and its deletion is the point of having had one.**
 *
 * `NOT_YET_DRAWN` held exactly `["labels"]` for as long as that panel was unwritten: `nav.ts`
 * declared the id so the `Appearance` group could arrive on the rail whole — the mark colours and
 * the label list are one question, and a group that held half of it for a release would be a rail
 * entry that changed meaning under the reader. It was an **exact set** rather than a tolerance
 * precisely so that the day `LabelsPanel.tsx` landed, the literal disagreed with the sweep and had
 * to be removed. It landed, and it was. A tolerance that quietly widens is how a rail entry that
 * scrolls to nothing survives, which is the failure the sweep below exists to catch.
 */

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
const RAIL: GroupId[] = [
  "updates",
  "carddata",
  "sync",
  "tags",
  "appearance",
  "storage",
  "errors",
];

/** Which panels each rail entry holds, in the order the pane draws them, on a **web** build. */
const UNDER: Record<GroupId, PanelId[]> = {
  updates: ["updates"],
  carddata: ["prices"],
  sync: ["sync", "review"],
  tags: ["hidden-tags"],
  appearance: ["theory-marks", "labels"],
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

    // Both sides are subjects, and both are whole: the shipped tree on one, the closed union on
    // the other, with nothing exempted from either. See the note above for what used to be.
    const declared = Object.keys(PANELS) as PanelId[];
    expect([...ids].sort()).toEqual(declared.sort());
  });

  it("has seven entries, in declaration order", () => {
    expect(GROUP_ORDER).toEqual(RAIL);
    expect(GROUP_ORDER).toHaveLength(7);
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
      "sync",
      "review",
      "hidden-tags",
      "theory-marks",
      "labels",
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
      "sync",
      "review",
      "hidden-tags",
      "theory-marks",
      "labels",
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
    // Inside: "book" against "spellbook", which is the half a `startsWith` would lose. The
    // keyword was `Combos`' until that panel was deleted and its still-answerable words moved
    // to `Local cache`; the property this line guards has nothing to do with either panel, so
    // it follows the word rather than going with the panel.
    expect(matches("cache", "book")).toBe(true);
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
    expect(visiblePanels("carddata", "   ", true)).toEqual(["prices"]);
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

  /**
   * Appearance is a rail entry of its own and **not** a section of Tags. A *tag* in this app is
   * one of Scryfall's two tagger datasets; a *label* is the deckbuilder's coloured per-card mark.
   * Filing the label list under Tags would put the two words on one rail entry, which is the one
   * thing this repo's vocabulary rule forbids.
   */
  it("draws both appearance panels under their own group", () => {
    expect(visiblePanels("appearance", "", false)).toEqual(["theory-marks", "labels"]);
  });

  /**
   * The colours are reached by what a reader would type at them, which is a colour word and the
   * mark's own look rather than the word this repo files it under — nobody searching for a green
   * tick types "theory". Both spellings of *colour* are in the line for `matches`' own reason: a
   * reader types the word they have, and one of the two would answer nothing at all.
   */
  it("finds the colours by the words a reader would type", () => {
    for (const query of ["colour", "color", "green", "checkmark", "theory mark", "customize"]) {
      expect(visiblePanels("updates", query, false)).toContain("theory-marks");
    }
  });

  /**
   * **The separation this group exists for, seen from the reader's side.** `label` has to reach
   * the deckbuilder's coloured per-card mark and nothing under `Tags` — a search that answered
   * `Hidden tags` here would be the app's two vocabularies collapsing in the one place a reader
   * would actually notice, which is why the panel is not filed there.
   */
  it("finds the labels without finding the tag panels", () => {
    expect(visiblePanels("updates", "label", false)).toEqual(["labels"]);
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
