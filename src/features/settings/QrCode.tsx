import type { QrMatrix } from "@/lib/ipc";

/**
 * A QR matrix, drawn.
 *
 * Rust answers `{ width, modules }` and nothing about a screen; this decides the module size,
 * the quiet zone and the colours — the same boundary `combos_for_cards` draws one feature over,
 * applied to a picture.
 *
 * **One `<rect>` per dark module and none per light one.** A 21×21 code is 441 cells and the
 * 105-character invite's is 1 681; drawing both colours would double the node count for a
 * background `fill` already answers. The quiet zone is four modules, which is the QR spec's own
 * minimum and the difference between a code a phone reads instantly and one it hunts for.
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
      className="size-56 shrink-0 rounded bg-white p-1"
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
