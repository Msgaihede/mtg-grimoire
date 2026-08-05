import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RarityGem } from "./RarityGem";

describe("RarityGem", () => {
  /**
   * The whole reason this is a component rather than a `<span>` at four call sites: a 6px
   * dot is colour-only information, and three of those four call sites had grown their own
   * `sr-only` label or their own `title` to make up for it. The word is always there.
   */
  it("names the rarity even when it only draws the gem", () => {
    const { container } = render(<RarityGem rarity="mythic" />);

    expect(screen.getByText("mythic")).toHaveClass("sr-only");
    expect(container).toHaveTextContent("Rarity: mythic");
  });

  it("prints the word, tinted, when asked to", () => {
    render(<RarityGem rarity="rare" withLabel />);

    const word = screen.getByText("rare");
    expect(word).not.toHaveClass("sr-only");
    expect(word).toHaveStyle({ color: "var(--color-rarity-rare)" });
  });

  /**
   * `special` and `bonus` exist in the data and have no token, and `rarity` is nullable
   * besides. The gem falls back to the border colour — so the word must not be tinted with
   * it, which would be a label drawn in the colour of a hairline.
   */
  it("says so when there is no rarity, and does not tint the word with the fallback", () => {
    render(<RarityGem rarity={null} withLabel />);

    const word = screen.getByText("unknown");
    expect(word).not.toHaveStyle({ color: "var(--color-border)" });
  });

  /** The dot is decoration; the word beside it already carries the fact. */
  it("hides the gem from assistive tech", () => {
    const { container } = render(<RarityGem rarity="common" withLabel />);

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
