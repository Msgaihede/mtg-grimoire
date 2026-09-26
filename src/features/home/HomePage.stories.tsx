import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import type { HomeLayout } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { CUSTOMIZE_HINT, HOME_CANVAS_ATTR, HomePage } from "./HomePage";
import { HOME_LAYOUT_KEY } from "./useHomeLayout";

/** How long a play waits on something a press has to mount — a dialog's panel, a card a write put on
 *  the page. Seconds-scale; a plain `const`, because CSF indexes every non-default export as a story. */
const MOUNT_TIMEOUT = { timeout: 5_000 };

/**
 * The page, opened on a stored arrangement of the story's choosing.
 *
 * **Seeded through `HOME_LAYOUT_KEY` rather than by mocking `home_layout`**, which is what that
 * constant is exported for: `useHomeLayout` reads one query at `staleTime: Infinity`, so a cache
 * entry written before the page mounts *is* the stored document as far as every consumer is
 * concerned — the read never fires, `ready` is true on the first render, and nothing about the page
 * is standing in for anything. A `vi.mock` would story the page against a second, agreeing copy of a
 * contract nobody had checked, which is the argument `.storybook/CLAUDE.md` makes about aliasing
 * `ipc.ts`.
 *
 * `useState`'s lazy initializer rather than an effect, `AllPrintingsDialog.stories.tsx`'s idiom and
 * its reason: an effect runs after the first paint, so a story about a particular arrangement would
 * draw the fake's for one frame first.
 *
 * `null` leaves the cache alone and lets the fake answer, which is the ordinary path.
 */
function Page({ layout }: { layout: HomeLayout | null }): ReactElement {
  const client = useQueryClient();
  useState(() => {
    if (layout !== null) client.setQueryData(HOME_LAYOUT_KEY, layout);
  });
  return <HomePage />;
}

/** A small arrangement the gesture stories start from, so what a press adds is unambiguous. */
const JUST_SUMMARY: HomeLayout = {
  version: 2,
  widgets: [{ id: "summary", kind: "summary", x: 0, y: 0, w: 4, h: 2, span: 1, config: null }],
};

/** A widget a build that is not this one wrote — an unknown `kind`, and a `config` shaped like
 *  nothing here reads. Both are carried through untouched, which is the promise this page is the
 *  last line of. */
const FROM_A_NEWER_BUILD: HomeLayout = {
  version: 2,
  widgets: [
    { id: "summary", kind: "summary", x: 0, y: 0, w: 4, h: 2, span: 1, config: null },
    // Not a `WidgetKind`, and deliberately plausible rather than nonsense: this is what a later
    // build's tenth widget looks like to this one.
    {
      id: "priceHistory",
      kind: "priceHistory",
      x: 4,
      y: 0,
      w: 4,
      h: 2,
      span: 1,
      config: { window: "90d", smooth: true },
    },
    { id: "activity", kind: "activity", x: 0, y: 2, w: 3, h: 3, span: 1, config: null },
  ],
};

/**
 * `AppShell`'s `main`, stood in for, at a given width. `relative` goes with any `overflow` in this
 * app: a scroll container has to be the containing block for its own absolutely positioned content,
 * or an `sr-only` label inside stretches the document.
 *
 * Written as two whole class strings rather than one built from a number — Tailwind scans source
 * text, and an interpolated width would emit no rule.
 */
const MAIN_WIDE = "relative h-[760px] w-[1032px] max-w-full overflow-auto p-1";
const MAIN_NARROW = "relative h-[760px] w-[480px] max-w-full overflow-auto p-1";

