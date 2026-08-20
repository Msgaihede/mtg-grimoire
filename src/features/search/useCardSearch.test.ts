import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacetResponse, SearchRequest, SearchSortKey } from "@/lib/ipc";

const searchCards = vi.hoisted(() => vi.fn());
const facetCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards, facetCards },
}));

import { COLD_POLL_MS } from "./useCardFacets";
import {
  activeFilterCount,
  ANY_CARD,
  cycleTriState,
  formatParams,
  FORMATS,
  SEARCH_SORT_OPTIONS,
  toggleColor,
  toggleIn,
  useCardSearch,
  type FormatFilterOption,
} from "./useCardSearch";

describe("toggleIn", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleIn([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2], 2)).toEqual([1]);
  });
});

describe("activeFilterCount", () => {
  const none = {
    text: "",
    format: "",
    colors: [],
    sets: [],
    manaValues: [],
    manaX: false,
    owned: undefined,
  };

  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(none)).toBe(0);
  });

  /**
   * `false` is a filter — "the cards I do *not* have" — and a falsy check would count it as
   * nothing at all, leaving Reset all hidden over a search that is filtering hard.
   */
  it("counts an owned filter in either direction", () => {
    expect(activeFilterCount({ ...none, owned: true })).toBe(1);
    expect(activeFilterCount({ ...none, owned: false })).toBe(1);
  });

  /**
   * Each *kind* of filter counts once, however many values it holds: the badge tells the
   * reader how many things Reset all is about to clear, and "3" for three colours in one
   * chip row would be a different, less useful claim.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...none, colors: ["W", "U", "B"] })).toBe(1);
    expect(activeFilterCount({ ...none, sets: ["lea", "roe"] })).toBe(1);
    expect(activeFilterCount({ ...none, text: "bolt", format: "modern", manaValues: [1] })).toBe(3);
  });

  /**
   * X rides *inside* the mana-value group and is OR'd with the numerals, so it is the same
   * kind of filter rather than a ninth one — "1 and X" is one thing Reset all clears, exactly
   * as three colours are. It still has to be seen: an X-only search that counted zero would
   * hide the Reset all that is the way out of it.
   */
  it("counts the X chip with the mana values it sits among", () => {
    expect(activeFilterCount({ ...none, manaX: true })).toBe(1);
    expect(activeFilterCount({ ...none, manaValues: [1], manaX: true })).toBe(1);
    expect(activeFilterCount({ ...none, manaValues: [1], manaX: true, text: "bolt" })).toBe(2);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...none, text: "   " })).toBe(0);
  });

  /**
   * The one row of the format select that *widens*, and it counts anyway.
   *
   * This number captions Reset all, which asks "how much would pressing this change" rather
   * than "how narrow is this search" — and reset puts the select back on `Any format`, so a
   * reader sitting on `Any card` has exactly one thing that press would clear. The old
   * `Unplayable` chip counted zero here and was right to: it survived Reset all. This does not
   * survive it, so a zero would caption a button that changes the wall.
   */
  it("counts Any card, which is the row that widens", () => {
    expect(activeFilterCount({ ...none, format: ANY_CARD })).toBe(1);
    // And it is the same one kind as any other value of that select — one control, one count,
    // whichever of its rows is showing.
    expect(activeFilterCount({ ...none, format: "modern" })).toBe(1);
  });
});

/**
 * One select, two request fields — the mapping the whole merge turns on.
 *
 * Three rows and only three reachable payloads: a state meaning "Modern, and also the art
 * cards" is what the old chip-beside-the-select could reach and what this cannot. `playableOnly`
 * rides with a named format for exactly that reason rather than out of caution — a card legal in
 * Modern is legal somewhere, so it narrows nothing there and one expression covers all three.
 */
describe("formatParams", () => {
  it("asks for the whole corpus on Any card", () => {
    // **Absent, not `false`.** `playableOnly` is omitted-means-false, so this is the request
    // every other caller of `search_cards` sends; spelling it out would make the payload lie.
    expect(formatParams(ANY_CARD)).toEqual({});
  });

  it("hides the printings no format allows on Any format", () => {
    expect(formatParams("")).toEqual({ format: undefined, playableOnly: true });
  });

  it("sends playableOnly with a named format too", () => {
    expect(formatParams("modern")).toEqual({ format: "modern", playableOnly: true });
  });
});

