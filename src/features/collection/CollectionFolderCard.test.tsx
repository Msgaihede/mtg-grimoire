import { useEffect, useRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER_DROP_LINE_ATTR } from "@/components/FolderDropLine";
import { NOT_A_DRAG } from "@/features/decks/dnd";
import { DROP_EDGE, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import {
  folderDraggable,
  readFolderDrag,
  type FolderDrag,
  type FolderEdge,
} from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import type { CollectionFolder } from "@/lib/ipc";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import { CollectionFolderCard, type CollectionFolderTotals } from "./CollectionFolderCard";
import {
  collectionDraggable,
  collectionTileDraggable,
  type CollectionDrag,
  type CollectionDrop,
  type CollectionTileDrag,
} from "./collectionDrag";

/**
 * The two things the collection page draws around its cards: the dashed folder tile a reader
 * clicks into, and the breadcrumb they climb back out on.
 *
 * **One file for two components, because they are one contract.** "Where a copy can be dropped"
 * is a single sentence about both — a folder card takes a row *down* and a breadcrumb segment
 * takes it *back out*, and "without the breadcrumb a drag can only ever push cards deeper" is a
 * claim no test of either component alone can make. `WishFolderCard.test.tsx`'s arrangement, for
 * its reason.
 *
 * **The tile has two shapes since 2026-09-03** — the drawer, and the drawer with its name being
 * edited, because `Rename…` is answered on the card rather than in a strip above the wall. The
 * last section here is that second shape: what it replaces, what it keeps, and the two things
 * about a drag that deliberately do not change while it is open.
 *
 * **Both drags are pointer drags now, driven over `@dnd-kit/dom`'s real code path** — one press,
 * a gesture that crosses the activation threshold, and a release wherever the pointer was left.
 * `src/test-drag.ts` says what jsdom cannot do for that, and it is the thing every case below is
 * arranged around: jsdom lays nothing out and dnd-kit hit-tests by **coordinate**, so every source
 * and every target here is handed a `getBoundingClientRect` of its own. A drag that skipped one
 * lands nowhere and says nothing about it.
 *
 * **The two marks moved onto the card's own `<button>` on 2026-09-03 and the tokens changed with
 * them**, which is what every mark assertion below now addresses. A folder card wears `DROP_EDGE`
 * — its dashed border gone faintly gold — where a borderless target wears `DROP_RING`, and both
 * that and `DROP_OVER` are drawn on the face rather than on the `<li>` around it. The `<li>` is
 * still where the copy drop is *registered*, so the two are deliberately different questions here
 * and `carries no mark on the box the drop is registered on` is the one that would go red if
 * anything put the eligible mark back on a wrapper. `CollectionBreadcrumb` below is untouched by
 * any of it: a segment is a plain button with no border of its own, so `DROP_RING` is still its
 * mark and still drawn on the element it is asserted against.
 *
 * What is still out of reach and stays the live pass's to prove: that `FOCUS` — which stands 4px
 * proud of that same button — survives the wall's own `overflow` (that is `DROP_MARK_ROOM`, and
 * jsdom has no layout engine and therefore no clip), that the dash and the wash really do arrive
 * on one rectangle, and where a pointer really is over a real layout.
 */

const ENTRY: CollectionDrag = { entryId: 7, name: "Lightning Bolt", folderId: null };

/** What the *wall* offers, where the table offers {@link ENTRY}: one printing and every copy the
 *  tile summed — here two, filed in two different places, which is the whole reason a tile needs a
 *  payload of its own. */
const TILE: CollectionTileDrag = {
  cardId: "c1",
  name: "Lightning Bolt",
  copies: [
    { entryId: 7, folderId: null },
    { entryId: 8, folderId: 3 },
  ],
};

/** What each source's drop arrives as, once `readCollectionDrop` has read it — spelled once,
 *  because these are the two sentences every target below is asserted against. */
const ENTRY_DROP: CollectionDrop = { kind: "entry", entry: ENTRY };
const TILE_DROP: CollectionDrop = { kind: "tile", tile: TILE };

function folder(
  over: Partial<CollectionFolder> & { id: number; name: string },
): CollectionFolder {
  // `locked: false` is the row every existing database has: schema v33's column is
  // `NOT NULL DEFAULT 0`, so the upgrade is invisible. The cases that lock a drawer say so
  // through the card's `locked` **prop**, which is the *effective* answer the page computes over
  // the whole cabinet — this flag is the folder's own and the card never reads it.
  return { parentId: null, kind: "user", deckId: null, sortOrder: over.id, locked: false, ...over };
}

const BINDER = folder({ id: 3, name: "Trade binder" });
const FOILS = folder({ id: 9, name: "Foils", parentId: 3 });

function node(
  f: CollectionFolder,
  over: Partial<FolderNode<CollectionFolder>> = {},
): FolderNode<CollectionFolder> {
  return { folder: f, depth: 0, count: 0, children: [], ...over };
}

/**
 * Whether an element wears one of `dropMarks.ts`'s marks.
 *
 * `classList.contains` per class rather than `className.includes(mark)`: several of the classes
 * around these are `hover:` variants, and a substring test against the whole attribute passes
 * before any state has changed — a vacuous assertion that reads exactly like a real one.
 */
function marked(element: Element | null | undefined, mark: string): boolean {
  expect(element).toBeTruthy();
  return mark.split(" ").every((one) => element!.classList.contains(one));
}

/**
 * Every class the three drop marks can paint with, as a flat set — the vocabulary a wrapper must
 * wear **none** of.
 *
 * **Not `marked(element, MARK)` three times, because that helper asks for *all* of a mark's
 * classes and the failure this guards is a mark applied at all.** A wrapper carrying
 * `border-accent/45` on its own would satisfy neither `DROP_EDGE` (whose other half is
 * `transition-none`) nor anything else, so three `marked(…)` calls returning `false` would leave a
 * second gold outline on screen and the suite green. Asking per class is what makes the assertion
 * about the defect rather than about the token.
 *
 * Derived from the constants rather than typed out, so a change to the vocabulary reaches here
 * without anyone remembering to update a list — with `transition-none` dropped, which is a
 * statement about *timing* that two of the three share and paints nothing.
 */
const MARK_CLASSES = [DROP_RING, DROP_EDGE, DROP_OVER]
  .flatMap((mark) => mark.split(" "))
  .filter((one) => one !== "transition-none");

/** Which of {@link MARK_CLASSES} an element is actually wearing — a list rather than a boolean, so
 *  a failure names the class that came back rather than printing `true !== false`. */
const marks = (element: Element) => MARK_CLASSES.filter((one) => element.classList.contains(one));

/**
 * Something to pick up.
 *
 * `collectionDraggable` rather than the library's `draggable` directly, so the payload travels
 * exactly as a collection row's does — **both keys at once**, which is the case that would break
 * if the two marks were ever collapsed into one.
 */
function Source({ entry = ENTRY }: { entry?: CollectionDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Somewhere to be pressed. dnd-kit reads the press coordinate off the source's own box and
    // jsdom measures every rectangle as four zeroes, so a source with no box is pressed at the
    // origin — silently, and nowhere near the card this file drags onto.
    element.getBoundingClientRect = () => SOURCE_BOX;
    return collectionDraggable({
      element,
      entry: () => entry,
      card: () => ({ kind: "card", cardId: "c1", name: entry.name, typeLine: "Instant" }),
    });
  }, [entry]);
  return <div ref={ref}>the copy</div>;
}

