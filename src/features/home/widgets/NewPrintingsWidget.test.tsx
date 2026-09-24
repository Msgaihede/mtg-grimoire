import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CardDetail,
  DeckRow,
  HomeWidget,
  NewPrinting,
  NewPrintingDeck,
  NewPrintings,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The three commands this widget can reach, in front of an **intact** mirror.
 *
 * The module namespace *and* the `ipc` object are both spread from the original — an `ipc`
 * replaced wholesale by a handful of `vi.fn()`s erases the hand-written mirror, so a struct that
 * grew a field in Rust fails inside a render rather than under `tsc`. Every stub is typed against
 * its own signature for the same reason: a bare `vi.fn()` accepts any fixture at all, and every
 * fixture below is annotated with the real interface so the mirror checks the shapes this file
 * makes up.
 *
 * **The transport rather than the cache**, which is where this file parts from `DecksWidget`'s.
 * The widget writes the *seen* cursor and then invalidates its own root, so a seeded query is
 * refetched out from under the first assertion the moment the mark lands — and the case that
 * matters most here is precisely what the *second* answer does to the dots. So the stub is the
 * seam, and `newPrintings.mock.calls` is what pins the question the body asked.
 *
 * `deckList` and `cardDetail` are the row dialog's, and both are reached only when a row is
 * pressed: `Dialog` renders its children only while open, which is the whole of why an unpressed
 * card pays nothing for the covers — and the heading's read is mounted with the dialog, which the
 * body mounts on the first press. The two marketplace reads are `useMarketplace`'s, which the
 * dialog prices the printing through.
 */
const newPrintings = vi.hoisted(() =>
  vi.fn<
    (
      scope: string,
      deckIds: readonly number[],
      days: number,
      langs: readonly string[],
      includeVirtual: boolean,
      includeTheory: boolean,
      includeBasics: boolean,
      limit: number,
    ) => Promise<NewPrintings>
  >(),
);
const markNewPrintingsSeen = vi.hoisted(() => vi.fn<(at: number) => Promise<void>>());
const deckList = vi.hoisted(() => vi.fn<() => Promise<DeckRow[]>>());
const cardDetail = vi.hoisted(() =>
  vi.fn<(id: string, marketplace: MarketplaceId) => Promise<CardDetail | null>>(),
);
const getMarketplace = vi.hoisted(() => vi.fn<() => Promise<string>>());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn<() => Promise<never[]>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      newPrintings,
      markNewPrintingsSeen,
      deckList,
      cardDetail,
      getMarketplace,
      marketplaceFeedStatus,
    },
  };
});

import { useAppStore } from "@/lib/store";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import {
  NEW_PRINTINGS_READ,
  NewPrintingsWidget,
  NO_DECKS,
  resolveLangs,
} from "./NewPrintingsWidget";

/**
 * Three release days, two months, all Fridays — the day a set lands.
 *
 * Written as constants because every expectation below is a *formatted* one: the body pins an
 * explicit `en-GB` locale and an explicit UTC zone (`printings.ts`' rule), so `2026-08-28` is
 * "Friday 28 August" on every machine this suite runs on rather than the day before it for
 * everyone west of Greenwich.
 */
const SEP18 = "2026-09-18";
const SEP11 = "2026-09-11";
const AUG28 = "2026-08-28";

/** Midnight UTC of {@link SEP18}, in Unix seconds — what a cursor is compared against. */
const SEP18_AT = 1_789_689_600;

function deckHolding(over: Partial<NewPrintingDeck> = {}): NewPrintingDeck {
  return { deckId: 1, name: "Atraxa", quantity: 2, variant: "live", virtualOnly: false, ...over };
}

/** One reprinted printing. The default is the commonest row there is: an English reprint one
 *  watched deck holds. */
function printing(
  over: Partial<NewPrinting> & { printingId: string; releasedAt: string },
): NewPrinting {
  return {
    oracleId: "o-sol-ring",
    name: "Sol Ring",
    setCode: "sld",
    setName: "Secret Lair Drop",
    collectorNumber: "1",
    rarity: "uncommon",
    promoTypes: null,
    finishes: null,
    lang: "en",
    decks: [deckHolding()],
    ...over,
  };
}

/**
 * The feed as it comes off the wire.
 *
 * `decksWatched` defaults to a non-zero count on purpose: it is the fact that decides *which*
 * empty sentence a card draws, so a fixture that left it at zero would make every other case in
 * this file silently a test of the no-decks branch.
 */
