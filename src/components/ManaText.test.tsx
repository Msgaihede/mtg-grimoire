import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManaText } from "./ManaText";

describe("ManaText", () => {
  it("draws each symbol with the bundled font rather than printing its braces", () => {
    const { container } = render(<ManaText source="{2}{U}" />);

    expect(container.querySelectorAll("i.ms-2, i.ms-u")).toHaveLength(2);
    // The braces are the wire format, not the card: `{2}{U}` on screen is what this
    // component exists to stop.
    expect(container.textContent).not.toContain("{");
  });

  /**
   * A glyph is a font `::before`, which is nothing at all to a screen reader. Without a
   * text equivalent the cost simply is not there for one — and a cost is the single most
   * load-bearing string on a Magic card.
   */
  it("still says the cost for a reader who cannot see the glyphs", () => {
    const { container } = render(<ManaText source="{2}{U}" />);

    // "2 U", not "2U": adjacent tokens with no space between them reach a screen reader as
    // one word it will try to pronounce.
    expect(container).toHaveTextContent("2 U");
  });

  /**
   * The text equivalents sit *beside* each glyph rather than being one label for the whole
   * run — a label would be a second copy of every word in a line of rules text, and a
   * screen reader would read the ability twice.
   */
  it("never reads the prose twice", () => {
    const { container } = render(<ManaText source="Flying" />);

    expect(container.textContent).toBe("Flying");
  });

  it("prints a symbol the font has no glyph for instead of dropping it", () => {
    const { container } = render(<ManaText source="{HW}" />);

    expect(container.querySelectorAll("i")).toHaveLength(0);
    expect(container).toHaveTextContent("{HW}");
  });

  /** Rules text is symbols with prose around it, and the prose has to survive. */
  it("keeps the words around a symbol in rules text", () => {
    const { container } = render(<ManaText source="{T}: Add {G}." />);

    expect(container).toHaveTextContent(": Add");
    expect(container.querySelector("i.ms-tap")).toBeInTheDocument();
  });

  it("renders nothing at all for a card with no cost", () => {
    const { container } = render(<ManaText source={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
