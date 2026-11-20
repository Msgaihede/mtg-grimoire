import type { JSX } from "react";
import { Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { playScanSound } from "@/features/scanner/sounds/player";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { useAppVolume } from "@/lib/volume";
import { PANEL_BUTTON, TOUCH_FLOOR } from "./controls";
import { SettingsSection } from "./panelChrome";

/** The panel's id stem — `SettingsSection`'s heading is `volume-heading`. */
const ID = "volume";

/**
 * How loud the app is: one slider over every sound the page makes (issue #1703).
 *
 * **The level is `@/lib/volume`'s**, kept on this device and adopted by every window of it; the
 * scanner's player and the playtest board each multiply their sound by it, so the slider moves a
 * sound that is already ringing. Nothing here reaches the backend: a level is a fact about the
 * machine, not the collection, and is never synced.
 *
 * **A Play beside it**, `Scan sounds`' arrangement, so a reader hears the level they set before a
 * card is under the camera: the scanner's own *Scanned* beep, which plays with the scanner's switch
 * off too — it is a preview, not a scan.
 *
 * Steps of 5, the playtest board's slider's, and the figure beside it in the same words; the icon
 * is the board's speaker too, crossed out at 0.
 */
export function VolumePanel(): JSX.Element {
  const volume = useAppVolume((s) => s.volume);
  const setVolume = useAppVolume((s) => s.setVolume);
  const Icon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <SettingsSection id="volume" title="Volume">
      <div>
        <p id={`${ID}-label`} className="text-sm">
          App volume
        </p>
        <p className="mt-0.5 text-xs leading-snug text-dim">
          Every sound the app makes plays at this level on this device.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Icon
          className={cn("size-5 shrink-0", volume === 0 ? "text-dim" : "text-text")}
          aria-hidden="true"
        />
        <input
          type="range"
          aria-labelledby={`${ID}-label`}
          aria-valuetext={`${volume}%`}
          min={0}
          max={100}
          step={5}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className={cn("block min-w-0 flex-1 accent-accent", TOUCH_FLOOR, FOCUS)}
        />
        <span
          aria-hidden="true"
          className={cn(
            "w-10 shrink-0 text-right font-mono text-sm tabular-nums",
            volume === 0 ? "text-dim" : "text-text",
          )}
        >
          {volume}%
        </span>
        <button
          type="button"
          onClick={() => playScanSound("ok")}
          aria-label="Play a test sound"
          className={cn(
            PANEL_BUTTON,
            "size-8 justify-center border-border p-0 hover:bg-bg coarse:min-w-[var(--target-min)]",
          )}
        >
          <Play className="size-4" aria-hidden="true" />
        </button>
      </div>
    </SettingsSection>
  );
}
