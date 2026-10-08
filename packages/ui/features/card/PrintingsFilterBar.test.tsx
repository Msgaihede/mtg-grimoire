import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pickOption } from "@/test-dropdown";
import { PrintingsFilterBar } from "./PrintingsFilterBar";
import { EMPTY_PRINTING_FILTER } from "./printingFilters";

/**
 * `SetCombobox` reads `["sets"]` through `useQuery` regardless of whether the query is
 * `enabled` — react-query wants a `QueryClientProvider` on the tree just to construct the
 * hook, `enabled` only decides whether it *fires*. Nothing in this file is about sets, so it is
 * stubbed the same way `CollectionFilterBar.test.tsx` and `FilterBar.test.tsx` stub it, rather
 * than dragging a `QueryClientProvider` in for a component this suite never exercises.
 */
vi.mock("@/features/search/SetCombobox", () => ({
  SetCombobox: () => null,
}));

describe("PrintingsFilterBar", () => {
  /**
   * **The gap this test closes.** `Sort printings by` became a `Dropdown` in Task 12
   * (2026-08-26). Before this file existed, nothing drove a pick through it and asserted
   * `onSortChange` — `AllPrintingsDialog.test.tsx`'s one test that touches this control only
   * *opens* the panel, for the arrow-owner fence, and never activates a row. Confirmed by
   * mutation at review: neutering this control's `onChange` to a no-op left that file's full
   * 32 tests green. This is the first test that would have caught it, and the fix-round mutation
   * below is that same mutation, re-run.
   */
  it("reaches onSortChange, and only onSortChange, when a sort option is picked", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const onFilterChange = vi.fn();
    render(
      <PrintingsFilterBar
        filter={EMPTY_PRINTING_FILTER}
        setOptions={[]}
        langOptions={[]}
        treatmentOptions={[]}
        sort="artist"
        onFilterChange={onFilterChange}
        onSortChange={onSortChange}
      />,
    );

    await pickOption(user, "Sort printings by", "Set");

    // The two channels are deliberately separate — the doc comment on `onSortChange` says
    // clearing the four filters must never move the sort — so a copy-paste onto the wrong prop
    // is exactly the defect worth a second assertion here.
    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith("set");
    expect(onFilterChange).not.toHaveBeenCalled();
  });
});
