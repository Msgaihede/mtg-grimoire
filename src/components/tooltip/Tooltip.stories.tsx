import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TooltipProvider, TOOLTIP_OPEN_MS } from "./TooltipProvider";
import { useTooltip, type TooltipOptions } from "./useTooltip";

/**
 * One control with a tooltip bound to it — the whole of what a call site does.
 *
 * The provider is mounted here as well as globally in `preview.tsx`, so that this file reads as
 * the documentation of how to use it rather than relying on a decorator the reader cannot see.
 */
function Stage({ words, options, label }: { words: string; options?: TooltipOptions; label: string }) {
  return (
    <TooltipProvider>
      <div className="grid min-h-[220px] place-items-center bg-bg p-8">
        <Control words={words} options={options} label={label} />
      </div>
    </TooltipProvider>
  );
}

function Control({ words, options, label }: { words: string; options?: TooltipOptions; label: string }) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text"
      {...tip(words, options)}
    >
      {label}
    </button>
  );
}

const meta = {
  title: "Primitives/Tooltip",
  component: Stage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "260px" } },
    description: {
      component:
        "The app's one tooltip. A single `fixed` panel mounted at the app root — outside every " +
        "transform and every clipped scroller, which is what lets it be shown from a virtualised " +
        "table row or from inside a modal without a raised z-index or any scroll arithmetic.\n\n" +
        "A call site binds it by spreading `useTooltip()`'s result onto the element it already " +
        "has: `<span {...tip(words)}>`. There is no wrapper element, so it cannot change a " +
        "layout.",
    },
  },
} satisfies Meta<typeof Stage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary one: a sentence describing a control that is already named. It opens after the
 * pointer has rested, and while it is open the control carries `aria-describedby`.
 */
export const Default: Story = {
  args: { label: "Size rule", words: "The cards a format's size rule counts.", options: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Size rule" });
    await userEvent.hover(button);
    const panel = await canvas.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    await expect(panel).toHaveTextContent("size rule counts");
    await expect(button).toHaveAttribute("aria-describedby", panel.id);
    await userEvent.unhover(button);
    await waitFor(async () => await expect(canvas.queryByRole("tooltip")).toBeNull());
  },
};

/**
 * A hint the reader is meant to act on, so the pointer can enter it and the text can be selected.
 * The panel takes its own pointer events; the default one does not.
 */
export const Interactive: Story = {
  args: {
    label: "Needs review",
    words: "Check the printing and re-add it, or remove this entry.",
    options: { interactive: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole("button", { name: "Needs review" }));
    const panel = await canvas.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    await expect(panel).toHaveClass("select-text");
    await expect(panel).not.toHaveClass("pointer-events-none");
  },
};

/**
 * The keyboard's half. A Tab onto the control opens it with no delay — there is no "resting" for
 * a caret, and a reader who has just arrived should not be made to wait.
 */
export const OnFocus: Story = {
  args: { label: "Newest first", words: "Sorted by release date, newest first.", options: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Newest first" })).toHaveFocus();
    await expect(await canvas.findByRole("tooltip")).toHaveTextContent("release date");
  },
};

/**
 * The largest group of call sites: a clipped cell whose tooltip is its own full text. It says
 * nothing when the text is *not* cut off — which is most rows most of the time, and is why this
 * costs a virtualised table nothing.
 */
export const OnlyWhenClipped: Story = {
  args: {
    label: "A set name long enough to be cut off",
    words: "A set name long enough to be cut off",
    options: { whenClipped: true },
  },
};
