import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WishlistPage } from "./WishlistPage";

const meta = {
  title: "Wishlist/Page",
  component: WishlistPage,
  tags: ["autodocs"],
  decorators: [
    // The page is `h-full`, so it needs a parent with a height or the virtualiser is handed a
    // 0px window. 1032px is exactly the content column at the 1280×800 window
    // `tauri.conf.json:16-17` opens: 1280 less the sidebar's `w-52` (208px) and less `main`'s
    // `p-5` on both sides (40px), from `AppShell.tsx:92` and `AppShell.tsx:144`. The height is
    // chosen rather than derived — the ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The thin mirror of the collection: a shopping list, not an inventory. One list and " +
          "no layout toggle — a shopping list is read by name, and forty pieces of art answer " +
          "none of what it is for.\n\n" +
          "Driven end to end by `.storybook/fake/`. The **five seeded wishes are five different " +
          "answers to “is this filled?”**, and every one of them is arithmetic the fake really " +
          "does rather than a number written into a fixture — `wishlist::OWNED_SQL` is mirrored " +
          "at `db.ts:774-783`. Measured 2026-08-10 over " +
          '`readHandlers(seed("starter")).wishlist_list`: Counterspell 2 of 4, Jace 0 of 1, ' +
          "the **foil** Ragavan 0 of 1 with a nonfoil in the binder, Rhystic Study 0 of 1, and " +
          "the any-printing Sol Ring **2 of 1** — fulfilled twice over, because a wish naming no " +
          "printing is filled by every printing of the card.\n\n" +
          "**Zero deletes here, and the collection's zero does not.** `wishlist_set_quantity(0)` " +
          "removes the row (`db.ts:1968-1977`, mirroring the table's `CHECK (quantity > 0)`) " +
          "because a wish for none of something is not a wish. **But the stepper cannot reach " +
          "zero**: it is `min={1}` (`WishlistTable.tsx:146`), because a stepper that deleted a row " +
          "when held down would be a one-way door with no undo. Removal is its own control, and " +
          "{@link Removed} is the story of it — there is no story of a wish stepped to zero, " +
          "because the UI does not offer one.\n\n" +
          "**There is no `Large` story, and that is a fact about the seeds rather than about " +
          'this page.** `seed: "large"` builds 5 243 cards and 600 collection entries and ' +
          "**no wishes at all** — `seeds.ts:734-736` says so in as many words, and " +
          "`wishlist_list` answers `total: 0` under it (measured 2026-08-10). A story named " +
          "`Large` would render the zero state {@link Empty} already covers, under a name " +
          "promising depth. Closing it means seeding wishes into `largeSeed`, which is a change " +
          "to a fixture every other story file reads.",
      },
    },
  },
} satisfies Meta<typeof WishlistPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Five wishes, and the one number the view exists for.
 *
 * The total is counted over what is **missing** rather than over what is wanted: a figure that
 * charged the reader for cards already in the binder is a number nobody can act on. So the
 * fulfilled Sol Ring contributes nothing, and $158.06 is Counterspell's two missing copies plus
 * Jace plus the foil Ragavan plus Rhystic Study.
 *
 * **One tile, not the two this story used to assert.** The page drew `Still to buy (USD)` beside
 * `Still to buy (EUR)` while there was no way for a reader to say which they were shopping in;
 * the marketplace setting is that way, so the figure follows it and the label carries the
 * currency. There is no euro node on screen here at all — this is the default world, which is
 * TCGplayer. The euro arithmetic is covered where it can be asserted against a chosen
 * marketplace rather than a world default: `WishlistPage.test.tsx`, and
 * `Collection/SummaryHeader`'s `InEuros`, whose header takes its marketplace as a prop.
 *
 * The unpriced counters stay two fields behind it, because the two currencies do not have the
 * same holes — `eur_etched` does not exist in Scryfall's data, so the same card can be priced in
 * dollars and unpriced in euros. Neither counter shows here: every wish with copies still to
 * find is priced in both.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("$158.06")).toBeInTheDocument();
    await expect(canvas.getByText("Still to buy (USD)")).toBeInTheDocument();
    await expect(canvas.queryByText("€94.62")).not.toBeInTheDocument();
    // What assistive tech is told the list is: every matching row plus the header
    // (`VirtualTable.tsx:181`), not the rows a virtualised list keeps in the DOM. A wishlist
    // total is counted in full, so there is no unknown-count case here — unlike the search's.
    await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "6",
    );
    // **The Needs review chip is not drawn**, and its absence is the rule rather than an
    // oversight: `WishlistFilterBar.tsx:21` offers it only where there is something to filter, so
    // a list nothing flagged does not carry a control that would spend its whole life saying
    // nothing. {@link NeedsReview} is the same page with the chip.
    await expect(canvas.queryByRole("button", { name: "Needs review" })).toBeNull();
  },
};

