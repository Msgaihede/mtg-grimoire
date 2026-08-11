import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DeckSearchPanel } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";

/**
 * The panel, with the two things the editor owns and hands down.
 *
 * **`add` is `useDeck(deckId).addCard`, mounted here rather than inside the panel** — the shape
 * every control in the editor takes, and for the measured reason the prop's own doc gives: a
 * second observer of `["decks","detail",id]` is an extra `deck_get` every time a deck is opened.
 * So the wrapper is where the hook goes, exactly as `DeckEditor.tsx` is.
 *
 * **`categories` comes off that same hook**, which is new since schema v8 and is the whole
 * simplification: the list this panel offers used to be `moveTargets`, derived from the seeded
 * `format_specs` row, and a story had to hand-copy that derivation or repeat it. A category is
 * not derived from anything — it is a row of the deck the reader owns — so `deck_get` answers
 * the list and both the editor and this wrapper read the same one. Hand-copying it here would
 * be a story asserting against ids the fake's database does not have.
 *
 * `targetCategoryId` is controlled, so the state lives here; **until the reader picks, it is the
 * first category the deck has**, which is the editor's own clamp in miniature — the deck read
 * settles a beat after the first render, and a wrapper holding an id chosen before then would
 * be holding one that names nothing.
 */
function Panel({ deckId, roomy = true }: { deckId: number; roomy?: boolean }) {
  const deck = useDeck(deckId);
  const [picked, setPicked] = useState<number | null>(null);
  const categories = deck.categories;
  return (
    <DeckSearchPanel
      add={deck.addCard}
      categories={categories}
      targetCategoryId={picked ?? categories[0]?.id ?? 0}
      onTargetCategoryChange={setPicked}
      roomy={roomy}
    />
  );
}

const meta = {
  title: "Decks/SearchPanel",
  component: Panel,
  tags: ["autodocs"],
  args: { deckId: 1, roomy: true },
  render: (args) => <Panel key={`${args.deckId}:${args.roomy}`} {...args} />,
  decorators: [
    // The panel is a flex column with `min-h-0`, so it needs a parent with a height or its wall
    // has none — and a flex row, because that is the row it shares with the deck. 384px is the
    // panel's own `w-96`; the 36px beside it is the width its rail collapses to, so both states
    // fit the same box.
    (Story) => (
      <div className="flex h-[640px] w-[420px] justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The path by which cards enter a deck — **not a second search**. It is " +
          "`useCardSearch` + `FilterBar` + `CardGrid`, the search view's own parts, in a 384px " +
          "column beside the deck, with the wall's two slots pointed at this job: the badge " +
          "keeps telling the collection story, and the action becomes **Add to deck**.\n\n" +
          "Driven end to end by `.storybook/fake/`: the wall is `search_cards` over the seeded " +
          "corpus (**36 cards** on the `starter` seed's default browse, measured 2026-08-10 — " +
          "43 printings less the two the fake's `paperOnly` default excludes), and the Add " +
          "button writes through `deck_add_card`.\n\n" +
          "**The category choice sits above the results rather than on each of them.** It is " +
          "the click path's answer to “where does this go”, and therefore the keyboard's — " +
          "which is what makes dragging a shortcut rather than the only way in. The select's " +
          "value is a category **id**, because a category's name is the reader's to change; " +
          "every Add button is named for the card *and* that category's name, because where " +
          "the card is going is the one thing about the press that is not visible on the " +
          "tile.\n\n" +
          "**A fixture of the editor, not a dismissible layer.** Escape pressed in here belongs " +
          "to the card detail pane; the way to put the panel away is the disclosure it names " +
          "itself by ({@link Collapsed}), and the one state where that control refuses is " +
          "{@link NoRoom} — measured width, not a guess.\n\n" +
          "**`Docked` and the plan's `Results` are one state, not two.** This panel has no " +
          "empty-and-docked shape to tell apart from a docked one with results: with the seed " +
          "it is given, docking it *is* showing results. What genuinely differs is why a wall " +
          "can be empty, and those are two stories with two different sentences — " +
          "{@link Empty}, which is a statement about the database, and {@link NoMatch}, which " +
          "is a statement about the filters.\n\n" +
          "**No drag story here.** Every tile is registered as a drag source " +
          "(`cardDraggable` with a `search-card` payload) and the category columns are the " +
          "drop targets, " +
          "but Storybook runs in an ordinary browser with no WRY OLE drop target, while the " +
          'shipped window depends on `"dragDropEnabled": false` in `tauri.conf.json`. A green ' +
          "drag here would prove nothing about the real app; that is the live CDP pass's.",
      },
    },
  },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Open, with the whole corpus in it.
 *
 * The count line is the search view's own `summaryOf`, imported rather than re-written: two
 * copies of these six sentences would be two answers to "why is this list empty", and the one
 * that matters most — an empty database still syncing, which is not a search that missed — is the
 * one a second copy would be likeliest to get wrong.
 *
 * The wall's tile floor is 150px here rather than the standard 170, and that is what makes this
 * column two tiles wide instead of one: 384 is 331 by the time the panel's padding, the
 * scrollbar and the wall's padding are off it, which is 23px short of two standard tiles.
 *
 * The Add button is never disabled while a write is in flight, deliberately: `deck_add_card`
 * **folds into** the row it finds, so pressing three times is three copies, and disabling would
 * drop presses two and three.
 */