function answer(over: Partial<NewPrintings> = {}): NewPrintings {
  return {
    printings: [],
    decksWatched: 3,
    since: "2026-06-26",
    oldest: null,
    seenAt: null,
    ...over,
  };
}

function deckRow(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    statsOpen: true,
    ...over,
  };
}

/**
 * The printing as `card_detail` answers it — what the dialog's heading and picture are drawn from.
 * Filled out whole so it is a real `CardDetail` rather than a cast; the fields read are the name,
 * the type line, the chin's set and number, and the finishes the price cells are laid out by.
 */
function detail(over: Partial<CardDetail> & { id: string }): CardDetail {
  return {
    oracleId: "o-sol-ring",
    name: "Sol Ring",
    setCode: "sld",
    setName: "Secret Lair Drop",
    collectorNumber: "1",
    rarity: "uncommon",
    layout: "normal",
    lang: "en",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Artifact",
    oracleText: "{T}: Add {C}{C}.",
    illustrationId: "art-sol",
    artist: "Mark Tedin",
    releasedAt: SEP18,
    legalities: null,
    finishPrices: { nonfoil: 1.5, foil: null, etched: null },
    finishes: '["nonfoil","foil"]',
    promoTypes: null,
    imageStatus: "highres_scan",
    faces: [],
    ...over,
  };
}

/** The stored entry the page hands a body. `null` is the config of a widget nobody has set up,
 *  which is what the catalogue adds and what every reader in `widgetSettings.ts` reads as
 *  defaults. */
function widgetOf(config: unknown = null, fit: WidgetFit = ROOMY): HomeWidget {
  return { id: "np-1", kind: "newPrintings", x: 0, y: 0, w: fit.w, h: fit.h, config };
}

/** The box a card is told it is drawn in, at the grid's own target cell — so "a two-cell tile" is
 *  a two-cell tile in pixels too, and the fitting arithmetic below is the page's. */
function fitFor(w: number, h: number): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });
}

/**
 * **220 × 220, one list column, 168px of body** — the one entry of the design's size matrix that
 * is fixture-independent. It is also below every one of the body's height gates, so nothing here
 * draws a month rule, a *Seen already* rule or a closing line.
 */
const TILE = fitFor(2, 2);
/** 452 × 452, two list columns, 400px of body: room for every fixture in this file and no
 *  furniture, so a case about wording is never also a case about the cut. */
const ROOMY = fitFor(4, 4);
/** 684 × 452 — **three** list columns, which is the footprint the "rows stay in their own group"
 *  rule is about. */
const WIDE = fitFor(6, 4);
/** 452 × 1380, two columns, 1 328px of body — the tallest card the kind offers, and the only
 *  footprint that draws both the month rules and the closing line. */