/**
 * A foil wish reading nothing owned, with a nonfoil of the same printing in the binder.
 *
 * This is why finish is part of what makes two wishes two wishes. `ownedAgainstWish` narrows by
 * the wish's `preferredFinish` when it names one (`db.ts:774-783`), so the seeded nonfoil
 * Damaged Ragavan (`.storybook/fake/seeds.ts:239-241`) fills none of the seeded foil wish
 * (`seeds.ts:279`) — 0 of 1, beside a collection that holds one.
 *
 * Condition is deliberately *not* a term in that count: a wishlist has nowhere to say "and in
 * NM", so a Damaged copy would fill a finish-blind wish completely.
 */
export const FoilWishUnfilled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Found by its printing rather than by "0 of 1 owned", which is **three** of the five seeded
    // wishes — Jace and Rhystic Study read the same because nothing in the binder covers them
    // either, and only this one reads it with a copy of the card sitting a view away. The
    // printing column carries set, number **and** finish, because those three together are what
    // identify a wish; it is the one column here that cannot be given a fixed width and stay
    // honest.
    const row = (await canvas.findByText("MH2 · 138 · Foil")).closest('[role="row"]');
    await expect(row).not.toBeNull();
    await expect(within(row as HTMLElement).getByText("0 of 1 owned")).toBeInTheDocument();
    // And the same three ride in the stepper's accessible name, which is the half no screenshot
    // shows: two wishes for one card differ only by printing and finish, so "Copies wanted of
    // Ragavan, Nimble Pilferer" alone would be two identical controls in one list as far as a
    // screen reader or a voice driver is concerned.
    await expect(
      canvas.getByRole("spinbutton", {
        name: "Copies wanted of Ragavan, Nimble Pilferer (MH2 138, Foil)",
      }),
    ).toHaveValue(1);
  },
};

/**
 * The `fulfilled` chip, both ways round.
 *
 * One chip and three states, and **the word on it is what says which is on** — an unpressed chip
 * cannot mean "still missing" and also be the same chip that means it when pressed. "Still
 * missing" is the first press because that is the question a shopping list is usually open for;
 * the search's twin starts from the other end for the same reason.
 *
 * The two halves are a partition of the same five wishes, so the story asserts a named row on
 * each side rather than a count: the any-printing Sol Ring is the one the collection covers (2 of
 * 1), and Counterspell is one of the four it does not (2 of 4).
 */
