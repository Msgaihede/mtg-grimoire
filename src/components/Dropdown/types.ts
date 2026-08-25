import type { ReactNode } from "react";

/**
 * One row of a dropdown.
 *
 * Six fields, and deliberately **no render prop**. All 45 `<option>` bodies this app replaced were
 * plain strings and the set picker's row is exactly `icon + label + hint + tick`, so there is
 * nothing today a `renderRow` would serve — and a render prop is how two dropdowns start looking
 * different again, which is the whole thing this component exists to stop.
 */
export type DropdownOption = {
  /** The value round-tripped to the caller. A string, because a select speaks strings. */
  value: string;
  /**
   * What the reader sees, and what an **uncontrolled** search box matches against.
   *
   * A caller that supplies `query`/`onQueryChange` filters the list itself and this is never
   * matched against — see `DropdownShell`.
   */
  label: string;
  /** Drawn at the head of the row. The set picker's keyrune glyph is the only one today. */
  icon?: ReactNode;
  /** A dim, right-aligned second fact — the set picker's code. */
  hint?: string;
  /**
   * Out of reach: greyed with `FILTER_UNAVAILABLE`, `aria-disabled`, refused by both the pointer
   * and Enter, and skipped by the arrow keys.
   *
   * **`aria-disabled` and not `disabled`.** The house rule is that a control which greys as the
   * reader types must not leave the tab order under their hands; a row is never *in* the tab order
   * (the walk is `aria-activedescendant`, not focus), so the same argument lands on the same
   * attribute for a different reason — there is no `disabled` to set on a `<li>` at all.
   */
  disabled?: boolean;
  /**
   * The row's tooltip, through `useTooltip`. **Never its accessible name** — the row's own content
   * is that, and an `aria-label` here would replace the label, the hint and the tick with a
   * sentence that has neither in it.
   */
  title?: string;
};

/**
 * The two geometries, and there are only two.
 *
 * `md` **is** `FilterChips`' private `FILTER_SHAPE` (`h-9 rounded-md border text-sm`), so a
 * dropdown in a filter row shares a line with the chips beside it. `sm` is the card pane's
 * density. Four geometries existed before this component and nobody had decided on any of them.
 */
export type DropdownSize = "md" | "sm";

/** A rectangle in viewport coordinates. */
export type Box = { left: number; top: number; right: number; bottom: number };

export type Size = { width: number; height: number };

/**
 * Where the panel goes, in **viewport** coordinates.
 *
 * The hook converts these to the frame's coordinates before they reach the DOM; see
 * `usePopupPlacement`. The two flags are not redundant with the numbers — they pick the
 * `origin-*` class, and a panel has to grow from the corner it is pinned by.
 */
export type Placement = { left: number; top: number; flipX: boolean; flipY: boolean };
