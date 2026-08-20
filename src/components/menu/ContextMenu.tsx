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
  isTextEntry,
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
 * The depth of the deepest panel that survives a move from `prev` to `next`.
 *
 * A panel at depth `d` is drawn because `openPath[d - 1]` names the row it hangs off, so it is
 * still the same panel afterwards only if `next` agrees with `prev` about every entry above it —
 * the length of their common prefix. Everything below that depth is unmounted, whether it is
 * closing (a shorter path) or being replaced by a sibling's panel at the same depth.
 */
const keptDepth = (next: string[], prev: string[]): number => {
  let depth = 0;
  while (depth < next.length && depth < prev.length && next[depth] === prev[depth]) depth += 1;
  return depth;
};

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
  /**
   * Hand focus back and close, with no thing to do — a lazy panel's `onDone`, for a body that
   * finishes *without* a row being chosen.
   *
   * **It hands the caret back, and until 2026-08-14 it did not.** The reader who pressed `Add` in
   * the deck editor's "Tag card → New tag…" field had acted as deliberately as the reader who
   * picks an existing tag two rows above it, and that row goes through {@link run} — so a panel
   * whose halves disagreed about the caret dropped it on `<body>` for one of them. This is
   * {@link run} minus the action, and that is the whole of the difference between them. **That
   * field is gone since 2026-08-20** — the row opens a dialog now, so no shipped panel has one —
   * and the contract is unchanged: a `lazy` body that finishes without a row is still a thing
   * this primitive supports, and `ContextMenu.test.tsx` drives it with a fixture of its own.
   *
   * Not to be confused with an **outside press**, which closes and deliberately hands the caret
   * to nobody: that path calls `onClose` directly and is untouched by this. A reader who clicks
   * elsewhere has said where they want to be.
   */
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
      // order and stops being announced, and a greyed row exists to be read: it is how the reader
      // finds out that the thing they came for is not on offer *here* rather than gone.
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
          accessible name, deliberately: "View all printings, you are already looking at them"
          is one sentence and reads as one.

          **Optional, and a caller that leaves it out is not being lazy.** A row is as wide as
          its widest content, so a `reason` sets the width of every row in the panel — which is
          why the deck menu's two zone rows grey silently and word their refusal nowhere (see
          `deckCardMenu.tsx`'s `zoneItem`). A reason belongs here when it is a phrase; a
          rules sentence belongs where there is room to read it. */}
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
 *
 * ## Two rules a caller has to keep
 *
 * **`id` must be unique within one level, and only within one level.** The caret, the expanded-row
 * path and React's keys all key on it, and the path is *itself* keyed by depth — so a folder and a
 * deck inside it may share an id, while two decks in one panel may not. Two siblings with one id
 * expand and collapse each other.
 *
 * **A row's `onSelect` must not also call `onDone`.** Choosing a row already closes the whole menu
 * — that is what `ActionRow` and `MenuRadio` mean — so an `onSelect` that closes as well is a
 * second close of something already gone. `onDone` is for a body that finishes *without* a row
 * being pressed: a form it drew itself, a step it completed on its own.
 *
 * And one thing that is not a rule but bites the same way: **`lazy` is a promise about mounting,
 * not about rendering.** A body is mounted once, when its row is expanded, so a query in it fires
 * once — but the component may re-render many times while the menu is open (any re-render of the
 * menu reaches it; nothing in between is memoised, measured 2026-08-14). Work belongs in its
 * hooks, not in its body.
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

  // Memoised because it is a **context value** now: an identity that changed every render would
  // be a context change every render, which is the one thing a context consumer cannot opt out of.
  // The two setters read `prev`, so nothing here goes stale between renders `openPath` did not
  // cause.
  //
  // **It does not stop a lazy body from re-rendering, and an earlier version of this comment
  // claimed it did.** Measured 2026-08-14 with a throwaway probe — a re-render of `ContextMenu`
  // with `ctx` identical still ran a `MenuLazy.Content` a second time. Nothing between here and
  // that body is `memo()`d, so every element down the chain is rebuilt and the re-render arrives
  // whatever this identity is. That is correct and worth stating plainly for whoever writes one:
  // **`lazy` is a promise about mounting, not about rendering.** The query fires once; the
  // component may run many times, so a body's work belongs in its hooks and not in its body.
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
      // `run` with nothing to run. See the declaration for why the hand-back belongs here too,
      // and why an outside press — which calls `onClose` directly — is not this.
      close: () => {
        opener?.focus();
        onClose();
      },
    }),
    [openPath, opener, onClose],
  );

  // The caret starts on the panel, so Escape has something to hand back and the first ArrowDown
  // is not swallowed by an element outside the menu. Measuring here too: `offsetWidth`/
  // `offsetHeight` are the layout box and ignore the entry animation's `scale`, which a
  // `getBoundingClientRect()` taken in this same tick would be 4% short of.
  useLayoutEffect(() => {
    // **A hover armed against the menu that has just gone away, disarmed with it** — the third
    // thing a new `openId` resets, and the one the render-phase block above cannot do, because
    // clearing a timer is a side effect and a render is not where those go. Here rather than in
    // an ordinary effect so it lands in the same commit that drew the new menu: a `setTimeout`
    // callback is a macrotask, and React renders a discrete event's update synchronously, so
    // there is no moment between the reset and this line for the stale timer to fire in.
    //
    // A pointer that leaves the panel fires no `pointerover` the panel can hear, so nothing else
    // ever disarms one — and the reader whose pointer left is exactly the reader about to
    // right-click something else. The cost of leaving it is not a stale expansion but a **mounted
    // `lazy` body**: card menu ids are the same on every card, so the path still names a row of
    // the menu now on screen, and the queries the `lazy` kind exists to keep off a right-click
    // fire on a right-click.
    clearHover();
    const el = panelRef.current;
    if (!el) return;
    el.focus();
    const width = Math.max(el.offsetWidth, MENU_MIN_WIDTH);
    const height = Math.max(el.offsetHeight, MENU_MIN_HEIGHT);
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [openId]);

  /**
   * **A pending hover is only valid for the cascade state it was armed in** — so any change to
   * that state disarms it, whatever moved it.
   *
   * The timer's callback is a macrotask closed over the `openPath` of the render that armed it,
   * and until this line the only things that disarmed one were `onPointerOver`, a new `openId` and
   * the unmount. `openSubmenu`/`closeSubmenu` touch no timer, so a click or an ArrowRight inside
   * the 120ms window left a callback reasoning about a cascade that had already moved: the pointer
   * settles on "Open on" (armed with `next` = `["open-on"]`, closure `openPath` = `[]`), the reader
   * clicks it, `focusInto` puts the caret in the panel that opened — and the timer then computes
   * `keptDepth(["open-on"], [])` = 0 against the *stale* path, finds the caret two levels below
   * that, and hands it back out of the panel it had just been put in. `setOpenPath` writes an equal
   * path, so the submenu stays open with the caret outside it: ArrowDown walks the root panel and
   * Enter collapses what the reader had just asked for. It was harmless before the hand-back
   * existed — one wasted render — which is what kept it out of sight.
   *
   * **Disarming rather than reading the live path out of a ref at fire time**, and the difference
   * is which half is stale. A ref would fix `handBack`'s arithmetic and leave the callback's
   * *intent* stale — `next` was computed from the old path too, so a hover that resolved to
   * "collapse everything" would still collapse a submenu the reader opened by keyboard a
   * moment later, correctly handing the caret back on its way. The whole callback is out of date,
   * not one of its inputs.
   *
   * It costs the ordinary cases nothing. A timer that has already fired nulls the ref before it
   * writes, so the effect this write triggers clears nothing; a pointer sweeping between rows
   * re-arms through `onPointerOver`, which clears first anyway; and a hover that opens or
   * collapses is the very write whose state the next hover must be armed against.
   */
  useLayoutEffect(() => {
    clearHover();
  }, [openPath]);

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
    //
    // **It hands the caret back, and it is not the outside press above.** That carve-out rests on
    // "the reader who clicked elsewhere is already somewhere else"; a wheel spin puts the reader
    // nowhere new, so this is the ordinary rule every other close in this file keeps — Escape's
    // rung, `Tab`, `run` and `close` all focus the opener while the panel is still on screen. The
    // caret is *always* inside the panel on a menu nobody has touched with the keyboard, because
    // the `[openId]` effect focuses it there on open; left alone, the fading panel goes `inert`
    // under it and the caret ends up on `<body>`, outside the React root, so the next Tab restarts
    // from the top of the app.
    //
    // **`preventScroll`, which is the reason this is not a one-liner.** `focus()` scrolls its
    // element into view by default, so a bare hand-back would fight the very scroll that closed
    // the menu and jump the page back under the reader.
    //
    // Guarded on the caret being ours to move, which the deliberate closes need no equivalent of:
    // they are a key or a press *in the panel*, while this fires for any scroll anywhere —
    // including one no reader caused, an image settling or a `scrollIntoView` from a background
    // query — and such a scroll must close the menu without also seizing focus from wherever it
    // legitimately is.
    const onAway = () => {
      if (panelRef.current?.contains(document.activeElement)) {
        opener?.focus({ preventScroll: true });
      }
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
    // `opener` joins the deps with the hand-back above. It is one field of the provider's open-menu
    // state and changes only when a fresh right-click replaces the whole of it, so the three
    // listeners are still registered once per open rather than once per render.
  }, [onClose, opener, present]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const root = panelRef.current;
    if (!root) return;
    // **Tab closes the menu — and it is the one key a field does not get, which is why it is
    // tested before the yield below rather than after it.**
    //
    // Not trapped. Rows are `tabIndex={-1}`, so a panel's only tab stop is a field a lazy body
    // drew, and a trap with one stop cycles that field to itself and reads as a stuck key. The
    // ARIA menu pattern says Tab closes, and here that is also what the reader means: Tab is
    // "I am done here, move on", never a request to stay. Left alone it was a bug in its own
    // right — focus left for the page behind while the panel stayed up, so the reader was
    // somewhere else looking at a menu that was still open.
    //
    // **The same two lines as Escape's rung, ending somewhere else, and the difference is the
    // `preventDefault` that is deliberately not here.** Escape's rung prevents the press and the
    // caret therefore *stays* on the opener — a hand back. This lets the press through, so the
    // opener is a waypoint rather than a destination: the browser's own Tab carries on from it to
    // whatever follows it, which is the forward motion the reader asked for. Focusing the opener
    // first is what makes "the next thing after the opener" true rather than "the first thing in
    // the document", which is where the caret lands if the menu simply unmounts under it.
    //
    // **Shift+Tab takes this branch too, deliberately.** It is the same sentence backwards — "I am
    // done here, move on" — and the un-prevented press then walks backwards from the opener, which
    // is where a reader reversing out of the menu expects to arrive.
    //
    // **A body that wants Tab can keep it today, with no change to any contract.** React
    // dispatches child-first, so a field that handles its own `keydown` and calls
    // `stopPropagation()` never reaches this line — which is the escape hatch for a lazy body with
    // two fields to move between, or a slider that wants the arrow keys back.
    //
    // **A half-typed field is discarded, and that is the house rule rather than a shrug.**
    // `FolderTree`'s rename field says it in as many words — clicking or tabbing away discards a
    // half-typed name, as every other popup in this app discards its half-made decision — and it
    // names tabbing away specifically. Committing instead is not a thing this file *can* do: a
    // `Content` is somebody else's component, its value and what "commit" would mean are entirely
    // its own, and `MenuLazy` hands it nothing but `onDone`. Making that possible is a change to
    // the contract, not a bug fix, so it is not smuggled in here.
    if (e.key === "Tab") {
      opener?.focus();
      onClose();
      return;
    }

    // **A text field inside a panel is a mode, and while the caret is in one every key below
    // belongs to it.** A panel that owns the arrows, Home and End is right for a list of rows and
    // wrong for a caret in a field: typing works and *editing* does not, which is how this arrived
    // — the deck editor's "Tag card ▸ New tag…" drew the first input any panel has ever held, and
    // on 2026-08-20 it became a row that opens a dialog, so it drew the last one too. The rule
    // stays because the *kind* does: `lazy` exists for a body a `MenuItem[]` cannot express, and
    // a field is the reason such a body would be written. Driven by a fixture in the suite now
    // rather than by a shipped menu, which is worth knowing before trusting a green run here.
    //
    // All of them yield, including `ArrowUp`/`ArrowDown`, which have no caret meaning in a
    // single-line input and could defensibly have stayed the menu's. They do not, and the reason
    // is sharper than "the caret moves somewhere unhelpful": **there is no type-ahead here, so a
    // caret knocked onto a row does not swallow the next characters — it fires them.** Space and
    // Enter on a focused `ActionRow` are its `onClick`. A reader typing "new tag" into a field the
    // caret has silently left runs whatever row it landed on, which for this menu is a write to
    // their deck. Yielding costs one Escape to get back to the rows; that is not a comparison.
    //
    // Escape is untouched by this and must stay so — it is `useDismissOnEscape` on `window`, not
    // this handler, and the `switch` below has no `Escape` case for the yield to have taken.
    // That is what makes the yield safe: the way out of the field still works.
    //
    // `isTextEntry` and **not** `useContextMenu`'s `isTextField`, which matches every `<input>`:
    // a checkbox or a radio yielding all six keys would strand the caret on a control the arrows
    // do nothing to. Whether a *right-click* on a checkbox should get the browser's menu is a
    // separate question, so it keeps its own separate predicate.
    if (isTextEntry(e.target)) return;
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
   * The caret, moved out of a panel that is about to be unmounted — **the hover's half of a rule
   * every other close in this file already keeps.**
   *
   * ArrowLeft focuses the parent row before it collapses, `Submenu`'s Escape focuses its own row
   * before it closes, and a click on a parent row is focused by the click that closed it. A
   * hover-collapse writes `openPath` with nothing under the pointer having taken the caret, so it
   * is the one route that can unmount the element holding `document.activeElement`. That drops the
   * caret on `<body>`, which is **outside the React root** — so the panel's `onKeyDown` stops
   * firing altogether and the arrows, Home, End *and Tab* go dead while the panel is still up.
   * Tab is the one that does damage: unhandled, it falls through to the browser and walks focus
   * into the page behind a menu the reader can still see.
   *
   * The hand-back target is ArrowLeft's, arrived at the same way: the row that the deepest doomed
   * panel hangs off. Only the caret is moved and only when it is inside something closing, so a
   * sweep across rows while the caret sits in the root panel goes on rearranging nothing.
   */
  const handBack = (next: string[]) => {
    const root = panelRef.current;
    const caret = document.activeElement;
    if (!root || !(caret instanceof Element) || !root.contains(caret)) return;
    const panel = panelOf(caret);
    if (!panel) return;
    const kept = keptDepth(next, openPath);
    if (depthOf(panel) <= kept) return;
    const doomed = root.querySelector<HTMLElement>(panelAtDepth(kept + 1));
    const parentRow = doomed?.closest<HTMLElement>(ROW_SELECTOR);
    if (parentRow) rowButtonOf(parentRow)?.focus();
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
    // **A field is a mode for the pointer too, and this half costs the reader their words.**
    // Hover-to-open is the panel assuming its contents are rows: a sweep onto a row that opens
    // nothing collapses whatever was open, which — once a panel holds a field — is a half-typed
    // tag name deleted by a nudge of the mouse while the reader is looking at the keyboard. So
    // while the caret is in a field anywhere in this cascade, the pointer rearranges nothing.
    // The caret leaving the field is what turns hover back on, and that is a deliberate act.
    //
    // **It suppresses hover-*opening* too, including of a submenu in the field's own panel**, and
    // that is the deliberate half of a blunt rule rather than an oversight: a reader mid-word is
    // not asking for a panel, and every such row is still one click away. `isTextEntry` for the
    // reason the key guard above gives — a checkbox must not disable hover for the whole cascade.
    const caret = document.activeElement;
    if (isTextEntry(caret) && panelRef.current?.contains(caret)) return;

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
      // The caret first, while the panel it is in is still on screen -- then the collapse. Same
      // order, and the same two lines, as ArrowLeft and as `Submenu`'s Escape.
      handBack(next);
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
      // `inert` is the half `aria-hidden` cannot do: it takes the fading panel out of the **focus**
      // order as well as out of the accessibility tree. That mattered less when every row was
      // `tabIndex={-1}` and nothing inside was a tab stop — and Tab is now the first key that can
      // walk a caret into a panel on its way out, since a lazy body's field is a real one.
      inert={!present || undefined}
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
