import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { ipc, type SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";

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

/** Module scope so the scroll effect can depend on it without re-running every render. */
const optionId = (id: string, index: number) => `${id}-option-${index}`;

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
}: {
  selected: readonly string[];
  onToggle: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Which option the keyboard is on. Focus stays in the box; this moves instead. */
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      (sets.data ?? [])
        // A set with no printings here can never match a search, so offering it is
        // offering an empty result. `sets` holds memorabilia and token-only sets that
        // `default_cards` carries nothing for, and Arena/MTGO sets whose every printing
        // the search's paper-only default hides again.
        .filter((s) => s.cardCount > 0)
        // Name matches anywhere, code from the start: three letters inside a longer code
        // are a coincidence, three letters inside a set's name are usually what was meant.
        .filter(
          (s) => !needle || s.name.toLowerCase().includes(needle) || s.code.startsWith(needle),
        )
    );
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
      onToggle(options[activeIndex].code);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {/* The button's *content* is the value ("2 sets"); its name has to come from
          somewhere else, or assistive tech announces the value twice and the field never. */}
      <span id={labelId} className="sr-only">
        Set
      </span>
      <button
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
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
            : "border-border text-muted hover:text-text",
        )}
      >
        {label}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-md border border-border bg-surface p-2 shadow-lg">
          <input
            ref={inputRef}
            type="text"
            aria-label="Search sets"
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
            className="mb-2 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            className="max-h-64 overflow-auto"
          >
            {options.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted">
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
                onToggle={onToggle}
              />
            ))}
          </ul>
          {matches.length > options.length && (
            <p className="pt-2 text-center text-[0.7rem] text-muted">
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
  onToggle,
}: {
  id: string;
  set: SetSummary;
  picked: boolean;
  active: boolean;
  onToggle: (code: string) => void;
}) {
  const glyph = setGlyphClass(set.code);
  return (
    <li
      id={id}
      role="option"
      aria-selected={picked}
      // Keeps the caret — and therefore the arrow keys — in the search box while the
      // reader picks several sets with the mouse.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(set.code)}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "transition-colors duration-150 motion-reduce:transition-none",
        picked ? "text-accent" : "text-text",
        active && "bg-bg",
      )}
    >
      {/* keyrune covers 441 of ~1 050 sets, and its own `.ss` rule draws a generic set
          symbol for the rest — so every row has a glyph, and the code rides along as text
          for the ones where that glyph is not the set's own. */}
      <i className={cn(glyph, "w-4 shrink-0 text-center")} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{set.name}</span>
      <span className="shrink-0 font-mono text-xs text-muted">{set.code.toUpperCase()}</span>
      {/* Gold text alone reads as "hovered" in a list the reader is moving through. The
          slot is held open on every row so picking one does not shuffle the column. */}
      <span className="w-3.5 shrink-0">
        {picked && <Check className="size-3.5" aria-hidden="true" />}
      </span>
    </li>
  );
}
