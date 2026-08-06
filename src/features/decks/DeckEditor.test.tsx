import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardSummary, DeckCard, DeckDetail, DeckRow, FormatSpec } from "@/lib/ipc";
import { dragOnto, startDrag } from "@/test-drag";
import { card, resetRowIds, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
// The docked search panel is the editor's own filter bar, set picker and result wall.
const searchCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckUpdate,
    deckSetCardQuantity,
    deckMoveCard,
    deckAddCard,
    deckMissingToWishlist,
    formatSpecs,
    searchCards,
    listSets,
  },
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

/** One search result, for the tests that drive the docked panel. */
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
    priceUsd: 1.5,
    layout: "normal",
    oracleId: `o-${name}`,
    finishes: `["nonfoil"]`,
    ownedQuantity: 0,
    wishlisted: false,
  };
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

/**
 * jsdom lays nothing out, so the docked panel's virtualised wall measures a scroll container
 * of zero height and renders no tiles at all. One number is the whole of what it is missing;
 * `scrollTo` is the other thing the virtualiser reaches for that jsdom does not implement.
 *
 * Put back afterwards: these are patches to a *global* prototype, and a file that leaves one
 * behind is a file that decides how the next one measures the DOM.
 */
const patched: [string, PropertyDescriptor | undefined][] = [];
function patch(name: string, descriptor: PropertyDescriptor) {
  patched.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
}

beforeAll(() => {
  patch("offsetHeight", { value: 600 });
  patch("scrollTo", { value: vi.fn() });
});

afterAll(() => {
  for (const [name, original] of patched.reverse()) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

/**
 * Pretend the editor's desk is `px` wide for the duration of one test.
 *
 * jsdom measures every element at zero, which the editor reads as "not measured yet" and
 * therefore as room — so the narrow case cannot be reached without saying how wide things are.
 * `clientWidth` is what the desk is measured with, since the `ResizeObserver` in `test-setup`
 * is a no-op.
 */
function desk(px: number) {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  return () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (original && !Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")) {
      Object.defineProperty(Element.prototype, "clientWidth", original);
    }
  };
}

beforeEach(() => {
  resetRowIds();
  useAppStore.setState({ openDeckId: 4, selectedCardId: null });
  deckGet
    .mockReset()
    .mockResolvedValue(
      detail({}, [bolt(), card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 })]),
    );
  deckUpdate.mockReset().mockResolvedValue(DECK);
  deckSetCardQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 0, removed: true });
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  deckAddCard.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  deckMissingToWishlist.mockReset().mockResolvedValue(3);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  // Nothing found by default: a result named after a card already in the deck would be a
  // second button by that name, and every test here addresses rows by the card's name.
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  listSets.mockReset().mockResolvedValue([]);
});