const TALL = fitFor(4, 12);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw({
  config = null,
  fit = ROOMY,
  still = false,
}: { config?: unknown; fit?: WidgetFit; still?: boolean } = {}) {
  return render(
    <NewPrintingsWidget
      widget={widgetOf(config, fit)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Every row's accessible name, in the order they are drawn — the one assertion that can see both
 *  *which* printings are shown and *what order* they are in. The row's whole face is in that one
 *  string on purpose: three flex children separated by a `gap` concatenate to `Sol RingSLD2
 *  decks`, so the parts would not survive name computation. */
function rowNames(): string[] {
  return rows().map((el) => el.getAttribute("aria-label") ?? "");
}

/** Every pressable row — the buttons that open a printing's dialog. Found by `aria-haspopup`,
 *  because the row carries no `aria-expanded` on purpose (see `PrintingRow`). */
function rows(): HTMLElement[] {
  return screen
    .queryAllByRole("button")
    .filter((el) => el.getAttribute("aria-haspopup") === "dialog");
}

beforeEach(() => {
  newPrintings.mockReset().mockResolvedValue(answer());
  markNewPrintingsSeen.mockReset().mockResolvedValue(undefined);
  deckList.mockReset().mockResolvedValue([]);
  cardDetail.mockReset().mockImplementation((id) => Promise.resolve(detail({ id })));
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // Store state is module-level and leaks between tests, so the popover's navigation case would
  // otherwise pass on an id a previous case wrote. Every case starts from the store's own
  // initial state.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

/**
 * Decision 2, and the whole of it: three modes on the page collapse into **one** list on the
 * wire, where empty is every language. A mode *and* a list would be two fields that can disagree.
 */
describe("resolveLangs", () => {
  const lang = (config: unknown) => resolveLangs(widgetOf(config));

  it("resolves the three language modes into one allow-list", () => {
    expect(lang(null)).toEqual(["en"]);
    expect(lang({ langs: "en" })).toEqual(["en"]);
    // **Empty is every language** — the one sentinel, and the same rule at both ends of the wire.
    expect(lang({ langs: "all" })).toEqual([]);
    expect(lang({ langs: "chosen", langIds: ["en", "ja"] })).toEqual(["en", "ja"]);
  });

  /**
   * A hand-edited `config` reaches this function unchecked — `widgetConfig`'s shape check is
   * shallow by its own admission — so the ids are narrowed against `languages.ts`' table here.
   * **Nothing usable reads as English and gets no sentence**, which parts from `DecksWidget`'s
   * *no decks pinned yet*: an empty deck set is a real statement, where an empty language set
   * would mean *show no printings at all*, which nobody means by unticking the last box.
   */
  it("drops language ids the table does not name, and reads what is left as English", () => {
    expect(lang({ langs: "chosen", langIds: ["zz", 7, null, "ja"] })).toEqual(["ja"]);
    expect(lang({ langs: "chosen", langIds: ["zz", 7, null] })).toEqual(["en"]);
    expect(lang({ langs: "chosen", langIds: [] })).toEqual(["en"]);
    expect(lang({ langs: "chosen" })).toEqual(["en"]);
  });

  /** A word no option carries is the pick's default, which is `pickValue`'s vocabulary check —
   *  so a `config` a newer build wrote cannot reach a branch this one does not have. */
  it("reads a mode this build does not offer as English", () => {
    expect(lang({ langs: "every-language-ever" })).toEqual(["en"]);
  });
});

/**
 * §8's footprint-scaled default is **not implemented**, and this is the case that says so rather
 * than an absence a reader has to notice. It shipped once as dead code — `pickOf` answers the
 * registry's `dflt: 90` rather than `undefined`, so the arm beside it could never run — and
 * wiring it up would have left the title chip (`chipLabel`, which takes no `fit`) saying *90
 * days* over a body reading a year. Every card opens on ninety days; §12 of
 * `docs/reference/home-page.md` has the whole argument.
 */
describe("the window every card arrives on", () => {
  it("is ninety days even on a card §8 would have opened on a year", async () => {
    // 4 × 12 is 48 cells, twice §8's threshold of 24 — the footprint the rule was written for.
    draw({ fit: TALL });

    await waitFor(() => expect(newPrintings).toHaveBeenCalledTimes(1));
    expect(newPrintings.mock.calls[0][2]).toBe(90);
  });
});

describe("the question the card asks", () => {
  /**
   * Every argument is the widget's `config` narrowed on the way out, and the defaults are the
   * issue's: theory cards in, virtual decks and basic lands out.
   *
   * The `90` is the registry's `dflt`, and it is what **every** footprint reads — see
   * `the window every card arrives on` above for why §8's footprint rule is not implemented.
   */
  it("asks with the issue's three defaults, English, and the command's own read size", async () => {
    draw({ fit: TALL });

    await waitFor(() => expect(newPrintings).toHaveBeenCalledTimes(1));
    expect(newPrintings).toHaveBeenCalledWith(
      "all",
      [],
      90,
      ["en"],
      false,
      true,
      false,
      NEW_PRINTINGS_READ,
    );
  });

  /** A stored config is read whole — the scope and its ids, the window, the language mode and
   *  each of the three switches. */
  it("asks the reader's own question when the card has been set up", async () => {
    draw({
      config: {
        scope: "chosen",
        deckIds: [7, "3", 2.5, 3],
        window: 365,
        langs: "chosen",
        langIds: ["ja", "zz"],
        virtual: true,
        theory: false,
        basics: true,
      },
    });

    await waitFor(() => expect(newPrintings).toHaveBeenCalledTimes(1));
    // The ids are narrowed with `DecksWidget`'s element check: a string and a fraction are not
    // deck ids, and neither is a language `languages.ts` has never heard of.
    expect(newPrintings).toHaveBeenCalledWith(
      "chosen",
      [7, 3],
      365,
      ["ja"],
      true,
      false,
      true,
      NEW_PRINTINGS_READ,
    );
  });
});

/**
 * **Three empty sentences, never one.** An empty list means *no deck is watched* or *nothing was
 * reprinted in this window*, and a count of zero printings cannot tell them apart — so the
 * watched count travels beside the list and is read first.
 */
describe("the sentences", () => {
  it("says it is reading while the read is out", async () => {
    newPrintings.mockImplementation(() => new Promise(() => {}));

    draw();

    expect(await screen.findByText("Reading recent printings…")).toBeInTheDocument();
  });

  /**
   * A reader watching no decks is not a reader whose decks hold nothing new, and handing them the
   * wrong sentence sends them to the wrong place: this one points at the control that fixes it.
   */
  it("says no decks are watched, and not that nothing was reprinted", async () => {
    newPrintings.mockResolvedValue(answer({ decksWatched: 0, printings: [] }));

    draw();

    expect(await screen.findByText(NO_DECKS)).toBeInTheDocument();
    expect(screen.queryByText(/has been reprinted/)).toBeNull();
  });

  it("says nothing was reprinted when decks are watched and the list is empty", async () => {
    newPrintings.mockResolvedValue(answer({ decksWatched: 3, printings: [] }));

    draw();

    expect(
      await screen.findByText(
        "Nothing in the 3 decks you watch has been reprinted in the last 90 days. New printings arrive with each card data sync.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(NO_DECKS)).toBeNull();
  });

  /** The count and the window are both the reader's, so both agree with themselves in the
   *  singular — one deck, and a window a reader could have picked. */
  it("counts one watched deck and one day in words", async () => {
    newPrintings.mockResolvedValue(answer({ decksWatched: 1, printings: [] }));

    draw({ config: { window: 30 } });

    expect(
      await screen.findByText(
        "Nothing in the 1 deck you watch has been reprinted in the last 30 days. New printings arrive with each card data sync.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * **The refusal is read before the emptiness**, which is `ActivityWidget`'s rule and its
   * reason: a failed read has no rows either, and calling it *nothing has been reprinted* tells a
   * reader with six decks that the game has stopped printing cards. `ipcError` is how the
   * backend's own words reach the card.
   */
  it("reads the refusal before the emptiness", async () => {
    newPrintings.mockRejectedValue("BUSY: the database is being written to");

    draw();

    expect(
      await screen.findByText(
        "Could not read recent printings — BUSY: the database is being written to",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has been reprinted/)).toBeNull();
    expect(screen.queryByText(NO_DECKS)).toBeNull();
    expect(screen.queryByText("Reading recent printings…")).toBeNull();
  });
});

describe("what a card has room for", () => {
  /**
   * **§11's checkable case, and the one entry of §8 that is fixture-independent.** A 2 × 2 has
   * 168px of body and one list column, so `floor((168 − 22 − 22 + 6) / (54 + 6))` — the footer,
   * the day's own header and gap, over a 54px row on a 6px gap — is **two** row-lines whatever
   * the day groups do.
   *
   * The fixture is **one day holding four printings**, stated here because the count is a fact
   * about this list and not about the arithmetic: a second day would spend a second header and
   * the design's own `Printings` column was measured over a different sample entirely.
   */
  it("draws exactly two rows at 2 × 2, and no chip", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [1, 2, 3, 4].map((n) =>
          printing({ printingId: `p${n}`, releasedAt: SEP18, name: `Card ${n}` }),
        ),
        oldest: SEP18,
      }),
    );

    draw({ fit: TILE });

    await screen.findByText("Card 1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Card 2")).toBeInTheDocument();
    expect(screen.queryByText("Card 3")).toBeNull();
    // No room for a bordered chip at two cells, so the deck count goes in the caption — and the
    // header carries the day's short label rather than the long one.
    expect(screen.queryByText("1 deck")).toBeNull();
    expect(screen.getAllByText("· 1×")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("18 Sept");
  });

  /**
   * **A group's rows fill the columns under their own header and never across one.** Without that
   * rule a three-column card reads as three unrelated lists — so each day's list is its own
   * `ul`, named by the day it is about.
   *
   * The fixture is two days at three columns: five printings that would fit on two lines of a
   * single list, and do not.
   */
  it("keeps a day's rows inside its own group at three columns", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [
          printing({ printingId: "a1", releasedAt: SEP18, name: "Sol Ring" }),
          printing({ printingId: "a2", releasedAt: SEP18, name: "Arcane Signet" }),
          printing({ printingId: "b1", releasedAt: SEP11, name: "Lightning Bolt" }),
          printing({ printingId: "b2", releasedAt: SEP11, name: "Counterspell" }),
          printing({ printingId: "b3", releasedAt: SEP11, name: "Brainstorm" }),
        ],
        oldest: SEP11,
      }),
    );

    draw({ fit: WIDE });

    await screen.findByText("Sol Ring");
    expect(WIDE.listColumns).toBe(3);
    const newer = screen.getByRole("list", { name: "Friday 18 September" });
    const older = screen.getByRole("list", { name: "Friday 11 September" });
    expect(within(newer).getAllByRole("listitem")).toHaveLength(2);
    expect(within(older).getAllByRole("listitem")).toHaveLength(3);
    // …and in that order: the feed is newest first and the fold is a fold, never a second sort.
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * **The month rules and the closing line, both of which only a tall card draws.** A month rule
   * is drawn where the month turns and never before the first group, where it would be a heading
   * over the card's own heading; the closing line is drawn only when everything the read answered
   * is on screen, because a list that is still scrolling has not run out of window, it has run
   * out of card.
   *
   * The fixture is four printings over three days in two months — 18 and 11 September, and 28
   * August — with `oldest` at the far end of it.
   */
  it("draws the month rules and the closing line at 4 × 12", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [
          printing({ printingId: "a1", releasedAt: SEP18, name: "Sol Ring" }),
          printing({ printingId: "a2", releasedAt: SEP18, name: "Arcane Signet" }),
          printing({ printingId: "b1", releasedAt: SEP11, name: "Lightning Bolt" }),
          printing({ printingId: "c1", releasedAt: AUG28, name: "Counterspell" }),
        ],
        oldest: AUG28,
      }),
    );

    draw({ fit: TALL });

    await screen.findByText("Sol Ring");
    // One rule, at the one boundary: not over the first group, and not between two September
    // days.
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(screen.queryByText("September 2026")).toBeNull();
    expect(
      screen.getByText("Nothing older than 28 August in this window."),
    ).toBeInTheDocument();
  });

  /**
   * The closing line is a statement about the *window*, so a list the box cut short does not get
   * one — those rows are in the DOM and scrollable, and the reader has not reached the end of
   * anything.
   *
   * The fixture is **sixty printings on one day** at 4 × 12: two list columns over 1 328px of
   * body less the footer and the closing line's own reservation leave twenty row-lines, so forty
   * rows are drawn and twenty are not.
   */
  it("draws no closing line while the box is still cutting the list", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: Array.from({ length: 60 }, (_, i) =>
          printing({ printingId: `p${i}`, releasedAt: SEP18, name: `Card ${i}` }),
        ),
        oldest: SEP18,
      }),
    );

    draw({ fit: TALL });

    await screen.findByText("Card 0");
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    expect(screen.queryByText(/^Nothing older than/)).toBeNull();
  });

  /**
   * **A `gap` between two children joins them with no space at all in the accessible name** — the
   * `Missing2` failure, which is why `ActivityWidget` keeps its roll-up *outside* its `h4`.
   *
   * ⚠ This heading does not: the label, the rule and the count are all inside it, so the computed
   * name is the day and the count with nothing between them. Asserted as it computes rather than
   * as it reads, because the whole point of the trap is that asserting the two texts separately
   * passes over it, and the component's own comment cited the trap while committing it.
   *
   * **Fixed 2026-09-20**: the `h4` holds the label alone and the rule and count are its siblings,
   * which is `ActivityWidget.Heading`'s shape exactly. This asserts the computed name rather than
   * the two texts separately, because asserting them separately is what passed over the defect.
   */
  it("computes the day heading's name from its label alone", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [
          printing({ printingId: "a1", releasedAt: SEP18, name: "Sol Ring" }),
          printing({ printingId: "a2", releasedAt: SEP18, name: "Arcane Signet" }),
        ],
        oldest: SEP18,
      }),
    );

    draw();

    await screen.findByText("Sol Ring");
    expect(screen.getByRole("heading", { level: 4 })).toHaveAccessibleName(
      "Friday 18 September",
    );
    // The count is still on screen — it moved out of the name, not off the card.
    expect(screen.getByText("2")).toBeVisible();
  });
});

