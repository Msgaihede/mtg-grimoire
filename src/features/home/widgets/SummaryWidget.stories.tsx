import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { patchConfig } from "../layout";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { widgetDensity } from "../widgetSettings";
import { SummaryWidget, SummaryWidgetSettings } from "./SummaryWidget";

/** The grid's target cell, so a footprint here is drawn at the size an ordinary window draws it. */
const CELL = 104;

/** How long a play waits on a freshly opened settings popover. A plain `const`, because CSF
 *  indexes every non-default export as a story. */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/** A Summary entry at a footprint. */
const summaryAt = (w: number, h: number, config: unknown = null): HomeWidget => ({
  id: "summary",
  kind: "summary",
  x: 0,
  y: 0,
  w,
  h,
  config,
});

/**
 * The body inside the card the page draws it in, at its footprint's pixel size.
 *
 * **The config is held here and patched the way the page patches it** (`patchConfig`: merge, and
 * `undefined` removes), so a press in the `Figures` checklist takes the figure off the card in the
 * story rather than only reaching a mock. `onConfig` is still called, so a play can assert the
 * write too. The fit is rebuilt from the held entry, which is what the page does after a write.
 */
function Framed({ widget: initial, editing, still, onConfig }: WidgetBodyProps) {
  const [widget, setWidget] = useState(initial);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx: spanPx(widget.w, CELL),
    heightPx: spanPx(widget.h, CELL),
    density: widgetDensity(widget),
  });
  const patch = (fields: Record<string, unknown>) => {
    onConfig(fields);
    setWidget(
      (current) => patchConfig({ version: 2, widgets: [current] }, current.id, fields).widgets[0],
    );
  };
  return (
    <div style={{ width: fit.widthPx, height: fit.heightPx }}>
      <WidgetCard
        widget={widget}
        fit={fit}
        editing={editing}
        still={still}
        onConfig={patch}
        onRemove={fn()}
        extraSettings={<SummaryWidgetSettings widget={widget} onConfig={patch} />}
      >
        <SummaryWidget
          widget={widget}
          fit={fit}
          editing={editing}
          still={still}
          onConfig={patch}
        />
      </WidgetCard>
    </div>
  );
}

/**
 * The body with a query client that has not fetched — the beat before four reads answer.
 *
 * **A client rather than a stubbed command, and rather than a fault.** `busy` is
 * `collection::BUSY` and the fake honours it on **writes only** (`.storybook/fake/db.ts`'s
 * `refuseIfBusy`, wired into every `writeHandlers` entry and no read), which is the crate's own
 * split: a write takes `AppState.db` and can be refused, a read goes through `db_read` and
 * answers through every second of a sync. So there is no world in which one of these four reads
 * is in flight for longer than a microtask, and the sentence this widget draws for that beat —
 * one of the three it insists are three different statements — would otherwise be unstoryable.
 *
 * A nested `QueryClientProvider` whose queries are `enabled: false` is the honest shape of it:
 * nothing is mocked, no command answers anything it would not answer, and every one of the four
 * queries sits at `status: "pending"` with `data: undefined`, which is exactly what the widget
 * sees on its first render. It is deliberately **its own** client rather than the world's, so
 * nothing here can leak into the story mounted beside it on a docs page.
 */
function Unanswered(props: WidgetBodyProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Framed {...props} />
    </QueryClientProvider>
  );
}

const DEFAULT_WIDGET = summaryAt(4, 2);