const meta = {
  title: "Home/Page",
  component: Page,
  tags: ["autodocs"],
  args: { layout: null },
  // Keyed on the layout, so changing it in Controls remounts and the initializer above runs again
  // rather than writing into a cache the mounted page is already observing.
  render: (args) => <Page key={JSON.stringify(args.layout)} {...args} />,
  decorators: [
    // 1032px is the content column at the app's narrow rung — the 1280-wide window
    // `src-tauri/src/window.rs` opens on, less the sidebar's `w-52` and `main`'s `p-5` on both
    // sides — which measures as nine columns of 104px, `TARGET_CELL` exactly.
    (Story) => (
      <div className={MAIN_WIDE}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The landing view: the reader's own arrangement of widgets on a grid of square cells, " +
          "and the gestures that change it — add, remove, move, resize, configure.\n\n" +
          "**The page draws a layout document and owns no state about it.** `useHomeLayout` is " +
          "where the arrangement lives, `layout.ts` computes every change to it and `fit.ts` is the " +
          "arithmetic of cells and pixels — so the state here is about the session: Customize, the " +
          "catalogue, and the gesture in the reader's hand.\n\n" +
          "**The column count is measured, and what is drawn is derived from it — never written " +
          "back.** A `ResizeObserver` on the canvas gives the columns and the cell; the page draws " +
          "`normalise(layout.widgets, cols)` as a memo, so narrowing the window for a moment never " +
          "rewrites the stored arrangement. Only a gesture writes, and it writes the arrangement " +
          "the reader was looking at.\n\n" +
          "**Below a readable cell the page stacks** — {@link Narrow} — one card per row at the " +
          "canvas's width, with no grid to drop on. **In this workbench's Vitest runner every story " +
          "is stacked**: jsdom lays nothing out, so the canvas measures `0`, which the page reads " +
          "as unmeasured. That is why no play below asserts on a grip or a corner.\n\n" +
          "**An unknown `kind` is drawn, never thrown on** — {@link FromANewerBuild}. **No " +
          "`@container` and no `cqw`**: layout containment would reparent every `fixed` descendant " +
          "of a card, and this runtime can measure where the design canvas could not.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A database nobody has customised: the fake's seeded arrangement.
 *
 * Each widget is a `region` named by its own title — `WidgetCard` draws a named `<section>` — which
 * is what lets a test, a live pass and a screen reader all address one by its words. **A widget's
 * place is the one thing about it a reader is free to change, so it is the one thing nothing may
 * address it by.** The header carries **Customize** and nothing else at rest.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const title of ["Summary", "Decks", "Activity", "Collection value", "Folders"]) {
      await expect(await canvas.findByRole("region", { name: title })).toBeInTheDocument();
    }
    await expect(canvas.getByRole("button", { name: "Customize" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.queryByRole("button", { name: "Add widget" })).not.toBeInTheDocument();
    await expect(canvas.queryByText(CUSTOMIZE_HINT)).not.toBeInTheDocument();
  },
};

/**
 * Customize pressed: the guides come up down the middle of every gap, each card grows its title
 * field, its tray and — on the grid — its grip and resize corner, and the header grows the hint and
 * the two controls that only mean something while the page is being rearranged. The toggle says
 * **Done** while it is on.
 */
export const Customizing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Customize" }));

    await expect(canvas.getByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByText(CUSTOMIZE_HINT)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();

    // The tray, on one named card — present on the grid and in the stack alike.
    const summary = within(canvas.getByRole("region", { name: "Summary" }));
    await expect(summary.getByRole("button", { name: "Settings for Summary" })).toBeInTheDocument();
    await expect(summary.getByRole("button", { name: "Remove Summary" })).toBeInTheDocument();
  },
};

/**
 * The Widget catalogue, open over the page: every kind this build can draw, each as the real widget
 * at the footprint it arrives at — a still, outside the accessibility tree — with a status line
 * saying whether one is already on the page and an Add that puts one there.
 */
export const CatalogueOpen: Story = {
  args: { layout: JUST_SUMMARY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Customize" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add widget" }));

    const dialog = within(
      await canvas.findByRole("dialog", { name: "Widget catalogue" }, MOUNT_TIMEOUT),
    );
    for (const label of [
      "Summary",
      "Recently viewed",
      "Set completion",
      "Price movers",
      "Deck completion",
      "To review",
      "Wishlist savings",
      "Coming soon",
    ]) {
      await expect(dialog.getByRole("button", { name: `Add ${label}` })).toBeInTheDocument();
    }
    // The previews are pictures: every one a real card, and not one of them a region a reader can
    // reach. (This said "nine" until a round of new kinds made it wrong — `WIDGETS` is the count.)
    await expect(dialog.queryAllByRole("region")).toHaveLength(0);
    await expect(
      within(dialog.getByRole("heading", { name: "Summary" }).closest("li")!).getByText(
        "On the page",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A reader who has taken every widget off the page.
 *
 * **An empty widget list is a layout, not a missing document** — `home.rs` keeps it rather than
 * re-seeding, because handing the defaults back on the next launch would undo the reader's choice
 * silently, every time. So the empty page is the second way into the tray: **Add widget** and
 * **Reset** are drawn with Customize still off.
 */
export const ClearedByTheReader: Story = {
  args: { layout: { version: 2, widgets: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^Your home page is empty\./)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Customize" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  },
};

/**
 * Adding from the empty page, through the catalogue. The widget lands at the first free cell — on an
 * empty grid, the top-left corner — and one widget is not an empty page any more, so the sentence
 * goes and the tray goes with it: the page has affordances on its cards again.
 */
export const AddingFromTheEmptyPage: Story = {
  args: { layout: { version: 2, widgets: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add widget" }));
    const dialog = within(
      await canvas.findByRole("dialog", { name: "Widget catalogue" }, MOUNT_TIMEOUT),
    );
    await userEvent.click(dialog.getByRole("button", { name: "Add Activity" }));

    await expect(
      await canvas.findByRole("region", { name: "Activity" }, MOUNT_TIMEOUT),
    ).toBeInTheDocument();
    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    }, MOUNT_TIMEOUT);
    await expect(canvas.queryByText(/^Your home page is empty\./)).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  },
};

/**
 * A pane too narrow for a readable cell: **the stack**. One card per row in reading order, each at
 * the canvas's full width and at the height its footprint has on the narrowest readable grid. There
 * is no grid to drop on, so Customize grows no grip and no resize corner — the size steppers in each
 * card's settings still write the footprint the wide page uses.
 */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className={MAIN_NARROW}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Summary" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await expect(canvas.queryByRole("button", { name: "Move Summary" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Resize Summary" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Settings for Summary" })).toBeInTheDocument();
  },
};

