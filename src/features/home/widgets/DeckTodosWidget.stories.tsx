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
          "Every deck's **to-do lists**, gathered: a heading per deck — its name and how many of " +
          "its to-dos are open across all its lists, at every depth — then each list's title " +
          "(`Untitled list` when it has none) and that list's to-dos beneath it, sub-to-dos " +
          "indented one step per level. **A to-do list is not a note**: a deck holds any number " +
          "of titled lists, and a to-do is a line of one. A list's headings and paragraphs are " +
          "the band's to read; this card draws the to-dos alone.\n\n" +
          "**The checkbox ticks in place**, as a compare-and-set on that one list: the tick sends " +
          "the body it read, and a list that moved since is refused with its own sentence in the " +
          "card's one-line failure slot and read again. **A deck's heading opens the deck on its " +
          "To-do band**, opening the band first when it is shut.\n\n" +
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
 * The default panel over `starter`'s three lists — `Rhystic Testbed`'s two, edited last, then
 * `Kenrith Two-Drops`' one — with the done sub-to-dos and the done top-level to-do hidden. Three
 * cells tall is room for the first deck and its two lists; the rest is counted in the footer.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("button", { name: "Rhystic Testbed · 4 open" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("heading", { level: 5, name: "To-do" })).toBeInTheDocument();
    await expect(
      card.getByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' }),
    ).toBeInTheDocument();
    await expect(
      card.queryByRole("checkbox", { name: 'Mark "Sleeve the deck" not done' }),
    ).not.toBeInTheDocument();
  },
};

/**
 * The tallest card the kind allows: both decks whole. `Rhystic Testbed` draws its two lists under
 * one heading, each under its own title — and `Mana`'s body is a document, a heading and a paragraph
 * among its to-dos, of which the card draws the to-dos alone.
 */
export const Lists: Story = {
  args: { widget: todos(3, 6) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("button", { name: "Rhystic Testbed · 4 open" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Kenrith Two-Drops · 1 open" })).toBeInTheDocument();
    await expect(
      card.getAllByRole("heading", { level: 5 }).map((el) => el.textContent),
    ).toEqual(["To-do", "Mana", "To-do"]);
    await expect(card.getByRole("checkbox", { name: 'Mark "Cut a land" done' })).toBeInTheDocument();
    await expect(card.queryByText(/Some notes about/)).not.toBeInTheDocument();
  },
};

/** The widest card the kind allows, three cells tall: the same lists with room to read each line. */
export const Wide: Story = {
  args: { widget: todos(6, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To-dos" }));
    await expect(
      await card.findByRole("checkbox", { name: 'Mark "Add a Treasure maker" done' }),
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
    await expect(await card.findByText("Add a Treasure maker")).toBeInTheDocument();
    await expect(card.queryByRole("checkbox")).toBeNull();
    await expect(card.queryByRole("button", { name: /^Rhystic Testbed/ })).toBeNull();
  },
};
