import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { FILTER_UNAVAILABLE } from "@/components/FilterChips";
import { ipc, type SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { facetTitle, optionDisabled } from "./facets";

/**
 * Options rendered at once.
 *
 * There are ~1 050 sets and the list is filtered as the reader types, so anything past
 * the first screenful is scrolled past rather than read. Capping keeps the popup out of
 * the virtualiser's territory — a 1 050-row `<ul>` inside a dropdown is a jank source for
 * a control that is open for two seconds. The footer says when the cap is in force, so a
 * short list is never mistaken for the whole answer.
 */
const MAX_OPTIONS = 50;

/**
 * How many sets one search may name.
 *
 * Mirrors `MAX_SET_FILTER` in `src-tauri/src/filters.rs`, whose `picked_sets` truncates
 * past it — so
 * without a ceiling here the button would say "65 sets" while the backend filtered on 64,
 * and the results would quietly disagree with the control that produced them. The backend
 * keeps its truncation as the belt; this is the braces, and it is the only one the reader
 * can see.
 */
const MAX_SETS = 64;

/** Module scope so the scroll effect can depend on it without re-running every render. */
const optionId = (id: string, index: number) => `${id}-option-${index}`;

/** Exact code, then code prefix, then a name match. Lower sorts first. */
const rank = (code: string, needle: string): number =>
  code === needle ? 0 : code.startsWith(needle) ? 1 : 2;

/**
 * A searchable, multi-select set picker.
 *
 * Hand-rolled rather than pulled from a component library, and deliberately *not* a
 * portalled popover: the shipped CSP is `style-src 'self'`, and every Radix overlay
 * primitive pulls in `react-remove-scroll`, which injects a runtime `<style>` element the
 * moment it opens. That passes `tauri dev` and breaks in a packaged build. This is a
 * plain absolutely-positioned listbox in the same stacking context as the button, so
 * nothing is injected and nothing is locked. The ARIA wiring below is the whole of what
 * the dependency would have provided.
 */
export function SetCombobox({
  selected,
  onToggle,
  counts,
}: {
  selected: readonly string[];
  onToggle: (code: string) => void;
  /**
   * How many printings this search holds per set code, or `undefined` when that is not
   * known — in which case nothing is greyed, because not-greyed means "we don't know".
   *
   * **Greys, never hides.** The `cardCount > 0` filter below drops sets the corpus holds
   * nothing for at all, which is a fact about the database; this is a fact about the search
   * the reader is halfway through typing, and dropping those rows would make the list jump
   * under the cursor on every keystroke.
   */
  counts?: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Which option the keyboard is on. Focus stays in the box; this moves instead. */
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;
  const labelId = `${id}-label`;

  // One call per session: the set list changes at most once a sync, and the picker has to
  // open instantly.
  const sets = useQuery({
    queryKey: ["sets"],
    queryFn: () => ipc.listSets(),
    // Cached for good once it has answered with rows — but an empty answer is not an
    // answer. The first launch opens this picker while the opening sync is still writing
    // `sets`, and a `staleTime` of `Infinity` over that `[]` would leave the filter empty
    // for the rest of the session with no way to ask again.
    staleTime: (q) => (q.state.data?.length ? Infinity : 0),
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape is a keyboard word, and the element it dismissed is about to unmount with the
  // focus still on it — which drops the caret onto `<body>`, so the next Tab restarts from
  // the top of the app rather than continuing along the filter row. Called before React
  // flushes the close, while the input is still mounted. The outside-click below
  // deliberately does not do this: the reader is already somewhere else.
  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // The innermost open layer: capture phase, and the press is consumed so the card detail
  // pane underneath does not close on the same one. See `useDismissOnEscape`.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = (sets.data ?? [])
      // A set with no printings here can never match a search, so offering it is
      // offering an empty result. `sets` holds memorabilia and token-only sets that
      // `default_cards` carries nothing for, and Arena/MTGO sets whose every printing
      // the search's paper-only default hides again.
      .filter((s) => s.cardCount > 0)
      // Name matches anywhere, code from the start: three letters inside a longer code
      // are a coincidence, three letters inside a set's name are usually what was meant.
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.code.startsWith(needle));
    if (!needle) return found;
    // Typing a whole set code is an unambiguous request for that set, and without this it
    // is the one result you cannot reach: "lea" is Limited Edition Alpha, but it also
    // appears in six League Tokens sets, nine Arena Leagues, Oversized League Prizes and
    // M15 Pre**relea**se Challenge — seventeen name matches that the cap can push the
    // exact one out of entirely. Sorted rather than filtered, because the rest are still
    // real matches and the reader may have meant one of them.
    //
    // `sort` is stable, so within each rank the backend's own order survives.
    return found.sort((a, b) => rank(a.code, needle) - rank(b.code, needle));
  }, [sets.data, query]);

  const options = matches.slice(0, MAX_OPTIONS);
  // Clamped rather than reset from an effect: the list shortens under the cursor whenever
  // the query narrows or the set list finishes loading, and a stored index that outruns it
  // would point `aria-activedescendant` at an element that is not there any more.
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  useEffect(() => {
    if (!open) return;
    // `scrollIntoView` is one of the layout APIs jsdom leaves undefined.
    document.getElementById(optionId(id, activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, id]);

  const label =
    selected.length === 0 ? "Any set" : `${selected.length} set${selected.length === 1 ? "" : "s"}`;

  /** At the ceiling, adding is off and removing is still on — the way out has to stay open. */
  const full = selected.length >= MAX_SETS;
  /**
   * Why a row cannot be pressed — the cap, or nothing in this search to press it for.
   *
   * One predicate for both, because both the mouse and the Enter key have to hit the same
   * wall: a list that refuses the click and takes the keystroke is a list with two rules.
   * A picked row is live under either, which is the way out of both dead ends.
   */
  const canToggle = (code: string) =>
    (!full || selected.includes(code)) && !optionDisabled(counts, code, selected.includes(code));

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const code = options[activeIndex].code;
      if (canToggle(code)) onToggle(code);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      // Tab out of the panel and the panel should not still be there: 288px of listbox
      // hanging over the results, with the caret three controls further along. `onBlur`
      // is React's `focusout`, so it catches the input losing focus to anything at all;
      // a `relatedTarget` inside the root — the trigger, on Escape — is not leaving.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {/* The button's *content* is the value ("2 sets"); its name has to come from
          somewhere else, or assistive tech announces the value twice and the field never. */}
      <span id={labelId} className="sr-only">
        Set
      </span>
      {/* A disclosure button, not the combobox: the combobox is the text field it reveals,
          which is where the caret goes and what `aria-activedescendant` is read from. */}
      <button
        ref={buttonRef}
        type="button"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((v) => !v);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
            setActive(0);
          }
        }}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm",
          "transition-colors duration-150 motion-reduce:transition-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          selected.length > 0
            ? "border-accent text-accent"
            : "border-border text-dim hover:text-text",
        )}
      >
        {label}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute mt-1 w-72 rounded-md border border-border bg-surface p-2 shadow-lg",
            // Over the results table's sticky header, which is a layer down. They used to
            // share one, and a shared layer is resolved by document order — where the
            // header, coming after this filter row, painted a grey band across the picker.
            LAYER.popup,
            // **Pinned to the trigger's right edge, not its left.** This control sits at the
            // end of a wrapping filter row, so with the default `left: auto` — the static
            // position, i.e. the trigger's left edge — 288px of listbox opened 174px past
            // the window at 1280 (measured). Nothing clips it, so the *page* scrolled
            // sideways to reveal it: the whole app slid left, sidebar and all, the moment
            // the picker's own `scrollIntoView` ran. `AddToCollection`'s `align="end"` is
            // the same decision for the same reason.
            "right-0",
          )}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search sets"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={options.length > 0 ? optionId(id, activeIndex) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query is a new list, and the old cursor position means nothing in it.
              setActive(0);
            }}
            onKeyDown={onListKeyDown}
            placeholder="Name or code"
            className="mb-2 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm placeholder:text-dim focus:border-accent focus:outline-none"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            className="max-h-64 overflow-auto"
          >
            {options.length === 0 && (
              // Not an option, and a bare `<li>` in a listbox is a `listitem` where only
              // options are allowed. `presentation` makes it the sentence it looks like.
              <li role="presentation" className="px-2 py-3 text-center text-xs text-dim">
                {sets.isPending
                  ? "Loading sets…"
                  : sets.isError
                    ? "Could not read the set list — try Refresh data."
                    : "No sets match that."}
              </li>
            )}
            {options.map((s, i) => (
              <Option
                key={s.code}
                id={optionId(id, i)}
                set={s}
                picked={selected.includes(s.code)}
                active={i === activeIndex}
                disabled={!canToggle(s.code)}
                title={facetTitle(s.name, counts?.[s.code])}
                onToggle={onToggle}
              />
            ))}
          </ul>
          {full && (
            <p className="pt-2 text-center text-[0.7rem] text-dim">
              {MAX_SETS} sets is the most one search can name — remove one to add another.
            </p>
          )}
          {matches.length > options.length && (
            <p className="pt-2 text-center text-[0.7rem] text-dim">
              Showing {options.length} of {matches.length} — keep typing to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  id,
  set,
  picked,
  active,
  disabled,
  title,
  onToggle,
}: {
  id: string;
  set: SetSummary;
  picked: boolean;
  active: boolean;
  disabled: boolean;
  /**
   * The tooltip, and only the tooltip. Unlike the chips, this row's accessible name comes
   * from its own content — the set's name, its code and its tick — and an `aria-label`
   * carrying the count would replace all three with a sentence that has no code in it.
   */
  title?: string;
  onToggle: (code: string) => void;
}) {
  const glyph = setGlyphClass(set.code);
  return (
    <li
      id={id}
      role="option"
      aria-selected={picked}
      aria-disabled={disabled || undefined}
      title={title}
      // Keeps the caret — and therefore the arrow keys — in the search box while the
      // reader picks several sets with the mouse.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => !disabled && onToggle(set.code)}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "transition-colors duration-150 motion-reduce:transition-none",
        // The filter row's one treatment for unavailable, shared with the chips rather than
        // spelled twice: the cap and a facet zero look the same because they mean the same.
        disabled ? FILTER_UNAVAILABLE : "cursor-pointer",
        picked ? "text-accent" : "text-text",
        active && "bg-bg",
      )}
    >
      {/* keyrune covers 441 of ~1 050 sets, and its own `.ss` rule draws a generic set
          symbol for the rest — so every row has a glyph, and the code rides along as text
          for the ones where that glyph is not the set's own. */}
      <i className={cn(glyph, "w-4 shrink-0 text-center")} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{set.name}</span>
      <span className="shrink-0 font-mono text-xs text-dim">{set.code.toUpperCase()}</span>
      {/* Gold text alone reads as "hovered" in a list the reader is moving through. The
          slot is held open on every row so picking one does not shuffle the column. */}
      <span className="w-3.5 shrink-0">
        {picked && <Check className="size-3.5" aria-hidden="true" />}
      </span>
    </li>
  );
}
