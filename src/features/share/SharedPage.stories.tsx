import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FRIEND_SHARE_URL } from "../../../.storybook/fake/seeds";
import { useAppStore } from "@/lib/store";
import { SharedPage } from "./SharedPage";

/**
 * The view, with the links the store would be holding when a reader arrives at it.
 *
 * `openedShares` is the store's, and it is the *only* way into this page — a share is opened by
 * pasting a link, and the head of that list is the binder on screen. So a story cannot pass one
 * as a prop. `useState`'s lazy initializer is `WishlistPage.stories.tsx`'s answer to that and for
 * its reason: an effect runs after the first paint, so a story would draw the empty state for one
 * frame first.
 *
 * The list is written and **not** the active view: `openShare` deliberately does not navigate,
 * because the paste dialog is opened from inside this view as well as from outside it.
 */
function Page({ open }: { open: string[] }) {
  useState(() => {
    useAppStore.setState({ openedShares: open });
  });
  return <SharedPage />;
}

const meta = {
  title: "Share/Shared collection",
  component: Page,
  tags: ["autodocs"],
  args: { open: [FRIEND_SHARE_URL] },
  // Keyed on the links, so changing them in Controls remounts and the initializer above runs
  // again rather than writing to a store the mounted page is already subscribed to.
  render: (args) => <Page key={args.open.join("|")} {...args} />,
  decorators: [
    // `AppShell`'s `main`, which is the scroller this view grows inside — and `relative` with
    // it, which is this app's rule for any box carrying an `overflow`. 1032px is the content
    // column at a 1280-wide window: 1280 less the sidebar's `w-52` and less `main`'s `p-5` on
    // both sides.
    (Story) => (
      <div className="relative h-[720px] w-[1032px] overflow-auto">
        <Story />
      </div>
    ),
  ],
  parameters: {
    // The `shared` seed: `starter` connected, with one drawer of its own published and a link
    // from Giradeli waiting to be opened. Both halves, because sharing has two sides.
    fake: { seed: "shared" },
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`.
       *
       * Every story in this file writes `openedShares` during render, and the store is a module
       * singleton `.storybook/` cannot make per-story. Inline, an autodocs page mounts every
       * story at once and the last to render would own the store for all of them — the empty
       * state and the binder both drawing whichever won.
       */
      story: { inline: false, height: "760px" },
      description: {
        component:
          "Somebody else's collection, read **inside the app** — and the one thing this view " +
          "can do that the public web page cannot is the reason it exists: every row is " +
          "cross-referenced against what the reader already owns and already wants. A binder is " +
          "only worth scrolling if you can see what is in it that you have been looking for.\n\n" +
          "It renders a **fetched document** and writes nothing to it. `readOnly.test.ts` is " +
          "that fence and it is a source sweep, because there is no read-only mode anywhere on " +
          "this app's data path to assert against. The one write in the whole directory is the " +
          "want list below, and it writes the reader's **own** wishlist.\n\n" +
          "Driven end to end by `.storybook/fake/`. The `shared` seed puts Giradeli's binder on " +
          "the relay and `share_open` derives the wire document from rows — so the two absences " +
          "the format has are real here rather than written into a fixture: Jace is **ungraded** " +
          "and carries no condition at all while the snapshot advertises one, and the Secret " +
          "Lair Sol Ring has no price at any marketplace. Both draw an em dash.\n\n" +
          "**The tick on a card appears only once the cross-reference has answered.** Until both " +
          "of `useOwnedIndex`'s sweeps land every card reads *wanted 0*, so a want list built in " +
          "that window would offer to add cards the reader already wants with nothing on screen " +
          "saying so. The same gate draws the figure line, which is why they arrive together.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A binder somebody sent, with the reader's own two figures under every card.
 *
 * The four rows worth reading are all cross-references rather than fixtures: the Lightning Bolt
 * the reader already has a playset of, the Rhystic Study they have written down **twice**, the
 * foil Ragavan against the nonfoil in their binder, and the Swords to Plowshares they neither own
 * nor want.
 */
export const Binder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(async () => {
      await expect(canvas.getByRole("heading", { level: 2 })).toHaveAccessibleName(
        "Giradeli’s Trade binder",
      );
    });
    // The figures, once both sweeps have landed — and the wait is the point rather than
    // ceremony, because the tile draws no figure line at all before they do.
    await waitFor(async () => {
      await expect(canvas.getByText("You own 4")).toBeInTheDocument();
    });
    const rhystic = within(canvas.getByRole("listitem", { name: /^Rhystic Study/ }));
    await expect(rhystic.getByText("You own 0")).toBeInTheDocument();
    await expect(rhystic.getByText("You want 2")).toBeInTheDocument();
  },
};

/**
 * Tick two cards and send them to a wishlist folder the reader already has — spec decision 8,
 * and the one write this directory makes.
 *
 * The dialog says which of the picked cards are **already** on the list, because `wishlist_add`
 * folds onto the wishlist's grain: a second add raises the count rather than doing nothing, which
 * is the right behaviour and the wrong surprise.
 */
export const WantList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tick = async (name: string) => {
      await userEvent.click(await canvas.findByRole("checkbox", { name: `Pick ${name}` }));
    };

    // The tick is gated on the cross-reference, so waiting for it is waiting for the figures.
    await tick("Rhystic Study");
    await tick("Swords to Plowshares");
    await expect(canvas.getByText("2 picked")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Add to wishlist" }));
    await waitFor(async () => {
      await expect(canvas.getByRole("option", { name: "Ordered" })).toBeInTheDocument();
    });
    // One of the two is already written down and the other is not, which is exactly what makes
    // this sentence worth drawing rather than a count of everything picked.
    await expect(
      canvas.getByText("1 of these 2 cards is already on your wishlist. Adding raises its count."),
    ).toBeInTheDocument();

    await userEvent.selectOptions(canvas.getByLabelText("Add them to"), "1");
    await userEvent.click(canvas.getByRole("button", { name: "Add 2 cards" }));

    // The verb the button used, in the past tense, naming the destination the reader chose —
    // said in the view, because the dialog has closed over it.
    await waitFor(async () => {
      await expect(canvas.getByText("Added 2 cards to Ordered.")).toBeInTheDocument();
    });
    // And the picks are put down: a bar still reading *2 picked* over cards that are now on the
    // wishlist invites the same press twice.
    await expect(canvas.queryByText("2 picked")).toBeNull();
  },
};

/**
 * A link that has gone dark — withdrawn by its owner, or darkened when their membership ended.
 *
 * **One sentence for two causes**, and that is the crate's decision rather than a shortcut: the
 * Worker answers 410 with the difference in the rendered HTML rather than in a code, so an app
 * that claimed to know which had happened would be reading prose. It is the `shareLapsed` fault,
 * which exists because it is the one refusal in this flow a reader cannot produce by typing —
 * every other way a paste fails is a shape the handler raises from what it was given.
 */
export const Gone: Story = {
  parameters: { fake: { seed: "shared", fault: "shareLapsed" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(async () => {
      await expect(
        canvas.getByText("That shared collection is no longer available."),
      ).toBeInTheDocument();
    });
    // Two ways out and no third: the link cannot be revived from this side.
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Close this collection" })).toBeInTheDocument();
  },
};

/**
 * A reader who has never opened a link.
 *
 * An empty screen is an invitation to act, so the sentence says what a shared collection *is* and
 * the control does the one thing there is to do. It is also the only entry point that exists
 * before the cabinet grows its own Share control.
 */
export const NothingOpened: Story = {
  args: { open: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByRole("heading", { name: "Open a collection somebody shared with you" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Open a shared collection" }),
    ).toBeInTheDocument();
  },
};
