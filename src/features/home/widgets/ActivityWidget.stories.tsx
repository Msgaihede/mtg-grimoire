import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { WidgetProps } from "../widgetProps";
import { ActivityWidget } from "./ActivityWidget";

/** How long a play waits on a freshly opened settings popover. Seconds-scale, because the panel
 *  mounts on the press and the `Dropdown` inside it a commit later; a plain `const`, because CSF
 *  indexes every non-default export as a story. */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/** The page's half of every widget's props — see `widgetProps.ts`. */
const CHROME = {
  editing: false,
  onRemove: fn(),
  onSpan: fn(),
  onConfig: fn(),
  onNudge: fn(),
  dragHandleRef: fn(),
};

/**
 * The widget with a query client that has not fetched — the beat before `activity_recent`
 * answers, which is one of the four sentences this widget insists are four.
 *
 * **A client rather than a fault, because no fault in `.storybook/fake/` reaches a read.**
 * `busy` is `collection::BUSY` and the fake honours it on writes only (`refuseIfBusy`, wired
 * into every `writeHandlers` entry and none of the reads) — the crate's own split, since a write
 * takes `AppState.db` and can be refused while a read goes through `db_read` and answers through
 * every second of a sync. `activity_recent`'s own handler says outright that no fault reaches it.
 *
 * So a nested `QueryClientProvider` whose queries are `enabled: false` is the honest shape of
 * it: nothing is mocked, no command answers anything it would not answer, and the feed's query
 * sits at `status: "pending"` — exactly what the widget sees on its first render. Its own client
 * rather than the world's, so nothing here leaks into the story mounted beside it on a docs page.
 */
function Unanswered({ widget, ...chrome }: WidgetProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <ActivityWidget widget={widget} {...chrome} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Home/ActivityWidget",
  component: ActivityWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: one column, no config — which reads 50 changes.
    widget: { id: "activity", kind: "activity", span: 1, config: null },
    ...CHROME,
  },
  decorators: [
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
          "What has been added, moved and removed, in day sections — `DeckHistoryDialog` one " +
          "scope wider.\n\n" +
          "**Every sentence in it belongs to somebody else.** The grouping is " +
          "`activityText.ts`'s `activityDays`, the wording its `activityLine` — which hands a " +
          "`deck`-scoped row straight to the deck history's own builder, so a deck line reads " +
          "here character for character as it reads in that dialog. What this file adds is the " +
          "shape: a scroller, a sticky day header with the day's roll-up, a row, and the four " +
          "sentences the list has when it is not a list.\n\n" +
          "**Two tables read as one.** `activity_recent` is a `UNION ALL` over `activity` and " +
          "`deck_audit`, and their ids collide — so a row is keyed on `scope` plus `id`, and a " +
          "caller keying on the bare number would draw two rows as one with nothing said about " +
          "it. The `starter` seed is timed to interleave the two halves, so one day holds a " +
          "collection line, a wishlist line and a deck line.\n\n" +
          "**The one thing this widget owns is staying fresh.** No mutation anywhere has heard " +
          "of an `[\"activity\"]` key, and `invalidateQueries` matches by prefix, so the " +
          "invalidations that already follow a write cannot reach it. The bridge lives here: a " +
          "marker query under each of the three write roots, so each always has something to " +
          "match, and one subscription turning an `invalidate` on any of them into an " +
          "invalidation of this feed.\n\n" +
          "**The refusal is read before the emptiness**, which is the deck history's rule and " +
          "its reason: a failed read has no rows either, and calling it *nothing has happened " +
          "yet* tells a reader with nine thousand cards that their history is gone. That arm is " +
          "the one this workbench cannot reach — see {@link Unanswered} for why.\n\n" +
          "**The day's roll-up is drawn `+18 / −4` and spoken as a sentence**, because read " +
          "literally that string is *plus eighteen slash minus four*. Two counters rather than " +
          "one signed sum: a day that gained eighteen copies and lost four is not a quiet day, " +
          "and `+14` says it was.",
      },
    },
  },
} satisfies Meta<typeof ActivityWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Four days of the seeded world, with the collection, the wishlist and the deck audit
 * interleaved.
 *
 * The `play` reads the **accessible** feed. The roll-up beside each day heading is drawn as
 * `+18 / −4` inside an `aria-hidden` span with an `sr-only` sentence beside it, and the sentence
 * is what is asserted — the heading itself deliberately holds the label and nothing else, since
 * a count folded in beside it would compute into the accessible name and a `gap` joins two
 * children with no space at all (`Today3 changes`).
 *
 * The two lines it names are the two this seed is arranged to produce. **A run rather than a
 * card** — a wishlist `add` naming no printing and carrying a `cards` count is the deck's *Send
 * missing to wishlist* press, and it is the one payload that changes which sentence its own kind
 * draws. And a **deck** line in the same list, which is the whole point of the union: that
 * sentence is `auditText.ts`'s, drawn here without this file wording anything.
 *
 * Only `Today` and `Yesterday` are asserted by name. Every older heading is a weekday and a
 * date, which is a different string every day this suite runs.
 */
