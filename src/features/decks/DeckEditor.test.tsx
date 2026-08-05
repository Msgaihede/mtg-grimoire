import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { DeckCard, DeckDetail, DeckRow, FormatSpec } from "@/lib/ipc";
import { card, resetRowIds, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckGet, deckUpdate, deckSetCardQuantity, deckMoveCard, formatSpecs },
}));

import { DeckEditor } from "./DeckEditor";
import { useAppStore } from "@/lib/store";

const DECK: DeckRow = {
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: null,
  coverArtist: null,
  isBuilt: false,
  archived: false,
  cardCount: 6,
  updatedAt: 1_800_000_000,
};

/** The picker, as `format_specs` serves it — every enabled row in `sort_order`. */
const PICKER: FormatSpec[] = [spec("modern"), spec("commander"), spec("gladiator"), spec("casual")];

function detail(deck: Partial<DeckRow>, cards: DeckCard[]): DeckDetail {
  return { deck: { ...DECK, ...deck }, cards };
}

function bolt(overrides: Partial<DeckCard> = {}): DeckCard {
  return card({
    name: "Lightning Bolt",
    typeLine: "Instant",
    quantity: 4,
    unitPriceUsd: 4.5,
    ownedQuantity: 3,
    ...overrides,
  });
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The editor, rendered and waited for — every test starts from a deck on screen. */
async function open() {
  const view = wrap(<DeckEditor deckId={4} />);
  await screen.findByLabelText("Deck name");
  return view;
}

beforeEach(() => {
  resetRowIds();
  useAppStore.setState({ openDeckId: 4, selectedCardId: null });
  deckGet.mockReset().mockResolvedValue(detail({}, [bolt(), card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 })]));
  deckUpdate.mockReset().mockResolvedValue(DECK);
  deckSetCardQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 0, removed: true });
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
});

