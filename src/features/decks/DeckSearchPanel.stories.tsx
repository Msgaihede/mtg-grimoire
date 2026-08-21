import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import type { FormatFilterOption } from "@/features/search/useCardSearch";
import { AUTO_CATEGORY } from "./autoCategory";
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
 * **`targetCategoryId` is read-only now, and the wrapper reads it off the deck row** — the
 * `useState` that used to be here went with the select the panel used to draw (2026-08-15). It
 * is `decks.default_category_id`, chosen in the settings dialog, and {@link AUTO_CATEGORY} until
 * somebody chooses: it needs no clamp to a real id and that is the point of it. A wrapper (or an
 * editor) that reached for `categories[0]` instead would hold an id naming nothing until the
 * deck read settled — and once it landed, `categories[0]` on a deck with no user pile of its own
 * is the seeded **Commander** category, which is where every plain add used to go.
 *
 * **`defaultFormat` is an arg here and is deliberately *not* derived from the deck this wrapper
 * already reads.** Deriving it is `DeckEditor`'s job and it carries a fence this panel never
 * sees: a format with no legality data behind it has to arrive as `null`, because `filters.rs`
 * answers an unrecognised legality key with no rows at all and the wall would be empty with
 * nothing on screen to say why. A wrapper deriving it here would be a second, unfenced copy of
 * that rule, agreeing with the editor's until the day one of them changed. {@link DeckFormat}
 * passes the format the deck it is opened on actually has, so the story is not a fiction either.
 */
function Panel({
  deckId,
  roomy = true,
  defaultFormat = null,
  maxWidth,
}: {
  deckId: number;
  roomy?: boolean;
  defaultFormat?: FormatFilterOption | null;
  maxWidth?: number;
}) {
  const deck = useDeck(deckId);
  return (
    <DeckSearchPanel
      add={deck.addCard}
      categories={deck.categories}
      targetCategoryId={deck.deck?.defaultCategoryId ?? AUTO_CATEGORY}
      defaultFormat={defaultFormat}
      roomy={roomy}
      maxWidth={maxWidth}
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
          "corpus (**37 cards** on the `starter` seed's default browse, measured 2026-08-22 — " +
          "52 printings less the two the fake's `paperOnly` default excludes and the four its " +
          "`playableOnly` default does, collapsed to one row per card), and the Add " +
          "button writes through `deck_add_card`.\n\n" +
          "**Where a card goes is a deck setting, and this panel only reads it** " +
          "(2026-08-15). An `Add to` select sat on the header row here until then, backed by a " +
          "`useState` in `DeckEditor` — so a reader who pointed it at their Sideboard lost that " +
          "the moment they closed the deck, and the *other* surface it governed, the toolbar's " +
          "quick-add field, drew no control at all. It is `decks.default_category_id` now, " +
          "asked once in the deck settings dialog beside the format and the folder. What is " +
          "still here is where it shows: **every Add button is named for the card *and* the " +
          "pile it will land in**, because where the card is going is the one thing about the " +
          "press that is not visible on the tile.\n\n" +
          "**The format filter opens on the open deck's format** ({@link DeckFormat}), because " +
          "a deck is built out of what is legal in it. It is a *default* and not a " +
          "constraint — the select is live, `Any format` stays in it under the wider " +
          "`Any card`, and a card the " +
          "format does not allow is the validation panel's `RULE BREAK` to draw rather than " +
          "something this search hides.\n\n" +
          "**A fixture of the editor, not a dismissible layer.** Escape pressed in here belongs " +
          "to the card detail pane; the way to put the panel away — and the way to get it out " +
          "in the first place — is the disclosure it names itself by ({@link Collapsed}), and " +
          "the one state where that control refuses is {@link NoRoom} — measured width, not a " +
          "guess.\n\n" +
          "**It opens collapsed** (2026-08-14), which is why every play below presses that " +
          "disclosure before it looks at anything. 384px plus the desk's 16px gap out of a row " +
          "measured at **602px** at 1280×800 with the card pane docked leaves the deck 202px — " +
          "one stack column — so open by default every reader paid for the wall on every deck " +
          "they opened whether or not they were adding cards. The choice is this component's " +
          "`useState` and deliberately not a `useAppStore` field: it is per editor-open and not " +
          "remembered.\n\n" +
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
 * Opened by a press, with the whole corpus in it — the panel itself starts collapsed.
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
    const toggle = within(panel).getByRole("button", { name: "Search cards" });
    // Collapsed at rest, so the wall arrives on a press. {@link Collapsed} is where that
    // default is the subject rather than the setup.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();

    // The pile is in every Add button's name, and it is the only part of the press a
    // screenshot cannot show: two tiles' buttons both called "Add" are two controls a screen
    // reader cannot tell apart.
    //
    // **This deck is on `AUTO_CATEGORY`**, which the seed leaves every deck on — so the name on
    // the button is the pile *this card* earns rather than one pile for the whole wall. Ancient
    // Tomb is a Land, and it is written out here because that is the claim: the button promises
    // the pile before the press, and it can only do that because `autoCategoryFor` is a pure
    // function of the card.
    //
    // **And there is no control here to change it.** The select this play used to drive is in
    // the settings dialog, whose own story is where a pick is made; what this asserts instead is
    // that nothing was left behind on the row when it moved.
    await expect(within(panel).queryByLabelText("Add to")).toBeNull();
    await expect(
      await within(panel).findByRole("button", { name: "Add Ancient Tomb to Land" }),
    ).toBeInTheDocument();
  },
};

