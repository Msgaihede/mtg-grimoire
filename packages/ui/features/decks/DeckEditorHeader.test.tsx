import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { DeckEditorHeader, type DeckEditorHeaderProps } from "./DeckEditorHeader";

function header(over: Partial<DeckEditorHeaderProps> = {}) {
  const props: DeckEditorHeaderProps = {
    backRef: createRef(),
    closeDeck: vi.fn(),
    name: "Kenrith",
    renameDeck: vi.fn(),
    theoryEnabled: false,
    variant: "live",
    pickVariant: vi.fn(),
    layer: null,
    openLayer: vi.fn(),
    tightHeader: false,
    wideHeader: true,
    settingsIcon: false,
    ...over,
  };
  render(<DeckEditorHeader {...props} />);
  return props;
}

describe("DeckEditorHeader's page bar", () => {
  it("leads with a `Decks` crumb that closes the deck and holds the caret's way back", async () => {
    const props = header();
    const trail = screen.getByRole("navigation", { name: "Page trail" });
    const back = within(trail).getByRole("button", { name: "Back to decks" });
    // The drawn word is the crumb's, at every width — it no longer drops to a bare chevron.
    expect(back).toHaveTextContent("Decks");
    expect(props.backRef.current).toBe(back);
    await userEvent.click(back);
    expect(props.closeDeck).toHaveBeenCalledOnce();
  });

  it("files a deck under its drawers: `Decks` goes to the top level, its own drawer closes", async () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 7 });
    const props = header({
      folders: [
        { id: 1, name: "Commander" },
        { id: 2, name: "Otters" },
      ],
    });
    const trail = within(screen.getByRole("navigation", { name: "Page trail" }));

    // The drawer the deck is in is the close — the caret's way back and Escape's meaning.
    const own = trail.getByRole("button", { name: "Back to Otters" });
    expect(own).toHaveTextContent("Otters");
    expect(props.backRef.current).toBe(own);
    await userEvent.click(own);
    expect(props.closeDeck).toHaveBeenCalledOnce();

    // Three crumbs: the bar keeps the root and the deck's own drawer and elides the middle.
    expect(trail.queryByRole("button", { name: "Commander" })).toBeNull();
    expect(trail.getByText("…")).toBeInTheDocument();

    // `Decks` is the rail's own press, which closes an editor onto the top level.
    await userEvent.click(trail.getByRole("button", { name: "Back to all decks" }));
    expect(useAppStore.getState()).toMatchObject({
      activeView: "decks",
      openDeckId: null,
      pendingDeckFolder: null,
      returnToDeckId: null,
    });
    expect(props.closeDeck).toHaveBeenCalledOnce();
  });

  it("draws the crumb alone, with no actions, before the deck has answered", () => {
    header({ name: null });
    expect(screen.getByRole("button", { name: "Back to decks" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deck settings" })).toBeNull();
  });
});

describe("DeckEditorHeader's Goldfish button", () => {
  it("is the fish alone at every width, named for what it does, and opens the board", async () => {
    const openGoldfish = vi.fn();
    header({ openGoldfish, wideHeader: true });
    const button = screen.getByRole("button", { name: "Goldfish this deck" });
    // An icon button: the glyph and nothing to read, even on the widest header.
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg.lucide-fish")).not.toBeNull();
    await userEvent.click(button);
    expect(openGoldfish).toHaveBeenCalledOnce();
  });

  it("is not drawn where the edition has no Playtesting", () => {
    header();
    expect(screen.queryByRole("button", { name: "Goldfish this deck" })).toBeNull();
  });
});

describe("DeckEditorHeader's trail for a deck in one drawer", () => {
  it("draws the root and the drawer, and nothing closes until one is pressed", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 7 });
    const props = header({ folders: [{ id: 2, name: "Otters" }] });
    const trail = within(screen.getByRole("navigation", { name: "Page trail" }));
    expect(trail.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Back to all decks",
      "Back to Otters",
    ]);
    expect(props.closeDeck).not.toHaveBeenCalled();
  });
});
