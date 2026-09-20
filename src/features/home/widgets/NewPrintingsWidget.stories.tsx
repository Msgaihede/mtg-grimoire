import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { NewPrintingsWidget, NewPrintingsWidgetSettings } from "./NewPrintingsWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits on a freshly opened settings popover. A plain `const`, because CSF
 *  indexes every non-default export as a story. */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/** A `newPrintings` widget at a footprint, with a config. */
function printings(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "newPrintings", kind: "newPrintings", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell.
 *
 * `extraSettings` is wired the way `HomePage` wires it, so the settings popover is the shipped one
 * down to this kind's own two pickers rather than the registry rows alone.
 */
function Framed({ widget, editing = false }: { widget: HomeWidget; editing?: boolean }) {
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
          editing={editing}
          onConfig={onConfig}
          onRemove={fn()}
          extraSettings={<NewPrintingsWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <NewPrintingsWidget
            widget={widget}
            fit={fit}
            editing={editing}
            still={false}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/NewPrintingsWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The catalogue's own footprint for this kind: three cells by three, and no config at all —
    // `All decks`, the registry's 90-day window and English, which is where every reader starts.
    widget: printings(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Reprints of cards the reader's watched decks already hold, newest first, **in day " +
          "groups**. The heading is `ActivityWidget`'s — a dim date, a rule and a count — because " +
          "*these things happened together* already means that on this page, and a reprint feed " +
          "is the same sentence about a different noun. Rows flow into the card's columns " +
          "*inside* a group and never across one, and a group with no whole row left is dropped " +
          "rather than drawn as a header over nothing.\n\n" +
          "**Three empty sentences, never one.** *No decks are being watched* points at the " +
          "card's own settings; *nothing has been reprinted in this window* is a comparison that " +
          "was made and came back empty; a refusal is read before either, because a failed read " +
          "has no rows and calling that *nothing was reprinted* tells a reader with six decks " +
          "that the game has stopped printing cards. `decksWatched` travels beside the list " +
          "precisely so a count of zero printings never has to guess between the first two.\n\n" +
          "**`Languages` is the one setting that changes how many rows a reprint is.** " +
          "`cards.id` is one printing *in one language*, so a set that shipped in ten is ten rows " +
          "of one reprint — and the row carries its code at **every** tier, the two-cell tile " +
          "included, whenever the answer is not English alone. Without it those ten rows all read " +
          "`Sol Ring · SLD · 3 decks` and the list looks broken rather than complete. The code is " +
          "read off the *resolved* list rather than off the pick, so a `Chosen…` narrowed down to " +
          "English alone draws none: there would be nothing for it to tell apart.\n\n" +
          "**Two of the three switches start off.** A virtual deck is a pile the reader does not " +
          "own and a basic land is reprinted in every set, so both are subjects to be asked for " +
          "rather than face to be hidden; `Theory cards` keeps the shipped default, because a " +
          "theory card is one the reader intends to own and so is exactly the reader who wants to " +
          "know it was reprinted. The footer states `basics hidden` whichever way round it is, " +
          "and the other two only where they differ from their default.\n\n" +
          "**There is deliberately no `Every language` story, and the absence is a decision.** " +
          "The corpus holds exactly one card in a second language — Lightning Bolt, `sta 105`, " +
          "Japanese — and it was printed on 2021-04-23, outside the 365-day maximum this feed " +
          "will answer. So an empty `langs` and a `langs` of `en` alone return the same rows " +
          "here, and the story could not fail. The rule is proven in " +
          "`.storybook/fake/db.test.ts` and in this widget's own suite instead.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The catalogue's footprint on the registry's defaults: one day group, one row.
 *
 * The seed's four decks hold one card reprinted inside 90 days — Swords to Plowshares in `msc`,
 * on 26 June — so the card draws a single dated section with a single printing under it. The
 * `play` asserts the row's **written** name, because the row's flex children would otherwise
 * compute to a name with the words run together, and because the two marks that are pictures on
 * screen — the rarity gem and the unseen dot — are only said there.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await expect(await card.findByRole("heading", { name: /^Friday 26 June/ })).toBeInTheDocument();
    await expect(
      await card.findByRole("button", {
        name: "Swords to Plowshares · MSC · Marvel Super Heroes Commander · uncommon · 1 deck · not seen yet",
      }),
    ).toBeInTheDocument();
    await expect(
      card.getByText("4 decks watched · 90 days · English · basics hidden"),
    ).toBeInTheDocument();
  },
};

/**
 * A band on a year's window: three list columns, the set's *name* under each row, and the whole
 * footer sentence.
 *
 * The chip beside the title is the `Window` pick's own label, which is what `chip: "window"` in
 * the registry buys — a glance at the card says what it is a year of without opening anything.
 * The caption's second word is the printing's own **treatment** and not the spec's frame effect:
 * `NewPrinting` carries `promo_types` and not `frame_effects`, so `Surge Foil` is what a wide row
 * can honestly add about that cardboard.
 */
export const Band: Story = {
  args: { widget: printings(6, 4, { window: 365 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await expect(await card.findByText("A year")).toBeInTheDocument();
    await expect(
      await card.findByText("Marvel Super Heroes Commander · Surge Foil"),
    ).toBeInTheDocument();
    await expect(card.getByText("Secret Lair Drop")).toBeInTheDocument();
    await expect(
      card.getByText("4 decks watched · 365 days · English · basics hidden"),
    ).toBeInTheDocument();
  },
};

/**
 * A tall card, where the furniture the smaller tiers cannot afford is drawn.
 *
 * The two printings a year's window reaches are seven months apart, so the month turns once
 * between them and a **month rule** is drawn where it does — set in the display face, which is the
 * whole of what tells a *when* from a *what happened here*. The seed's cursor falls between those
 * two days, so the `Seen already` boundary lands on the same index and both rules are budgeted
 * before either is drawn.
 *
 * And because the read answered fewer rows than it asked for and every one of them is on screen,
 * the list **closes** rather than trailing off: a list still scrolling has not run out of window,
 * it has run out of card.
 */
export const Tall: Story = {
  args: { widget: printings(4, 12, { window: 365 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await expect(await card.findByText("December 2025")).toBeInTheDocument();
    await expect(card.getByText("Seen already")).toBeInTheDocument();
    await expect(
      card.getByText(/^Nothing older than 1 December in this window\.$/),
    ).toBeInTheDocument();
  },
};

/**
 * A database with no decks in it at all — the first of the three sentences, and the one a count of
 * zero printings would get wrong.
 *
 * It points at the control rather than carrying a press of its own: the settings popover is
 * `WidgetCard`'s state and reaches no body, which is `DecksWidget.NOTHING_PINNED`'s answer to the
 * same question. The `play` asserts the *other* sentence is absent, because telling this reader
 * that nothing was reprinted is a claim about a comparison nobody made.
 */
export const NoDecks: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await expect(await card.findByText(/^No decks are being watched/)).toBeInTheDocument();
    await expect(card.queryByText(/has been reprinted in the last/)).not.toBeInTheDocument();
  },
};

/**
 * Four decks watched, thirty days asked about, and nothing in them reprinted — the second
 * sentence.
 *
 * The same seed answers one row at ninety days and two at a year, so this is the window talking
 * and not the collection. It names both numbers the reader can act on, and the `play` asserts the
 * no-decks sentence is *not* the one drawn: these two are the pair a single count of zero cannot
 * tell apart.
 */
export const NothingReprinted: Story = {
  args: { widget: printings(3, 3, { window: 30 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await expect(
      await card.findByText(
        "Nothing in the 4 decks you watch has been reprinted in the last 30 days. New printings arrive with each card data sync.",
      ),
    ).toBeInTheDocument();
    await expect(card.queryByText(/^No decks are being watched/)).not.toBeInTheDocument();
  },
};

/**
 * Customize on and the settings popover opened, with both picks on `Chosen…`.
 *
 * **Each picker is drawn only while its own pick is on `Chosen…`**, so this is the one state that
 * shows both at once — a picker under `All decks` would be a control whose every press changes
 * nothing on the card, and the pick's row is directly above it in the same popover. Each trigger
 * says the *answer* rather than a count of ticks: `English and Japanese` is `languagePhrase`, the
 * same function the footer reads, so the popover and the card cannot come to describe one setting
 * two ways.
 */
export const Chosen: Story = {
  args: {
    editing: true,
    widget: printings(4, 4, {
      window: 365,
      scope: "chosen",
      deckIds: [2, 4],
      langs: "chosen",
      langIds: ["en", "ja"],
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "New printings" }));

    await userEvent.click(card.getByRole("button", { name: "Settings for New printings" }));
    const decks = await waitFor(
      () => card.getByRole("button", { name: "Decks to watch" }),
      POPOVER_TIMEOUT,
    );
    await expect(decks).toHaveTextContent("2 decks");
    await expect(card.getByRole("button", { name: "Languages to show" })).toHaveTextContent(
      "English and Japanese",
    );
  },
};
