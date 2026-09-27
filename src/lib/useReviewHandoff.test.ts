import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/lib/store";
import { useReviewHandoff, type ReviewScope } from "@/lib/useReviewHandoff";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

/**
 * The hook the way a page holds it: the list hook's own `needsReview` state seeded from
 * `initialNeedsReview`, and `settle` called during render after it. `CollectionPage` and
 * `WishlistPage` are this, with a real list hook in the middle.
 */
function usePage(scope: ReviewScope, seed?: boolean) {
  const review = useReviewHandoff(scope);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(
    review.initialNeedsReview ?? seed,
  );
  review.settle(needsReview, setNeedsReview);
  return { review, needsReview, setNeedsReview };
}

describe("useReviewHandoff", () => {
  /** The common arrival: the page mounts with the hand-off already waiting for it. */
  it("is born filtered when a hand-off names this list, and spends it", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result } = renderHook(() => usePage("wishlist"));

    expect(result.current.needsReview).toBe(true);
    // Spent on the commit that read it.
    expect(useAppStore.getState().pendingReviewFilter).toBeNull();
  });

  /** One field serves both lists, so the question is "is there one for me". */
  it("leaves the other list's hand-off in the store, unread", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result } = renderHook(() => usePage("collection"));

    expect(result.current.needsReview).toBeUndefined();
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });
  });

  /** `settle`: the widget's two store writes landing in two commits. */
  it("answers a hand-off that lands after the page has mounted", () => {
    const { result } = renderHook(() => usePage("collection"));
    expect(result.current.needsReview).toBeUndefined();

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "collection" } }));

    expect(result.current.needsReview).toBe(true);
    expect(useAppStore.getState().pendingReviewFilter).toBeNull();
  });

  /** `!== true`, not a falsy test: `false` is the chip's "not flagged" state, and a hand-off
   *  asking for the flagged rows has to move the page off it. */
  it("moves a page showing the rows nothing flagged onto the flagged ones", () => {
    const { result } = renderHook(() => usePage("collection", false));
    expect(result.current.needsReview).toBe(false);

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "collection" } }));

    expect(result.current.needsReview).toBe(true);
  });

  /** Spent, it is gone: the reader clearing the filter afterwards is not overruled. */
  it("lets the reader clear the filter once the hand-off is spent", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    const { result } = renderHook(() => usePage("collection"));

    act(() => result.current.setNeedsReview(false));

    expect(result.current.needsReview).toBe(false);
  });
});