export const ThreeDays: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await expect(await feed.findByText("Today")).toBeInTheDocument();
    await expect(feed.getByText("Yesterday")).toBeInTheDocument();

    // The day's copies in and out, spoken. Not `+18 / −4`, which is punctuation read aloud.
    await expect(feed.getByText("18 copies added, 4 copies removed")).toBeInTheDocument();

    // The bulk shape: no card named, a count in the payload, and its own sentence.
    await expect(feed.getByText("Added 12 cards to your wishlist")).toBeInTheDocument();
    // And a `deck_audit` row in the same day — `auditText.ts`'s wording, verbatim.
    await expect(feed.getByText("Renamed category Value to Card advantage")).toBeInTheDocument();
  },
};

/**
 * A feed deeper than the widget reads — 180 rows over twelve days, against a default limit of
 * fifty.
 *
 * **The widget is deciding where to stop rather than showing everything there is**, which is a
 * state three days of tidying cannot reach and is the whole reason the `large` seed carries an
 * activity table at all. The `play` counts the rows because the count *is* the claim: fifty
 * exactly, out of a hundred and eighty, and the day headings stop wherever the fiftieth row
 * falls.
 *
 * The rows are not virtualised — this is a scroller with a `max-h`, not a `VirtualTable` — so
 * counting them here is a fact about the widget rather than about jsdom's missing layout.
 */
export const CutOffAtTheLimit: Story = {
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await expect(await feed.findByText("Today")).toBeInTheDocument();
    await waitFor(async () => {
      await expect(feed.getAllByRole("listitem")).toHaveLength(50);
    });
  },
};

/**
 * A database nothing has happened in — the only world three of this widget's four states are
 * reachable from.
 *
 * The sentence names the two cabinets whose lines are **this device's own** and the one whose
 * lines arrive from every device paired with it, because that asymmetry is a fact about the
 * feed a reader has no other way to learn: `deck_audit` is synced and `activity` is not.
 */
export const NothingYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));
    await expect(await feed.findByText("Nothing has happened yet.")).toBeInTheDocument();
    await expect(feed.queryByText("Today")).not.toBeInTheDocument();
  },
};

/**
 * The read still out — and it says so rather than saying nothing has happened.
 *
 * **"We have not read it yet" and "there is nothing to read" are opposite statements**, and a
 * feed that drew the second over the first would greet a reader with nine thousand cards with a
 * blank history for the beat before the rows land. See {@link Unanswered} for why this is a
 * paused query client rather than a fault.
 */
export const StillReading: Story = {
  render: (args) => <Unanswered {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));
    await expect(feed.getByText("Reading recent activity…")).toBeInTheDocument();
    await expect(feed.queryByText("Nothing has happened yet.")).not.toBeInTheDocument();
  },
};

/**
 * The settings popover — the one number this widget remembers.
 *
 * Every row it offers is inside `activity_recent`'s own clamp of `1..=500`, so the narrowing in
 * `feedLimit` can only ever fire on a config no press of this control produced — a hand-edited
 * row, or a build that offered a different set. The label is both `id`-associated and
 * `labelledBy`: the first keeps the pointer behaviour a `<label for>` gives, the second states
 * the accessible name outright rather than leaving it to an association a later edit could break.
 */
export const ChoosingHowMuchToShow: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await userEvent.click(feed.getByRole("button", { name: "Settings for Activity" }));
    const picker = await waitFor(
      () => feed.getByRole("button", { name: "Changes to show" }),
      POPOVER_TIMEOUT,
    );
    await expect(picker).toHaveTextContent("50 changes");

    await userEvent.click(picker);
    await waitFor(async () => {
      // **Ascending, and deliberately not `sortOptions`' order** — this is one of the app's
      // documented exemptions, because the order *is* the information: a ladder of amounts read
      // alphabetically puts 100 above 25, which is a list nobody can walk.
      await expect(feed.getAllByRole("option").map((row) => row.textContent)).toEqual([
        "25 changes",
        "50 changes",
        "100 changes",
        "200 changes",
      ]);
    }, POPOVER_TIMEOUT);
  },
};
