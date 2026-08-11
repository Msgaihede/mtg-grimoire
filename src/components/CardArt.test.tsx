import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardArt } from "./CardArt";

describe("CardArt", () => {
  it("draws the card's art, named by the card", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * The whole reason `CardImage` exists, kept true through the extraction: a frame belongs
   * to a *slot*, so React hands one element a different card, and a browser keeps painting
   * the last decoded frame until the new `src` decodes. A new card must be a new element.
   *
   * Element identity is what a test can see here. `naturalWidth` cannot: setting `src`
   * resets it to 0 while the old frame stays painted, so it reads the same in the healthy
   * case and the broken one.
   */
  it("is a new element when it is a new card", () => {
    const { rerender } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    const first = screen.getByRole("img");
    rerender(<CardArt cardId="shock" name="Shock" />);
    expect(screen.getByRole("img")).not.toBe(first);
  });

  /** An orphan has no printing to fetch, and a request for one could only 404. */
  it("draws the name and fetches nothing when there is no card id", () => {
    render(<CardArt cardId={null} name="Lightning Bolt" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("No card")).toBeInTheDocument();
  });

  /**
   * The sheen tints, the chip speaks. Only the chip is information, so only the chip is in
   * the accessibility tree — a screen reader hearing "Foil" twice per card would be being
   * told about the decoration.
   */
  it("lays a sheen over a foil card and hides it from screen readers", () => {
    const { container } = render(<CardArt cardId="unf" name="Sole Performer" finish="foil" />);
    const sheen = container.querySelector("[data-foil-sheen]");
    expect(sheen).toBeInTheDocument();
    expect(sheen).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
  });

  it("marks etched as etched, not as foil", () => {
    render(<CardArt cardId="etch" name="Etched Card" finish="etched" />);
    expect(screen.getByLabelText("Etched")).toBeInTheDocument();
    expect(screen.queryByLabelText("Foil")).not.toBeInTheDocument();
  });

  it("draws no sheen for a card that is not foil", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(container.querySelector("[data-foil-sheen]")).not.toBeInTheDocument();
  });

  /** The face and the variant both reach the URL, which is what keys the image. */
  it("asks for the face and variant it was given", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" face={1} variant="art" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", expect.stringContaining("/art/bolt/1"));
  });
});
