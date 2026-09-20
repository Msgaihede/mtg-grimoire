import { describe, expect, it } from "vitest";
import { masonryRowSpan } from "./masonry";

/**
 * The arithmetic `StackView` has shipped since 2026-08-15, now taking its gutter as an argument.
 * The four rows below are `views.test.tsx`'s own, re-stated against a 20px gutter so that a
 * change here that broke the deck's stack view would fail in both files rather than in one.
 */
describe("a masonry row span", () => {
  it("is the height plus one gutter, rounded up", () => {
    expect(masonryRowSpan(300, 20)).toBe(320);
    expect(masonryRowSpan(300.2, 20)).toBe(321);
  });

  it("is the gutter alone for a box nothing has laid out — which is every box in jsdom", () => {
    expect(masonryRowSpan(0, 20)).toBe(20);
    expect(masonryRowSpan(0, 8)).toBe(8);
  });

  it("never answers a span a grid would throw away", () => {
    // `grid-row: span 0` is invalid and is dropped, which would stack every card at row 1.
    expect(masonryRowSpan(-40, 20)).toBe(1);
    expect(masonryRowSpan(0, 0)).toBe(1);
  });
});
