import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinishMark } from "./FinishMark";

describe("FinishMark", () => {
  /**
   * The word, not the shape. A screen reader announcing "sparkles" beside a price would be
   * describing the icon rather than the card.
   */
  it("names the finish it marks", () => {
    render(<FinishMark finish="foil" />);
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
  });

  /**
   * Etched is a third thing and never a kind of foil — flattening it into `foil: true` is the
   * commonest way an importer loses data, and drawing them identically teaches that mistake.
   */
  it("gives etched a glyph of its own", () => {
    const { container: foil } = render(<FinishMark finish="foil" />);
    const { container: etched } = render(<FinishMark finish="etched" />);
    expect(screen.getByLabelText("Etched")).toBeInTheDocument();
    expect(foil.innerHTML).not.toBe(etched.innerHTML);
  });

  /** Nonfoil is the finish a price is assumed to be, so it is unmarked. */
  it("draws nothing for nonfoil", () => {
    const { container } = render(<FinishMark finish="nonfoil" />);
    expect(container).toBeEmptyDOMElement();
  });
});