/**
 * **The caption carries the language code whenever the answer is not English alone.** `Every
 * language` answers one reprint once per language, which is what that reader asked for — and
 * without the code those are rows reading `Sol Ring · SLD · 1 deck` and the list looks broken
 * rather than complete.
 */
describe("the language code", () => {
  const twoLanguages = () =>
    answer({
      printings: [
        printing({ printingId: "en", releasedAt: SEP18, lang: "en" }),
        printing({ printingId: "ja", releasedAt: SEP18, lang: "ja" }),
      ],
      oldest: SEP18,
    });

  it("carries the language code once the answer is not English alone", async () => {
    newPrintings.mockResolvedValue(twoLanguages());

    draw({ config: { langs: "all" } });

    await screen.findByText("EN");
    expect(screen.getByText("JA")).toBeInTheDocument();
    // And it is said in words in the row's own name, where the code is a mark on screen.
    expect(rowNames()).toEqual([
      "Sol Ring · SLD · Secret Lair Drop · English · uncommon · 1 deck · not seen yet",
      "Sol Ring · SLD · Secret Lair Drop · Japanese · uncommon · 1 deck · not seen yet",
    ]);
  });

  /**
   * **At two cells as well**, which is the point of the rule: it is what tells two rows of one
   * reprint apart rather than a detail a small card can drop.
   */
  it("carries the language code on a two-cell tile too", async () => {
    newPrintings.mockResolvedValue(twoLanguages());

    draw({ config: { langs: "all" }, fit: TILE });

    await screen.findByText("EN");
    expect(screen.getByText("JA")).toBeInTheDocument();
  });

  /**
   * English alone has nothing to tell apart, so the code is noise. Read off the **resolved** list
   * and never off the pick: a `Chosen…` that narrowed down to English alone draws no code either.
   */
  it("draws no language code when the answer is English alone", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [printing({ printingId: "en", releasedAt: SEP18 })],
        oldest: SEP18,
      }),
    );

    const { unmount } = draw();
    await screen.findByText("Sol Ring");
    expect(screen.queryByText("EN")).toBeNull();
    expect(rowNames()).toEqual([
      "Sol Ring · SLD · Secret Lair Drop · uncommon · 1 deck · not seen yet",
    ]);
    unmount();

    draw({ config: { langs: "chosen", langIds: ["en"] } });
    await screen.findByText("Sol Ring");
    expect(screen.queryByText("EN")).toBeNull();
  });
});

