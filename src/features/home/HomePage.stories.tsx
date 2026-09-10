import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { HomeLayout } from "@/lib/ipc";
import { HomePage } from "./HomePage";
import { HOME_LAYOUT_KEY } from "./useHomeLayout";

/** How long a play waits on something a freshly opened popover has to draw. Seconds-scale,
 *  because the panel mounts on the press and its rows arrive a commit or two later; a plain
 *  `const`, because CSF indexes every non-default export as a story. */
const POPOVER_TIMEOUT = { timeout: 5_000 };

/**
 * The page, opened on a stored arrangement of the story's choosing.
 *
 * **Seeded through `HOME_LAYOUT_KEY` rather than by mocking `home_layout`**, which is what that
 * constant is exported for: `useHomeLayout` reads one query at `staleTime: Infinity`, so a cache
 * entry written before the page mounts *is* the stored document as far as every consumer is
 * concerned — the read never fires, `ready` is true on the first render, and nothing about the
 * page is standing in for anything. A `vi.mock` would story the page against a second, agreeing
 * copy of a contract nobody had checked, which is the argument `.storybook/CLAUDE.md` makes about
 * aliasing `ipc.ts`.
 *
 * `useState`'s lazy initializer rather than an effect, `AllPrintingsDialog.stories.tsx`'s idiom
 * and its reason: an effect runs after the first paint, so a story about a particular
 * arrangement would draw the seeded six for one frame first. The query has no observer at this
 * point — `HomePage` has not mounted — so the write notifies nobody and is not a render-phase
 * update to another component.
 *
 * `null` leaves the cache alone and lets the fake answer, which is the ordinary path and what
 * most of the stories below want.
 */
function Page({ layout }: { layout: HomeLayout | null }): ReactElement {
  const client = useQueryClient();
  useState(() => {
    if (layout !== null) client.setQueryData(HOME_LAYOUT_KEY, layout);
  });
  return <HomePage />;
}

/** A widget a build that is not this one wrote — an unknown `kind`, and a `config` shaped like
 *  nothing here reads. Both are carried through untouched, which is the promise this page is the
 *  last line of. */
const FROM_A_NEWER_BUILD: HomeLayout = {
  version: 1,
  widgets: [
    { id: "summary", kind: "summary", span: 2, config: null },
    // Not a `WidgetKind`, and deliberately plausible rather than nonsense: this is what a later
    // build's seventh widget looks like to this one.
    { id: "priceHistory", kind: "priceHistory", span: 1, config: { window: "90d", smooth: true } },
    { id: "activity", kind: "activity", span: 1, config: null },
  ],
};

