import { useId } from "react";
import {
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  filterChipState,
} from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { TagNamespace } from "@/lib/ipc";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { TAG_NAMESPACE_HINT, TAG_NAMESPACE_LABEL } from "./namespaces";

/**
 * The Tags page's type-ahead, and the one control that decides which taxonomy it searches.
 *
 * Built out of `FilterChips`' three recipes rather than out of its own classes, so that this row
 * really is the same row as the search and collection filter bars: one 36px line, one focus
 * outline, one on/off treatment. A control that invents its own height sits 2px off the line and
 * one that invents its own focus style is the only thing on the screen a keyboard reader loses.
 *
 * **Fully controlled and holds nothing.** The debounce, the query and the settled needle are
 * `useTagSearch`'s; the namespace is part of `TagSelection`, because a chip picked while the box
 * was on Art has to keep saying so after the box moves.
 */

/** What the reader is choosing between, as a ladder rather than an alphabet. */
interface NamespaceChoice {
  value: TagNamespace | "both";
  label: string;
  hint: string;
}

/**
 * Widest first, then art, then oracle.
 *
 * **Deliberately not through `sortOptions`, and this is the "its order *is* the information"
 * exemption** rather than an oversight. `Both` is the setting the page opens on and the only one
 * that can never hide a tag, so it leads; `Art` comes next because the page's job is building a
 * deck around a motif and the illustrations are the primary reading; `Oracle` is the secondary
 * one. Alphabetised, the row would read Art, Both, Oracle and bury the safe default in the middle.
 *
 * The two taxonomy labels come from {@link TAG_NAMESPACE_LABEL} rather than being spelled here,
 * so the word on this radio and the word on a rail row's mark cannot drift apart.
 */
const CHOICES: readonly NamespaceChoice[] = [
  { value: "both", label: "Both", hint: "Art and oracle tags together" },
  { value: "art", label: TAG_NAMESPACE_LABEL.art, hint: TAG_NAMESPACE_HINT.art },
  { value: "oracle", label: TAG_NAMESPACE_LABEL.oracle, hint: TAG_NAMESPACE_HINT.oracle },
];

export interface TagSearchBoxProps {
  value: string;
  onChange: (text: string) => void;
  /** The **box's** taxonomy, not a filter — a chip carries its own and is unaffected by this. */
  namespace: TagNamespace | "both";
  onNamespaceChange: (namespace: TagNamespace | "both") => void;
}

export function TagSearchBox({ value, onChange, namespace, onNamespaceChange }: TagSearchBoxProps) {
  // `useId` rather than a literal: the deck editor draws its filter row beside the search's, and
  // two elements sharing an `id` make one `<label htmlFor>` point at whichever came first.
  const fieldId = useId();
  const tip = useTooltip();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor={fieldId} className="sr-only">
        Search tags
      </label>
      <input
        id={fieldId}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Escape empties the box while there is something in it to empty, and falls through when
        // there is not — the same one press a filter box owns anywhere else in the app. The Tags
        // page has nothing behind it for the fall-through to reach today; the handler is here so
        // that "a filter box owns one Escape while it has text" is true of every filter box
        // rather than of the ones that happened to need it. Chromium clears an
        // `<input type="search">` natively but leaves `defaultPrevented` false, and jsdom does
        // not clear it at all, so this handler is what makes the press both deterministic and
        // testable. The rule is {@link clearFieldOnEscape}'s.
        onKeyDown={(e) => clearFieldOnEscape(e, value, () => onChange(""))}
        // Three examples rather than a category, because "Search tags" leaves a reader arriving
        // from the search page typing a card name — and because one art motif, a second, and one
        // rules effect teaches what the two taxonomies are in the width of a placeholder.
        placeholder="Search tags — dragon, forest, removal…"
        // `FILTER_FIELD` and not `FILTER_CONTROL`: the row's chips dip 3% under the press and a
        // box the reader types into must not, or the native ✕ slides out from under the pointer
        // clearing it. Issue #179 — the reason is on the constant.
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "min-w-56 flex-1 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />

      {/* Named for the question rather than for the answers: `role="radiogroup"` takes no name
          from its contents, so without this a screen reader hears three loose words.

          **Each radio is its own tab stop rather than a roving caret**, which is
          `ExportDialog`'s shape for the app's other radio group. Deliberate: two radio groups in
          one app that answered the arrow keys differently would be worse than one that answers
          them nowhere, and three chips are a shorter walk than the arrow model saves. */}
      <div role="radiogroup" aria-label="Which tags to search" className="flex gap-1">
        {CHOICES.map((choice) => {
          const on = namespace === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onNamespaceChange(choice.value)}
              // The hint is a **description** and never the name: the visible word is the whole
              // of what this radio is called, and folding the sentence into `aria-label` would
              // have a screen reader announce the explanation on every pass through the row.
              {...tip(choice.hint)}
              className={cn(FILTER_CONTROL, FILTER_FOCUS, "px-3", filterChipState(on))}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