/**
 * **The cursor is read once per mount and held.** The widget writes it as soon as it renders a
 * non-empty list, so a body that re-read it would watch every gold dot vanish under the reader's
 * eyes a frame after they appeared.
 */
describe("the unseen cursor", () => {
  const oneUnseenDay = () =>
    answer({
      printings: [printing({ printingId: "a1", releasedAt: SEP18 })],
      oldest: SEP18,
      seenAt: null,
    });

  it("keeps the dots up after writing the seen cursor in the same session", async () => {
    newPrintings.mockResolvedValue(oneUnseenDay());
    // The write moves the cursor past the whole feed, and the invalidation that follows it brings
    // that new cursor straight back. This is the frame the latch exists for.
    markNewPrintingsSeen.mockImplementation(async () => {
      newPrintings.mockResolvedValue(
        answer({
          printings: [printing({ printingId: "a1", releasedAt: SEP18 })],
          oldest: SEP18,
          seenAt: SEP18_AT + 86_400,
        }),
      );
    });

    draw();

    await screen.findByText("Sol Ring");
    expect(rowNames()[0]).toContain("not seen yet");
    await waitFor(() => expect(markNewPrintingsSeen).toHaveBeenCalledTimes(1));
    // The root's own invalidation, which is what keeps `NEW_PRINTINGS_ROOT` a root with a writer.
    await waitFor(() => expect(newPrintings).toHaveBeenCalledTimes(2));

    expect(rowNames()[0]).toContain("not seen yet");
  });

  /** The clock is the caller's — never `SystemTime::now()`, which panics on the wasm target — and
   *  it is whole seconds, which is what `app_meta` stores. */
  it("writes the cursor once per mount, in whole seconds", async () => {
    newPrintings.mockResolvedValue(oneUnseenDay());

    draw();

    await screen.findByText("Sol Ring");
    await waitFor(() => expect(markNewPrintingsSeen).toHaveBeenCalledTimes(1));
    const [at] = markNewPrintingsSeen.mock.calls[0];
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
  });

  /** **A still body publishes nothing** — a catalogue preview is a picture of a widget, and one
   *  that marked the reader's feed as seen would put every dot out on a card nobody opened. */
  it("writes no cursor while still", async () => {
    newPrintings.mockResolvedValue(oneUnseenDay());

    draw({ still: true });

    await screen.findByText("Sol Ring");
    // The rows are pictures of rows: the same words, and no press.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
    expect(markNewPrintingsSeen).not.toHaveBeenCalled();
    // And nothing was published late either: a cursor write invalidates this widget's own root,
    // so a second read is the tell that one happened.
    await waitFor(() => expect(newPrintings).toHaveBeenCalledTimes(1));
    expect(markNewPrintingsSeen).not.toHaveBeenCalled();
  });

  /** A cursor past the whole feed is a feed with no dots on it, which is the other half of the
   *  same latch: what is drawn is the cursor as it stood when the card mounted. */
  it("draws no dot for a day the reader has already seen", async () => {
    newPrintings.mockResolvedValue(
      answer({
        printings: [printing({ printingId: "a1", releasedAt: SEP18 })],
        oldest: SEP18,
        seenAt: SEP18_AT + 86_400,
      }),
    );

    draw();

    await screen.findByText("Sol Ring");
    expect(rowNames()[0]).not.toContain("not seen yet");
  });
});

