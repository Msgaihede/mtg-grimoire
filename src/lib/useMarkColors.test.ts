import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const markColors = vi.hoisted(() => vi.fn());
const setMarkColor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { markColors, setMarkColor },
}));

import {
  isMarkColorKey,
  MARK_COLOR_DEFAULTS,
  MARK_COLORS_KEY,
  useMarkColors,
  useMarkColorVars,
} from "./useMarkColors";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** What `mark_colors` answers this test — the row as the reader left it, keys and all. */
function stored(row: Record<string, string>) {
  markColors.mockResolvedValue(row);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  markColors.mockReset().mockResolvedValue({});
  setMarkColor.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // `useMarkColorVars` writes on `document.documentElement`, which every test in this file
  // shares — so without this the "writes nothing" case inherits whatever the case above it set
  // and passes or fails for a reason that is not its own.
  document.documentElement.removeAttribute("style");
});

/**
 * Which marks this build can colour at all.
 *
 * The vocabulary is TypeScript's — `markcolors.rs` validates the *shape* of a colour and knows
 * nothing about a theory tick — so this predicate is the whole of the narrowing, and a key a
 * newer build wrote has to fall out of it rather than through it.
 */
describe("isMarkColorKey", () => {
  it("admits the marks this build draws and nothing else", () => {
    expect(isMarkColorKey("theoryExact")).toBe(true);
    expect(isMarkColorKey("theoryName")).toBe(true);
    expect(isMarkColorKey("ruleBreak")).toBe(false);
    expect(isMarkColorKey("")).toBe(false);
  });
});

/**
 * The reader's choice of colour for each card mark: one `app_meta` row, read once per app run
 * and written on the press.
 *
 * Two things separate this from `useNavCollapsed`, which it is otherwise shaped after. **An
 * absent key is not a value** — the stylesheet owns what an uncustomised mark is drawn in, so
 * this hook answers the default without ever having written one. And **a refused write is
 * surfaced**, because the reader is standing in front of a colour picker watching a swatch,
 * where the rail's refusal costs them nothing they can see until the next launch.
 */
describe("useMarkColors", () => {
  it("answers the stylesheet's default for a mark nobody has chosen", async () => {
    stored({});

    const { result } = renderHook(() => useMarkColors(), { wrapper });

    await waitFor(() => expect(markColors).toHaveBeenCalled());
    expect(result.current.colors.theoryExact).toBe("#56bd78");
    expect(result.current.colors.theoryName).toBe("#0e68ab");
    expect(result.current.colors).toEqual(MARK_COLOR_DEFAULTS);
  });

  it("answers a stored colour", async () => {
    stored({ theoryExact: "#123456" });

    const { result } = renderHook(() => useMarkColors(), { wrapper });

    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#123456"));
    // The mark the reader left alone is still the stylesheet's.
    expect(result.current.colors.theoryName).toBe(MARK_COLOR_DEFAULTS.theoryName);
  });

  /** A key a newer build wrote is not this build's business and must not become a colour. */
  it("ignores a mark this build does not draw", async () => {
    stored({ ruleBreak: "#d3202a" });

    const { result } = renderHook(() => useMarkColors(), { wrapper });

    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#56bd78"));
    expect(Object.keys(result.current.colors)).toEqual(["theoryExact", "theoryName"]);
  });

  /**
   * A stored entry this build cannot read is the default, never nothing and never the junk.
   *
   * The backend refuses anything but `#rrggbb` on the way in, so this is a hand-edited row or a
   * spelling a future build wrote — and a mark drawn in an unparseable string is a mark drawn in
   * no colour at all.
   */
  it("falls back to the default for a colour it cannot read", async () => {
    stored({ theoryExact: "rebeccapurple" });

    const { result } = renderHook(() => useMarkColors(), { wrapper });

    await waitFor(() => expect(markColors).toHaveBeenCalled());
    expect(result.current.colors.theoryExact).toBe(MARK_COLOR_DEFAULTS.theoryExact);
  });

  /**
   * The swatch moves on the press, not a round trip later — `useNavCollapsed`'s optimistic write,
   * for its reason. The write here never settles, which is what makes the claim a real one.
   */
  it("moves before the write has answered", async () => {
    setMarkColor.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    act(() => result.current.setColor("theoryExact", "#123456"));

    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#123456"));
    expect(setMarkColor).toHaveBeenCalledWith("theoryExact", "#123456");
  });

  /**
   * Shorthand is expanded on this side, which is `markcolors.rs`' stated expectation: it refuses
   * three digits outright so that the row cannot hold two spellings of one colour.
   */
  it("expands a shorthand hex before sending it", async () => {
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    act(() => result.current.setColor("theoryExact", "#F00"));

    await waitFor(() => expect(setMarkColor).toHaveBeenCalledWith("theoryExact", "#ff0000"));
    expect(result.current.colors.theoryExact).toBe("#ff0000");
  });

  /**
   * Reset sends `null`, which clears the row. Writing the default hex instead would freeze
   * today's palette into the reader's database — the cost `labelColors.ts` records for a stored
   * label colour, paid for nothing.
   */
  it("resets by clearing rather than by writing the default", async () => {
    stored({ theoryExact: "#123456" });
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#123456"));

    act(() => result.current.resetColor("theoryExact"));

    await waitFor(() => expect(setMarkColor).toHaveBeenCalledWith("theoryExact", null));
    expect(setMarkColor).not.toHaveBeenCalledWith("theoryExact", MARK_COLOR_DEFAULTS.theoryExact);
    // And the cache holds no entry for it at all, so the stylesheet is back in charge.
    await waitFor(() => expect(client.getQueryData(MARK_COLORS_KEY)).toEqual({}));
    expect(result.current.colors.theoryExact).toBe(MARK_COLOR_DEFAULTS.theoryExact);
  });

  /**
   * **A refused write is said out loud**, which is the one place this parts company with
   * `useNavCollapsed`. `set_mark_color` answers BUSY while a sync holds the write connection,
   * and a reader who has just picked a colour is looking at the control that would have to
   * explain itself.
   */
  it("surfaces a refused write", async () => {
    setMarkColor.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(markColors).toHaveBeenCalled());
    expect(result.current.failure).toBeNull();

    act(() => result.current.setColor("theoryExact", "#123456"));

    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.failure).toContain("busy");
    // The colour the reader picked stays on screen for this session — losing it *and* being told
    // about it is the rail's silent trade with the compensation removed.
    expect(result.current.colors.theoryExact).toBe("#123456");
  });

  /** A colour that is not one at all is refused here rather than at the far end: the backend
   *  would answer the same, and a round trip buys nothing. */
  it("refuses a colour it cannot read without sending it", async () => {
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    act(() => result.current.setColor("theoryExact", "chartreuse"));

    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(setMarkColor).not.toHaveBeenCalled();
    expect(result.current.colors.theoryExact).toBe(MARK_COLOR_DEFAULTS.theoryExact);
  });
});

