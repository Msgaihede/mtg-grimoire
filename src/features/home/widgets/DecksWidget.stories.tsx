import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DecksWidget } from "./DecksWidget";

/**
 * How long a play waits on something a freshly opened popover has to draw.
 *
 * **Seconds-scale, and not exported.** An `AnchoredPopup` mounts its panel on the press and the
 * dropdown inside it then reads `deck_list` through the fake, so the rows arrive a couple of
 * commits after the click; the default 1 s timeout is what a play that opened one fails on
 * first, and it fails as *the row is not there* rather than as *the row is late*. It is a plain
 * `const` because **CSF indexes every non-default export as a story** — an exported number would
 * become a story whose render is a number.
 */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/** The page's half of every widget's props — see `widgetProps.ts`. `fn()` so a play can assert
 *  a press reached the page; Storybook resets them between stories. */
const CHROME = {
  editing: false,
  onRemove: fn(),
  onSpan: fn(),
  onConfig: fn(),
  onNudge: fn(),
  dragHandleRef: fn(),
};

const meta = {
  title: "Home/DecksWidget",
  component: DecksWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry for this kind: one column, and no config at all — which is
    // what "nothing pinned" is spelled as, and the state every reader meets first.
    widget: { id: "decks", kind: "decks", span: 1, config: null },
    ...CHROME,
  },
  decorators: [
    // One column of the wrapping row. `WIDGET_CARD_BOX`'s floor is 22rem, so this is that floor
    // with a little room — the width the card is drawn at on a 1280 window with six widgets on
    // the page.
    (Story) => (
      <div className="w-[26rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Six shortcuts, each opening a deck in one press. **A shortcut and not a second " +
          "gallery**: `DecksPage` already draws every deck with its colours, its bracket, its " +
          "context menu and its drags, and this draws the four facts a reader picks a deck by " +
          "from a landing page — the cover, the name, what it is, and what it is worth.\n\n" +
          "**Three rules that are easy to get wrong**, and each is visible below. An empty " +
          "`deckIds` means the six most recently updated and the *backend* already answers " +
          "that (`deck_list` is `ORDER BY archived ASC, updated_at DESC, id DESC`), so the " +
          "fallback is a filter and a `slice` and never a sort. A **chosen** set is drawn in " +
          "the order the reader chose it, which is the one place this widget ignores that " +
          "order. And archived cuts both ways: excluded from the fallback, drawn when pinned, " +
          "and labelled either way.\n\n" +
          "**A missing pin costs nothing and says nothing** — a `deckIds` entry naming a " +
          "deleted deck is dropped on the way through, and the config is *not* rewritten to " +
          "match, because a write on render would be a page that edits itself while being " +
          "read. {@link PinnedDecksGone} is the one case that does earn a sentence: a reader " +
          "who chose a set and lost all of it is not a reader with no decks.\n\n" +
          "Every figure comes out of `deck_values` with the marketplace in its key, and " +
          "`DeckValue.value` is `null` where the marketplace priced *nothing* in that deck — " +
          "an em dash, never a zero.",
      },
    },
  },
} satisfies Meta<typeof DecksWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing pinned: the decks the reader touched most recently, archived ones left out.
 *
 * The seed holds four decks and one of them is archived, so three tiles are drawn — `Modern
 * Goodstuff` first, because `deck_list` answers `updated_at DESC` and that is the deck the seed
 * touched an hour ago.
 *
 * The `play` asserts the tile's **written** name. Its three flex children are separated by a
 * `gap` and no whitespace text node, so a computed name would read `Modern GoodstuffModern · 60
 * cards$120.00`; the widget states the whole sentence in an `aria-label` instead, and that is
 * what a reader driving by voice actually gets.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = within(await canvas.findByRole("region", { name: "Decks" }));

    await expect(
      await decks.findByRole("button", { name: /^Modern Goodstuff · Modern · \d+ cards/ }),
    ).toBeInTheDocument();
    // The archived deck is not in the fallback — "the ones I touched most recently" is about
    // decks in play, and a shelf of retired lists would crowd out the ones that are not.
    await expect(
      decks.queryByRole("button", { name: /^Old School 93\/94/ }),
    ).not.toBeInTheDocument();
  },
};

