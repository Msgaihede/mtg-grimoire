import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import {
  CardSearchPanel,
  DEFAULT_PANEL_WIDTH_PX,
  MIN_PANEL_WIDTH_PX,
  SEARCH_OVER_ATTR,
  type SearchSurface,
} from "./CardSearchPanel";

/**
 * The shell on its own — **the half of the docked search column that has nothing to do with what
 * is searched.**
 *
 * `DeckSearchPanel.test.tsx`'s 51 cases are the proof that extracting this changed nothing, and
 * they go on being that. What this file adds is coverage of the shell as a *component with props*:
 * the three drawn states against a body that is one text field, the two gates that must stay two,
 * and the splitter's whole contract. None of it is a second copy of the deck's assertions — a
 * railing there is `roomy: false` on a panel full of Scryfall printings, and here it is the same
 * flag over an `<input>` whose value is the only thing that has to survive it.
 *
 * **jsdom lays nothing out**, so every geometric claim below is either an inline style (which the
 * component writes and is therefore real) or a class (which is the choice, drawn where a suite can
 * ask about it). Nothing here measures a box.
 */

/** The disclosure, by the name it takes from {@link Props.toggleLabel} — **a pattern, because the
 *  name says what pressing it does** and therefore changes with the state. The `$` anchor keeps it
 *  off `Resize card search`, which is a `separator` rather than a `button` anyway. */
const TOGGLE = /card search$/;

const SECTION = "Add cards";

interface Props {
  surface?: SearchSurface;
  roomy?: boolean;
  overWidth?: number;
  maxWidth?: number;
  tabs?: boolean;
  startOpen?: boolean;
}

/**
 * The panel with a body that is one uncontrolled text field.
 *
 * **Uncontrolled on purpose, and it is the whole of the mount-vs-hide assertion.** A field whose
 * value lives in the DOM keeps it exactly as long as its node is in the tree — so "the reader's
 * typing survived" and "the node was never unmounted" are the same claim, made without a store, a
 * query or a hook that could be answering instead.
 *
 * `open` is a `useState` here because the shell takes the pair as props: each of the three real
 * surfaces reads its own stored answer, and standing in for that with local state is what lets
 * this file drive a press without mocking a command.
 */
function Harness({
  surface = "deck",
  roomy,
  overWidth,
  maxWidth,
  tabs = false,
  startOpen = true,
}: Props) {
  const [open, setOpen] = useState(startOpen);
  return (
    <TooltipProvider>
      <CardSearchPanel
        surface={surface}
        title="Search cards"
        sectionLabel={SECTION}
        toggleLabel="card search"
        open={open}
        setOpen={setOpen}
        roomy={roomy}
        overWidth={overWidth}
        maxWidth={maxWidth}
        tabs={tabs ? <div role="group" aria-label="Search in" /> : undefined}
      >
        <input aria-label="Body field" />
      </CardSearchPanel>
    </TooltipProvider>
  );
}

function panel(props: Props = {}) {
  let current = props;
  const view = render(<Harness {...current} />);
  return {
    ...view,
    /** Re-render with one prop changed — what a page does when it re-measures the row the list
     *  and the panel share. */
    update: (patch: Props) => {
      current = { ...current, ...patch };
      view.rerender(<Harness {...current} />);
    },
  };
}

const section = () => screen.getByRole("region", { name: SECTION });
const toggle = () => screen.getByRole("button", { name: TOGGLE });
const handle = () => screen.getByRole("separator", { name: "Resize card search" });
const noHandle = () => screen.queryByRole("separator", { name: "Resize card search" });

/** One pointer event with a real `clientX` on it. Built as a `MouseEvent` rather than through
 *  `fireEvent.pointerDown`, for the reason `src/test-drag.ts` builds its own: jsdom ships no
 *  `PointerEvent`, so Testing Library's pointer helpers fall back to a plain `Event` and the
 *  coordinate never arrives. React dispatches on the event's **type**, not on its class. */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(handle(), event);
}

/** A whole drag: press at `from`, move to `to`, let go. Leftward is wider. */
function drag(from: number, to: number) {
  pointer("pointerdown", from);
  pointer("pointermove", to);
  pointer("pointerup", to);
}