/**
 * The four custom properties a chosen colour becomes.
 *
 * The mark is drawn on four surfaces and none of them decides its colour, so the colour lives on
 * `:root` — which is also what lets a story and a vitest render draw the real colours with no
 * provider and no seeding.
 */
describe("useMarkColorVars", () => {
  it("writes all four properties, foregrounds included", async () => {
    stored({ theoryExact: "#f8e7b9", theoryName: "#0e68ab" });

    renderHook(() => useMarkColorVars(), { wrapper });

    const root = document.documentElement;
    await waitFor(() => expect(root.style.getPropertyValue("--color-theory-exact")).toBe("#f8e7b9"));
    // `#f8e7b9` has luma 0.91 — `labelFgCss` puts the app's near-black on it, and a tick in
    // `--color-text` would be invisible.
    expect(root.style.getPropertyValue("--color-theory-exact-fg")).toBe("var(--color-accent-fg)");
    expect(root.style.getPropertyValue("--color-theory-name")).toBe("#0e68ab");
    expect(root.style.getPropertyValue("--color-theory-name-fg")).toBe("var(--color-text)");
  });

  /**
   * An uncustomised mark must be left to the stylesheet: an inline property set to the default
   * would win over a future theme, which is the one thing an *absent* entry is protecting.
   */
  it("writes nothing for a mark nobody has chosen", async () => {
    stored({});

    renderHook(() => useMarkColorVars(), { wrapper });

    await waitFor(() => expect(client.getQueryData(MARK_COLORS_KEY)).toEqual({}));
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--color-theory-exact")).toBe("");
    expect(root.style.getPropertyValue("--color-theory-exact-fg")).toBe("");
    expect(root.style.getPropertyValue("--color-theory-name")).toBe("");
    expect(root.style.getPropertyValue("--color-theory-name-fg")).toBe("");
  });

  /** A mark the reader resets is put back to the stylesheet's, so the property has to be
   *  *removed* rather than left at the last colour they chose. */
  it("takes a property back off when the colour is cleared", async () => {
    stored({ theoryExact: "#123456" });
    const { result } = renderHook(
      () => ({ vars: useMarkColorVars(), colors: useMarkColors() }),
      { wrapper },
    );
    const root = document.documentElement;
    await waitFor(() => expect(root.style.getPropertyValue("--color-theory-exact")).toBe("#123456"));

    act(() => result.current.colors.resetColor("theoryExact"));

    await waitFor(() => expect(root.style.getPropertyValue("--color-theory-exact")).toBe(""));
    expect(root.style.getPropertyValue("--color-theory-exact-fg")).toBe("");
  });
});