/**
 * One chip, three states — and which of the two *on* states comes first is the caller's,
 * because the useful first press is not the same question in both views. A search asks
 * "what have I already got"; a shopping list asks "what am I still missing".
 */
describe("cycleTriState", () => {
  it("goes off → the caller's question → its opposite → off", () => {
    expect(cycleTriState(undefined, true)).toBe(true);
    expect(cycleTriState(true, true)).toBe(false);
    expect(cycleTriState(false, true)).toBeUndefined();
  });

  it("starts from the other end when the caller asks the other question first", () => {
    expect(cycleTriState(undefined, false)).toBe(false);
    expect(cycleTriState(false, false)).toBe(true);
    expect(cycleTriState(true, false)).toBeUndefined();
  });
});

/** Unchanged behaviour, pinned here because Task 10 restyles the chips it belongs to. */
describe("toggleColor", () => {
  it("keeps C exclusive in both directions", () => {
    expect(toggleColor(["W", "U"], "C")).toEqual(["C"]);
    expect(toggleColor(["C"], "W")).toEqual(["W"]);
  });
});

/** One client per test, reachable from the test body so it can drive a re-read of a key that
 *  is already loaded — the only way to reach "an answer, and an error beside it". */
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

const READY: FacetResponse = {
  colors: { W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 },
  manaValues: { "0": 1 },
  manaX: 1,
  formats: { modern: 1 },
  sets: { lea: 1 },
  owned: { owned: 1, missing: 0 },
  total: 1,
  ready: true,
};

const lastFacetRequest = () =>
  facetCards.mock.calls[facetCards.mock.calls.length - 1][0] as SearchRequest;

const lastSearchRequest = () =>
  searchCards.mock.calls[searchCards.mock.calls.length - 1][0] as SearchRequest;

/**
 * The two `…Only` flags this view decides, whose defaults are **opposites** — which is what
 * makes them the pair most easily got wrong. `paperOnly` is on unless a caller says
 * otherwise, so this view says nothing; `playableOnly` is off unless a caller says
 * otherwise, so this view has to say `true` to get the default it wants.
 */
describe("the corpus useCardSearch searches over", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  it("opens on Any format, which hides the cards no format allows", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    await waitFor(() => expect(facetCards).toHaveBeenCalled());

    expect(result.current.format).toBe("");
    expect(lastSearchRequest().playableOnly).toBe(true);
    // Omitted, and that *is* the value it wants — the neighbour with the opposite default.
    expect(lastSearchRequest().paperOnly).toBeUndefined();
    // The counts have to describe the same corpus the page does, or a chip would offer a set
    // or a mana value that only art cards satisfy.
    expect(lastFacetRequest().playableOnly).toBe(true);

    act(() => result.current.setFormat(ANY_CARD));

    await waitFor(() => expect(lastSearchRequest().playableOnly).toBeUndefined());
    await waitFor(() => expect(lastFacetRequest().playableOnly).toBeUndefined());
    // And `Any card` is not a `legalities` key the backend is asked to match — the sentinel
    // stays on this side of the boundary. It reaching Rust would be a search for a format that
    // does not exist, which answers no rows at all and looks exactly like an empty database.
    expect(lastSearchRequest().format).toBeUndefined();
    expect(lastFacetRequest().format).toBeUndefined();
  });

  /**
   * A named format keeps `playableOnly` on, which is what makes the three rows nest rather than
   * overlap. There is no "Modern, and also the art cards" to reach any more — the old
   * `Unplayable` chip beside this select could reach it, and it was a filter contradicting
   * itself.
   */
  it("keeps playableOnly on under a named format", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setFormat(ANY_CARD));
    await waitFor(() => expect(lastSearchRequest().playableOnly).toBeUndefined());

    act(() => result.current.setFormat("modern"));

    await waitFor(() => expect(lastSearchRequest().format).toBe("modern"));
    expect(lastSearchRequest().playableOnly).toBe(true);
  });

  /**
   * **Both halves reverse what the `Unplayable` chip did, and deliberately.** The chip was
   * filed with `allPrintings` — a statement about the corpus rather than a filter — so Reset all
   * neither counted it nor cleared it. As a row of the format select it is the filter that
   * select has always been: one control cannot be half-cleared by the button that captions
   * itself with how much it clears.
   */
  it("counts Any card on the Reset all badge, and clears it", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setFormat(ANY_CARD));
    await waitFor(() => expect(result.current.activeCount).toBe(1));

    act(() => result.current.resetAll());

    await waitFor(() => expect(result.current.activeCount).toBe(0));
    expect(result.current.format).toBe("");
    await waitFor(() => expect(lastSearchRequest().playableOnly).toBe(true));
  });

  /**
   * `Any card` is the one row of this select that *widens*, so an empty answer to it is still an
   * empty database rather than a search that missed — and the caption the page draws over an
   * empty wall turns on exactly that. It is not "the reader asked something", however plainly
   * the reader picked it.
   */
  it("still reads as unfiltered on Any card", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(result.current.unfiltered).toBe(true);

    act(() => result.current.setFormat(ANY_CARD));
    await waitFor(() => expect(lastSearchRequest().playableOnly).toBeUndefined());
    expect(result.current.unfiltered).toBe(true);

    // The contrast: a named format is the reader asking, and an empty answer to *that* is a
    // search that missed.
    act(() => result.current.setFormat("modern"));
    await waitFor(() => expect(result.current.unfiltered).toBe(false));
  });
});