/**
 * A document holding a widget this build has never heard of — **the feature's central promise,
 * drawn**. `HomeWidget.kind` is a free `string` on the wire, `home.rs` refuses no kind, `parseLayout`
 * keeps it and `renderBody`'s `default` arm draws it: a card saying where it came from, with its
 * opaque `config` untouched underneath, and its tray intact.
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

    // The widgets this build does know are drawn beside it, and nothing the seed holds that this
    // document does not — the document is the reader's, not a merge.
    await expect(canvas.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: "Folders" })).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await expect(
      unknown.getByRole("button", { name: "Remove Unknown widget (priceHistory)" }),
    ).toBeInTheDocument();
  },
};

/**
 * An add made while a sync holds the write connection — **the press lands anyway**.
 *
 * `set_home_layout` answers `BUSY` while a sync has the database, which the fake honours on every
 * write. The writes are optimistic and deliberately not rolled back: the cache is written before the
 * command is sent, and a refused write keeps the reader's page for this session and says nothing.
 * Snapping a widget back off the page under the reader's hand, with nothing on screen saying why, is
 * worse than losing one launch's memory of the arrangement.
 */
export const WhileTheDatabaseIsBusy: Story = {
  args: { layout: JUST_SUMMARY },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Customize" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add widget" }));
    const dialog = within(
      await canvas.findByRole("dialog", { name: "Widget catalogue" }, MOUNT_TIMEOUT),
    );
    await userEvent.click(dialog.getByRole("button", { name: "Add Set completion" }));

    await expect(
      await canvas.findByRole("region", { name: "Set completion" }, MOUNT_TIMEOUT),
    ).toBeInTheDocument();
    // And nothing is said about the refusal: there is no error banner on this page, by design.
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Summary" })).toBeInTheDocument();
  },
};
/**
 * The dashboard at 150%, which is where the gesture this page grew leaves it.
 *
 * **The zoom is a CSS `zoom` on the grid box, and it is the only one in this app.** Every other wall
 * spends its `cardZoom` number as a multiplier on a tile's width, because a card is a picture and a
 * picture's size is the question. A widget is a box of *type*: a bigger box at the same type size is
 * not a zoomed dashboard, it is the same dashboard showing more small rows — the opposite of the
 * gesture. `zoom` is a layout scale rather than a paint one, so cells, cards, titles, figures and
 * rows all move together, and `fit.ts` never had to learn the word.
 *
 * What the page owes it is one division: the canvas is measured **outside** the zoom and the columns
 * are computed against `width / zoom`. That is the whole of how a zoom takes tiles away — 1032px is
 * nine columns at life size and 688 local px, six columns, at this one.
 *
 * **In this workbench's Vitest runner this story is stacked like every other**: jsdom measures the
 * canvas at `0` and implements no `zoom` at all. So the play below asserts the one thing that holds
 * in both runtimes — that the property reached the grid box and not the ruler above it. What it does
 * to a painted box belongs to a browser, and the figures are in `HomePage.tsx`'s module doc.
 *
 * Written during render, and in its own frame, for `DecksPage.stories.tsx`' two reasons: an effect
 * would draw one frame at 100% on the way here, and `useAppStore` is a module singleton, so a write
 * during an inline render would be the last writer and would quietly resize every story on the page.
 */
function ZoomedPage(): ReactElement {
  useState(() => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, home: 1.5 } });
  });
  return <Page layout={null} />;
}

export const Zoomed: Story = {
  render: () => <ZoomedPage />,
  parameters: { docs: { story: { inline: false, height: "680px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Summary" }, MOUNT_TIMEOUT);

    const ruler = canvasElement.querySelector<HTMLElement>(`[${HOME_CANVAS_ATTR}]`);
    // The measured canvas is never scaled — it is the ruler, and a scaled ruler has nothing to
    // divide. The box inside it is what carries the reader's number.
    await expect(ruler).not.toHaveStyle({ zoom: "1.5" });
    await expect(ruler?.firstElementChild).toHaveStyle({ zoom: "1.5" });
  },
};
