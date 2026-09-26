import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { useReviewHandoff, type ReviewScope } from "@/lib/useReviewHandoff";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

/**
 * The hook the way a page holds it: the list hook's own `needsReview` state seeded from
 * `initialNeedsReview`, and `settle` called during render after it. `CollectionPage` and
 * `WishlistPage` are this, with a real list hook in the middle.
 */
function usePage(scope: ReviewScope, flattenStored: boolean) {
  const review = useReviewHandoff(scope, flattenStored);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(review.initialNeedsReview);
  review.settle(needsReview, setNeedsReview);
  return { review, needsReview, setNeedsReview };
}

const mount = (scope: ReviewScope, stored: boolean) =>
  renderHook(({ stored }) => usePage(scope, stored), { initialProps: { stored } });

describe("useReviewHandoff", () => {
  /** The common arrival: the page mounts with the hand-off already waiting for it. */
  it("is born filtered and sweeping when a hand-off names this list and its switch is off", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result } = mount("wishlist", false);

    expect(result.current.needsReview).toBe(true);
    expect(result.current.review.reviewSweep).toBe(true);
    // Spent on the commit that read it.
    expect(useAppStore.getState().pendingReviewFilter).toBeNull();
  });

  /** A list already read flat has nothing for a sweep to add — and a sweep there would turn the
   *  reader's next Flatten press into a no-op. */
  it("arms no sweep over a switch that is already on, and leaves the Flatten press alone", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    const { result } = mount("collection", true);
    const toggle = vi.fn();

    expect(result.current.needsReview).toBe(true);
    expect(result.current.review.reviewSweep).toBe(false);
    expect(result.current.review.onFlattenToggle(toggle)).toBe(toggle);
  });

  /** One field serves both lists, so the question is "is there one for me". */
  it("leaves the other list's hand-off in the store, unread", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result } = mount("collection", false);

    expect(result.current.needsReview).toBeUndefined();
    expect(result.current.review.reviewSweep).toBe(false);
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });
  });

  /** `settle`'s first clause: the widget's two store writes landing in two commits. */
  it("answers a hand-off that lands after the page has mounted", () => {
    const { result } = mount("collection", false);
    expect(result.current.needsReview).toBeUndefined();

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "collection" } }));

    expect(result.current.needsReview).toBe(true);
    expect(result.current.review.reviewSweep).toBe(true);
    expect(useAppStore.getState().pendingReviewFilter).toBeNull();
  });

  /** Off by the ✕ or Reset all (`undefined`) or by cycling the chip to "not flagged" (`false`):
   *  either way the flagged rows are no longer what the page is showing. */
  it.each([undefined, false])("spends the sweep when the filter goes to %s", (next) => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    const { result } = mount("collection", false);

    act(() => result.current.setNeedsReview(next));

    expect(result.current.review.reviewSweep).toBe(false);
  });

  /** `settle`'s `|| flattenStored`: the reader's own switch arriving on (a launch read landing
   *  late) makes the sweep redundant, and a redundant one would swallow the next press. */
  it("spends the sweep when the stored switch comes on underneath it", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result, rerender } = mount("wishlist", false);
    expect(result.current.review.reviewSweep).toBe(true);

    rerender({ stored: true });

    expect(result.current.review.reviewSweep).toBe(false);
    expect(result.current.needsReview).toBe(true);
  });

  /** The chip draws the combined state, so its press turns off the half that is on — and writes
   *  nothing — after which the press is the page's own again. */
  it("gives a Flatten press to the sweep while it stands, and to the page's toggle after", () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    const { result } = mount("wishlist", false);
    const toggle = vi.fn();

    act(() => result.current.review.onFlattenToggle(toggle)());

    expect(toggle).not.toHaveBeenCalled();
    expect(result.current.review.reviewSweep).toBe(false);
    expect(result.current.review.onFlattenToggle(toggle)).toBe(toggle);
  });
});
