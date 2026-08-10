import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { DeckZone } from "@/lib/ipc";
import { DeckSearchPanel } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";

/**
 * The panel, with the two things the editor owns and hands down.
 *
 * **`add` is `useDeck(deckId).addCard`, mounted here rather than inside the panel** — the shape
 * every control in the editor takes, and for the measured reason the prop's own doc gives: a
 * second observer of `["decks","detail",id]` is an extra `deck_get` every time a deck is opened.
 * So the wrapper is where the hook goes, exactly as `DeckEditor.tsx:842` is.
 *
 * **`zones` is a literal and is not derived here.** It is the editor's `moveTargets` for the
 * seeded Modern deck — `main`, `side`, `companion`, then the scratchpad — which
 * `DeckEditor.tsx:266-274` computes from the seeded format spec: Modern's `sideboardMax` is 15 so
 * the sideboard is offered, `allowsCompanion` is true so the companion is, `requiresCommander` is
 * false and the zone is empty so the command zone is not. Re-deriving it in this file would be
 * the second derivation the panel's own interface doc exists to forbid.
 *
 * `targetZone` is controlled, so the state lives here; the meta keys its render on the story's
 * arguments, so changing one in Controls remounts rather than leaving a stale zone behind.
 */
function Panel({
  deckId,
  zones,
  roomy = true,
}: {
  deckId: number;
  zones: readonly DeckZone[];
  roomy?: boolean;
}) {
  const deck = useDeck(deckId);
  const [targetZone, setTargetZone] = useState<DeckZone>("main");
  return (
    <DeckSearchPanel
      add={deck.addCard}
      zones={zones}
      targetZone={targetZone}
      onTargetZoneChange={setTargetZone}
      roomy={roomy}
    />
  );
}

const meta = {
  title: "Decks/SearchPanel",
  component: Panel,
  tags: ["autodocs"],
  args: { deckId: 1, zones: ["main", "side", "companion", "maybe"], roomy: true },
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
          "column beside the zones, with the wall's two slots pointed at this job: the badge " +
          "keeps telling the collection story, and the action becomes **Add to deck**.\n\n" +
          "Driven end to end by `.storybook/fake/`: the wall is `search_cards` over the seeded " +
          "corpus (**41 cards** on the `starter` seed's default browse, measured 2026-08-10 — " +
          "43 printings less the two the fake's `paperOnly` default excludes), and the Add " +
          "button writes through `deck_add_card`.\n\n" +
          "**The zone choice sits above the results rather than on each of them.** It is the " +
          "click path's answer to “where does this go”, and therefore the keyboard's — which " +
          "is what makes dragging a shortcut rather than the only way in. Every Add button is " +
          "named for the card *and* the zone, because the zone is the one thing about that " +
          "press that is not visible on the tile.\n\n" +
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
          "(`cardDraggable` with a `search-card` payload) and the zones are the drop targets, " +
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
    await expect(await within(panel).findByText("41 cards")).toBeInTheDocument();

    // The zone is in every Add button's name, and it is the only part of the press a screenshot
    // cannot show: two tiles' buttons both called "Add" are two controls a screen reader cannot
    // tell apart.
    const zone = within(panel).getByLabelText("Add to");
    await expect(zone).toHaveValue("main");
    await expect(
      await within(panel).findByRole("button", { name: "Add Ancient Tomb to Main deck" }),
    ).toBeInTheDocument();

    // Four options, in the editor's own order, with the scratchpad last — and no Commander,
    // because a Modern deck is never offered one.
    const options = within(zone as HTMLSelectElement).getAllByRole("option");
    await expect(options.map((o) => o.textContent)).toEqual([
      "Main deck",
      "Sideboard",
      "Companion",
      "Maybe",
    ]);

    await userEvent.selectOptions(zone, "side");
    await waitFor(async () => {
      await expect(
        within(panel).getByRole("button", { name: "Add Ancient Tomb to Sideboard" }),
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
    await expect(await within(panel).findByText("41 cards")).toBeInTheDocument();

    await userEvent.click(toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The same button, not a new one in the same place.
    await expect(within(panel).getByRole("button", { name: "Search cards" })).toBe(toggle);
    // Everything below the rail is gone with it: the filters, the count and the wall.
    await expect(within(panel).queryByText("41 cards")).toBeNull();
    await expect(within(panel).queryByRole("searchbox")).toBeNull();
    await expect(within(panel).queryByLabelText("Add to")).toBeNull();
  },
};

/**
 * No room for the deck and the panel both, so the panel yields — and says why.
 *
 * The narrowest thing gives way first, which is the rule the zone columns already follow, one
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
    await expect(await within(panel).findByText("41 cards")).toBeInTheDocument();

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
 * place (`DeckEditor.tsx:220-224`).
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Add Ancient Tomb to Main deck" }),
    );

    const alert = await within(panel).findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not add that card — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await expect(within(panel).getByText("41 cards")).toBeInTheDocument();
  },
};
