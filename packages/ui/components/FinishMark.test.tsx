import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { finishTreatments } from "@/lib/treatment";
import { FinishMark } from "./FinishMark";

/** MUL 133 — the card in issue #160's screenshot, which drew the same glyph as a plain foil. */
const HALO = finishTreatments('["halofoil"]', "foil");

/**
 * The **artwork** one render drew, with the label left out — which is the half issue #353 is
 * about, and the half a treatment is allowed to change is the other one.
 *
 * It throws on a missing glyph rather than answering `undefined`, because two `undefined`s
 * compare equal: a `toBe` over `querySelector("svg")?.innerHTML` passes just as loudly when the
 * component drew nothing at all, and this file's whole subject is which of three pictures got
 * drawn.
 */
function glyphOf(container: HTMLElement): string {
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("FinishMark drew no glyph");
  return svg.innerHTML;
}

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

  /**
   * **Issue #353, and it is the assertion the old one inverted.** A treatment renames the mark
   * and must not redraw it: a Halo Foil is a foil, so it is the app's one foil icon with a
   * longer word behind it. The glyph swap this replaces is what let one Surge Foil be two
   * different pictures — an `Aperture` on the printings wall, a `Sparkles` in the card pane's
   * foil toggle and the deck card menu, which draw the finish and never saw a treatment.
   *
   * The glyph's own `innerHTML` rather than the container's, because the label legitimately
   * differs — that is the half a treatment is allowed to change.
   */
  it("draws a named foil as the same glyph as a plain one", () => {
    const plain = glyphOf(render(<FinishMark finish="foil" />).container);
    const named = glyphOf(render(<FinishMark finish="foil" treatments={HALO} />).container);
    expect(plain).toBe(named);
  });

  /** The same rule one finish over: an etched copy with a name is still drawn as etched. */
  it("draws a named etched copy as the same glyph as a plain one", () => {
    const plain = glyphOf(render(<FinishMark finish="etched" />).container);
    const named = glyphOf(
      render(<FinishMark finish="etched" treatments={finishTreatments('["serialized"]', "etched")} />)
        .container,
    );
    expect(screen.getByLabelText("Serialized")).toBeInTheDocument();
    expect(plain).toBe(named);
  });

  /**
   * The one place a third glyph survives, and the reason it has to: a plain copy has no finish
   * glyph to keep, so without this the 1 718 unusual-but-not-shiny printings draw nothing.
   */
  it("gives a named plain copy a glyph of its own", () => {
    const foil = glyphOf(render(<FinishMark finish="foil" />).container);
    const etched = glyphOf(render(<FinishMark finish="etched" />).container);
    const trait = glyphOf(
      render(<FinishMark finish="nonfoil" treatments={finishTreatments('["poster"]', "nonfoil")} />)
        .container,
    );
    expect(trait).not.toBe(foil);
    expect(trait).not.toBe(etched);
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