const meta = {
  title: "Home/Page",
  component: Page,
  tags: ["autodocs"],
  // The ordinary path: no cache seeding, so `home_layout` answers and the fake's own
  // `DEFAULT_HOME_WIDGETS` is what the page opens on.
  args: { layout: null },
  // Keyed on the layout, so changing it in Controls remounts and the initializer above runs
  // again rather than writing into a cache the mounted page is already observing.
  render: (args) => <Page key={JSON.stringify(args.layout)} {...args} />,
  decorators: [
    // `AppShell`'s `main`, stood in for. 1032px is the content column at the app's narrow rung —
    // the 1280-wide window `src-tauri/src/window.rs` opens on, less the sidebar's `w-52` and
    // `main`'s `p-5` on both sides — which is the width the wrapping row's breaks were chosen
    // at. `relative` goes with any `overflow` in this app: a scroll container has to be the
    // containing block for its own absolutely positioned content, or an `sr-only` label inside
    // stretches the document.
    (Story) => (
      <div className="relative h-[760px] w-[1032px] max-w-full overflow-auto p-1">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The landing view: the reader's own arrangement of widgets, and the four gestures " +
          "that change it — add, remove, widen, reorder.\n\n" +
          "**The page draws a layout document and owns no state about it.** `useHomeLayout` is " +
          "where the arrangement lives for the life of the window, `layout.ts` is where every " +
          "change to it is computed, and both are pure of React — so the only `useState` here " +
          "is whether **Customize** is on, which is a fact about this session and not about the " +
          "document.\n\n" +
          "**An unknown `kind` is drawn, never thrown on.** `home.rs` stores a kind it has " +
          "never heard of, `parseLayout` keeps it, and `renderWidget`'s `default` arm is where " +
          "that promise is finally kept — {@link FromANewerBuild} is the story it is about. A " +
          "reader running two builds of a portable app is the ordinary case rather than the " +
          "exotic one, and an older build that emptied the newer build's page would be the " +
          "exact loss the whole round-trip rule exists to prevent. The placeholder keeps its " +
          "full edit tray on purpose: a widget this build cannot draw is the one a reader is " +
          "most likely to want to move or take off the page.\n\n" +
          "**No `@container`, here or in `WidgetCard`.** `container-type: inline-size` applies " +
          "layout containment, which makes the box the containing block for every `fixed` " +
          "descendant — and these widgets open anchored popovers, context menus and, through " +
          "them, dialogs whose scrim is a bare `fixed inset-0`. The row wraps with flexbox " +
          "instead, and the two width recipes are whole class strings rather than a width " +
          "computed from `span`, because Tailwind scans source *text* and an interpolated class " +
          "emits no rule at all.\n\n" +
          "**The page does no arithmetic about position.** A drop reports which widget was " +
          "dragged and which edge of which widget it landed on, and `moveWidget` takes exactly " +
          "that pair — an index worked out here would be an index into the list *before* the " +
          "dragged widget was lifted out of it, and one too high for every forward move. The " +
          "arrow keys go the same way, because `dndManager` ships no `KeyboardSensor` and a " +
          "reorder that was only a drag would be a rearrange half the readers do not have.\n\n" +
          "**`ready` is what separates two pages that look identical.** Before the stored " +
          "document answers, a page with no widgets has not spoken yet; after it answers, the " +
          "same page is a reader who cleared it — {@link ClearedByTheReader} is the second, and " +
          "drawing it over the first would greet every launch with a sentence that vanishes a " +
          "moment later.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A database nobody has customised: the six widgets the crate seeds, in the order it seeds them.
 *
 * Each is a `region` named by its own heading — `StatsCard` draws a `<section aria-labelledby>`
 * over an `<h3>` — which is what lets a test, a live pass and a screen reader all address one by
 * its words. **A widget's place is the one thing about it a reader is free to change, so it is
 * the one thing nothing may address it by.**
 *
 * The header carries **Customize** and nothing else at rest: Add widget and Reset belong to edit
 * mode, and to the empty page.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const heading of [
      "Summary",
      "Decks",
      "Activity",
      "Collection value",
      "Wishlist value",
      "Folders",
    ]) {
      await expect(await canvas.findByRole("region", { name: heading })).toBeInTheDocument();
    }
    await expect(canvas.getByRole("button", { name: "Customize" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.queryByRole("button", { name: "Add widget" })).not.toBeInTheDocument();
  },
};

/**
 * Customize pressed: every card grows its tray, and the header grows the two controls that only
 * mean something while the page is being rearranged.
 *
 * Every control in a tray folds the widget's heading into its own accessible name, so six cards
 * are six addressable Remove buttons rather than one name repeated six times — which is the
 * whole reason a play can name one.
 */
export const Customizing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const customize = canvas.getByRole("button", { name: "Customize" });
    await userEvent.click(customize);

    await expect(customize).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();

    // The tray, on one named card. `Full width` is a toggle with a fixed name and `aria-pressed`
    // saying which state it is in — never two glyphs swapped, because a different element in the
    // same slot teleports.
    const summary = within(canvas.getByRole("region", { name: "Summary" }));
    await expect(summary.getByRole("group", { name: "Customize Summary" })).toBeInTheDocument();
    await expect(summary.getByRole("button", { name: "Move Summary" })).toBeInTheDocument();
    await expect(summary.getByRole("button", { name: "Full width, Summary" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(summary.getByRole("button", { name: "Remove Summary" })).toBeInTheDocument();
  },
};

/**
 * A document holding a widget this build has never heard of — **the feature's central promise,
 * drawn**.
 *
 * `HomeWidget.kind` is a free `string` on the wire, `home.rs` refuses no kind, `parseLayout`
 * keeps it and `renderWidget`'s `default` arm draws it: a card saying where it came from, with
 * its opaque `config` untouched underneath. The kind is in the heading rather than only in the
 * sentence, so two widgets from a newer build are two addressable cards instead of one name
 * repeated.
 *
 * **It keeps its whole tray and carries no settings popover.** A widget this build cannot draw
 * is the one a reader is most likely to want to move or take off the page; an empty settings
 * panel is a question with no answers in it.
 *
 * The arrangement is seeded through `HOME_LAYOUT_KEY` — see {@link Page}. Nothing is mocked, and
 * the two widgets this build *does* know are drawn beside it, which is the claim: an older build
 * pointed at a newer build's row rearranges what it knows and quietly empties nothing.
 */
export const FromANewerBuild: Story = {
  args: { layout: FROM_A_NEWER_BUILD },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const unknown = within(
      await canvas.findByRole("region", { name: "Unknown widget (priceHistory)" }),
    );
    await expect(
      unknown.getByText(/This widget came from a newer version of MTG Grimoire\./),
    ).toBeInTheDocument();

    // The widgets this build does know are drawn beside it, and the ones the default layout
    // holds but this document does not are absent — the document is the reader's, not a merge.
    await expect(canvas.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: "Folders" })).not.toBeInTheDocument();

    // The full tray, on the card this build cannot draw — and no settings control.
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await expect(
      unknown.getByRole("button", { name: "Remove Unknown widget (priceHistory)" }),
    ).toBeInTheDocument();
    await expect(
      unknown.queryByRole("button", { name: "Settings for Unknown widget (priceHistory)" }),
    ).not.toBeInTheDocument();
  },
};

/**
 * A reader who has taken every widget off the page.
 *
 * **An empty widget list is a layout, not a missing document** — `home.rs` keeps it rather than
 * re-seeding, because handing the six defaults back on the next launch would undo the reader's
 * choice silently, every time, for ever.
 *
 * So the page needs a way back that is not on a card, and the empty page is the second way into
 * the tray: **Add widget** and **Reset** are drawn with nothing pressed. Without that, the only
 * page with nothing on it would also be the only page with no way to put anything back.
 */
