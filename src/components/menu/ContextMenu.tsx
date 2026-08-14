import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motion, useIsPresent } from "motion/react";
import { Check } from "lucide-react";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { Submenu } from "./Submenu";
import {
  MENU_MIN_HEIGHT,
  MENU_MIN_WIDTH,
  PANEL_CLASS,
  ROW_CLASS,
  ROW_SELECTOR,
  depthOf,
  focusInto,
  moveCaret,
  panelAtDepth,
  panelOf,
  placeMenu,
  rowButtonOf,
} from "./panel";
import type { MenuAction, MenuItem, MenuPosition, MenuRadio } from "./types";

/**
 * How long the pointer has to rest on a row before its submenu opens, in ms.
 *
 * A timer, where almost nothing else in this app has one, and it is allowed for the reason
 * `CardZoomIndicator`'s is: **it is not a transition.** Nothing about the panel's arrival is
 * decided here — that is {@link popup}'s, and `MotionConfig` turns it down for a reader who asked
 * the OS for less. All this decides is when a pointer that is *passing over* a row becomes a
 * pointer that is *pointing at* it. Short, because the reader has already aimed: the diagonal
 * sweep from a parent row down to a submenu's third item crosses two or three rows on the way,
 * and 120ms is longer than that sweep takes and shorter than a deliberate stop.
 */
export const SUBMENU_HOVER_MS = 120;

/** Nothing expanded, and no size measured yet — module constants so a reset can compare by identity. */
const NO_SUBMENU: string[] = [];
const UNMEASURED = { width: MENU_MIN_WIDTH, height: MENU_MIN_HEIGHT };

const samePath = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * What every row needs and no row should be handed one prop at a time.
 *
 * `openPath` is the chain of expanded rows, one id per level: `openPath[d]` is the row expanded in
 * the panel at depth `d`. A path rather than a single id because a submenu may hold a submenu, and
 * a flag per row could describe two open siblings — a state the cascade cannot be in.
 */
interface RowsContext {
  openPath: string[];
  /** `rowDepth` is the depth of the panel the row is drawn in; its panel opens one below. */
  openSubmenu: (rowDepth: number, id: string, focus: boolean) => void;
  closeSubmenu: (rowDepth: number) => void;
  /** Hand focus back, close the menu, then do the thing. */
  run: (onSelect: () => void) => void;
  /** Close the whole menu and hand focus nowhere — a lazy panel's `onDone`. */
  close: () => void;
}

/**
 * The cascade a set of rows is being drawn into: its machinery, and **which panel it is in**.
 *
 * Depth is here rather than passed down the recursion because a lazy panel's body is not part of
 * the recursion at all — `MenuLazy.Content` is somebody else's component, and it is handed nothing
 * but `onDone`. Reading the depth from a provider that {@link Submenu}'s own children sit inside
 * means a foreign component's rows are at the depth of the panel they are actually drawn in,
 * without anyone having to tell it what that is or being able to get it wrong.
 */
interface Cascade {
  ctx: RowsContext;
  depth: number;
}

/**
 * What {@link MenuRows} does outside a menu: draw the rows, open no submenus, run what is pressed.
 *
 * Rows outside a cascade are a real case rather than a defensive one — a story that wants to look
 * at a set of rows without opening a menu around them is the obvious way to catalogue this — and
 * a component that throws there would make that impossible for no gain. `run` still calls through,
 * because "press it and the thing happens" is the part that does not depend on a panel.
 */
const NO_CASCADE: Cascade = {
  ctx: {
    openPath: [],
    openSubmenu: () => {},
    closeSubmenu: () => {},
    run: (onSelect) => onSelect(),
    close: () => {},
  },
  depth: 0,
};

/**
 * **Private on purpose, and that is the whole design of the seam.**
 *
 * A lazy `Content` needs the cascade in order to draw rows that join it, and there were three ways
 * to give it one: widen `MenuLazy.Content`'s props, export this context, or export a component that
 * reads it. Exporting the context makes every field of `RowsContext` — an `openPath` keyed by
 * depth, a `focusDepth` protocol, the ordering rules between them — a public contract that any
 * consumer may reimplement and this module must then keep. {@link MenuRows} is the whole of what a
 * consumer needs and the only thing exported; everything above stays free to change.
 */
