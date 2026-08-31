import type { QrMatrix } from "@/lib/ipc";

/**
 * A QR matrix, drawn.
 *
 * Rust answers `{ width, modules }` and nothing about a screen; this decides the module size,
 * the quiet zone and the colours — the same boundary `combos_for_cards` draws one feature over,
 * applied to a picture.
 *
 * **One `<rect>` per dark module and none per light one.** A 21×21 code is 441 cells and the
 * pairing invite's 53×53 is 2 809; drawing both colours would double the node count for a
 * background `fill` already answers. The quiet zone is four modules, which is the QR spec's own
 * minimum and the difference between a code a phone reads instantly and one it hunts for.
 *
 * **`size-72` against the pairing invite's 162-byte URL payload.** That is a version-9 symbol at
 * error-correction level M — 53×53 modules — where the old bare-number payload fit a much smaller
 * symbol. The old `size-56` (224px) drawn over 53 modules is 3.67 px per module; `size-72` (288px)
 * is 4.72, which is the difference between a code a phone's camera locks onto at once and one it
 * has to hunt for.
 *
 * ⚠️ **`bg-white` and `fill="#000"` are literal and stay literal.** This is the one surface in
 * the app that must not follow the theme: a QR code inverted by dark mode is a QR code no camera
 * reads. A later theme pass that "fixes" the hard-coded colours here breaks the feature and
 * nothing goes red — the picture still draws, it just stops being scannable.
 */
export function QrCode({ matrix, label }: { matrix: QrMatrix; label: string }) {
  const quiet = 4;
  const side = matrix.width + quiet * 2;
  return (
    <svg
      data-testid="pairing-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${side} ${side}`}
      className="size-72 shrink-0 rounded bg-white p-1"
      shapeRendering="crispEdges"
    >
      {matrix.modules.map((dark, i) =>
        dark ? (
          <rect
            key={i}
            x={(i % matrix.width) + quiet}
            y={Math.floor(i / matrix.width) + quiet}
            width={1}
            height={1}
            fill="#000"
          />
        ) : null,
      )}
    </svg>
  );
}