/**
 * The X chip, whose whole risk is the query key.
 *
 * "Costs 3" and "costs 3, or has an X in its cost" are two different sets of cards, and this
 * query is against local SQLite: a key that could not tell them apart would answer the second
 * out of the first's cached pages *instantly*, with no spinner, no error and nothing on screen
 * to notice. Every test below would pass against a hook that dropped the flag from the payload
 * as well — except that they read the payload too.
 */
describe("the X mana chip", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  it("is off, absent from the payload, and not counted", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.manaX).toBe(false);
    // Absent rather than `false`: an off chip is not a filter, and the backend's default is
    // the value it wants — the rule `paperOnly` follows two fields above it.
    expect(lastSearchRequest().manaX).toBeUndefined();
    expect(lastFacetRequest().manaX).toBeUndefined();
    expect(result.current.activeCount).toBe(0);
    expect(result.current.unfiltered).toBe(true);
  });

  /**
   * **The key, which is the load-bearing half.** A new request having gone out at all is the
   * assertion — the payload below it would be right and unsent if the key had not moved, and
   * the reader would be looking at the previous search's rows.
   */
  it("mints a new key rather than answering out of the numerals' cache", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.toggleManaValue(3));
    await waitFor(() => expect(lastSearchRequest().manaValues).toEqual([3]));
    const asked = searchCards.mock.calls.length;
    const key = result.current.searchKey;

    act(() => result.current.toggleManaX());

    await waitFor(() => expect(searchCards.mock.calls.length).toBeGreaterThan(asked));
    expect(result.current.searchKey).not.toBe(key);
    expect(lastSearchRequest().manaX).toBe(true);
    // **Additive**: the numeral it was pressed beside is still on the wire. `cmc` counts `{X}`
    // as zero, so `{X}{B}{B}{B}` is a 3 *and* an X, and the two chips are OR'd rather than
    // replacing one another.
    expect(lastSearchRequest().manaValues).toEqual([3]);
    // The counts describe the same search the page does, or the row would grey by numbers
    // taken over a different set of printings.
    await waitFor(() => expect(lastFacetRequest().manaX).toBe(true));
  });

  /** A filter, so Reset all reaches it — and it is counted with the numerals it sits among,
   *  which is why one chip and both together read as one thing to clear. */
  it("is cleared by Reset all, counted as part of the mana-value question", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    const fresh = result.current.searchKey;

    act(() => result.current.toggleManaX());
    expect(result.current.activeCount).toBe(1);
    expect(result.current.unfiltered).toBe(false);

    // Still one: the numeral and X are the same question, and the badge counts kinds.
    act(() => result.current.toggleManaValue(3));
    expect(result.current.activeCount).toBe(1);

    act(() => result.current.resetAll());

    expect(result.current.manaX).toBe(false);
    expect(result.current.activeCount).toBe(0);
    // Back to the key the row opened on. Asserted rather than read off the next request,
    // because the key *is* the search — a filter that survived the reset would show here as a
    // search that is not the one this view starts in.
    expect(result.current.searchKey).toBe(fresh);
  });
});

