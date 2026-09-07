import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  WishlistOptimizePlan,
  WishOptimizeApplyItem,
  WishOptimizeMove,
  WishOptimizeResult,
  WishOptimizeStatus,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { OptimizeWishlistDialog, type OptimizeWrite } from "./OptimizeWishlistDialog";

/**
 * The dialog holds no query and no mutation, so there is no `QueryClientProvider` here and no ipc
 * mock — everything it draws arrives as a prop. That fence is the component's own (see its file
 * doc) and this file is what proves it still holds: the day somebody reaches for a hook in there,
 * every case below fails with a missing-provider throw rather than passing quietly.
 *
 * No `TooltipProvider` either: `useTooltip` answers a documented no-op without one, and nothing
 * here asserts on a hover.
 */
const TCG = MARKETPLACES.tcgplayer;

function move(
  wishId: number,
  {
    name = `Card ${wishId}`,
    quantity = 1,
    perCopy,
    toPrice = 2,
    preferredFinish = null,
    fromLang = "en",
    toLang = "en",
    folderId = null,
  }: {
    name?: string;
    quantity?: number;
    /** `null` is the unpriced-current case — no price on `from`, no figure on either saving. */
    perCopy: number | null;
    toPrice?: number;
    preferredFinish?: WishOptimizeMove["preferredFinish"];
    fromLang?: string;
    toLang?: string;
    folderId?: number | null;
  },
): WishOptimizeMove {
  return {
    wishId,
    name,
    quantity,
    preferredFinish,
    folderId,
    from: {
      cardId: `from-${wishId}`,
      setCode: "lea",
      collectorNumber: String(160 + wishId),
      lang: fromLang,
      price: perCopy === null ? null : toPrice + perCopy,
    },
    to: {
      cardId: `to-${wishId}`,
      setCode: "2x2",
      collectorNumber: String(100 + wishId),
      lang: toLang,
      price: toPrice,
    },
    savedPerCopy: perCopy,
    saved: perCopy === null ? null : perCopy * quantity,
  };
}

const planOf = (
  moves: WishOptimizeMove[],
  over: Partial<Omit<WishlistOptimizePlan, "moves">> = {},
): WishlistOptimizePlan => ({
  moves,
  considered: moves.length,
  alreadyCheapest: 0,
  skipped: 0,
  ...over,
});

/** An idle write — nothing pressed, nothing pending, nothing answered. */
function idleWrite(over: Partial<OptimizeWrite> = {}): OptimizeWrite {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    ...over,
  };
}

const outcomeWrite = (results: WishOptimizeResult[]): OptimizeWrite =>
  idleWrite({ isSuccess: true, data: { results } });

const result = (wishId: number, status: WishOptimizeStatus): WishOptimizeResult => ({
  wishId,
  status,
});

