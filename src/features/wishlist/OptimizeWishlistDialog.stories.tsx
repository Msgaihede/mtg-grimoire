import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { WishlistOptimizePlan, WishOptimizeMove } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { OptimizeWishlistDialog } from "./OptimizeWishlistDialog";

/**
 * How long a `waitFor` will wait for one animation frame.
 *
 * The dialog fades and scales in, so its first painted frame is at `opacity: 0` — and
 * `toBeVisible` walks the ancestors, so *nothing* inside it is visible until that lands.
 * `PullFromCollectionDialog.stories.tsx`'s constant, and its whole reasoning.
 */
const FRAME_WAIT = 5_000;

/**
 * The panel's scrolling body.
 *
 * The outcome's headline is deliberately in the DOM **twice** — once visibly here, and once in
 * the footer's permanently mounted `sr-only` live region, which is the only arrangement that
 * announces anything (a region that appears with its sentence already inside is a region nothing
 * noticed changing). So an assertion about that sentence has to say which of the two it means.
 */
const bodyOf = (canvasElement: HTMLElement): HTMLElement =>
  canvasElement.querySelector("footer")?.previousElementSibling as HTMLElement;

function move(over: Partial<WishOptimizeMove> & Pick<WishOptimizeMove, "wishId" | "name">) {
  const base: WishOptimizeMove = {
    wishId: 0,
    name: "",
    quantity: 1,
    preferredFinish: null,
    folderId: null,
    from: { cardId: "from", setCode: "lea", collectorNumber: "161", lang: "en", price: 5 },
    to: { cardId: "to", setCode: "2x2", collectorNumber: "117", lang: "en", price: 2 },
    savedPerCopy: 3,
    saved: 3,
  };
  return { ...base, ...over };
}

/** The ordinary row: the same card, cheaper, in the same language — four copies, so the saving
 *  column has to show its arithmetic. */
const BOLT = move({
  wishId: 1,
  name: "Lightning Bolt",
  quantity: 4,
  from: { cardId: "bolt-lea", setCode: "lea", collectorNumber: "161", lang: "en", price: 5.5 },
  to: { cardId: "bolt-2x2", setCode: "2x2", collectorNumber: "117", lang: "en", price: 0.5 },
  savedPerCopy: 5,
  saved: 20,
});

/**
 * The row this preview exists for: the cheapest printing is **Japanese**.
 *
 * A saving is a saving and the backend is right to offer it, but a reader who wanted English
 * cardboard has to be able to see that and untick it — which is why `lang` is drawn on both
 * sides of every row rather than only where it differs.
 */
const RAGAVAN = move({
  wishId: 2,
  name: "Ragavan, Nimble Pilferer",
  quantity: 1,
  preferredFinish: "foil",
  from: { cardId: "rag-mh2", setCode: "mh2", collectorNumber: "138", lang: "en", price: 68 },
  to: { cardId: "rag-jp", setCode: "mh2", collectorNumber: "138", lang: "ja", price: 41.25 },
  savedPerCopy: 26.75,
  saved: 26.75,
});

/**
 * The unpriced case: this marketplace has never listed the printing the wish is pinned to.
 *
 * It is offered, drawn `— → $2.30`, counted as no saving and **left unticked** — an unlisted
 * printing may be cheap rather than dear, so the app has no basis for calling the swap an
 * improvement. The reader may well know better, which is why it is a row rather than a silence.
 */
const RHYSTIC = move({
  wishId: 3,
  name: "Rhystic Study",
  quantity: 2,
  from: { cardId: "rhy-pcy", setCode: "pcy", collectorNumber: "45", lang: "en", price: null },
  to: { cardId: "rhy-jmp", setCode: "j21", collectorNumber: "13", lang: "en", price: 2.3 },
  savedPerCopy: null,
  saved: null,
});

const planOf = (
  moves: WishOptimizeMove[],
  over: Partial<Omit<WishlistOptimizePlan, "moves">> = {},
): WishlistOptimizePlan => ({
  moves,
  considered: moves.length + 9,
  alreadyCheapest: 8,
  skipped: 1,
  ...over,
});

