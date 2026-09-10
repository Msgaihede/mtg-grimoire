import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardDetail, CardNote } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const cardNotes = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();

/**
 * Every command this overlay's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it and the mocked
 * module is pulled in by the component's own imports, so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal — `OracleTagsDialog.test.tsx` mocks the same module the same way.
 *
 * `ipcError` is not listed and must not be: the spread keeps every real export, and the failure
 * test below asserts the sentence that helper produces.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (cardId: string, marketplace: MarketplaceId) => cardDetail(cardId, marketplace),
    cardNotes: (oracleId: string) => cardNotes(oracleId),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

import { NotesOverlay } from "./NotesOverlay";
import { useAppStore } from "@/lib/store";

/** A card the overlay can name itself after. Only three of its fields are read here — the id, the
 *  name in the subtitle and the oracle id the note read is keyed on — and the rest are filled so
 *  the fixture is a real `CardDetail` rather than a cast. */
function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: "c1",
    oracleId: "o1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    rarity: "common",
    layout: "normal",
    lang: "en",
    manaCost: "{R}",
    cmc: 1,
    typeLine: "Instant",
    oracleText: "Lightning Bolt deals 3 damage to any target.",
    illustrationId: "art-1",
    artist: "Christopher Rush",
    releasedAt: "1993-08-05",
    legalities: null,
    finishPrices: { nonfoil: null, foil: null, etched: null },
    finishes: '["nonfoil"]',
    promoTypes: null,
    imageStatus: "highres_scan",
    faces: [],
    ...over,
  };
}

/** One row of what `card_notes` answers — a note, and the deck it was found in. */
function note(over: Partial<CardNote> = {}): CardNote {
  return { id: 1, deckId: 7, deckName: "Burn", title: "", body: "", ...over };
}

beforeEach(() => {
  cardDetail.mockReset().mockResolvedValue(card());
  // **No notes by default, so every test that wants some has to stage them.** A default that
  // already answered rows would make the empty test below pass for the wrong reason.
  cardNotes.mockReset().mockResolvedValue([]);
  getMarketplace.mockReset().mockResolvedValue(null);
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  // The overlay is driven by two store fields and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/**
 * The overlay with a card open under it and the rail's row pressed — the two store writes a press
 * on `Notes` makes, and nothing else.
 *
 * **The overlay is opened on every render, the last test excepted.** Every read in the component
 * is gated on the open flag, so a test that left it closed would assert `not.toHaveBeenCalled()`
 * about an overlay that was never asked anything — a pass that proves nothing about the oracle id.
 */
function renderWithCard(over: Partial<CardDetail> = {}) {
  cardDetail.mockResolvedValue(card(over));
  useAppStore.setState({ selectedCardId: "c1" });
  useAppStore.getState().openCardOverlay("notes");
  return render(wrap(<NotesOverlay />));
}

it("lists what was written about the card, and names the deck each note was in", async () => {
  // The reason `card_notes` is the one note read that is not deck-scoped, and the reason
  // `CardNote` carries a deck name at all: a card can be in five decks, and prose with no
  // address is prose a reader cannot act on.
  cardNotes.mockResolvedValue([
    note({ id: 1, deckId: 7, deckName: "Burn", title: "Cheapest reach", body: "Three for one." }),
    note({ id: 2, deckId: 9, deckName: "Storm", title: "", body: "Only as a finisher." }),
  ]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText("Cheapest reach")).toBeInTheDocument();
  expect(screen.getByText("Three for one.")).toBeInTheDocument();
  expect(screen.getByText("Only as a finisher.")).toBeInTheDocument();
  expect(screen.getByText("Burn")).toBeInTheDocument();
  expect(screen.getByText("Storm")).toBeInTheDocument();
  // Asked once, with the oracle id and not the printing id: a note attaches across every printing
  // of a card, so a call carrying `c1` would answer nothing for three quarters of the Bolts.
  expect(cardNotes).toHaveBeenCalledExactlyOnceWith("o1");
  // The card names the panel, so a reader who opened two overlays in a row can tell which card
  // this one is about without closing it.
  expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
});

it("says the card has no notes rather than drawing an empty box", async () => {
  // Silence is the failure this whole component is shaped against: an empty panel is a picture
  // the in-flight and failed states also draw, and only one of the three means "there is nothing
  // written about this card".
  cardNotes.mockResolvedValue([]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText(/no notes\./i)).toBeInTheDocument();
  // And it says where one is written, because nothing on this surface writes one.
  expect(screen.getByText(/open a deck that holds it/i)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("says the read failed rather than showing the same emptiness", async () => {
  // `DeckBracket`'s `ComboState` reasoning, one surface over: an empty list and a failed query
  // are pictures of the same nothing and mean opposite things. A reader told *there is nothing
  // here* about a note they know they wrote has been told something false.
  cardNotes.mockRejectedValue("database is busy");
  renderWithCard({ oracleId: "o1" });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not read the notes — database is busy.");
  // The half that would still pass with the failure drawn as an empty list: the empty state's
  // own sentence must be nowhere on screen.
  expect(screen.queryByText(/open a deck that holds it/i)).not.toBeInTheDocument();
});

it("draws a body through the dialect reader rather than printing its markup", async () => {
  // Reading loads no editor — the list, the menu's submenu and this panel all render through the
  // closed AST, and a `**` reaching the screen is the tell that one of them stopped.
  cardNotes.mockResolvedValue([note({ body: "**Fourteen** sources." })]);
  renderWithCard({ oracleId: "o1" });

  const strong = await screen.findByText("Fourteen");
  expect(strong.tagName).toBe("STRONG");
  expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
});

it("draws a link a note cannot be pressed through as ordinary words", async () => {
  // The fence is `noteMarkdown.ts`'s `isOpenable` and this asserts the *pair*, which is the only
  // place it can be asserted: `openExternal` hands its argument straight to the opener, and the
  // renderer trusts every `link` run it is given. A parser that stopped refusing would arm this
  // button with nothing in either file going red on its own. The words survive either way —
  // nothing a reader typed is ever dropped — and only the press is refused.
  // A paren-free href on purpose: the parser's own href pattern is `[^()\s]+`, so
  // `javascript:alert(1)` never reaches `isOpenable` at all — it fails to match as a link and
  // survives as its literal source, which is a different (and also safe) path. This fixture is
  // the one that actually exercises the scheme fence.
  cardNotes.mockResolvedValue([
    note({ id: 1, body: "[Scryfall](https://scryfall.com) and [press me](javascript:danger)" }),
  ]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByRole("button", { name: "Scryfall" })).toBeInTheDocument();
  expect(screen.getByText(/press me/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "press me" })).not.toBeInTheDocument();
});

it("does not ask for notes for a card with no oracle id", async () => {
  renderWithCard({ oracleId: null });

  // Awaited rather than asserted straight after `render`: the note read is downstream of the card
  // read, so a bare synchronous check would pass before the card had even resolved and would go
  // on passing with the guard deleted. Waiting for the sentence this state draws is what puts the
  // component past the point where it would have asked.
  expect(await screen.findByText(/not linked to an oracle card/i)).toBeInTheDocument();
  expect(cardNotes).not.toHaveBeenCalled();
});

it("asks nothing at all until the overlay is opened", async () => {
  // What lets `App` mount this beside the card modal unconditionally: an overlay nobody opened
  // costs no query. Only the overlay field differs from `renderWithCard`.
  useAppStore.setState({ selectedCardId: "c1" });
  render(wrap(<NotesOverlay />));

  await Promise.resolve();
  expect(cardDetail).not.toHaveBeenCalled();
  expect(cardNotes).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
