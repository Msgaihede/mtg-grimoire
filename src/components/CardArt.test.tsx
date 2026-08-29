import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { isWebTarget } from "@/pwa/target";
import { CardArt } from "./CardArt";

/** Which build this frame is drawing in — a build-time `define`, so a mock is the only way to
 *  see the web branch. Desktop by default, which is what the real module answers here. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

beforeEach(() => {
  vi.mocked(isWebTarget).mockReturnValue(false);
});

const mount = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

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

  it("draws no marks at all for a card with nothing to mark", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(container.querySelector("[data-card-marks]")).not.toBeInTheDocument();
  });

  /**
   * **A game changer gets the chip and never the sheen.** The sheen is a photograph of what
   * the cardboard does to light, and a game changer's cardboard does nothing special — it is
   * an ordinary card the Commander bracket happens to count. Marking it as if it were foil
   * would say something false about the object.
   */
  it("crowns a game changer without pretending it is foil", () => {
    const { container } = render(<CardArt cardId="pcy" name="Rhystic Study" gameChanger />);

    const chip = container.querySelector("[data-card-marks]");
    expect(chip?.querySelector(".lucide-crown")).toBeInTheDocument();
    expect(container.querySelector("[data-foil-sheen]")).not.toBeInTheDocument();
  });

  /**
   * A game changer is a fact about the *card* and a finish a fact about the *printing*, so a
   * foil-only printing of a game changer carries both — and it carries them in **one** chip.
   * A tile's fourth corner is the only one left (the other three are the owned badge, the
   * printing count and the caption), and a second box beside this one would start a row of
   * stickers over the art.
   */
  it("puts both marks in one chip when a card is a foil-only game changer", () => {
    const { container } = render(
      <CardArt cardId="mp2" name="Consecrated Sphinx" finish="foil" gameChanger />,
    );

    const chips = container.querySelectorAll("[data-card-marks]");
    expect(chips).toHaveLength(1);
    expect(chips[0].querySelectorAll("svg")).toHaveLength(2);
    expect(chips[0].querySelector(".lucide-crown")).toBeInTheDocument();
    expect(container.querySelector("[data-foil-sheen]")).toBeInTheDocument();
  });

  /**
   * **The bug this chip existed with for its whole life.** `pointer-events` inherits, so the
   * chip took the overlay wrapper's `none` and was never a hit target — and a tooltip is shown
   * by the element the pointer *hits*, so the `<title>` inside every glyph in it could not
   * appear at all. The wrapper keeps `none`, because a full-bleed sheen inside a button really
   * would swallow every click; the chip alone takes it back.
   */
  it("makes the chip hoverable so its tooltip can appear", () => {
    const { container } = render(<CardArt cardId="mp2" name="Consecrated Sphinx" finish="foil" />);

    const chip = container.querySelector("[data-card-marks]");
    expect(chip).toHaveClass("pointer-events-auto");
    expect(chip).not.toHaveClass("pointer-events-none");
    // And the sheen it shares a wrapper with stays untouchable.
    expect(chip?.parentElement).toHaveClass("pointer-events-none");
  });

  /**
   * The chip's padding is hoverable too, so it says in words whichever facts it is drawing —
   * through `useTooltip()` now rather than a native `title`, so this hovers the chip and reads
   * the app's own panel rather than an attribute. `describes: false` because the words are
   * decoration (see the overlay's own `aria-hidden`, above): no `aria-describedby` is wired.
   */
  it("names both facts on the chip itself", () => {
    vi.useFakeTimers();
    const { container, rerender } = mount(
      <CardArt cardId="mp2" name="Consecrated Sphinx" finish="foil" gameChanger />,
    );
    const chip = () => container.querySelector<HTMLElement>("[data-card-marks]");
    fireEvent.pointerEnter(chip()!);
    advance(TOOLTIP_OPEN_MS);
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent("Game changer · Foil");
    expect(chip()).not.toHaveAttribute("aria-describedby");
    fireEvent.pointerLeave(chip()!);

    rerender(
      <TooltipProvider>
        <CardArt cardId="pcy" name="Rhystic Study" gameChanger />
      </TooltipProvider>,
    );
    fireEvent.pointerEnter(chip()!);
    advance(TOOLTIP_OPEN_MS);
    // Exact, not a substring: this card carries no `finish`, so the panel must read "Game
    // changer" alone — `toHaveTextContent`'s string form is `.includes()`, and "Game changer" is
    // a prefix of the foil card's "Game changer · Foil" above, so a stale or wrongly-suffixed
    // panel here would pass a substring check just as readily as the correct one.
    expect(document.getElementById(TOOLTIP_PANEL_ID)?.textContent).toBe("Game changer");
    vi.useRealTimers();
  });

  /**
   * The crown is held to the chip's own rule (see above): a wall of game changers must not
   * become forty buttons called "Rhystic Study Game changer". A `title` attribute is excluded
   * on the same terms — name computation skips an `aria-hidden` subtree whole — while the
   * browser still shows it on hover, which is what makes the tooltip and the quiet name
   * compatible rather than a trade.
   */
  it("keeps the crown out of the enclosing button's name", () => {
    render(
      <button type="button">
        <CardArt cardId="pcy" name="Rhystic Study" gameChanger />
      </button>,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("Rhystic Study");
  });

  /**
   * **The frame takes a URL and never asks what platform it is on**, which is the whole
   * arrangement: `cardArtSrc` in `@/lib/images` owns the branch, and these three tests are what
   * say the frame is wired to it rather than to a check of its own.
   *
   * A row carries `imageUris` on **both** builds — one DTO, one shape — so the desktop half is
   * "the local cache still wins", not "nothing was passed". Preferring the supplied URL there
   * would refetch a screenful of art the cache already holds, over the network, on every scroll,
   * and it would still draw cards: there is nothing on screen to catch it.
   */
  const SUPPLIED = "https://cards.scryfall.io/large/front/0/0/0000419b.jpg?1706230661";

  it("keeps drawing the cached protocol picture on desktop when a row hands it a URL", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" imageUrl={SUPPLIED} />);

    const img = screen.getByRole("img", { name: "Lightning Bolt" });
    expect(img).toHaveAttribute("src", expect.stringContaining("/display/bolt/0"));
    expect(img.getAttribute("src")).not.toContain("scryfall.io");
  });

  it("draws the URL it was handed on the web build, where there is no protocol to ask", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    render(<CardArt cardId="bolt" name="Lightning Bolt" imageUrl={SUPPLIED} />);

    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toHaveAttribute("src", SUPPLIED);
  });

  /**
   * The failure this prevents is a *broken image*, not a missing one: a browser handed
   * `mtgimg://` for a printing Scryfall has no picture of would draw the platform's own broken
   * icon under the card's name. The frame already knows how to say "No image", and it is still
   * a card — the name is what the reader came for.
   */
  it("draws the no-art frame on web for a card whose row carries no picture", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    render(<CardArt cardId="bolt" name="Lightning Bolt" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    // "No image" and not "No card": the printing exists, its picture does not.
    expect(screen.getByText("No image")).toBeInTheDocument();
  });

  /** The face and the variant both reach the URL, which is what keys the image. */
  it("asks for the face and variant it was given", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" face={1} variant="art" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", expect.stringContaining("/art/bolt/1"));
  });

  /**
   * **The edge `CardChin` continues.**
   *
   * Every surface that draws this frame now draws a chin under it, and the chin joins whichever
   * outline its host has: under the deck's stacks that host is a bordered card and the two read
   * as one object, while under a frame with no edge of its own the picture simply *stopped* and a
   * bordered bar *started*. A reader reported that as a rough cut-off. Removing the edge here is
   * therefore removing half of a join, and the half that is left still looks deliberate — which
   * is exactly the kind of regression a wall of tiles hides.
   *
   * **`classList.contains`, never `className.toContain`.** `"border-border"` contains the
   * substring `border`, so the obvious spelling is satisfied by the colour alone and would pass
   * on a frame that draws no edge at all; and `"border-border"` contains `border-b` too, which is
   * the shape this repo has been bitten by more than once.
   *
   * A class string rather than a painted pixel, because jsdom has no Tailwind and no layout — the
   * seam itself is a live-window question and was settled there.
   */
  it("draws its own edge, in the colour the chin under it uses", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    const frame = container.firstElementChild;

    expect(frame?.classList.contains("border")).toBe(true);
    expect(frame?.classList.contains("border-border")).toBe(true);
  });

  /**
   * **The edge and the ring are two marks on one element, and both still read.**
   *
   * A ring is a box shadow with spread — painted *outside* the border box — so the gold sits
   * against the new edge rather than replacing it, and the frame keeps both. Worth pinning
   * because the tidy-looking fix for "two lines round one card" is to drop one of them, and the
   * one that would go is the edge that has no state behind it.
   */
  it("keeps the picked ring beside that edge rather than instead of it", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" selected />);
    const frame = container.firstElementChild;

    expect(frame?.classList.contains("ring-2")).toBe(true);
    expect(frame?.classList.contains("ring-accent")).toBe(true);
    expect(frame?.classList.contains("border-border")).toBe(true);
  });
});