function draw(over: Partial<Parameters<typeof OptimizeWishlistDialog>[0]> = {}) {
  const props = {
    open: true,
    scope: { folder: "Wishlist", flatten: false, filtered: false },
    plan: planOf([move(1, { perCopy: 3 })]),
    loading: false,
    readError: null,
    marketplace: TCG,
    apply: idleWrite(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(<OptimizeWishlistDialog {...props} />) };
}

/** The row for one wish, found by the checkbox that names it. */
const rowFor = (name: string | RegExp): HTMLElement =>
  screen.getByRole("checkbox", { name: typeof name === "string" ? new RegExp(name) : name })
    .closest("li") as HTMLElement;

const applyButton = () => screen.getByRole("button", { name: /^Switch/ });

/**
 * The panel's two halves, scoped apart.
 *
 * The outcome's headline is deliberately in the DOM **twice** — once visibly in the body, and once
 * in the footer's permanently-mounted `sr-only` live region, which is the only arrangement that
 * announces anything (a region that appears with its sentence already inside is a region nothing
 * noticed changing). So every assertion about a sentence or a figure has to say which half it
 * means, or it matches both and the query throws.
 */
const footer = () => screen.getByRole("dialog").querySelector("footer") as HTMLElement;
const body = () => footer().previousElementSibling as HTMLElement;

describe("OptimizeWishlistDialog", () => {
  it("names the scope in its subtitle", () => {
    draw({ scope: { folder: "Ordered", flatten: false, filtered: true } });
    expect(screen.getByText("Ordered, matching your filters")).toBeInTheDocument();
  });

  it("says it is looking while the plan is in flight", () => {
    draw({ plan: null, loading: true });
    expect(screen.getByText("Looking for cheaper printings…")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("reports the read's own refusal where the rows would have been", () => {
    draw({ plan: null, readError: "no such folder" });
    expect(screen.getByText("no such folder")).toBeInTheDocument();
  });

  it("draws both printings with both languages, so a language swap can be refused", () => {
    draw({
      plan: planOf([move(1, { name: "Lightning Bolt", perCopy: 3, fromLang: "en", toLang: "ja" })]),
    });
    const row = rowFor("Lightning Bolt");
    expect(within(row).getByText("LEA · 161 · EN")).toBeInTheDocument();
    expect(within(row).getByText("2X2 · 101 · JA")).toBeInTheDocument();
  });

  it("draws both prices, the saving, and the per-copy arithmetic above one copy", () => {
    draw({ plan: planOf([move(1, { name: "Lightning Bolt", perCopy: 3, quantity: 4 })]) });
    const row = rowFor("Lightning Bolt");
    expect(within(row).getByText("$5.00")).toBeInTheDocument();
    expect(within(row).getByText("$2.00")).toBeInTheDocument();
    expect(within(row).getByText("$12.00")).toBeInTheDocument();
    // The quantity, and why the row saves four times its per-copy figure.
    expect(within(row).getByText("×4")).toBeInTheDocument();
    expect(within(row).getByText("($3.00 × 4)")).toBeInTheDocument();
  });

  it("draws an em dash for an unpriced current printing and leaves the row unticked", () => {
    draw({
      plan: planOf([
        move(1, { name: "Lightning Bolt", perCopy: 3 }),
        move(2, { name: "Sol Ring", perCopy: null, toPrice: 2 }),
      ]),
    });
    const unpriced = rowFor("Sol Ring");
    expect(within(unpriced).getByText("—")).toBeInTheDocument();
    expect(within(unpriced).getByText("No saving to count")).toBeInTheDocument();
    expect(within(unpriced).getByRole("checkbox")).not.toBeChecked();
    // The priced one beside it did open ticked, so this is the row and not the dialog.
    expect(within(rowFor("Lightning Bolt")).getByRole("checkbox")).toBeChecked();
    expect(applyButton()).toHaveAccessibleName("Switch 1 wish");
  });

  it("moves the total and the button's own count when a row is unticked", async () => {
    const user = userEvent.setup();
    draw({
      plan: planOf([
        move(1, { name: "Lightning Bolt", perCopy: 3, quantity: 4 }),
        move(2, { name: "Rhystic Study", perCopy: 5 }),
      ]),
    });
    expect(applyButton()).toHaveAccessibleName("Switch 2 wishes");
    expect(within(footer()).getByText("$17.00")).toBeInTheDocument();

    await user.click(within(rowFor("Lightning Bolt")).getByRole("checkbox"));

    expect(applyButton()).toHaveAccessibleName("Switch 1 wish");
    expect(within(footer()).getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByText("$17.00")).not.toBeInTheDocument();
  });

  it("sends exactly the ticked rows, each naming the printing it comes from and goes to", async () => {
    const user = userEvent.setup();
    const apply = idleWrite();
    draw({
      apply,
      plan: planOf([
        move(1, { name: "Lightning Bolt", perCopy: 3 }),
        move(2, { name: "Rhystic Study", perCopy: 5 }),
        move(3, { name: "Sol Ring", perCopy: null }),
      ]),
    });

    await user.click(within(rowFor("Rhystic Study")).getByRole("checkbox"));
    await user.click(applyButton());

    expect(apply.mutate).toHaveBeenCalledTimes(1);
    expect(apply.mutate).toHaveBeenCalledWith([
      { wishId: 1, fromCardId: "from-1", toCardId: "to-1" },
    ] satisfies WishOptimizeApplyItem[]);
  });

  it("refuses the press with nothing ticked, and says so rather than merely greying", async () => {
    const user = userEvent.setup();
    const apply = idleWrite();
    draw({ apply, plan: planOf([move(1, { name: "Lightning Bolt", perCopy: 3 })]) });

    await user.click(within(rowFor("Lightning Bolt")).getByRole("checkbox"));
    const button = applyButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    // Still in the tab order, which is why it is `aria-disabled` and not `disabled`.
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(apply.mutate).not.toHaveBeenCalled();
  });

  it("walks the select-all from some, to all, to none", async () => {
    const user = userEvent.setup();
    draw({
      plan: planOf([
        move(1, { name: "Lightning Bolt", perCopy: 3 }),
        move(2, { name: "Sol Ring", perCopy: null }),
      ]),
    });
    const all = screen.getByRole("checkbox", { name: "Select all" });
    // One of two ticked by default — the unpriced one is not.
    expect(all).toBePartiallyChecked();
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

    await user.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();

    await user.click(all);
    expect(all).not.toBeChecked();
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
  });

  it("tells an already-cheapest list from a list with nothing in it, and counts both", () => {
    const { unmount } = draw({
      plan: planOf([], { considered: 12, alreadyCheapest: 11, skipped: 1 }),
    });
    expect(screen.getByText("Nothing to change.")).toBeInTheDocument();
    expect(
      screen.getByText("Checked 12 wishes · 11 already cheapest · 1 skipped."),
    ).toBeInTheDocument();
    unmount();

    draw({ plan: planOf([], { considered: 0 }) });
    expect(screen.getByText("Nothing to check.")).toBeInTheDocument();
    expect(
      screen.getByText("Checked 0 wishes · 0 already cheapest · 0 skipped."),
    ).toBeInTheDocument();
  });

  it("stays open after a write and says what happened, merges and skips included", () => {
    draw({
      plan: planOf([]),
      apply: outcomeWrite([
        result(1, "changed"),
        result(2, "merged"),
        result(3, "stale"),
        result(4, "missing"),
      ]),
    });
    // The dialog is still up and the reader has one way out.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Switch/ })).not.toBeInTheDocument();
  });

  it("reads the outcome against the moves that were pressed, not the plan behind it", async () => {
    const user = userEvent.setup();
    const moves = [
      move(1, { name: "Lightning Bolt", perCopy: 3, quantity: 2 }),
      move(2, { name: "Rhystic Study", perCopy: 5 }),
      move(3, { name: "Ancestral Recall", perCopy: 7 }),
    ];
    const apply = idleWrite();
    const { rerender, props } = draw({ apply, plan: planOf(moves) });

    await user.click(applyButton());

    // What the real hook does next: the apply invalidates `["wishlist"]`, so the plan refetches
    // and the wishes that just moved leave it. The outcome must still name them.
    rerender(
      <OptimizeWishlistDialog
        {...props}
        plan={planOf([])}
        apply={outcomeWrite([result(1, "changed"), result(2, "merged"), result(3, "stale")])}
      />,
    );

    expect(
      within(body()).getByText("Switched 2 wishes to the cheapest printing, saving $11.00."),
    ).toBeInTheDocument();
    // The announcement carries the same sentence, which is what makes it an announcement.
    expect(within(footer()).getByRole("status")).toHaveTextContent(
      "Switched 2 wishes to the cheapest printing, saving $11.00.",
    );
    expect(
      within(body()).getByText(/folded into a wish you already had in the same folder/),
    ).toBeInTheDocument();
    expect(
      within(body()).getByText(/^Ancestral Recall — its printing had already changed/),
    ).toBeInTheDocument();
  });

  it("says nothing moved rather than switching zero wishes", () => {
    draw({
      plan: planOf([]),
      apply: outcomeWrite([result(1, "stale"), result(2, "missing")]),
    });
    expect(
      within(body()).getByText("Nothing moved — every wish had already changed since the preview."),
    ).toBeInTheDocument();
  });

  it("reports a refused write beside the button that was pressed", () => {
    draw({ apply: idleWrite({ isError: true, error: new Error("database is locked") }) });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not switch those wishes — database is locked",
    );
  });

  it("names each row's own card, never a bare Select", () => {
    draw({
      plan: planOf([
        move(1, { name: "Lightning Bolt", perCopy: 3, quantity: 4, preferredFinish: "foil" }),
      ]),
    });
    expect(
      screen.getByRole("checkbox", { name: "Switch Lightning Bolt, 4 copies, foil" }),
    ).toBeInTheDocument();
  });

  it("captions each row with its drawer while the list is flattened", () => {
    draw({
      scope: { folder: "Ordered", flatten: true, filtered: false },
      plan: planOf([move(1, { name: "Lightning Bolt", perCopy: 3, folderId: 4 })]),
      folderNameOf: (id) => (id === 4 ? "Backordered" : null),
    });
    expect(within(rowFor("Lightning Bolt")).getByText("in Backordered")).toBeInTheDocument();
  });

  it("mounts nothing while it is closed", () => {
    draw({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