describe("CardSearchPanel", () => {
  /**
   * **Three states, one element.** React reconciles by position, so two shapes either side of a
   * collapse would mean the disclosure is a *different* button — and the caret handed to the rail
   * when a card closes would be dropped again one commit later, around a freshly mounted copy of
   * it. The classes are the assertion because jsdom lays nothing out; the identity check at the
   * end is what would fail a "tidy" that split the two arms into separate roots.
   */
  describe("the three states it is drawn in", () => {
    it("docks beside the list at the reader's width", () => {
      panel();

      expect(section().classList.contains("relative")).toBe(true);
      expect(section()).toHaveStyle({ width: `${DEFAULT_PANEL_WIDTH_PX}px` });
      expect(section()).not.toHaveAttribute(SEARCH_OVER_ATTR);
      // The hairline down the left edge is the only chrome the panel adds, and it says
      // "everything right of this line is not your list".
      expect(section().classList.contains("border-l")).toBe(true);
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });

    it("collapses to a 36px rail that still says what it is", async () => {
      panel();
      const before = section();

      await userEvent.click(toggle());

      expect(section()).toBe(before);
      expect(section().classList.contains("w-9")).toBe(true);
      // The rail's width is the `w-9` class and never an inline number, so the reader's dragged
      // width cannot leak into a state that has no edge to drag. Read off the property rather
      // than the attribute: React empties the declaration and leaves a bare `style=""` behind.
      expect(section().style.width).toBe("");
      // The hairline is on the column in *both* states — a collapse changes what is in this
      // column, not what it is.
      expect(section().classList.contains("border-l")).toBe(true);
      expect(noHandle()).toBeNull();
      // The title turns on its side rather than disappearing, so 36px of chrome still names
      // itself. Found by the writing mode: the words are also the search box's name on a real
      // surface, and the two are on screen together whenever the body is drawn.
      const sideways = screen
        .getAllByText("Search cards")
        .filter((el) => el.style.writingMode === "vertical-rl");
      expect(sideways).toHaveLength(1);
      expect(sideways[0].classList.contains("self-center")).toBe(true);
      // **`text-center` is asserted absent rather than merely unused.** In `vertical-rl` the
      // inline axis runs down the page, so `text-align` moves the words along the rail rather
      // than across it — it is the class that reads as though it does this job, and a future
      // edit reaching for it is the failure this fence is for.
      expect(sideways[0].classList.contains("text-center")).toBe(false);
    });

    /**
     * **The door out of the rail.** `roomy` answers *is there room beside the list*, and below
     * that width the answer used to be the end of it — the disclosure refused and offered to
     * widen a window with no width to give. A page names the second placement by sending a width.
     */
    it("draws over the list at the width the page sends", () => {
      panel({ roomy: false, overWidth: 390 });

      expect(section()).toHaveAttribute(SEARCH_OVER_ATTR, "deck");
      expect(section().classList.contains("absolute")).toBe(true);
      expect(section()).toHaveStyle({ width: "390px" });
      // No hairline in the overlay: the panel is the whole row there, so a line down its left
      // edge is a line down the window.
      expect(section().classList.contains("border-l")).toBe(false);
      // The rail's 36px stays in the flow, so the list behind is laid out at exactly the width it
      // had before the press rather than being re-measured twice per disclosure.
      expect(section().previousElementSibling).toHaveClass("w-9");
      // Nothing to drag: the width is the row's, so the edge a handle would move is the window.
      expect(noHandle()).toBeNull();
    });

    /** The value discriminates, which is what lets one attribute serve three panels that live on
     *  three routes and can never be on screen together. */
    it("stamps the surface it was told it is", () => {
      panel({ surface: "wishlist", roomy: false, overWidth: 390 });

      expect(section()).toHaveAttribute(SEARCH_OVER_ATTR, "wishlist");
    });

    /** And the spacer takes a slot of its own in the fragment, so appearing and disappearing
     *  cannot renumber the section beside it — which is what the caret hand-back rests on. */
    it("keeps one section across every crossing between the three", async () => {
      const view = panel({ roomy: false, overWidth: 390 });
      const first = section();

      await userEvent.click(toggle());
      expect(section()).toBe(first);
      expect(section().previousElementSibling).toBeNull();

      await userEvent.click(toggle());
      view.update({ roomy: true, overWidth: undefined });
      expect(section()).toBe(first);
    });
  });

  describe("the disclosure", () => {
    it("flips aria-expanded and names the press rather than the state", async () => {
      panel();
      expect(toggle()).toHaveAccessibleName("Collapse card search");

      await userEvent.click(toggle());

      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(toggle()).toHaveAccessibleName("Expand card search");
    });

    /**
     * **`aria-disabled` and a press that does nothing, never the `disabled` attribute.** A
     * disabled button leaves the tab order, which would leave the reason hanging on a hover a
     * keyboard reader cannot perform — a rail that cannot be activated and never says why.
     */
    it("refuses in words where neither placement fits, and stays reachable", async () => {
      panel({ roomy: false });

      const rail = toggle();
      expect(rail).toHaveAttribute("aria-disabled", "true");
      expect(rail).toBeEnabled();
      rail.focus();
      expect(rail).toHaveFocus();

      fireEvent.pointerEnter(rail);
      const tooltip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
      expect(tooltip).toHaveTextContent(/not enough room/i);
      expect(document.getElementById(TOOLTIP_PANEL_ID)).toBe(tooltip);
      fireEvent.pointerLeave(rail);
    });

    /**
     * And "does nothing" has to include not quietly flipping the reader's own choice: a press
     * that toggled it would look inert while refused and then keep the panel shut when the room
     * came back, which is the reader being answered by a control they never operated.
     */
    it("leaves the reader's own answer alone while it is refusing", async () => {
      const view = panel({ roomy: false });

      await userEvent.click(toggle());
      view.update({ roomy: true });

      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("textbox", { name: "Body field" })).toBeInTheDocument();
    });

    /** A row that can hold the panel over the list is not a row that refuses, however narrow it
     *  is — the refusal used to fire for every phone. */
    it("is live wherever there is a placement for the panel", () => {
      panel({ roomy: false, overWidth: 390 });

      expect(toggle()).not.toHaveAttribute("aria-disabled");
    });
  });

  /**
   * **Three gates, not two, and they must stay three.** `open` mounts the body — a page nobody
   * searched from issues no `search_cards`. `roomy` merely hides it, so a window narrowing keeps
   * the reader's typed query, filters and fetched pages. Folding the two throws a reader's search
   * away on a *resize*.
   */
  describe("mounting against hiding", () => {
    it("keeps what the reader typed across a railing and drops it on a collapse", async () => {
      const view = panel();
      const field = screen.getByRole("textbox", { name: "Body field" });
      await userEvent.type(field, "goblin");

      // The wrapper generates **no box** while the panel is drawn, which is what keeps the body's
      // children flex items of the panel's own column: the `gap-2`, the `min-h-0` chain and the
      // wall's `flex-1` distribute exactly as they would with no wrapper there. A `block` in its
      // place would read identically in jsdom, which lays nothing out, so the class is the
      // assertion.
      expect(section().lastElementChild).toHaveClass("contents");

      view.update({ roomy: false });

      // Hidden, not unmounted — which is invisible to a role query, because the `hidden`
      // **attribute** takes the whole subtree out of the accessibility tree. That attribute rides
      // beside the class because jsdom loads no stylesheet, so the class alone would hide nothing.
      expect(screen.queryByRole("textbox", { name: "Body field" })).not.toBeInTheDocument();
      expect(section().lastElementChild).toHaveAttribute("hidden");
      expect(section().lastElementChild).toHaveClass("hidden");

      view.update({ roomy: true });

      // The same node, still carrying what was typed into it. Nothing the reader did was a
      // decision to start over, so nothing has started over.
      expect(screen.getByRole("textbox", { name: "Body field" })).toBe(field);
      expect(field).toHaveValue("goblin");

      // And a press is still a press: shutting the panel is the reader saying they are done.
      await userEvent.click(toggle());
      await userEvent.click(toggle());

      expect(screen.getByRole("textbox", { name: "Body field" })).not.toBe(field);
      expect(screen.getByRole("textbox", { name: "Body field" })).toHaveValue("");
    });

    /** A shut panel mounts nothing at all, which is what makes the search a thing the reader asks
     *  for rather than a thing every page pays for. */
    it("mounts no body at all while it is shut", () => {
      const { container } = panel({ startOpen: false });

      expect(container.querySelector("input")).toBeNull();
    });

    /** A railing costs the *body*; a rail draws no strip either, because a control for a body
     *  that is not drawn is a control that cannot do the thing it names. */
    it("draws the tabs slot with the panel and not with the rail", () => {
      const view = panel({ tabs: true });
      const strip = screen.getByRole("group", { name: "Search in" });
      const header = toggle().parentElement!;

      // Its own line under the header row and a sibling of it — a bar drawn below the filters
      // would be a tab bar under the thing it switches.
      expect(header).not.toContainElement(strip);
      expect(strip.parentElement).toBe(header.parentElement);
      expect(header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      view.update({ roomy: false });

      expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();
    });
  });

  /**
   * The panel's left edge, as something to pull on — an ARIA window splitter, so the pointer path
   * and the keyboard path are one control rather than a drag with a settings dialog beside it for
   * anyone who cannot perform one.
   */
  describe("the splitter", () => {
    it("reports the width in px, and the range it may be moved through", () => {
      panel({ maxWidth: 500 });

      expect(handle()).toHaveAttribute("aria-orientation", "vertical");
      expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_PANEL_WIDTH_PX));
      expect(handle()).toHaveAttribute("aria-valuemin", String(MIN_PANEL_WIDTH_PX));
      expect(handle()).toHaveAttribute("aria-valuemax", "500");
      // It points at the thing it resizes, which is how a screen reader ties the two together.
      expect(handle()).toHaveAttribute("aria-controls", section().id);
    });

    it("grows as the edge is pulled left and stops at one card's width the other way", () => {
      panel();

      drag(900, 800);
      expect(section()).toHaveStyle({ width: "484px" });
      expect(handle()).toHaveAttribute("aria-valuenow", "484");

      drag(800, 1600);
      expect(section()).toHaveStyle({ width: `${MIN_PANEL_WIDTH_PX}px` });
    });

    /** The page's cap. The drag is refused **at** it rather than allowed and corrected
     *  afterwards: a reader pulling past the edge sees the panel stop, which is what an edge is. */
    it("stops at the width the page allows however far the edge is pulled", () => {
      panel({ maxWidth: 500 });

      drag(900, 100);

      expect(section()).toHaveStyle({ width: "500px" });
    });

    /**
     * The keyboard half, which is not an extra: a caret cannot perform a drag, and a resize only a
     * pointer can reach is a layout choice taken away from anyone who does not use one. Left
     * widens and right narrows, matching the pointer — the key moves the *separator*.
     */
    it("moves with the arrow keys and jumps to either end with Home and End", async () => {
      panel({ maxWidth: 500 });
      handle().focus();

      await userEvent.keyboard("{ArrowLeft}");
      expect(section()).toHaveStyle({ width: "408px" });

      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      expect(section()).toHaveStyle({ width: "360px" });

      await userEvent.keyboard("{Home}");
      expect(section()).toHaveStyle({ width: `${MIN_PANEL_WIDTH_PX}px` });

      await userEvent.keyboard("{End}");
      expect(section()).toHaveStyle({ width: "500px" });
    });

    /**
     * **The clamp split, which is the whole of "reopens at the last valid width".**
     *
     * The environment clamps what is *drawn*; a drag clamps what is *stored*. A window narrowing,
     * or a list floor that will not give any more, is not the reader changing their mind — so when
     * the room comes back, so does their column. Holding the clamped number instead makes every
     * momentary squeeze permanent, and the failure is invisible until somebody widens a window.
     */
    it("gives the reader's width back when the room returns", () => {
      const view = panel();

      drag(900, 600);
      expect(section()).toHaveStyle({ width: "684px" });

      view.update({ maxWidth: 300 });
      expect(section()).toHaveStyle({ width: "300px" });

      view.update({ maxWidth: undefined });
      expect(section()).toHaveStyle({ width: "684px" });
    });

    /** And a collapse does not take it either: the width lives in the shell's root beside the
     *  disclosure, so a reader who sized this column for a job, shut it, and opened it again is
     *  not asking to start from 384. */
    it("reopens at the width the reader left it at", async () => {
      panel();
      drag(900, 700);
      expect(section()).toHaveStyle({ width: "584px" });

      await userEvent.click(toggle());
      await userEvent.click(toggle());

      expect(section()).toHaveStyle({ width: "584px" });
    });

    /** There is nothing to resize in the rail, and an edge to pull on it would be an affordance
     *  for a width the page has already refused. */
    it("is not drawn on a railed panel", () => {
      panel({ roomy: false });

      expect(noHandle()).toBeNull();
    });
  });

  /** The title is centred over the *panel* rather than over what the chevron leaves — a shim of
   *  the chevron's own width on the far side, which is cheaper than absolute positioning and
   *  keeps the heading in flow so `truncate` still has a box to work against at the floor. */
  it("centres its heading over the row with a shim, drawn only when it is", async () => {
    panel();
    const header = toggle().parentElement!;
    expect(within(header).getByText("Search cards")).toHaveClass("text-center");
    expect(header.lastElementChild).toHaveClass("size-7");

    await userEvent.click(toggle());

    expect(toggle().parentElement!.lastElementChild).not.toHaveClass("size-7");
  });
});
