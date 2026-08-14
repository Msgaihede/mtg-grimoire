import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardSummary } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { card } from "./validation/fixtures";

const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards },
}));

/**
 * The system file picker.
 *
 * Mocked for the reason `DeckSettingsDialog.test.tsx` mocks it: there is no OS dialog in jsdom,
 * and the real `open` reaches `invoke`, which needs `window.__TAURI_INTERNALS__` and would throw
 * identically for all three answers a picker can give. The three are exercised on the dialog's
 * own suite; here the mock exists so pressing Upload does not explode a test about something
 * else.
 */
const pickFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFile }));

import { coverChoices, DeckCoverPicker, type DeckCoverPickerProps } from "./DeckCoverPicker";

/** One search result — `DeckEditor.test.tsx`'s builder, cut to what a cover tile reads. */
function found(name: string): CardSummary {
  return {
    id: `s-${name}`,
    name,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "12",
    rarity: "rare",
    typeLine: "Creature — Goblin",
    manaCost: "{R}",
    price: 1.5,
    layout: "normal",
    oracleId: `o-${name}`,
    finishes: `["nonfoil"]`,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: 1.5,
    priceHigh: 1.5,
    gameChanger: false,
  };
}

const page = (items: CardSummary[], total = items.length, totalIsCapped = false) => ({
  items,
  total,
  totalIsCapped,
});

