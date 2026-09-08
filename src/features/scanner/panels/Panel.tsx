import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { PRESS } from "@/lib/motion";
import { useAppStore, type ScannerPanelId } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * One section of the Scanner's column: the Settings panel chrome — heading, then a bordered
 * `bg-surface` body — with a fold on every panel but `match`.
 *
 * **The heading is the disclosure button**, `aria-expanded` on it and — *while it is open* —
 * `aria-controls` to the body, so a screen reader hears "Controls, collapsed, button" rather
 * than a heading and an unrelated toggle.
 *
 * **The `aria-controls` comes and goes with the body, and that is the whole of why it is
 * conditional.** This panel unmounts its body rather than hiding it, so a folded heading
 * pointing at `scanner-controls-body` names an element that is not in the document — a dangling
 * IDREF, which is an ARIA conformance error and is the kind a screen reader resolves to
 * *nothing* rather than to an error. The attribute is dropped while folded instead. Everything
 * a reader needs in that state is already on the button: `aria-expanded="false"` says there is
 * something to open, and the fold is the next element in the tree once it exists.
 *
 * The region keeps its `aria-labelledby` either way — that target is the heading, which is
 * always mounted — so `getByRole("region", { name })` finds a folded panel too.
 *
 * **`SettingsSection`'s classes, copied rather than imported.** That component is the Settings
 * page's chrome and has no fold; a `foldable` prop on it would put this screen's one requirement
 * into the file three settings panels share, and the resemblance here is deliberate rather than
 * shared. What is copied is three class strings — if they drift, one screen looks slightly
 * different from another, which is the kind of mistake a screenshot catches.
 */
export function Panel({
  id,
  title,
  children,
}: {
  /** `match` is the one panel with no fold: it is what the screen is for. */
  id: ScannerPanelId | "match";
  /** The heading — and, through the pairing, the region's accessible name. */
  title: string;
  children: ReactNode;
}) {
  const open = useAppStore((s) => (id === "match" ? true : s.scannerFolds[id]));
  const setFold = useAppStore((s) => s.setScannerFold);
  const headingId = `scanner-${id}-heading`;
  const bodyId = `scanner-${id}-body`;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="font-heading text-lg leading-none">
        {id === "match" ? (
          title
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => setFold(id, !open)}
            className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            {title}
          </button>
        )}
      </h2>

      {open && (
        <div id={bodyId} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          {children}
        </div>
      )}
    </section>
  );
}

/** A `dl` row's key/value pair — every panel below draws its figures as one of these. */
export function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <>
      <dt className="text-dim">{label}</dt>
      <dd className={cn("text-right tabular-nums", tone)}>{value}</dd>
    </>
  );
}

/** The grid a panel's figures are laid out on: a label column and a right-aligned value column. */
export const FIGURES = "grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm";

/**
 * A panel's button.
 *
 * The press half is {@link PRESS}, which is the app's one recipe and is not respelled here; the
 * box is this feature's own. Deliberately *not* `features/settings/controls.ts`' `BUTTON`,
 * byte-identical though the box happens to be — that module exists for the vocabulary the
 * Settings *panels* share, and a scanner reaching across a feature boundary for a class string
 * would make every later change to the Settings page a change to this screen as well.
 */
export const BUTTON = cn(
  "inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
  PRESS,
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
);
