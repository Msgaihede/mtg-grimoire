import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { WidgetProps } from "../widgetProps";
import { SummaryWidget } from "./SummaryWidget";

/**
 * The chrome the page wraps every widget in, as a story has to supply it.
 *
 * `widgetProps.ts` splits a widget's props in two — what the widget is *about* (`widget`,
 * `onConfig`) and what the page is *doing to it* — and this is the second half. A widget passes
 * every field of it straight to `WidgetCard` and interprets none of it, so a story can hand over
 * five mocks and still be drawing exactly what the page draws.
 *
 * `fn()` rather than a no-op arrow so a play can assert a press reached the page. Storybook
 * resets these between stories, which is what keeps `toHaveBeenCalled` a claim about *this*
 * story.
 */
const CHROME = {
  editing: false,
  onRemove: fn(),
  onSpan: fn(),
  onConfig: fn(),
  onNudge: fn(),
  dragHandleRef: fn(),
};

/**
 * The widget with a query client that has not fetched — the beat before four reads answer.
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
function Unanswered({ widget, ...chrome }: WidgetProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <SummaryWidget widget={widget} {...chrome} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Home/SummaryWidget",
  component: SummaryWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's own entry for this kind, verbatim — `span: 2`, `config: null`. This
    // widget remembers nothing, so the config is the one field that could not be anything else.
    widget: { id: "summary", kind: "summary", span: 2, config: null },
    ...CHROME,
  },
  decorators: [
    // The card's own default width: `span: 2` is the whole grid row, and at 1280 with the rail
    // docked that is about 52rem. The three figures wrap at a 10rem basis, so a narrower box
    // would story a layout the page only reaches on a phone.
    (Story) => (
      <div className="w-[52rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the whole grimoire adds up to: the collection, the decks and the wishlist, " +
          "each with its copies, its value and the copies that value could not include.\n\n" +
          "**Four reads and no fifth command.** Every figure is answered by the command the " +
          "view it names is built on — `collection_summary`, `deck_list`, `deck_values`, " +
          "`wishlist_summary` — so the number on this card and the number on the page a press " +
          "from it opens are one query rather than two answers. Two of the four keys are " +
          "shared verbatim with other readers (`collectionTotalKey` with " +
          "`CollectionValueWidget`, `wishlistTotalKey` with `WishlistValueWidget`), which is " +
          "one fetch between them.\n\n" +
          "**Each figure is a `<button>` and not a `Figure`.** `Figure` draws a `<dt>`/`<dd>` " +
          "pair, which is only valid inside a `<dl>` — and a `<dl>` is flow content, which a " +
          "`<button>` may not contain. So these are real buttons wearing `Figure`'s type " +
          "scale, and each states its whole sentence as an `aria-label`: a name computed from " +
          "a flex column runs the label and the count together as one word.\n\n" +
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
 * The seeded grimoire: twelve collection rows holding twenty-one copies, four decks, and a
 * wishlist.
 *
 * The `play` reads the **accessible** story rather than the drawing. Each figure's visible face
 * is three flex children with a `gap` between them, which computes to `Collection21 cards$…` —
 * so the sentence is written out in `aria-label`, and that written sentence is what is asserted.
 *
 * `Decks` counts **piles** where the other two count cardboard, which is why its noun is not
 * `card`: a total over decks the count leaves out is a figure that cannot be checked against
 * anything on screen, so archived decks are in both.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));

    // The count and the noun, then the money. Anchored at the start rather than matched whole,
    // because the tail carries an unpriced note only where the marketplace left a hole — which
    // is a fact about the price feed rather than about this widget.
    await expect(
      summary.getByRole("button", { name: /^Collection: 21 cards, \$/ }),
    ).toBeInTheDocument();
    // Four seeded decks, archived one included.
    await expect(summary.getByRole("button", { name: /^Decks: 4 decks, / })).toBeInTheDocument();
    await expect(
      summary.getByRole("button", { name: /^Wishlist: \d+ cards, / }),
    ).toBeInTheDocument();
  },
};

/**
 * A database nobody has put anything in — and one sentence rather than three zeroes.
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
    // Not a row of zeroes: the three presses are gone with the figures, so there is nothing to
    // open a view that has nothing in it.
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

/**
 * Customize on: the card grows its tray and nothing else about it changes.
 *
 * The tray is `WidgetCard`'s and every control in it folds the heading into its own accessible
 * name — six cards are six addressable Remove buttons rather than one name repeated six times.
 * This widget carries **no settings control**, because it remembers nothing and an empty
 * popover is a question with no answers in it.
 */
export const Customizing: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = within(await canvas.findByRole("region", { name: "Summary" }));
    await expect(summary.getByRole("button", { name: "Move Summary" })).toBeInTheDocument();
    await expect(summary.getByRole("button", { name: "Full width, Summary" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(summary.getByRole("button", { name: "Remove Summary" })).toBeInTheDocument();
    // Nothing to remember, so nothing to open — a greyed control would read as broken.
    await expect(
      summary.queryByRole("button", { name: "Settings for Summary" }),
    ).not.toBeInTheDocument();
  },
};
