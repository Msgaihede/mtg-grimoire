/**
 * The last setup, kept on this device so the next game starts where the last one was set up.
 *
 * **`localStorage`, per device and never synced**: a setup is how this phone or this browser is
 * used at this table, not a fact about the reader's collection, and it is worth nothing on another
 * device. Every access is wrapped — a private window, blocked site data or a full quota throws —
 * and a refusal costs only the memory: the setup opens on Commander's defaults.
 *
 * **Validated on the way in, field by field.** What comes back was written by an earlier build or
 * by hand, so a word this build does not know is not trusted to be a setup: a field that does not
 * hold is taken from {@link DEFAULT_SETUP}, and the rest of what was kept survives.
 */
import {
  DEFAULT_SETUP,
  LIFE_FORMATS,
  TURN_TIMERS,
  type LifeFormat,
  type LifeSetup,
} from "../types";

/** The key, versioned: a setup of another shape is a new key, and the old one reads as nothing. */
export const SETUP_KEY = "grimoire.life.setup.v1";

/** Starting life's bounds — `LifeSetup.life`'s, the Custom field's seven digits. */
export const MOST_LIFE = 9_999_999;

const isFormat = (value: unknown): value is LifeFormat =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(LIFE_FORMATS, value);

const isWhole = (value: unknown, least: number, most: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= least && value <= most;

/** A kept value as a setup, or `null` for one that is not an object at all. */
export function parseSetup(value: unknown): LifeSetup | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const d = DEFAULT_SETUP;
  return {
    format: isFormat(v.format) ? v.format : d.format,
    players: isWhole(v.players, 1, 6) ? v.players : d.players,
    life: isWhole(v.life, 1, MOST_LIFE) ? v.life : d.life,
    layout: v.layout === "A" || v.layout === "B" ? v.layout : d.layout,
    seating:
      v.seating === "table" || v.seating === "screen" || v.seating === null ? v.seating : d.seating,
    timerSeconds: (TURN_TIMERS as readonly unknown[]).includes(v.timerSeconds)
      ? (v.timerSeconds as number)
      : d.timerSeconds,
    commander: typeof v.commander === "boolean" ? v.commander : d.commander,
    autoLife: typeof v.autoLife === "boolean" ? v.autoLife : d.autoLife,
  };
}

/** The setup this device last kept, or {@link DEFAULT_SETUP}. */
export function readSetup(): LifeSetup {
  try {
    const raw = window.localStorage.getItem(SETUP_KEY);
    if (raw === null) return DEFAULT_SETUP;
    return parseSetup(JSON.parse(raw)) ?? DEFAULT_SETUP;
  } catch {
    return DEFAULT_SETUP;
  }
}

/** Keep `setup` for the next time. A refused write is forgotten, not reported. */
export function writeSetup(setup: LifeSetup): void {
  try {
    window.localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch {
    // Storage refused (a private window, a full quota): the setup lasts as long as the page.
  }
}
