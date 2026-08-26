import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { FILTER_UNAVAILABLE } from "@/components/FilterChips";
import { PopupPanel } from "@/components/PopupListbox";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { usePopupPlacement } from "./usePopupPlacement";
import type { DropdownOption, DropdownSize } from "./types";

/**
 * The props every dropdown shares — `<Dropdown>` here, `<MultiDropdown>` (Task 5) on top of
 * the same shell.
 *
 * **Declared once, in full, here.** Task 4 implements the search half (`searchable` and
 * everything below it but `onReachEnd`) and Task 8 implements `onOpen`; nothing re-declares
 * this type. `onReachEnd` is wired now, ahead of its own comment block, because the keyboard
 * that calls it is written once here rather than twice.
 */
export type SharedProps = {
  options: readonly DropdownOption[];
  /** @default "md" */
  size?: DropdownSize;
  /** @default "start" */
  align?: "start" | "end";
  /** Stretch to the container, chevron to the far edge. */
  fill?: boolean;
  /** Gold border and text — "this is not where the control opens". */
  active?: boolean;
  disabled?: boolean;
  /** The trigger's id, so a visible `<label htmlFor>` still presses it. */
  id?: string;
  /** `aria-label`, when there is no visible label. */
  label?: string;
  /**
   * id of the visible `<label>`.
   *
   * A `<label htmlFor>` never reaches a button's accessible name the way it reaches a
   * `<select>`'s — the button's own content is the picked value, so without this the name and
   * the content say the same thing and a screen reader never hears which field it is. Pass
   * both `id` and `labelledBy` where there is a visible label: `id` keeps the pointer
   * behaviour, `labelledBy` is what supplies the name.
   */
  labelledBy?: string;
  /** On the trigger. */
  className?: string;
  /** On the panel. */
  panelClassName?: string;
  // Implemented in Task 4:
  searchable?: boolean;
  /** @default "Search" */
  searchPlaceholder?: string;
  /**
   * `aria-label` on the search box — its only accessible name, since the box carries no visible
   * `<label>` of its own. Deliberately not derived from `label`: `label` is usually singular
   * ("Set"), the set picker Task 8 folds in needs exactly `"Search sets"`, and a `"Search " +
   * label` concat would silently reword every other consumer to something nobody chose.
   * @default "Search"
   */
  searchLabel?: string;
  /** Controlled: the caller filters. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** @default "No matches." */
  emptyLine?: string;
  footer?: ReactNode;
  /**
   * The keyboard walked off the end of the drawn list — ArrowDown on the last row, or End
   * pressed a second time already there.
   *
   * A no-op here: `<Dropdown>` never pages. `<MultiDropdown>` (Task 5) is what reveals more of
   * a capped list on it, and it is wired at this level so the keyboard has one implementation
   * rather than two.
   */
  onReachEnd?: () => void;
  /**
   * The panel is opening — called in the **same batch** as the state change that opens it, on
   * every one of the three ways in (a click, ArrowDown on the closed trigger, and a character
   * key on a `searchable` one).
   *
   * For the per-*opening* state a caller keeps outside this component. `SetCombobox`'s is the
   * page depth it resets and the snapshot of picked sets it floats to the top; an effect on the
   * shell's own `open` would take that snapshot one commit after the first render of the list it
   * is meant to order, which is the whole reason this hook exists rather than nothing.
   *
   * **Not a place to change what `options` will be.** The opening row is computed from the list
   * drawn on the render *before* this runs — see `openingList` below — so a caller that
   * synchronously re-cut its own list here would open the panel on a row of a list it is about
   * to discard. Reset a page depth, take a snapshot; do not clear a controlled `query`.
   */
  onOpen?: () => void;
};

/** What the trigger draws when `value` matches nothing in `options`. */
const DEFAULT_PLACEHOLDER = "—";

/** How long a run of closed-trigger keystrokes stays one type-ahead word. */
const TYPE_AHEAD_MS = 600;

/** Module scope so a scroll effect can depend on it without re-running every render. */
const optionId = (id: string, index: number) => `${id}-option-${index}`;