const CascadeContext = createContext<Cascade>(NO_CASCADE);

/** Everything inside this is one panel deeper. Memoised, so a re-render is not a context change. */
function CascadeLevel({ ctx, depth, children }: Cascade & { children: ReactNode }) {
  const value = useMemo(() => ({ ctx, depth }), [ctx, depth]);
  return <CascadeContext.Provider value={value}>{children}</CascadeContext.Provider>;
}

/** The colours of a row the caret may land on. The caret is real focus, so `focus:` is the caret. */
const LIVE_ROW = "text-text hover:bg-bg focus:bg-bg";

function ActionRow({ item, run }: { item: MenuAction; run: RowsContext["run"] }) {
  const disabled = item.disabled === true;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      // Both row attributes on one element, because a plain row *is* its button — where a submenu
      // row is a box holding a button and a panel. The pointer and the caret find every row by
      // `ROW_ATTR` and neither cares which shape it got; `rowButtonOf` is the one place that does.
      // Without this the hover handler cannot resolve a plain row at all, and a submenu opened by
      // hover stays open while the pointer sweeps past it to the row below.
      data-menu-row={item.id}
      data-menu-row-button=""
      // `aria-disabled`, and never the `disabled` attribute. A `disabled` button leaves the tab
      // order and stops being announced, and the greyed "Set as commander" row exists to be read:
      // its whole job is to say why the thing the reader came for is not on offer.
      aria-disabled={disabled ? true : undefined}
      onClick={() => {
        if (!disabled) run(item.onSelect);
      }}
      className={cn(ROW_CLASS, disabled ? "text-dim" : LIVE_ROW)}
    >
      {item.Icon && <item.Icon className="size-4 flex-none" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {/* `text-dim`, which is this app's only dim-text class — the retired spelling still
          compiles and paints the surface colour on the surface, and `tokens.test.ts` sweeps
          prose as eagerly as code for it, so it is not named here either. Part of the row's own
          accessible name, deliberately: "Set as commander, not a legendary creature" is one
          sentence and reads as one. */}
      {item.reason && <span className="flex-none text-[0.7rem] text-dim">{item.reason}</span>}
    </button>
  );
}

function RadioRow({ item, run }: { item: MenuRadio; run: RowsContext["run"] }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      tabIndex={-1}
      // See `ActionRow`: a plain row carries both attributes, and the hover handler needs it.
      data-menu-row={item.id}
      data-menu-row-button=""
      aria-checked={item.checked}
      onClick={() => run(item.onSelect)}
      className={cn(ROW_CLASS, LIVE_ROW)}
    >
      {/* `invisible` rather than absent, so the labels of a set of choices line up whether or not
          the reader has picked one yet. `aria-checked` above is what actually says so. */}
      <Check
        className={cn("size-4 flex-none text-accent", !item.checked && "invisible")}
        aria-hidden="true"
      />
      {item.Icon && <item.Icon className="size-4 flex-none" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  );
}

/**
 * One panel's worth of rows, and — through {@link Submenu} — every panel below it.
 *
 * The recursion is here rather than in `Submenu` on purpose: a submenu's body is handed to it as
 * `children`, an element this function *builds* and does not render. That is what keeps
 * `MenuLazy.Content` honest. Building `<Content onDone={…} />` creates an object; only mounting it
 * calls the component, and only the expanded branch of `Submenu` mounts anything. So a menu with
 * six lazy rows reaches the backend zero times when it opens, which is the entire reason that kind
 * exists.
 *
 * ## The one thing this module exports for a `MenuLazy.Content` to use
 *
 * A lazy body that wants to offer real choices — a folder tree, a deck list — should not have to
 * rebuild a row. Rendering `<MenuRows items={…} />` inside a `Content` gets the same rows the menu
 * draws for itself: the same caret and `focus:` styling, the same `data-menu-row` attributes that
 * put them on the caret's walk, and, for a nested `MenuSubmenu`, the same ArrowRight to expand,
 * ArrowLeft to collapse, `aria-haspopup`/`aria-expanded`, and one Escape per level.
 *
 * **It takes no depth and no context object**, because both are facts about where it is being
 * rendered rather than decisions a caller should be making — and a caller that could pass the
 * wrong depth would produce a cascade whose levels close each other. It reads them from the panel
 * it is inside, so a `Content` mounted at depth 3 is at depth 3 without knowing the number exists.
 */
