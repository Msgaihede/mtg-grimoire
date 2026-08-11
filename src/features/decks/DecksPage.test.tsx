import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { DeckRow, FormatSpec } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { spec } from "./validation/fixtures";

const deckList = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckDuplicate = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckList, deckCreate, deckUpdate, deckDelete, deckDuplicate, formatSpecs },
}));

import { DecksPage } from "./DecksPage";
import { useAppStore } from "@/lib/store";

/** A deck with a cover, which is the only kind that can carry an artist credit. */
const BURN: DeckRow = {
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: "0000419b-0bba-4488-8f7a-6194544ce91d",
  coverArtist: "Rebecca Guay",
  isBuilt: false,
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns. Every real row carries all four, so the fixture does too.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
};

/** No cover, so no art and — the plan's ruling — no credit line at all. */
const DRAFT: DeckRow = {
  ...BURN,
  id: 5,
  name: "Sunday draft",
  formatKey: "limited",
  formatName: "Limited",
  coverCardId: null,
  coverArtist: null,
  cardCount: 40,
};

/** Filed away: sorted last by `deck_list`, and behind a disclosure here. */
const FILED: DeckRow = { ...BURN, id: 6, name: "Old Standard", archived: true, cardCount: 60 };

/**
 * The picker's rows as `format_specs` serves them: every seeded row, in `sort_order`,
 * including the one that is switched off.
 *
 * Only four cells matter to a picker — key, display name, `enabledInPicker` and the order —
 * so the two rows the shared fixture does not carry are built from one that does. The
 * authority for the seed itself is Task 2's Rust test, not this list.
 */
const PICKER: FormatSpec[] = [
  { ...spec("modern"), key: "standard", displayName: "Standard", sortOrder: 1 },
  {
    ...spec("modern"),
    key: "future",
    displayName: "Future Standard",
    enabledInPicker: false,
    sortOrder: 2,
  },
  spec("modern"),
  spec("commander"),
  spec("casual"),
];

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The tile, addressed the way a reader sees it: the deck's name first. */
const tileFor = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  deckList.mockReset().mockResolvedValue([BURN, DRAFT, FILED]);
  deckCreate.mockReset().mockResolvedValue({ ...BURN, id: 9, name: "Sunday burn" });
  deckUpdate.mockReset().mockResolvedValue({ ...BURN, archived: true });
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckDuplicate.mockReset().mockResolvedValue({ ...BURN, id: 10, name: "Burn (copy)" });
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  useAppStore.setState({ openDeckId: null, returnToDeckId: null });
});

