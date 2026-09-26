import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM } from "@/lib/cardZoom";
import type { Printing, PrintingsResponse } from "@/lib/ipc";

// `useMarketplace` is the real hook — a tile's chin quotes its finish's price in the currency it
// answers — so its two reads need answers, and `cardPrintings` is the picker's own read.
const cardPrintings = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { cardPrintings, getMarketplace, marketplaceFeedStatus },
}));

import type { DeckTokenView } from "./deckTokens";
import { TokenArtPicker, type TokenArtPickerProps } from "./TokenArtPicker";

const TREASURE_TEXT = "Colorless · {T}, Sacrifice this token: Add one mana of any color.";

/** One entry of one token, as `deckTokens.ts` draws it — every field, the interesting ones named. */
function entry(over: Partial<DeckTokenView> = {}): DeckTokenView {
  return {
    oracleId: "o-treasure",
    name: "Treasure",
    typeLine: "Token Artifact — Treasure",
    layout: "token",
    printingId: "p-tmom-12",
    finish: "nonfoil",
    implicit: false,
    entryKey: "p-tmom-12:nonfoil",
    quantity: 1,
    sources: [{ cardId: "c-tithe", name: "Smothering Tithe" }],
    derived: true,
    state: "auto",
    overridden: true,
    subtitle: TREASURE_TEXT,
    imageUrl: null,
    imageUris: null,
    setCode: "tmom",
    collectorNumber: "12",
    setName: "March of the Machine Tokens",
    rarity: "common",
    finishes: '["nonfoil","foil"]',
    unitPrice: 0.1,
    ...over,
  } as DeckTokenView;
}

/** One printing, with every field `Printing` requires. */
function printing(over: Partial<Printing> & Pick<Printing, "id">): Printing {
  return {
    setCode: "tmom",
    setName: "March of the Machine Tokens",
    collectorNumber: "12",
    releasedAt: "2023-04-21",
    rarity: "common",
    illustrationId: null,
    artist: "Jana Heidersdorf",
    lang: "en",
    finishes: '["nonfoil"]',
    finishPrices: { nonfoil: null, foil: null, etched: null },
    promo: false,
    promoTypes: null,
    fullArt: false,
    frameEffects: null,
    borderColor: null,
    layout: "token",
    ...over,
  };
}

function answer(items: Printing[]): PrintingsResponse {
  return { items, total: items.length };
}

/**
 * Treasure's two printings: one sold in both finishes — listed **foil first** on purpose, so the
 * nonfoil-first order is the picker's and not the fixture's — and one sold only in nonfoil.
 */
const TREASURES = [
  printing({
    id: "p-tmom-12",
    finishes: '["foil","nonfoil"]',
    finishPrices: { nonfoil: 0.1, foil: 1.5, etched: null },
  }),
  printing({
    id: "p-tclb-5",
    setCode: "tclb",
    setName: "Commander Legends Tokens",
    collectorNumber: "5",
    releasedAt: "2022-06-10",
    artist: "Mark Poole",
    finishPrices: { nonfoil: 0.25, foil: null, etched: null },
  }),
];

const WURMS = [
  printing({
    id: "p-tsom-9",
    setCode: "tsom",
    setName: "Scars of Mirrodin Tokens",
    collectorNumber: "9",
    releasedAt: "2010-10-01",
    artist: "Anthony Palumbo",
    finishPrices: { nonfoil: 0.3, foil: null, etched: null },
  }),
];

const WURM = entry({
  oracleId: "o-wurm",
  name: "Wurm",
  printingId: "p-tsom-9",
  entryKey: "p-tsom-9:nonfoil",
  subtitle: "Colorless 3/3 · Deathtouch",
  setCode: "tsom",
  collectorNumber: "9",
});

beforeEach(() => {
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  cardPrintings.mockReset().mockImplementation(async (oracleId: string) => {
    if (oracleId === "o-treasure") return answer(TREASURES);
    if (oracleId === "o-wurm") return answer(WURMS);
    return answer([]);
  });
});

