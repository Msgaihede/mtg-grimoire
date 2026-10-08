import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { FormatSpec } from "@/lib/ipc";

const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { formatSpecs },
}));

import { ANY_GAME, gameLabel, pickerFormats, useFormatSpecs } from "./useFormatSpecs";

/** One row of the seed, cell for cell — `commander` as `schema.rs` actually writes it. */
const COMMANDER: FormatSpec = {
  games: ["paper"],
  key: "commander",
  displayName: "Commander",
  enabledInPicker: true,
  deckMin: 100,
  deckMax: 100,
  maxCopies: 1,
  sideboardMax: 0,
  singleton: true,
  requiresCommander: true,
  commanderRule: "edh",
  life: 40,
  restrictedSemantic: "max_one",
  hasLegalityData: true,
  maxManaValue: null,
  allowsCompanion: true,
  sortOrder: 12,
};

/** The pseudo-format with no legality data — `hasLegalityData: false` is a real cell. */
const CASUAL: FormatSpec = {
  ...COMMANDER,
  key: "casual",
  displayName: "Casual",
  deckMin: 0,
  deckMax: null,
  maxCopies: null,
  sideboardMax: null,
  singleton: false,
  requiresCommander: false,
  commanderRule: null,
  life: 20,
  hasLegalityData: false,
  games: ["paper", "arena", "mtgo"],
  sortOrder: 24,
};

/** An Arena-only format, and the one `games` cell that excludes Paper. */
const HISTORIC: FormatSpec = {
  ...COMMANDER,
  key: "historic",
  displayName: "Historic",
  deckMin: 60,
  deckMax: null,
  maxCopies: 4,
  sideboardMax: 15,
  singleton: false,
  requiresCommander: false,
  commanderRule: null,
  life: 20,
  games: ["arena"],
  sortOrder: 3,
};

/** Two platforms rather than one or three — the shape a `includes` bug reads as either. */
const MODERN: FormatSpec = {
  ...HISTORIC,
  key: "modern",
  displayName: "Modern",
  games: ["paper", "mtgo"],
  sortOrder: 7,
};

/** The row no picker offers, whatever the game — `enabledInPicker: false`. */
const FUTURE: FormatSpec = {
  ...MODERN,
  key: "future",
  displayName: "Future Standard",
  enabledInPicker: false,
  games: ["paper", "arena", "mtgo"],
  sortOrder: 2,
};

const ALL = [COMMANDER, CASUAL, HISTORIC, MODERN, FUTURE];

/** One client for the whole test, so a remount asks the *cache* rather than the mock. */
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  formatSpecs.mockReset().mockResolvedValue([COMMANDER, CASUAL]);
});

describe("useFormatSpecs", () => {
  /**
   * The rules are data (spec §6) and the data is seeded by a migration, so this table can
   * change exactly once per app version — never while the app is running, and never because
   * of a sync. `staleTime: Infinity` is that sentence, and this is what proves it: a second
   * mount under the same cache asks nobody.
   *
   * Unlike `["sets"]`, which needs a *function* staleTime because its first launch can
   * answer `[]` while the opening sync is still writing the table. `format_specs` is written
   * by `migrate()` before a command can be served, so an empty answer is not reachable.
   */
  it("reads the format table once and holds it for the session", async () => {
    const first = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(first.result.current.specs).toHaveLength(2));
    expect(client.getQueryData(["formatSpecs"])).toEqual([COMMANDER, CASUAL]);
    first.unmount();

    const second = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(second.result.current.specs).toHaveLength(2));

    expect(formatSpecs).toHaveBeenCalledTimes(1);
  });

  /**
   * Every deck carries a `formatKey` and nothing else; the rules it is judged by are this
   * lookup. `null` for a key the table does not carry rather than a thrown error or a
   * casual-shaped stand-in: a deck whose format left the seed is a deck that must still
   * open, and the caller decides what to say about it.
   */
  it("finds a spec by key, and answers null for one the table does not carry", async () => {
    const { result } = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(result.current.specs).toHaveLength(2));

    expect(result.current.formatSpecFor("casual")).toEqual(CASUAL);
    expect(result.current.formatSpecFor("pauperoathbreaker")).toBeNull();
  });

  /** Before the table has answered there is no spec for anything — and asking is not an
   *  error, because every consumer of this hook renders through its own loading pass. */
  it("answers null while the table is still loading", () => {
    const { result } = renderHook(() => useFormatSpecs(), { wrapper });

    expect(result.current.specs).toEqual([]);
    expect(result.current.formatSpecFor("commander")).toBeNull();
  });
});

