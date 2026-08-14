import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardSummary, SearchResponse } from "@/lib/ipc";

// `vi.hoisted`, because `vi.mock` is hoisted above every `const` in this file and the factory
// runs the moment `./QuickAdd` pulls `@/lib/ipc` in. One command: this field's three routes to
// an add are all `search_cards`, and what separates them is the argument.
const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards },
}));
import { QuickAdd } from "./QuickAdd";

/**
 * **Real timers, everywhere in this file.**
 *
 * The field debounces by `DEBOUNCE_MS` (300ms) and `userEvent` cannot be driven under Vitest
 * fake timers at all — RTL's `asyncWrapper` waits on a real `setTimeout` it only knows how to
 * advance through *Jest*, so such a test hangs to its timeout rather than failing. So the wait
 * for a suggestion is a real one, and it is given the same headroom
 * `DeckSearchPanel.stories.tsx` gives its own debounced field rather than a bare default.
 */
const SETTLE = { timeout: 4000 };

/** One search result, in `DeckEditor.test.tsx`'s shape — the same `Creature — Goblin` the
 *  editor files by, so a fixture here and one there are the same card. */
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
  };
}

const page = (...names: string[]): SearchResponse => ({
  items: names.map(found),
  total: names.length,
  totalIsCapped: false,
});

/**
 * The field, with somewhere to Tab to.
 *
 * The button is deliberately *outside* the control's root: `onBlur` only closes the list when
 * the focus left the root altogether, so a target inside it would prove nothing.
 */
function mount() {
  const onAdd = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <QuickAdd targetName={null} onAdd={onAdd} />
      <button type="button">Elsewhere</button>
    </QueryClientProvider>,
  );
  return { onAdd, field: screen.getByRole("combobox", { name: "Quick add a card" }) };
}

/** Type, and wait out the debounce for the rows it settles on. */
async function suggest(field: HTMLElement, text: string) {
  await userEvent.type(field, text);
  return await screen.findAllByRole("option", {}, SETTLE);
}

/** The row Enter would take — and there is exactly one of it, which is half of what makes it
 *  a highlight rather than a colour. */
function highlighted() {
  const on = screen.getAllByRole("option").filter((r) => r.getAttribute("aria-selected") === "true");
  expect(on).toHaveLength(1);
  return on[0];
}

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue(page());
});