/** The row a fresh opening starts on, disregarding whether it can be pressed: the picked one,
 *  or the first row. {@link openingIndex} is what a caller actually opens on. */
function startIndex(options: readonly DropdownOption[], value: string): number {
  const idx = options.findIndex((o) => o.value === value);
  return idx >= 0 ? idx : 0;
}

/**
 * Where a fresh **opening** lands — never a disabled row, or Enter on the very first press
 * would silently do nothing. Rerouted to the first enabled row when {@link startIndex} landed on
 * one that cannot be pressed, whether because the picked value itself is disabled or because
 * nothing matched and the fallback (row 0) happens to be. `-1` when nothing in the list can be
 * pressed at all — see {@link firstEnabledIndex}.
 */
function openingIndex(options: readonly DropdownOption[], value: string): number {
  const i = startIndex(options, value);
  return options[i]?.disabled ? firstEnabledIndex(options) : i;
}

/**
 * The first **enabled** row whose label begins with the typed characters, case-insensitively —
 * the buffered type-ahead's matcher, used both closed (the trigger) and open (a non-`searchable`
 * listbox). **Not** what a `searchable` box's own query matches by — that is a substring test
 * against `label`, computed inline where `drawn` is built.
 */
function typeAheadIndex(options: readonly DropdownOption[], char: string): number {
  const needle = char.toLowerCase();
  return options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(needle));
}

/** The next/previous **enabled** row from `from` — `from` unchanged when there is none. */
function nextEnabledIndex(options: readonly DropdownOption[], from: number, dir: 1 | -1): number {
  let i = from + dir;
  while (i >= 0 && i < options.length) {
    if (!options[i].disabled) return i;
    i += dir;
  }
  return from;
}

