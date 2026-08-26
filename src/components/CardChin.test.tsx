import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_OPEN_MS, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { CHIN_RISE, chinHeight } from "@/lib/cardZoom";
import { CardChin } from "./CardChin";

describe("CardChin", () => {
  /** The default printing line is the set and the number, which is what fits on a card's foot. */
  it("writes the set and the number when given no printing of its own", () => {
    render(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" />);
    expect(screen.getByText(/C21 · 179/)).toBeInTheDocument();
  });

  /**
   * The caller's words win, because a wish for *any* printing is drawn as one and must not be
   * captioned as one — a caption reading `DSK · 123` under that art would say the reader had
   * asked for that piece of cardboard.
   */
  it("takes the caller's printing line over the default", () => {
    render(
      <CardChin rarity="rare" zoom={1} setCode="dsk" collectorNumber="123" printing="Any printing" />,
    );
    expect(screen.getByText("Any printing")).toBeInTheDocument();
    expect(screen.queryByText(/DSK · 123/)).not.toBeInTheDocument();
  });

  /** The money slot, and an em dash where a caller has nothing — never `$0.00`. */
  it("draws the money it is given", () => {
    render(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" money="$12.32" />);
    expect(screen.getByText("$12.32")).toBeInTheDocument();
  });

  /**
   * Nonfoil draws no glyph — it is the finish a price is assumed to be. The mark is `FinishMark`'s
   * own rule; the chin only has to not force one.
   */
  it("marks a foil and leaves a nonfoil unmarked", () => {
    const { rerender } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" finish="foil" />,
    );
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
    rerender(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" finish="nonfoil" />);
    expect(screen.queryByLabelText("Foil")).not.toBeInTheDocument();
  });

  /**
   * The height is the card's, at this zoom, and the rise is what joins the two boxes into one
   * object. jsdom cannot see the seam; it can see the two numbers that make it.
   */
  it("is as tall as the card's chin at this zoom, and rides up by the rise", () => {
    const { container } = render(
      <CardChin rarity="rare" zoom={0.5} setCode="c21" collectorNumber="179" />,
    );
    const chin = container.firstElementChild as HTMLElement;
    expect(chin.style.height).toBe(`${chinHeight(0.5)}px`);
    expect(chin.style.marginTop).toBe(`-${CHIN_RISE}px`);
  });

  /**
   * **The chin's edges are the card's edges**, and the two hosts own their outline differently.
   * Under a bordered card the chin draws `border-x` only — the card's own border is the bottom
   * edge, and a `border-b` here would sit 1px above it, which is a 2px foot on a card whose
   * everything-else is 1px. Under bare art it supplies all three.
   *
   * `classList.contains`, not `className.includes`: a substring match passes on `border-x` when
   * the class is `border-x-2`, and this assertion is the only thing standing between the two seams.
   */
  it("lets the card own the bottom edge and the art not", () => {
    const { container: card } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="card" />,
    );
    const { container: art } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="art" />,
    );
    expect((card.firstElementChild as HTMLElement).classList.contains("border-b")).toBe(false);
    expect((art.firstElementChild as HTMLElement).classList.contains("border-b")).toBe(true);
  });

  /**
   * A card that breaks a rule is outlined in destructive, and the chin's border paints **over**
   * the card's along every pixel of its height — it is `relative` and later in the document. So
   * the two are one line drawn by two elements and they have to agree, or the card stops reading
   * as a single object exactly where the foot joins the face.
   */
  it("carries the card's own edge colour", () => {
    const { container } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" tone="destructive" />,
    );
    const chin = container.firstElementChild as HTMLElement;
    expect(chin.classList.contains("border-destructive")).toBe(true);
    expect(chin.classList.contains("border-border")).toBe(false);
  });

  /**
   * **The seam is a geometry as well as a set of edges, and the geometry is the half nothing else
   * can see.** `-mx-px` is what pulls the chin a pixel wider than the card on each side so its
   * border lands *on top of* the card's rather than a pixel inside it — the two are then one line
   * drawn by two elements. Drop it and the chin is a 210px bar under a 212px card, which jsdom
   * cannot see, a screenshot barely can, and neither the seam nor the tone test above would
   * notice.
   *
   * The two radii are the two hosts' own corners rather than a preference: the stack's face clips
   * at `rounded-[7px]` inside a `rounded-lg` border, so the chin closing that card matches the
   * face; bare `CardArt` is `rounded-lg` outright, so the chin closing that one matches the art.
   * A chin wearing the wrong one is a corner that misses its host by a pixel of curve.
   *
   * `classList.contains` throughout, never `className.includes` — a substring match passes on
   * `border-x` when the class is `border-x-2`.
   */
  it("rides onto the card's border and wears each host's own corner", () => {
    const { container: card } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="card" />,
    );
    const { container: art } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="art" />,
    );
    const cardChin = card.firstElementChild as HTMLElement;
    const artChin = art.firstElementChild as HTMLElement;

    expect(cardChin.classList.contains("-mx-px")).toBe(true);
    expect(cardChin.classList.contains("rounded-b-[7px]")).toBe(true);
    expect(cardChin.classList.contains("rounded-b-lg")).toBe(false);

    // The art frame has no border to ride onto, so the chin must sit exactly as wide as it.
    expect(artChin.classList.contains("-mx-px")).toBe(false);
    expect(artChin.classList.contains("rounded-b-lg")).toBe(true);
    expect(artChin.classList.contains("rounded-b-[7px]")).toBe(false);
  });

  /**
   * The deck is the only caller that passes an `extra` — the `owned/wanted` shortage — and it has
   * to land **after** the price. `$12.32` `1/2` is a price and then a shortage; `1/2` `$12.32`
   * reads as though the figure before the money were part of it.
   */
  it("draws the extra after the money", () => {
    render(
      <CardChin
        rarity="rare"
        zoom={1}
        setCode="c21"
        collectorNumber="179"
        money="$12.32"
        extra={<span>1/2</span>}
      />,
    );
    const money = screen.getByText("$12.32");
    const extra = screen.getByText("1/2");
    // `DOCUMENT_POSITION_FOLLOWING` is the question asked directly: is the shortage after the
    // price in document order? A text match on the chin would answer about adjacency instead.
    expect(money.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * **The tooltip is on the printing line, and it is only observable through the provider.**
   *
   * `useTooltip` returns event handlers and nothing else — no `title`, no `aria-*` — so a title
   * that is bound and a title that is not render byte-identical DOM. `aria-describedby` is
   * written by `TooltipProvider` when the panel actually opens, {@link TOOLTIP_OPEN_MS} after the
   * pointer arrives, which is why this is the one thing here that needs a provider and a clock.
   * (A `[role=tooltip]` probe is not always the way in — a `describes: false` binding carries no
   * role at all — but this chin passes no options, so `describes` is its default `true` and the
   * panel is a real `tooltip`.)
   */
  describe("the printing line's tooltip", () => {
    // Fake timers because the open is a schedule, and a real-clock test of a 400ms delay is a
    // flake waiting for a loaded machine. `fireEvent`, never `userEvent`, which hangs on a fake
    // clock.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("hangs the set's name on the printing line", () => {
      render(
        <TooltipProvider>
          <CardChin
            rarity="rare"
            zoom={1}
            setCode="c21"
            collectorNumber="179"
            printingTitle="Commander 2021 · #179"
          />
        </TooltipProvider>,
      );
      // The line the reader sees is the anchor: `C21` is what fits on a card's foot, and the set's
      // name is one hover away because `PF26` is not a word anybody knows.
      fireEvent.pointerEnter(screen.getByText("C21 · 179"));
      act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));

      expect(screen.getByRole("tooltip")).toHaveTextContent("Commander 2021 · #179");
    });

    /**
     * An orphan printing — one `cards` has no set name for — gets **no tooltip**, rather than
     * being annotated with a guess. This is what would catch a `?? "Unknown set"` written into
     * that slot by someone who thought the empty case looked unfinished.
     */
    it("says nothing where the caller has no set name", () => {
      render(
        <TooltipProvider>
          <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" printingTitle={null} />
        </TooltipProvider>,
      );
      fireEvent.pointerEnter(screen.getByText("C21 · 179"));
      act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));

      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
