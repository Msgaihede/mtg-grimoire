import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));
/**
 * The note editor, as a textarea — `DeckNotesPanel.test.tsx`'s stand-in, for its reason: Tiptap
 * does not type in jsdom, and what these tests pin is the host's half of the save, not the editor.
 * It keeps the real component's three props.
 */
vi.mock("@grimoire/ui/features/decks/NoteEditor", () => ({
  default: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (markdown: string) => void;
    ariaLabel: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { ipc, type DeckCard, type DeckVariant } from "@grimoire/ui/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@grimoire/ui/lib/marketplace";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for a fake round trip and the reads that follow it. */
const SETTLE = { timeout: 3000 };

/**
 * The starter seed's decks, as these tests lean on them. Deck 1 is a Modern deck that keeps one
 * list — four `2X2` Lightning Bolts in `Main deck`, a Sideboard to move into. Deck 2 is a Commander
 * deck under Kenrith, with a to-do list. Deck 4 keeps a plan.
 */
const MODERN = 1;
const KENRITH = 2;

/** The deck as the backend holds it now — every assertion reads the fake, never the screen. */
async function rows(deckId: number, variant: DeckVariant = "live"): Promise<DeckCard[]> {
  const detail = await ipc.deckGet(deckId, variant, DEFAULT_MARKETPLACE);
  return detail?.cards ?? [];
}

const bolts = async (deckId = MODERN) =>
  (await rows(deckId)).filter((card) => card.name === "Lightning Bolt");

/** Open a row's action sheet by its `⋯`, and hand back the sheet. */
async function act(name: RegExp): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name }, SETTLE));
  return await screen.findByRole("dialog", undefined, SETTLE);
}

