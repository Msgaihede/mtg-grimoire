import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";

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
    subtitle: TREASURE_TEXT,
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
  quantity: 0,
  subtitle: "Colorless 3/3 · Deathtouch",
  setCode: "tsom",
  collectorNumber: "9",
  finishes: '["nonfoil"]',
});
/**
 * **A token nothing in the deck makes** — Oko's emblem, added by hand: `derived: false`, no
 * sources, `manual`. Stepped to **0** on purpose, which is Review Focus 2: a hand-added token at
 * zero is still the reader's, so it stays on the band with its mark and its Remove button — it is
 * only the deck's stacks that leave it out.
 */
const OKO = entry({
  oracleId: "o-oko",
  name: "Oko, Shadowmoor Scion Emblem",
  typeLine: "Emblem — Oko",
  layout: "emblem",
  printingId: "p-tecl-12",
  entryKey: "p-tecl-12:nonfoil",
  quantity: 0,
  sources: [],
  derived: false,
  state: "manual",
  subtitle: null,
  setCode: "tecl",
  collectorNumber: "12",
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
    writes: [],
    setQuantity: vi.fn(),
    swap: vi.fn(),
    addPrinting: vi.fn(),
    remove: vi.fn(),
  } as unknown as DeckTokens;
}

function band(props: Partial<DeckTokensPanelProps> = {}) {
  const callbacks = {
    onToggle: vi.fn(),
    onPick: vi.fn(),
    onAddPrinting: vi.fn(),
  };
  const tokens = props.tokens ?? tokensOf([PLAIN, FOIL, WURM]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <DeckTokensPanel tokens={tokens} open {...callbacks} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { tokens, ...callbacks };
}

const TMOM_PLAIN = `Treasure, ${TREASURE_TEXT}, TMOM · 12, Nonfoil`;
const TMOM_FOIL = `Treasure, ${TREASURE_TEXT}, TMOM · 12, Foil`;
const WURM_NAME = "Wurm, Colorless 3/3 · Deathtouch, TSOM · 9, Nonfoil";
const OKO_NAME = "Oko, Shadowmoor Scion Emblem, TECL · 12, Nonfoil";

/** A tile — the `<li>` holding its picture, its foot and its controls — by the art press's name. */
function tileOf(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name }).closest("li")!;
}