/** `-1`, not `0`, when nothing is enabled — row 0 is not a row Enter may land on. */
function firstEnabledIndex(options: readonly DropdownOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

/** `-1`, not `0`, when nothing is enabled — see {@link firstEnabledIndex}. */
function lastEnabledIndex(options: readonly DropdownOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

/**
 * Where a `<MultiDropdown>` **opening** lands, given the list it is opening on.
 *
 * **Two branches, and only the first is safe from a reroute for free.** When a `selected` value
 * is found in that list, its row is never disabled — a selected option is never greyed by this
 * app's own rule (`optionDisabled` in `src/features/search/facets.ts:50`, delegating to
 * `countDisabled`'s "a selected option is never greyed" clause at `:28`) — so the found branch
 * needs no reroute the way {@link openingIndex} needs one. **The fallback does not inherit that
 * guarantee**: row 0 is an arbitrary row when nothing selected survived into the list — the set
 * picker's normal state once a query has narrowed the list past every ticked row — and it can be
 * disabled. Landing there would silently do nothing on the very first Enter or Space, for
 * exactly the reason {@link openingIndex}'s own doc gives, so the fallback reroutes to the first
 * enabled row the same way `openingIndex` reroutes its own.
 */
function multiOpeningIndex(drawn: readonly DropdownOption[], selected: readonly string[]): number {
  for (const v of selected) {
    const i = drawn.findIndex((o) => o.value === v);
    if (i >= 0) return i;
  }
  return drawn[0]?.disabled ? firstEnabledIndex(drawn) : 0;
}

/**
 * Props private to {@link DropdownShell} — exactly the handful of places `<Dropdown>` and
 * `<MultiDropdown>` differ, so the shell itself needs no other `multi` branch anywhere.
 */
type ShellProps = SharedProps & {
  /** Whether this opening is a multi-select. Drives `aria-multiselectable`, the Space decision
   *  in `onListKeyDown` below, and whether activating a row closes the panel. */
  multi: boolean;
  /** The trigger's own content — `<Dropdown>` computes a picked label or its placeholder,
   *  `<MultiDropdown>` passes `triggerLabel` straight through. The shell draws it verbatim and
   *  never inspects it. */
  triggerContent: ReactNode;
  /** Whether one option's value counts as picked — `aria-selected` and the row's tick. */
  isPicked: (value: string) => boolean;
  /** The row a fresh opening lands on, given the list that will actually be on screen once the
   *  panel finishes opening — `openingList` below, never `drawn` directly (see its own comment
   *  for why that distinction is load-bearing). Both `<Dropdown>`'s `openingIndex` and
   *  `<MultiDropdown>`'s {@link multiOpeningIndex} read the argument honestly. */
  computeOpeningIndex: (openingList: readonly DropdownOption[]) => number;
  /** Enter, or a pointer press, on an enabled row. `<Dropdown>` passes `onChange`;
   *  `<MultiDropdown>` passes `onToggle`. Whether the panel then closes is the shell's own
   *  call, from `multi` alone — see `activate` below. */
  onActivate: (value: string) => void;
};

/**
 * The disclosure button, the listbox it opens and an optional search box (Task 4) — every
 * native `<select>` in the app is being replaced with this, in one of two shapes:
 * `<Dropdown>` below commits a single value and closes; `<MultiDropdown>` toggles a value and
 * stays open. Neither is exported; each is reached only through its own thin wrapper.
 *
 * **Whichever element is focused while the panel is open is what carries
 * `aria-activedescendant`**, because that attribute belongs on the *focused* element. Without
 * `searchable` there is nothing else to take the caret, so it is the `<ul role="listbox">`
 * itself. With `searchable` the `<input role="combobox">` takes it instead, and the listbox
 * carries neither the caret nor the attribute — see the render below. Rows are never focused
 * and never `disabled`: an out-of-reach row is `aria-disabled`, refused by both the pointer and
 * Enter, and skipped by the arrow keys, because a row is walked by `aria-activedescendant`
 * rather than by the tab order.
 */
function DropdownShell(props: ShellProps) {
  const {
    options,
    size = "md",
    align = "start",
    fill = false,
    active = false,
    disabled = false,
    id,
    label,
    labelledBy,
    className,
    panelClassName,
    searchable = false,
    searchPlaceholder,
    searchLabel = "Search",
    query,
    onQueryChange,
    emptyLine = "No matches.",
    footer,
    onReachEnd,
    onOpen,
    multi,
    triggerContent,
    isPicked,
    computeOpeningIndex,
    onActivate,
  } = props;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Uncontrolled search state — read only when the caller has not supplied `query`. See
  // `controlled` below for the reason a controlled caller's typing never lands here.
  const [localQuery, setLocalQuery] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * The closed trigger's type-ahead buffer — several keystrokes typed within
   * {@link TYPE_AHEAD_MS} of each other are one word, not several independent single-character
   * jumps. A ref rather than state: nothing about it is ever drawn, so a re-render would only
   * cost a paint nobody sees.
   */
  const typeAheadRef = useRef<{ buffer: string; timeout: number | null }>({
    buffer: "",
    timeout: null,
  });

  const uid = useId();
  const listboxId = `${uid}-listbox`;

  const { placement, minWidth } = usePopupPlacement({
    triggerRef: buttonRef,
    frameRef,
    panelRef,
    open,
    align,
    onClose: () => setOpen(false),
  });

  // Escape's own close: hands the caret back to the trigger before React flushes the unmount —
  // the listbox holds focus while open, and an element that unmounts with focus on it drops the
  // caret to <body>, restarting the next Tab from the top of the app.
  const dismiss = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  // The innermost open layer: capture phase, so a card pane (or anything else) behind this
  // dropdown does not also close on the same press.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  // Controlled vs uncontrolled search. A caller that supplies `query` has already filtered with
  // its own idea of a match — the set picker's is name-contains, code-prefix and a three-level
  // rank — and a second substring test here would silently re-cut a list that was deliberately
  // ordered. Uncontrolled, the shell does the one thing every plain select needs: a
  // case-insensitive substring match on the label.
  const controlled = query !== undefined;
  const q = query ?? localQuery;
  const drawn =
    searchable && !controlled
      ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
      : options;

  // The list an **opening** index has to be computed against — not always `drawn`, because
  // `openAt` below clears the uncontrolled query in the *same batch* as the index it is handed.
  // An index computed against the current, possibly query-narrowed `drawn` would describe a row
  // in a list that is about to be replaced: open on row 1 of a two-row narrowed list, and the
  // very same commit resets the query, so the next paint shows row 1 of the *full* list — a
  // different row entirely, silently. `openAt` only resets the query `if (!controlled)`, so
  // that is exactly the condition here: uncontrolled opens onto the full `options` (what the
  // reset leaves drawn), controlled opens onto `drawn` (which nothing here is about to change —
  // a controlled caller filters before handing `options` down, so `drawn === options` for it
  // regardless, but this is written as the actual rule rather than as that coincidence, because
  // it is `openAt`'s reset condition that decides it, not an algebraic identity today's code
  // happens to hold).
  const openingList = controlled ? drawn : options;

  // A stored index can outrun a shrunk list — searching narrows `drawn` while the panel stays
  // open — and a stale index would point `aria-activedescendant` at a row that is no longer
  // drawn, and make ArrowDown fire `onReachEnd` forever instead of moving. Read this, never
  // `activeIndex` itself, everywhere below.
  const index = Math.min(activeIndex, Math.max(0, drawn.length - 1));

  useEffect(() => {
    // The search box takes the caret when there is one — see the doc comment above this
    // component — and the listbox takes it otherwise.
    if (open) (searchable ? inputRef : listRef).current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    // jsdom leaves this layout API undefined.
    document.getElementById(optionId(uid, index))?.scrollIntoView?.({ block: "nearest" });
  }, [index, open, uid]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      // Closed without moving focus: the reader clicked elsewhere and is already there.
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Only clears a timer this component itself started, so an unmount mid-buffer never fires
  // into state nobody reads any more. The ref is copied into the closure up front — by the
  // time cleanup runs, `typeAheadRef.current` could already be a later render's object.
  useEffect(() => {
    const ta = typeAheadRef.current;
    return () => {
      if (ta.timeout !== null) window.clearTimeout(ta.timeout);
    };
  }, []);

  // A fresh opening starts with a blank search, so a reader who typed a filter, closed without
  // picking, and reopened is not shown a pre-filtered panel. Reset here rather than on close —
  // in the same batch as the active-index reset, matching `SetCombobox`'s `startOpening()` —
  // because the panel is still fading out on close and clearing the box there would be a visible
  // flicker in something the reader is watching leave. Never for a **controlled** caller: it owns
  // `query` and this must not reach it, so the guard skips `onQueryChange` entirely rather than
  // calling it with `""`.
  //
  // `onOpen` goes off here rather than from an effect on `open`, which is the whole of what it
  // is for: a caller's per-opening state then lands in the same batch as the open itself. Its
  // one other entry point is the `searchable` character-key branch below, which cannot use this
  // function — see the comment there.
  const openAt = (i: number) => {
    setActiveIndex(i);
    if (!controlled) setLocalQuery("");
    setOpen(true);
    onOpen?.();
  };

  // Enter, or a pointer press, on an enabled row. `<Dropdown>`'s `onActivate` is `onChange` and
  // this closes behind it, exactly as `commit` always did; `<MultiDropdown>`'s is `onToggle` and
  // `multi` is what keeps the panel open — see "stays open across several picks".
  const activate = (v: string) => {
    onActivate(v);
    if (!multi) dismiss();
  };

  // A new query is a new list; neither the old cursor position nor how far the reader had
  // paged into the old one means anything in it. One handler for both branches: a controlled
  // caller is told what was typed, an uncontrolled one is trusted to remember it.
  const updateQuery = (next: string) => {
    setActiveIndex(0);
    if (controlled) onQueryChange?.(next);
    else setLocalQuery(next);
  };

  /**
   * Advances the type-ahead buffer by one character and returns the first enabled row it now
   * matches, or `-1`. Several keystrokes typed within {@link TYPE_AHEAD_MS} of each other are
   * one word, not several independent single-character jumps — "st" reaches Standard, not
   * whatever the lone "s" would have.
   *
   * Shared by the closed trigger's `onKeyDown` and the open, non-`searchable` listbox's
   * `onListKeyDown` below — the same buffer has to survive the handoff between them, since the
   * very keystroke that opens the panel is also the one that starts the word. A `searchable`
   * dropdown never calls this: the search box owns filtering there, and a character key lands in
   * it through the browser's own text-input handling rather than through here.
   */
  const typeAhead = (char: string): number => {
    const ta = typeAheadRef.current;
    if (ta.timeout !== null) window.clearTimeout(ta.timeout);
    ta.buffer += char;
    ta.timeout = window.setTimeout(() => {
      ta.buffer = "";
      ta.timeout = null;
    }, TYPE_AHEAD_MS);
    return typeAheadIndex(options, ta.buffer);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    // The panel keeps rendering through its exit fade (`PopupPanel`'s own `useIsPresent`), so
    // the element outlives `open` — without this guard Enter could still commit a row on a
    // dropdown that has already closed.
    if (!open || drawn.length === 0) return;
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = nextEnabledIndex(drawn, index, 1);
        if (next === index) {
          // Nothing moved: the keyboard walked off the end of the list — which, for a caller
          // that pages, is the end of a *page* rather than of the list. Ask for the rest, and
          // step onto the first row that arrives: the arrow key the reader is already holding
          // meant "more of this list", not "reveal some and stay where I am".
          onReachEnd?.();
          // Only from the very last row, and inert whenever nothing is revealed — `index` is
          // then `drawn.length - 1`, so the clamp above walks `index + 1` straight back to it on
          // the next render. From a last *enabled* row with disabled ones after it there is
          // nothing to step onto, which is why this asks about the list's end and not the walk's.
          if (index === drawn.length - 1) setActiveIndex(index + 1);
        } else setActiveIndex(next);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        setActiveIndex(nextEnabledIndex(drawn, index, -1));
        break;
      }
      case "Home": {
        e.preventDefault();
        setActiveIndex(firstEnabledIndex(drawn));
        break;
      }
      case "End": {
        e.preventDefault();
        const last = lastEnabledIndex(drawn);
        // Already there: the same "asking for more" gesture ArrowDown makes.
        if (index === last) onReachEnd?.();
        else setActiveIndex(last);
        break;
      }
      case "Enter": {
        e.preventDefault();
        const opt = drawn[index];
        if (opt && !opt.disabled) activate(opt.value);
        break;
      }
      default: {
        // **Space decision (Task 5), made deliberately and stated here because this is its
        // site: on a non-searchable `<MultiDropdown>`, Space toggles the active row instead of
        // joining type-ahead below.** A native multi-select toggles on Space, and this app's own
        // Enter already does the same job for a multi-select — toggle, not close — so Space
        // reaching a *different* outcome than Enter on the same row would be the surprise, not
        // this.
        // **The honest cost, stated rather than hidden**: the old behaviour was not always a
        // dead key. A lone Space as the *first* character of a fresh buffer does match nothing —
        // `typeAheadIndex` is a `startsWith`, and no label starts with a space — but mid-buffer
        // it is live: typing "limited " continues a real `startsWith("limited ")` match against
        // any multi-word label such as "Limited Edition Alpha". Toggling on Space gives that up
        // for every non-searchable `<MultiDropdown>` — multi-word labels can no longer be
        // type-ahead-narrowed past their first word — in exchange for Space reliably toggling
        // the row a reader is looking at, on every press rather than only the ones that happen
        // to land after a word boundary with no match. That trade was accepted on its merits,
        // not because the alternative was inert.
        // **Never for `searchable`**: the search box already owns every character it receives
        // (the guard just below exempts it the same way), and a query has to be able to hold a
        // literal space — several set names do, and a search box that ate Space as a toggle
        // could never type them. `<Dropdown>` falls through unchanged, because `multi` is false
        // there: Space stays an ordinary type-ahead character exactly like any other, which is
        // what "buffers consecutive keystrokes into one type-ahead word" already relies on.
        if (multi && !searchable && e.key === " ") {
          e.preventDefault();
          const opt = drawn[index];
          if (opt && !opt.disabled) activate(opt.value);
          break;
        }
        // Type-ahead continues while the panel is open, building the same word the closed
        // trigger's keystrokes would have. Never for `searchable`: that box already owns
        // every character it receives, through its own `onChange`.
        if (searchable || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) break;
        e.preventDefault();
        const match = typeAhead(e.key);
        if (match !== -1) setActiveIndex(match);
        break;
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn(fill && "w-full")}
      // Tab out of the panel and the panel should not still be there. `onBlur` is React's
      // `focusout`, so it catches the listbox losing focus to anything at all; a `relatedTarget`
      // still inside the root (the trigger, on Escape) is not leaving.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        onClick={() => {
          if (open) setOpen(false);
          else openAt(computeOpeningIndex(openingList));
        }}
        onKeyDown={(e) => {
          // The panel holds the caret while open, so this only ever runs on the closed
          // trigger — a keydown fired at a focused descendant never bubbles to a sibling.
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAt(computeOpeningIndex(openingList));
            return;
          }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          if (searchable) {
            // Same gesture, same place: a character that would have jumped a row instead
            // opens the panel and seeds the search box the reader is about to land in.
            updateQuery(e.key);
            // Opened by hand rather than through `openAt`, whose uncontrolled query reset would
            // wipe the very character this branch exists to keep — and `updateQuery` has already
            // put the cursor on row 0. It is still an opening, so it is still announced.
            setOpen(true);
            onOpen?.();
            return;
          }
          const match = typeAhead(e.key);
          openAt(match !== -1 ? match : computeOpeningIndex(openingList));
        }}
        className={cn(
          size === "sm"
            ? "h-8 rounded-md border px-2 text-xs"
            : "h-9 rounded-md border px-2.5 text-sm",
          PRESS,
          "disabled:active:scale-100",
          FOCUS,
          active ? "border-accent text-accent" : "border-border text-dim hover:text-text",
          fill ? "flex w-full items-center justify-between" : "inline-flex items-center gap-1.5",
          className,
        )}
      >
        {triggerContent}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          // The key belongs on AnimatePresence's own direct child — this frame div — and not
          // on PopupPanel, a grandchild it happens to work for today only because there is
          // ever at most one of these mounted.
          <div key="panel" ref={frameRef} className={cn("fixed left-0 top-0 size-0", LAYER.popup)}>
            <PopupPanel
              ref={panelRef}
              style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, minWidth }}
              className={cn(
                "absolute rounded-md border border-border bg-surface p-2 shadow-lg",
                // The corner it is pinned by is the corner it grows from — this app's standing rule
                // for an anchored popup. All four spellings written out whole: Tailwind scans source
                // text, so a class built by interpolation emits no rule at all.
                placement?.flipY
                  ? placement.flipX
                    ? "origin-bottom-right"
                    : "origin-bottom-left"
                  : placement?.flipX
                    ? "origin-top-right"
                    : "origin-top-left",
                // Invisible until measured. `placement` is null for exactly one frame — the one
                // that mounts the panel, before its own size exists — and `popup` already has it
                // at opacity 0 there, so this is belt and braces rather than the only guard.
                placement === null && "invisible",
                panelClassName,
              )}
            >
              {searchable && (
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-label={searchLabel}
                  aria-expanded="true"
                  aria-controls={listboxId}
                  aria-activedescendant={
                    drawn.length > 0 && index >= 0 ? optionId(uid, index) : undefined
                  }
                  value={q}
                  onChange={(e) => updateQuery(e.target.value)}
                  onKeyDown={onListKeyDown}
                  placeholder={searchPlaceholder ?? "Search"}
                  className="mb-2 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm placeholder:text-dim focus:border-accent focus:outline-none"
                />
              )}
              <ul
                ref={listRef}
                id={listboxId}
                role="listbox"
                tabIndex={-1}
                aria-label={labelledBy ? undefined : label}
                aria-labelledby={labelledBy}
                // `<Dropdown>` never sets this — a single-select listbox is not multiselectable,
                // and the attribute's absence says so rather than a written-out "false".
                aria-multiselectable={multi ? "true" : undefined}
                // The search box carries this instead when there is one — see the doc comment
                // above this component.
                aria-activedescendant={
                  !searchable && drawn.length > 0 && index >= 0
                    ? optionId(uid, index)
                    : undefined
                }
                onKeyDown={searchable ? undefined : onListKeyDown}
                className="max-h-64 overflow-auto"
              >
                {drawn.length === 0 && (
                  // Not an option, and a bare `<li>` in a listbox is a `listitem` where only
                  // options are allowed. `presentation` makes it the sentence it looks like.
                  <li role="presentation" className="px-2 py-3 text-center text-xs text-dim">
                    {emptyLine}
                  </li>
                )}
                {drawn.map((opt, i) => (
                  <Row
                    key={opt.value}
                    id={optionId(uid, i)}
                    option={opt}
                    picked={isPicked(opt.value)}
                    active={i === index}
                    size={size}
                    onCommit={() => activate(opt.value)}
                  />
                ))}
              </ul>
              {footer}
            </PopupPanel>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The single-select — every native `<select>` in the app, one value in and `onChange` out.
 * Everything else lives in {@link DropdownShell}; this is the thin translation from "one value"
 * to the shell's `isPicked`/`triggerContent`/`computeOpeningIndex`/`onActivate`.
 */
