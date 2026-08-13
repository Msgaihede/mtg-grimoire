import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, formatZoom, stepZoom } from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { CardZoomIndicator, ZOOM_QUIET_MS, ZoomBadge } from "./CardZoomIndicator";

/** The two buttons below, which are scaffolding rather than app chrome — the app's own gesture
 *  is ctrl+wheel and has no control. Plain border-grey, so nothing here reads as a design. */
const STEP_BUTTON =
  "rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * The store-driven component, with two buttons standing in for the wheel.
 *
 * The badge listens for no gesture: it reads `cardZoom` and `zoomPulse`, and the ctrl+wheel
 * handler that writes them is another module's. So these presses call **`zoomCards`** — the
 * store's own single writer of the pair — rather than assembling a `setState` of their own,
 * which means a press here climbs the same ladder by the same arithmetic a notch does, clamp
 * and all.
 *
 * The starting size is written **during render** rather than in an effect (the lever
 * `CardDetailPane.stories.tsx` uses, for its reason): an effect runs after the first paint, so a
 * story that cleared the previous story's pulse there would flash a badge on its way to showing
 * none. Writing it before the indicator below has mounted is also what makes this story start in
 * the state the app starts in — silent.
 */
function Zooming({ zoom }: { zoom: number }) {
  useState(() => {
    useAppStore.setState({ cardZoom: zoom, zoomPulse: 0 });
  });
  const zoomCards = useAppStore((s) => s.zoomCards);

  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <div className="flex gap-2">
        <button type="button" onClick={() => zoomCards(-1)} className={STEP_BUTTON}>
          Zoom out
        </button>
        <button type="button" onClick={() => zoomCards(1)} className={STEP_BUTTON}>
          Zoom in
        </button>
      </div>
      <p className="max-w-sm text-sm text-dim">
        One press is one notch. Press again before the badge fades and its clock starts over,
        which is what keeps the figure up for the whole of a rolled wheel — and pressing past
        either end of the ladder keeps it up too, saying the same number.
      </p>
      <CardZoomIndicator />
    </div>
  );
}

const meta = {
  title: "Chrome/CardZoomIndicator",
  // `ZoomBadge` and not `CardZoomIndicator`, because it is the half with properties: the
  // indicator takes none at all — it reads the store — and is on screen for a second and a fifth
  // at a time, which no catalogue entry can hold still. Every story below is the badge at rest
  // except {@link WhileZooming}, which is the whole thing, live.
  component: ZoomBadge,
  tags: ["autodocs"],
  args: { zoom: 1.25 },
  decorators: [
    // The badge is `fixed`, so on the docs page every story would stack at the bottom of the
    // article. A **transformed** ancestor is the containing block for `position: fixed`
    // descendants (CSS Transforms), so `transform-gpu` boxes each story into its own frame
    // without touching a class on the component — `SyncProgress.stories.tsx` boxes its overlay
    // the same way. Nothing about the badge changes: it still centres itself near the bottom of
    // its window, the window is simply this box.
    (Story) => (
      <div className="relative h-40 w-full transform-gpu overflow-hidden rounded-lg border border-border bg-bg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the reader is told while they zoom the card sections with ctrl+wheel: the size " +
          "as a percentage, centred near the bottom of the window, gone about a second after " +
          "their hand stops.\n\n" +
          "**`zoomPulse` and not `cardZoom` is what puts it up.** A gesture at either end of " +
          "`ZOOM_STEPS` changes no number — the ladder is clamped — and that is precisely the " +
          "moment a reader most needs an answer, because they are rolling the wheel and " +
          "nothing is happening. So the store counts *gestures*, every one of them restarts " +
          "the clock, and “200%, and that is as far as it goes” is a badge that stays up under " +
          "a hand that keeps going.\n\n" +
          "**It is `aria-hidden`, and that is a decision rather than an omission.** This is " +
          "transient feedback for a mouse-and-trackpad gesture; a live region here would " +
          "announce “60%… 75%… 90%…” once per wheel notch, which is a burst of noise a " +
          "screen-reader reader cannot act on and did not ask for. It is also " +
          "`pointer-events-none` — the box spans the window directly over the grid, and a " +
          "layer that took the pointer would swallow the very ctrl+wheel events that put it " +
          "there.\n\n" +
          "The figure is Geist Mono and `tabular-nums`: three characters that change on every " +
          "notch, in the one face where they do not shove their own box around as they do it.",
      },
    },
  },
} satisfies Meta<typeof ZoomBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The resting look, two stops up from life size.
 *
 * The claim under it is an attribute no screenshot shows, so it is asserted: the badge is
 * decoration, and the app has exactly one `role="status"` (the ribbon's line) that this must
 * never become a second of.
 */
export const Enlarged: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const badge = canvas.getByText(formatZoom(args.zoom));
    await expect(badge.closest("[aria-hidden='true']")).toBeInTheDocument();
    await expect(canvas.queryByRole("status")).toBeNull();
  },
};

