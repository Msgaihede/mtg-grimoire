import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { DecksWidget, DecksWidgetSettings } from "./DecksWidget";

/**
 * How long a play waits on something a freshly opened dropdown has to draw.
 *
 * **Seconds-scale, and not exported.** The rows arrive once `deck_list` answers through the fake,
 * a couple of commits after the click; the default 1 s timeout fails as *the row is not there*
 * rather than as *the row is late*. A plain `const` because **CSF indexes every non-default export
 * as a story**.
 */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `decks` widget at a footprint, with a config. */
function decks(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "decks", kind: "decks", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, in a box the card's footprint covers at the target cell — so a
 * story shows exactly the rows the page would draw at that size, and the card's title, chip and
 * tray are the shipped ones rather than a stand-in.
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
          extraSettings={<DecksWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <DecksWidget widget={widget} fit={fit} editing={false} still={still} onConfig={onConfig} />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/DecksWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry for this kind: three cells by three, and no config at all —
    // which is `Most recent`, the state every reader meets first.
    widget: decks(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Rows that open a deck in one press. **A shortcut and not a second gallery**: " +
          "`DecksPage` already draws every deck with its colours, its bracket, its context menu " +
          "and its drags, and this draws the four facts a reader picks a deck by from a landing " +
          "page — the cover, the name, what it is, and what it is worth.\n\n" +
          "**Three scopes.** `Most recent` is `deck_list`'s own order with the archived decks " +
          "taken out — a filter, never a sort. `Archived too` keeps them, after the live ones. " +
          "`Pinned` is drawn in the order the reader chose, and says so in words when nothing is " +
          "pinned rather than drawing the recent decks under a chip that reads `Pinned`.\n\n" +
          "**What fits is the box's.** A cover needs three cells wide and two tall; the caption " +
          "needs a panel and a comfortable density; on a two-cell tile the value moves under the " +
          "name. Every list is cut to whole rows.\n\n" +
          "Every figure comes out of `deck_values` with the marketplace in its key, and a `null` " +
          "value is an em dash, never a zero.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * `Most recent`, three by three: covers, captions and values.
 *
 * The seed holds four decks and one of them is archived, so the archived one is not drawn —
 * "the ones I touched most recently" is about decks in play. The `play` asserts the row's
 * **written** name, because its flex children would otherwise compute to a name with the words
 * run together.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));

    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · Modern · \d+ cards/ }),
    ).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Old School 93\/94/ })).not.toBeInTheDocument();
  },
};

/** `Archived too` on a band: the shelf after the live decks, the chip naming the scope, and the
 *  price note a band has the room for. */
export const ArchivedTooOnABand: Story = {
  args: { widget: decks(4, 4, { scope: "archived" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));

    await expect(
      await card.findByRole("button", { name: /^Old School 93\/94 · .* · Archived · / }),
    ).toBeInTheDocument();
    await expect(await card.findByText(/prices as of/)).toBeInTheDocument();
  },
};

/** A two-cell tile: no cover, no caption, and the value moved under the name. */
export const Tile: Story = {
  args: { widget: decks(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · / }),
    ).toBeInTheDocument();
    await expect(card.queryByText(/^Modern · \d+ cards$/)).not.toBeInTheDocument();
  },
};

/** Compact, three by two, covers off: one line a row, so more of them fit. */
export const CompactNoCovers: Story = {
  args: { widget: decks(3, 2, { density: "compact", art: false }) },
};

/**
 * `Pinned`, and every deck in the set has gone.
 *
 * **Its own sentence, because it is its own situation.** Falling back to the most recent here
 * would answer a question the reader did not ask.
 */
export const PinnedDecksGone: Story = {
  args: { widget: decks(3, 3, { scope: "pinned", deckIds: [901, 902] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(
      await card.findByText("The decks pinned here are not in this collection any more."),
    ).toBeInTheDocument();
  },
};

/** `Pinned` with nothing pinned points at the picker. */
export const NothingPinned: Story = {
  args: { widget: decks(3, 3, { scope: "pinned" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(await card.findByText(/^No decks pinned yet/)).toBeInTheDocument();
  },
};

/** A database with no decks at all — a different sentence again, pointing at the Decks page. */
export const NoDecksYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(
      await card.findByText("No decks yet — make one on the Decks page and it will show up here."),
    ).toBeInTheDocument();
  },
};

/** A catalogue preview: the same rows as pictures of rows — nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(await card.findByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Modern Goodstuff · / })).toBeNull();
  },
};

/**
 * The pin picker on its own, as the card's settings popover draws it under `Pinned`.
 *
 * The rows are every deck there is, **sorted by the deck's own name** rather than by the row's
 * label — so the `(archived)` suffix a retired deck carries does not file it under A.
 */
export const PinPicker: Story = {
  render: () => (
    <div className="w-[268px] p-2">
      <DecksWidgetSettings widget={decks(3, 3, { scope: "pinned" })} onConfig={fn()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole("button", { name: "Decks to pin" });
    await expect(picker).toHaveTextContent("None pinned");

    await userEvent.click(picker);
    await waitFor(async () => {
      await expect(canvas.getAllByRole("option").map((row) => row.textContent?.trim())).toEqual([
        expect.stringContaining("Kenrith Two-Drops"),
        expect.stringContaining("Modern Goodstuff"),
        expect.stringContaining("Old School 93/94 (archived)"),
        expect.stringContaining("Rhystic Testbed"),
      ]);
    }, POPOVER_TIMEOUT);
  },
};