describe("DeckEditor", () => {
  /** The header is the deck: what it is called, what it is for, and whether it is sleeved up. */
  it("heads the editor with the deck's name, format and build state", async () => {
    await open();

    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
    expect(screen.getByLabelText("Format")).toHaveValue("modern");
    const built = screen.getByRole("button", { name: /^Built/ });
    expect(built).toHaveAttribute("aria-pressed", "false");
    expect(built).toHaveAttribute("title", "Reserves your copies for this deck");
  });

  /** The caret starts in the editor rather than on `<body>`: the gallery's New deck button —
   *  which is what had it — unmounts the moment this view takes over. */
  it("takes the caret when it opens", async () => {
    await open();

    await waitFor(() =>
      expect(screen.getByRole("region", { name: /deck editor: burn/i })).toHaveFocus(),
    );
  });

  /** The way back, and the only thing that closes the editor. */
  it("returns to the gallery from the back control", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /back to decks/i }));

    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /** There is no Save: the row in the database *is* the draft, so a name is committed the
   *  moment the reader is done with the field. */
  it("renames the deck when the name field is left", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday burn");
    await userEvent.tab();

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunday burn" }));
  });

  it("renames the deck on Enter without waiting for the caret to leave", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.type(screen.getByLabelText("Deck name"), "Sunday burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunday burn" }));
  });

  /**
   * Escape puts the name back and writes nothing — and it consumes the press, so the card
   * pane docked beside the editor does not close on the same key. The pane is an `"outer"`
   * layer listening in the bubble phase; a field that handles Escape at its own target runs
   * first and `preventDefault()` is the whole handshake.
   */
  it("reverts a half-typed name on Escape, without writing and without letting the press through", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday");
    const press = fireEvent.keyDown(name, { key: "Escape" });

    expect(press).toBe(false); // preventDefault() was called
    expect(name).toHaveValue("Burn");
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /** A blank name is not a rename — the backend refuses it in words, and the field should not
   *  have to be told twice. */
  it("keeps the old name when the field is emptied", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.tab();

    expect(deckUpdate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
  });

  it("re-formats the deck from the header select", async () => {
    await open();

    await userEvent.selectOptions(screen.getByLabelText("Format"), "commander");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { formatKey: "commander" }));
  });

  /** Built is the one switch with a consequence outside this deck, so it says what it does. */
  it("marks the deck built", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { isBuilt: true }));
  });

  /** The seeded rules drive the chrome: Modern has a sideboard and no commander. */
  it("draws the zones the format has, and not the ones it does not", async () => {
    await open();

    expect(screen.getByRole("region", { name: /^Main deck/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^Sideboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Commander/ })).not.toBeInTheDocument();
  });

  /** Commander has a commander zone and no sideboard at all — the same data, read the other
   *  way. */
  it("draws a commander zone and no sideboard for a commander deck", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "commander", formatName: "Commander" }, []));

    await open();

    expect(await screen.findByRole("region", { name: /^Commander/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Sideboard/ })).not.toBeInTheDocument();
  });

  /**
   * The rule that keeps a re-format from hiding cards: a zone the format does not have is
   * still drawn while something is in it, or the copies would be invisible *and* unreachable
   * — they would still count, and nothing on screen would say why.
   */
  it("keeps drawing a zone the format has no use for while cards are still in it", async () => {
    deckGet.mockResolvedValue(
      detail({}, [card({ name: "Kenrith", zone: "commander", typeLine: "Legendary Creature" })]),
    );

    await open();

    const zone = await screen.findByRole("region", { name: /^Commander/ });
    expect(within(zone).getByRole("button", { name: "Kenrith" })).toBeInTheDocument();
  });

  /** Two ways to read the same list, and the deck decides which one answers the question in
   *  front of you. */
  it("regroups the deck by mana value on request", async () => {
    await open();

    expect(screen.getByRole("list", { name: "Instant" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mana value" }));

    expect(screen.getByRole("list", { name: "Mana value 1" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Instant" })).not.toBeInTheDocument();
  });

  /**
   * Zero removes, and it is `deck_set_card_quantity` that does it — never a `−1` through
   * `deck_add_card`, which refuses the orphaned rows a reader most needs to be able to clear.
   */
  it("removes a row when its stepper reaches zero", async () => {
    deckGet
      .mockResolvedValueOnce(detail({}, [bolt({ quantity: 1 })]))
      .mockResolvedValue(detail({}, []));

    await open();
    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "c-Lightning Bolt", "main", 0);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Lightning Bolt" })).not.toBeInTheDocument(),
    );
  });

  /** A row opens the card in the pane the app already docks; the stepper on it does not. */
  it("opens the card from a row, and not from its stepper", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
    expect(useAppStore.getState().selectedCardId).toBe("c-Lightning Bolt");

    useAppStore.setState({ selectedCardId: null });
    await userEvent.click(screen.getByRole("button", { name: /increase copies of lightning bolt/i }));
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** The click path a move needs before drag exists — and the one it keeps afterwards. */
  it("moves a card between zones from the row's menu", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Sideboard" }));

    expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", "main", "side");
  });

  it("picks the deck's cover from a row", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(screen.getByRole("button", { name: "Set as cover" }));

    await waitFor(() =>
      expect(deckUpdate).toHaveBeenCalledWith(4, { coverCardId: "c-Lightning Bolt" }),
    );
  });

  /**
   * Escape closes the layer that is open and stops there. The editor is a *view*, not a
   * dismissible layer — the back control is the only way out of it — so the deck is still on
   * screen afterwards and the caret is back on the control that opened the menu.
   */
  it("closes an open row menu on Escape and leaves the editor where it was", async () => {
    await open();
    const trigger = screen.getByRole("button", { name: "More actions for Lightning Bolt" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: /lightning bolt/i });

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * The half of the Escape protocol a component test would never think to check, and the
   * running app found in a minute: with no layer open, the press has to reach the **window**,
   * because that is where the card detail pane listens.
   *
   * React's synthetic `stopPropagation` stops the *native* event at the root container — so a
   * cell that stops `keydown` to keep Enter off its row (the collection table does exactly
   * that) also stops every Escape pressed inside it from ever leaving the app's own tree. The
   * pane then cannot be closed from a stepper or a menu trigger at all, and nothing on screen
   * says why.
   */
  it("lets Escape through to the card pane when no layer of its own is open", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    screen.getByLabelText("Copies of Lightning Bolt in Main deck").focus();
    await userEvent.keyboard("{Escape}");
    screen.getByRole("button", { name: "More actions for Lightning Bolt" }).focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    // Heard both times, and consumed by nothing: the pane's bubble-phase listener acts on
    // exactly this.
    expect(heard).toEqual([false, false]);
  });

  /**
   * The binding pattern: the menu's controls disable themselves on the press, a browser
   * blurs a disabled control with no `relatedTarget`, and the click-away handler would read
   * that as the reader leaving — closing the menu as if the write had worked. jsdom will not
   * produce that blur on its own, so it is dispatched directly.
   */
  it("keeps the row menu open while the write it started is in flight", async () => {
    let refuse!: (reason: string) => void;
    deckUpdate.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );

    await open();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(screen.getByRole("button", { name: "Set as cover" }));
    const menu = screen.getByRole("dialog", { name: /lightning bolt/i });

    fireEvent.focusOut(menu, { relatedTarget: null });

    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

    refuse("The database is busy with a sync — try again in a moment.");

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });

  /** The scratchpad: kept, counted by nothing, and out of the way until it is wanted. */
  it("keeps the maybe pile collapsed under the columns", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt({ zone: "maybe", quantity: 3 })]));

    await open();

    expect(screen.queryByRole("button", { name: "Lightning Bolt" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /^Maybe/ }));

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /** Spec §5: a price is never shown without saying how old it is. */
  it("says how old its prices are", async () => {
    await open();

    expect(screen.getByText("Prices as of the last card-data sync.")).toBeInTheDocument();
  });

  /** A deck deleted from another view is a deck the editor is holding a ghost of. It says so
   *  and offers the way back rather than throwing. */
  it("says so when the deck is not there any more", async () => {
    deckGet.mockResolvedValue(null);

    wrap(<DeckEditor deckId={4} />);

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to decks/i })).toBeInTheDocument();
  });

  /**
   * Every write goes through `touch_deck`, which answers "That deck is not there any more."
   * when the deck has been deleted under the reader. So a refused write re-reads the deck —
   * and the read is what decides whether this is a busy database or a deck that is gone.
   */
  it("re-reads the deck when a write is refused, and lands on the gone message if it is", async () => {
    deckSetCardQuantity.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
  });

  /** A refused write is said in the app's own words, where the reader is looking. */
  it("says so when a write is refused", async () => {
    deckMoveCard.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    await open();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Sideboard" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });
});