/**
 * The format the panel opens on — a *default*, and default is the whole of what it is.
 *
 * The deck editor's docked panel opens on the format of the deck beside it, so a Commander
 * builder is not shown a wall of cards they cannot play. Everything below is about that being a
 * **starting position** rather than a lock: the reader may move it anywhere including back to
 * `Any format`, Reset all really clears it, and a deck the panel is not looking at any more
 * never gets to put its own answer back over the reader's.
 *
 * `SearchPage` passes nothing, and the first case here is that one: with no option the hook must
 * behave exactly as it did before this parameter existed. (`FilterBar.stories.tsx` is the other
 * caller that passes nothing; `DeckSearchPanel` is the one that passes a default.
 * `CollectionFilterBar` mounts none of this — it imports `FORMATS` and draws its own select.)
 */
describe("the default format filter", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  const COMMANDER: FormatFilterOption = { value: "commander", label: "Commander" };
  /**
   * A key the deck picker offers and this filter's own list does not. The picker draws every
   * enabled `format_specs` row against `FORMATS`' seven, so a default this list cannot draw is
   * the ordinary case rather than the exotic one — and a `<select>` holding a value none of
   * its options carry does not show it, it silently reports the first one. The panel would then
   * read `Any format` over a filtered wall of cards.
   */
  const OATHBREAKER: FormatFilterOption = { value: "oathbreaker", label: "Oathbreaker" };

  /**
   * The hook as the deck editor really drives it: the default arrives as a prop, changes when
   * another deck is opened, and starts at `null` — which is what `useFormatSpecs`, being a
   * query, hands its caller for the first render or two of a session.
   */
  const renderWithDeck = (initial: FormatFilterOption | null) =>
    renderHook(
      ({ deck }: { deck: FormatFilterOption | null }) => useCardSearch({ defaultFormat: deck }),
      { wrapper, initialProps: { deck: initial } },
    );

  const searchRequestAt = (i: number) => searchCards.mock.calls[i][0] as SearchRequest;

  /** The `SearchPage` case: called with no argument, this is the hook it has always been. */
  it("opens on Any format and offers exactly FORMATS when nobody passes one", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.format).toBe("");
    expect(result.current.formats).toEqual(FORMATS);
    // Absent rather than `""`, exactly as before: a blank string is not a filter, and sending
    // one would make the payload lie about intent.
    expect(searchRequestAt(0).format).toBeUndefined();
    expect(result.current.activeCount).toBe(0);
    expect(result.current.unfiltered).toBe(true);
  });

  /**
   * **The first request, not the last.** A default applied after mount would send the whole
   * corpus first and answer it — a wall of cards the deck cannot play, replaced a round trip
   * later — which is the thing seeding `useState` rather than correcting it afterwards exists
   * to prevent, and only reading call zero can see it.
   */
  it("opens on the format it was given, and the first request already carries it", async () => {
    const { result } = renderHook(() => useCardSearch({ defaultFormat: COMMANDER }), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.format).toBe("commander");
    expect(searchRequestAt(0).format).toBe("commander");
  });

  /**
   * The deck's own format select re-points the panel beside it — **including over a format the
   * reader had picked by hand**, because the panel is now looking at a different deck and the
   * hand-picked filter belonged to the old one.
   *
   * The assertion that matters is the list of requests: the state is adjusted during render, so
   * no commit and therefore no query ever holds the stale filter. An effect would pass the two
   * lines above it and fail this one.
   */
  it("re-points at the deck's format when the deck changes, over a reader's own pick", async () => {
    const { result, rerender } = renderWithDeck(COMMANDER);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setFormat("modern"));
    await waitFor(() => expect(lastSearchRequest().format).toBe("modern"));
    const before = searchCards.mock.calls.length;

    rerender({ deck: OATHBREAKER });

    // Synchronously, with no intervening paint.
    expect(result.current.format).toBe("oathbreaker");
    await waitFor(() => expect(searchCards.mock.calls.length).toBeGreaterThan(before));
    expect(searchCards.mock.calls.slice(before).map((c) => (c[0] as SearchRequest).format)).toEqual(
      ["oathbreaker"],
    );
  });

  /**
   * The late seed. `useFormatSpecs` is a query, so the first deck opened in a session mounts
   * this panel before the deck's format is known — the seed on `useState` cannot catch that
   * one, and without the render-phase guard the panel would sit on `Any format` for the life
   * of the deck.
   */
  it("applies a default that arrives late", async () => {
    const { result, rerender } = renderWithDeck(null);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(result.current.format).toBe("");

    rerender({ deck: COMMANDER });

    expect(result.current.format).toBe("commander");
    await waitFor(() => expect(lastSearchRequest().format).toBe("commander"));
  });

  /**
   * The other half of the guard, and the case that decides whether this is a default or a lock.
   * The rerender passes a **fresh object with the same fields**, which is what every caller
   * does on every render: the guard compares the two strings, so nothing here has changed and
   * the reader's own pick is untouched.
   */
  it("leaves a reader's own pick alone while the deck's format holds", async () => {
    const { result, rerender } = renderWithDeck(COMMANDER);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setFormat("modern"));
    rerender({ deck: { ...COMMANDER } });

    expect(result.current.format).toBe("modern");
    await waitFor(() => expect(lastSearchRequest().format).toBe("modern"));
  });

  /**
   * The default going the other way, which is the arm the deck editor reaches by the reader
   * changing the open deck's format to `casual`: the fence stops handing one down, and the
   * filter has to follow it back to `Any format` rather than going on narrowing by a format the
   * deck is not in any more. The same render-phase guard does it — `""` is a default like any
   * other — and the request is what proves it, since a stale key would still be narrowing the
   * search. Driven from the unlisted key so the picker's own row is watched back out too.
   */
  it("clears the filter when the deck's format stops offering a default", async () => {
    const { result, rerender } = renderWithDeck(OATHBREAKER);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(result.current.format).toBe("oathbreaker");

    rerender({ deck: null });

    expect(result.current.format).toBe("");
    await waitFor(() => expect(lastSearchRequest().format).toBeUndefined());
    // And the picker goes back to the seven it had before, rather than keeping a row for a
    // default nobody is passing any more.
    expect(result.current.formats).toEqual(FORMATS);
  });

  /** A default the list already carries is not added twice, and one it does not is added. */
  it("offers a format only the deck picker has, and never doubles one it already had", async () => {
    const { result, rerender } = renderWithDeck(COMMANDER);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.formats).toEqual(FORMATS);

    rerender({ deck: OATHBREAKER });

    expect(result.current.formats).toHaveLength(FORMATS.length + 1);
    expect(result.current.formats[result.current.formats.length - 1]).toEqual(OATHBREAKER);
    // Every one of the seven is still there — this appends, it never replaces.
    for (const f of FORMATS) expect(result.current.formats).toContainEqual(f);
  });

  /**
   * **The asymmetry, which is the point of this test.** `unfiltered` asks "did the reader ask
   * anything of the database", so a default nobody chose is nothing — otherwise a deck editor
   * opened over a database that has not synced yet would caption its empty wall "try another
   * word", and there is no other word, there are no cards. `activeCount` captions Reset all and
   * asks "how much would pressing this change", and pressing it really would clear the format.
   */
  it("counts a default nobody chose as no filter, while Reset all still offers to clear it", async () => {
    const { result } = renderHook(() => useCardSearch({ defaultFormat: COMMANDER }), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.unfiltered).toBe(true);
    expect(result.current.activeCount).toBe(1);

    act(() => result.current.setFormat("modern"));
    expect(result.current.unfiltered).toBe(false);

    act(() => result.current.resetAll());
    expect(result.current.unfiltered).toBe(true);
    expect(result.current.activeCount).toBe(0);
    await waitFor(() => expect(lastSearchRequest().format).toBeUndefined());
  });

  /**
   * Reset all means "no filters", not "back to the deck's" — and it has to **stick**, or the
   * button would be the one control on that row unable to clear what it captions. The guard
   * compares against the applied default rather than against `format`, which reset does not
   * touch, so only the deck really changing brings one back.
   */
  it("clears to Any format on Reset all, and only a new deck brings a default back", async () => {
    const { result, rerender } = renderWithDeck(COMMANDER);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.resetAll());
    expect(result.current.format).toBe("");

    // The deck has not changed, so nothing may put its format back — not on this render, and
    // not on the fresh object every re-render of the editor builds.
    rerender({ deck: { ...COMMANDER } });
    expect(result.current.format).toBe("");
    await waitFor(() => expect(lastSearchRequest().format).toBeUndefined());

    rerender({ deck: OATHBREAKER });
    expect(result.current.format).toBe("oathbreaker");
  });
});