describe("DeckTokensPanel", () => {
  /**
   * **One tile per entry, and no two tiles share a name.** A Treasure kept as a plain and a foil
   * copy of one printing is two tiles over one picture, so the subtitle no longer tells them
   * apart — the printing and the finish do, and `tokenEntryName` spells both into every control.
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

  /**
   * **The tile reads card, controls, subtitle, source — and draws no name line** (issue #615). The
   * picture prints the token's name on the card, so a line repeating it only pushed the controls
   * down; it is gone, the controls come straight after the card and span the tile, and the
   * colour-and-stats line the owner kept on the issue sits under them, the source under that.
   *
   * jsdom lays nothing out, so "full width" is pinned as the structure that produces it: the
   * stepper at `fill` (its group `w-full`, its number box `flex-1`) inside a `flex-1` box that
   * shares one row with Remove printing.
   */
  it("draws the card, then full-width controls, then the subtitle and the source, and no name line", () => {
    band();

    const tile = tileOf(`Change the art for ${TMOM_PLAIN}`);
    // The name is the first term of every control's accessible name, and no line of type.
    expect(within(tile).queryByText("Treasure")).toBeNull();

    const art = within(tile).getByRole("button", { name: `Change the art for ${TMOM_PLAIN}` });
    const stepper = within(tile).getByRole("spinbutton", { name: `Quantity of ${TMOM_PLAIN}` });
    const subtitle = within(tile).getByText(TREASURE_TEXT);
    const source = within(tile).getByText("From Smothering Tithe");
    const precedes = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(precedes(art, stepper)).toBe(true);
    expect(precedes(stepper, subtitle)).toBe(true);
    expect(precedes(subtitle, source)).toBe(true);

    const group = stepper.parentElement!;
    expect(stepper.classList.contains("flex-1")).toBe(true);
    expect(group.classList.contains("w-full")).toBe(true);
    const grows = group.parentElement!;
    expect(grows.classList.contains("flex-1")).toBe(true);
    const remove = within(tile).getByRole("button", { name: `Remove ${TMOM_PLAIN}` });
    expect(remove.parentElement).toBe(grows.parentElement);
  });

  /**
   * Issue #673: an entry at 0 fades its picture and nothing else. Asserted as a pair — faded here,
   * not there — because an `opacity-40` on every frame would pass a one-sided check. Issue #712
   * took it from 60% to 40%.
   */
  it("fades the picture of an entry at zero, and only the picture", () => {
    band();

    const uncounted = screen.getByRole("button", { name: `Change the art for ${WURM_NAME}` });
    const counted = screen.getByRole("button", { name: `Change the art for ${TMOM_PLAIN}` });
    expect(uncounted.hasAttribute("data-token-uncounted")).toBe(true);
    expect(counted.hasAttribute("data-token-uncounted")).toBe(false);
    // The frame is the button's first child: `CardArt`'s own box.
    expect(uncounted.firstElementChild!.classList.contains("opacity-40")).toBe(true);
    expect(counted.firstElementChild!.classList.contains("opacity-40")).toBe(false);

    // The stepper that counts it up is not inside the faded frame.
    const tile = tileOf(`Change the art for ${WURM_NAME}`);
    const stepper = within(tile).getByRole("spinbutton", { name: `Quantity of ${WURM_NAME}` });
    expect(stepper.closest(".opacity-40")).toBeNull();
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

  /** An implicit entry says so in its reference, so Rust knows to materialise it (rule 2) — and
   *  an untouched token reads 0 since managed tokens spec §3.1, so its first `+` writes one. */
  it("hands an implicit entry's reference over as implicit", async () => {
    const { tokens } = band();

    await userEvent.click(screen.getByRole("button", { name: `Increase Quantity of ${WURM_NAME}` }));

    expect(tokens.setQuantity).toHaveBeenCalledWith(
      { oracleId: "o-wurm", cardId: "p-tsom-9", finish: "nonfoil", implicit: true },
      1,
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

  /**
   * **The header draws on a deck that makes nothing**, and says so in words — and since fix round
   * 1, **it still offers Add printing**: a deck whose cards make nothing is the spec's own case
   * for a token added by hand (§1.3, §3.6), and the picker opens on every token in the game for it.
   * What is not drawn is the disclosure (there is no wall to open) or, since managed tokens spec
   * §3.9, a mode control.
   */
  it("keeps the header on a deck that makes no tokens, and offers Add printing there", async () => {
    const { onAddPrinting } = band({ tokens: tokensOf([]), open: false });

    expect(screen.getByText("Nothing in this deck makes a token or an emblem.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: TOKENS_HEADING })).toBeNull();
    expect(screen.queryByRole("group", { name: "Tokens" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add printing" }));
    expect(onAddPrinting).toHaveBeenCalledTimes(1);
  });

  /**
   * **Add printing waits for an answer** — the ruling's `answered && readFailure === null`. A read
   * in flight has no deck to add to yet, and a refused one has already said so in its alert; a
   * button beside either would be a press the band cannot stand behind.
   */
  it("offers no Add printing before the read answers, or when it is refused", () => {
    const pending = {
      ...tokensOf([]),
      query: { data: undefined, isSuccess: false, isError: false, isPending: true, error: null },
    } as unknown as DeckTokens;
    band({ tokens: pending, open: false });
    expect(screen.queryByRole("button", { name: "Add printing" })).toBeNull();
    cleanup();

    const refused = {
      ...tokensOf([]),
      query: {
        data: undefined,
        isSuccess: false,
        isError: true,
        isPending: false,
        error: "Database is busy.",
      },
    } as unknown as DeckTokens;
    band({ tokens: refused, open: false });
    expect(screen.getByRole("alert")).toHaveTextContent("Database is busy.");
    expect(screen.queryByRole("button", { name: "Add printing" })).toBeNull();
  });

  /**
   * **Dismiss, restore, Reset printings and the mode control are gone** (managed tokens spec §3.3,
   * §3.4, §3.9) — every one of them, on a wall holding an entry each of them used to be drawn on:
   * a stored entry (Reset's), an implicit one, and a `hidden` row (the eye and `Show dismissed`).
   */
  it("draws no dismiss, restore, reset, dismissed switch or mode control", () => {
    const hidden = { ...WURM, state: "hidden" as const };
    band({ tokens: tokensOf([PLAIN, FOIL, hidden]) });

    const region = screen.getByRole("region", { name: TOKENS_HEADING });
    for (const gone of [/^Show dismissed/, /^Dismiss /, /^Restore /, /^Reset /]) {
      expect(within(region).queryByRole("button", { name: gone }), String(gone)).toBeNull();
    }
    expect(within(region).queryByRole("group", { name: "Tokens" })).toBeNull();
    for (const word of ["Managed", "Hide", "Collection"]) {
      expect(within(region).queryByRole("button", { name: word }), word).toBeNull();
    }
  });

  /**
   * **A `hidden` row is an ordinary tile, and it counts** (Review Focus 1). The resolver can still
   * answer the word — an older peer can sync a dismissal in after the launch pass that retires it
   * has run — and until the next launch it is a token like any other: on the wall, in the count,
   * with its stepper. Nothing on the band can bring back a token that vanished.
   */
  it("draws a hidden row as an ordinary tile, counted with the rest", () => {
    const hidden = { ...WURM, state: "hidden" as const, quantity: 3, implicit: false };
    band({ tokens: tokensOf([PLAIN, hidden]) });

    const region = screen.getByRole("region", { name: TOKENS_HEADING });
    expect(
      within(region).getByRole("button", { name: `Change the art for ${WURM_NAME}` }),
    ).toBeInTheDocument();
    // Two plain Treasures and three Wurms: the dismissed word takes nothing out of the count.
    expect(within(region).getByText("5 tokens and emblems")).toBeInTheDocument();
  });

  /**
   * **Remove printing on every tile that is an entry the list holds** (managed tokens spec §3.4) —
   * a trash glyph named for its entry, so the plain and the foil Treasure are two presses — and on
   * none that is implicit, because an implicit entry is not stored and there is nothing to delete.
   * A press hands the host the entry's address and nothing else.
   */
  it("draws Remove printing on each stored entry, named for it, and hands the entry over", async () => {
    const { tokens } = band();

    const region = screen.getByRole("region", { name: TOKENS_HEADING });
    expect(
      within(region)
        .getAllByRole("button", { name: /^Remove / })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([`Remove ${TMOM_PLAIN}`, `Remove ${TMOM_FOIL}`]);
    expect(within(region).queryByRole("button", { name: `Remove ${WURM_NAME}` })).toBeNull();

    await userEvent.click(within(region).getByRole("button", { name: `Remove ${TMOM_FOIL}` }));
    expect(tokens.remove).toHaveBeenCalledTimes(1);
    expect(tokens.remove).toHaveBeenCalledWith({
      oracleId: "o-treasure",
      cardId: "p-tmom-12",
      finish: "foil",
      implicit: false,
    });
  });

  /** The pointer's word for the glyph is the spec's, `Remove printing`, whatever the entry. */
  it("says Remove printing under the pointer", async () => {
    band();

    const remove = screen.getByRole("button", { name: `Remove ${TMOM_PLAIN}` });
    fireEvent.pointerEnter(remove);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent("Remove printing");
  });

  /**
   * **A token nothing in the deck makes is marked like a rule-break card — an outline and a
   * badge** (managed tokens spec §3.5). The outline is on the tile's wrapper, since `CardArt` takes
   * no tone, and the chin under it wears `tone="destructive"` so the red runs through the foot; the
   * badge reads `NOT MADE BY DECK`, is `aria-hidden` like every other mark, and its words join the
   * art press's name. A **derived** token wears none of it — `derived`, never `state`, is the test,
   * because a derived token can be `manual` too.
   */
  it("marks a hand-added token with the outline and the badge, and a derived one with neither", () => {
    const derivedManual = entry({
      oracleId: "o-wurm",
      name: "Wurm",
      printingId: "p-tsom-9",
      entryKey: "p-tsom-9:nonfoil",
      subtitle: "Colorless 3/3 · Deathtouch",
      setCode: "tsom",
      collectorNumber: "9",
      state: "manual",
    });
    band({ tokens: tokensOf([PLAIN, derivedManual, OKO]) });

    const oko = tileOf(`Change the art for ${OKO_NAME}, not made by deck`);
    const badge = within(oko).getByText("NOT MADE BY DECK");
    expect(badge).toHaveAttribute("aria-hidden", "true");
    const art = within(oko).getByRole("button", { name: /^Change the art for Oko/ });
    expect(art.parentElement!.classList.contains("ring-destructive")).toBe(true);
    const chin = within(oko).getByText("TECL · 12").parentElement!;
    expect(chin.classList.contains("border-destructive")).toBe(true);

    for (const made of [
      tileOf(`Change the art for ${TMOM_PLAIN}`),
      tileOf(/^Change the art for Wurm/),
    ]) {
      expect(within(made).queryByText("NOT MADE BY DECK")).toBeNull();
      const press = within(made).getByRole("button", { name: /^Change the art for / });
      expect(press.parentElement!.classList.contains("ring-destructive")).toBe(false);
      expect(press).not.toHaveAccessibleName(/not made by deck/);
    }
  });

  /** The badge's own sentence, for the pointer — the spec's words, with the token's name in them. */
  it("says why a hand-added token is marked under the pointer", async () => {
    band({ tokens: tokensOf([OKO]) });

    const badge = screen.getByText("NOT MADE BY DECK");
    fireEvent.pointerEnter(badge);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Nothing in this deck makes Oko, Shadowmoor Scion Emblem. It was added by hand, or kept after the card that made it was cut.",
    );
  });

  /**
   * **Review Focus 2: a hand-added token stepped to 0 stays on the band** — at 0, with its mark
   * and its Remove button, which is the one way to take it off the deck. The pile leaves it out;
   * the band never does.
   */
  it("keeps a hand-added token at zero on the band, marked and removable", () => {
    band({ tokens: tokensOf([OKO]) });

    const region = screen.getByRole("region", { name: TOKENS_HEADING });
    expect(within(region).getByRole("spinbutton", { name: `Quantity of ${OKO_NAME}` })).toHaveValue(0);
    expect(within(region).getByText("NOT MADE BY DECK")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: `Remove ${OKO_NAME}` })).toBeInTheDocument();
    expect(within(region).getByText("Added or kept by hand")).toBeInTheDocument();
  });
});
