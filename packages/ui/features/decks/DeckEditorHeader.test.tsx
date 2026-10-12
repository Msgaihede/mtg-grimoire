import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
