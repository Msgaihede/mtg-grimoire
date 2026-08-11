import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckAuditEntry } from "@/lib/ipc";

const deckAuditList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckAuditList },
}));

import { useDeckAudit } from "./useDeckAudit";

/** Unix **seconds**, like every stamp in this schema — `auditText` multiplies by 1000 exactly
 *  once, where the `Date` is built. Built from "now" so the day labels are stable whenever the
 *  suite runs. */
const NOW = Math.floor(Date.now() / 1000);

function entry(over: Partial<DeckAuditEntry>): DeckAuditEntry {
  return {
    id: 1,
    deckId: 4,
    at: NOW,
    variant: "live",
    kind: "add",
    cardId: "p1",
    cardName: "Lightning Bolt",
    payload: '{"category":"Main deck","quantity":2}',
    delta: 2,
    ...over,
  };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckAuditList.mockReset().mockResolvedValue([entry({})]);
});

describe("useDeckAudit", () => {
  /** The drawer is mounted with the editor, which is mounted whether or not a deck is open —
   *  a query that fired anyway would ask the backend for the history of deck `null`. */
  it("asks for nothing until a deck is open", () => {
    renderHook(() => useDeckAudit(null), { wrapper });

    expect(deckAuditList).not.toHaveBeenCalled();
  });

  /**
   * The limit is the backend's own ceiling and is **sent**, not left to a default: `limit` is
   * an `i64` parameter, so a mirror that omitted it would fail the call rather than quietly
   * reading everything — and a `0` would mean *no limit at all*, which is how SQLite reads a
   * negative `LIMIT`.
   */
  it("asks for one deck's history at the backend's own cap", async () => {
    const { result } = renderHook(() => useDeckAudit(4), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(deckAuditList).toHaveBeenCalledWith(4, 500);
    expect(client.getQueryData(["decks", "audit", 4])).toEqual([entry({})]);
  });

  /**
   * The grouping is `auditDays`' and is not re-derived here.
   *
   * Two entries a day apart land in two sections, newest first, and the day's `delta` is the
   * **sum** of its entries — the `+7 / −6` roll-up a sticky header prints. A remove carries a
   * negative delta, which is what makes that sum worth taking.
   */
  it("groups the history into day sections with their signed roll-up", async () => {
    deckAuditList.mockResolvedValue([
      entry({ id: 3, delta: 2 }),
      entry({ id: 2, kind: "remove", delta: -1 }),
      entry({ id: 1, at: NOW - 86_400 * 2, delta: 4 }),
    ]);
    const { result } = renderHook(() => useDeckAudit(4), { wrapper });

    await waitFor(() => expect(result.current.days).toHaveLength(2));
    const [today, older] = result.current.days;
    expect(today.label).toBe("Today");
    expect(today.entries).toHaveLength(2);
    expect(today.delta).toBe(1);
    expect(older.entries).toHaveLength(1);
    expect(older.delta).toBe(4);
  });

  /**
   * **Both variants, unfiltered.** A Theory edit is history too, and each row carries its own
   * variant — a drawer that filtered would hide half of "all changes" from a reader who came
   * to see them. There is no variant in the key for the same reason.
   */
  it("keeps theory entries in the history beside the live ones", async () => {
    deckAuditList.mockResolvedValue([
      entry({ id: 2, variant: "theory" }),
      entry({ id: 1, variant: "live" }),
    ]);
    const { result } = renderHook(() => useDeckAudit(4), { wrapper });

    await waitFor(() => expect(result.current.days).toHaveLength(1));
    expect(result.current.days[0].entries.map((e) => e.variant)).toEqual(["theory", "live"]);
  });

  /** A stable empty array while the read is in flight: a drawer that is loading and a deck with
   *  no history are told apart by `query.isPending`, not by this. */
  it("answers with no days before the first read lands", () => {
    const { result } = renderHook(() => useDeckAudit(4), { wrapper });

    expect(result.current.days).toEqual([]);
    expect(result.current.query.isPending).toBe(true);
  });
});
