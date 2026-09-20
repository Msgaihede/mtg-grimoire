import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { StickyNotesWidget } from "./StickyNotesWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `stickyNotes` widget at a footprint, with a config. */
function notes(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "stickyNotes", kind: "stickyNotes", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, in a box the card's footprint covers at the target cell — so a
 * story shows exactly the tiles, rails and rows the page would draw at that size.
 */
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
          <StickyNotesWidget
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
  title: "Home/StickyNotesWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The registry's default footprint: four cells by three, and no config — Board, all three
    // toggles on, since a `WidgetToggle` is stored only as `false`.
    widget: notes(4, 3),
  },
  parameters: {
    docs: {
      // Each story renders in its own frame: a press here opens a dialog that covers the window,
      // and the notes the fake seeds are shared state a play writes to.
      story: { inline: false, height: "440px" },
      description: {
        component:
          "The reader's own prose on the home page, in two layouts. **Board** is the default — " +
          "tinted tiles, a 3px strip in the note's own colour, the name in the display face and " +
          "a preview clamped to the tile, with a gold dot on a pinned note.\n\n" +
          "**Pad** draws one note whole and lets the card decide what carries the rest: a pager " +
          "at tier 0–1 with the stack drawn as sheets behind it, a horizontal rail of names at " +
          "tier 2, and a vertical index at tier 3. **Which note it shows is `useState` and is " +
          "never stored** — it opens on the pinned note, and the reader's flip does not sync.\n\n" +
          "**Columns come from the body's measured width, not from cells**, and rows are whole " +
          "rows: a card with room for no tile draws none rather than one it clips. Everything a " +
          "note body draws goes through the same closed markdown reader the deck band uses, so " +
          "reading a note loads no editing surface at all — the editor arrives only when a note " +
          "is opened, behind the dialog's own lazy boundary.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default footprint: three columns of two rows, the pinned note first, and every tile a press
 * that opens the editor.
 *
 * The press is what the story is for. Vitest stubs the dialog — it would otherwise drag a whole
 * ProseMirror instance into a suite with nothing to say about it — so this is the only place the
 * editor's chunk is really fetched and really mounted.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    const tiles = await card.findAllByRole("listitem");

    await expect(tiles).toHaveLength(6);
    // The pinned note is lifted, and the gold dot that says so on screen is decoration — so the
    // press says it in words or nobody hears it.
    await expect(within(tiles[0]).getByRole("button")).toHaveAccessibleName(
      "Trade night — Friday, pinned",
    );

    await userEvent.click(card.getByRole("button", { name: "Cards to proxy" }));
    await expect(await canvas.findByRole("dialog")).toBeInTheDocument();
  },
};

/**
 * Two cells by two — the size `min: [3, 2]` exists to make unreachable, drawn here because the
 * cost of it is the argument for that floor: 96×67 tiles, two preview lines, and every name
 * truncated. The footer loses its words and keeps its press.
 */
export const BoardSmall: Story = {
  args: { widget: notes(2, 2) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(await card.findAllByRole("listitem")).toHaveLength(4);
    await expect(card.getByRole("button", { name: "New note" })).toBeInTheDocument();
  },
};

/** Six by three — four columns and eight notes, which is the board at its best. */
export const BoardWide: Story = {
  args: { widget: notes(6, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(await card.findAllByRole("listitem")).toHaveLength(8);
  },
};

/** The dates and the strip switched off: the same eight notes with nothing about them but the
 *  words, and a preview line given back to every tile. */
export const BoardPlain: Story = {
  args: { widget: notes(6, 3, { dates: false, strip: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await card.findAllByRole("listitem");
    await expect(card.queryByText(/^Edited /)).not.toBeInTheDocument();
  },
};

/** Pad at the default footprint — tier 2, where the other notes become a rail of names with the
 *  current one in the accent and the rest counted. */
export const Pad: Story = {
  args: { widget: notes(4, 3, { layout: "pad" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(
      await card.findByRole("article", { name: "Trade night — Friday, pinned" }),
    ).toBeInTheDocument();

    await userEvent.click(card.getByRole("button", { name: "Cards to proxy" }));
    await expect(card.getByRole("article", { name: "Cards to proxy" })).toBeInTheDocument();
  },
};

/** Pad at two by two — tier 0, where there is room for the note and a pager and nothing else. The
 *  stack behind it is drawn rather than listed. */
export const PadSmall: Story = {
  args: { widget: notes(2, 2, { layout: "pad" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(await card.findByText("1 / 8")).toBeInTheDocument();

    await userEvent.click(card.getByRole("button", { name: "Next note" }));
    await expect(card.getByText("2 / 8")).toBeInTheDocument();
  },
};

/** Pad at six by three — tier 3, where the rail turns vertical and becomes the pad's index. */
export const PadWide: Story = {
  args: { widget: notes(6, 3, { layout: "pad" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    const index = within(await card.findByRole("list", { name: "Your notes" }));
    await expect(index.getAllByRole("listitem").length).toBeGreaterThan(4);

    await userEvent.click(index.getByRole("button", { name: "Sleeve stock" }));
    await expect(card.getByRole("article", { name: "Sleeve stock" })).toBeInTheDocument();
  },
};

/**
 * A first launch. Every other world the fake seeds has no notes at all — a note is implied by
 * nothing, where a card the reader opened is implied by their binder — so this is the state a
 * reader really starts in rather than a hole in a fixture.
 */
export const EmptyBoard: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(await card.findByText("No notes yet")).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "New note" })).toBeInTheDocument();
  },
};

/** The same empty card under the other layout: one state, drawn once, because an empty Pad and an
 *  empty Board are the same sentence and a second drawing of it would be a second thing to keep
 *  in step. */
export const EmptyPad: Story = {
  args: { widget: notes(4, 3, { layout: "pad" }) },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await expect(await card.findByText("No notes yet")).toBeInTheDocument();
  },
};

/**
 * A catalogue preview — a picture of a notes card at its default footprint.
 *
 * It opens nothing and writes nothing, so there is no press in it at all: no tile, no New note,
 * no pager. That is also what keeps the editor's chunk out of a catalogue drawing nine previews.
 */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Notes" }));
    await card.findByRole("list", { name: "Your notes" });
    await expect(card.queryByRole("button")).not.toBeInTheDocument();
  },
};
