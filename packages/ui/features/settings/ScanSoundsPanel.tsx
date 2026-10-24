import { useState, type JSX } from "react";
import { Play } from "lucide-react";
import type { ScanSounds } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { parsePurchasePrice, priceText } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { playScanSound } from "@/features/scanner/sounds/player";
import {
  ladderRefusal,
  PRICE_TIERS,
  type PriceTier,
  type ScanSound,
} from "@/features/scanner/sounds/scanSounds";
import { useScanSoundSettings } from "@/features/scanner/sounds/useScanSoundSettings";
import { PANEL_BUTTON, SWITCH, switchTone, TOUCH_FIELD, TOUCH_FLOOR } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** The panel's id stem — `SettingsSection`'s heading is `scan-sounds-heading`. */
const ID = "scan-sounds";

/** The two sounds no price decides, in the order a scan meets them. */
const PLAIN: readonly { sound: ScanSound; title: string; detail: string }[] = [
  {
    sound: "ok",
    title: "Scanned",
    detail: "A card below your first tier, or one with no price.",
  },
  {
    sound: "needs-input",
    title: "Needs a choice",
    detail: "A card waiting for you to pick its printing or finish.",
  },
];

/** What each tier is called on the panel. */
const TIER_TITLE: Record<PriceTier, string> = {
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3",
  jackpot: "Jackpot",
};

/**
 * The scanner's sounds: whether a scan beeps, and the prices its louder jingles start at.
 *
 * **Each row can be heard from here** — a Play beside every sound — so a reader setting a ladder
 * knows which jingle a figure buys before a card is under the camera. Play works with the switch
 * off too: it is a preview, not a scan.
 *
 * **The figures are in the reader's marketplace currency**, the prices the scanner itself quotes
 * (`useScanSounds`), and the panel says which. A box is a draft until it loses focus or Enter is
 * pressed; then the whole ladder is checked (`ladderRefusal`, the crate's own words) and stored,
 * or the sentence is shown and nothing is written. A box left unreadable shows the same sentence.
 *
 * It reaches the backend itself, `StartViewPanel`'s rule: `useScanSoundSettings` is the one
 * `["scanSounds"]` entry the Scanner reads, so a hook here is a second reader of it.
 */
export function ScanSoundsPanel(): JSX.Element {
  const { sounds, setSounds } = useScanSoundSettings();
  const { marketplace } = useMarketplace();
  const [refusal, setRefusal] = useState<string | null>(null);

  /** One tier's box, committed: the ladder with it, checked whole, stored if it climbs. */
  const commit = (tier: PriceTier, text: string) => {
    const value = parsePurchasePrice(text);
    const next: ScanSounds = { ...sounds, [tier]: value ?? Number.NaN };
    const refused = ladderRefusal(next);
    setRefusal(refused);
    if (refused === null && value !== sounds[tier]) setSounds(next);
  };

  return (
    <SettingsSection id="scan-sounds" title="Scan sounds">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p id={`${ID}-switch`} className="text-sm">
            Play a sound when a card is scanned
          </p>
          <p className="mt-0.5 text-xs leading-snug text-dim">
            Pricier cards get a bigger jingle, at the prices you see on {marketplace.label} (
            {marketplace.currency.toUpperCase()}).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={sounds.enabled}
          aria-labelledby={`${ID}-switch ${ID}-switch-state`}
          onClick={() => setSounds({ ...sounds, enabled: !sounds.enabled })}
          className={cn(SWITCH, switchTone(sounds.enabled))}
        >
          <span id={`${ID}-switch-state`}>{sounds.enabled ? "On" : "Off"}</span>
        </button>
      </div>

      <ul className="space-y-3">
        {PLAIN.map((row) => (
          <SoundRow key={row.sound} sound={row.sound} title={row.title}>
            <p className="text-xs leading-snug text-dim">{row.detail}</p>
          </SoundRow>
        ))}
        {PRICE_TIERS.map((tier) => (
          <SoundRow key={tier} sound={tier} title={TIER_TITLE[tier]}>
            <label className="flex items-center gap-2 text-xs text-dim">
              From
              <input
                // Re-seeded whenever the stored figure moves — another window's change, or a
                // refusal putting it back — and otherwise the reader's draft.
                key={sounds[tier]}
                type="text"
                inputMode="decimal"
                defaultValue={priceText(sounds[tier])}
                aria-label={`${TIER_TITLE[tier]} starts at`}
                onBlur={(e) => commit(tier, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(tier, e.currentTarget.value);
                }}
                className={cn(
                  "w-24 rounded-md border border-border bg-bg px-2 py-1 text-right font-mono text-sm text-text",
                  TOUCH_FIELD,
                  TOUCH_FLOOR,
                  FOCUS,
                )}
              />
            </label>
          </SoundRow>
        ))}
      </ul>

      <PanelAlert tone="problem">{refusal}</PanelAlert>
    </SettingsSection>
  );
}

/** One sound: its name, what decides it, and a press that plays it. */
function SoundRow({
  sound,
  title,
  children,
}: {
  sound: ScanSound;
  title: string;
  children: JSX.Element;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => playScanSound(sound)}
        aria-label={`Play the ${title} sound`}
        className={cn(
          PANEL_BUTTON,
          "size-8 justify-center border-border p-0 hover:bg-bg coarse:min-w-[var(--target-min)]",
        )}
      >
        <Play className="size-4" aria-hidden="true" />
      </button>
      <h3 className="w-28 shrink-0 text-sm text-text">{title}</h3>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