/**
 * One press that re-points every pinned wish onto the cheapest printing of the same card, and the
 * preview that stands between it and a shopping list nobody could trust (issue #352).
 *
 * **It reaches nothing** — no query, no mutation, no fake world. The plan, its two read states,
 * the marketplace and the write all arrive as props, which is `PullFromCollectionDialog`'s fence:
 * every frame below is an argument rather than a seeded database, and a stray query added to the
 * component later would break these stories rather than pass them.
 */
const meta = {
  title: "Wishlist/OptimizeWishlistDialog",
  component: OptimizeWishlistDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    scope: { folder: "Wishlist", flatten: false, filtered: false },
    plan: planOf([BOLT, RAGAVAN, RHYSTIC]),
    loading: false,
    readError: null,
    marketplace: MARKETPLACES.tcgplayer,
    apply: {
      mutate: fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    },
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A wish pinned from a search result is pinned to whatever printing the reader " +
          "happened to be looking at, which is very often not the cheap one. This is the sweep " +
          "that fixes that in bulk — and the preview that keeps it from being a silent " +
          "rewrite of somebody's shopping list.\n\n" +
          "**`wishlist_optimize_plan` writes nothing.** It answers where each pinned wish is, " +
          "where the cheapest printing of the same card is, and the difference between the " +
          "two; only the rows the reader leaves ticked reach `wishlist_optimize_apply`.\n\n" +
          "**Two minorities are the whole reason there is a body at all.** A cheaper printing " +
          "in another language is a real answer and a reasonable thing to refuse, so `lang` is " +
          "drawn on *both* sides of every row. And a wish whose current printing this " +
          "marketplace does not list is offered, drawn `— → $2.30`, counted as no saving and " +
          "left unticked: an unlisted printing may be cheap rather than dear.\n\n" +
          "**The scope is the rows on screen.** The plan takes the same query the list was " +
          "drawn from — the folder, the Flatten switch and every active filter — so the " +
          "subtitle says where it looked and the footer says what it passed over.\n\n" +
          "**It stays open afterwards.** The page underneath has no place for a transient " +
          "sentence, and a wish that folded into one the reader already had is the app's own " +
          "merge rule rather than a card going missing.",
      },
    },
  },
} satisfies Meta<typeof OptimizeWishlistDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The preview: three rows, two of them ticked, and every shape this list has in one frame.
 *
 * The play presses through to the wire rather than stopping at the screen, because the claim
 * worth making is about what would be *written*: the unpriced row is not in the payload, and
 * every item that is carries the printing it comes **from** as well as the one it goes to —
 * the guard that leaves a wish alone if a sync has moved it since this panel was drawn.
 */
export const Preview: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    // Both printings, both languages: the Japanese swap is visible before it is applied.
    await expect(canvas.getByText("MH2 · 138 · JA")).toBeVisible();

    // The unpriced row draws an em dash and opens unticked, so the headline cannot be inflated
    // by a saving nobody quoted.
    const rhystic = canvas.getByRole("checkbox", { name: /^Switch Rhystic Study/ });
    await expect(rhystic).not.toBeChecked();
    await expect(within(rhystic.closest("li")!).getByText("No saving to count")).toBeVisible();

    await expect(canvas.getByRole("button", { name: "Switch 2 wishes" })).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Switch 2 wishes" }));
    await expect(args.apply.mutate).toHaveBeenCalledWith([
      { wishId: 1, fromCardId: "bolt-lea", toCardId: "bolt-2x2" },
      { wishId: 2, fromCardId: "rag-mh2", toCardId: "rag-jp" },
    ]);
  },
};

/**
 * The reader takes the language swap out.
 *
 * One press changes three things at once and they have to agree: the count in the strip, the
 * total in the footer and the verb on the button. They are one derivation (`optimizePlan.ts`)
 * precisely so they cannot come apart.
 */
export const UntickingARow: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await userEvent.click(canvas.getByRole("checkbox", { name: /^Switch Ragavan/ }));

    await expect(canvas.getByText("1 of 3 selected")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Switch 1 wish" })).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Switch 1 wish" }));
    await expect(args.apply.mutate).toHaveBeenCalledWith([
      { wishId: 1, fromCardId: "bolt-lea", toCardId: "bolt-2x2" },
    ]);
  },
};