export const FulfilledAndUnfulfilled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Sol Ring");
    await expect(canvas.getByText("Counterspell")).toBeInTheDocument();

    // Off → still missing.
    await userEvent.click(canvas.getByRole("button", { name: "Still missing" }));
    await waitFor(async () => {
      await expect(canvas.queryByText("Sol Ring")).toBeNull();
    });
    await expect(canvas.getByText("Counterspell")).toBeInTheDocument();

    // Still missing → fulfilled. The chip is pressed either way, so it is the label that has
    // just changed, and it is the label the next press has to be addressed by.
    await userEvent.click(canvas.getByRole("button", { name: "Still missing" }));
    await waitFor(async () => {
      await expect(canvas.getByText("Sol Ring")).toBeInTheDocument();
    });
    await expect(canvas.queryByText("Counterspell")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Fulfilled" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * A shopping list nobody has written on yet.
 *
 * "Nothing on your wishlist yet. Add cards from search with the + on any row or tile." — a
 * statement about the wishlist, naming the control that fills it. `statusOf` chooses it on
 * `activeCount === 0`; with a filter on, the same empty list says "No wishes match these
 * filters", which is a statement about the filters instead.
 *
 * Both money figures read an em dash rather than $0.00 — a list that claims to be worth nothing
 * is worse than one that has not said.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Nothing on your wishlist yet. Add cards from search with the + on any row or tile.",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A wish a sync left a question against — **listed, counted, and asking to be looked at**.
 *
 * The reconciler walks `wishlist_entries` as well as `collection_entries`, so its sentence is a
 * band under the row it belongs to, drawn across the whole row because it is a sentence and not a
 * column. The row grows by `REVIEW_HEIGHT` and the virtualiser is told so through `extraHeight` —
 * a list told every row is the same height would overlap the one below it by exactly that band.
 *
 * The seeded sentence is `reconcile::flag_deleted`'s, copied verbatim with its date into
 * `.storybook/fake/seeds.ts:476`. It is the flagged row's *whole* explanation, and the second
 * half of it is what to do about it — which is why the band carries the sentence as a `title` as
 * well, and why a screen reader gets all of it either way.
 *
 * The **Needs review** chip appears with the row, and only with it ({@link Default} asserts it
 * absent). It stays while the filter is on, including on the complement, where by definition no
 * row on screen carries a flag and the chip is the only way back off.
 */
export const NeedsReview: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Scryfall removed this printing from its database on 2026-07-31\./),
    ).toBeInTheDocument();
    // The flag lists and never hides: the five unflagged wishes are still here with it, and the
    // count in the header still counts all six.
    await expect(canvas.getByText("Counterspell")).toBeInTheDocument();
    await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "7",
    );
    await expect(canvas.getByRole("button", { name: "Needs review" })).toBeInTheDocument();
  },
};

/**
 * A write the database refused.
 *
 * `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the list underneath is untouched.
 * The alert is a `role="alert"` of its own rather than a line folded into the status above it:
 * that one describes the list, and this one describes something the reader just did to it.
 *
 * Counterspell rather than one of the four wishes at quantity 1, because the stepper is `min={1}`
 * and its Decrease button is disabled at the floor — a refusal story has to press a control that
 * would otherwise have worked.
 *
 * The stepper is optimistic on the row's own number, so this also exercises the rollback:
 * `onError` restores the snapshot `onMutate` took, and the box goes back to 4.
 */
export const Busy: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Copies wanted of Counterspell (MH2 267)";
    await userEvent.click(await canvas.findByRole("button", { name: `Decrease ${label}` }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change your wishlist — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(4);
    });
  },
};

/**
 * Crossing a line off the list.
 *
 * **Removal is offered on every row here, where the collection offers it only on an emptied one**
 * (`WishlistTable.tsx:203-206`). The two lists mean opposite things by deletion: losing a
 * collection entry loses the record of something owned — its condition, its price, the story of
 * where it came from — while crossing a line off a shopping list is what a shopping list is for.
 *
 * The row removed is the any-printing Sol Ring, whose accessible name is the whole of what
 * distinguishes it: `wishLabel` writes "any printing" where a pinned wish writes its set and
 * number, because a wish with no `card_id` is for the *card* and there is no printing to name.
 * (It is also the reason that row is not a drag source and not clickable: there is no printing
 * for a drop or a pane to be about.)
 *
 * The header moves with it. Every page carries the same count of the whole list, so `patchWish`
 * decrements each page's copy — otherwise the figure the *first* page feeds would go on counting
 * a wish that is gone.
 */
export const Removed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Sol Ring");

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Sol Ring (any printing) from your wishlist" }),
    );

    await waitFor(async () => {
      await expect(canvas.queryByText("Sol Ring")).toBeNull();
    });
    await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "5",
    );
    // A removal that succeeded says nothing: the row going is the whole report.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
