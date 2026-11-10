import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSeededDrafts } from "./useSeededDrafts";

type Seeds = { a: string; b: string };

describe("useSeededDrafts", () => {
  it("starts from the seeds and keeps a draft while its seed stands", () => {
    const { result, rerender } = renderHook((seeds: Seeds) => useSeededDrafts(seeds), {
      initialProps: { a: "1", b: "2" },
    });
    expect(result.current.drafts).toEqual({ a: "1", b: "2" });
    act(() => result.current.setDraft("a", "9"));
    rerender({ a: "1", b: "2" });
    expect(result.current.drafts.a).toBe("9");
    expect(result.current.edited("a")).toBe(true);
    expect(result.current.edited("b")).toBe(false);
  });

  /** Issue #1589: only the box whose own figure moved loses its draft. */
  it("re-seeds only the box whose seed moved", () => {
    const { result, rerender } = renderHook((seeds: Seeds) => useSeededDrafts(seeds), {
      initialProps: { a: "1", b: "2" },
    });
    act(() => {
      result.current.setDraft("a", "9");
      result.current.setDraft("b", "8");
    });
    rerender({ a: "1", b: "5" });
    expect(result.current.drafts).toEqual({ a: "9", b: "5" });
  });

  it("puts every box back on reseed", () => {
    const { result } = renderHook(() => useSeededDrafts({ a: "1", b: "2" }));
    act(() => result.current.setDrafts({ a: "x", b: "y" }));
    act(() => result.current.reseed());
    expect(result.current.drafts).toEqual({ a: "1", b: "2" });
  });
});