const meta = {
  title: "Home/SummaryWidget",
  component: SummaryWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's own entry for this kind: four cells by two, nothing configured. A
    // story that changes the footprint passes only `widget` — `Framed` builds the fit from the
    // entry it holds, as the page does, and this `fit` is only what the body's type requires.
    widget: DEFAULT_WIDGET,
    fit: makeFit({
      w: 4,
      h: 2,
      widthPx: spanPx(4, CELL),
      heightPx: spanPx(2, CELL),
      density: "comfortable",
    }),
    editing: false,
    still: false,
    onConfig: fn(),
  },
  render: (args) => <Framed {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "What the whole grimoire adds up to: the collection's copies, the decks, the " +
          "wishlist's copies and what the collection is worth — each a press that opens the " +
          "view it is about.\n\n" +
          "**A body, drawn here inside the card the page draws it in.** `WidgetCard` owns the " +
          "title, the tray and the settings popover; this owns the figure line, cut to the box: " +
          "how many figures share a line (~110px each) times how many lines the body has " +
          "(~40px each), capped by what the card's width in cells wants — a pair on a two-cell " +
          "tile, all four from four cells wide. **The reader's own picks come first**: a figure " +
          "switched off in the `Figures` checklist is not a figure competing for room.\n\n" +
          "**Four reads and no fifth command.** Every figure is answered by the command the " +
          "view it names is built on — `collection_summary`, `deck_list`, `deck_values`, " +
          "`wishlist_summary` — so the number on this card and the number on the page a press " +
          "from it opens are one query rather than two answers. Two of the four keys are " +
          "shared verbatim with other readers (`collectionTotalKey` with " +
          "`CollectionValueWidget`, `wishlistTotalKey` with `WishlistValueWidget`), which is " +
          "one fetch between them.\n\n" +
          "**Each count's press label is still the whole sentence** — its copies, its value and " +
          "what went unpriced — because the figure line has room for one number apiece and a " +
          "summary that lost two totals to make room would summarise less.\n\n" +
          "**Three sentences and never one shrug.** Loading, empty and refused send a reader " +
          "to three different places. The refusal arm is the one state this workbench cannot " +
          "reach — no fault in `.storybook/fake/` refuses a read — and {@link StillReading} " +
          "carries the note on how the in-flight one is stood up without mocking anything.",
      },
    },
  },
} satisfies Meta<typeof SummaryWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded grimoire at the kind's default footprint: all four figures.
 *
 * The `play` reads the **accessible** story rather than the drawing. A figure's visible face is a
 * label over a number, which computes to `Collection21cards` — so the sentence is written out in
 * `aria-label`, and that written sentence is what is asserted.
 *
 * `Decks` counts **piles** where the other two count cardboard, which is why its noun is not
 * `card`: archived decks are in both the count and the money, because a total over decks the count
 * leaves out cannot be checked against anything on screen.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));

    // The count and the noun, then the money. Anchored at the start rather than matched whole,
    // because the tail carries an unpriced note only where the marketplace left a hole — which
    // is a fact about the price feed rather than about this widget.
    await expect(
      await summary.findByRole("button", { name: /^Collection: 21 cards, \$/ }),
    ).toBeInTheDocument();
    // Four seeded decks, archived one included.
    await expect(summary.getByRole("button", { name: /^Decks: 4 decks, / })).toBeInTheDocument();
    await expect(
      summary.getByRole("button", { name: /^Wishlist: \d+ cards, / }),
    ).toBeInTheDocument();
    await expect(
      summary.getByRole("button", { name: /^Collection value: \$/ }),
    ).toBeInTheDocument();
  },
};

/**
 * A two-cell tile — an honest pair rather than four figures crushed into 220px.
 *
 * The pair is the first two the reader has not hidden, in the checklist's order, so the counts a
 * press opens a view with outrank the money on the smallest card.
 */
export const Tile: Story = {
  args: { widget: summaryAt(2, 2) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));

    await expect(
      await summary.findByRole("button", { name: /^Collection: / }),
    ).toBeInTheDocument();
    await expect(summary.getByRole("button", { name: /^Decks: / })).toBeInTheDocument();
    await expect(summary.queryByRole("button", { name: /^Wishlist: / })).not.toBeInTheDocument();
    await expect(
      summary.queryByRole("button", { name: /^Collection value: / }),
    ).not.toBeInTheDocument();
  },
};

/**
 * The `Figures` checklist — the one setting this kind has that the registry cannot declare.
 *
 * Customize on, the settings popover opened, and `Decks` switched off: the figure leaves the card
 * and the write is `{ hide: ["decks"] }`, a whole list rather than a toggle, so a key a newer build
 * hid would survive this build's press.
 */
export const ChoosingFigures: Story = {
  args: { editing: true },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));

    await userEvent.click(summary.getByRole("button", { name: "Settings for Summary" }));
    const decks = await waitFor(
      () => summary.getByRole("checkbox", { name: "Decks" }),
      POPOVER_TIMEOUT,
    );
    await expect(decks).toBeChecked();

    await userEvent.click(decks);
    await expect(args.onConfig).toHaveBeenCalledWith({ hide: ["decks"] });
    await waitFor(async () => {
      await expect(summary.getByRole("checkbox", { name: "Decks" })).not.toBeChecked();
    });
  },
};

/**
 * A database nobody has put anything in — and one sentence rather than four zeroes.
 *
 * **The empty state is all three being empty**, which is the rule worth seeing here: a reader
 * with a collection and no decks is owed the collection's figure and a plain `0` beside it,
 * because that is a true statement about their decks rather than a gap. Only a grimoire with
 * nothing in any of the three gets the sentence.
 */
export const NothingYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));
    await expect(await summary.findByText(/^Nothing to add up yet\./)).toBeInTheDocument();
    // Not a row of zeroes: the presses are gone with the figures, so there is nothing to open a
    // view that has nothing in it.
    await expect(summary.queryByRole("button", { name: /^Collection:/ })).not.toBeInTheDocument();
  },
};

/**
 * The four reads still out — the first of the widget's three sentences.
 *
 * "We have not read it yet" is not "there is nothing to read", and a card that drew zeroes for
 * both would be lying in one of them. See {@link Unanswered} for why this is a paused query
 * client rather than the `busy` fault: `busy` is a write lock and reaches no read in the fake or
 * in the crate.
 */
export const StillReading: Story = {
  render: (args) => <Unanswered {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));
    await expect(
      summary.getByText("Adding up your collection, decks and wishlist…"),
    ).toBeInTheDocument();
    await expect(summary.queryByRole("button", { name: /^Collection:/ })).not.toBeInTheDocument();
  },
};