export const ClearedByTheReader: Story = {
  args: { layout: { version: 1, widgets: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/^Your home page is empty\./),
    ).toBeInTheDocument();
    // The tray, with Customize still off — this is the empty page's own way in.
    await expect(canvas.getByRole("button", { name: "Customize" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  },
};

/**
 * Adding a widget from the empty page, and putting it back with Reset.
 *
 * The menu is the app's one option list — `sortOptions`' order rather than the registry's own
 * insertion order — and picking a row adds that widget while the trigger goes straight back to
 * saying what it does, because there is no value here for it to be set to.
 *
 * **Reset writes the seeded six**, in their seeded order and at their seeded widths, through the
 * same optimistic path every other change to this page takes.
 */
export const AddingAndResetting: Story = {
  args: { layout: { version: 1, widgets: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Add widget" }));
    await waitFor(async () => {
      await expect(canvas.getAllByRole("option").map((row) => row.textContent)).toEqual([
        "Activity",
        "Collection value",
        "Decks",
        "Folders",
        "Summary",
        "Wishlist value",
      ]);
    }, POPOVER_TIMEOUT);

    await userEvent.click(canvas.getByRole("option", { name: "Activity" }));
    await waitFor(async () => {
      await expect(canvas.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    });
    // One widget is not an empty page any more, so the sentence goes — **and the tray goes with
    // it**, because `tray` is `editing || empty` and neither is true now. That is the empty
    // page's way in closing behind the reader rather than a control disappearing: the page has
    // affordances on its cards again, which is what the second way in existed to stand in for.
    await expect(canvas.queryByText(/^Your home page is empty\./)).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();

    // Reset is edit mode's from here, and it writes the seeded six back — in their seeded order
    // and at their seeded widths, through the same optimistic path every other change takes.
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await userEvent.click(canvas.getByRole("button", { name: "Reset" }));
    await waitFor(async () => {
      await expect(canvas.getByRole("region", { name: "Folders" })).toBeInTheDocument();
    });
  },
};

/**
 * A rearrangement made while a sync holds the write connection — **the press lands anyway**.
 *
 * `set_home_layout` takes `AppState.db` and answers `BUSY` while a sync has it, which the fake
 * honours on every write (`refuseIfBusy`). The reads are untouched, here as in the crate, so
 * this is the one refusal the home page can actually be shown in — and what it shows is that
 * **the writes are optimistic and deliberately not rolled back**: the cache is written before
 * the command is sent, and a refused write keeps the reader's page for this session and says
 * nothing.
 *
 * That is a decision rather than an omission. Snapping the widgets back under the reader's hand,
 * with nothing on screen saying why, is worse than losing one launch's memory of the
 * arrangement — and this page is direct manipulation end to end, where a card that answers late
 * reads as a card that did not move.
 */
export const WhileTheDatabaseIsBusy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));

    const summary = within(canvas.getByRole("region", { name: "Summary" }));
    await userEvent.click(summary.getByRole("button", { name: "Remove Summary" }));

    // Gone from the page the reader is looking at, even though the row it would have been
    // remembered in refused the write.
    await waitFor(async () => {
      await expect(canvas.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
    });
    // And nothing is said about it: there is no error banner on this page, by design.
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    // The rest of the arrangement is untouched.
    await expect(canvas.getByRole("region", { name: "Folders" })).toBeInTheDocument();
  },
};

/**
 * The keyboard's reorder: the grip's arrow keys, one step at a time.
 *
 * `dndManager` ships no `KeyboardSensor`, so without this a reorder would be a gesture only a
 * mouse can make. A delta becomes the **neighbour's id** and an edge, which is the only shape
 * `moveWidget` takes — so the two ways to move a widget are the same call and cannot come to
 * disagree.
 *
 * The order is read off the page's own `data-home-widget` boxes rather than off the cards: the
 * box is what the wrapping row lays out, and it is the element the page owns. It is scenery with
 * no accessible name of its own, which is why this is the one assertion here that is not made
 * through a role.
 */
export const NudgingWithTheKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));

    const order = () =>
      [...canvasElement.querySelectorAll("[data-home-widget]")].map((box) =>
        box.getAttribute("data-home-widget"),
      );
    await expect(order()).toEqual([
      "summary",
      "decks",
      "activity",
      "collectionValue",
      "wishlistValue",
      "folders",
    ]);

    const grip = within(canvas.getByRole("region", { name: "Activity" })).getByRole("button", {
      name: "Move Activity",
    });
    // Pressed rather than focused programmatically: `el.focus()` tests a caret no reader has,
    // and the grip is a `<button>`, so a click is what puts the caret where the arrows are read.
    await userEvent.click(grip);
    await userEvent.keyboard("{ArrowLeft}");

    await waitFor(async () => {
      await expect(order()).toEqual([
        "summary",
        "activity",
        "decks",
        "collectionValue",
        "wishlistValue",
        "folders",
      ]);
    });
  },
};