/**
 * Life size — the figure the reader gets on the way back down, not a state the badge is idle in.
 *
 * Worth a story because it is the one percentage that means "nothing is being done to these
 * cards", and it still appears: a zoom-out that lands on 100% is a gesture like any other, and
 * saying nothing there would leave the reader guessing whether they had arrived.
 */
export const LifeSize: Story = { args: { zoom: DEFAULT_ZOOM } };

/** The bottom of the ladder, read from `ZOOM_STEPS` rather than typed, and the shortest figure
 *  the badge ever draws — the pill is sized by its padding, so it does not shrink around it. */
export const AtHalfSize: Story = { args: { zoom: MIN_ZOOM } };

/** The top of the ladder, and the longest figure. `tabular-nums` is why the two sit still
 *  against each other: every digit is the same width, so a wheel rolled through 90 → 100 → 110
 *  does not jitter the pill. */
export const AtDoubleSize: Story = { args: { zoom: MAX_ZOOM } };

/**
 * The whole thing, live: the real component, reading the real store, stepped by the store's own
 * `zoomCards`.
 *
 * Press **Zoom in** and the badge appears; press again within the second and its clock starts
 * over. Left alone it is gone about {@link ZOOM_QUIET_MS} after the last press — which is the one
 * claim on this page that only a running story can make, and the reason this story exists beside
 * four still ones. Holding either end of the ladder is worth a press too: the figure stops
 * changing and the badge stays up regardless, which is the whole of what `zoomPulse` buys.
 */
export const WhileZooming: Story = {
  render: (args) => <Zooming zoom={args.zoom} />,
  parameters: {
    docs: {
      // **This one story gets its own frame**, and the four above deliberately do not. The rule
      // in `.storybook/CLAUDE.md` is about a docs page where several stories write `useAppStore`
      // during render: the store is a module singleton, so inline they would all end up showing
      // the last writer's view. Here exactly one story touches it and the others take their
      // figure as an argument, so there is no second view for a write to overwrite — what the
      // frame buys is that pressing Zoom in on the docs page cannot leave a pulse behind in the
      // page's own store.
      story: { inline: false, height: "300px" },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // Through the app's own ladder and its own formatter rather than a typed-out "150%": what
    // this story is about is *when* the figure is on screen, and a hand-written percentage would
    // be a second claim about `stepZoom` and `formatZoom` that nothing keeps in step with them.
    const figure = formatZoom(stepZoom(args.zoom, 1));

    // Nothing on mount, however much zooming a story before this one did.
    await expect(canvas.queryByText(figure)).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
    await waitFor(async () => {
      await expect(canvas.getByText(figure)).toBeInTheDocument();
    });

    // …and away again on its own, with nobody pressing anything. The wait is the delay itself
    // plus room for a slow machine — the default second would expire before the badge did.
    await waitFor(
      async () => {
        await expect(canvas.queryByText(figure)).toBeNull();
      },
      { timeout: ZOOM_QUIET_MS + 3_000 },
    );
  },
};
