import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { finishTreatments } from "@/lib/treatment";
import { FinishMark } from "./FinishMark";

/** MUL 133 — the card in issue #160's screenshot, which drew the same glyph as a plain foil. */
const HALO = finishTreatments('["halofoil"]', "foil");

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

  /**
   * Issue #160: a Surge Foil, a Halo Foil and an ordinary foil were one glyph with one word
   * behind it. The name replaces the finish's rather than joining it — "Halo Foil, foil" would
   * say one thing twice.
   */
  it("says what a named copy is called instead of saying `Foil`", () => {
    render(<FinishMark finish="foil" treatments={HALO} />);
    expect(screen.getByLabelText("Halo Foil")).toBeInTheDocument();
    expect(screen.queryByLabelText("Foil")).toBeNull();
  });

  /** A third glyph, for the reason etched has a second one: told apart at 12px or not at all. */
  it("gives a named copy a glyph of its own", () => {
    const { container: plain } = render(<FinishMark finish="foil" />);
    const { container: etched } = render(<FinishMark finish="etched" />);
    const { container: named } = render(<FinishMark finish="foil" treatments={HALO} />);
    expect(named.innerHTML).not.toBe(plain.innerHTML);
    expect(named.innerHTML).not.toBe(etched.innerHTML);
  });

  /**
   * **The whole list, joined**, because this is an accessible name and a tooltip and both have
   * the room. MUL 133z is two true things about one card and dropping either would say less
   * than the reader's own cardboard does.
   */
  it("joins every treatment a copy carries", () => {
    render(
      <FinishMark
        finish="foil"
        treatments={finishTreatments('["serialized","doublerainbow"]', "foil")}
      />,
    );
    expect(screen.getByLabelText("Double Rainbow Foil · Serialized")).toBeInTheDocument();
  });

  /**
   * **A trait outlives the finish**, which is what lets 1 718 printings that draw nothing today
   * carry a mark: serialized cardboard is serialized in whatever finish you hold it. The
   * nonfoil rule above is about a card with *nothing* to say, not about the finish alone.
   */
  it("draws a plain copy that has a name of its own", () => {
    render(<FinishMark finish="nonfoil" treatments={finishTreatments('["serialized"]', "nonfoil")} />);
    expect(screen.getByLabelText("Serialized")).toBeInTheDocument();
  });

  /** An empty list is the 95 % of the corpus with no name beyond its finish — unchanged. */
  it("is unchanged by an empty treatment list", () => {
    const { container: bare } = render(<FinishMark finish="foil" />);
    const { container: empty } = render(<FinishMark finish="foil" treatments={[]} />);
    expect(empty.innerHTML).toBe(bare.innerHTML);
    expect(render(<FinishMark finish="nonfoil" treatments={[]} />).container).toBeEmptyDOMElement();
  });
});
