import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FILTER_FOCUS, FILTER_UNAVAILABLE } from "@/components/FilterChips";
import { ipc, type SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { facetTitle, optionDisabled } from "./facets";

/**
 * Options rendered before the reader asks for more.
 *
 * There are ~1 050 sets and the list is filtered as the reader types, so anything past
 * the first screenful is scrolled past rather than read. Capping keeps the popup out of
 * the virtualiser's territory — a 1 050-row `<ul>` inside a dropdown is a jank source for
 * a control that is open for two seconds. The footer says when the cap is in force, so a
 * short list is never mistaken for the whole answer.
 *
 * **A first page and not a ceiling**: {@link MORE_STEP} reveals the next one, so the whole
 * list is reachable by both the mouse and the arrow keys. Typing is still the fast way
 * through 1 047 sets and the footer goes on saying so.
 */
const MAX_OPTIONS = 100;

/**
 * How many more rows one press of the footer's control reveals.
 *
 * Half a page rather than a whole one: a press is cheap and the reader is scanning, so the
 * cost of asking again is a smaller cost than a repaint that lands them somewhere they did
 * not recognise. The control is worded with the number it will *actually* add, which on the
 * last press is whatever is left rather than this.
 */
const MORE_STEP = 50;

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
 * The listbox's own box, so that the fade-out has somewhere to be inert from.
 *
 * A component and not a `motion.div` written inline, and the reason is the whole of why this
 * exists: `AnimatePresence` keeps the **element it was last handed** while that element leaves,
 * so an exiting panel goes on rendering the props of the render in which it was still open —
 * including its `className`. A flag read upstairs can therefore never reach it. `useIsPresent`
 * is read *inside* the presence, which is the only place the answer changes, and children
 * spread through untouched so nothing had to be threaded down to get it.
 *
 * What it buys is a state this control has never been in before. Its three dismissals are
 * Escape, a `window` mousedown listener and an `onBlur`, and **all three come down with the
 * flag** — so for the length of the fade the panel is painted, hit-testable, and watched by
 * nothing at all. A press on it would land on a listbox that can no longer close itself.
 */
function Listbox({ className, children }: { className?: string; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      {...popup}
      // Not in the accessibility tree on the way out either: a second, stale copy of a set list
      // is worse than none, and the caret left with the flag.
      aria-hidden={present ? undefined : true}
      className={cn(className, !present && "pointer-events-none")}
    >
      {children}
    </motion.div>
  );
}

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
  /**
   * How many rows are drawn. Reset to {@link MAX_OPTIONS} on a new query and on each open —
   * beside the `setActive(0)` that resets the cursor for the same reason, rather than from an
   * effect that would have to work out which change it was reacting to. A new query is a new
   * list, and how deep the reader had paged into the old one means nothing in it.
   */
  const [shown, setShown] = useState(MAX_OPTIONS);
  /**
   * Which sets float to the top — **a snapshot taken when the popup opens, not `selected`.**
   *
   * The reason is the press itself. Ordering on the live `selected` would move a row to the
   * top of the list *because the reader just clicked it*, so the second set they wanted is no
   * longer under the cursor and the third click lands on whatever slid up — in a control whose
   * whole purpose is picking several sets in a row, and whose own rows already go to the
   * trouble of an `onMouseDown` preventDefault so the mouse cannot disturb the keyboard.
   *
   * Frozen for the length of one opening, it buys the thing the pinning was for — the sets
   * already ticked are visible and un-tickable rather than stranded past the end of the page —
   * without the list ever moving under a press. The other two levels cannot move a row on a
   * pick either: `facets::compute` skips the dimension it counts, so ticking a set does not
   * change a single set's count, and a rank is a fact about the typed needle.
   *
   * It also covers the case pinning exists for in reverse: un-ticking a set that this search
   * has nothing in would otherwise sink it out of the page mid-gesture, leaving no way back.
   */
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(selected));
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

  /**
   * Everything that belongs to one *opening* rather than to the mount: the cursor, how far the
   * reader has paged, and which sets are floated to the top.
   *
   * Deliberately not an effect on `open`. The two callers are the only two ways in, and doing
   * it there keeps the state changes in the same batch as `setOpen` — an effect would take a
   * snapshot one commit after the first render of the list it is meant to order. Note what is
   * *not* here: the query, which survives an opening on purpose so reopening the picker shows
   * the reader the list they left. (`setShown` is reset by the query's own `onChange` for the
   * separate reason that a new query is a new list; `pinned` is not, because the sets already
   * ticked are the same sets whatever has been typed.)
   */
  const startOpening = useCallback(() => {
    setActive(0);
    setShown(MAX_OPTIONS);
    setPinned(new Set(selected));
  }, [selected]);

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
    // Three grouping levels, then the alphabet — `sortOptions` settles them in order and
    // `list_sets`'s own newest-first order survives none of it. That order is still the
    // right thing for the backend to answer; what the picker draws is a display decision.
    //
    // **1 — picked first.** The list is paged, and a set the reader has already ticked must
    // never sit past the end of the page, where they can neither see it nor un-tick it.
    // It beats the facet level deliberately: a picked row is drawn at the top even if it
    // somehow greyed. (It cannot today — `optionDisabled`'s first rule is that a selected
    // option is never greyed — but the order is written so the two could not fight.)
    // Read off `pinned` and **not `selected`**, which is what keeps the list still under a
    // press; see that state's own doc for the gesture it protects.
    //
    // **2 — then what this search has printings for**, greyed rows sinking rather than
    // disappearing, for the same reason they are greyed and not filtered. The predicate is
    // `optionDisabled` and **not `canToggle`**: the two differ by the `MAX_SETS` cap, and
    // at the cap every unpicked row becomes untoggleable at once — so folding the cap in
    // here would re-sort the whole list the instant the 64th set is ticked. The cap is a
    // transient global state; the facet is a fact about this search, and only the fact gets
    // to decide an order.
    //
    // **3 — then the code rank**, which is why `rank` exists at all: typing a whole set code
    // is an unambiguous request for that set, and without this it is the one result you
    // cannot reach. "lea" is Limited Edition Alpha, but it also appears in six League Tokens
    // sets, nine Arena Leagues, Oversized League Prizes and M15 Pre**relea**se Challenge —
    // seventeen name matches, enough to push the exact one past the page end entirely.
    // Ranked rather than filtered, because the rest are still real matches and the reader
    // may have meant one of them. With nothing typed every row scores 0, so the level costs
    // nothing; it sits *below* the two above because a picked or available set the reader
    // can act on beats a spelling coincidence.
    //
    // **4 — then the set's name**, which `sortOptions` does. This is where the old stable
    // sort's "within each rank the backend's own order survives" stopped being true: the
    // alphabet decides now, so `lea` is followed by Arena League 1999 and not by whichever
    // League set shipped most recently.
    return sortOptions(
      found,
      (s) => s.name,
      (s) => [
        pinned.has(s.code) ? 0 : 1,
        optionDisabled(counts, s.code, selected.includes(s.code)) ? 1 : 0,
        needle ? rank(s.code, needle) : 0,
      ],
    );
  }, [sets.data, query, selected, counts, pinned]);

  const options = matches.slice(0, shown);
  /**
   * What the footer's control would add — the *honest* number, so the last press reads
   * "Show 7 more" rather than promising fifty rows that are not there.
   */
  const moreCount = Math.min(MORE_STEP, matches.length - options.length);
  // Counted from what is on screen rather than from `shown`, which can outrun the list when
  // the query narrows under a reader who has already paged down.
  const revealMore = () => setShown(options.length + MORE_STEP);
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
      // The bottom of a *page* is not the bottom of the list, so pressing past the last row
      // reveals the next page and lands on its first entry. The old clamp survives only for
      // the case where there genuinely is no more.
      //
      // Not because the footer's button is out of reach — it is inside the root, and the
      // `onBlur` below only closes when focus leaves the root, so Tab does get there. It is
      // that Tab is *also* how a reader leaves this control entirely, and the arrow key they
      // are already holding is the one that meant "more of this list".
      if (activeIndex >= options.length - 1) {
        if (moreCount > 0) {
          revealMore();
          setActive(options.length);
        }
      } else {
        setActive(activeIndex + 1);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      // End means "the end of what I can see"; pressing it again from there asks for the
      // rest, the same bargain `ArrowDown` strikes at the bottom row. It does not leap to
      // match 1 047 of 1 047 — one press, one page, and the reader can watch it arrive.
      if (activeIndex === options.length - 1 && moreCount > 0) {
        revealMore();
        setActive(options.length + moreCount - 1);
      } else {
        setActive(options.length - 1);
      }
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
          startOpening();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
            startOpening();
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

      <AnimatePresence>
        {open && (
          <Listbox
            key="sets"
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
              // And the corner it is pinned by is the corner it grows from, which is the one
              // thing `popup` leaves to whoever anchors it: a listbox that grew from its own
              // middle would read as unrelated to the button that opened it. Written out whole
              // — Tailwind scans source text, so an interpolated class emits no rule.
              "origin-top-right",
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
                // A new query is a new list, and neither the old cursor position nor how far
                // the reader had paged into the old one means anything in it.
                setActive(0);
                setShown(MAX_OPTIONS);
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
            {moreCount > 0 && (
              <div className="pt-2 text-center text-[0.7rem] text-dim">
                {/* The advice stays first and unchanged: at 1 047 sets, paging to the end is
                    reachable but it is not the intended path, and the button below is the
                    escape for the search that cannot be narrowed rather than the fast way. */}
                <p>
                  Showing {options.length} of {matches.length} — keep typing to narrow it down.
                </p>
                <button
                  type="button"
                  // Same reason as the rows above: a press here must not pull the caret out
                  // of the search box, or the arrow keys stop working the moment the reader
                  // reaches for more with the mouse. The root's `onBlur` only closes when
                  // focus leaves the root, and this button is inside it — so Tabbing onto it
                  // is safe either way, and this is about the mouse.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={revealMore}
                  className={cn(
                    FILTER_FOCUS,
                    // A quiet footer control, not a primary action: it wears the footer's own
                    // size and colour and is told apart from the sentence by the underline.
                    "mt-1 rounded-md px-1.5 py-0.5 underline underline-offset-2",
                    "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  )}
                >
                  Show {moreCount} more
                </button>
              </div>
            )}
          </Listbox>
        )}
      </AnimatePresence>
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
