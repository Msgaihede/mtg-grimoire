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
  /*
   * **`useAddMode` was mounted here for `add`'s reason and is gone with the own/need pair**
   * (2026-08-25). The answer was the editor's, because it governed the toolbar's quick-add field
   * as well as the panel's Add button, so this wrapper held it while standing in for the editor.
   * Every add from this panel means "I need this" now; putting a copy the reader owns into a deck
   * is the Collection tab's `collection_to_deck`.
   */
  return (
    <DeckSearchPanel
      add={deck.addCard}
      categories={deck.categories}
      deckId={deckId}
      targetCategoryId={deck.deck?.defaultCategoryId ?? AUTO_CATEGORY}
      defaultFormat={defaultFormat}
      roomy={roomy}
      maxWidth={maxWidth}
    />
  );
}

/**
 * Move the panel to the card search.
 *
 * **Every play that wants a wall of printings presses this first, and none of them used to**
 * (2026-08-23): this column offers two searches now and opens on the reader's own collection, so
 * a play reaching straight for `37 cards` would be asking about a body that is not mounted.
 *
 * A named helper rather than the press inlined thirty times, for `openPanel`'s reason in
 * `DeckSearchPanel.test.tsx`: "this story needs the wall" is what these call sites mean, and the
 * day the default tab moves again it is one function that changes.
 */
async function showAllCards(panel: HTMLElement) {
  await userEvent.click(within(panel).getByRole("button", { name: "All cards" }));
}

/**
 * The panel's disclosure — **a pattern, because its name says what pressing it does** and
 * therefore changes with the state: `Collapse card search` open, `Expand card search` collapsed.
 * It was the literal `Search cards` until 2026-08-25, when the words became a heading beside the
 * button and the control became a bare chevron. The `$` anchor keeps it off the drag handle's
 * `Resize card search`.
 */
const PANEL_TOGGLE = /card search$/;

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
          "The path by which cards enter a deck, and since 2026-08-23 it offers **two** searches — " +
          "a tab strip on its header row, opening on **Collection**, with the card search this " +
          "panel has always been beside it as **All cards**. Every story below that wants a wall " +
          "of printings presses that second tab first.\n\n" +
          "**The Collection tab is `CollectionSearchTab`, storied on its own page** " +
          "(`Decks/CollectionSearchTab`), and it is a different kind of answer rather than the " +
          "same wall over different rows: collection *rows*, one per printing, finish and " +
          "condition, each saying where that copy is filed, and an Add that calls " +
          "`collection_to_deck` — the write that physically moves a card into this deck's group. " +
          "{@link Tabs} is where the two bodies are the subject here.\n\n" +
          "The card search itself is **not a second search**. It is " +
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
          "**A fixture of the editor, not a dismissible layer.** This panel registers no Escape " +
          "rung, so a press in here falls past it — to whatever card or dialog is open over the " +
          "desk, and otherwise to the editor's own floor, which closes the deck. The way to put " +
          "the panel away — and the way to get it out " +
          "in the first place — is the disclosure it names itself by ({@link Collapsed}), and " +
          "the one state where that control refuses is {@link NoRoom} — measured width, not a " +
          "guess.\n\n" +
          "**It opens open again** (issue #183, 2026-08-22), and remembers which way the reader " +
          "last left it — `app_meta.deck_search_open` behind `useDeckSearchOpen`, written on the " +
          "**press** and never on the drawn state. It opened collapsed for eight days on a width " +
          "argument that has since gone: 384px plus the desk's 16px gap out of a row measured at " +
          "**602px** at 1280×800 *with the card pane docked beside the editor* left the deck " +
          "202px, and the card is a centred modal since 2026-09-03 and takes width from " +
          "neither column. " +
          "{@link Collapsed} is where the other state is the subject rather than the setup.\n\n" +
          "**Which tab is remembered too, and only for the session** — the query cache under " +
          "`DECK_SEARCH_TAB_KEY`, which is app-scoped, so it survives the remount that opening a " +
          "second deck is. There is no `app_meta` row behind it: `SCHEMA_VERSION` did not move " +
          "for this change.\n\n" +
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
 * The panel at rest, with the whole corpus in it.
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
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });
    // Open at rest, so the strip is simply there (issue #183). {@link Collapsed} is where the
    // other state is the subject rather than the setup, and {@link Tabs} is where the tab the
    // panel opens on is the subject rather than a press to get past.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await showAllCards(panel);
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
 * The two searches this column offers, and the one it opens on.
 *
 * **Collection first** (spec §7.2): a deck is built out of cards you have, so the reader's own
 * binder is the resting state and the wider search — every printing Scryfall has published — is
 * one press away. That reverses what this panel did until 2026-08-23, when the collection could
 * not be searched from a deck at all.
 *
 * **`aria-pressed` over a `.map`, not `role="tab"`.** The role is a contract rather than a name:
 * roving focus on the arrow keys, `aria-controls`, a `tabpanel` that takes the caret. Nothing else
 * in this app implements it — `DeckEditor`'s Theory/Actual switch, `FilterChips`' layout pair and
 * the card pane's toggles are all pressed buttons — so a `tab` role here would announce a contract
 * this control does not honour. Two buttons, one pressed, which is why every query in every play
 * on this page reaches for `role="button"`.
 *
 * **Each tab's body is its own component**, so only the one being read is mounted and only its
 * hook runs — `OpenPanel`'s reason one level in. Switching therefore throws the other tab's
 * search away, exactly as a collapse does.
 */
