import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HeadingCaret } from "@/features/shelves/headingCaret";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import type { Shelf } from "@/lib/shelves";
import { CollectionShelfHeading } from "./CollectionShelfParts";

/**
 * **A heading takes back the caret the page hands it** (live pass, check 8). After Add folder in a
 * heading and after a Move up / Move down, the caret belongs on that heading's own control — and
 * the page cannot put it there itself, because the heading may not be drawn when the request is
 * made and the element it remembered is often a detached one. So the heading takes it when drawn.
 */
describe("CollectionShelfHeading's caret", () => {
  const BINDER: Shelf = {
    id: 3,
    name: "Trade binder",
    kind: "folder",
    group: "own",
    pathIds: [3],
    path: ["Trade binder"],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
  };
  const menu = { onContextMenu: vi.fn(), onKeyDown: vi.fn(), onClick: vi.fn() };

  /** The page's `claimCaret`: `true` exactly once per id. */
  const claims = () => {
    let taken: number | null = null;
    return vi.fn((id: number) => {
      if (taken === id) return false;
      taken = id;
      return true;
    });
  };

  const heading = (caret?: HeadingCaret, withAddFolder = true) => (
    <CollectionShelfHeading
      shelf={BINDER}
      stat=""
      peek={[]}
      onToggle={vi.fn()}
      onOpen={vi.fn()}
      onAddFolder={withAddFolder ? vi.fn() : undefined}
      menu={menu}
      caret={caret}
    />
  );
  const addFolder = () => screen.getByRole("button", { name: "Add folder in Trade binder" });
  const manage = () => screen.getByRole("button", { name: "Manage Trade binder" });

  /** The opener died with its heading, so the caret is on `<body>` — this heading's to take. */
  it("takes the caret on its Add folder when drawn while the caret is nowhere", () => {
    render(heading({ id: 1, control: "add", from: null, claim: claims() }));

    expect(addFolder()).toHaveFocus();
  });

  /** A heading that stayed mounted through a move keeps the `⋯` the reader pressed, and it still
   *  holds the caret — which is nothing having moved it since, so it may be taken from. */
  it("takes the caret on its ⋯ from the element the reader pressed", () => {
    render(<button type="button">pressed</button>);
    const pressed = screen.getByRole("button", { name: "pressed" });
    pressed.focus();

    render(heading({ id: 1, control: "manage", from: pressed, claim: claims() }));

    expect(manage()).toHaveFocus();
  });

  /** Anything else holding the caret is the reader's doing since the press, and is left alone. */
  it("leaves a caret the reader has put somewhere else", () => {
    render(<button type="button">elsewhere</button>);
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();

    render(heading({ id: 1, control: "add", from: null, claim: claims() }));

    expect(elsewhere).toHaveFocus();
  });

  /** **Once per request.** A heading scrolled back into view later — drawn again with the same
   *  request on it — must not pull the caret off wherever the reader has taken it. */
  it("takes it once per request", () => {
    const claim = claims();
    const { rerender } = render(heading({ id: 1, control: "add", from: null, claim }));
    expect(addFolder()).toHaveFocus();
    addFolder().blur();

    rerender(heading({ id: 1, control: "add", from: null, claim }));
    expect(document.body).toHaveFocus();

    rerender(heading({ id: 2, control: "add", from: null, claim }));
    expect(addFolder()).toHaveFocus();
  });

  /** **The control is looked for inside this heading's own row.** A second row stamped with the
   *  same folder — a band the table has not dropped yet, drawn earlier in the document — has a
   *  control of the same name, and a lookup across the page takes that one. */
  it("takes the caret on its own control, not on another row's", () => {
    render(
      <div {...{ [SHELF_HEADING_ATTR]: BINDER.id }}>
        <button type="button" aria-label="Add folder in Trade binder">
          stale
        </button>
      </div>,
    );

    render(heading({ id: 1, control: "add", from: null, claim: claims() }));

    const [stale, own] = screen.getAllByRole("button", { name: "Add folder in Trade binder" });
    expect(stale).toHaveTextContent("stale");
    expect(own).toHaveFocus();
  });

  /** A request for a control the heading is not drawing yet is not spent on it. */
  it("waits for the control it names", () => {
    const claim = claims();
    const { rerender } = render(heading({ id: 1, control: "add", from: null, claim }, false));
    expect(claim).not.toHaveBeenCalled();

    rerender(heading({ id: 1, control: "add", from: null, claim }));
    expect(addFolder()).toHaveFocus();
  });
});
