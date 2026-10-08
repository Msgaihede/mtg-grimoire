import { MANA_LINE_GRADIENT, type ManaLineSync } from "@/lib/mana";

/**
 * The app's signature, and its only progress bar.
 *
 * A 2px W→U→B→R→G rule under the ribbon, present on every screen. During a sync the rule
 * dims and a full-strength copy of itself fills across it behind a gold cap — the one
 * place where the identity element and a functional one are the same element. It is never
 * repeated anywhere else in the app, which is what makes it a signature rather than a
 * motif.
 */
export function ManaLine({ sync }: { sync: ManaLineSync | null }) {
  if (!sync) {
    return (
      <div
        aria-hidden="true"
        className="h-0.5 w-full shrink-0"
        style={{ background: MANA_LINE_GRADIENT }}
      />
    );
  }

  const percent = sync.value === null ? null : Math.round(sync.value * 100);
  return (
    <div
      role="progressbar"
      aria-label={sync.label}
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted rather than zeroed when the length is unknown — see the test.
      {...(percent === null ? {} : { "aria-valuenow": percent })}
      className="relative h-0.5 w-full shrink-0 overflow-hidden"
    >
      {/* The line itself, held back so the fill reads as progress across it. */}
      <div className="absolute inset-0 opacity-30" style={{ background: MANA_LINE_GRADIENT }} />
      {percent === null ? (
        // No denominator: a short segment sweeps instead of a bar filling. Dropped
        // entirely under prefers-reduced-motion, where a parked segment would read as a
        // third of the way done — the dimmed line alone says "busy, length unknown".
        <div
          className="absolute inset-y-0 left-0 w-1/3 animate-mana-sweep motion-reduce:hidden"
          style={{ background: MANA_LINE_GRADIENT }}
        />
      ) : (
        <>
          {/* A full-width copy of the line, *revealed* left→right rather than a narrower
              box being widened: a gradient painted across `width: 40%` would squeeze all
              five colours into the left 40% and disagree with the dim line behind it at
              every pixel. Clipping keeps the two in register, so the sync reads as the
              line coming up to full strength. */}
          <div
            className="absolute inset-0 transition-[clip-path] duration-150 ease-out motion-reduce:transition-none"
            style={{
              background: MANA_LINE_GRADIENT,
              clipPath: `inset(0 ${100 - percent}% 0 0)`,
            }}
          />
          {/* The gold cap: the accent colour marking the leading edge, so the boundary
              between done and not-done is legible against five shifting hues. Clamped at
              the left edge rather than allowed to sit at -2px, so the first paint of a
              determinate sync shows the leading edge instead of nothing at all. */}
          <span
            className="absolute inset-y-0 w-0.5 bg-accent transition-[left] duration-150 ease-out motion-reduce:transition-none"
            style={{ left: `max(0px, calc(${percent}% - 2px))` }}
          />
        </>
      )}
    </div>
  );
}
