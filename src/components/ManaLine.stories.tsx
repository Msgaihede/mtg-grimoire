import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ManaLine } from "./ManaLine";

const meta = {
  title: "Primitives/ManaLine",
  component: ManaLine,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The app's signature, and its only progress bar: a 2px W→U→B→R→G rule under the " +
          "ribbon, present on every screen. During a sync the rule dims and a full-strength " +
          "copy of itself fills across it behind a gold cap — the one place where the " +
          "identity element and a functional one are the same element. Each `label` below is " +
          "a literal value of `PHASE_LABEL`, because a sync cannot produce any other.",
      },
    },
  },
} satisfies Meta<typeof ManaLine>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest it is decoration and nothing else — `aria-hidden`, no `progressbar` role.
 *  Announcing a 0% bar on every screen in the app would be noise. */
export const Idle: Story = { args: { sync: null } };

/** The ingest, the phase that takes ~81 s of a ~93 s sync and the only one a reader watches
 *  long enough to want a fraction from. */
export const Determinate: Story = { args: { sync: { label: "Importing cards", value: 0.62 } } };

/**
 * A phase with no denominator sweeps instead of filling, and **omits `aria-valuenow`** rather
 * than sending zero: `0` is a claim that no progress has been made, while an absent value is
 * ARIA's way of saying the length is unknown.
 *
 * Two things a reader cannot check by looking, so the `play` checks them: the missing
 * attribute, and that the sweep is dropped entirely under `prefers-reduced-motion` (a parked
 * segment would read as a third of the way done). The second is a `motion-reduce:hidden`
 * class here; proving it *paints* nothing is the live pass's job, not jsdom's.
 */
export const Indeterminate: Story = {
  args: { sync: { label: "Downloading card data", value: null } },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("progressbar", { name: "Downloading card data" });
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(bar).toHaveAttribute("aria-valuemin", "0");
    await expect(bar).toHaveAttribute("aria-valuemax", "100");
    await expect(bar.querySelector(".animate-mana-sweep")).toHaveClass("motion-reduce:hidden");
  },
};

/** The gold cap at 98%: the leading edge has to stay legible against five shifting hues right
 *  up to the point where there is almost no line left to shift. */
export const NearlyDone: Story = { args: { sync: { label: "Importing cards", value: 0.98 } } };
