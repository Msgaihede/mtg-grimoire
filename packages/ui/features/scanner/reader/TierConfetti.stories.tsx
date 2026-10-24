import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRICE_TIERS, type PriceTier } from "../sounds/scanSounds";
import { TierConfetti, type TierConfettiProps } from "./TierConfetti";

/** What each press says. */
const LABEL: Record<PriceTier, string> = {
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3",
  jackpot: "Jackpot",
};

/**
 * The confetti in a black box the size of the picture its values were tuned for — 640 × 600 — with
 * a press per tier under it that throws that tier's burst. Each press is a fresh stamp, exactly as
 * a landing is, so a replay runs the component's own path: a press mid-burst starts the new tier in
 * place of the old.
 *
 * **Nothing draws under a reduced-motion setting**, here as in the app — the workbench mounts the
 * same reader's-preference motion config the app does. That is the component, not a broken story.
 */
function Replay({ originBottom }: Pick<TierConfettiProps, "originBottom">) {
  const [landing, setLanding] = useState<{ tier: PriceTier; count: number } | null>(null);
  const burst = landing === null ? null : { stamp: `landing-${landing.count}`, tier: landing.tier };
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="relative h-[600px] w-[640px] max-w-full overflow-hidden rounded-lg bg-black">
        <TierConfetti burst={burst} originBottom={originBottom} />
      </div>
      <div className="flex flex-wrap gap-2">
        {PRICE_TIERS.map((tier) => (
          <button
            key={tier}
            type="button"
            onClick={() => setLanding((was) => ({ tier, count: (was?.count ?? 0) + 1 }))}
            className={cn("h-8 rounded-md border border-border px-3 text-sm", PRESS, FOCUS)}
          >
            {LABEL[tier]}
          </button>
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: "Scanner/Reader/TierConfetti",
  component: TierConfetti,
  tags: ["autodocs"],
  render: (args) => <Replay originBottom={args.originBottom} />,
  args: { burst: null, originBottom: 64 },
} satisfies Meta<typeof TierConfetti>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every tier, a press each: a gold-and-white puff at the first; more pieces, further, with
 * streamers among them at the second; the five mana colours and a flash at the third; and at the
 * jackpot a second wave, rain from the top of the picture and a gold glow round its edge.
 */
export const EveryTier: Story = {};