describe("a deck row's action sheet", () => {
  it("steps the copies up and down through the stepper", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Lightning Bolt" }));
    await waitFor(async () => expect((await bolts())[0]?.quantity).toBe(5), SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "One fewer Lightning Bolt" }));
    await waitFor(async () => expect((await bolts())[0]?.quantity).toBe(4), SETTLE);
    // The sheet follows the row: its own count reads what the deck holds.
    expect(within(sheet).getByRole("status", { name: "Copies" })).toHaveTextContent("4");
  });

  it("removes the row, closes the sheet, and says where a cut's copies went", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);

    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from Main deck" }));

    await waitFor(async () => expect(await bolts()).toHaveLength(0), SETTLE);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    // A cut from an Actual list is a collection write and files no undo step — on the desktop
    // too — so the page's line says what went, and offers no Undo it could not honour.
    expect(
      await screen.findByText(/^Removed 4 × Lightning Bolt from Main deck\./, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Lightning Bolt, / })).toBeNull();
  });

  it("offers the deck's own undo for a write it journalled, and the undo puts it back", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);
    await userEvent.click(within(sheet).getByRole("button", { name: /^Label/ }));
    await userEvent.click(
      await within(within(sheet).getByRole("list", { name: "Labels" })).findByRole(
        "button",
        { name: "Cut candidate" },
        SETTLE,
      ),
    );
    await waitFor(async () => expect((await bolts())[0]?.labelName).toBe("Cut candidate"), SETTLE);
    expect(
      await within(sheet).findByText("Labelled Lightning Bolt Cut candidate.", undefined, SETTLE),
    ).toBeInTheDocument();

    // The button is named by the step the deck filed, which is what it reverses.
    await userEvent.click(await within(sheet).findByRole("button", { name: /^Undo — / }, SETTLE));

    await waitFor(async () => expect((await bolts())[0]?.labelId).toBeNull(), SETTLE);
  });

  it("moves the card to another pile, and stays on the row it moved", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);

    await userEvent.click(within(sheet).getByRole("button", { name: /^Pile/ }));
    const piles = within(sheet).getByRole("list", { name: "Piles" });
    // The pile the card is in is marked and says why a press there would do nothing.
    expect(within(piles).getByRole("button", { name: /^Main deck/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await userEvent.click(within(piles).getByRole("button", { name: /^Sideboard/ }));

    await waitFor(
      async () => expect((await bolts()).map((card) => card.categoryName)).toEqual(["Sideboard"]),
      SETTLE,
    );
    // Back on the first page, about the same card at its new address.
    expect(await within(sheet).findByText("4 in Sideboard", undefined, SETTLE)).toBeInTheDocument();
  });

  it("refuses a claim the card cannot make, in words, and writes nothing", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${KENRITH}` });
    const sheet = await act(/^Edit Sol Ring in /);

    const claim = within(sheet).getByRole("button", { name: /^Set as commander/ });
    expect(claim).toHaveAttribute("aria-disabled", "true");
    // The validation panel's own sentence, under the row rather than nowhere.
    expect(claim.textContent).not.toBe("Set as commander");
    const before = (await rows(KENRITH)).find((card) => card.name === "Sol Ring");

    await userEvent.click(claim);

    const after = (await rows(KENRITH)).find((card) => card.name === "Sol Ring");
    expect(after?.categoryId).toBe(before?.categoryId);
  });

  it("puts a label on the card and takes it off again", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);

    await userEvent.click(within(sheet).getByRole("button", { name: /^Label/ }));
    const labels = within(sheet).getByRole("list", { name: "Labels" });
    await userEvent.click(
      await within(labels).findByRole("button", { name: "Cut candidate" }, SETTLE),
    );
    await waitFor(async () => expect((await bolts())[0]?.labelName).toBe("Cut candidate"), SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: /^Label/ }));
    await userEvent.click(
      within(within(sheet).getByRole("list", { name: "Labels" })).getByRole("button", {
        name: "None",
      }),
    );
    await waitFor(async () => expect((await bolts())[0]?.labelId).toBeNull(), SETTLE);
  });

  it("plays another printing of the card, and another finish of it", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const sheet = await act(/^Edit Lightning Bolt in Main deck$/);

    await userEvent.click(within(sheet).getByRole("button", { name: /^Printing/ }));
    const printings = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
    await userEvent.click(within(printings).getByRole("button", { name: /LEA · 161/ }));
    await waitFor(async () => expect((await bolts())[0]?.setCode).toBe("lea"), SETTLE);

    // Back to a printing sold in two finishes, then the foil one.
    await userEvent.click(within(sheet).getByRole("button", { name: /^Printing/ }));
    await userEvent.click(
      within(await within(sheet).findByRole("list", { name: "Printings" }, SETTLE)).getByRole(
        "button",
        { name: /2X2 · 117/ },
      ),
    );
    await waitFor(async () => expect((await bolts())[0]?.setCode).toBe("2x2"), SETTLE);
    await userEvent.click(within(sheet).getByRole("button", { name: /^Finish/ }));
    await userEvent.click(
      within(within(sheet).getByRole("list", { name: "Finishes" })).getByRole("button", {
        name: "Foil",
      }),
    );
    await waitFor(async () => expect((await bolts())[0]?.finish).toBe("foil"), SETTLE);
  });
});

describe("adding cards to a deck", () => {
  it("adds one copy per press from the add search, and says how many the list holds", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    await userEvent.click(await screen.findByRole("button", { name: "Add cards" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Add cards" }, SETTLE);
    const before = (await rows(MODERN)).filter((c) => c.name === "Llanowar Elves").length;
    expect(before).toBe(0);

    // The deck's format is where the search opens, and a tile's press says it adds.
    await userEvent.type(
      within(sheet).getByRole("searchbox", { name: "Search cards to add" }),
      "Llanowar Elves",
    );
    const wall = await within(sheet).findByRole("list", { name: "Cards to add" }, SETTLE);
    await userEvent.click(
      await within(wall).findByRole("button", { name: /^Add Llanowar Elves/ }, SETTLE),
    );

    await waitFor(
      async () =>
        expect(
          (await rows(MODERN)).filter((c) => c.name === "Llanowar Elves").map((c) => c.quantity),
        ).toEqual([1]),
      SETTLE,
    );
    expect(await within(sheet).findByText(/1 in this list/, undefined, SETTLE)).toBeInTheDocument();
  });

  it("adds the printing on screen from the card sheet over a deck", async () => {
    const bolt = (await import("@grimoire/fake/fixtures")).printing("2x2", "117");
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}?card=${bolt.id}` });
    const add = await screen.findByRole("button", { name: /^Add to Modern Goodstuff/ }, SETTLE);

    await userEvent.click(add);

    // One copy, filed by the deck's own rule for an add from outside the editor — which may be a
    // pile of its own, so the deck is counted across its piles.
    await waitFor(
      async () => expect((await bolts()).reduce((sum, card) => sum + card.quantity, 0)).toBe(5),
      SETTLE,
    );
    expect(
      await screen.findByText("Added 1 × Lightning Bolt.", undefined, SETTLE),
    ).toBeInTheDocument();
  });

  it("offers no deck add on a card sheet opened anywhere but over a deck", async () => {
    const bolt = (await import("@grimoire/fake/fixtures")).printing("2x2", "117");
    renderPhone(<PhoneFace />, { path: `/search?card=${bolt.id}` });
    await screen.findByRole("dialog", { name: "Lightning Bolt" }, SETTLE);
    // The collection's and the wishlist's adds are on every card since step 3.5b; a deck's is not.
    const actions = await screen.findByRole("region", { name: "Actions" }, SETTLE);
    expect(
      within(actions)
        .getAllByRole("button", { name: /^Add to / })
        .map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual(["Add to collection", "Add to wishlist", "Add to wishlist, any printing"]);
  });
});

describe("a deck's notes and to-do lists", () => {
  it("ticks a to-do in place", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${KENRITH}` });
    const todos = await screen.findByRole("region", { name: "To-do lists" }, SETTLE);

    await userEvent.click(
      await within(todos).findByRole(
        "checkbox",
        { name: 'Mark "Cut three creatures" done' },
        SETTLE,
      ),
    );

    await waitFor(
      async () =>
        expect((await ipc.deckTodoLists(KENRITH))[0]?.body).toBe("- [x] Cut three creatures"),
      SETTLE,
    );
  });

  it("writes a new deck note, then edits it, through the desktop's dialog", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${KENRITH}` });
    const notes = await screen.findByRole("region", { name: "Notes" }, SETTLE);

    await userEvent.click(within(notes).getByRole("button", { name: "New note" }));
    await userEvent.type(
      await screen.findByLabelText("Body of New note", undefined, SETTLE),
      "Fourteen sources.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(
      async () =>
        expect((await ipc.deckNotes(KENRITH)).map((n) => [n.title, n.body])).toEqual([
          ["", "Fourteen sources."],
        ]),
      SETTLE,
    );

    await userEvent.click(
      await within(notes).findByRole("button", { name: "Edit Fourteen sources." }, SETTLE),
    );
    const body = await screen.findByLabelText("Body of Fourteen sources.", undefined, SETTLE);
    await userEvent.clear(body);
    await userEvent.type(body, "Fifteen.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(
      async () => expect((await ipc.deckNotes(KENRITH)).map((n) => n.body)).toEqual(["Fifteen."]),
      SETTLE,
    );
  });
});