/**
 * **The search page is no longer a printings viewer**, and this describe is what is left of the
 * mode that made it one.
 *
 * "View all printings" used to write `pendingCardSearch` on the store, which this hook consumed
 * during render: it seeded an `oracleId` filter, widened the format select to `Any card`, cleared
 * every other filter and switched `allPrintings` on — a whole second mode of this view, reachable
 * only from a right-click made somewhere else. The row opens a modal over wherever the reader
 * already is now, so nothing seeds a filter here and there is nothing left to consume.
 *
 * The `oracleId` field on `SearchRequest` and its Rust implementation stay, because they are part
 * of the search contract and are tested there. What is gone is the frontend's only way to set it.
 */
describe("the retired one-card mode", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  /**
   * **Call zero, not the last one** — which is where the seed lived. It was spent in a
   * `useState` initialiser precisely so that the *first* request already carried the card, so a
   * surviving seed is a thing only the mount request can still show.
   */
  it("sends no oracle id", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(searchCards.mock.calls[0][0]).not.toHaveProperty("oracleId");
    // The two states that used to arrive with it, back to being this view's own defaults: one
    // row per card, and the caller's format rather than the widest row of the select.
    expect(result.current.allPrintings).toBe(false);
    expect(result.current.format).toBe("");
  });
});

