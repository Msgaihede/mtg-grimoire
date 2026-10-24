/**
 * Which sound a card makes as it lands in the tray, or as the reader settles it — the pure half
 * of the scanner's sounds, decidable without a speaker in the room.
 *
 * **Rust stores the ladder, TypeScript decides the sound.** `scansounds::ScanSounds` is the
 * reader's four floors and the switch; which of the six sounds a row is owed is this module's,
 * from the row's own facts — whether it still asks the reader something, and what one copy of it
 * costs at the tray's marketplace (`trayPrice.ts`).
 */
import type { ScanSounds, ScannerTrayRow } from "@/lib/ipc";
import type { LandedCard } from "../reader/AddedToast";
import { needsDecision } from "../reader/tray";
import { isKnownFinish } from "../reader/trayFinish";

/** The six sounds, as the player names them. */
export type ScanSound = "ok" | "needs-input" | "tier1" | "tier2" | "tier3" | "jackpot";

/** What a fresh install plays at — `ScanSounds::default()` in `scansounds.rs`. */
export const DEFAULT_SCAN_SOUNDS: ScanSounds = {
  enabled: true,
  tier1: 1,
  tier2: 10,
  tier3: 100,
  jackpot: 1000,
};

/** The four tiers, cheapest first — the order the ladder climbs and the panel draws. */
export const PRICE_TIERS = ["tier1", "tier2", "tier3", "jackpot"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

/**
 * The sound a settled card's price is owed: **the highest floor it reaches**, each floor "at
 * least this much"; below the first, or unpriced, the plain scan sound. An unpriced card is no
 * cheaper than a dollar — it is a card nobody quotes — and the honest sound for it is the one that
 * says only that it landed.
 */
export function soundForPrice(price: number | null, sounds: ScanSounds): ScanSound {
  if (price === null) return "ok";
  for (let i = PRICE_TIERS.length - 1; i >= 0; i--) {
    const tier = PRICE_TIERS[i];
    if (price >= sounds[tier]) return tier;
  }
  return "ok";
}

/**
 * Whether a landing asks the reader something — **a printing to pick, or a finish to name**, the
 * tray's two questions (`needsDecision`). Such a card is owed `needs-input` whatever it costs: a
 * price for a card the reader has not said they hold would be a jingle for a guess.
 */
export function landingNeedsInput(card: LandedCard): boolean {
  return card.kind === "pick" || !isKnownFinish(card.finish);
}

/**
 * The rows of `next` **the reader just settled**: a row that asked something in `before` and
 * asks nothing now — a printing picked, a finish named, a printing found through *More
 * printings…*.
 *
 * **The same key and the same `addedAt`**, the stamp only a landing writes (`headLanded`): a
 * second opinion that settled a row is a landing, and it is the landing's sound that plays for it,
 * not a second one. A row that is new to `next` settled nothing either — it landed.
 */
export function settledRows(
  before: readonly ScannerTrayRow[],
  next: readonly ScannerTrayRow[],
): ScannerTrayRow[] {
  const asked = new Map<string, ScannerTrayRow>();
  for (const row of before) if (needsDecision(row)) asked.set(row.key, row);
  if (asked.size === 0) return [];
  return next.filter((row) => {
    const was = asked.get(row.key);
    return was !== undefined && was.addedAt === row.addedAt && !needsDecision(row);
  });
}

/**
 * Why a ladder cannot be stored, in `scansounds::TIERS_MUST_CLIMB`'s words, or `null` when it can
 * — the panel's check before a write, so a reader is told while the figure is still under their
 * hand. Each floor a positive figure above the one before it.
 */
export function ladderRefusal(sounds: ScanSounds): string | null {
  const floors = PRICE_TIERS.map((tier) => sounds[tier]);
  const climbs =
    floors.every((f) => Number.isFinite(f) && f > 0) &&
    floors.every((f, i) => i === 0 || floors[i - 1] < f);
  return climbs ? null : TIERS_MUST_CLIMB;
}

/** `scansounds::TIERS_MUST_CLIMB`, verbatim. */
export const TIERS_MUST_CLIMB =
  "Each price must be a positive amount, and each tier higher than the one before it.";
