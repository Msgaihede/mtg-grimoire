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
          "**It is the card search's own wall, scoped to what the reader owns** (2026-08-24): the " +
          "same `CardGrid`, the same zoom section, the same tile, over `collection_list` instead " +
          "of `search_cards`. It was a list of text rows until then, on the argument that a wall " +
          "of art answers *which card* while this tab has to answer *which copy* — sound, and it " +
          "made the tab the panel opens on look like a different application from the tab beside " +
          "it.\n\n" +
          "The grain question is answered where a picture cannot help: `foldCopies` folds the " +
          "copies of a printing **in one finish** into one tile and **`pickCopy` chooses which of " +
          "them a press moves** — the desk before a deck, a real card before a proxy, the oldest " +
          "entry first. So a copy another deck is holding is still never taken silently. A foil " +
          "and a played nonfoil are two objects at two prices, so they stay two tiles, each " +
          "quoting its own price in the chin.\n\n" +
          "**It is assign-only since issue #358**: it answers *which copies I own back this " +
          "deck's list*. A tile whose card the open deck's live list does not play is drawn " +
          "**greyed**, with a reason naming the **Card search** tab beside it — the tile stays " +
          "because the reader can see the card in their binder, and one that vanished would read " +
          "as a search that lost it. `collection_alloc::NOT_IN_DECK` refuses the same press at " +
          "the backend; the greying is that refusal said early.\n\n" +
          "Driven end to end by `.storybook/fake/`. The `starter` seed carries all three answers " +
          "at once, across two decks: **deck 1** (Modern Goodstuff) plays no Black Lotus, so the " +
          "proxy in `Trade binder` is the greyed tile; **deck 2** (Kenrith Two-Drops) plays " +
          "Ragavan and the reader's only copy sits in deck 1's group, which is the one press on " +
          "this page that takes a card off a deck they are not looking at.",
      },
    },
  },
} satisfies Meta<typeof Tab>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Open the filter tray, and hand back the **`Not in a deck`** chip inside it.
 *
 * Set, Format, Decks, Rarity and Price went behind a disclosure on 2026-08-25, when this tab
 * stopped drawing a filter row of its own and started drawing `FilterBar`'s — so every play about
 * one of them presses this first. The four controls that never fold away (the search box, the
 * colours, the mana values and the sort) need none of it.
 *
 * It hands back the chip rather than the disclosure because that is what three of the four callers
 * want next, and because a helper that returned the thing it pressed would leave each of them
 * repeating the query it exists to spell once.
 */
async function openTray(canvas: ReturnType<typeof within>): Promise<HTMLElement> {
  await userEvent.click(await canvas.findByRole("button", { name: /^Show filters/ }));
  return canvas.findByRole("button", { name: /^Not in a deck/ });
}

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

    const toggle = await openTray(canvas);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Tiles, found by the one control each carries: a wall says the copy in an accessible **name**
    // rather than in a line of text, so this is the query a wall answers.
    const adds = await canvas.findAllByRole("button", { name: /^Add / });
    await expect(adds.length).toBeGreaterThan(0);
    // And the row above them is the card search's own — which is the whole of the 2026-08-25
    // change, so it is worth naming a cell the card search draws and one it does not.
    await expect(canvas.getByRole("group", { name: "Color identity" })).toBeInTheDocument();
    await expect(canvas.getByRole("group", { name: "Mana value" })).toBeInTheDocument();
    await expect(canvas.getByLabelText("Format")).toBeInTheDocument();
    // No Owned pair and no All printings: every row here is a copy the reader has, and these
    // *are* their printings. `COLLECTION_TRAY` is where both absences are argued.
    await expect(canvas.queryByRole("button", { name: /^Owned/ })).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^All printings/ })).toBeNull();
  },
};

/**
 * The other end of the toggle — **every copy, wherever it is filed**.
 *
 * This is the state the confirmation exists for: with the spoken-for copies on screen, one of the
 * rows is a card another deck is physically holding, and pressing Add on it would take that card
 * off that deck's list.
 *
 * **Deck 2 rather than deck 1, and the assign-only fence is why** (issue #358). The seed's one
 * cross-deck row is Ragavan in `Modern Goodstuff`'s group, and a cross-deck press only means
 * anything on a deck that *plays* the card: deck 2 lists `mh2 138`, deck 1 does not. Opened on deck
 * 1 the same tile is greyed instead, which is what {@link NotInTheDeck} shows.
 */