/**
 * The row is the question — *which decks hold this card* — so the whole row is the press, and what
 * it opens is the printing drawn the way the card modal draws a card, with the decks beside it
 * (issue #514).
 */
describe("the printing dialog", () => {
  /** One Sol Ring reprint held by a live deck and a theory one, with both covers readable. */
  function heldTwice() {
    newPrintings.mockResolvedValue(
      answer({
        printings: [
          printing({
            printingId: "sld-1",
            releasedAt: SEP18,
            decks: [
              deckHolding({ deckId: 4, name: "Atraxa", quantity: 2 }),
              deckHolding({ deckId: 9, name: "Edgar", quantity: 1, variant: "theory" }),
            ],
          }),
        ],
        oldest: SEP18,
      }),
    );
    deckList.mockResolvedValue([deckRow({ id: 4, name: "Atraxa" }), deckRow({ id: 9, name: "Edgar" })]);
  }

  /**
   * **The card modal's own parts, and the test says which ones** — the reader asked for the
   * preview to look like the card details popup, so what is pinned is that it *is* those parts: the
   * picture named by the card, the chin's `SLD · 1` under it, the price cell per finish, and a
   * heading carrying the type line beside the name. Not a screenshot; a drawing that shares no
   * code with the modal would fail every one of these.
   */
  it("draws the printing the way the card modal does, with the decks that hold it", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    await user.click(await screen.findByRole("button", { name: /^Sol Ring/ }));

    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });
    // The heading waits on nothing: the row already knew the name, so it never reads *Loading…*.
    expect(within(dialog).queryByText("Loading…")).toBeNull();
    // `CardModalArt`: the picture, named by the card, over its chin and one cell per finish.
    expect(await within(dialog).findByRole("img", { name: "Sol Ring" })).toBeInTheDocument();
    expect(within(dialog).getByText("SLD · 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Nonfoil")).toBeInTheDocument();
    expect(within(dialog).getByText("Foil")).toBeInTheDocument();
    // `CardModalTitle`: the type line beside the name, from the same read.
    expect(within(dialog).getByText("Artifact")).toBeInTheDocument();
    expect(within(dialog).getByText("Released Friday, 18 September 2026")).toBeInTheDocument();
    // Read once, at the card modal's own key — so *Open card details* paints from this entry.
    expect(cardDetail).toHaveBeenCalledWith("sld-1", "tcgplayer");
    expect(qc.getQueryData(["card", "sld-1", "tcgplayer"])).toMatchObject({ id: "sld-1" });

    const decks = within(dialog).getByRole("region", { name: "In 2 watched decks" });
    // A deck holding the card only in a theory pile says so rather than counting copies nobody
    // owns.
    expect(within(decks).getByRole("button", { name: "Atraxa · 2 copies" })).toBeInTheDocument();
    expect(within(decks).getByRole("button", { name: "Edgar · planned" })).toBeInTheDocument();
  });

  it("names the printing's language under the heading when it is not English", async () => {
    const user = userEvent.setup();
    newPrintings.mockResolvedValue(
      answer({ printings: [printing({ printingId: "sld-ja", releasedAt: SEP18, lang: "ja" })] }),
    );

    draw({ config: { langs: "all" } });
    await user.click(await screen.findByRole("button", { name: /^Sol Ring/ }));

    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });
    expect(
      within(dialog).getByText("Released Friday, 18 September 2026 · Japanese"),
    ).toBeInTheDocument();
  });

  /**
   * ⚠️ **The row must never carry `aria-expanded`.** `WidgetCard` lifts itself to `z-10` whenever
   * anything inside it says `aria-expanded="true"`, and a card with a z-index is a stacking context
   * — which would cap this dialog's scrim at the card's layer. jsdom has no opinion about a
   * z-index, so the attribute is the only thing the suite can pin.
   */
  it("opens from a row that carries no aria-expanded, before or after the press", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    const row = await screen.findByRole("button", { name: /^Sol Ring/ });
    expect(row).toHaveAttribute("aria-haspopup", "dialog");
    expect(row).not.toHaveAttribute("aria-expanded");

    await user.click(row);
    await screen.findByRole("dialog", { name: /^Sol Ring/ });
    expect(row).not.toHaveAttribute("aria-expanded");
  });

  it("hands the caret back to the row on Escape", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    const row = await screen.findByRole("button", { name: /^Sol Ring/ });
    await user.click(row);
    await screen.findByRole("dialog", { name: /^Sol Ring/ });

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(row).toHaveFocus();
  });

  it("opens the deck that is pressed", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    await user.click(await screen.findByRole("button", { name: /^Sol Ring/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });

    await user.click(within(dialog).getByRole("button", { name: "Edgar · planned" }));

    // **`decks` is one view with two states**, so a press writes the view *and* the id.
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(9);
  });

  /**
   * ⚠ **The printing is not selected, and the body says it is.** `openDeck` writes the card
   * first — *"so the deck opens with the printing already picked out in it"* — but
   * `setActiveView` clears `selectedCardId` on the way into a view, so the write is undone by
   * the next line of the same function. `setOpenDeckId` clears no card, so the order that would
   * work is view, deck, **then** card.
   *
   * **Fixed 2026-09-20**: the order is view → deck → card, which is the one order in which all
   * three writes survive. This asserts the card as well as the deck, because a test checking only
   * the two writes that always landed is exactly what passed over the defect.
   */
  it("opens the deck with the pressed printing picked out in it", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    await user.click(await screen.findByRole("button", { name: /^Sol Ring/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });
    await user.click(within(dialog).getByRole("button", { name: "Atraxa · 2 copies" }));

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(4);
    expect(useAppStore.getState().selectedCardId).toBe("sld-1");
  });

  /**
   * *Open card details* is the card modal on this printing, over the home page — and the caret is
   * handed to the row **before** the card is selected, so the modal remembers the row as its opener
   * rather than this dialog's panel, which is on its way out of the document.
   */
  it("opens the card modal on the printing, with the caret back on its row", async () => {
    const user = userEvent.setup();
    heldTwice();

    draw();
    const row = await screen.findByRole("button", { name: /^Sol Ring/ });
    await user.click(row);
    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });

    await user.click(within(dialog).getByRole("button", { name: "Open card details" }));

    expect(useAppStore.getState().selectedCardId).toBe("sld-1");
    // Still on the home page: the card modal is drawn over whatever view is on screen.
    expect(useAppStore.getState().activeView).toBe("home");
    expect(row).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when the card cannot be read, and still lists the decks", async () => {
    const user = userEvent.setup();
    heldTwice();
    cardDetail.mockRejectedValue("The card database is busy.");

    draw();
    await user.click(await screen.findByRole("button", { name: /^Sol Ring/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Sol Ring/ });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not read this card — The card database is busy.",
    );
    expect(within(dialog).getByRole("button", { name: "Atraxa · 2 copies" })).toBeInTheDocument();
  });

  it("opens nothing from a catalogue preview", async () => {
    heldTwice();

    draw({ still: true });

    expect(await screen.findByText("Sol Ring")).toBeInTheDocument();
    expect(rows()).toEqual([]);
  });
});
