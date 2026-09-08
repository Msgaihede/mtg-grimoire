import type { ScannerVerdict } from "../types";
import { FIGURES, Panel, Row } from "./Panel";

/**
 * The card as the detector straightened it, beside the geometry that produced it.
 *
 * The slot is a fixed 122×170 whether or not there is a picture in it — a panel whose height
 * changes with every frame that loses the card would make the whole column jump at ~6 fps.
 * A bare `<img>` for `PipelinePanel`'s reason: a data URL from this frame, keyed on nothing
 * and fetched from nowhere.
 */
export function RectifiedPanel({ verdict }: { verdict: ScannerVerdict | null }) {
  const score = verdict?.score ?? null;

  return (
    <Panel id="rectified" title="Rectified">
      <div className="flex gap-3">
        <div className="grid h-[170px] w-[122px] shrink-0 place-items-center overflow-hidden rounded bg-bg">
          {verdict?.rectified == null ? (
            <span className="px-2 text-center text-xs text-dim">no rectification</span>
          ) : (
            <img
              src={verdict.rectified}
              alt="the rectified card"
              className="h-full w-full object-contain"
            />
          )}
        </div>

        <dl className={`${FIGURES} min-w-0 flex-1 self-start`}>
          <Row label="aspect" value={score === null ? "—" : score.aspect.toFixed(3)} />
          <Row
            label="frame area"
            value={score === null ? "—" : `${(score.area_frac * 100).toFixed(1)}%`}
          />
          <Row
            label="corner err"
            value={score === null ? "—" : `${score.max_angle_error.toFixed(1)}°`}
          />
          <Row label="detector" value={verdict?.method ?? "—"} />
          <Row label="geometry" value={score?.via ?? "—"} />
          <Row label="dhash" value={verdict?.hash?.slice(0, 12) ?? "—"} />
        </dl>
      </div>
    </Panel>
  );
}