export function Dropdown(
  props: SharedProps & {
    value: string;
    onChange: (value: string) => void;
    /** Trigger text when `value` matches no option. Defaults to an em dash. */
    placeholder?: string;
  },
) {
  const { value, onChange, placeholder, options, ...shared } = props;
  const picked = options.find((o) => o.value === value);
  const content = picked ? picked.label : (placeholder ?? DEFAULT_PLACEHOLDER);
  return (
    <DropdownShell
      {...shared}
      options={options}
      multi={false}
      triggerContent={content}
      isPicked={(v) => v === value}
      // Reads its argument honestly — `openingList` (see the shell's own comment) is always
      // `options` for a single-select regardless of search state, so this is exactly
      // `openingIndex(options, value)`, unchanged from before this file had a shell.
      computeOpeningIndex={(openingList) => openingIndex(openingList, value)}
      onActivate={onChange}
    />
  );
}

/**
 * The multi-select every `<select multiple>` this app never had is being built as —
 * `SetCombobox` (Task 8) is its first real caller, ~1 050 sets deep. `selected` is read
 * fresh on every render rather than snapshotted, so several picks in a row (this control's
 * whole reason to exist) each see the latest list.
 *
 * The Space decision is made and explained at its actual site — the default case inside
 * {@link DropdownShell}'s `onListKeyDown` — because that is the one place it has any effect.
 */
