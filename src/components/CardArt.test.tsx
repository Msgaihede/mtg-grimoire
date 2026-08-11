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

  /** The sheen is drawn, and a chip is drawn beside it. Both are paint. */
  it("lays a sheen and a chip over a foil card", () => {
    const { container } = render(<CardArt cardId="unf" name="Sole Performer" finish="foil" />);
    expect(container.querySelector("[data-foil-sheen]")).toBeInTheDocument();
    // The chip's glyph, found through the DOM rather than the a11y tree — see below for why
    // it is not in the latter.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  /**
   * **The overlay is decoration, all of it — chip included.**
   *
   * This frame usually sits *inside* a button, and a button's accessible name is computed
   * from its contents, so a chip that named itself turned a wall of foil tiles into buttons
   * called "Consecrated Sphinx Foil". Measured over CDP in the shipped window 2026-08-11,
   * where a tile button's accessible name came back as bare "Foil".
   *
   * The same trap the owned badge avoids by being a *sibling* of the button rather than a
   * child of it. Nothing is lost: every surface states the finish in text where it has room —
   * the wall's caption carries an `sr-only` word, the search table a `FinishMark` in its Name
   * cell, the pane one per finish price. This test is what stops the chip being "helpfully"
   * re-exposed.
   */
  it("keeps the whole foil overlay out of the accessibility tree", () => {
    const { container } = render(
      <button type="button">
        <CardArt cardId="unf" name="Sole Performer" finish="foil" />
      </button>,
    );
    // The claim, stated the way the platform states it: the *computed* name, which is what a
    // screen reader announces. (`queryByLabelText` is no use here — it matches the attribute
    // wherever it sits, `aria-hidden` ancestors included, so it would fail on correct code.)
    expect(screen.getByRole("button")).toHaveAccessibleName("Sole Performer");
    // And the mechanism that makes it true, so a failure says which half broke.
    const overlay = container.querySelector("[data-foil-sheen]")?.parentElement;
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  /**
   * Etched is a third thing and never a kind of foil, so it gets a glyph of its own. Compared
   * by rendered markup because neither is in the accessibility tree.
   */
  it("marks etched with a different glyph than foil", () => {
    const { container: foil } = render(<CardArt cardId="a" name="A" finish="foil" />);
    const { container: etched } = render(<CardArt cardId="b" name="B" finish="etched" />);
    const glyph = (c: HTMLElement) => c.querySelector("svg")?.innerHTML;
    expect(glyph(foil)).toBeTruthy();
    expect(glyph(etched)).not.toBe(glyph(foil));
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