export const Tabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const strip = within(panel).getByRole("group", { name: "Search in" });
    const collection = within(strip).getByRole("button", { name: "Collection" });
    const cards = within(strip).getByRole("button", { name: "All cards" });

    // At rest, with nothing pressed.
    await expect(collection).toHaveAttribute("aria-pressed", "true");
    await expect(cards).toHaveAttribute("aria-pressed", "false");
    // The card search is not merely hidden — it is not mounted, so its wall and its filter row
    // are both absent rather than empty. **Both boxes are `type="search"` now** (2026-08-23), so
    // the query is by name: an unnamed `queryByRole("searchbox")` was null while the collection
    // tab was a placeholder sentence and would find that tab's own box today.
    await expect(within(panel).queryByRole("searchbox", { name: "Search cards" })).toBeNull();
    await expect(
      within(panel).getByRole("searchbox", { name: "Search your collection" }),
    ).toBeInTheDocument();

    await userEvent.click(cards);

    await expect(cards).toHaveAttribute("aria-pressed", "true");
    await expect(collection).toHaveAttribute("aria-pressed", "false");
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();
    // And the collection body went with the press, rather than being hidden under the wall.
    await expect(
      within(panel).queryByRole("searchbox", { name: "Search your collection" }),
    ).toBeNull();

    // And back, which is what says the strip switches a body rather than only marking itself.
    await userEvent.click(collection);
    await expect(within(panel).queryByText("37 cards")).toBeNull();
    await expect(within(panel).queryByRole("searchbox", { name: "Search cards" })).toBeNull();
  },
};

/**
 * The panel at the narrowest it goes — **the width it has to survive, and the one nobody
 * designs at**.
 *
 * `MIN_PANEL_WIDTH_PX` is 206, measured from one 150px card and the chrome around it, and a reader
 * drags the column there. Its content box is **193px**, and the one thing this width forbids is an
 * *overhang*: a flex item cannot shrink below its own min-content, and `DeckEditor`'s page section
 * is `overflow-y-auto`, which computes `overflow-x` to `auto` — so a control that will not fit
 * puts a horizontal scrollbar across the whole deck builder. `ManaValueChips` shipped exactly that
 * once.
 *
 * **Three controls shared the header row and now two things do, neither of which can overhang.**
 * Driven headless over the built stylesheet on 2026-08-23, when the row held a 99px disclosure,
 * the 141px tab strip and the 175px own/need pair, each on a line of its own inside 193 — 100px
 * tall, against 62 with the strip alone. The strip became a full-width bar of its own on
 * 2026-08-24 and the pair was deleted on 2026-08-25, so what is left on the row is a 28px chevron
 * and a heading that truncates. **The tabs are still two short words**, and that measurement is
 * the reason: at "Collection Search" / "Normal Search" the strip read `scrollWidth` **216** against
 * a `clientWidth` of 193 — the overhang, in the label text — and two `flex-1` halves of 193 give
 * each label 96px to fit in.
 *
 * The play reads both states, because the card-search tab is the one with a filter row under it.
 * **Heights have not been re-driven since the row lost two controls**; the widths above are
 * per-control and did not move.
 *
 * `maxWidth` is the editor's cap and is what pins the panel here; in the app it is
 * `min(half the window, what the desk can spare over DECK_FLOOR)`.
 */
