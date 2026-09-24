import type { ReactElement, ReactNode } from "react";

import { useAppStore } from "@/lib/store";

/**
 * Hands a widget's overlay back the app's own scale, from inside the home grid's CSS `zoom`.
 *
 * The dashboard's Ctrl+scroll is a `zoom` on the grid box (`HomePage.tsx`, `home-page.md` §4), and
 * `zoom` is inherited by everything under it — including a `fixed` dialog a widget mounts in its
 * own body, which is drawn against the window and yet still sized by the grid's multiplier.
 * Measured in the shipped window on 2026-09-24 at the dashboard's 150%: the New printings dialog
 * drew **1056px** wide, exactly 1.5 × its 704, while the card modal the same dialog opens stayed at
 * 704 — two panels a press apart at two sizes. `home-page.md` already ruled on what an overlay is
 * here: the tooltip "stays at app scale, which is right — a tooltip is chrome, not dashboard
 * content", and a modal over the whole window is chrome in exactly that sense.
 *
 * **`zoom` compounds by multiplication**, so the reciprocal cancels the grid's to within a float's
 * rounding, and `display: contents` keeps the wrapper out of the widget body's flex column — no box,
 * no gap — while Chromium still resolves the effective zoom through it, because zoom is a *style*
 * property inherited down the element tree rather than a property of the box. That second half is
 * the one worth doubting, and it was checked in the running window: at 150% the wrapper computed
 * `display: contents` with `zoom: 0.666667`, and the dialog under it drew at **704** — its size at
 * 100%. jsdom lays out neither.
 *
 * Only for something drawn against the window. A popover anchored inside a card must go on scaling
 * with the card it hangs off, which is §4's other measured half.
 */
export function AppScale({ children }: { children: ReactNode }): ReactElement {
  const zoom = useAppStore((s) => s.cardZoom.home);
  return (
    <div className="contents" style={{ zoom: 1 / zoom }}>
      {children}
    </div>
  );
}