function wrap(ui: ReactElement) {
  // No retries: a test that mocks a refusal should see it on the first answer, not after three.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The picker with a cover it can credit and nothing else going on. */
function picker(props: Partial<DeckCoverPickerProps> = {}) {
  const onPickCard = vi.fn();
  const onPickFile = vi.fn();
  const view = wrap(
    <DeckCoverPicker
      coverCardId="c-Lightning Bolt"
      coverKind="card_art"
      coverArtist="Christopher Rush"
      customCoverUrl={null}
      deckCards={[]}
      onPickCard={onPickCard}
      onPickFile={onPickFile}
      pendingFileName={null}
      uploading={false}
      idPrefix="cover"
      {...props}
    />,
  );
  return { onPickCard, onPickFile, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  searchCards.mockResolvedValue(page([]));
  pickFile.mockResolvedValue("C:\\pics\\dragon.png");
});

describe("DeckCoverPicker", () => {
  /** The in-deck half, unchanged from the settings dialog: the deck's own printings, and a
   *  press that hands the card id back rather than writing anything itself. */
  it("offers the deck's own printings, and picking one calls onPickCard", async () => {
    const { onPickCard } = picker({
      deckCards: [card({ name: "Lightning Bolt" }), card({ name: "Shivan Dragon" })],
    });

    await userEvent.click(screen.getByRole("button", { name: "Shivan Dragon" }));

    // Once, with the card id and nothing else. Both commands that set a cover belong to the
    // host — a component that reached for either would be usable on one of the two surfaces.
    expect(onPickCard).toHaveBeenCalledTimes(1);
    expect(onPickCard).toHaveBeenCalledWith("c-Shivan Dragon");
  });

  /** The tile that is already the cover says so, rather than leaving the reader to match the
   *  picture above against eight thumbnails. */
  it("marks the tile that is already the cover", () => {
    picker({ deckCards: [card({ name: "Lightning Bolt" }), card({ name: "Shivan Dragon" })] });

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Shivan Dragon" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /**
   * A deck being created has no cards, which is the state the search box exists for — but the
   * grid still has to say what it is empty *of* rather than showing nothing at all.
   */
  it("says the deck has nothing to pick from yet", () => {
    picker({ deckCards: [] });

    expect(screen.getByText(/Nothing to pick from yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  /**
   * **The empty box is not a browse.** `useCardSearch`'s is, deliberately — an empty search view
   * is the whole database sorted by name. Here an empty box already has an answer, the deck's
   * own cards, so a round trip whose result is never drawn must not be made.
   */
  it("asks the backend nothing while the search box is empty", async () => {
    picker({ deckCards: [card({ name: "Lightning Bolt" })] });

    // Long enough that the debounce would have fired had anything been queued.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(searchCards).not.toHaveBeenCalled();
  });

  /**
   * The new half: a query replaces the deck's own cards with every printing the database has,
   * under a heading that says which of the two is on screen.
   *
   * Real timers and a `waitFor`, not `vi.useFakeTimers()`: **`userEvent` cannot be driven under
   * Vitest fake timers at all** — RTL's `asyncWrapper` waits on a real `setTimeout` it only
   * knows how to advance through Jest, so the test hangs to its timeout instead of failing.
   */
  it("switches the grid to search results, and picking one calls onPickCard", async () => {
    searchCards.mockResolvedValue(page([found("Shivan Dragon"), found("Bogardan Hellkite")]));
    const { onPickCard } = picker({ deckCards: [card({ name: "Lightning Bolt" })] });

    await userEvent.type(screen.getByLabelText("Search every card"), "dragon");

    const list = await screen.findByRole("list", { name: "Pick art from any card" });
    // The deck's own card is gone: one grid, two modes, never both at once.
    expect(within(list).queryByRole("button", { name: "Lightning Bolt" })).toBeNull();

    await userEvent.click(within(list).getByRole("button", { name: "Shivan Dragon" }));

    expect(onPickCard).toHaveBeenCalledWith("s-Shivan Dragon");
  });

  /**
   * The two flags that make this a *cover* search rather than a copy of the search view's.
   *
   * `collapse: false` because different printings are different art, and collapsing them hides
   * exactly the choice being made. `playableOnly: false` because art series and tokens are some
   * of the best crops there are and a cover is not a card you cast.
   */
  it("searches every printing, playable or not", async () => {
    picker();

    await userEvent.type(screen.getByLabelText("Search every card"), "bolt");

    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith({
        text: "bolt",
        collapse: false,
        playableOnly: false,
        limit: 50,
        offset: 0,
      }),
    );
  });

  /**
   * **Enter in the search box goes no further than the box.**
   *
   * It shares a panel with a Name field whose Enter *is* a submission — `CreateDeckDialog`
   * passes `DeckSettingsForm.onSubmit` — so a key that travelled from here would make the deck
   * halfway through a card name. Nothing above listens for it today, which is exactly why the
   * guarantee is stated here: a host that wrapped the panel in a `<form>` would get implicit
   * submission from every single-line input in it, this one included, and `preventDefault` on
   * the keydown is what a browser reads as "not that one".
   *
   * Asserted through `fireEvent`'s answer — `false` when a handler prevented the default —
   * because that is the only observable half. jsdom submits nothing, so a test that merely
   * pressed the key would pass just as well against a box with no handler at all.
   */
  it("stops Enter in the search box from meaning anything", () => {
    picker();

    const box = screen.getByLabelText("Search every card");

    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    // And only that key: everything else is a card name being typed.
    expect(fireEvent.keyDown(box, { key: "a" })).toBe(true);
  });

  /** A search that failed says so in words. Silence would read as "nothing matched", which is
   *  the opposite advice: one asks for another word, the other for another try. */
  it("says so when the search fails", async () => {
    searchCards.mockRejectedValue("Database is busy.");
    picker();

    await userEvent.type(screen.getByLabelText("Search every card"), "bolt");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not search the cards — Database is busy.",
    );
    // And it does not also claim the word matched nothing — one sentence per thing that happened.
    expect(screen.queryByText(/No card matches/)).toBeNull();
  });

  /** A word nothing matches is a different answer from a search that failed, and from a deck
   *  with no cards in it. */
  it("says when nothing matched the word", async () => {
    searchCards.mockResolvedValue(page([]));
    picker({ deckCards: [card({ name: "Lightning Bolt" })] });

    await userEvent.type(screen.getByLabelText("Search every card"), "zzzz");

    expect(await screen.findByText(/No card matches “zzzz”\./)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to pick from yet/)).toBeNull();
  });

  /** One page and no pager, so the reader has to be told when the page is not the whole of it. */
  it("says how many matched when more matched than are shown", async () => {
    searchCards.mockResolvedValue(page([found("Shivan Dragon")], 60));
    picker();

    await userEvent.type(screen.getByLabelText("Search every card"), "dragon");

    expect(await screen.findByText(/Showing 1 of 60 matches/)).toBeInTheDocument();
  });

  /** `total` is a floor once the backend stops counting, so it is rendered as one. */
  it("renders a capped total as a floor", async () => {
    searchCards.mockResolvedValue(page([found("Shivan Dragon")], 5000, true));
    picker();

    await userEvent.type(screen.getByLabelText("Search every card"), "a");

    expect(await screen.findByText(/Showing 1 of 5,000\+ matches/)).toBeInTheDocument();
  });

  /**
   * At create there is no deck id, so there is no `/cover/<deckId>` to draw and no bytes to
   * draw from — the picker names the file instead of pretending to a preview.
   */
  it("shows a chosen file's name when there is no deck to upload it against", () => {
    picker({ pendingFileName: "dragon.png", coverCardId: null, coverArtist: null });

    expect(screen.getByText("dragon.png")).toBeInTheDocument();
    expect(screen.queryByText("No cover")).toBeNull();
  });

  /** A pending file is what the deck will wear, so the card art's credit line stands down —
   *  a line crediting an illustrator over a picture nobody can see would credit the wrong one. */
  it("draws no art credit while a file is waiting to be applied", () => {
    picker({ pendingFileName: "dragon.png" });

    expect(screen.queryByText(/Art by/)).toBeNull();
  });

  /** Scryfall's image policy: an `art` crop has no printed frame, so the illustrator is credited
   *  wherever one is shown. */
  it("draws a cover it can credit, with the credit", () => {
    const { container } = picker();

    expect(screen.getByText("Art by Christopher Rush")).toBeInTheDocument();
    expect(
      container.querySelector(`img[src="${cardImageUrl("c-Lightning Bolt", 0, "art")}"]`),
    ).not.toBeNull();
  });

  /** An orphaned cover: `cards` has no row for the printing, so there is no artist — and the
   *  frame says "No cover" rather than claiming a failure. It heals on the next sync. */
  it("draws no cover at all when the artist is unknown", () => {
    const { container } = picker({ coverArtist: null });

    expect(screen.getByText("No cover")).toBeInTheDocument();
    expect(screen.queryByText(/Art by/)).toBeNull();
    expect(
      container.querySelector(`img[src="${cardImageUrl("c-Lightning Bolt", 0, "art")}"]`),
    ).toBeNull();
  });

  /**
   * A custom cover is the reader's own picture served at a route that names the **deck**, so
   * there is no Scryfall artist to credit and none is drawn — while the frame quite properly
   * draws the picture.
   */
  it("draws a custom cover from the URL it was given, uncredited", () => {
    const url = "http://mtgimg.localhost/cover/4";
    const { container } = picker({ coverKind: "custom", customCoverUrl: url });

    expect(container.querySelector(`img[src="${url}"]`)).not.toBeNull();
    expect(screen.queryByText(/Art by/)).toBeNull();
  });

  /** The picker's answer is a **path**, handed straight back to the host — the backend reads
   *  the file, not the webview. */
  it("hands the picked path back to the host", async () => {
    const { onPickFile } = picker();

    await userEvent.click(screen.getByRole("button", { name: "Upload an image…" }));

    await waitFor(() => expect(onPickFile).toHaveBeenCalledWith("C:\\pics\\dragon.png"));
  });
});

/**
 * The in-deck grid's ordering rule, which came here with the function.
 *
 * `DeckSettingsDialog.test.tsx` carried these same three cases while it owned `coverChoices`;
 * they were identical to these, so the move is a deletion there rather than a merge here.
 */
describe("coverChoices", () => {
  /** A commander deck's cover is almost always its commander, and `categoryKind` is what
   *  answers that — the category's *name* is the reader's and may be anything. */
  it("puts the commander first and keeps the read's order otherwise", () => {
    const choices = coverChoices([
      card({ name: "Sol Ring" }),
      card({ name: "Atraxa", categoryKind: "commander" }),
      card({ name: "Swords to Plowshares" }),
    ]);

    expect(choices.map((c) => c.name)).toEqual(["Atraxa", "Sol Ring", "Swords to Plowshares"]);
  });

  /** One printing in two categories is one choice: the picker offers pictures, not rows. */
  it("offers each printing once", () => {
    const choices = coverChoices([
      card({ name: "Sol Ring" }),
      card({ name: "Sol Ring", categoryKind: "side" }),
    ]);

    expect(choices).toHaveLength(1);
  });

  /** An orphan's printing has left `cards`: no art to fetch, no artist to credit, and a cover
   *  the gallery would decline to draw. */
  it("leaves out a row whose printing is gone", () => {
    const choices = coverChoices([
      card({ name: "Sol Ring" }),
      card({ name: "Ghost", needsReview: "This printing left the card database." }),
    ]);

    expect(choices.map((c) => c.name)).toEqual(["Sol Ring"]);
  });
});
