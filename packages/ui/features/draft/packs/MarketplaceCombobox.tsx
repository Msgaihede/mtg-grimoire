import { useId, useRef, useState, type JSX } from "react";
import { AnimatePresence } from "motion/react";
import { Check, X } from "lucide-react";
import { PopupPanel } from "@/components/PopupListbox";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import type { Marketplace, MarketplaceId } from "@/lib/marketplace";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import type { MarketplaceChoice } from "./marketplaces";

/** The currency's code, the row's hint. */
const CURRENCY_CODE = { usd: "USD", eur: "EUR" } as const;

/** Why a row cannot be pressed, in the reader's words. */
function disabledReason(m: Marketplace): string {
  return m.priced
    ? `${m.label}'s prices can't be read here.`
    : `${m.label} has no prices this app can read.`;
}

/**
 * The rows whose name, id or currency holds `query`, in picker order. Case does not matter, and
 * an empty query is every row.
 */
export function matchChoices(
  choices: readonly MarketplaceChoice[],
  query: string,
): MarketplaceChoice[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...choices];
  return choices.filter(({ marketplace: m }) =>
    [m.label, m.id, m.currency].some((word) => word.toLowerCase().includes(q)),
  );
}

export interface MarketplaceComboboxProps {
  /** The text box's id — what the page's `Prices from` label names. */
  id: string;
  /** Every marketplace the picker offers, greyed where it cannot be priced at. */
  choices: readonly MarketplaceChoice[];
  /** The page's marketplaces — the chips. Never empty. */
  picked: readonly Marketplace[];
  /** A press on a row, a chip's ✕ or Backspace — the page decides what it does to the pick. */
  onToggle: (id: MarketplaceId) => void;
  /** On the root — its width. Defaults to `w-72`. */
  className?: string;
}

/**
 * **Open Packs' marketplaces as a combobox** (issue #1463): the picked ones as chips in a box, a
 * search typed beside them, and under it every marketplace the search matches, each pressed to
 * add or put down. `DeckTagsField`'s shape — chips and a box in one bordered field, the list
 * hanging off its bottom edge — with a fixed list instead of free text, so nothing is ever added
 * that is not a marketplace.
 *
 * ## The keyboard
 *
 * | Key | What it does |
 * | --- | --- |
 * | ↓ / ↑ | open the list, then walk the rows that can be pressed; the caret stays in the box |
 * | Enter | toggles the highlighted row — or, with none, the first the search matches |
 * | Backspace, in an empty box | puts the last chip down — one per press, never the last chip |
 * | Escape | closes the list; pressed again, clears the search |
 *
 * **The list stays open after a press**, since several are picked in a row, and the search
 * empties so the next name is typed from the start. Only one chip is never removable: there is
 * always a marketplace to price at.
 */
export function MarketplaceCombobox({
  id,
  choices,
  picked,
  onToggle,
  className = "w-72",
}: MarketplaceComboboxProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  /** The highlighted row in `matches`, or `-1` for none. Read through `active`. */
  const [cursor, setCursor] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-option-${index}`;

  const pickedIds = new Set(picked.map((m) => m.id));
  const matches = matchChoices(choices, query);
  const pressable = matches.flatMap((c, i) => (c.disabled ? [] : [i]));
  const active = open && pressable.includes(cursor) ? cursor : -1;
  const removable = picked.length > 1;

  const toggle = (marketplaceId: MarketplaceId) => {
    onToggle(marketplaceId);
    setQuery("");
    setCursor(-1);
  };

  useDismissOnEscape({
    layer: "inner",
    enabled: open || query !== "",
    onDismiss: () => {
      if (open) setOpen(false);
      else setQuery("");
    },
  });

  /** One step through the rows that can be pressed, wrapping at either end. */
  const step = (by: 1 | -1) => {
    if (pressable.length === 0) return;
    const at = pressable.indexOf(active);
    const from = at === -1 ? (by === 1 ? -1 : pressable.length) : at;
    setCursor(pressable[(from + by + pressable.length) % pressable.length]);
  };

  return (
    <div
      ref={rootRef}
      className={cn("relative max-w-full", className)}
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget)) return;
        setOpen(false);
        setCursor(-1);
      }}
    >
      <div
        // The chips and the box are one field: a press on its padding lands in the box.
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          inputRef.current?.focus();
        }}
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-border",
          "bg-surface px-1.5 py-1 text-sm text-text focus-within:border-accent",
        )}
      >
        <ul aria-label="Marketplaces priced at" className="contents">
          {picked.map((m) => (
            <li
              key={m.id}
              className={cn(
                "flex items-center gap-1 rounded-sm border border-border bg-bg pl-1.5 text-xs leading-5",
                !removable && "pr-1.5",
              )}
            >
              <span>{m.label}</span>
              {removable && (
                <button
                  type="button"
                  aria-label={`Stop pricing at ${m.label}`}
                  onClick={() => {
                    onToggle(m.id);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-sm text-dim",
                    "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search marketplaces…"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setCursor(-1);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              step(e.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (!open) {
                setOpen(true);
                return;
              }
              const row = active >= 0 ? active : query.trim() !== "" ? pressable[0] : undefined;
              if (row !== undefined) toggle(matches[row].marketplace.id);
              return;
            }
            if (e.key === "Backspace" && !e.repeat && query === "" && removable) {
              e.preventDefault();
              onToggle(picked[picked.length - 1].id);
            }
          }}
          className="h-6 min-w-32 flex-1 bg-transparent px-1 text-sm placeholder:text-dim focus:outline-none"
        />
      </div>

      <AnimatePresence>
        {open && (
          <PopupPanel
            key="marketplaces"
            className={cn(
              "absolute inset-x-0 top-full mt-1 origin-top-left rounded-md border border-border",
              "bg-surface p-1 shadow-lg",
              LAYER.popup,
            )}
          >
            <ul
              id={listId}
              role="listbox"
              aria-label="Marketplaces"
              aria-multiselectable="true"
              className="max-h-64 overflow-auto"
            >
              {matches.map(({ marketplace: m, disabled }, index) => {
                const on = pickedIds.has(m.id);
                return (
                  <li
                    key={m.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={on}
                    aria-disabled={disabled || undefined}
                    title={disabled ? disabledReason(m) : undefined}
                    // Keeps the caret in the box, so the press is a pick and not a blur.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!disabled) toggle(m.id);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      "transition-colors duration-150 motion-reduce:transition-none",
                      disabled
                        ? "cursor-not-allowed text-dim opacity-60"
                        : "cursor-pointer text-text hover:bg-bg",
                      index === active && "bg-bg",
                    )}
                  >
                    <Check
                      className={cn("size-4 shrink-0 text-accent", !on && "invisible")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    <span className="shrink-0 font-mono text-xs text-dim">
                      {CURRENCY_CODE[m.currency]}
                    </span>
                  </li>
                );
              })}
              {matches.length === 0 && (
                <li role="presentation" className="px-2 py-1.5 text-sm text-dim">
                  No marketplace matches “{query.trim()}”.
                </li>
              )}
            </ul>
          </PopupPanel>
        )}
      </AnimatePresence>
    </div>
  );
}