describe("DecksPage", () => {
  /**
   * An empty screen is an invitation to act: it says what the thing is and offers the one
   * action that makes one. Not "No decks found", which blames the reader for a table nobody
   * has put anything in yet.
   */
  it("says what a deck is and offers to make one when there are none", async () => {
    deckList.mockResolvedValue([]);

    wrap(<DecksPage />);

    expect(await screen.findByText(/a deck is a list you build for a format/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New deck" })).toBeInTheDocument();
  });

  /**
   * Scryfall's image policy, which is not optional: the credit rides the interface that
   * shows art, so the footer is drawn whether or not any deck has a cover yet.
   */
  it("credits Wizards and Scryfall even with nothing on the wall", async () => {
    deckList.mockResolvedValue([]);

    wrap(<DecksPage />);

    expect(
      await screen.findByText("Card images © Wizards of the Coast · Data © Scryfall"),
    ).toBeInTheDocument();
  });

  /** Name in the reading face, format beside it, and the count in the data face. */
  it("draws a deck as its cover art, named, formatted and counted", async () => {
    wrap(<DecksPage />);

    const tile = await tileFor("Burn");
    // The art, the name and the caption are one control — a reader who aims at the name of a
    // deck should not miss it. (`toHaveAccessibleName` is asserted as a prefix rather than in
    // full: the name and the caption are two block spans, and jsdom computes no `display`, so
    // dom-accessibility-api joins them without the space a browser would insert.)
    expect(tile).toHaveAccessibleName(/^Burn/);
    expect(within(tile).getByText("Burn")).toBeInTheDocument();
    // `getByText` reads an element's *direct* text nodes, so the caption is found by the
    // part of it that is not in the mono span and read back whole.
    expect(within(tile).getByText(/Modern/)).toHaveTextContent("Modern · 60 cards");
    expect(within(tile).getByText("60")).toHaveClass("font-mono");
    const img = tile.querySelector("img");
    expect(img).toHaveAttribute("src", cardImageUrl(BURN.coverCardId!, 0, "art"));
  });

  /**
   * An art crop has no printed frame, so the illustrator is credited beside it — and the
   * plan's ruling is that a cover with no artist draws *no line at all*, never the word
   * "null" and never a placeholder.
   */
  it("credits the cover's artist, and says nothing at all when there is none", async () => {
    wrap(<DecksPage />);

    expect(await screen.findByText("Art by Rebecca Guay")).toBeInTheDocument();
    // The coverless deck is on screen beside it, and has no credit of its own.
    await tileFor("Sunday draft");
    expect(screen.getAllByText(/art by/i)).toHaveLength(1);
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  /**
   * The ruling's real case, and the only one that can put the word "null" on a tile: the deck
   * *has* a cover, and the printing it names has left the card database — so `cards` answers
   * no artist for it. The art still resolves (the id is still an id); the credit does not.
   */
  it("draws no credit for a cover whose printing has left the card database", async () => {
    deckList.mockResolvedValue([{ ...BURN, coverArtist: null }]);

    wrap(<DecksPage />);

    const tile = await tileFor("Burn");
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      cardImageUrl(BURN.coverCardId!, 0, "art"),
    );
    expect(screen.queryByText(/art by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  /** A filed deck is kept, not shown: it is behind its own disclosure, shut. */
  it("keeps archived decks in a section of their own, collapsed", async () => {
    wrap(<DecksPage />);

    await tileFor("Burn");
    expect(screen.queryByRole("button", { name: /^Old Standard/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /archived/i }));

    expect(await tileFor("Old Standard")).toBeInTheDocument();
  });

  /** The gallery's whole job: pick one to work on. */
  it("opens the deck a tile is clicked", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await tileFor("Burn"));

    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * Coming back from an editor. The tile that opened it unmounted while the editor was up, so
   * the store carries the note and the wall hands the caret back once the tiles exist —
   * without it the caret is on `<body>` and the next Tab restarts from the top of the app.
   */
  it("hands the caret back to the tile of the deck an editor just closed", async () => {
    useAppStore.setState({ returnToDeckId: 4 });

    wrap(<DecksPage />);

    await waitFor(async () => expect(await tileFor("Burn")).toHaveFocus());
    // Used once: a note left standing would yank the caret again on the next render.
    expect(useAppStore.getState().returnToDeckId).toBeNull();
  });

  /** A deck deleted from inside its own editor has no tile to come back to, and the note is
   *  still spent — otherwise it waits forever for a row that is never coming. */
  it("clears the note when the deck it names is gone", async () => {
    useAppStore.setState({ returnToDeckId: 99 });

    wrap(<DecksPage />);

    await tileFor("Burn");
    await waitFor(() => expect(useAppStore.getState().returnToDeckId).toBeNull());
  });

  /**
   * Two questions and no more — a name and a format — and the caret starts in the field the
   * reader has to fill.
   */
  it("opens the create form with the caret in the name field", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    expect(await screen.findByLabelText("Name")).toHaveFocus();
  });

  /**
   * The picker is the seeded table read in `sortOrder`, and `enabled_in_picker` is what
   * keeps Future Standard — a format you can test against but cannot build for — out of it.
   */
  it("offers the seeded formats in their own order, without the one that is switched off", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    const format = await screen.findByLabelText("Format");
    const options = within(format)
      .getAllByRole("option")
      .map((o) => o.textContent);

    expect(options).toEqual(["Standard", "Modern", "Commander", "Casual"]);
    expect(format).toHaveValue("casual");
  });

  /** Creating a deck is creating it *and* going to it — nobody makes a deck to look at a tile. */
  it("creates the deck and opens it", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "modern");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({ name: "Sunday burn", formatKey: "modern" }),
    );
    await waitFor(() => expect(useAppStore.getState().openDeckId).toBe(9));
  });

  /**
   * The one place a refused create can be read is the form it was made in — `writeFailure`
   * covers the three writes a *tile* makes, not this one, and reopening the form resets the
   * mutation. So the form has to outlive the press.
   *
   * The press is what puts it at risk: `Create deck` disables itself, and a browser blurs a
   * disabled control **with no `relatedTarget` at all** — which the click-away handler reads as
   * the reader leaving. That blur is the one event jsdom will not produce on its own (it does
   * not blur a control that becomes disabled, and a `userEvent.click` elsewhere then finds
   * nothing to move the caret *from*), so it is dispatched here directly. Delivered any other
   * way this test passes over a missing guard — it was written that way first, and did.
   */
  it("keeps the create form open while the write is in flight, so a refusal has somewhere to land", async () => {
    let refuse!: (reason: string) => void;
    deckCreate.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    fireEvent.focusOut(screen.getByLabelText("Name"), { relatedTarget: null });

    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    refuse("The database is busy with a sync — try again in a moment.");

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });

  /** The same guard on the other panel: the answer must not arrive over a closed question. */
  it("keeps the delete question open while the delete is in flight", async () => {
    let finish!: () => void;
    deckDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Burn" }));
    const confirm = screen.getByRole("dialog", { name: /delete burn/i });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete deck" }));

    fireEvent.focusOut(confirm, { relatedTarget: null });

    expect(screen.getByRole("dialog", { name: /delete burn/i })).toBeInTheDocument();

    finish();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("duplicates a deck", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Duplicate Burn" }));

    expect(deckDuplicate).toHaveBeenCalledWith(4);
  });

  /** Filing a deck away is `archived`, never the delete — this is what a gallery's remove is. */
  it("archives a deck, and restores one", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Archive Burn" }));
    expect(deckUpdate).toHaveBeenCalledWith(4, { archived: true });

    await userEvent.click(screen.getByRole("button", { name: /archived/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore Old Standard" }));

    expect(deckUpdate).toHaveBeenCalledWith(6, { archived: false });
  });

  /**
   * A deck is minutes of work and `deck_delete` really deletes, so the destructive one asks
   * — once, in words, naming the deck it would take.
   */
  it("asks before deleting, in words that name the deck", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete Burn" }));

    expect(deckDelete).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: /delete burn/i });
    expect(confirm).toHaveTextContent("Burn");
    expect(confirm).toHaveTextContent(/60 cards/);

    await userEvent.click(within(confirm).getByRole("button", { name: "Delete deck" }));

    expect(deckDelete).toHaveBeenCalledWith(4);
  });

  /** The way out of the question, for the reader who did not mean to ask it. */
  it("closes the delete question on Escape, without deleting anything", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deckDelete).not.toHaveBeenCalled();
    expect(remove).toHaveFocus();
  });

  /**
   * The other half of the same rule, and the half a single shared handler gets wrong: a
   * reader who clicked somewhere else is *already* somewhere else, so the layer goes and the
   * caret stays where they put it. Yanking it back to the trash icon is what makes a Tab
   * forward out of Cancel bounce backwards.
   */
  it("closes the delete question on a click away, and leaves the caret where it went", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);
    await screen.findByRole("dialog");

    await userEvent.click(document.body);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).not.toHaveFocus();
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /** Cancel is a control *in* the layer, so it is the keyboard way out and hands back. */
  it("hands the caret back when the question is cancelled", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).toHaveFocus();
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /** Every other popup in the app closes when the reader looks away; this one too. */
  it("closes the create form on a click away, without handing the caret back", async () => {
    wrap(<DecksPage />);
    const newDeck = await screen.findByRole("button", { name: "New deck" });
    await userEvent.click(newDeck);
    await screen.findByLabelText("Name");

    await userEvent.click(document.body);

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(newDeck).not.toHaveFocus();
  });

  /**
   * Escape closes one layer per press: the popover goes, the gallery stays, and the caret
   * comes back to the control that opened it rather than dropping onto `<body>`.
   */
  it("closes the create form on Escape and hands the caret back", async () => {
    wrap(<DecksPage />);
    const newDeck = await screen.findByRole("button", { name: "New deck" });
    await userEvent.click(newDeck);
    await screen.findByLabelText("Name");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(newDeck).toHaveFocus();
    expect(await tileFor("Burn")).toBeInTheDocument();
  });

  /** A refused write is said in the app's own words, where the reader is looking. */
  it("says so when a write is refused", async () => {
    deckDuplicate.mockRejectedValue("That deck is not there any more.");

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate Burn" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That deck is not there any more.");
  });
});
