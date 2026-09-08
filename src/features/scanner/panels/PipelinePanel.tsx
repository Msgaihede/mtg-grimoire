import type { ScannerStages } from "../types";
import { Panel } from "./Panel";

/** The three crops, in the order the detector produces them. */
const STAGES = [
  { key: "binary", alt: "mask", caption: "02 mask" },
  { key: "contours", alt: "contours", caption: "03 contours" },
  { key: "quad", alt: "quad", caption: "04 quad" },
] as const;

/**
 * What the detector saw between the frame and the quad.
 *
 * **A bare `<img>`, which the app's card-art rule does not cover.** That rule is about a card
 * *face* — a picture belonging to a slot rather than to a card, fetched over `mtgimg:` and
 * therefore needing `CardImage`'s key and its stall retry. These three are data URLs the
 * detector minted from this very frame: there is no URL to key on, no request to stall, and
 * nothing to retry. The same goes for the rectification and the two OCR bands next door.
 *
 * Drawn only where `options.stages` asked for them — the parent gates it, because the images
 * roughly double the response time and a panel that folded them away would still be paying.
 */
export function PipelinePanel({ stages }: { stages: ScannerStages | null }) {
  return (
    <Panel id="pipeline" title="Pipeline">
      {STAGES.map(({ key, alt, caption }) => {
        const src = stages?.[key] ?? null;
        return (
          <figure key={key} className="space-y-1">
            {src === null ? (
              <div className="grid h-24 place-items-center rounded bg-bg text-xs text-dim">
                not in this frame
              </div>
            ) : (
              <img src={src} alt={alt} className="w-full rounded bg-bg" />
            )}
            <figcaption className="text-xs text-dim">{caption}</figcaption>
          </figure>
        );
      })}
    </Panel>
  );
}