describe("QuickAdd", () => {
  /**
   * The suggestions are the docked panel's own search, cut to five and collapsed to the newest
   * printing of each match — the same printing the wall offers first for the same query, because
   * this is a shortcut over that wall and not a second way of choosing a printing.
   *
   * Five is the ceiling and it is asserted as a number rather than through `MAX_SUGGESTIONS`:
   * it is a promise to the reader about how long the list gets, so a test that imports the
   * constant would follow it wherever it went and pin nothing.
   */
  it("asks for five collapsed suggestions once the typing settles, and draws them", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker", "Goblin King"));
    const { field } = mount();

    const rows = await suggest(field, "goblin");

    expect(searchCards).toHaveBeenCalledWith({
      text: "goblin",
      collapse: true,
      limit: 5,
      offset: 0,
    });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Goblin Guide"),
      expect.stringContaining("Goblin Bushwhacker"),
      expect.stringContaining("Goblin King"),
    ]);
    // The set code rides along, because two printings of one name are told apart by nothing else.
    expect(rows[0]).toHaveTextContent("MH2");
    expect(field).toHaveAttribute("aria-expanded", "true");
  });

  /**
   * The list arrives with its first row already taken, so a reader who typed a name and meant
   * the obvious card presses Enter once. `aria-activedescendant` is the same fact for a screen
   * reader, and the two spellings of the row's id have to agree — a mismatch is invisible to the
   * eye and total to a reader who cannot see, which is why both are read here.
   */
  it("opens with the first suggestion under the cursor", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker"));
    const { field } = mount();

    const rows = await suggest(field, "goblin");

    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(rows[1]).toHaveAttribute("aria-selected", "false");
    expect(field).toHaveAttribute("aria-activedescendant", rows[0].id);
  });

  /** Enter on a settled list takes the row, and no round trip: the suggestion is already the
   *  card, so asking again would be a second search for an answer in hand. */
  it("adds the highlighted suggestion on Enter and clears the field", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker"));
    const { field, onAdd } = mount();

    await suggest(field, "goblin");
    searchCards.mockClear();
    await userEvent.keyboard("{Enter}");

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "s-Goblin Guide" }));
    expect(searchCards).not.toHaveBeenCalled();
    // Cleared on a hit, because the next action is the next card — and the list goes with it.
    expect(field).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(field).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **The point of the dropdown**: the caret stays in the field and the highlight moves instead,
   * so a reader who meant the third Goblin never has to Tab into the answers to take it.
   *
   * Both ends clamp rather than wrap. A list of five that jumps from the last row back to the
   * first is a list whose end the reader cannot feel, and this one is glanced at rather than
   * read — the stop *is* the feedback.
   */
  it("moves the highlight with the arrows, clamps at both ends, and adds the row it lands on", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker", "Goblin King"));
    const { field, onAdd } = mount();

    await suggest(field, "goblin");

    // Four presses down a three-row list: the fourth has nowhere to go.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(highlighted()).toHaveTextContent("Goblin King");
    expect(field).toHaveAttribute("aria-activedescendant", highlighted().id);

    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(highlighted()).toHaveTextContent("Goblin Guide");

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "Goblin Bushwhacker" }));
  });

  it("jumps to the first and last suggestions on Home and End", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker", "Goblin King"));
    const { field } = mount();

    await suggest(field, "goblin");

    await userEvent.keyboard("{End}");
    expect(highlighted()).toHaveTextContent("Goblin King");

    await userEvent.keyboard("{Home}");
    expect(highlighted()).toHaveTextContent("Goblin Guide");
  });

  /**
   * …and with nothing under it the field is a text field again. Home and End really do belong to
   * the caret there, and an arrow key consumed by a list that is not on screen is a keystroke
   * that goes nowhere. `fireEvent` answers `false` when the press was consumed.
   */
  it("leaves the arrows and Home and End to the caret when there is no list", async () => {
    const { field } = mount();

    expect(fireEvent.keyDown(field, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "Home" })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "End" })).toBe(true);
  });

  /**
   * One click, not two. The row refuses the focus a press would otherwise take — without that
   * the click blurs the input, `onBlur` closes the list, and the press lands on nothing.
   *
   * The caret is asserted by *pressing a key*, not by typing into the field: `user.type` focuses
   * whatever it is handed, so a test that types into the field would prove a focus that was never
   * there.
   */
  it("adds a suggestion on a single click and leaves the caret in the field", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker", "Goblin King"));
    const { field, onAdd } = mount();

    const rows = await suggest(field, "goblin");
    await userEvent.click(rows[2]);

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "Goblin King" }));

    await userEvent.keyboard("x");
    expect(field).toHaveValue("x");
  });

  /**
   * The mouse and the keyboard must not disagree about which row Enter would take: a reader who
   * arrowed to the third row and then moved the pointer over the first has pointed at the first.
   *
   * Driven with a *move* rather than an enter, because React never listens for `pointerenter` —
   * it synthesises enter/leave from `pointerover`/`pointerout`, so a component that listened for
   * the enter would hear nothing and this test would pass having called none of it.
   */
  it("re-points the highlight at whichever row the pointer moved over", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker", "Goblin King"));
    const { field, onAdd } = mount();

    const rows = await suggest(field, "goblin");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(highlighted()).toHaveTextContent("Goblin King");

    fireEvent.pointerMove(rows[0]);

    expect(highlighted()).toHaveTextContent("Goblin Guide");
    await userEvent.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "Goblin Guide" }));
  });

  /**
   * **The list on screen is an answer to what is in the field *now*.**
   *
   * The debounce means it need not be: 300ms after `sol` the field can say `solemn` while the
   * rows still belong to `sol`, and adding the top hit of a search the reader has already moved
   * past is a real bug rather than a theoretical one. Enter falls through to the one-shot search
   * for the text that is actually there.
   *
   * `fireEvent` rather than `userEvent` for the second half deliberately: the assertion is about
   * what happens *inside* the 300ms window, and a keystroke pair that has to beat a real timer is
   * a keystroke pair that loses the race on a loaded machine.
   */
  it("ignores rows that belong to older text and searches for what is in the field", async () => {
    searchCards.mockImplementation(({ limit }: { limit: number }) =>
      Promise.resolve(limit === 1 ? page("Solemn Simulacrum") : page("Sol Ring", "Sol Talisman")),
    );
    const { field, onAdd } = mount();

    await suggest(field, "sol");
    expect(highlighted()).toHaveTextContent("Sol Ring");

    // The reader types on, and presses Enter before the list can catch up.
    searchCards.mockClear();
    fireEvent.change(field, { target: { value: "solemn" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // Awaited before the argument is read, because `mutate` reaches its `mutationFn` a
    // microtask later — a synchronous assertion here sees no call at all and says the field
    // committed the stale row when it did nothing of the kind.
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "Solemn Simulacrum" })),
    );
    expect(searchCards).toHaveBeenCalledWith({
      text: "solemn",
      collapse: true,
      limit: 1,
      offset: 0,
    });
    // Once, and for the card that was actually in the field.
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  /**
   * **The no-regression test.** Enter has to work in a field with nothing to pick from, which is
   * every field for the first 300ms of typing — and a reader who knows the name and types it at
   * speed is exactly the reader the dropdown must not have cost anything.
   *
   * The suggestion arm is wired to a promise that never answers, so no row can ever exist to be
   * taken: the only route to an add here is the one-shot `limit: 1` search, whatever the machine
   * running this does with the debounce.
   */
  it("still adds a typed name on Enter before any suggestion exists", async () => {
    searchCards.mockImplementation(({ limit }: { limit: number }) =>
      limit === 1 ? Promise.resolve(page("Goblin Guide")) : new Promise(() => {}),
    );
    const { field, onAdd } = mount();

    await userEvent.type(field, "goblin guide{Enter}");

    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "s-Goblin Guide" })),
    );
    expect(searchCards).toHaveBeenCalledWith({
      text: "goblin guide",
      collapse: true,
      limit: 1,
      offset: 0,
    });
    expect(field).toHaveValue("");
  });

  /**
   * Escape closes the list and spends exactly one press doing it.
   *
   * The second half is the whole of what `enabled: listOpen` buys: with no list up, the press
   * belongs to the card detail pane, which listens on `window` in the bubble phase — and a
   * capture-phase listener here would consume it first and close nothing at all.
   * `DeckEditor.test.tsx` watches the same press arrive at the window from the editor.
   */
  it("closes the list on Escape, and leaves a press it has nothing to spend it on", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker"));
    const { field } = mount();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    try {
      await suggest(field, "goblin");
      await userEvent.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
      expect(field).toHaveAttribute("aria-expanded", "false");
      // The text stays: Escape put the list away, it did not undo the typing.
      expect(field).toHaveValue("goblin");

      await userEvent.keyboard("{Escape}");
    } finally {
      window.removeEventListener("keydown", listen);
    }

    // Consumed while there was a list, and untouched once there was not.
    expect(heard).toEqual([true, false]);
  });

  /** Tab past the field and the list should not still be hanging over the deck with the caret
   *  three controls further along. */
  it("closes the list when focus leaves the control", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker"));
    const { field } = mount();

    await suggest(field, "goblin");
    await userEvent.tab();

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(field).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **The rows go the moment the field does**, and this is what `keepPreviousData` costs if the
   * list is read off the debounced text instead: clearing the field changes the query key to
   * `""`, which the query is `enabled: false` for — so it never fetches, never replaces the
   * placeholder, and the last search's rows hang under an empty box for the rest of the session.
   *
   * Asserted without a `waitFor`, because "300ms later" is the other half of the bug.
   */
  it("takes the suggestions away the moment the field is emptied", async () => {
    searchCards.mockResolvedValue(page("Goblin Guide", "Goblin Bushwhacker"));
    const { field } = mount();

    await suggest(field, "goblin");
    await userEvent.clear(field);

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(field).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * A miss is said in words rather than swallowed, and the field keeps what was typed — because
   * the next action there is to correct it, not to type the next card.
   *
   * The live region is mounted for as long as the control is: one that appeared together with
   * its sentence would announce nothing, because there was no change to notice.
   */
  it("says when nothing was found, and keeps what was typed", async () => {
    const { field, onAdd } = mount();
    expect(screen.getByRole("status")).toHaveTextContent("");

    await userEvent.type(field, "Blakc Lotus{Enter}");

    expect(await screen.findByText("No card found for “Blakc Lotus”.", {}, SETTLE)).toBeVisible();
    expect(onAdd).not.toHaveBeenCalled();
    expect(field).toHaveValue("Blakc Lotus");
  });
});