describe("DeckEditor", () => {
  /** The header is the deck: what it is called, what it is for, and whether it is sleeved up. */
  it("heads the editor with the deck's name, format and build state", async () => {
    await open();

    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
    expect(screen.getByLabelText("Deck format")).toHaveValue("modern");
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
   * Enter commits and then blurs, and the blur handler commits too — in the same tick, off a
   * draft the first call had already decided to send. Two identical `deck_update`s for one
   * press, which the assertion above cannot see because it matches arguments rather than
   * counting calls.
   */
  it("writes one rename for one press of Enter", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.type(screen.getByLabelText("Deck name"), "Sunday burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledTimes(1));
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

    await userEvent.selectOptions(screen.getByLabelText("Deck format"), "commander");

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

  /**
   * The deck builder opens as **cards**: it is the one surface in the app whose whole subject
   * is what the cards are, and the user asked for it in those words. The switch beside the
   * grouping says what pressing it does, never where you are.
   */
  it("opens the deck as cards", async () => {
    await open();

    expect(screen.getByAltText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show as list" })).toBeInTheDocument();
  });

  /**
   * And the dense rows are one press away, for the reader comparing prices and collector
   * numbers — which is the whole reason the text list stays.
   */
  it("switches to the compact list and back", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Show as list" }));

    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    // The two facts the dense rows exist for, and the two the cards leave to this list.
    expect(screen.getAllByText("LEA · 161")).toHaveLength(2);
    expect(screen.getByText("$4.50")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show as cards" }));

    expect(screen.getByAltText("Lightning Bolt")).toBeInTheDocument();
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

  /**
   * The stepper is controlled by the cache, so a press before the last answer would be
   * computed from the number the last press was computed from: hold `+` on a 4-of and three
   * presses all read 4, all send 5, and the deck lands on 5 instead of 7. The optimistic patch
   * is what makes the second press know about the first — `CollectionPage`'s fix and
   * `WishlistPage`'s, in the third place that needed it.
   */
  it("computes a held-down stepper from the press before it, not from the cache", async () => {
    // Never answers: the only thing that can move the second press's number is the guess.
    deckSetCardQuantity.mockReturnValue(new Promise(() => {}));
    await open();

    const up = screen.getByRole("button", { name: /increase copies of lightning bolt/i });
    await userEvent.click(up);
    await userEvent.click(up);
    await userEvent.click(up);

    expect(deckSetCardQuantity.mock.calls.map((c) => c[3])).toEqual([5, 6, 7]);
  });

  /**
   * And the guess is rolled back when the write is refused — zero *removes* here, so a
   * refusal that stayed on screen would be a card silently gone from the deck.
   *
   * The re-read that a refusal also triggers is left hanging on purpose: it would put the row
   * back by itself, and a test that cannot tell the rollback from the refetch is a test that
   * passes with no rollback at all.
   */
  it("puts a refused removal back before the re-read answers", async () => {
    deckSetCardQuantity.mockRejectedValue("The database is busy with a sync — try again.");
    deckGet
      .mockResolvedValueOnce(detail({}, [bolt({ quantity: 1 })]))
      .mockReturnValue(new Promise(() => {}));

    await open();
    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /** The row the caret was on leaves with the last copy. The zone it left is where the reader
   *  is looking, and it announces its own new count — the hand-off a move makes. */
  it("hands the caret to the zone when a row is stepped away", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt({ quantity: 1 })]));

    await open();
    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(screen.getByRole("region", { name: /^Main deck/ })).toHaveFocus();
  });

  /** A row opens the card in the pane the app already docks; the stepper on it does not. */
  it("opens the card from a row, and not from its stepper", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
    expect(useAppStore.getState().selectedCardId).toBe("c-Lightning Bolt");

    useAppStore.setState({ selectedCardId: null });
    await userEvent.click(
      screen.getByRole("button", { name: /increase copies of lightning bolt/i }),
    );
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
    // The name field is the third way in, and the one that *does* consume a press — but only
    // while it is holding something to revert.
    screen.getByLabelText("Deck name").focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    // Heard every time, and consumed by nothing: the pane's bubble-phase listener acts on
    // exactly this.
    expect(heard).toEqual([false, false, false]);
  });

  /**
   * The other side of it: a field that has been typed in owns one press, and one only. The
   * second is the pane's again — otherwise a reader who half-typed a name and pressed Escape
   * twice would find the second press had gone nowhere, with the pane still open beside them
   * and nothing on screen to say why.
   */
  it("spends exactly one Escape on reverting the name", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday");
    // Back to back in one tick, which is what a held key sends: `fireEvent` answers `false`
    // when the press was consumed. Read off the state rather than the ref, the second press
    // sees a draft React has not cleared yet and eats a press it has nothing to spend.
    const first = fireEvent.keyDown(name, { key: "Escape" });
    const second = fireEvent.keyDown(name, { key: "Escape" });

    expect([first, second]).toEqual([false, true]);
    expect(name).toHaveValue("Burn");
    expect(deckUpdate).not.toHaveBeenCalled();
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

  /**
   * A trigger with `aria-expanded` has to be able to close what it opened. It nearly cannot:
   * pressing it blurs the panel *first*, and a blur-away handler that does not know the
   * trigger closes the menu — after which the press opens it again, forever.
   */
  it("closes the row menu from the control that opened it", async () => {
    await open();
    const trigger = screen.getByRole("button", { name: "More actions for Lightning Bolt" });

    await userEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

    await userEvent.click(trigger);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * A deck deleted under an open menu takes the menu's row with it. The state that says one is
   * open does not go on its own — and an `"inner"` layer nothing draws is a layer that eats
   * the first Escape of whatever the reader does next.
   */
  it("closes an open row menu when the deck turns out to be gone", async () => {
    deckSetCardQuantity.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([false]);
  });

  /**
   * The path by which cards enter a deck. Docked rather than a dialog, so the deck it is
   * filling stays on screen next to it.
   */
  it("docks a card search beside the deck and adds what it finds", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", "main", 1);
  });

  /** The same seeded rules that decide which columns are drawn decide where a card may land:
   *  a Modern deck is never offered a commander zone to add to. */
  it("offers only the zones this format has as add targets", async () => {
    await open();

    const select = (await screen.findByLabelText("Add to")) as HTMLSelectElement;
    // Modern's seeded row has a sideboard and allows a companion, and has no commander zone —
    // the same four the row menus offer as move targets, from the same derivation.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Main deck",
      "Sideboard",
      "Companion",
      "Maybe",
    ]);
    expect([...select.options].map((o) => o.textContent)).not.toContain("Commander");
  });

  /**
   * A re-format can take the add target away — Commander has no sideboard at all — and a
   * select left holding a zone that is not among its own options shows nothing selected while
   * every press files a card somewhere the editor is not drawing.
   */
  it("falls back to the main deck when a re-format takes the add target away", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.selectOptions(await screen.findByLabelText("Add to"), "side");
    await screen.findByRole("button", { name: "Add Goblin Guide to Sideboard" });

    deckGet.mockResolvedValue(detail({ formatKey: "commander", formatName: "Commander" }, []));
    await userEvent.selectOptions(screen.getByLabelText("Deck format"), "commander");

    // Read off the Add button rather than off the select, because the select cannot see this
    // bug: HTML selects the first option when the selected one is removed, so the control
    // *shows* "Main deck" whatever the state behind it says. Without the reset, every press
    // would still file its card into a sideboard this format does not have and the editor is
    // no longer drawing.
    expect(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
    ).toBeInTheDocument();
  });

  /** The scratchpad is shut by default, and a card added into a closed drawer is a card that
   *  has vanished — the same hand-off a move into it makes. */
  it("opens the maybe pile when it becomes the add target", async () => {
    await open();

    await userEvent.selectOptions(await screen.findByLabelText("Add to"), "maybe");

    expect(screen.getByRole("region", { name: /^Maybe/ })).toBeInTheDocument();
  });

  /**
   * Three docked columns do not fit in a 1024px window — sidebar, page padding, the card pane
   * and the panel come to 1044 before the deck gets a pixel — and the deck was measured at
   * **2px** before this existed, which reads as a rendering fault rather than as a squeeze.
   * The narrowest thing gives way first, which is the rule the zone columns already follow.
   *
   * 376 is what a 1024px window leaves this row with the card pane docked beside the view
   * (measured at 361 once the page's own scrollbar is out); 604 is `DECK_FLOOR` plus the panel
   * and its gap — the exact width at which all three fit again, so the pair of tests pins the
   * floor to the pixel.
   */
  it("falls back to the rail when the deck and the panel cannot both fit", async () => {
    const restore = desk(376);
    try {
      await open();

      const rail = await screen.findByRole("button", { name: "Search cards" });
      expect(rail).toHaveAttribute("aria-expanded", "false");
      // Not a control that records an intention and moves nothing: there is no width for what
      // it would open, and it says so rather than doing nothing.
      expect(rail).toHaveAttribute("aria-disabled", "true");
      expect(rail).toHaveAttribute("title", expect.stringMatching(/not enough room/i));
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("draws the panel at the width where the deck still clears its floor", async () => {
    const restore = desk(604);
    try {
      await open();

      expect(await screen.findByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search cards" })).not.toHaveAttribute(
        "aria-disabled",
      );
    } finally {
      restore();
    }
  });

  /** And one pixel under it is the rail — the floor is a number, not a feeling. */
  it("gives way one pixel below that", async () => {
    const restore = desk(603);
    try {
      await open();

      expect(await screen.findByRole("button", { name: "Search cards" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  /**
   * The panel is a fixture of the editor, not a dismissible layer: Escape pressed in its
   * search box belongs to the card pane, which listens on `window` in the bubble phase. A
   * panel that consumed the press would leave a card pinned open with nothing to close it.
   */
  it("lets Escape through from the docked search panel", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    screen.getByRole("searchbox", { name: "Search cards" }).focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([false]);
  });

  /** The scratchpad: kept, counted by nothing, and out of the way until it is wanted. */
  it("keeps the maybe pile collapsed under the columns", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt({ zone: "maybe", quantity: 3 })]));

    await open();

    expect(screen.queryByRole("button", { name: "Lightning Bolt" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /^Maybe/ }));

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * The readout layer, over the same rows the columns are drawn from: one query, so the curve
   * and the format check can never disagree about what is in the deck.
   */
  it("adds up the deck under the header", async () => {
    await open();

    // Four Bolts and two Bears, both nonlands, both mana value 1.
    expect(screen.getByText("Cards").nextElementSibling).toHaveTextContent("6");
    const curve = screen.getByRole("list", { name: "Mana curve" });
    expect(within(curve).getByText("6 cards at mana value 1")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Card types" })).toBeInTheDocument();
  });

  /** Six cards is not a Modern deck, and the chip says so before it is opened. */
  it("counts the format's findings on a chip in the header", async () => {
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));

    expect(
      screen.getByText("Modern decks need at least 60 cards; you have 6."),
    ).toBeInTheDocument();
  });

  /**
   * Two `"inner"` layers open at once are not ordered by the Escape protocol at all — both
   * would consume one press — so the editor holds *one* piece of state for the pair, and
   * opening either takes the other down.
   */
  it("never has a row menu and the format check open at once", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Modern check" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
  });

  /**
   * The **third** `"inner"` peer on this screen, and the one no state union covers: the set
   * filter inside the docked search panel owns its own Escape rung (`SetCombobox`). What keeps
   * it exclusive with the editor's own two is focus and click mechanics — every one of the
   * three closes on focus-out — so it is pinned here in the assembled editor, both ways round
   * for both of the editor's layers. Neither direction is a structural guarantee, and a test is
   * the only thing that would notice one of them being dropped.
   */
  it("never has the set filter and one of the editor's own layers open at once", async () => {
    await open();
    const setFilter = () => screen.getByRole("button", { name: "Set" });
    const filterOpen = () => screen.queryByRole("combobox", { name: "Search sets" });

    // Row menu, then the set filter: taking the caret out of the menu closes it.
    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    await userEvent.click(setFilter());

    expect(filterOpen()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // ...and back the other way: opening the menu takes the set filter down.
    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));

    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
    expect(filterOpen()).not.toBeInTheDocument();

    // The format check is the union's other half, and it behaves the same way both ways.
    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));
    await userEvent.click(setFilter());

    expect(filterOpen()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));

    expect(screen.getByRole("dialog", { name: "Modern check" })).toBeInTheDocument();
    expect(filterOpen()).not.toBeInTheDocument();
  });

  /** The one write in this task, end to end: what the deck is short of becomes wishes, and the
   *  strip says how many in words. */
  it("sends what the deck is missing to the wishlist", async () => {
    await open();

    expect(screen.getByText("3 of 6 missing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

    await waitFor(() => expect(deckMissingToWishlist).toHaveBeenCalledWith(4));
    // Wishes are cards and the shortfall is copies, so the sentence says which it counts.
    expect(
      await screen.findByText("Added 3 wishes — one per card, for every copy you are short."),
    ).toBeInTheDocument();
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

  /**
   * The panel's add is in that family too, and it is the one that could have been left out of
   * it: `add_card` goes through `touch_deck` like every other write, so a press on a deck that
   * has been deleted answers the same sentence. Without the re-read the panel would say the
   * deck is gone while the zone columns beside it went on painting it, and every further press
   * would fail the same way with nothing on screen explaining it.
   */
  it("re-reads the deck when an add from the panel is refused", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    deckAddCard.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
    );

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
  });

  /**
   * And the fifth: `missing_to_wishlist` reads the deck before it writes anything and answers
   * the same `GONE`, so the stats strip's button belongs in the family for the family's reason
   * — no refused deck write may leave a dead deck painted.
   */
  it("re-reads the deck when the wishlist write is refused", async () => {
    deckMissingToWishlist.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

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

/**
 * The three drags, end to end: a tile out of the panel into a zone, a row from one zone into
 * another, and a row onto the tray that takes it out of the deck.
 *
 * Real drag events at the real registrations — `src/test-drag.ts` explains why jsdom can carry
 * them and lists what it cannot (the platform's drag preview, pointer hit-testing, auto-scroll
 * and Escape, which the browser handles without telling the page). Every one of these has a
 * click path from Tasks 12–13 tested above it: what these prove is that the drag reaches the
 * *same* write, not a second one.
 */
describe("DeckEditor drag and drop", () => {
  const zone = (title: string) => screen.getByRole("region", { name: new RegExp(`^${title}`) });
  /** The scroller is the drop target, and the attribute is how `ZoneColumn` marks it. */
  const scroller = (title: string) => zone(title).querySelector("[data-zone-scroller]")!;
  /** A row, from the name it shows. The `<li>` is the drag handle — the whole row is. */
  const row = (name: string) => screen.getByRole("button", { name }).closest("li")!;

  /** One result in the panel, for the drags that start there. */
  function panelHolds(name: string) {
    searchCards.mockResolvedValue({ items: [found(name)], total: 1, totalIsCapped: false });
    return async () => {
      const art = await screen.findByRole("button", { name });
      return art.closest('[draggable="true"]')!;
    };
  }

  /**
   * The zone that took the card decides, not the panel's target-zone select — which is still
   * saying Main deck while the card lands in the sideboard. That is the whole difference
   * between the drag and the button beside it, and the reason a drop carries its own zone.
   */
  it("adds a card dragged out of the panel to the zone it was dropped on", async () => {
    const tile = panelHolds("Goblin Guide");
    await open();

    await dragOnto(await tile(), scroller("Sideboard"));

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", "side", 1);
    expect(screen.getByLabelText("Add to")).toHaveValue("main");
  });

  /**
   * A row dropped on another column is the row menu's "Move to" by another route — the same
   * command, and the same hand-off afterwards: the row the reader was holding has left, so the
   * caret goes to the zone that now has the card and announces it.
   */
  it("moves a row into the zone it was dropped on, and hands the caret to it", async () => {
    await open();

    await dragOnto(row("Lightning Bolt"), scroller("Sideboard"));

    await waitFor(() =>
      expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", "main", "side"),
    );
    await waitFor(() => expect(zone("Sideboard")).toHaveFocus());
  });

  /**
   * The tray is the drag's own way out of the deck: it is not there until a row is in the air,
   * it names the card once it has it, and it writes the zero that the stepper's last press
   * writes.
   */
  it("offers a way out of the deck while a row is in the air", async () => {
    await open();
    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();

    const held = await startDrag(row("Lightning Bolt"));
    const tray = screen.getByText("Remove from deck");
    await held.over(tray);
    expect(screen.getByText("Remove Lightning Bolt from deck")).toBeInTheDocument();
    await held.drop();

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "c-Lightning Bolt", "main", 0);
    await waitFor(() => expect(screen.queryByText(/remove/i)).not.toBeInTheDocument());
  });

  /**
   * And it is not there for a card being dragged *in*: there is no row to take out, so a tray
   * that appeared would be offering to undo something that never happened.
   */
  it("does not offer the tray for a card dragged in from the panel", async () => {
    const tile = panelHolds("Goblin Guide");
    await open();

    const held = await startDrag(await tile());
    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();

    await held.cancel();
  });

  /**
   * **A cancelled drag is not a press of Escape as far as this app is concerned.**
   *
   * The platform cancels a drag itself — in Chromium the keypress goes to the drag operation
   * and the page is told by a `dragend`, which is what takes the tray down here. jsdom has no
   * drag to cancel, so what this pins is the app's half of that contract: while a card is in
   * the air the editor is listening for no keys at all, so an Escape that reaches the window
   * arrives with nothing consumed and the card detail pane behind this view still closes on
   * its own press (`App.test.tsx`'s Escape stack). An editor that treated a drag as a
   * dismissible layer would eat that press and leave a card pinned open.
   */
  it("takes the tray away on the drag's own end, without spending the app's Escape", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    const held = await startDrag(row("Lightning Bolt"));
    expect(screen.getByText("Remove from deck")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(heard).toEqual([false]);

    await held.cancel();

    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    expect(deckMoveCard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", listen);
  });
});