describe("pickerFormats", () => {
  const keys = (game?: Parameters<typeof pickerFormats>[2]) =>
    pickerFormats(ALL, null, game).map((f) => f.key);

  /** No game is every offerable format, which is what makes the argument's default a no-op
   *  and is why no caller that has not thought about games had to change. */
  it("offers every enabled format when no game is named", () => {
    expect(keys()).toEqual(keys(ANY_GAME));
    expect(keys()).toEqual(["casual", "commander", "historic", "modern"]);
  });

  /**
   * The narrowing, read off the seed's `games` cell.
   *
   * Both directions are asserted on purpose: Arena keeps Historic **and drops Modern**, Paper
   * does the reverse. A filter that answered "everything" would pass the first half of each.
   */
  it("narrows the list to the formats that platform plays", () => {
    expect(keys("arena")).toEqual(["casual", "historic"]);
    expect(keys("paper")).toEqual(["casual", "commander", "modern"]);
    expect(keys("mtgo")).toEqual(["casual", "modern"]);
  });

  /** `enabledInPicker` outranks the game: Future Standard is a format you can test a card
   *  against and cannot build for, on every platform it is legal in. */
  it("still refuses a format no picker offers, whatever the game", () => {
    expect(keys("paper")).not.toContain("future");
    expect(keys()).not.toContain("future");
  });

  /**
   * **The whole of "setting a game never re-formats a deck", on this side.**
   *
   * A Modern deck switched to Arena is the ordinary way a deck's own format falls out of the
   * list — the older way, a format that left the seed, is the same code path. Without `keep`
   * the select would show its first row while still reporting `modern`, and the deck would be
   * silently re-formatted by the reader's next unrelated change.
   */
  it("folds the deck's own format back in when the game would drop it", () => {
    const kept = pickerFormats(ALL, { key: "modern", name: "Modern" }, "arena");

    expect(kept.map((f) => f.key)).toContain("modern");
    // Alphabetically among the rest rather than pinned in front: it is an option like any
    // other, and the `<select>`'s own `value` already marks it as the current one.
    expect(kept.map((f) => f.key)).toEqual(["casual", "historic", "modern"]);
  });

  /** A format the narrowed list already carries is not added twice. */
  it("adds no duplicate row when the kept format survives the filter", () => {
    const kept = pickerFormats(ALL, { key: "historic", name: "Historic" }, "arena");

    expect(kept.filter((f) => f.key === "historic")).toHaveLength(1);
  });

  /** A spec naming no platform is offered under `Any` and under nothing else. Rust guarantees
   *  the cell is never empty; this pins what the filter does if that guarantee ever slips —
   *  fail closed, so the wrong answer is a missing row rather than an illegal deck. */
  it("offers a format with no platforms only when no game is named", () => {
    const orphan: FormatSpec = { ...MODERN, key: "orphan", displayName: "Orphan", games: [] };

    expect(pickerFormats([orphan], null).map((f) => f.key)).toEqual(["orphan"]);
    expect(pickerFormats([orphan], null, "paper")).toEqual([]);
  });
});

describe("gameLabel", () => {
  it("words each key, and falls back to a key it has never heard of", () => {
    expect(gameLabel("any")).toBe("Any");
    expect(gameLabel("mtgo")).toBe("MTGO");
    // `decks.game_key` carries no CHECK — `ALTER TABLE … ADD COLUMN` cannot add one — so this
    // state can exist, and showing it is how anybody would find out. Calling it "Any" would
    // hide the one thing worth seeing.
    expect(gameLabel("gameboy")).toBe("gameboy");
  });
});