export const Docked: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    await expect(within(panel).getByRole("button", { name: "Search cards" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(await within(panel).findByText("36 cards")).toBeInTheDocument();

    // The category is in every Add button's name, and it is the only part of the press a
    // screenshot cannot show: two tiles' buttons both called "Add" are two controls a screen
    // reader cannot tell apart.
    //
    // Read off the select rather than written out, because the list is the **deck's** now
    // rather than a derivation from its format — the fake seeds the categories every deck is
    // born with, and a story that retyped their names would be asserting against the seed
    // instead of against this panel.
    const select = within(panel).getByLabelText("Add to") as HTMLSelectElement;
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    await expect(options.length).toBeGreaterThan(1);
    await expect(select).toHaveValue(options[0].value);
    await expect(
      await within(panel).findByRole("button", {
        name: `Add Ancient Tomb to ${options[0].textContent}`,
      }),
    ).toBeInTheDocument();

    // And the button follows the pick, which is the whole of what the select does.
    await userEvent.selectOptions(select, options[1].value);
    await waitFor(async () => {
      await expect(
        within(panel).getByRole("button", {
          name: `Add Ancient Tomb to ${options[1].textContent}`,
        }),
      ).toBeInTheDocument();
    });
  },
};

/**
 * Put away by the reader, and still saying what it is.
 *
 * The words run down the rail rather than leaving a bare icon to be guessed at, and they are the
 * button's accessible name either way — an `aria-label` would be a second, invisible copy of
 * them, and a name that differs from the visible text is a control voice control cannot reach
 * (WCAG 2.5.3).
 *
 * **One root for both states**, rather than a bare rail in the collapsed one. React reconciles by
 * position, so two shapes would make the disclosure a *different* button either side of a
 * collapse — and the caret handed to the rail when the card pane closes would be dropped again
 * one commit later. That this is the same element is invisible on screen and is what the identity
 * check below is for.
 */
export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const toggle = within(panel).getByRole("button", { name: "Search cards" });
    await expect(await within(panel).findByText("36 cards")).toBeInTheDocument();

    await userEvent.click(toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The same button, not a new one in the same place.
    await expect(within(panel).getByRole("button", { name: "Search cards" })).toBe(toggle);
    // Everything below the rail is gone with it: the filters, the count and the wall.
    await expect(within(panel).queryByText("36 cards")).toBeNull();
    await expect(within(panel).queryByRole("searchbox")).toBeNull();
    await expect(within(panel).queryByLabelText("Add to")).toBeNull();
  },
};