export function MenuRows({ items }: { items: MenuItem[] }) {
  const { ctx, depth } = useContext(CascadeContext);
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "separator":
            return <div key={item.id} role="separator" className="my-1 h-px bg-border" />;
          case "action":
            return <ActionRow key={item.id} item={item} run={ctx.run} />;
          case "radio":
            return <RadioRow key={item.id} item={item} run={ctx.run} />;
          case "submenu":
            return (
              <Submenu
                key={item.id}
                id={item.id}
                label={item.label}
                Icon={item.Icon}
                panelDepth={depth + 1}
                open={ctx.openPath[depth] === item.id}
                onOpen={(focus) => ctx.openSubmenu(depth, item.id, focus)}
                onClose={() => ctx.closeSubmenu(depth)}
              >
                {/* The body of a panel is one level deeper than the row that opens it, and that
                    is stated here — once, for both kinds — rather than threaded through the
                    recursion, so that the built-in case and the foreign one below cannot drift. */}
                <CascadeLevel ctx={ctx} depth={depth + 1}>
                  <MenuRows items={item.items} />
                </CascadeLevel>
              </Submenu>
            );
          case "lazy":
            return (
              <Submenu
                key={item.id}
                id={item.id}
                label={item.label}
                Icon={item.Icon}
                panelDepth={depth + 1}
                open={ctx.openPath[depth] === item.id}
                onOpen={(focus) => ctx.openSubmenu(depth, item.id, focus)}
                onClose={() => ctx.closeSubmenu(depth)}
              >
                {/* Still an element and not a call: `Content` is invoked when `Submenu` mounts
                    this, never before. Wrapping it changes nothing about that — a provider around
                    an unmounted subtree runs none of it — and it is what lets the body render
                    `<MenuRows>` of its own that lands at this depth. */}
                <CascadeLevel ctx={ctx} depth={depth + 1}>
                  <item.Content onDone={ctx.close} />
                </CascadeLevel>
              </Submenu>
            );
        }
      })}
    </>
  );
}

/**
 * The menu itself: one panel at the pointer, and whatever cascade the reader opens out of it.
 *
 * ## Why it is mounted where it is
 *
 * At the app root, as a sibling of `AppShell` — see `App.tsx`. A `z-index` competes only inside
 * its own stacking context, and every card surface in this app draws rows that are
 * `position: absolute` **and** transformed; a menu mounted where it was opened is capped at that
 * row's `LAYER.raised` and painted under the table header above it. There is no portal either:
 * the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a runtime
 * `<style>` that fails **silently** (`style.sheet` comes back null). Mounted at the root,
 * positioned by hand, drawn at the pointer.
 *
 * ## Why the caret is focus and not state
 *
 * Every arrow key in the cascade is handled once, here, and routed by asking the DOM which panel
 * `document.activeElement` is in. Two things fall out. A lazy panel's rows — somebody else's
 * component, rendered from data this file never saw — are reachable by the same code as every
 * other row. And moving the caret costs **no React state**, so a keystroke re-renders nothing,
 * which is what keeps a `MenuLazy.Content` mounted exactly once for as long as it is open.
 */