/**
 * The wall's source beside the table's: `collectionTileDraggable`, so the tile payload travels the
 * way the collection page's grid view sends it — the printing plus every copy behind it, under its
 * own key, with the card half beside it exactly as a row carries one.
 *
 * A second source rather than a parameter on {@link Source}, because the point of every test below
 * that uses it is that **the same target** takes two different payloads without knowing which one
 * it is about to get.
 */
function TileSource({ tile = TILE }: { tile?: CollectionTileDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A box of its own, for {@link Source}'s reason.
    element.getBoundingClientRect = () => SOURCE_BOX;
    return collectionTileDraggable({
      element,
      tile: () => tile,
      card: () => ({ kind: "card", cardId: tile.cardId, name: tile.name, typeLine: "Instant" }),
    });
  }, [tile]);
  return <div ref={ref}>the tile</div>;
}

/**
 * A sibling drawer, in the air.
 *
 * Its own `folderDraggable` rather than a second `CollectionFolderCard`, for {@link Source}'s
 * reason one payload over: every test below is about what the card *under the pointer* does, and
 * a second card would put a second drop target in the way of that.
 */
const OTHER_FOLDER: FolderDrag = {
  folderId: 9,
  name: "Foils",
  parentId: null,
  scope: "collection",
};

function FolderSource({ drag = OTHER_FOLDER }: { drag?: FolderDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return folderDraggable({ element, folder: () => drag });
  }, [drag]);
  return <div ref={ref}>the folder</div>;
}

/**
 * Two boxes and three landings, because dnd-kit hit-tests by **coordinate** and jsdom measures
 * every rectangle as zero.
 *
 * An edge-dependent test therefore has to state the box itself rather than hope for one — and
 * with a pointer-based library it states the box *once* and then moves the pointer over it, which
 * is the gesture a reader makes. (Under the HTML5 harness this file did the opposite, sliding the
 * card under a stationary pointer, because that harness sent one fixed coordinate and nothing
 * else was possible.) The card is read along the **horizontal** axis, since the wall lays its
 * drawers out as a grid; `EDGE_ZONE` is a quarter, so a tenth in from either end is unambiguously
 * beside it and the middle is unambiguously inside.
 */
const SOURCE_BOX = new DOMRect(0, 0, 240, 120);
const CARD_BOX = new DOMRect(400, 0, 240, 120);
const BEFORE = { x: 0.1 };
const INSIDE = { x: 0.5 };
const AFTER = { x: 0.9 };

const onOpen = vi.fn();
const onDropCard = vi.fn();
const onDropFolder = vi.fn();
const onContextMenu = vi.fn();
const onKeyDown = vi.fn();
const onClickMenu = vi.fn();
const onRenameSubmit = vi.fn();
const onRenameCancel = vi.fn();

/**
 * The rename arm at rest, which is what every case here that is not about the field passes.
 *
 * Spelled once rather than at forty call sites — and it is a *required* prop rather than an
 * optional one on purpose, so a page that draws a wall of drawers cannot forget to say what
 * `Rename…` does on them and leave a menu row that opens nothing.
 */
const RESTING = {
  active: false,
  pending: false,
  onSubmit: onRenameSubmit,
  onCancel: onRenameCancel,
};

/** …and the same card with its name being edited: `active` is the page's flag, because one field
 *  is open at a time across the whole cabinet. */
const RENAMING = { ...RESTING, active: true };

beforeEach(() => {
  onOpen.mockReset();
  onDropCard.mockReset();
  onDropFolder.mockReset();
  onContextMenu.mockReset();
  onKeyDown.mockReset();
  onClickMenu.mockReset();
  onRenameSubmit.mockReset();
  onRenameCancel.mockReset();
});

