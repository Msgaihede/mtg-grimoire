import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { FormatFilterOption } from "@/features/search/useCardSearch";
import { AUTO_CATEGORY } from "./autoCategory";
import { CollectionSearchTab } from "./CollectionSearchTab";
import { useDeck } from "./useDeck";

/**
 * The tab on its own, in a box the width of the panel that hosts it.
 *
 * **`categories` comes off `useDeck`** rather than being hand-written, for `DeckSearchPanel`'s
 * own reason: a category is a row of the reader's deck, so the fake's database is what answers
 * the list — and it is also where this component reads the **deck id** it addresses
 * `collection_to_deck` with. A hand-copied list would be a story asserting against ids the fake
 * does not have.
 *
 * `targetCategoryId` is the deck row's `default_category_id`, which is {@link AUTO_CATEGORY} until
 * somebody sets it in the settings dialog — so these stories exercise the per-card pile the Add
 * buttons name.
 */
function Tab({
  deckId,
  defaultFormat = null,
  width = 372,
}: {
  deckId: number;
  defaultFormat?: FormatFilterOption | null;
  /**
   * The content box this tab is drawn in, in px — an **arg** rather than a decorator, because the
   * decorator would have to fight the box's own width to narrow it.
   *
   * 372 is `DEFAULT_PANEL_WIDTH_PX` (384) less the panel's left border and padding; **193** is the
   * same arithmetic at {@link MIN_PANEL_WIDTH_PX}, which is where {@link Narrow} puts it.
   */
  width?: number;
}) {
  const deck = useDeck(deckId);
  return (
    // The panel's own shape: a `min-h-0` flex column with a height, so the list inside is what
    // scrolls rather than the page.
    <div className="flex h-[560px] min-h-0 flex-col gap-2" style={{ width }}>
      <CollectionSearchTab
        categories={deck.categories}
        // The deck the copies move into — the editor's own id, threaded through the panel rather
        // than read off `categories[0]` (2026-08-23). A wrapper is where the editor would be, so
        // it hands over the same id it opened the deck with.
        deckId={deckId}
        targetCategoryId={deck.deck?.defaultCategoryId ?? AUTO_CATEGORY}
        defaultFormat={defaultFormat}
      />
    </div>
  );
}

const meta = {
  title: "Decks/CollectionSearchTab",
  component: Tab,
  tags: ["autodocs"],
  args: { deckId: 1 },
  render: (args) => <Tab key={args.deckId} {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "The deck search panel's **Collection** tab — the reader's own binder, beside the deck, " +
          "and the first thing in the app to call `collection_to_deck`.\n\n" +
          "It lists collection **rows** rather than oracle cards: one per printing, finish and " +
          "condition, each saying **where that copy is filed**. That last fact is what a wall of " +
          "art cannot draw and what this whole tab turns on — the same printing filed in two " +
          "places is two rows, and which one is added decides whether another deck loses a card." +
          "\n\n" +
          "Driven end to end by `.storybook/fake/`. The `starter` seed was built with this screen " +
          "in mind: deck 1's group holds three copies (drawn as **already in this deck**), and " +
          "exactly one row sits in **deck 2's** group — the one press on this page that takes a " +
          "card off a deck the reader is not looking at.",
      },
    },
  },
} satisfies Meta<typeof Tab>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * How the tab opens: the reader's own copies, **narrowed to the ones no deck is holding**.
 *
 * That default is the product decision this tab is (spec §7.2). "Unallocated" is the root, a
 * drawer the reader made and `Recently removed` — three places where a card is still on the desk
 * — and a copy in a deck's group is spoken for. `CollectionQuery.allocation` is the field that
 * says so, and this tab is the first thing in the app ever to send it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const toggle = await canvas.findByRole("button", { name: /^Not in a deck/ });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Rows, and each one says where its copies live — the root in words rather than as a blank.
    const rows = await canvas.findAllByRole("listitem");
    await expect(rows.length).toBeGreaterThan(0);
    await expect(canvas.getAllByText("Collection").length).toBeGreaterThan(0);
  },
};

/**
 * The other end of the toggle — **every copy, wherever it is filed**.
 *
 * This is the state the confirmation exists for: with the spoken-for copies on screen, one of the
 * rows is a card another deck is physically holding, and pressing Add on it would take that card
 * off that deck's list.
 */
export const EveryCopy: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /^Not in a deck/ }));

    await expect(await canvas.findByRole("button", { name: /^Not in a deck/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The `starter` seed's one row filed under a deck the reader is **not** standing in.
    await expect(await canvas.findByText("Kenrith Two-Drops")).toBeInTheDocument();
  },
};

/**
 * **The press this whole PR is about, stopped one step short of the write.**
 *
 * The copy is in `Kenrith Two-Drops`. Confirming would move it into this deck's group *and* take
 * it off that deck's live list — a side effect landing on a deck the reader is not looking at — so
 * the question is asked first and it **names the deck**.
 *
 * This app's confirmations carry **no** `dialog` or `alertdialog` role: the box is a
 * `role="group"` that takes the caret (`useConfirmFocus`), because the reader has not decided yet
 * and a stray Enter must not decide for them.
 */
export const CrossDeckConfirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /^Not in a deck/ }));
    await canvas.findByText("Kenrith Two-Drops");

    const rows = await canvas.findAllByRole("listitem");
    const spokenFor = rows.find((r) => within(r).queryByText("Kenrith Two-Drops"));
    await expect(spokenFor).toBeTruthy();
    await userEvent.click(within(spokenFor!).getByRole("button"));

    const question = await canvas.findByRole("group", { name: /^Move / });
    await expect(within(question).getByText(/Kenrith Two-Drops/)).toBeInTheDocument();
    await expect(
      within(question).getByRole("button", { name: "Move it here" }),
    ).toBeInTheDocument();
  },
};

/**
 * The tab at the narrowest the panel goes — `MIN_PANEL_WIDTH_PX` is **206**, whose content box is
 * ~193px.
 *
 * The filter row is three controls and `flex-wrap`, and the wrap is the whole of what makes this
 * width safe: a flex item cannot shrink below its own min-content, so an unwrapped row would be an
 * *overhang* rather than a squeeze — and `DeckEditor`'s page section computes `overflow-x` to
 * `auto`, so that overhang becomes a horizontal scrollbar across the whole deck builder.
 * `ManaValueChips` shipped exactly that once (`src/CLAUDE.md`).
 *
 * **jsdom lays nothing out, so the suite cannot see any of it** — this story is where a person
 * looks.
 */
export const Narrow: Story = {
  args: { width: 193 },
};

/**
 * A deck whose format the search opens on.
 *
 * A **default and never a constraint**: the select is still the reader's, and `Any format` is one
 * press away. The fence is `DeckEditor`'s — `spec.hasLegalityData`, because `casual` is every
 * deck's birth format and answers no rows at all — so what arrives here is already known to be a
 * key the backend can filter by.
 */
export const DeckFormat: Story = {
  args: { defaultFormat: { value: "modern", label: "Modern" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByLabelText("Format")).toHaveValue("modern");
  },
};

/**
 * A binder with nothing in it — the state a reader has on the day they install the app.
 *
 * It says so rather than drawing an empty box: a blank column reads as a control still loading,
 * and this tab is the panel's *default*, so it is the first thing a new reader sees.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/No copies match/)).toBeInTheDocument();
  },
};