/**
 * The filter bar's sort picker — the sort state reached from somewhere other than a header.
 *
 * Until it landed the table's headers were the only way into `sort`, so the grid, which has
 * none, could not be ordered at all. Two of the seven keys it offers have no header either,
 * and that is what the payload test at the bottom is for: `SEARCH_SORTS` in
 * `src-tauri/src/search.rs` drops a key it does not recognise **silently**, so a spelling that
 * drifts from Rust's is a row of the picker that quietly reorders nothing, with every other
 * assertion in this file still green.
 */
describe("the filter bar's sort picker", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  /**
   * A `Record` over the whole union, so a key added to `SearchSortKey` fails to compile here
   * until somebody decides about it — which is what makes the assertion below a census rather
   * than a second copy of the list it is checking.
   */
  const EVERY_KEY: Record<SearchSortKey, true> = {
    name: true,
    set: true,
    type: true,
    rarity: true,
    price: true,
    manaValue: true,
    released: true,
  };

  /**
   * The claim `sortSelection` rests on, and the reason this picker needs no `Custom…` row
   * where the collection's has one: every key a header can put in the spec is also a row of
   * this select, so a `""` selection can only ever mean the empty spec. A key offered by a
   * header and missing here would leave the select showing a value no `<option>` carries —
   * which react-dom draws as the *first* row, so the control would read `Mana value` over a
   * wall sorted by something else rather than looking broken.
   */
  it("offers every key the search sorts by", () => {
    expect(SEARCH_SORT_OPTIONS.map((o): string => o.value).sort()).toEqual(
      Object.keys(EVERY_KEY).sort(),
    );
  });

  /**
   * The select says "sort by this", not "and also this" — so it replaces, headers and all. A
   * Shift-built second key left standing under it would order the wall by something the
   * control is not showing.
   */
  it("replaces a multi-term sort with one term at that key's first direction", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.toggleSort("name", false));
    act(() => result.current.toggleSort("price", true));
    expect(result.current.sort).toEqual([
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);

    act(() => result.current.setSortKey("released"));

    // Descending because "newest first" is what pressing a release date means — the key's own
    // first direction, not whatever direction the term it replaced happened to carry.
    expect(result.current.sort).toEqual([{ key: "released", dir: "desc" }]);
    expect(result.current.sortSelection).toBe("released");
  });

  /**
   * `Default order` is a real row of that select and the only way back to it: an empty spec is
   * relevance when there is a query, and nothing else on the page can ask for that again once
   * a key has been picked.
   */
  it("empties the spec on the default row", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setSortKey("manaValue"));
    expect(result.current.sort).toEqual([{ key: "manaValue", dir: "asc" }]);

    act(() => result.current.setSortKey(""));

    expect(result.current.sort).toEqual([]);
    expect(result.current.sortSelection).toBe("");
  });

  /**
   * The direction button edits the key the select is showing and nothing else. It also has to
   * edit it **in place**: a first term rewritten by removal and re-append would land behind
   * `price`, which would hand the order to the money column without moving the control.
   */
  it("flips the first term and leaves a second one where it is", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.toggleSort("name", false));
    act(() => result.current.toggleSort("price", true));

    act(() => result.current.flipSortDir());

    expect(result.current.sort).toEqual([
      { key: "name", dir: "desc" },
      { key: "price", dir: "desc" },
    ]);
    expect(result.current.sortSelection).toBe("name");
  });

  /**
   * There is no other end to the view's own order — relevance runs one way — so the button has
   * nothing to flip. Seeding a term to have something would be it answering a question nobody
   * asked, and would take a ranked search off relevance by being pressed.
   */
  it("is a no-op on an empty spec", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(result.current.sort).toEqual([]);

    act(() => result.current.flipSortDir());

    expect(result.current.sort).toEqual([]);
    expect(result.current.sortSelection).toBe("");
  });

  /**
   * The *first* term rather than a single one, so a Shift-built sort still reads as what it is
   * primarily ordered by. The empty spec is where this parts company with the collection's
   * twin, which falls back to `name`: name order is exactly what an empty collection spec
   * means, and it is not what an empty search spec means under a query.
   */
  it("shows the first term's key, and the default row for an empty spec", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    expect(result.current.sortSelection).toBe("");

    act(() => result.current.toggleSort("rarity", false));
    act(() => result.current.toggleSort("set", true));

    expect(result.current.sortSelection).toBe("rarity");
  });

  /**
   * **The only test here that can catch a misspelt key.** Everything above would pass just as
   * well against `manavalue`, because this side never validates the string — Rust does, by
   * dropping it. So the assertion is on the payload the backend is actually handed.
   */
  it("sends the two keys with no column straight through to the backend", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    act(() => result.current.setSortKey("manaValue"));
    await waitFor(() =>
      expect(lastSearchRequest().sort).toEqual([{ key: "manaValue", dir: "asc" }]),
    );

    act(() => result.current.setSortKey("released"));
    await waitFor(() =>
      expect(lastSearchRequest().sort).toEqual([{ key: "released", dir: "desc" }]),
    );

    // And back to the default row the sort is *absent* rather than `[]`, which is the payload
    // an untouched table has always sent.
    act(() => result.current.setSortKey(""));
    await waitFor(() => expect(lastSearchRequest().sort).toBeUndefined());
  });
});

