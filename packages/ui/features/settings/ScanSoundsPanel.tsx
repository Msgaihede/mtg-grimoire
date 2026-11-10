import { useState, type JSX } from "react";
import { Play } from "lucide-react";
import type { ScanSounds } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { parsePurchasePrice, priceText } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { useSeededDrafts } from "@/lib/useSeededDrafts";
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

/** Each tier's figure as its box draws it. */
function ladderText(sounds: ScanSounds): Record<PriceTier, string> {
  return {
    tier1: priceText(sounds.tier1),
    tier2: priceText(sounds.tier2),
    tier3: priceText(sounds.tier3),
    jackpot: priceText(sounds.jackpot),
  };
}

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
 * pressed; then the whole ladder **as the boxes draw it** is checked (`ladderRefusal`, the crate's
 * own words) and stored together, or the sentence is shown and nothing is written. A box left
 * unreadable shows the same sentence. So a ladder raised in list order — Tier 1 to 20, refused
 * while Tier 2 is 10, then Tier 2 to 50 — stores 20 and 50 at once, and a refused draft is never
 * left on screen with no sentence beside it (issue #1589).
 *
 * It reaches the backend itself, `StartViewPanel`'s rule: `useScanSoundSettings` is the one
 * `["scanSounds"]` entry the Scanner reads, so a hook here is a second reader of it.
 */
export function ScanSoundsPanel(): JSX.Element {
  const { sounds, setSounds } = useScanSoundSettings();
  const { marketplace } = useMarketplace();
  const [refused, setRefused] = useState<string | null>(null);
  const { drafts, setDraft, setDrafts, edited } = useSeededDrafts(ladderText(sounds));

  /** A box committed: every box's draft, checked as one ladder, stored together if it climbs. */
  const commit = () => {
    const next: ScanSounds = { ...sounds };
    for (const tier of PRICE_TIERS) next[tier] = parsePurchasePrice(drafts[tier]) ?? Number.NaN;
    const refusal = ladderRefusal(next);
    setRefused(refusal);
    if (refusal !== null) return;
    setDrafts(ladderText(next));
    if (PRICE_TIERS.some((tier) => next[tier] !== sounds[tier])) setSounds(next);
  };
  // Said only while a box still holds a draft: a re-seed from another window takes it away.
  const refusal = PRICE_TIERS.some(edited) ? refused : null;

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
                // One node for the box's whole life (issue #1589): a stored figure re-seeds the
                // draft, so Enter keeps the caret here.
                type="text"
                inputMode="decimal"
                value={drafts[tier]}
                aria-label={`${TIER_TITLE[tier]} starts at`}
                onChange={(e) => setDraft(tier, e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
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
