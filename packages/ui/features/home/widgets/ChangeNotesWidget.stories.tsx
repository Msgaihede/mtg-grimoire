import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ChangeNotesWidget } from "./ChangeNotesWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits for the notes' chunk to load. Not exported, for CSF. */
const LANDED = { timeout: 5_000 };

/** A `changeNotes` widget at a footprint, with a config. */
function notes(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "changeNotes", kind: "changeNotes", x: 0, y: 0, w, h, config };
}

/** The body inside the real card. */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx,
    heightPx,
    density: widgetDensity(widget),
  });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <ChangeNotesWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/ChangeNotesWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config — the latest release, in full.
    widget: notes(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "What the newest releases changed (issue #905): the version and its day over its " +
          "notes, one section per release, from `changelog/<version>.md` as **this build** " +
          "carries it — so the story draws this repository's real notes, and the card asks no " +
          "host anything.\n\n" +
          "`Releases to show` picks the latest alone, the last three or the last five; " +
          "`Highlights only` cuts each body to its `Highlights` section, and draws a body that " +
          "has none whole. `All versions` opens Settings on its Updates panel.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The latest release, in full, with the press into the version history. */
export const Latest: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Latest change notes" }));
    await expect(await card.findAllByRole("region", { name: /^Release / }, LANDED)).toHaveLength(1);
    await expect(card.getByRole("button", { name: "All versions" })).toBeInTheDocument();
  },
};

/** The last three releases, each body cut to its highlights. */
export const LastThreeHighlights: Story = {
  args: { widget: notes(4, 5, { releases: 3, highlights: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Latest change notes" }));
    await expect(await card.findAllByRole("region", { name: /^Release / }, LANDED)).toHaveLength(3);
  },
};

/** The two-cell tile: the version without its day. */
export const Tile: Story = {
  args: { widget: notes(2, 3) },
};

/** A catalogue preview: the notes as a picture, nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Latest change notes" }));
    await expect(await card.findAllByRole("region", { name: /^Release / }, LANDED)).toHaveLength(1);
    await expect(card.queryByRole("button", { name: "All versions" })).toBeNull();
  },
};
