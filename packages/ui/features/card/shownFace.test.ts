import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShownFaces, showsBack, toggleShownFace, useShownFace } from "./shownFace";

beforeEach(() => resetShownFaces());

describe("shownFace", () => {
  it("starts every printing face up", () => {
    const { result } = renderHook(() => useShownFace("dfc"));
    expect(result.current).toBe(0);
    expect(showsBack("dfc")).toBe(false);
  });

  it("turns a printing over and back, everywhere it is read", () => {
    const one = renderHook(() => useShownFace("dfc"));
    const two = renderHook(() => useShownFace("dfc"));
    act(() => toggleShownFace("dfc"));
    expect(one.result.current).toBe(1);
    expect(two.result.current).toBe(1);
    act(() => toggleShownFace("dfc"));
    expect(one.result.current).toBe(0);
  });

  it("turns only the printing it was asked about", () => {
    const other = renderHook(() => useShownFace("other"));
    act(() => toggleShownFace("dfc"));
    expect(other.result.current).toBe(0);
  });

  it("answers the front for a card with no back to turn to", () => {
    act(() => toggleShownFace("dfc"));
    const { result } = renderHook(() => useShownFace(null));
    expect(result.current).toBe(0);
  });
});
