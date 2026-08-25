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
  // Implemented in Task 8:
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
 * The first **enabled** row whose label begins with the typed character, case-insensitively —
 * the closed trigger's type-ahead. Shared with the search box's own matcher (Task 4).
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
 * The single-select shell every native `<select>` in the app is being replaced with — a
 * disclosure button, the listbox it opens, an optional search box (Task 4), without
 * multi-select (Task 5) built on top of it.
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
export function Dropdown(
  props: SharedProps & {
    value: string;
    onChange: (value: string) => void;
    /** Trigger text when `value` matches no option. Defaults to an em dash. */
    placeholder?: string;
  },
) {
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
    query,
    onQueryChange,
    emptyLine = "No matches.",
    footer,
    onReachEnd,
    value,
    onChange,
    placeholder,
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

  const openAt = (i: number) => {
    setActiveIndex(i);
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    dismiss();
  };

  // A new query is a new list; neither the old cursor position nor how far the reader had
  // paged into the old one means anything in it. One handler for both branches: a controlled
  // caller is told what was typed, an uncontrolled one is trusted to remember it.
  const updateQuery = (next: string) => {
    setActiveIndex(0);
    if (controlled) onQueryChange?.(next);
    else setLocalQuery(next);
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
        // Nothing moved: the keyboard walked off the end of the list.
        if (next === index) onReachEnd?.();
        else setActiveIndex(next);
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
        if (opt && !opt.disabled) commit(opt.value);
        break;
      }
      default:
        break;
    }
  };

  const picked = options.find((o) => o.value === value);
  const content = picked ? picked.label : (placeholder ?? DEFAULT_PLACEHOLDER);

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
          else openAt(openingIndex(options, value));
        }}
        onKeyDown={(e) => {
          // The panel holds the caret while open, so this only ever runs on the closed
          // trigger — a keydown fired at a focused descendant never bubbles to a sibling.
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAt(openingIndex(options, value));
            return;
          }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          if (searchable) {
            // Same gesture, same place: a character that would have jumped a row instead
            // opens the panel and seeds the search box the reader is about to land in.
            updateQuery(e.key);
            setOpen(true);
            return;
          }
          // Several keystrokes typed within TYPE_AHEAD_MS of each other are one word, not
          // several independent single-character jumps — "st" reaches Standard, not whatever
          // the lone "s" would have.
          const ta = typeAheadRef.current;
          if (ta.timeout !== null) window.clearTimeout(ta.timeout);
          ta.buffer += e.key;
          ta.timeout = window.setTimeout(() => {
            ta.buffer = "";
            ta.timeout = null;
          }, TYPE_AHEAD_MS);
          const match = typeAheadIndex(options, ta.buffer);
          openAt(match !== -1 ? match : openingIndex(options, value));
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
        {content}
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
                    picked={opt.value === value}
                    active={i === index}
                    size={size}
                    onCommit={() => commit(opt.value)}
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
  /** Whether this is the value the dropdown currently holds — `aria-selected`. */
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
