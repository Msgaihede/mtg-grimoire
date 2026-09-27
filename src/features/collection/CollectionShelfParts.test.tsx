import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadingCaret } from "@/features/shelves/headingCaret";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { SHELF_STICKY_ATTR } from "@/features/shelves/ShelfStickyBar";
import { dndDraggable } from "@/lib/dndTarget";
import { UNFILED_SHELF, type Shelf } from "@/lib/shelves";
import { boxed, startPointerDrag } from "@/test-drag";
import { collectionDragData } from "./collectionDrag";
import {
  CollectionEmptyShelf,
  CollectionShelfHeading,
  CollectionShelfSticky,
  type CardTarget,
} from "./CollectionShelfParts";

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

  /** `useHeadingCaret`'s `claim`: `true` exactly once per id. */
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

/**
 * **Where a copy let go on a shelf's three targets is filed** — the heading, the sticky bar and an
 * empty folder's box, each through `shelfTarget` (the final review's C-M6), and the sticky bar's
 * claim on the pointer where it is drawn over a heading (S-M1).
 *
 * dnd-kit hit-tests by coordinate and jsdom measures nothing, so every target and the copy are
 * given a box (`boxed`) and the pointer is walked into them.
 */
describe("the collection's shelf targets", () => {
  const NOT_SORTED: Shelf = {
    id: UNFILED_SHELF,
    name: "Not sorted",
    kind: "unfiled",
    group: "own",
    pathIds: [UNFILED_SHELF],
    path: ["Not sorted"],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
  };
  const folderShelf = (id: number, name: string): Shelf => ({
    ...NOT_SORTED,
    id,
    name,
    kind: "folder",
    pathIds: [id],
    path: [name],
  });
  const BINDER = folderShelf(3, "Trade binder");
  const SEALED = folderShelf(4, "Sealed");

  const undo: (() => void)[] = [];
  afterEach(() => undo.splice(0).forEach((stop) => stop()));

  /** A collection row in the air, filed in `Trade binder`, with a box of its own at `top`. */
  const copy = (top = 0) => {
    const element = boxed(document.createElement("div"), top);
    document.body.append(element);
    const stop = dndDraggable({
      element,
      data: () => collectionDragData({ entryId: 7, name: "Lightning Bolt", folderId: 3 }),
    });
    undo.push(() => {
      stop();
      element.remove();
    });
    return element;
  };
  const target = () => ({
    canDrop: (): boolean => true,
    onDrop: vi.fn<CardTarget["onDrop"]>(),
  });
  const menu = { onContextMenu: vi.fn(), onKeyDown: vi.fn(), onClick: vi.fn() };

  /** `Not sorted`'s address is the root: `null`, never its shelf id `0`. */
  it("files a copy let go on Not sorted's heading at the root", async () => {
    const cards = target();
    render(
      <CollectionShelfHeading
        shelf={NOT_SORTED}
        stat=""
        peek={[]}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        cards={cards}
      />,
    );
    boxed(document.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!, 200);
    const held = await startPointerDrag(copy());

    await held.moveTo(100, 220);
    await held.drop();

    expect(cards.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry" }), null);
  });

  it("files a copy let go on Not sorted's sticky bar at the root", async () => {
    const cards = target();
    render(
      <CollectionShelfSticky shelf={NOT_SORTED} onOpen={vi.fn()} onTop={vi.fn()} cards={cards} />,
    );
    boxed(document.querySelector<HTMLElement>(`[${SHELF_STICKY_ATTR}]`)!, 200, 36);
    const held = await startPointerDrag(copy());

    await held.moveTo(100, 218);
    await held.drop();

    expect(cards.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry" }), null);
  });

  it("files a copy let go on an empty box under Not sorted at the root", async () => {
    const cards = target();
    const { container } = render(<CollectionEmptyShelf shelf={NOT_SORTED} cards={cards} />);
    boxed(container.querySelector<HTMLElement>("[data-shelf-empty]")!, 200, 96);
    const held = await startPointerDrag(copy());

    await held.moveTo(100, 240);
    await held.drop();

    expect(cards.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry" }), null);
  });

  /**
   * **The sticky bar takes the card where it is drawn over a heading** (S-M1). The bar is pinned at
   * the top of the wall and headings scroll underneath it, so a heading half under the bar whose
   * centre is nearer the pointer used to take the drop the bar was showing it would take. Here the
   * bar is 200–236 (centre 218), `Trade binder`'s heading 210–250 (centre 230), and the pointer at
   * 228 — inside both, nearer the heading.
   */
  it("gives the sticky bar the copy over a heading scrolled underneath it", async () => {
    const bar = target();
    const under = target();
    render(
      <>
        <CollectionShelfSticky shelf={SEALED} onOpen={vi.fn()} onTop={vi.fn()} cards={bar} />
        <CollectionShelfHeading
          shelf={BINDER}
          stat=""
          peek={[]}
          onToggle={vi.fn()}
          onOpen={vi.fn()}
          menu={menu}
          cards={under}
        />
      </>,
    );
    boxed(document.querySelector<HTMLElement>(`[${SHELF_STICKY_ATTR}]`)!, 200, 36);
    boxed(document.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!, 210, 40);
    const held = await startPointerDrag(copy());

    await held.moveTo(100, 228);
    await held.drop();

    expect(bar.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry" }), SEALED.id);
    expect(under.onDrop).not.toHaveBeenCalled();
  });
});
