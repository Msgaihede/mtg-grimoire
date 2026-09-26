import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `useMarketplace` is the real hook — every tile's foot quotes its entry's price in the currency
// it answers — so its two reads need answers or they sit rejected for the life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { getMarketplace, marketplaceFeedStatus },
}));

import type { DeckTokenRow, DeckTokenView } from "./deckTokens";
import { DeckTokensPanel, TOKENS_HEADING, type DeckTokensPanelProps } from "./DeckTokensPanel";
import type { DeckTokens } from "./useDeckTokens";

afterEach(cleanup);

beforeEach(() => {
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

const TREASURE_TEXT = "Colorless · {T}, Sacrifice this token: Add one mana of any color.";

/** One entry of one token, as `deckTokens.ts` draws it. */
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
    quantity: 2,
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

/** Treasure kept in one printing, in both of its finishes — two entries, one picture. */
const PLAIN = entry();
const FOIL = entry({ finish: "foil", entryKey: "p-tmom-12:foil", quantity: 1, unitPrice: 1.5 });
const WURM = entry({
  oracleId: "o-wurm",
  name: "Wurm",
  printingId: "p-tsom-9",
  entryKey: "p-tsom-9:nonfoil",
  finish: "nonfoil",
  implicit: true,
  overridden: false,
  quantity: 1,
  subtitle: "Colorless 3/3 · Deathtouch",
  setCode: "tsom",
  collectorNumber: "9",
  finishes: '["nonfoil"]',
});

/**
 * The hook's answer, by hand: the rows the band counts from and the views it draws, and every
 * write as a spy. The rows default to one per view — the resolver answers one row per entry.
 */
function tokensOf(
  views: DeckTokenView[],
  rows: Pick<DeckTokenRow, "oracleId" | "state">[] = views.map((v) => ({
    oracleId: v.oracleId,
    state: v.state,
  })),
): DeckTokens {
  return {
    query: { data: rows, isSuccess: true, isError: false, isPending: false, error: null },
    tokens: views,
    loading: false,
    failure: null,
    showDismissed: false,
    setShowDismissed: vi.fn(),
    setQuantity: vi.fn(),
    swap: vi.fn(),
    addPrinting: vi.fn(),
    dismiss: vi.fn(),
    restore: vi.fn(),
    reset: vi.fn(),
  } as unknown as DeckTokens;
}

function band(props: Partial<DeckTokensPanelProps> = {}) {
  const callbacks = {
    onToggle: vi.fn(),
    onPick: vi.fn(),
    onAddPrinting: vi.fn(),
    onMode: vi.fn(),
  };
  const tokens = props.tokens ?? tokensOf([PLAIN, FOIL, WURM]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeckTokensPanel tokens={tokens} open mode="managed" {...callbacks} {...props} />
    </QueryClientProvider>,
  );
  return { tokens, ...callbacks };
}

const TMOM_PLAIN = `Treasure, ${TREASURE_TEXT}, TMOM · 12, Nonfoil`;
const TMOM_FOIL = `Treasure, ${TREASURE_TEXT}, TMOM · 12, Foil`;
const WURM_NAME = "Wurm, Colorless 3/3 · Deathtouch, TSOM · 9, Nonfoil";

describe("DeckTokensPanel", () => {
  /**
   * **One tile per entry, and no two tiles share a name.** A Treasure kept as a plain and a foil
   * copy of one printing is two tiles over one picture, so the subtitle no longer tells them
   * apart — the printing and the finish do, and `tileName` spells both into every control.
   *
   * The keys are the entries' too: keyed on the oracle id, the two Treasures would be one React
   * child twice, which React reports and then draws wrong.
   */
  it("draws one tile per entry, each control named by its printing and finish", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    band();

    const region = screen.getByRole("region", { name: TOKENS_HEADING });
    const arts = within(region)
      .getAllByRole("button", { name: /^Change the art for / })
      .map((b) => b.getAttribute("aria-label"));
    expect(arts).toEqual([
      `Change the art for ${TMOM_PLAIN}`,
      `Change the art for ${TMOM_FOIL}`,
      `Change the art for ${WURM_NAME}`,
    ]);
    const steppers = within(region)
      .getAllByRole("spinbutton")
      .map((s) => s.getAttribute("aria-label"));
    expect(steppers).toEqual([
      `Quantity of ${TMOM_PLAIN}`,
      `Quantity of ${TMOM_FOIL}`,
      `Quantity of ${WURM_NAME}`,
    ]);
    // Every control on the wall, not just the two above: no name twice.
    const names = within(region)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((n): n is string => n !== null);
    expect(new Set(names).size).toBe(names.length);

    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("same key")),
    ).toBe(false);
    errors.mockRestore();
  });

  /** The foil entry's picture wears the sheen; the plain copy of the same printing does not. */
  it("draws each entry's own finish on its picture", () => {
    band();

    const foil = screen.getByRole("button", { name: `Change the art for ${TMOM_FOIL}` });
    const plain = screen.getByRole("button", { name: `Change the art for ${TMOM_PLAIN}` });
    expect(foil.querySelector("[data-foil-sheen]")).not.toBeNull();
    expect(plain.querySelector("[data-foil-sheen]")).toBeNull();
  });

  /** A stepper writes **its** entry — `entryRef`'s four facts — and never the token's other one. */
  it("steps the entry the stepper is drawn for", async () => {
    const { tokens } = band();

    await userEvent.click(screen.getByRole("button", { name: `Increase Quantity of ${TMOM_FOIL}` }));

    expect(tokens.setQuantity).toHaveBeenCalledWith(
      { oracleId: "o-treasure", cardId: "p-tmom-12", finish: "foil", implicit: false },
      2,
    );
    expect(tokens.setQuantity).toHaveBeenCalledTimes(1);
  });

  /** An implicit entry says so in its reference, so Rust knows to materialise it (rule 2). */
  it("hands an implicit entry's reference over as implicit", async () => {
    const { tokens } = band();

    await userEvent.click(screen.getByRole("button", { name: `Increase Quantity of ${WURM_NAME}` }));

    expect(tokens.setQuantity).toHaveBeenCalledWith(
      { oracleId: "o-wurm", cardId: "p-tsom-9", finish: "nonfoil", implicit: true },
      2,
    );
  });

  /** A press on the picture hands the host the view — the host opens the picker on that entry. */
  it("hands the pressed entry's view to onPick", async () => {
    const { onPick } = band();

    await userEvent.click(screen.getByRole("button", { name: `Change the art for ${TMOM_FOIL}` }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe(FOIL);
  });

  /**
   * **Add printing is in the header**, beside the count, and it opens a shut band as it is
   * pressed — the Notes band's `New note` rule: a printing added into a region the reader cannot
   * see is answered by nothing but a number moving.
   */
  it("offers Add printing in the header, and opens a shut band with the press", async () => {
    const { onAddPrinting, onToggle } = band({ open: false });

    // The wall is shut, so no tile — but the header's controls are all there.
    expect(screen.queryByRole("button", { name: /^Change the art for / })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add printing" }));

    expect(onAddPrinting).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  /** An open band is left alone — the press is the picker's, and nothing needs opening. */
  it("does not toggle an open band on Add printing", async () => {
    const { onAddPrinting, onToggle } = band({ open: true });

    await userEvent.click(screen.getByRole("button", { name: "Add printing" }));

    expect(onAddPrinting).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  /** The mode control is the header's, and a press writes the column's word through the host. */
  it("draws the mode control in the header and reports a press", async () => {
    const { onMode } = band({ open: false, mode: "managed" });

    const group = screen.getByRole("group", { name: "Tokens" });
    expect(within(group).getByRole("button", { name: "Managed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(group).getByRole("button", { name: "Hide" }));

    expect(onMode).toHaveBeenCalledWith("hidden");
  });

  /**
   * **The header draws on a deck that makes nothing**, mode control and all — the mode is a
   * question about the deck, so a reader can set it before the deck makes its first token. What
   * is *not* drawn is Add printing: there is no token to add a printing of, and a control that
   * spends the whole deck refusing is the band's own argument against a greyed one.
   */
  it("keeps the header and its mode control on a deck that makes no tokens", () => {
    band({ tokens: tokensOf([]), mode: "hidden" });

    expect(screen.getByText("Nothing in this deck makes a token or an emblem.")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Tokens" });
    expect(within(group).getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Add printing" })).toBeNull();
    expect(screen.queryByRole("button", { name: TOKENS_HEADING })).toBeNull();
  });

  /**
   * **A dismissal is counted once per token, not once per entry.** The rows are one per entry
   * now, so a Treasure dismissed with two printings is two hidden rows — and one token the switch
   * offers to show.
   */
  it("counts a dismissed token once however many entries it has", () => {
    band({
      tokens: tokensOf(
        [WURM],
        [
          { oracleId: "o-treasure", state: "hidden" },
          { oracleId: "o-treasure", state: "hidden" },
          { oracleId: "o-wurm", state: "auto" },
        ],
      ),
    });

    expect(
      screen.getByRole("button", { name: "Show dismissed, 1 token or emblem" }),
    ).toBeInTheDocument();
  });
});