describe("CollectionFolderCard", () => {
  interface Props {
    /** Which drawer this card draws. Only the payload test below changes it. */
    on?: FolderNode<CollectionFolder>;
    summary?: CollectionFolderTotals | null;
    currency?: "usd" | "eur";
    /**
     * The **effective** lock the page hands down — the folder's own flag *or* any ancestor's.
     *
     * Deliberately separate from `on`, so a case can put the two out of step: a card told `true`
     * over a folder whose own flag is `false` is the inherited lock, and a card told nothing over
     * a folder whose own flag is `true` is the mutation this file exists to catch.
     */
    locked?: boolean;
    /** Whether the card is currently *being* the field, and whether the write is in flight. */
    rename?: typeof RESTING;
    canDrop?: (drop: CollectionDrop) => boolean;
    canDropFolder?: (drag: FolderDrag, edge: FolderEdge) => boolean;
    withSource?: boolean;
    /** The wall's tile in the air instead of the table's row — the same card, offered under the
     *  other key. */
    withTile?: boolean;
    /** A sibling drawer in the air — the third payload this card reads, under its own key. */
    withFolder?: boolean;
    folderDrag?: FolderDrag;
  }

  function tree({
    on = node(BINDER),
    summary = { cards: 12, value: 340.25 } as CollectionFolderTotals | null,
    currency = "usd" as const,
    locked = false,
    rename = RESTING,
    canDrop = () => true,
    canDropFolder = () => true,
    withSource = false,
    withTile = false,
    withFolder = false,
    folderDrag,
  }: Props) {
    return (
      <>
        {withSource && <Source />}
        {withTile && <TileSource />}
        {withFolder && <FolderSource drag={folderDrag} />}
        {/* Inside a `<ul>`, because the card is an `<li>` — `FolderCard`'s shape, and a row of
            folders genuinely is a list. */}
        <ul>
          <CollectionFolderCard
            node={on}
            summary={summary}
            currency={currency}
            locked={locked}
            onOpen={onOpen}
            rowMenu={{ onContextMenu, onKeyDown, onClick: onClickMenu }}
            rename={rename}
            canDrop={canDrop}
            onDropCard={onDropCard}
            canDropFolder={canDropFolder}
            onDropFolder={onDropFolder}
          />
        </ul>
      </>
    );
  }

  /**
   * Draw the card, and keep the props so the same card can be drawn again with one of them
   * changed.
   *
   * **`show` exists for the caret**, which is the one thing here that is a fact about a
   * *transition* rather than about a state: `useFolderFieldReturn` fires on the render where
   * `active` goes false, so a test that mounted the resting card would be asserting about a
   * component that was never renaming.
   */
  function mount(props: Props = {}) {
    const view = render(tree(props));
    return { show: (next: Props) => view.rerender(tree({ ...props, ...next })) };
  }

  /**
   * The card's own box — the element the copy drop is registered on and the one a reader picks
   * the folder up by.
   *
   * **It is no longer where any mark is drawn**, and that is worth the sentence rather than a
   * silent edit: until 2026-09-03 the eligible ring went here while the dash and the wash went on
   * the face inside, which put a box shadow 2px outside a dashed rectangle it never touched. So a
   * mark assertion pointed at this element is now asking about a *bug*, not about a drawing — see
   * `carries no mark on the box the drop is registered on` below.
   */
  function card(name = "Trade binder"): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`^${name} folder`) }).closest("li")!;
  }

  /** The face inside it, which is what carries the card's own dashed edge and therefore **both**
   *  marks — and the element a real pointer is over for all but the `⋯`'s corner, so it is where
   *  the folder drags below are aimed. */
  const face = (name?: string) => card(name).querySelector("button")!;

  /**
   * The box the **folder** drop target is registered on: an inner wrapper rather than the `<li>`,
   * because the drag library keeps one element drop target per element and the copy drag already
   * owns the `<li>`. A drag aimed at {@link face} finds it by walking up, exactly as a pointer
   * does; this is the handle for the one thing a walk cannot do, which is state the box.
   *
   * Taken off an `<li>` rather than off a folder's name, because the renaming cases below reach
   * the same wrapper on a card whose name is an `<input>` — the wrapper is where the field is
   * drawn, and it is the whole reason a rename does not tear the folder drop target down.
   */
  const box = (li: HTMLElement) => li.firstElementChild as HTMLElement;
  const slot = (name?: string) => box(card(name));

  /**
   * Which end the drop line is on, or `null` for no line at all.
   *
   * The attribute rather than a class: the side is a Tailwind utility and jsdom applies no
   * stylesheet, so a class assertion would be a check on this repo's source text rather than on
   * the drawing. `FolderDropLine` carries the edge as that attribute's *value* for exactly this.
   */
  const line = (li: HTMLElement = card()) =>
    li.querySelector(`[${FOLDER_DROP_LINE_ATTR}]`)?.getAttribute(FOLDER_DROP_LINE_ATTR) ?? null;

  /**
   * Give the card somewhere to be — the `<li>`, the wrapper inside it and the face, all at
   * {@link CARD_BOX}, which is where every drag below is aimed.
   *
   * **All three, because the two drops are nested droppables over one rectangle now.** The copy's
   * target is the `<li>` and the folder's is the wrapper inside it, and in a real window the one
   * is drawn exactly over the other; what keeps them apart is `accept`, which refuses the payload
   * each was not written for before dnd-kit measures either. The face takes the same rect because
   * it is what a real pointer is over for all but the `⋯`'s corner, so a drag aimed at it has to
   * arrive where the card is.
   */
  const stand = (name?: string) => {
    for (const element of [card(name), slot(name), face(name)]) {
      element.getBoundingClientRect = () => CARD_BOX;
    }
  };

  /**
   * The card while its name is being edited, and the field that has replaced the name.
   *
   * Addressed through the input, because the button {@link card} finds it by is exactly what the
   * field replaced — and that substitution is itself one of the claims below.
   */
  const field = () => screen.getByLabelText(`Rename ${BINDER.name}`);
  const renaming = () => field().closest("li") as HTMLElement;

  /** {@link stand}, for the renaming card: the same two drop targets, named the other way. There is
   *  no third element to measure, because the face a pointer would be over is the field. */
  const standRenaming = () => {
    for (const element of [renaming(), box(renaming())]) {
      element.getBoundingClientRect = () => CARD_BOX;
    }
  };

  it("names the folder and says what is in it", () => {
    mount();
    expect(screen.getByText("Trade binder")).toBeInTheDocument();
    expect(screen.getByText("12 cards · $340.25")).toBeInTheDocument();
  });

  it("prices in the currency it is handed", () => {
    mount({ currency: "eur" });
    expect(screen.getByText("12 cards · €340.25")).toBeInTheDocument();
  });

  it("says `1 card`, never `1 cards`", () => {
    mount({ summary: { cards: 1, value: 4 } });
    expect(screen.getByText("1 card · $4.00")).toBeInTheDocument();
  });

  /** A binder is thousands of copies where a wishlist is tens, which is why this writes its number
   *  through `count` rather than through `plural`'s plain one. */
  it("writes a four-figure count with its thousands separator", () => {
    mount({ summary: { cards: 1204, value: 12000 } });
    expect(screen.getByText("1,204 cards · $12,000.00")).toBeInTheDocument();
  });

  /**
   * **An em dash, never `$0.00`** — the backend answers `null` for a folder the marketplace priced
   * nothing in, and `$0.00` there would claim a quote nobody gave. The spoken half says it in
   * words, because a dash read aloud is punctuation.
   */
  it("draws an em dash rather than $0.00 when nothing in the folder is priced", () => {
    mount({ summary: { cards: 12, value: null } });
    expect(screen.getByText("12 cards · —")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, 12 cards, not priced" }),
    ).toBeInTheDocument();
  });

  /** An empty drawer is the ordinary state of a folder the reader just made, and money for nothing
   *  is noise: no price at all, not `$0.00` and not a dash. */
  it("shows the count alone on a folder holding nothing", () => {
    mount({ summary: { cards: 0, value: null } });
    expect(screen.getByText("0 cards")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, 0 cards" }),
    ).toBeInTheDocument();
  });

  /**
   * **`null` is "not counted yet", and it is a different answer from an empty drawer.** The wall is
   * gated on the folder *list* — one flat `SELECT` — while the figures come from a `GROUP BY` with
   * a price expression behind it, so `0 cards` across that window is a wrong number that then
   * jumps rather than a spinner.
   */
  /**
   * **The drawer set aside, in the two slots this card has** — issue #365.
   *
   * The `⋯` owns the top-right corner, so the leading glyph is the only mark a folder card has
   * left; it becomes a `Lock`, which is the device `PinnedFolder` already uses to say what kind of
   * folder it is. **And a glyph is not an accessible name**, so the word joins `folderFace`'s pair
   * rather than being drawn beside it — one function building `shown` and `spoken` together is
   * what stops the screen text and the `aria-label` drifting, and it follows the pair's existing
   * convention exactly: the app's `·` on screen, a comma in the sentence.
   *
   * The glyph is asserted by its lucide class rather than by a role, because it is `aria-hidden`
   * — which is right, since everything it says is already in the name.
   */
  describe("a drawer the reader has set aside", () => {
    const glyph = (which: "lock" | "folder") =>
      screen.getByRole("button", { name: /^Trade binder folder/ }).querySelector(`.lucide-${which}`);

    it("draws a Lock where the Folder was, and says the word in both spellings", () => {
      mount({ locked: true });
      expect(glyph("lock")).toBeInTheDocument();
      expect(glyph("folder")).toBeNull();
      expect(screen.getByText("Locked · 12 cards · $340.25")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Trade binder folder, locked, 12 cards, $340.25" }),
      ).toBeInTheDocument();
    });

    /** The badge keeps the glyph's size and colour: a mark that also changed weight would read as
     *  a different card rather than as the same card set aside. */
    it("keeps the glyph's size and colour", () => {
      mount({ locked: true });
      expect(glyph("lock")).toHaveClass("size-3.5", "flex-none", "text-dim");
    });

    /**
     * **A folder locked by an ancestor draws the badge too**, which is the whole reason `locked` is
     * a prop rather than a read of `node.folder.locked`: the lock inherits down the tree, so a
     * badge that appeared only on the drawer the reader pressed Lock on would make the inheritance
     * invisible exactly where it matters — standing inside that drawer, looking at what it took
     * with it.
     *
     * The folder's own flag is `false` here and the card says *locked* anyway.
     */
    it("draws the badge for a folder locked by its parent, whose own flag is off", () => {
      mount({ on: node(folder({ id: 9, name: "Trade binder", parentId: 3 })), locked: true });
      expect(glyph("lock")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Trade binder folder, locked, 12 cards, $340.25" }),
      ).toBeInTheDocument();
    });

    /**
     * **And the other way round, which is the assertion that catches the obvious shortcut.** A
     * card handed a folder whose own flag is `true` and told nothing draws no badge: the effective
     * answer is a walk over the whole cabinet and this component holds one node, so `locked` is
     * the page's word and the row's column is never read here. Wire the badge to
     * `node.folder.locked` and this is the case that goes red.
     */
    it("reads the prop and never the folder's own column", () => {
      mount({ on: node(folder({ id: 3, name: "Trade binder", locked: true })) });
      expect(glyph("lock")).toBeNull();
      expect(glyph("folder")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Trade binder folder, 12 cards, $340.25" }),
      ).toBeInTheDocument();
    });

    /**
     * **The word survives the window the figures have not arrived in.** The lock is known from the
     * folder *list*, which is what the wall is gated on; the figures come from a `GROUP BY` that
     * answers later. A badge that waited for the summary would flicker on for no reason a reader
     * could see.
     */
    it("says the drawer is locked before the figures land", () => {
      mount({ summary: null, locked: true });
      expect(screen.getByText("Locked · —")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Trade binder folder, locked, still counting" }),
      ).toBeInTheDocument();
    });
  });

  it("says nothing is counted yet rather than `0 cards`, while the summary is still reading", () => {
    mount({ summary: null });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/cards/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, still counting" }),
    ).toBeInTheDocument();
  });

  /** A wall of these is otherwise a row of controls all called "Manage": a screen reader reads
   *  them out of context, one after another, with nothing to tell them apart. */
  it("carries a manage trigger named for its own folder", () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Manage Trade binder" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    // Deliberately absent: the open state is `ContextMenuProvider`'s fact, and a static
    // `aria-expanded="false"` would be an assertion that is wrong for as long as the menu is up.
    expect(trigger).not.toHaveAttribute("aria-expanded");
  });

  it("opens the folder when pressed", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /^Trade binder folder/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /** Three doors into one menu, and the trigger's plain click is the third: it is either a pointer
   *  press or an Enter key, and only `menuClick` knows to ask. */
  it("hands all three menu gestures to the page", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Manage Trade binder" }));
    expect(onClickMenu).toHaveBeenCalledTimes(1);

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^Trade binder folder/ }),
    });
    expect(onContextMenu).toHaveBeenCalledTimes(1);

    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("golds its own dash for a copy it can take, and washes under the pointer", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    // Asked while the drag is still up: `started` is a live reading of the manager's own
    // operation rather than a remembered one, so after a drop or a cancel it is false for every
    // drag there has ever been.
    expect(held.started).toBe(true);
    expect(marked(face(), DROP_EDGE)).toBe(true);
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(card());
    expect(marked(face(), DROP_OVER)).toBe(true);
    // **The two marks supersede rather than stack, and that is `cn`'s doing rather than the
    // card's**: `DROP_EDGE`'s `border-accent/45` and the over branch's `border-accent` are one
    // `tailwind-merge` group, so the later argument wins outright and the eligible spelling is
    // gone from the class list. The escalation is therefore visible as a *swap* here, which is
    // exactly the property the argument order in the component buys.
    expect(marked(face(), DROP_EDGE)).toBe(false);
    expect(face().classList.contains("border-accent")).toBe(true);

    await held.cancel();
  });

  /**
   * **The `<li>` wears nothing, and this is the fence for the bug that made it worth saying.**
   * Until 2026-09-03 the eligible mark went on this box while the card's dashed border and its
   * wash went on the face inside — and a ring is a box shadow painted *outside* the border box, so
   * the gold rectangle stood 2px proud of a dashed one it never touched. Two concentric outlines
   * for one landing, which is what a reader reported as bulky affordances that overlap their
   * neighbours and do not line up with the dotted outline.
   *
   * Asserted through {@link marks} rather than against one token, because the failure mode is a
   * mark on this element at all rather than a particular one: putting `DROP_EDGE` back here would
   * draw a second gold border around the first and read as exactly the same defect. Asked in both
   * states, since `armed` and `over` are two different branches and either could put it back.
   *
   * The registration is untouched — the drop at the end still lands — so this cannot be satisfied
   * by quietly moving the drop target off the box the marks were taken from.
   */
  it("carries no mark on the box the drop is registered on", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marks(card())).toEqual([]);
    // …while the face it wraps is already saying the drawer would take the copy, so this is a
    // statement about *where* the mark is rather than about a wall with no affordance at all.
    expect(marked(face(), DROP_EDGE)).toBe(true);

    await held.over(card());
    expect(marks(card())).toEqual([]);
    expect(marked(face(), DROP_OVER)).toBe(true);

    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP);
  });

  /** The folder a copy is already filed in leaves its dash plain, rather than golding an edge that
   *  leads to a write that moves nothing and bumps `updated_at`. */
  it("draws no mark at all for a copy it refuses", async () => {
    mount({ withSource: true, canDrop: () => false });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(face(), DROP_EDGE)).toBe(false);

    // And refusing means refusing the drop too, not merely declining to advertise it.
    await held.over(card());
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("files the copy it is dropped", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    await held.over(card());
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP);
  });

  /**
   * The wall's tile is the other half of the same contract: one target, two payloads, and the card
   * knowing which only because the drop says so. Every copy travels — the tile is what the reader
   * grabbed, and dropping it half way would leave copies behind with nothing on screen saying so.
   */
  it("takes a whole tile too, and hands every copy behind it to the page", async () => {
    mount({ withTile: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(face(), DROP_EDGE)).toBe(true);

    await held.over(card());
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(TILE_DROP);
  });

  /**
   * **`canDrop` is asked again on the drop itself**, which is what the hook's own comment claims
   * and what nothing else here can see: the library never delivers a drop to a target that refused
   * at `dragover`, so every other refusal test in this file passes whether that second question is
   * asked or not. A policy that changes its mind *mid-drag* is the only way to reach the line —
   * and it is not a contrivance, because the two questions can be a second apart with a refetch
   * between them, and only the second one writes.
   */
  it("asks again at the drop, and refuses a copy it has stopped taking", async () => {
    let takes = true;
    mount({ withSource: true, canDrop: () => takes });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    await held.over(card());
    expect(marked(face(), DROP_OVER)).toBe(true);

    takes = false;
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  /** The card is dumb about the difference and the *page* is not: a policy that answers only for
   *  rows leaves a tile with a plain dash and no mark at all, which is the discriminant doing its
   *  job. */
  it("lets the page refuse one shape and take the other", async () => {
    mount({ withTile: true, canDrop: (drop) => drop.kind === "entry" });
    stand();
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(face(), DROP_EDGE)).toBe(false);

    await held.over(card());
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------ the folder drag ------- */

  /**
   * **The card is a drag *source* as well as a target now, and what it carries is read at
   * `dragstart`.** `parentId` travels because it is what lets the folder's own parent refuse a
   * nest that would move it nowhere — a fact about where the folder sits, not about the drawer it
   * is being carried over, so nothing downstream can work it out.
   */
  it("is a drawer a reader can pick up, carrying where it currently sits", async () => {
    mount({ on: node(FOILS) });
    const drags = recordDrags();

    stand("Foils");
    const held = await startPointerDrag(card("Foils"));
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map((data) => readFolderDrag(data, "collection"))).toEqual([
      { folderId: 9, name: "Foils", parentId: 3, scope: "collection" },
    ]);
  });

  /**
   * **A press on the folder's own `⋯` is a press on the menu.** Chromium starts a drag from the
   * nearest draggable *ancestor* of whatever was pressed, so without `data-no-drag` on the
   * trigger a press there plus five pixels of travel files this drawer somewhere and the click
   * that was meant is never delivered. The press and the drag land on two different elements
   * here, exactly as the platform sends them.
   */
  it("does not start a drag from a press on its manage trigger", async () => {
    mount();
    stand();
    const refused = await startPointerDrag(card(), {
      pressOn: screen.getByRole("button", { name: "Manage Trade binder" }),
    });
    expect(refused.started).toBe(false);
    await refused.cancel();

    // And the folder's face still is a grab handle — the guard is about a control's press, not
    // about the card. dnd-kit's own default would have refused this one too, because it is a
    // button; `NOT_A_DRAG` is what says a control marks itself.
    const again = await startPointerDrag(card(), {
      pressOn: screen.getByRole("button", { name: /^Trade binder folder/ }),
    });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * The middle of a drawer means *into* it, and it wears the same wash a copy over it does — only
   * one thing is ever in the air, so the two claims are one mark rather than two.
   *
   * **And the eligible mark is the same one a copy raises, on the same element**, which is what
   * says the two drags share `dropMarks.ts`'s vocabulary rather than each inventing one: the
   * assertion here is identical to the copy drag's above and only the payload differs.
   */
  it("golds its dash for a folder it can take, and washes over the middle it would nest in", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(face(), DROP_EDGE)).toBe(true);
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(slot(), INSIDE);
    expect(marked(face(), DROP_OVER)).toBe(true);
    // No line with the wash: `inside` is a folder taking the drag rather than a position between
    // two of them, so one meaning wears one mark.
    expect(line()).toBeNull();

    await held.cancel();
  });

  /**
   * **Which end the line is on *is* the fact under test** — a mark on the wrong side of a card is
   * a promise to file the folder in the wrong place — and it moves within one card rather than
   * answering once on entry, because the whole gesture is that one drawer means three things at
   * three places along it.
   */
  it("draws a line at the end a folder would land beside, and no wash with it", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));

    await held.over(slot(), BEFORE);
    expect(line()).toBe("before");
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(slot(), AFTER);
    expect(line()).toBe("after");

    await held.cancel();
  });

  /**
   * **No mark means no drop.** `useFolderDropTarget` reports `edge: null` over a part of the card
   * the page refuses, deliberately keeping the whole element in the library's hierarchy so the
   * reported edge keeps following the pointer — so the card has to draw nothing there rather than
   * a line leading to a write that never happens. The gold dash stays up, because this drawer
   * *would* take the folder beside it.
   */
  it("draws nothing at all over a landing the page refuses, and refuses the drop too", async () => {
    mount({ withFolder: true, canDropFolder: (_drag, edge) => edge !== "inside" });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(face(), DROP_EDGE)).toBe(true);

    await held.over(slot(), INSIDE);
    expect(marked(face(), DROP_OVER)).toBe(false);
    expect(line()).toBeNull();
    // Still eligible over the refused middle, and it has to be *this* spelling rather than merely
    // "some mark on the face": with the over branch off, nothing else raises `border-accent/45`,
    // so the assertion cannot be satisfied by the wash the line above has just denied.
    expect(marked(face(), DROP_EDGE)).toBe(true);

    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  it("draws no mark at all for a folder the page refuses outright", async () => {
    mount({ withFolder: true, canDropFolder: () => false });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(face(), DROP_EDGE)).toBe(false);

    await held.over(slot(), INSIDE);
    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  it("hands the page the folder and where it landed", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    await held.over(slot(), AFTER);
    await held.drop();
    expect(onDropFolder).toHaveBeenCalledWith(OTHER_FOLDER, "after");
  });

  /**
   * **The sidebar's deck-folder tree is mounted beside this page all day**, and folder `9` exists
   * in all three `*_folders` tables — so a deck folder carried over a binder is a gesture a reader
   * can really make, and a card that took it would file a real row in the wrong cabinet. The
   * refusal is `readFolderDrag`'s, reached by this card passing its own scope.
   */
  it("refuses a folder belonging to another cabinet", async () => {
    mount({
      withFolder: true,
      folderDrag: { folderId: 9, name: "Standard", parentId: null, scope: "deck" },
    });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(face(), DROP_EDGE)).toBe(false);

    await held.over(slot(), INSIDE);
    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  /**
   * **The two drags stay two.** They carry different marks under different keys, so each reader
   * answers `null` for the other's payload — which is what lets one card be a copy's destination
   * and a folder's neighbour at once without either handler learning about the other.
   */
  it("keeps the copy drag and the folder drag apart, in both directions", async () => {
    mount({ withSource: true, withFolder: true });
    stand();

    // **Both are pointer drags on one library now, so the two marks are the whole of the
    // fence** — a weaker separation than the one this comment used to claim (two libraries
    // sharing neither a registry, an event nor a coordinate space), and therefore the one worth
    // driving. The `<li>` and the wrapper inside it are two droppables over one rectangle, and
    // each refuses the other's payload in `accept` before dnd-kit measures either.
    const copy = await startPointerDrag(screen.getByText("the copy"));
    await copy.over(face());
    await copy.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP);
    expect(onDropFolder).not.toHaveBeenCalled();

    onDropCard.mockReset();
    const drawer = await startPointerDrag(screen.getByText("the folder"));
    await drawer.over(slot(), INSIDE);
    await drawer.drop();
    expect(onDropFolder).toHaveBeenCalledWith(OTHER_FOLDER, "inside");
    expect(onDropCard).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------ the name, edited on the card ------- */

  /**
   * **`Rename…` is answered on the card**, which is the whole of what changed on 2026-09-03: the
   * strip that used to open under the breadcrumb is gone and the tile becomes the field. The cases
   * below are the ones a suite can see — the substitution, what the field opens holding, what
   * survives underneath it, where the caret goes afterwards, and the two things that deliberately
   * do **not** change while it is open.
   */
  it("becomes the field, and draws neither of the two buttons it replaced", () => {
    mount({ rename: RENAMING });

    expect(field()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // **The `⋯` is the one that matters**: a card offering `Rename…`, `Move to folder…` and
    // `Delete…` over a name that is halfway through being typed is a menu about a folder in a
    // state the page cannot answer for. The folder's own button goes with it — the name is not
    // somewhere to press while it is somewhere to type.
    expect(screen.queryByRole("button", { name: "Manage Trade binder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Trade binder folder/ })).not.toBeInTheDocument();
  });

  /**
   * **Named for the folder it is about, and opening on its current name — selected.**
   *
   * The name matters because a wall of drawers renames one at a time and every field on it would
   * otherwise be called the same thing. The *selection* is what makes the commonest rename one
   * gesture: a reader who means to replace the word types it, and a reader who means to edit
   * inside it presses an arrow key first. `focus()` and `select()` are two calls rather than one
   * because the spec says `select()` only sets the selection — Chromium focuses on select, so a
   * missing `focus()` is a defect that only the suite can see.
   */
  it("opens named for the folder, holding the current name, selected", () => {
    mount({ rename: RENAMING });

    const input = field() as HTMLInputElement;
    expect(input).toHaveValue("Trade binder");
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Trade binder".length]);
  });

  /**
   * **The figures line stays, and it is the whole reason a rename is not the create tile with
   * another label.** A reader renaming *Trade binder* is looking at the drawer holding twelve
   * cards worth $340.25; a box that dropped the count while they typed would make them stop and
   * check they had the right one. Asserted *inside the field's own form* rather than merely
   * present on the card, because a line that survived somewhere else on the tile would be a
   * different drawing that passes the same `getByText`.
   */
  it("goes on saying what is in the drawer while the name is being edited", () => {
    mount({ rename: RENAMING });

    const figures = screen.getByText("12 cards · $340.25");
    expect(figures).toBeInTheDocument();
    expect(field().closest("form")!.contains(figures)).toBe(true);
  });

  /**
   * **The caret's way back, and it is a fact about the *transition*.**
   *
   * The control the field replaced is the `⋯`, so by the time the page's own dismiss tries to
   * focus what it remembered, that element has been unmounted and `focus()` is a silent no-op —
   * `useFolderFieldReturn` is the answer, and this is the assertion that the card handed it the
   * right ref. The end state is the one every ordinary close leaves: the focused input unmounts
   * and the browser drops the caret to `<body>`. (That `<body>` guard is the hook's own and is
   * fenced where the hook lives; what could break *here* is the ref landing on nothing, or on the
   * folder button instead, and a reader whose Tab restarts from the top of the app is the symptom
   * of either.)
   */
  it("hands the caret to the ⋯ when the field closes", () => {
    const view = mount({ rename: RENAMING });
    expect(field()).toHaveFocus();

    view.show({ rename: RESTING });

    expect(screen.getByRole("button", { name: "Manage Trade binder" })).toHaveFocus();
  });

  /**
   * **Enter is the form's own submission and the tick is the same answer**, but which callback
   * each arm reaches is this card's wiring rather than the field's — and a submit wired to
   * `onCancel` would look right on screen and quietly throw the reader's typing away.
   */
  it("hands the page the name typed, and the cancel separately", async () => {
    const user = userEvent.setup();
    mount({ rename: RENAMING });

    await user.keyboard("Binder{Enter}");
    expect(onRenameSubmit).toHaveBeenCalledWith("Binder");
    expect(onRenameCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRenameCancel).toHaveBeenCalledTimes(1);
    expect(onRenameSubmit).toHaveBeenCalledTimes(1);
  });

  /**
   * **A copy dropped on a drawer whose name is being edited files perfectly well, and the targets
   * are left registered on purpose.** Tearing them down would make the wall answer a drag
   * differently depending on a state the *dragger* cannot see — they are renaming a folder three
   * tiles away, and this one silently stops taking cards.
   *
   * The wash is not asserted and cannot be: `DROP_OVER` is drawn on the folder button, which is
   * exactly what the field replaced. The ring on the `<li>` and the delivered drop are the claim.
   */
  it("still takes a copy while its name is being edited", async () => {
    mount({ withSource: true, rename: RENAMING });
    standRenaming();

    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(renaming(), DROP_RING)).toBe(true);

    await held.over(renaming());
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP);
  });

  /** The other target, the same way — and the drop line still moves with the pointer, because it
   *  is drawn on the `<li>` rather than on anything the field replaced. */
  it("still takes a folder beside it while its name is being edited", async () => {
    mount({ withFolder: true, rename: RENAMING });
    standRenaming();

    const held = await startPointerDrag(screen.getByText("the folder"));
    await held.over(box(renaming()), BEFORE);
    expect(line(renaming())).toBe("before");

    await held.drop();
    expect(onDropFolder).toHaveBeenCalledWith(OTHER_FOLDER, "before");
  });

  /**
   * **What the field _does_ suppress is the card as a drag source**, and the mechanism is one
   * `data-no-drag` on the `<form>` matched with `closest()` — so the input, the tick and the cross
   * are covered by one mark rather than three. Without it, pressing into the name and moving five
   * pixels files the folder somewhere and the press that was meant is never delivered.
   *
   * **The tick is what makes this non-vacuous.** `NOT_A_DRAG` excludes `input` by tag, so a press
   * in the box would be refused whether the form were marked or not; a `<button>` is excluded by
   * nothing — `dndManager` replaced the library's own `preventActivation` precisely so that a
   * card's name-as-a-button stays a grab handle — so the tick's press is refused by the mark and
   * by nothing else. Driven as well as read, because the selector and the sensor agreeing is the
   * thing that has to be true. **And it is the mark doing it**: driven while writing this, the
   * same gesture pressed on the `<li>` itself — the one pixel of a renaming card the form does not
   * cover, and therefore not an assertion worth keeping — started the drag, so the source is live
   * on a renaming card and the tick's press is refused by the `<form>` rather than by a
   * registration that went missing with the folder button.
   */
  it("refuses to be picked up by a press inside the field", async () => {
    mount({ rename: RENAMING });
    standRenaming();

    const guard = field().closest("[data-no-drag]");
    expect(guard?.tagName).toBe("FORM");
    const tick = screen.getByRole("button", { name: "Rename folder" });
    expect(tick.closest(NOT_A_DRAG)).toBe(guard);
    expect(screen.getByRole("button", { name: "Cancel" }).closest(NOT_A_DRAG)).toBe(guard);

    const refused = await startPointerDrag(renaming(), { pressOn: tick });
    expect(refused.started).toBe(false);
    await refused.cancel();
  });
});

describe("CollectionBreadcrumb", () => {
  function mount({
    trail = [BINDER, FOILS] as readonly CollectionFolder[],
    canDrop = () => true,
    withSource = false,
    flattened = false,
    withTile = false,
  }: {
    trail?: readonly CollectionFolder[];
    canDrop?: (drop: CollectionDrop, folderId: number | null) => boolean;
    withSource?: boolean;
    flattened?: boolean;
    withTile?: boolean;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        {withTile && <TileSource />}
        <CollectionBreadcrumb
          trail={trail}
          flattened={flattened}
          onOpen={onOpen}
          canDrop={canDrop}
          onDropCard={onDropCard}
        />
      </>,
    );
  }

  /**
   * Every segment given a box of its own, stacked clear of the source's.
   *
   * dnd-kit hit-tests by **coordinate** and jsdom measures every rectangle as four zeroes, so a
   * bar nobody has measured is a row of targets piled on the origin: the pointer is over all of
   * them at once and which one a drop lands on is not a fact any case below would be stating.
   * 60px apart and starting past {@link SOURCE_BOX}, so every landing is unambiguous.
   *
   * **The folder the reader is standing in is boxed too, though it is no target.** It is the one
   * segment that must refuse a copy, and a refusal is only worth anything if the pointer really
   * arrived there — an unboxed span is a drop that *missed*, which looks identical.
   */
  const stand = () => {
    const bar = screen.getByRole("navigation", { name: "Collection folders" });
    [...bar.querySelectorAll<HTMLElement>("button, [aria-current]")].forEach((element, index) =>
      boxed(element, 200 + index * 60),
    );
  };

  it("draws the trail root-most first, with the folder you are in current and inert", () => {
    mount();
    expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trade binder" })).toBeInTheDocument();
    // The folder the reader is standing in is not a place to go.
    expect(screen.queryByRole("button", { name: "Foils" })).not.toBeInTheDocument();
    expect(screen.getByText("Foils")).toHaveAttribute("aria-current", "page");
  });

  it("makes the root itself current when the reader is already there", () => {
    mount({ trail: [] });
    expect(screen.queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
    expect(screen.getByText("Collection")).toHaveAttribute("aria-current", "page");
  });

  /**
   * **Flattened, the trail becomes a sentence about what is on screen.** With every folder drawn
   * at once there is no level to walk to, so a segment would be a door into the place the reader
   * is already standing — and, filed deeper, a drop target for a move that means nothing.
   *
   * The landmark and its name survive the switch on purpose: `CollectionPage` keeps this bar
   * while it puts the wall and the pinned strip away, so this is the only thing on screen saying
   * why three bands just vanished, and anything looking for `Collection folders` has to find it
   * in either state.
   */
  it("says what is on screen instead of a trail, once the filing is ignored", () => {
    mount({ flattened: true });
    const bar = screen.getByRole("navigation", { name: "Collection folders" });
    // `\s*` around the middot: a CSS gap between inline boxes is not a space to the accname
    // algorithm, and jsdom cannot referee that either way.
    expect(bar).toHaveTextContent(/Collection\s*·\s*all folders/);
    expect(within(bar).queryByRole("button")).toBeNull();
    // Not merely unlinked — the folder the reader was in is not named at all, because the list
    // is no longer showing it rather than everything else.
    expect(screen.queryByText("Trade binder")).not.toBeInTheDocument();
    expect(screen.queryByText("Foils")).not.toBeInTheDocument();
  });

  it("climbs to the root and to an ancestor", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Collection" }));
    expect(onOpen).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Trade binder" }));
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  /** The whole reason the segments are drop targets: without this a drag can only ever push copies
   *  deeper, and nothing on the page brings one back. */
  it("takes a copy dropped on the root and un-files it", async () => {
    mount({ withSource: true });
    stand();
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    expect(marked(root, DROP_OVER)).toBe(true);
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP, null);
  });

  it("takes a copy dropped on an ancestor and moves it up", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    await held.over(screen.getByRole("button", { name: "Trade binder" }));
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP, 3);
  });

  /** The way back out has to work for a tile as well, or the wall's drag is one-way: a reader who
   *  filed a printing three folders down by dragging would have to reach for the menu to undo it. */
  it("takes a whole tile dropped on the root and un-files every copy", async () => {
    mount({ withTile: true });
    stand();
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(TILE_DROP, null);
  });

  /** One `canDrop` per segment *and* per shape — the page can answer differently about a tile at
   *  the root than about the same tile on an ancestor, and only it knows why. */
  it("asks the page about each segment separately for a tile too", async () => {
    mount({ withTile: true, canDrop: (drop, folderId) => drop.kind === "tile" && folderId === 3 });
    stand();
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(false);

    await held.cancel();
  });

  it("offers no drop on the folder the reader is already standing in", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(screen.getByText("Foils"), DROP_RING)).toBe(false);

    await held.over(screen.getByText("Foils"));
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("asks the page about each segment separately", async () => {
    // Only the root says yes, so only the root lights up — one `canDrop` per segment rather than
    // one answer for the whole bar.
    mount({ withSource: true, canDrop: (_drag, folderId) => folderId === null });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(false);

    await held.cancel();
  });
});
