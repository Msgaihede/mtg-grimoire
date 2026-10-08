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
   *
   * The two cases are *not* one case: a null rarity has no word to tint, while `special` is
   * a real word the fallback would happily paint at about 1.9:1 on the app background —
   * legible to nobody, and below the AA floor the direction sets as a quality baseline.
   */
  it("never tints a word with the no-token fallback", () => {
    const { rerender } = render(<RarityGem rarity={null} withLabel />);
    expect(screen.getByText("unknown")).not.toHaveStyle({ color: "var(--color-border)" });

    rerender(<RarityGem rarity="special" withLabel />);
    const special = screen.getByText("special");
    expect(special).not.toHaveStyle({ color: "var(--color-border)" });
    // And it stays dim text rather than losing its colour altogether.
    expect(special).toHaveClass("text-dim");

    rerender(<RarityGem rarity="bonus" withLabel />);
    expect(screen.getByText("bonus")).not.toHaveStyle({ color: "var(--color-border)" });
  });

  /** The gem itself still carries the fallback: a dot in the hairline colour reads as "no
   *  rarity stated", which is the truth, and it is 6px of decoration rather than a label. */
  it("still draws the gem for a rarity it has no token for", () => {
    const { container } = render(<RarityGem rarity="special" withLabel />);

    expect(container.querySelector('[aria-hidden="true"]')).toHaveStyle({
      backgroundColor: "var(--color-border)",
    });
  });

  /** The dot is decoration; the word beside it already carries the fact. */
  it("hides the gem from assistive tech", () => {
    const { container } = render(<RarityGem rarity="common" withLabel />);

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