function renderPicker(props: Partial<TokenArtPickerProps> = {}): {
  onPick: ReturnType<typeof vi.fn>;
} {
  const onPick = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactElement = (
    <QueryClientProvider client={client}>
      <TokenArtPicker
        mode={{ kind: "swap", entry: entry() }}
        zoom={DEFAULT_ZOOM}
        onPick={onPick}
        onDismiss={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
  render(node);
  return { onPick };
}

/** Every tile's accessible name, in the order the wall draws them. */
async function tileNames(): Promise<string[]> {
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findAllByRole("button", { name: / — / });
  return within(dialog)
    .getAllByRole("button", { name: / — / })
    .map((b) => b.getAttribute("aria-label") ?? "");
}

/** The tile — the art's button, its chin and its credit — for one accessible name. */
function tileOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("li")!;
}

const TMOM_NONFOIL = "Treasure — TMOM · 12 · 2023, Nonfoil, art by Jana Heidersdorf";
const TMOM_FOIL = "Treasure — TMOM · 12 · 2023, Foil, art by Jana Heidersdorf";
const TCLB_NONFOIL = "Treasure — TCLB · 5 · 2022, Nonfoil, art by Mark Poole";

describe("TokenArtPicker — swap", () => {
  /**
   * **The picker's grain is the printing and the finish** (spec §4.6), the collection wall's own:
   * a printing sold in nonfoil and foil is two tiles, and the finish is in each one's name, so two
   * buttons over one picture never announce one name.
   */
  it("draws a printing sold in two finishes as two tiles, nonfoil first", async () => {
    renderPicker();

    expect(await tileNames()).toEqual([TMOM_NONFOIL, TMOM_FOIL, TCLB_NONFOIL]);
    expect(screen.getByRole("heading", { name: "Art for Treasure" })).toBeInTheDocument();
  });

  /**
   * The foil tile wears `FoilOverlay`'s sheen and says its finish in the chin; the plain tile
   * beside it wears neither — nonfoil is the finish a price is assumed to be, and goes unmarked.
   * Each quotes the price **at its own finish**, which is what makes them two objects.
   */
  it("sheens the foil tile, names its finish and prices each tile at its own finish", async () => {
    renderPicker();
    await tileNames();

    const foil = tileOf(TMOM_FOIL);
    const plain = tileOf(TMOM_NONFOIL);
    expect(foil.querySelector("[data-foil-sheen]")).not.toBeNull();
    expect(plain.querySelector("[data-foil-sheen]")).toBeNull();
    // `FinishMark` in the chin, which states the word through its own `aria-label`.
    expect(within(foil).getAllByRole("img", { name: "Foil" }).length).toBeGreaterThan(0);
    expect(within(plain).queryByRole("img", { name: "Foil" })).toBeNull();
    expect(within(foil).getByText("$1.50")).toBeInTheDocument();
    expect(within(plain).getByText("$0.10")).toBeInTheDocument();
  });

  /**
   * **Current by `(cardId, finish)`, never by the card alone** — an entry that is the foil copy
   * of a printing marks the foil tile and leaves the plain one of the same picture unpressed.
   */
  it("marks the entry's own tile current by printing and finish", async () => {
    renderPicker({
      mode: { kind: "swap", entry: entry({ finish: "foil", entryKey: "p-tmom-12:foil" }) },
    });
    await tileNames();

    expect(screen.getByRole("button", { name: TMOM_FOIL })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: TMOM_NONFOIL })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: TCLB_NONFOIL })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /** A press hands the host the printing **and** the finish — the swap's `to`. */
  it("hands back the printing and the finish on a press", async () => {
    const { onPick } = renderPicker();
    await tileNames();

    await userEvent.click(screen.getByRole("button", { name: TMOM_FOIL }));

    expect(onPick).toHaveBeenCalledWith({ cardId: "p-tmom-12", finish: "foil" });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  /** An etched printing is its own word, as the collection spells it. */
  it("names an etched tile Etched", async () => {
    cardPrintings.mockResolvedValue(
      answer([
        printing({
          id: "p-etched",
          finishes: '["etched"]',
          finishPrices: { nonfoil: null, foil: null, etched: 2 },
        }),
      ]),
    );
    renderPicker();

    expect(await tileNames()).toEqual([
      "Treasure — TMOM · 12 · 2023, Etched, art by Jana Heidersdorf",
    ]);
    expect(tileOf("Treasure — TMOM · 12 · 2023, Etched, art by Jana Heidersdorf").querySelector(
      "[data-foil-sheen]",
    )).not.toBeNull();
  });
});

describe("TokenArtPicker — add", () => {
  /**
   * **Every token the deck has, one read per token** — two entries of Treasure are one token and
   * one `card_printings` call, not two. The picker is titled for the act, since no one token is
   * being repictured.
   */
  it("lists every token's printings, reading each token once", async () => {
    renderPicker({
      mode: {
        kind: "add",
        tokens: [entry(), entry({ finish: "foil", entryKey: "p-tmom-12:foil" }), WURM],
      },
    });

    expect(await tileNames()).toEqual(
      expect.arrayContaining([
        `Treasure — TMOM · 12 · 2023, Nonfoil, art by Jana Heidersdorf`,
        `Treasure — TCLB · 5 · 2022, Nonfoil, art by Mark Poole`,
        `Wurm — TSOM · 9 · 2010, Nonfoil, art by Anthony Palumbo`,
      ]),
    );
    expect(screen.getByRole("heading", { name: "Add a printing" })).toBeInTheDocument();
    expect(cardPrintings.mock.calls.map(([oracleId]) => oracleId).sort()).toEqual([
      "o-treasure",
      "o-wurm",
    ]);
    // Grouped under each token's own name and subtitle, because two tokens can share a name.
    expect(screen.getByRole("list", { name: `Treasure, ${TREASURE_TEXT}` })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Wurm, Colorless 3/3 · Deathtouch" })).toBeInTheDocument();
    // Nothing is current when adding: a press adds, it does not toggle.
    for (const tile of screen.getAllByRole("button", { name: / — / })) {
      expect(tile).not.toHaveAttribute("aria-pressed");
    }
  });

  /** The search box narrows the wall by a token's name, and by a printing's set code. */
  it("filters by token name and by set code", async () => {
    renderPicker({ mode: { kind: "add", tokens: [entry(), WURM] } });
    await tileNames();
    const box = screen.getByRole("searchbox", { name: /find a printing/i });

    await userEvent.type(box, "wurm");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: / — / }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Wurm — TSOM · 9 · 2010, Nonfoil, art by Anthony Palumbo",
      ]),
    );

    await userEvent.clear(box);
    await userEvent.type(box, "TCLB");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: / — / }).map((b) => b.getAttribute("aria-label"))).toEqual([
        TCLB_NONFOIL,
      ]),
    );

    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(await screen.findByText(/No printing matches “zzz”/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: / — / })).toEqual([]);
  });

  /** A press adds that printing **in that finish** — rule 5's two halves. */
  it("hands back the printing and the finish on a press", async () => {
    const { onPick } = renderPicker({ mode: { kind: "add", tokens: [entry(), WURM] } });
    await tileNames();

    await userEvent.click(screen.getByRole("button", { name: TMOM_FOIL }));

    expect(onPick).toHaveBeenCalledWith({ cardId: "p-tmom-12", finish: "foil" });
  });

  /** A read refused for one token says so, and the others' printings are still offered. */
  it("says which token's printings could not be read, and draws the rest", async () => {
    cardPrintings.mockImplementation(async (oracleId: string) => {
      if (oracleId === "o-wurm") throw "Database is busy.";
      return answer(TREASURES);
    });
    renderPicker({ mode: { kind: "add", tokens: [entry(), WURM] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read the printings of Wurm — Database is busy.",
    );
    expect(screen.getByRole("button", { name: TCLB_NONFOIL })).toBeInTheDocument();
  });
});