describe("the facet request useCardSearch builds", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
    facetCards.mockReset().mockResolvedValue(READY);
  });

  it("carries the filters and nothing about the page", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(facetCards).toHaveBeenCalled());

    act(() => {
      result.current.setFormat("modern");
      result.current.toggleColor("R");
      result.current.toggleSet("lea");
      result.current.toggleManaValue(1);
      result.current.toggleOwned();
    });

    await waitFor(() => expect(lastFacetRequest().format).toBe("modern"));
    const req = lastFacetRequest();
    expect(req.colors).toBe("R");
    expect(req.sets).toEqual(["lea"]);
    expect(req.manaValues).toEqual([1]);
    expect(req.owned).toBe(true);
    // Facets depend on none of these, which is why they are a separate command: sending a
    // sort or an offset would recompute them on every header press and every page.
    expect(req.sort).toBeUndefined();
    expect(req.collapse).toBeUndefined();
    expect(req.offset).toBe(0);
  });

  /**
   * The claim the separate command exists for. A header press is a different *order* over
   * the same matches, and the counts under it do not move — so if the sort ever reached the
   * facet key, every column press would cost a second round trip that could only answer the
   * same numbers.
   */
  it("does not ask again when only the sort or the view mode changes", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(1));
    const searches = searchCards.mock.calls.length;

    act(() => result.current.toggleSort("price", false));
    act(() => result.current.toggleAllPrintings());

    // The search really did re-run — otherwise this test would pass against a hook that
    // stopped querying altogether.
    await waitFor(() => expect(searchCards.mock.calls.length).toBeGreaterThan(searches));
    expect(facetCards).toHaveBeenCalledTimes(1);
  });

  /**
   * Every failure fails open, and the hook is where that is decided so no control has to
   * remember it. A cold index answers `ready: false` with **empty maps** rather than zeros;
   * handing those maps on as an answer would grey the entire filter row.
   *
   * Written as a *transition* rather than as a cold first load, because a cold first load
   * cannot tell a hook that answers nothing from one that has not answered yet — and because
   * this is the sequence the app really runs: a sync republishes the index, and the counts go
   * away under a reader who is mid-search.
   */
  it("hands on a cold index as no answer at all", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockResolvedValue({
      colors: {},
      manaValues: {},
      // Zero rather than an absent key, because it is a number: the X chip is the one control
      // that would grey on a cold answer if the hook ever handed one on, which is what makes
      // this the sharpest fixture for the collapse being tested here.
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    });
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(result.current.facets).toBeUndefined());
  });

  /**
   * The chips hold their last answer while the next one is in flight, rather than blinking
   * open and shut on every keystroke. The pass is short enough — 57 ms at the worst measured
   * — that an answer one filter out of date is the better of the two experiences.
   */
  it("holds the previous counts while the next answer is in flight", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockReturnValue(new Promise(() => {}));
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(2));
    expect(result.current.facets).toEqual(READY);
  });

  /**
   * …but only while it is *in flight*. A query that failed is not a slow query: the counts it
   * was holding belong to a search the reader has since left, and greying options by them
   * would be the one failure mode this feature is not allowed to have.
   */
  it("drops the counts it was holding when the next facet query fails", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockRejectedValue("the index could not be read");
    act(() => result.current.toggleColor("R"));

    await waitFor(() => expect(result.current.facets).toBeUndefined());
  });

  /**
   * And the other half of that, which is the opposite answer to a failure and is meant to be.
   *
   * A **re-read of the search still on screen** is a case the app really reaches — the app's
   * `QueryClient` runs `staleTime: 30_000`, `retry: 1` and refetch-on-focus — and React Query
   * keeps the data and records the error beside it rather than clearing one for the other.
   * The counts that survive are keyed on this exact filter set, so they still describe what
   * the reader is looking at. Failing open is for not knowing; here we know, and throwing
   * them away would grey nothing over results they correctly describe.
   */
  it("keeps the counts when a re-read of the same search fails", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(result.current.facets).toEqual(READY));

    facetCards.mockRejectedValue(new Error("the index could not be read"));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["cards", "facets"] });
    });

    // The re-read really happened and really failed — without this the assertion below would
    // pass against a hook that never asked again.
    const cached = qc.getQueryCache().findAll({ queryKey: ["cards", "facets"] });
    expect(cached).toHaveLength(1);
    expect(cached[0].state.status).toBe("error");
    expect(cached[0].state.data).toEqual(READY);

    // **The flush matters, and reading without it is how the first version of this comment
    // came to say something false.** `refetchQueries` resolves when the fetch settles, which
    // is a tick before React Query's notifier has told the observer about it — so an
    // assertion here reads the state *before* the error, and would hold whatever the hook
    // did with it. A hook that dropped its counts on `isError` passes without this line.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(result.current.facets).toEqual(READY);
  });

  /**
   * **A not-ready answer corrects itself, and nothing else in the app would ever correct it.**
   *
   * This is the one defect the live pass found (2026-08-11, shipped window): after a sync the
   * filter row showed no counts at all while `facet_cards`, called directly, answered
   * `ready: true`. `sync.rs` calls `lifecycle::spawn_build` and then `emit_done` on the very
   * next line, and `spawn_build` runs `clear` **synchronously on the caller's thread** — so
   * `done` is emitted over a cold index by construction. `useSyncInvalidation` invalidates
   * `["cards"]`, which prefix-matches the facet key, and the single refetch that produces
   * lands inside the ~767 ms build and caches `ready: false`. Success, so no retry; same
   * filters, so no new key; `staleTime` 30 s, so not stale. The row sits there.
   *
   * The sequence below is that exact one, minus the timers: an answer arrives not-ready, the
   * backend then becomes ready, and **nothing touches the hook** — no filter change, no
   * remount, no refetch driven from the test. Against the ordering as it shipped this fails,
   * because the second call never happens.
   */
  it("asks again on its own while the index is cold, and stops once it is ready", async () => {
    const COLD: FacetResponse = { ...READY, ready: false };
    facetCards.mockReset().mockResolvedValue(COLD);

    const { result } = renderHook(() => useCardSearch(), { wrapper });
    // A cold answer is collapsed to `undefined` at the door, which is what leaves every
    // control live — so the row is failing open here, not merely empty.
    await waitFor(() => expect(facetCards).toHaveBeenCalledTimes(1));
    expect(result.current.facets).toBeUndefined();

    // The index finishes building. Real time rather than fake timers, because the hook is
    // one of several driving this render and `vi.useFakeTimers` here would also freeze the
    // debounce and React Query's own scheduling.
    facetCards.mockResolvedValue(READY);

    await waitFor(() => expect(result.current.facets).toEqual(READY), { timeout: 5000 });

    // …and then it stops. The interval is a function of the answer, so a ready one turns it
    // off — without that this hook would poll a healthy index every 500 ms forever.
    const settled = facetCards.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, COLD_POLL_MS * 3));
    });
    expect(facetCards.mock.calls.length).toBe(settled);
  });
});