/**
 * The select-all, from half-ticked to all of them.
 *
 * Three states rather than two: a checkbox that only knew "all" and "not all" would empty a
 * half-ticked list on its first press, and the press a reader wants from a half-ticked list is
 * *the rest of them*. Taking everything includes the unpriced row, which is legitimate because
 * the reader is saying so by hand.
 */
export const SelectingEverything: Story = {
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    const all = canvas.getByRole("checkbox", { name: "Select all" });
    await expect(all).toBePartiallyChecked();

    await userEvent.click(all);
    await expect(all).toBeChecked();
    await expect(canvas.getByText("3 of 3 selected")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Switch 3 wishes" })).toBeVisible();
  },
};

/**
 * Flattened: the sweep covers every drawer, so each row says which one it came out of.
 *
 * The subtitle changes with it — there is no level to name when the filing is being ignored, and
 * the folder the reader last stood in is not what is being swept.
 */
export const Flattened: Story = {
  args: {
    scope: { folder: "Ordered", flatten: true, filtered: true },
    plan: planOf([
      { ...BOLT, folderId: 1 },
      { ...RAGAVAN, folderId: 2 },
    ]),
    folderNameOf: (id: number | null) =>
      id === 1 ? "Ordered" : id === 2 ? "Backordered" : "Wishlist",
  },
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    await expect(canvas.getByText("Every folder, matching your filters")).toBeVisible();
    await expect(canvas.getByText("in Backordered")).toBeVisible();
  },
};

/**
 * Nothing to change — and the good news is the whole message.
 *
 * A reader who has just pressed a button expecting a list reads a blank panel as broken, so the
 * panel says *why* there isn't one: every wish here is already as cheap as this marketplace
 * makes it, and an "any printing" wish is cheapest by construction.
 */
export const AlreadyCheapest: Story = {
  args: { plan: planOf([], { considered: 12, alreadyCheapest: 11, skipped: 1 }) },
};

/**
 * Nothing to check — which is a different fact, and is fixed by a different act.
 *
 * The sweep had nothing in front of it: the folder is empty, or the filters are. Telling this
 * apart from the state above is the whole reason there are two of them.
 */
export const NothingInScope: Story = {
  args: {
    scope: { folder: "Someday", flatten: false, filtered: true },
    plan: planOf([], { considered: 0, alreadyCheapest: 0, skipped: 0 }),
  },
};

/** The sweep is in flight. It is the widest read this page makes, and it starts only when the
 *  dialog opens. */
export const Checking: Story = {
  args: { plan: null, loading: true },
};

/** The read's own refusal, in the backend's words, where the rows would have been. No retry
 *  button: the query re-runs the next time this opens. */
export const ReadFailed: Story = {
  args: { plan: null, readError: "database is locked" },
};

/**
 * What the press actually did — **the dialog stays open to say it**.
 *
 * Four things a reader is owed: how many wishes moved, how many folded into a wish they already
 * had (the app's documented merge rule, not a card going missing), what was really saved, and
 * **which rows were left alone**. That last one is why this is a panel rather than a line: a
 * skipped change reported as a number is a change nobody can go and look at.
 */
export const Done: Story = {
  args: {
    apply: {
      mutate: fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: {
        results: [
          { wishId: 1, status: "changed" },
          { wishId: 2, status: "merged" },
          { wishId: 3, status: "stale" },
        ],
      },
    },
  },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(async () => expect(await canvas.findByRole("dialog")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    const body = within(bodyOf(canvasElement));
    await expect(
      body.getByText("Switched 2 wishes to the cheapest printing, saving $46.75."),
    ).toBeVisible();
    // The merge is the app's documented rule rather than a card going missing, and the skipped
    // row is named rather than counted.
    await expect(
      body.getByText(/folded into a wish you already had in the same folder/),
    ).toBeVisible();
    await expect(body.getByText(/^Rhystic Study — its printing had already changed/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Done" })).toBeVisible();
  },
};

/** A refused write, reported beside the button that was pressed rather than on the page behind
 *  the scrim — a refusal a reader has to go looking for is one they will not find. */
export const WriteFailed: Story = {
  args: {
    apply: {
      mutate: fn(),
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new Error("database is locked"),
      data: undefined,
    },
  },
};