export const EveryCopy: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await openTray(canvas));

    await expect(await canvas.findByRole("button", { name: /^Not in a deck/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // **Narrowed to the card, because the wall virtualises.** `stories.test.tsx` mounts a 600px
    // scroll container, so a play may assert the presence of a tile *near the top* and never a
    // count — and with every copy shown, the seed's one cross-deck row is well down the list. The
    // text box is how a reader would reach it too.
    await userEvent.type(await canvas.findByRole("searchbox"), "Ragavan");

    // The `starter` seed's one row filed under a deck the reader is **not** standing in, found by
    // what its Add button promises: since the wall folds copies, "which deck this would take from"
    // is a fact about the *press* and is said in that button's name.
    await expect(
      await canvas.findByRole("button", { name: /taking it from Modern Goodstuff$/ }),
    ).toBeInTheDocument();
  },
};

/**
 * **The press this whole PR is about, stopped one step short of the write.**
 *
 * The copy is in `Modern Goodstuff`. Confirming would move it into this deck's group *and* take
 * it off that deck's live list — a side effect landing on a deck the reader is not looking at — so
 * the question is asked first and it **names the deck**.
 *
 * Opened on **deck 2** for {@link EveryCopy}'s reason: since issue #358 a cross-deck press is only
 * reachable on a deck that already plays the card, and Kenrith Two-Drops is the seed's deck that
 * plays Ragavan.
 *
 * This app's confirmations carry **no** `dialog` or `alertdialog` role: the box is a
 * `role="group"` that takes the caret (`useConfirmFocus`), because the reader has not decided yet
 * and a stray Enter must not decide for them.
 *
 * **It is drawn above the wall rather than under the tile it was asked from** (2026-08-24). A
 * folded tile has no row to sit under, and `CardGrid` virtualises — a tile scrolled out from under
 * an open question would unmount it mid-answer. So it quotes the card as well as the deck, which
 * is what makes the position survivable.
 */
export const CrossDeckConfirm: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await openTray(canvas));
    // Narrowed for {@link EveryCopy}'s reason — the wall virtualises and this row is not near the
    // top of the whole binder.
    await userEvent.type(await canvas.findByRole("searchbox"), "Ragavan");

    await userEvent.click(
      await canvas.findByRole("button", { name: /taking it from Modern Goodstuff$/ }),
    );

    const question = await canvas.findByRole("group", { name: /^Move / });
    await expect(within(question).getByText(/Modern Goodstuff/)).toBeInTheDocument();
    await expect(
      within(question).getByRole("button", { name: "Move it here" }),
    ).toBeInTheDocument();
  },
};

/**
 * **The tab is assign-only** ([#358](https://github.com/Msgaihede/mtg-grimoire/issues/358)), and
 * this is what that looks like on the wall.
 *
 * `Modern Goodstuff` plays no Black Lotus, and the reader's proxy sits loose in `Trade binder` — so
 * nothing about the *copy* is refusing this press. What refuses it is the deck's own list: filing
 * the card here would put cardboard into that deck's collection group for a card the deck has never
 * played, and that group is the ledger of where the reader's cards physically **are**.
 *
 * The tile is still drawn, because the reader can see the card in their binder and one that
 * vanished under a search that found it would read as the search losing rows. The button greys with
 * the reason in its accessible **name** — `aria-disabled` rather than `disabled`, so the tab stop
 * and therefore the sentence survive for a keyboard reader — and the sentence **names the route**:
 * the `Card search` tab is one press away, and adding the card there un-greys this tile with no
 * reload, because `useDeckPlays` sits under the `["decks"]` key every deck write invalidates.
 *
 * No press is needed to reach it: the proxy is loose, so it is in the wall's default
 * **`Not in a deck`** state.
 */
export const NotInTheDeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Narrowed for {@link EveryCopy}'s reason — the wall virtualises.
    await userEvent.type(await canvas.findByRole("searchbox"), "Black Lotus");

    // The tile is drawn: `CardGrid` names a tile's own button after the card.
    await expect(await canvas.findByRole("button", { name: "Black Lotus" })).toBeInTheDocument();

    const add = await canvas.findByRole("button", {
      name: /^Black Lotus is not in this deck .* add it from the Card search tab first$/,
    });
    await expect(add).toHaveAttribute("aria-disabled", "true");
  },
};

/**
 * The tab at the narrowest the panel goes — `MIN_PANEL_WIDTH_PX` is **206**, whose content box is
 * ~193px.
 *
 * **The filter row grew from three controls to five groups on 2026-08-24**, so this is the story
 * that matters most of the set: the colour pips and the mana-value chips are the two that have
 * actually overflowed a panel before. Every group is `flex-wrap`, and the wrap is the whole of what
 * makes this width safe: a flex item cannot shrink below its own min-content, so an unwrapped row
 * would be an *overhang* rather than a squeeze — and `DeckEditor`'s page section computes
 * `overflow-x` to `auto`, so that overhang becomes a horizontal scrollbar across the whole deck
 * builder. `ManaValueChips` shipped exactly that once, and it is on this row (`src/CLAUDE.md`).
 *
 * The wall under it is the other half: `CardGrid`'s `tileWidthFor` caps a tile at the wall's own
 * width, so 193px draws one column rather than a tile hanging out of it.
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

    // The picker is a tray cell, so the disclosure comes first — see {@link openTray}.
    await openTray(canvas);
    await expect(await canvas.findByRole("button", { name: "Format" })).toHaveTextContent(
      "Modern",
    );
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