/**
 * No room for the deck and the panel both, so the panel yields — and says why.
 *
 * The narrowest thing gives way first, which is the rule the category columns already follow, one
 * level up. `roomy` is measured against the row the deck and the panel share rather than against
 * the window, because the window's width is three layouts away from it — a 1024px window leaves
 * that row 361px with the card pane open, against 776px without one (`DeckEditor.tsx:66-71`'s
 * measured table). Three docked columns simply do not fit in 1024: the deck was measured at
 * **2px** before this floor existed, which reads as a rendering fault rather than as a squeeze
 * (`DeckEditor.tsx:55-58`).
 *
 * **`aria-disabled` and a press that does nothing, not `disabled`.** A disabled button is out of
 * the tab order, which would leave the reason hanging on a hover a keyboard reader cannot perform
 * — a rail that cannot be activated and never says why. This way the control is reachable, its
 * `title` is its description, and it is somewhere the caret can be put when the card pane closes
 * and the tile that opened it has gone with the panel.
 *
 * The reader's own choice is untouched by this, so the panel comes back the moment the room does.
 */
export const NoRoom: Story = {
  args: { roomy: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const toggle = within(panel).getByRole("button", { name: "Search cards" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await expect(toggle).toHaveAttribute(
      "title",
      "Not enough room — close the card details or widen the window",
    );
    // Reachable, which is the whole point of not using `disabled`.
    await expect(toggle).toBeEnabled();

    // And the press is recorded and does nothing, rather than being swallowed by the browser.
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  },
};

/**
 * A card database that has not been synced yet.
 *
 * "Card database is empty — waiting for the first sync to finish." An **unfiltered** search asks
 * for everything, so an empty answer to it is a statement about the database and not about the
 * query; saying "no cards match" here would blame the reader for a sync that has not finished.
 * The distinction is `summaryOf`'s `unfiltered`, and {@link NoMatch} is the other side of it.
 *
 * The wall is not drawn at all in this state — the status line carries the whole story, and an
 * empty grid under a sentence explaining the emptiness would be a second, wordless copy of it.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    await expect(
      await within(panel).findByText(
        "Card database is empty — waiting for the first sync to finish.",
      ),
    ).toBeInTheDocument();
    await expect(within(panel).queryByRole("group", { name: "Search results" })).toBeNull();
  },
};

/**
 * A search that missed, in the same line and with a different sentence.
 *
 * The corpus is there and the filters are what emptied the list, so the statement is about the
 * filters. One live region for both, mounted for as long as the panel is open: a region that
 * appears together with its text announces nothing, because there was no change to notice.
 */
export const NoMatch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    await expect(await within(panel).findByText("36 cards")).toBeInTheDocument();

    // Addressed by role: the panel's disclosure carries the same name as this field's `sr-only`
    // label, "Search cards".
    await userEvent.type(
      within(panel).getByRole("searchbox", { name: "Search cards" }),
      "brushwagg",
    );

    await waitFor(
      async () => {
        await expect(within(panel).getByText("No cards match these filters.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  },
};

/**
 * A write the database refused, said beside the button that was pressed.
 *
 * `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the wall underneath is untouched and
 * still counting 41.
 *
 * **This refusal is deliberately not in the editor's banner.** That one speaks for the three
 * writes the deck's own controls make, and a refusal reported somewhere else is a refusal the
 * reader has to go looking for — two banners for one press would be worse than one in the wrong
 * place (`DeckEditor.tsx:235-240`).
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    // Matched by prefix, where the click-to-add story above spells the category out.
    //
    // The name's tail is the category the picker is on, which is the deck's **first** in
    // `sortOrder` — the Commander pile, on a v8-seeded deck, not the main deck — and it
    // arrives on the deck read rather than on the search this story is really about. Naming it
    // would make a story about a *refused write* wait on, and fail over, a list it does not
    // care about; `findByRole` with a prefix waits for the button and says nothing about which
    // pile it points at. `ClickToAdd` is where the picker's own contract is pinned.
    await userEvent.click(
      await within(panel).findByRole("button", { name: /^Add Ancient Tomb to / }),
    );

    const alert = await within(panel).findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not add that card — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await expect(within(panel).getByText("36 cards")).toBeInTheDocument();
  },
};