export const Narrow: Story = {
  args: { maxWidth: 206 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards" });
    const strip = within(panel).getByRole("group", { name: "Search in" });
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });

    // Both controls are drawn and both are reachable — the layout is an answer about width, never
    // a control being dropped.
    await expect(strip).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(within(strip).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Nothing overhangs. Storybook runs in a real browser, so unlike the suite this can be read
    // off the box rather than off the class — the header row, the tab bar and the panel itself.
    const row = toggle.parentElement!;
    await expect(row.scrollWidth).toBe(row.clientWidth);
    await expect(strip.scrollWidth).toBe(strip.clientWidth);
    await expect(panel.scrollWidth).toBe(panel.clientWidth);

    // And again on the tab that draws a filter row under all of it, which is the state this width
    // is most likely to break in.
    await showAllCards(panel);
    await expect(panel.scrollWidth).toBe(panel.clientWidth);
    await expect(strip.scrollWidth).toBe(strip.clientWidth);
  },
};

/**
 * Opened on the format of the deck being edited.
 *
 * Deck 1 is **Modern Goodstuff**, so the filter row's Format picker starts on Modern and the
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
    // The filter row lives in `OpenPanel`, which the **tab** mounts: the disclosure is open at
    // rest again (issue #183) but the panel opens on the collection, so the seed is applied when
    // the card search itself arrives. `findBy`, not `getBy`: it still has a round trip to make.
    await showAllCards(panel);
    // …and then the filter row's own tray, which is where Format has lived since the row was
    // redesigned. Three presses to a dropdown is a lot to write down, and each is a real thing a
    // reader does: open the column, choose the card search, open the filters.
    await userEvent.click(await within(panel).findByRole("button", { name: /^Show filters/ }));
    const format = await within(panel).findByRole("button", { name: "Format" });

    // The trigger's own text is the whole of what the reader can see — a `<Dropdown>` given a
    // value none of its options carries falls back to its own placeholder dash rather than to a
    // picked row's label (`DEFAULT_PLACEHOLDER`, `Dropdown.tsx`), which is what a stale seed
    // would read as here.
    await expect(format).toHaveTextContent("Modern");

    // Moved to a format this deck is not in, which is the thing that has to keep working.
    await userEvent.click(format);
    await userEvent.click(await within(panel).findByRole("option", { name: "Legacy" }));
    await expect(format).toHaveTextContent("Legacy");

    // And all the way back out. `Any format` is pinned above the sorted list and is never
    // greyed, so the way to the whole corpus is one press from wherever the reader has got to —
    // which is what makes the deck's format a starting point rather than a pen.
    await userEvent.click(format);
    await userEvent.click(await within(panel).findByRole("option", { name: "Any format" }));
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();
  },
};

/**
 * The state a deck opens in — and the state the reader puts it back into — still saying what it
 * is.
 *
 * **A press away rather than the resting state** (issue #183, 2026-08-22): the panel opens open,
 * and this is what the reader gets when they say they are done with the wall. The deck then has
 * the whole desk, and one press on the rail fetches the search back exactly as they left it.
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
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });
    // At rest, before anything is pressed — open, and one tab press from the wall.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await showAllCards(panel);
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();

    // Shut, which is what this story is named for, and then open again: the round trip out and
    // back is what asks the identity question below.
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    // Straight back to the wall with no second tab press: the tab is the app's answer rather than
    // this panel's, so a collapse cannot take it away.
    await expect(await within(panel).findByText("37 cards")).toBeInTheDocument();
    await userEvent.click(toggle);

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The same button, not a new one in the same place — across both presses.
    await expect(within(panel).getByRole("button", { name: PANEL_TOGGLE })).toBe(toggle);
    // Everything below the rail is gone with it: the tab strip, the filters, the count and the
    // wall.
    await expect(within(panel).queryByRole("group", { name: "Search in" })).toBeNull();
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
    const toggle = within(panel).getByRole("button", { name: PANEL_TOGGLE });
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
    await showAllCards(panel);
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
    await showAllCards(panel);
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
    await showAllCards(panel);
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
    const handle = await canvas.findByRole("separator", { name: "Resize card search" });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuenow", "384");
    await expect(handle).toHaveAttribute("aria-valuemin", "206");
    await expect(handle).toHaveAttribute("aria-valuemax", "620");
    // A caret can reach it, which is the half of this a pointer-only handle would have lost:
    // there is no other control anywhere that sets this width.
    await expect(handle).toHaveAttribute("tabindex", "0");
  },
};
