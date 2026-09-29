import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { DeckTodosWidget, DeckTodosWidgetSettings, NO_TODOS } from "./DeckTodosWidget";

/** The grid's target cell. Not exported, for CSF — every non-default export is a story. */
const CELL = 104;

/** A `deckTodos` widget at a footprint, with a config. */
function todos(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "deckTodos", kind: "deckTodos", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell — with the `Chosen…`
 * checklist the page hands this kind as its `extraSettings`, so the settings popover is the shipped
 * one.
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
          extraSettings={<DeckTodosWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <DeckTodosWidget
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
  title: "Home/DeckTodosWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config: every deck, last edited first, completed
    // to-dos and archived decks hidden — the face a reader who adds one from the catalogue meets.
    widget: todos(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Every deck's **To-do band**, gathered: a heading per deck — its name and how many of " +
          "its to-dos are open, at every depth — and its to-dos beneath, sub-to-dos indented one " +
          "step per level. **A to-do list is not a note**: one list to a deck, a column on the " +
          "deck's row, and a to-do is a line of it.\n\n" +
          "**The checkbox ticks in place**, as a compare-and-set: the tick sends the body it read, " +
          "and a list that moved since is refused with its own sentence in the card's one-line " +
          "failure slot and read again. **A heading opens the deck on its To-do band**, opening " +
          "the band first when it is shut.\n\n" +
          "Completed to-dos are hidden until `Show completed` is on — **except a done to-do over " +
          "an open sub-to-do**, which stays, drawn done, so the open one keeps its parent. Rows " +
          "are whole; what does not fit is counted in a `+N more` footer.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default panel over `starter`'s two lists — `Rhystic Testbed`, edited last, over
 * `Kenrith Two-Drops` — with the done sub-to-do and the done top-level to-do hidden.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("button", { name: "Rhystic Testbed · 2 open" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Kenrith Two-Drops · 1 open" })).toBeInTheDocument();
    await expect(
      card.getByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' }),
    ).toBeInTheDocument();
    await expect(
      card.queryByRole("checkbox", { name: 'Mark "Sleeve the deck" not done' }),
    ).not.toBeInTheDocument();
  },
};

/** The widest card the kind allows, three cells tall: the same list with room to read each line. */
export const Wide: Story = {
  args: { widget: todos(6, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("checkbox", { name: 'Mark "Revise tokens" done' }),
    ).toBeInTheDocument();
  },
};

/** `Show completed` on: the done sub-to-do and the done to-do beside it, drawn gold and struck. */
export const CompletedShown: Story = {
  args: { widget: todos(3, 4, { done: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("checkbox", { name: 'Mark "Sleeve the deck" not done' }),
    ).toBeChecked();
    await expect(
      card.getByRole("checkbox", { name: 'Mark "Cut Clue tokens" not done' }),
    ).toBeChecked();
  },
};

/** A database with no to-dos anywhere: the first-launch face. */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_TODOS)).toBeInTheDocument();
    await expect(canvas.getByText("Add them in any deck's To-do band.")).toBeInTheDocument();
  },
};

/** A catalogue preview: the same rows as pictures of rows — nothing ticks, nothing opens. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(await card.findByText("Revise tokens")).toBeInTheDocument();
    await expect(card.queryByRole("checkbox")).toBeNull();
    await expect(card.queryByRole("button", { name: /^Rhystic Testbed/ })).toBeNull();
  },
};
