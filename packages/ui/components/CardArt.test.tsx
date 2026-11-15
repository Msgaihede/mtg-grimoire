import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import { CardArt } from "./CardArt";

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

  /**
   * **`nonfoil` is the regular copy and draws what `null` draws** — issue #616. A managed wish
   * stores the word in `preferred_finish`, a collection row in `finish`, and every caller that
   * handed it through raw drew a holo sheen over plain cardboard (#566 was the same bug one tab
   * over). The overlay maps it itself now, so no caller can reopen it.
   */
  it("draws neither a sheen nor a chip for a copy stated nonfoil", () => {
    const { container } = render(<CardArt cardId="tok" name="Treasure" finish="nonfoil" />);
    expect(container.querySelector("[data-foil-sheen]")).not.toBeInTheDocument();
    expect(container.querySelector("[data-card-marks]")).not.toBeInTheDocument();
  });

  /** The word takes the sheen away and nothing else: a named nonfoil copy keeps its chip. */
  it("keeps a treatment's chip on a nonfoil copy, with no sheen under it", () => {
    const { container } = render(
      <CardArt
        cardId="ser"
        name="Serialized"
        finish="nonfoil"
        treatments={[{ id: "serialized", label: "Serialized", foil: false }]}
      />,
    );
    expect(container.querySelector("[data-foil-sheen]")).not.toBeInTheDocument();
    expect(container.querySelector("[data-card-marks]")).toBeInTheDocument();
  });

  it("draws no marks at all for a card with nothing to mark", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(container.querySelector("[data-card-marks]")).not.toBeInTheDocument();
  });

  /**
   * **Each kind of foil is its own drawing** (2026-11-15). Scryfall photographs a printing sold
   * plain and in surge foil as the plain card, so a Surge Foil copy that drew the one shared
   * sheen looked like any other foil — the owner's report. The kind comes from the treatments the
   * caller already passes for the chip.
   */
  describe("the foil's drawing", () => {
    const surge = [{ id: "surgefoil", label: "Surge Foil", foil: true }];
    const overlayOf = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-foil]");

    it("draws a Surge Foil copy as surge, with its own pattern", () => {
      const { container } = render(
        <CardArt cardId="fic" name="Swords to Plowshares" finish="foil" treatments={surge} />,
      );
      const overlay = overlayOf(container);
      expect(overlay).toHaveAttribute("data-foil", "surge");
      expect(overlay?.querySelectorAll(".foil-pattern, .foil-pattern-2")).toHaveLength(2);
      // The blotches arrive as a property the stylesheet masks with, addressed by the bundler.
      expect(overlay?.style.getPropertyValue("--foil-tex-1")).toMatch(/^url\(/);
    });

    it("draws an etched copy as etched", () => {
      const { container } = render(<CardArt cardId="mh2" name="Angelic Curator" finish="etched" />);
      expect(overlayOf(container)).toHaveAttribute("data-foil", "etched");
    });

    /** Traditional foil is the sheen and the glare alone: two spans, and no picture to fetch. */
    it("draws an ordinary foil with no pattern layers and no texture", () => {
      const { container } = render(<CardArt cardId="dmr" name="Counterspell" finish="foil" />);
      const overlay = overlayOf(container);
      expect(overlay).toHaveAttribute("data-foil", "foil");
      expect(overlay?.querySelector(".foil-pattern")).toBeNull();
      expect(overlay?.style.getPropertyValue("--foil-tex-1")).toBe("");
    });

    /** A crown with no foil has no light to move, so the overlay is no `[data-foil]`. */
    it("draws no drawing for a game changer that is not foil", () => {
      const { container } = render(<CardArt cardId="pcy" name="Rhystic Study" gameChanger />);
      expect(overlayOf(container)).toBeNull();
    });
  });

  /**
   * **The light follows the pointer anywhere in the window, at full strength, and the card never
   * moves** — the owner's calls: "no tilt, but keep the motion follows cursor", then "the foils
   * should react to the cursor moving anywhere in the window" and "full strength even when not
   * hovered". jsdom lays nothing out, so every frame's box is given here.
   */
  describe("the foil's light", () => {
    // The suite restores nothing by itself, and a reduced-motion `matchMedia` left behind would
    // quietly hold every later light still.
    afterEach(() => vi.restoreAllMocks());
    const BOX = { left: 0, top: 0, width: 100, height: 140, right: 100, bottom: 140, x: 0, y: 0 };
    const boxAt = (box: typeof BOX) =>
      vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockReturnValue({ ...box, toJSON: () => box });
    const mountFoil = () => {
      const { container } = render(<CardArt cardId="dmr" name="Counterspell" finish="foil" />);
      const overlay = container.querySelector<HTMLElement>("[data-foil]");
      if (!overlay) throw new Error("no foil overlay");
      return overlay;
    };
    // A `MouseEvent` named `pointermove`, so `clientX` is set whatever jsdom's `PointerEvent` is —
    // dispatched on the window, nowhere near the card.
    const pointer = (x: number, y: number, pointerType = "mouse") => {
      const event = new MouseEvent("pointermove", { clientX: x, clientY: y });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      act(() => void window.dispatchEvent(event));
    };
    const light = (overlay: HTMLElement) => ({
      mx: overlay.style.getPropertyValue("--foil-mx"),
      on: overlay.style.getPropertyValue("--foil-on"),
    });
    const REST = { mx: "32.0%", on: "1" };

    it("rests at full strength, follows a mouse anywhere in the window, and rests when it leaves", () => {
      boxAt(BOX);
      const overlay = mountFoil();
      expect(light(overlay)).toEqual(REST);
      // Far to the card's right, outside it altogether: the light turns all the way toward it.
      pointer(900, 70);
      expect(Number.parseFloat(light(overlay).mx)).toBeGreaterThan(90);
      expect(light(overlay).on).toBe("1");
      // Far to its left now.
      pointer(-800, 70);
      expect(Number.parseFloat(light(overlay).mx)).toBeLessThan(10);
      // `relatedTarget` null: the pointer has left the window.
      act(() => void window.dispatchEvent(new MouseEvent("pointerout")));
      expect(light(overlay)).toEqual(REST);
    });

    it("lights a card mounted while the pointer is already in the window", () => {
      boxAt(BOX);
      const first = mountFoil();
      pointer(900, 70);
      const second = mountFoil();
      expect(light(second)).toEqual(light(first));
      expect(Number.parseFloat(light(second).mx)).toBeGreaterThan(90);
    });

    it("relights the cards that moved under a still pointer when the page scrolls", () => {
      const box = boxAt(BOX);
      const overlay = mountFoil();
      pointer(150, 70);
      const before = light(overlay).mx;
      // The wall scrolled the card 600px to the right of where it was, under the same pointer.
      const moved = { ...BOX, left: 600, right: 700, x: 600 };
      box.mockReturnValue({ ...moved, toJSON: () => moved });
      act(() => void document.body.dispatchEvent(new Event("scroll")));
      expect(Number.parseFloat(light(overlay).mx)).toBeLessThan(Number.parseFloat(before));
    });

    /** A touch has no hover, and a light that jumped to wherever a scroll began would be noise. */
    it("leaves the light at rest under a finger", () => {
      boxAt(BOX);
      const overlay = mountFoil();
      pointer(75, 70, "touch");
      expect(light(overlay)).toEqual(REST);
    });

    /** WCAG 2.3.3: a reader who asked the OS for less motion gets a still light. */
    it("leaves the light at rest for a reader who asked for less motion", () => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("reduce"),
            media: query,
            addEventListener() {},
            removeEventListener() {},
          }) as unknown as MediaQueryList,
      );
      boxAt(BOX);
      const overlay = mountFoil();
      pointer(75, 70);
      expect(light(overlay)).toEqual(REST);
    });
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
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent("Game Changer · Foil");
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
    // a prefix of the foil card's "Game Changer · Foil" above, so a stale or wrongly-suffixed
    // panel here would pass a substring check just as readily as the correct one.
    expect(document.getElementById(TOOLTIP_PANEL_ID)?.textContent).toBe("Game Changer");
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
   * **`remoteSrc` is the share viewer's door and nothing else's.** That page has no `mtgimg`
   * protocol to ask, so its `ShareTile` supplies the snapshot's own Scryfall URL — through
   * `components/CardTile`, the one caller that passes the prop on to this frame; every app surface
   * supplies nothing and draws the local cache. Getting it backwards is silent in both directions
   * — an app wall drawing Scryfall's URL would refetch a screenful of art the cache already holds,
   * over the network, on every scroll, and still draw cards.
   */
  const REMOTE = "https://cards.scryfall.io/large/front/0/0/0000419b.jpg?1706230661";

  it("draws the cached protocol picture when it is handed no remote picture", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" />);

    const img = screen.getByRole("img", { name: "Lightning Bolt" });
    expect(img).toHaveAttribute("src", expect.stringContaining("/display/bolt/0"));
    expect(img.getAttribute("src")).not.toContain("scryfall.io");
  });

  it("draws the remote picture it was handed, verbatim, with no card id", () => {
    render(<CardArt cardId={null} name="Lightning Bolt" remoteSrc={REMOTE} />);

    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toHaveAttribute("src", REMOTE);
  });

  /**
   * `null` is *present*: a snapshot row with no picture. The failure this prevents is a
   * *broken image*, not a missing one — the frame already knows how to draw a named, empty card,
   * and the name is what the reader came for. It must not fall through to the cache either,
   * which a page with no protocol cannot reach.
   */
  it("draws the named no-art frame for a remote picture of null, and fetches nothing", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" remoteSrc={null} />);

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