/**
 * Opened on the format of the deck being edited.
 *
 * Deck 1 is **Modern Goodstuff**, so the filter row's Format select starts on Modern and the
 * wall beside the deck is cards that deck may legally hold rather than the whole corpus. A deck
 * is built out of what is legal in it, which is where a search run from inside it should start;
 * {@link Docked} above is the same panel with no deck format behind it, and is what every other
 * surface mounting this search gets.
 *
 * **A default and not a constraint**, which is the half worth driving. The select is live: the
 * reader may move it to any format including one this deck is not legal in, and `Any format` is
 * one press from the whole database again. A card the deck's format does not allow is
 * `validation/engine.ts`'s `RULE BREAK` to draw once the card is in the deck — a search that
 * would not show it in the first place would be this panel enforcing a rule it does not own, and
 * would make a deliberate trip out of the format (a sideboard, a proxy, a deck about to be
 * re-formatted) impossible rather than merely marked.
 */
export const DeckFormat: Story = {
  args: { defaultFormat: { value: "modern", label: "Modern" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    // Opened first, because the panel comes up collapsed (2026-08-14) and the filter row is
    // inside `OpenPanel` — there is no Format select to read until the disclosure is pressed.
    // Which is also what makes the assertions below the interesting ones rather than trivial:
    // the seed is applied when the search mounts, and the search mounts on this press, so this
    // is the deck's format arriving at the moment the reader asks for the wall.
    await userEvent.click(within(panel).getByRole("button", { name: "Search cards" }));
    const format = (await within(panel).findByLabelText("Format")) as HTMLSelectElement;

    // The value is what the request carries; the option's own text is the whole of what the
    // reader can see. A select holding a key none of its options carries reports the first one
    // instead — `Any card`, the widest row there is since the `Unplayable` chip was merged into
    // this list — so `value` reads back `"any-card"` and the line below catches it, while only
    // the line after that says which word the reader is actually looking at.
    await expect(format).toHaveValue("modern");
    await expect(format.selectedOptions[0]).toHaveTextContent("Modern");

    // Moved to a format this deck is not in, which is the thing that has to keep working.
    await userEvent.selectOptions(format, "legacy");
    await expect(format).toHaveValue("legacy");

    // And all the way back out. `Any format` is pinned above the sorted list and is never
    // greyed, so the way to the whole corpus is one press from wherever the reader has got to —
    // which is what makes the deck's format a starting point rather than a pen.
    await userEvent.selectOptions(format, "");
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();
  },
};

/**
 * The state a deck opens in — and the state the reader puts it back into — still saying what it
 * is.
 *
 * **Collapsed is the default now** (2026-08-14), so this is the panel at rest rather than a panel
 * somebody shut. The deck gets the whole desk until the reader wants the wall, and one press on
 * the rail is what fetches it back.
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
 * check below is for: the round trip out and back is what asks the question, which is why this
 * play opens the panel it is named after.
 */
export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const toggle = within(panel).getByRole("button", { name: "Search cards" });
    // At rest, before anything is pressed.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();

    await userEvent.click(toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The same button, not a new one in the same place — across both presses.
    await expect(within(panel).getByRole("button", { name: "Search cards" })).toBe(toggle);
    // Everything below the rail is gone with it: the filters, the count and the wall.
    await expect(within(panel).queryByText("37 cards")).toBeNull();
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
 * that row 361px with the card pane open, against 776px without one (the measured table on
 * `DeckEditor`'s `DECK_FLOOR`). Three docked columns simply do not fit in 1024: the deck was
 * measured at **2px** before that floor existed, which reads as a rendering fault rather than as
 * a squeeze.
 *
 * **`aria-disabled` and a press that does nothing, not `disabled`.** A disabled button is out of
 * the tab order, which would leave the reason hanging on a hover a keyboard reader cannot perform
 * — a rail that cannot be activated and never says why. This way the control is reachable, its
 * `useTooltip()` hint is its description, and it is somewhere the caret can be put when the card
 * pane closes and the tile that opened it has gone with the panel.
 *
 * The reader's own choice is untouched by this, so a panel they had opened comes back the moment
 * the room does — **and comes back as they left it**. `roomy` decides what is *drawn* and the
 * reader decides what they *want*: a panel that was already open is hidden (`display: none`)
 * rather than unmounted, so the typed query, the filters and the facets are all still there when
 * the width returns. A panel nobody has opened is still mounted-as-nothing, which is what keeps
 * this state free. Untouched includes untouched by the press above — a refusal that quietly
 * flipped the reader's choice would answer somebody who never operated the control.
 *
 * This story is the never-opened arm, because `roomy` is an arg and the wrapper is keyed on it:
 * a *railing* is a prop moving under a live panel, which is a re-render rather than a remount,
 * and it is pinned in `DeckSearchPanel.test.tsx` ("keeps the reader's query and filters across a
 * railing").
 */
export const NoRoom: Story = {
  args: { roomy: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const toggle = within(panel).getByRole("button", { name: "Search cards" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    // Reachable, which is the whole point of not using `disabled`.
    await expect(toggle).toBeEnabled();

    // The reason is a hover away — a description of an already-named control, so it is
    // `describes: true` by default and the panel carries `role="tooltip"`.
    await userEvent.hover(toggle);
    await waitFor(
      async () =>
        expect(await canvas.findByRole("tooltip")).toHaveTextContent(
          "Not enough room — close the card details or widen the window",
        ),
      { timeout: TOOLTIP_OPEN_MS + 1000 },
    );
    await userEvent.unhover(toggle);

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
    await userEvent.click(within(panel).getByRole("button", { name: "Search cards" }));
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
    await userEvent.click(within(panel).getByRole("button", { name: "Search cards" }));
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();

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
 * The fake's `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of every
 * write handler and by no read handler — which is why the wall underneath is untouched and still
 * counting the 33 the play asserts.
 *
 * **This refusal is deliberately not in the editor's banner.** That one speaks for the writes the
 * deck's own controls make (`DeckEditor`'s `newestWrite`), and a refusal reported somewhere else
 * is a refusal the reader has to go looking for — two banners for one press would be worse than
 * one in the wrong place.
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    await userEvent.click(within(panel).getByRole("button", { name: "Search cards" }));
    // Matched by prefix, where the click-to-add story above spells the category out.
    //
    // The name's tail is the category the picker is on, which is the deck's **first** in
    // `sortOrder` — the Commander pile, on a v8-seeded deck, not the main deck — and it
    // arrives on the deck read rather than on the search this story is really about. Naming it
    // would make a story about a *refused write* wait on, and fail over, a list it does not
    // care about; `findByRole` with a prefix waits for the button and says nothing about which
    // pile it points at. {@link Docked} is where the picker's own contract is pinned.
    await userEvent.click(
      await within(panel).findByRole("button", { name: /^Add Ancient Tomb to / }),
    );

    const alert = await within(panel).findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not add that card — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await expect(within(panel).getByText("37 cards")).toBeInTheDocument();
  },
};

/**
 * The column's left edge, as something to pull on.
 *
 * The panel opens at its 384px default and the reader drags the hairline to trade width with the
 * deck beside it — which is the answer to the other half of the same complaint the zoom fixes.
 * `CardGrid` sizes a tile from the reader's zoom and fits however many of that size the wall
 * holds, so at 2× a 384px column draws **one** 300px card; the way to see two is to zoom back
 * down *or* to widen the column, and this is the second of those.
 *
 * **Hover the edge to see the grip.** At rest it is the hairline the panel already had — the one
 * piece of chrome it adds — because a permanent handle down a border this app spent care making
 * quiet would be a second line saying the same thing. The cursor is `col-resize` across a 9px
 * strip that straddles the border, 4px of it out in the desk's own gap.
 *
 * `maxWidth` is the editor's answer and is hard-coded here at 620 — in the app it is
 * `min(half the window, what the desk can spare over DECK_FLOOR)`, and a story has neither a desk
 * nor a window to derive it from. The box is 700px wide so there is somewhere to drag *to*; every
 * other story on this page uses the 420px box the panel's default width fits exactly.
 *
 * **The drag itself is not asserted here and the play does not attempt it.** jsdom ships no
 * `PointerEvent`, so a `userEvent.pointer` on this handle carries no `clientX` and the resize
 * reads `undefined` — `DeckSearchPanel.test.tsx` drives it with a hand-built `MouseEvent` for
 * exactly that reason, and what *this* story pins is the part a play can honestly settle: the
 * separator is there, it is a tab stop, and it reports the range the editor gave it.
 */
export const Resizable: Story = {
  args: { maxWidth: 620 },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[700px] justify-end">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Search cards" }));

    const handle = canvas.getByRole("separator", { name: "Resize card search" });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuenow", "384");
    await expect(handle).toHaveAttribute("aria-valuemin", "206");
    await expect(handle).toHaveAttribute("aria-valuemax", "620");
    // A caret can reach it, which is the half of this a pointer-only handle would have lost:
    // there is no other control anywhere that sets this width.
    await expect(handle).toHaveAttribute("tabindex", "0");
  },
};