export function ContextMenu({
  openId,
  items,
  at,
  opener,
  onClose,
}: {
  /** Bumped by every `openMenu`. One panel is reused across opens; this is what resets it. */
  openId: number;
  items: MenuItem[];
  at: MenuPosition;
  /** What was right-clicked. Escape and a chosen action both hand the caret back to it. */
  opener: HTMLElement | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [openPath, setOpenPath] = useState<string[]>(NO_SUBMENU);
  const [size, setSize] = useState(UNMEASURED);
  const present = useIsPresent();

  /**
   * The depth of a submenu that has just been asked to open with the caret, or `null`.
   *
   * A **ref** and not state, and the difference is the whole of `MenuLazy`'s promise: a second
   * state update after the expansion would re-render `MenuRows`, hand `Submenu` a fresh `children`
   * element, and mount the lazy content a second time. Read by the deps-less layout effect below,
   * which runs after every commit and therefore after the one that drew the new panel.
   */
  const focusDepth = useRef<number | null>(null);
  const hoverTimer = useRef<number | null>(null);

  // A fresh right-click reuses this panel rather than replacing it — a second menu is never
  // stacked on the first — so the reset is here, adjusting state during render, which is React's
  // own answer for state derived from something that changed. (`CardZoomIndicator` does the same
  // on the same rule; an effect would cost a painted frame showing the previous menu's cascade.)
  const [seenOpen, setSeenOpen] = useState(openId);
  if (seenOpen !== openId) {
    setSeenOpen(openId);
    setOpenPath(NO_SUBMENU);
    setSize(UNMEASURED);
  }

  const placement = placeMenu(at, size.width, size.height);

  const clearHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  // Memoised because it is a **context value** now, and a context value penetrates the
  // `children`-identity bail-out that keeps a `MenuLazy.Content` from re-rendering: without this,
  // measuring the panel would re-render every foreign row in the cascade. The two setters read
  // `prev`, so nothing here goes stale between renders that `openPath` did not cause.
  const ctx = useMemo<RowsContext>(
    () => ({
      openPath,
      openSubmenu: (rowDepth, id, focus) => {
        if (focus) focusDepth.current = rowDepth + 1;
        setOpenPath((prev) => [...prev.slice(0, rowDepth), id]);
      },
      closeSubmenu: (rowDepth) => setOpenPath((prev) => prev.slice(0, rowDepth)),
      run: (onSelect) => {
        // The caret goes home first, while the row it came from is still mounted; then the menu
        // closes; then the thing happens — in that order, so an action that opens a dialog and
        // focuses it is not overwritten by a hand-back arriving late.
        opener?.focus();
        onClose();
        onSelect();
      },
      close: onClose,
    }),
    [openPath, opener, onClose],
  );

  // The caret starts on the panel, so Escape has something to hand back and the first ArrowDown
  // is not swallowed by an element outside the menu. Measuring here too: `offsetWidth`/
  // `offsetHeight` are the layout box and ignore the entry animation's `scale`, which a
  // `getBoundingClientRect()` taken in this same tick would be 4% short of.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.focus();
    const width = Math.max(el.offsetWidth, MENU_MIN_WIDTH);
    const height = Math.max(el.offsetHeight, MENU_MIN_HEIGHT);
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [openId]);

  // No dependency array: this has to run after *whichever* commit drew the panel that was just
  // asked for, and it changes no state, so running every time costs a null check.
  useLayoutEffect(() => {
    const depth = focusDepth.current;
    if (depth === null) return;
    focusDepth.current = null;
    const opened = panelRef.current?.querySelector<HTMLElement>(panelAtDepth(depth));
    if (opened) focusInto(opened);
  });

  useEffect(() => clearHover, []);

  // Escape's innermost rung while nothing is expanded; an open submenu pushes its own on top of
  // this one, which is what gives the reader one press per level. The inline `onDismiss` is safe:
  // the hook latches it in a ref, so only mount order moves the stack.
  //
  // **`enabled: present`, and that is the app's "register on the flag, not the mount" rule
  // reached through the only flag this component has.** `AnimatePresence` keeps this element
  // mounted for the length of its exit, so a rung tied to the mount would go on sitting at the
  // top of the stack after the menu had closed — eating the next Escape, and handing the caret
  // back to an opener the reader had already left.
  useDismissOnEscape({
    layer: "inner",
    enabled: present,
    onDismiss: () => {
      opener?.focus();
      onClose();
    },
  });

  useEffect(() => {
    // Down with the same flag, for the same reason: a panel on its way out must not close a menu
    // that has already closed, nor answer a scroll on behalf of one.
    if (!present) return;
    // An outside press closes and deliberately hands the caret back to nobody: the reader who
    // clicked elsewhere is already somewhere else. Capture, so a surface that stops its own
    // `pointerdown` cannot leave a menu open behind it.
    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    // A `fixed` panel positioned from a point that has scrolled away is worse than no panel, and
    // `scroll` does not bubble — so the listener is on `window` in the capture phase, which is
    // what reaches a scroller five levels down inside a view.
    const onAway = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
  }, [onClose, present]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const root = panelRef.current;
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    // Which panel the press belongs to is a question about where the caret is, not about where
    // the listener is: a submenu is a DOM descendant of this element, so its presses arrive here.
    const panel = panelOf(active) ?? root;
    const depth = depthOf(panel);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveCaret(panel, "next");
        return;
      case "ArrowUp":
        e.preventDefault();
        moveCaret(panel, "prev");
        return;
      case "Home":
        e.preventDefault();
        moveCaret(panel, "first");
        return;
      case "End":
        e.preventDefault();
        moveCaret(panel, "last");
        return;
      case "ArrowRight": {
        // Enter and Space are the row's own: a `<button>` fires a click for both, and the click
        // is what opens a submenu. This is the third way in and the only one with no click.
        const id = active?.closest<HTMLElement>(ROW_SELECTOR)?.dataset.menuRow;
        if (id === undefined || active?.getAttribute("aria-haspopup") !== "menu") return;
        e.preventDefault();
        ctx.openSubmenu(depth, id, true);
        return;
      }
      case "ArrowLeft": {
        if (depth === 0) return;
        e.preventDefault();
        // Focus first, while the row this panel hangs off is still on screen, then close.
        const parentRow = panel.closest<HTMLElement>(ROW_SELECTOR);
        if (parentRow) rowButtonOf(parentRow)?.focus();
        ctx.closeSubmenu(depth - 1);
        return;
      }
      default:
        return;
    }
  };

  /**
   * Hover, resolved against the DOM for the same reason the caret is.
   *
   * `onPointerOver` and not `onPointerEnter`: React synthesises enter/leave from over/out, and a
   * `pointerenter` dispatched at an element is an event this component cannot hear — `QuickAdd`
   * carries the same note. One listener on the root panel covers the whole cascade, because every
   * open submenu is inside it.
   *
   * A pointer in a panel's padding, between rows, resolves to the row that panel hangs off and
   * therefore changes nothing: crossing the gap on the way to a submenu must not close it.
   */
  const onPointerOver = (e: ReactPointerEvent) => {
    const row = (e.target as Element).closest<HTMLElement>(ROW_SELECTOR);
    const panel = row && panelOf(row);
    const id = row?.dataset.menuRow;
    if (!row || !panel || id === undefined) return;
    const depth = depthOf(panel);
    const opens = rowButtonOf(row)?.getAttribute("aria-haspopup") === "menu";
    // A row that opens nothing closes whatever the row above it opened — the second half of
    // "the pointer is pointing at this now", and the half that was unreachable while plain rows
    // carried no row attribute for the sweep above to find.
    const next = opens ? [...openPath.slice(0, depth), id] : openPath.slice(0, depth);
    clearHover();
    if (samePath(next, openPath)) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setOpenPath(next);
    }, SUBMENU_HOVER_MS);
  };

  return (
    <motion.div
      ref={panelRef}
      {...popup}
      role="menu"
      aria-orientation="vertical"
      tabIndex={-1}
      // Out of the accessibility tree and out of the way for the length of its fade. Every one of
      // this panel's dismissals — Escape, the outside press, the scroll — comes down with the flag
      // that closed it, so while it leaves it is painted and watched by nothing; a press on it
      // would land on a menu that can no longer close itself. `PopupListbox` carries the same
      // guard for the same reason, and `useIsPresent` is read *inside* the presence because that
      // is the only place the answer changes.
      aria-hidden={present ? undefined : true}
      data-menu-panel=""
      data-menu-depth="0"
      // Pixels, so a class cannot carry them: this is a measurement, and Tailwind emits no rule
      // for a class name it never saw in the source text.
      style={{ left: placement.left, top: placement.top }}
      onKeyDown={onKeyDown}
      onPointerOver={onPointerOver}
      className={cn(
        "fixed",
        // Pinned by the corner nearest the pointer and grown from that same corner. A popup that
        // grows from the middle of itself reads as unrelated to what produced it.
        placement.origin,
        LAYER.popup,
        PANEL_CLASS,
        !present && "pointer-events-none",
      )}
    >
      <CascadeLevel ctx={ctx} depth={0}>
        <MenuRows items={items} />
      </CascadeLevel>
    </motion.div>
  );
}