export function MultiDropdown(
  props: SharedProps & {
    selected: readonly string[];
    onToggle: (value: string) => void;
    /** What the trigger says — "Any set", "2 sets". A count, never a value. */
    triggerLabel: string;
  },
) {
  const { selected, onToggle, triggerLabel, options, ...shared } = props;
  return (
    <DropdownShell
      {...shared}
      options={options}
      multi
      triggerContent={triggerLabel}
      isPicked={(v) => selected.includes(v)}
      computeOpeningIndex={(openingList) => multiOpeningIndex(openingList, selected)}
      onActivate={onToggle}
    />
  );
}

function Row({
  id,
  option,
  picked,
  active,
  size,
  onCommit,
}: {
  id: string;
  option: DropdownOption;
  /** Whether this option counts as picked — the one value `<Dropdown>` holds, or one of several
   *  `<MultiDropdown>` does — `aria-selected` and the tick. */
  picked: boolean;
  /** Whether the keyboard's cursor is on this row — the highlight, not a selection. */
  active: boolean;
  size: DropdownSize;
  onCommit: () => void;
}) {
  const tip = useTooltip();
  return (
    <li
      id={id}
      role="option"
      aria-selected={picked}
      aria-disabled={option.disabled || undefined}
      {...tip(option.title)}
      // Keeps the caret — and therefore the arrow keys — in the listbox while a row is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!option.disabled) onCommit();
      }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "transition-colors duration-150 motion-reduce:transition-none",
        option.disabled ? FILTER_UNAVAILABLE : "cursor-pointer",
        active && "bg-bg",
        size === "sm" && "text-xs",
      )}
    >
      {option.icon}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.hint && <span className="shrink-0 font-mono text-xs text-dim">{option.hint}</span>}
      {/* Gold text alone reads as "hovered" in a list the reader is moving through. The slot is
          held open on every row so a pick does not shuffle the column. */}
      <span className="w-3.5 shrink-0">
        {picked && <Check className="size-3.5" aria-hidden="true" />}
      </span>
    </li>
  );
}
