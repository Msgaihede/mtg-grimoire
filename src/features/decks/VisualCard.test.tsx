import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { IMAGE_RETRY_LIMIT } from "@/lib/useImageRetry";
import { NOT_A_DRAG } from "./dnd";
import { card, resetRowIds } from "./validation/fixtures";
import { STACK_OVERLAP, VisualCard } from "./VisualCard";
import { ZONE_LABEL } from "./ZoneColumn";

/** One card in a list, because that is the only place an `<li>` means anything. */
function draw(row: DeckCard, overrides: Partial<Parameters<typeof VisualCard>[0]> = {}) {
  const spies = {
    onOpenMenu: vi.fn(),
    onSetQuantity: vi.fn(),
    onSelect: vi.fn(),
  };
  const view = render(
    <ul>
      <VisualCard
        card={row}
        zone="main"
        zoneTitle={ZONE_LABEL.main}
        stacked={false}
        menuOpen={false}
        menu={null}
        {...spies}
        {...overrides}
      />
    </ul>,
  );
  return { ...spies, ...view };
}

/** The frame's own `<img>`, whatever else is on the card. */
const art = () => document.querySelectorAll("img");

beforeEach(() => {
  resetRowIds();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VisualCard", () => {
  /**
   * The whole point of the view: the card is the card. `grid` is the variant Task 4's
   * pre-warm already fills for every card in a deck, so a built deck opens from disk.
   */
  it("draws the card at the grid variant, named by the card", () => {
    draw(card({ name: "Lightning Bolt" }));

    const image = screen.getByAltText("Lightning Bolt");
    expect(image).toHaveAttribute("src", expect.stringContaining("/grid/"));
    expect(image).toHaveAttribute("src", expect.stringContaining("c-Lightning%20Bolt"));
  });

  /**
   * **One image, never N copies.** Four Bolts are four copies of one picture: the cache serves
   * one key, the column has room for one card, and a stack of four identical images is three
   * of them saying nothing.
   */
  it("draws one image and a mono badge for a card the deck wants four of", () => {
    draw(card({ name: "Lightning Bolt", quantity: 4 }));

    expect(art()).toHaveLength(1);
    const badge = screen.getByText("×4");
    expect(badge).toHaveClass("font-mono", "tabular-nums");
  });

  /** One copy is what a line without a number means, in a deck list and here. */
  it("says nothing about quantity when the deck wants one", () => {
    draw(card({ name: "Lightning Bolt", quantity: 1 }));

    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
  });

  /**
   * The name is **text**, not only the image's `alt`: a rate limit, an off-line first run or a
   * printing with no art anywhere leaves a column of empty frames, and a deck list that cannot
   * be read is not a deck list. It sits where the card prints its own name.
   */
  it("keeps the card's name readable when the image never arrives", async () => {
    draw(card({ name: "Lightning Bolt" }));

    // Two retries and then the frame says so — `useImageRetry`'s schedule, driven here by the
    // one thing a caller controls: the `<img>` failing. Re-queried each time round, because a
    // retry draws a *new* `<img>` at a marked URL.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i <= IMAGE_RETRY_LIMIT; i++) {
      fireEvent.error(screen.getByAltText("Lightning Bolt"));
      await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    }
    vi.useRealTimers();

    expect(art()).toHaveLength(0);
    expect(screen.getByText("No image")).toBeInTheDocument();
    // The name is still on screen, and the card is still the way into the card.
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * A row whose printing has left the card database has no art to draw — `cards` has no row
   * for it — so nothing tries. What it has is the reconciler's sentence, and that is what the
   * card carries instead of a picture.
   */
  it("draws an orphaned row as its sentence rather than as a picture", () => {
    draw(
      card({
        name: "Lightning Bolt",
        needsReview: "This printing left the card database in the last sync.",
      }),
    );

    expect(art()).toHaveLength(0);
    expect(screen.getByText(/left the card database/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /** The card front is one control: pressing it opens the card in the pane the app docks. */
  it("opens the card from the card", async () => {
    const { onSelect } = draw(card({ name: "Lightning Bolt" }));

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));

    expect(onSelect).toHaveBeenCalledWith("c-Lightning Bolt");
  });

  /**
   * The controls are the same ones the compact row has, and they appear the way the search
   * grid's do: on hover, and on focus — which is what makes them reachable from the keyboard
   * at all, since a control that is only ever revealed by a pointer is a control half the
   * readers of this app cannot press.
   */
  it("reveals the stepper and the menu on hover and on focus", () => {
    draw(card({ name: "Lightning Bolt", quantity: 4 }));

    // The bar the two of them sit on, found from one of them: the stepper and the trigger are
    // its only children, and it is the thing that is revealed.
    const controls = screen.getByRole("button", { name: "More actions for Lightning Bolt" })
      .parentElement;
    expect(controls).toHaveClass("opacity-0", "group-hover:opacity-100");
    expect(controls).toHaveClass("group-focus-within:opacity-100");
    expect(controls).toContainElement(screen.getByLabelText("Copies of Lightning Bolt in Main deck"));
  });

  it("steps the quantity from the card", async () => {
    const { onSetQuantity } = draw(card({ name: "Lightning Bolt", quantity: 4 }));

    await userEvent.click(screen.getByRole("button", { name: /increase copies/i }));

    expect(onSetQuantity).toHaveBeenCalledWith(expect.objectContaining({ name: "Lightning Bolt" }), 5);
  });

  /**
   * **Every control on a draggable card marks itself.** The card is the drag handle, and
   * Chromium starts a drag from the nearest draggable ancestor of whatever was pressed — so a
   * press on `−` that travels five pixels is a drag of the card with the press never
   * delivered (`cardDraggable`, measured in the running window before the guard existed).
   */
  it("marks every control so a press on one is not a drag of the card", () => {
    draw(card({ name: "Lightning Bolt", quantity: 4 }));

    const row = screen.getByRole("listitem");
    for (const control of row.querySelectorAll("button, input")) {
      // The card front itself is the one control that is *not* excluded: it is how the card
      // is picked up, exactly as the search tile's art is.
      if (control.getAttribute("aria-label") === "Lightning Bolt") continue;
      expect(control.closest(NOT_A_DRAG)).not.toBeNull();
    }
  });

  it("opens the row menu from the card, naming the card", async () => {
    const { onOpenMenu } = draw(card({ name: "Lightning Bolt" }));

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));

    expect(onOpenMenu).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Lightning Bolt" }),
      expect.any(HTMLButtonElement),
    );
  });

  /** The menu is drawn by the column and anchored inside the card, because the card is what
   *  it belongs to and what it is measured against when it decides which way to open. */
  it("holds the menu the column hands it, inside the card", () => {
    draw(card({ name: "Lightning Bolt" }), {
      menuOpen: true,
      menu: <div data-testid="menu" />,
    });

    expect(screen.getByRole("listitem")).toContainElement(screen.getByTestId("menu"));
    expect(screen.getByRole("button", { name: "More actions for Lightning Bolt" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  /**
   * The stack: every card but the first in a group is pulled up over the one before it, far
   * enough that its own title band still shows.
   */
  it("pulls a stacked card up over the one before it, and the first one not at all", () => {
    draw(card({ name: "Lightning Bolt" }), { stacked: true });
    expect(screen.getByRole("listitem")).toHaveClass(STACK_OVERLAP);

    document.body.innerHTML = "";
    draw(card({ name: "Bear" }));
    expect(screen.getByRole("listitem")).not.toHaveClass(STACK_OVERLAP);
  });

  /**
   * The lift, and the whole of it: paint order. No transform and no transition — the motion
   * budget is spent on chip and nav state, and sixty cards that grow when the pointer crosses
   * them is a column that moves while it is being read.
   */
  it("lifts on hover and focus by paint order alone", () => {
    draw(card({ name: "Lightning Bolt" }));
    const row = screen.getByRole("listitem");

    expect(row.className).toMatch(/\bhover:z-\d/);
    expect(row.className).toMatch(/\bfocus-within:z-\d/);
    expect(row.className).not.toMatch(/scale|translate|transition/);
  });

  /** The one deck fact a picture cannot carry: the copies this deck wants against the copies
   *  the collection can cover. Drawn only when it says something. */
  it("marks a card the collection is short of, and says nothing when it is not", () => {
    draw(card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 3 }));
    expect(screen.getByText("3/4")).toBeInTheDocument();

    document.body.innerHTML = "";
    draw(card({ name: "Bear", quantity: 2, ownedQuantity: 2 }));
    expect(screen.queryByText("2/2")).not.toBeInTheDocument();
  });
});
