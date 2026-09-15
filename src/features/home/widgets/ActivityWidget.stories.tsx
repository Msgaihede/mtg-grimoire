import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { widgetDensity } from "../widgetSettings";
import { ActivityWidget } from "./ActivityWidget";

/** The grid's target cell, so a footprint here is drawn at the size an ordinary window draws it. */
const CELL = 104;

/** An Activity entry at a footprint. */
const activityAt = (w: number, h: number, config: unknown = null): HomeWidget => ({
  id: "activity",
  kind: "activity",
  x: 0,
  y: 0,
  w,
  h,
  config,
});

/**
 * The body inside the card the page draws it in, at its footprint's pixel size.
 *
 * The fit is built from the entry, as the page builds it from a measured cell, so a story changes
 * the box by passing a different `widget` and nothing else. This kind's settings are all registry
 * rows (`Changes to show`, `Show times`), which the card draws — so there is no `extraSettings`.
 */
function Framed({ widget, editing, still, onConfig }: WidgetBodyProps) {
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx: spanPx(widget.w, CELL),
    heightPx: spanPx(widget.h, CELL),
    density: widgetDensity(widget),
  });
  return (
    <div style={{ width: fit.widthPx, height: fit.heightPx }}>
      <WidgetCard
        widget={widget}
        fit={fit}
        editing={editing}
        still={still}
        onConfig={onConfig}
        onRemove={fn()}
      >
        <ActivityWidget
          widget={widget}
          fit={fit}
          editing={editing}
          still={still}
          onConfig={onConfig}
        />
      </WidgetCard>
    </div>
  );
}

/**
 * The body with a query client that has not fetched — the beat before `activity_recent`
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
function Unanswered(props: WidgetBodyProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Framed {...props} />
    </QueryClientProvider>
  );
}

/** The kind's tallest card — room for twenty-six lines, which is the whole of the seeded today and
 *  the start of yesterday. */
const TALL = activityAt(4, 8);

const meta = {
  title: "Home/ActivityWidget",
  component: ActivityWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: three cells by three, no config — which reads 50 changes, with
    // times. `fit` is only what the body's type requires; `Framed` builds the real one from the
    // entry.
    widget: activityAt(3, 3),
    fit: makeFit({
      w: 3,
      h: 3,
      widthPx: spanPx(3, CELL),
      heightPx: spanPx(3, CELL),
      density: "comfortable",
    }),
    editing: false,
    still: false,
    onConfig: fn(),
  },
  render: (args) => <Framed {...args} />,
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
          "shape: a day heading with the day's roll-up, a line, and the four sentences the list " +
          "has when it is not a list.\n\n" +
          "**Cut to whole lines against the card.** A line is 27px and a day heading costs one, " +
          "so each day takes one fewer line than is left and a day with no line left is dropped " +
          "rather than drawn as a heading over nothing. The query still reads the stored limit, " +
          "and the roll-up is the whole day as read, not the lines the card had room for.\n\n" +
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
          "invalidation of this feed. A catalogue preview (`still`) does not bridge.\n\n" +
          "**The refusal is read before the emptiness**, which is the deck history's rule and " +
          "its reason: a failed read has no rows either, and calling it *nothing has happened " +
          "yet* tells a reader with nine thousand cards that their history is gone. That arm is " +
          "the one this workbench cannot reach — see {@link Unanswered} for why.\n\n" +
          "**The day's roll-up is drawn as two tinted chips and spoken as a sentence**, because " +
          "read literally `+18 −4` is *plus eighteen minus four*. Two counters rather than one " +
          "signed sum: a day that gained eighteen copies and lost four is not a quiet day, and " +
          "`+14` says it was.",
      },
    },
  },
} satisfies Meta<typeof ActivityWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded world on the kind's tallest card, with the collection, the wishlist and the deck
 * audit interleaved.
 *
 * The `play` reads the **accessible** feed. The roll-up beside each day heading is drawn as two
 * `aria-hidden` chips with an `sr-only` sentence beside them, and the sentence is what is asserted
 * — the heading itself deliberately holds the label and nothing else, since a count folded in
 * beside it would compute into the accessible name.
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
  args: { widget: TALL },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await expect(await feed.findByText("Today")).toBeInTheDocument();
    await expect(feed.getByText("Yesterday")).toBeInTheDocument();

    // The day's copies in and out, spoken. Not the chips, which are punctuation read aloud.
    await expect(feed.getByText("18 copies added, 4 copies removed")).toBeInTheDocument();

    // The bulk shape: no card named, a count in the payload, and its own sentence.
    await expect(feed.getByText("Added 12 cards to your wishlist")).toBeInTheDocument();
    // And a `deck_audit` row in the same day — `auditText.ts`'s wording, verbatim.
    await expect(feed.getByText("Renamed category Value to Card advantage")).toBeInTheDocument();
  },
};

/**
 * A feed deeper than the card — 180 rows over twelve days, on the kind's default three-by-three.
 *
 * **The widget is deciding where to stop rather than showing everything it read**, which is a
 * state three days of tidying cannot reach and the reason the `large` seed carries an activity
 * table at all. The card has room for eight lines; the first day's heading takes one, so it draws
 * seven of that day's fifteen and no second day. The `play` counts the rows because the count
 * *is* the claim — and it is a fact about the fit handed down, not about jsdom's missing layout.
 */
export const CutToTheCard: Story = {
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await waitFor(async () => {
      await expect(feed.getAllByRole("listitem")).toHaveLength(7);
    });
    await expect(feed.getAllByRole("heading", { level: 4 })).toHaveLength(1);
  },
};

/** `Show times` switched off: the same lines, no stamps — more of each sentence before it
 *  truncates on a narrow card. */
export const WithoutTimes: Story = {
  args: { widget: activityAt(3, 3, { times: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const feed = within(await canvas.findByRole("region", { name: "Activity" }));

    await expect(await feed.findByText("Today")).toBeInTheDocument();
    await expect(canvasElement.querySelector("time")).toBeNull();
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