/**
 * A reader who has pinned a set, and every deck in it has gone.
 *
 * **Its own sentence, because it is its own situation.** Falling back to the six most recent
 * here would answer a question they did not ask — they chose a set, and every member of it has
 * been deleted. Saying so is what points them at the settings tray.
 */
export const PinnedDecksGone: Story = {
  args: {
    // Two ids no seeded deck carries. The widget drops each in silence and is left with a
    // chosen set holding nothing, which is the branch this story is about.
    widget: { id: "decks", kind: "decks", span: 1, config: { deckIds: [901, 902] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(
      await decks.findByText("The decks pinned here are not in this collection any more."),
    ).toBeInTheDocument();
  },
};

/**
 * A database with no decks in it at all — which is a different sentence again, and points at
 * the page where a deck is made rather than at this widget's own settings.
 */
export const NoDecksYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = within(await canvas.findByRole("region", { name: "Decks" }));
    await expect(
      await decks.findByText("No decks yet — make one on the Decks page and it will show up here."),
    ).toBeInTheDocument();
  },
};

/**
 * Customize on — and this is **the one widget that changes something about itself** when it is.
 *
 * `widgetProps.ts` names the exception at the prop: a reader rearranging the page is not
 * browsing it, and a press that navigated away mid-drag would take the layout they were half way
 * through arranging off the screen. So the tile becomes a preview of itself: the same words, no
 * affordance. The `play` is what pins that — the deck's sentence is still on screen, and it is
 * no longer a button.
 */
export const Customizing: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = within(await canvas.findByRole("region", { name: "Decks" }));

    // The same words the resting tile carries, drawn now as text rather than as a control.
    await expect(await decks.findByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(
      decks.queryByRole("button", { name: /^Modern Goodstuff · Modern/ }),
    ).not.toBeInTheDocument();

    // And the tray is what edit mode adds instead.
    await expect(decks.getByRole("button", { name: "Move Decks" })).toBeInTheDocument();
    await expect(decks.getByRole("button", { name: "Remove Decks" })).toBeInTheDocument();
  },
};

/**
 * The pinning control, opened.
 *
 * The rows are every deck there is, **sorted by the deck's own name** rather than by the row's
 * label — so the `(archived)` suffix a retired deck carries does not file it under A. The
 * trigger says `Most recent` while nothing is pinned, because that is what the widget is
 * actually doing rather than a count of zero.
 *
 * Everything asserted after the press goes through `waitFor` with a seconds-scale timeout: the
 * panel mounts on the click and the rows arrive once `deck_list` answers through the fake.
 */
export const PinningDecks: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const decks = within(await canvas.findByRole("region", { name: "Decks" }));

    await userEvent.click(decks.getByRole("button", { name: "Settings for Decks" }));
    const picker = await waitFor(
      () => decks.getByRole("button", { name: "Decks to pin" }),
      POPOVER_TIMEOUT,
    );
    await expect(picker).toHaveTextContent("Most recent");

    await userEvent.click(picker);
    await waitFor(async () => {
      // Alphabetical by the deck's name: Kenrith, Modern, Old School, Rhystic — and the
      // archived one wears its suffix without being sorted by it.
      await expect(decks.getAllByRole("option").map((row) => row.textContent?.trim())).toEqual([
        expect.stringContaining("Kenrith Two-Drops"),
        expect.stringContaining("Modern Goodstuff"),
        expect.stringContaining("Old School 93/94 (archived)"),
        expect.stringContaining("Rhystic Testbed"),
      ]);
    }, POPOVER_TIMEOUT);
  },
};
