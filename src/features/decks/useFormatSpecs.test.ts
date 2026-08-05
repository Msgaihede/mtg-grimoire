import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { FormatSpec } from "@/lib/ipc";

const formatSpecs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { formatSpecs },
}));

import { useFormatSpecs } from "./useFormatSpecs";

/** One row of the seed, cell for cell — `commander` as `schema.rs` actually writes it. */
const COMMANDER: FormatSpec = {
  key: "commander",
  displayName: "Commander",
  enabledInPicker: true,
  deckMin: 100,
  deckMax: 100,
  maxCopies: 1,
  sideboardMax: 0,
  singleton: true,
  requiresCommander: true,
  commanderRule: "edh",
  life: 40,
  restrictedSemantic: "max_one",
  hasLegalityData: true,
  maxManaValue: null,
  allowsCompanion: true,
  sortOrder: 12,
};

/** The pseudo-format with no legality data — `hasLegalityData: false` is a real cell. */
const CASUAL: FormatSpec = {
  ...COMMANDER,
  key: "casual",
  displayName: "Casual",
  deckMin: 0,
  deckMax: null,
  maxCopies: null,
  sideboardMax: null,
  singleton: false,
  requiresCommander: false,
  commanderRule: null,
  life: 20,
  hasLegalityData: false,
  sortOrder: 24,
};

/** One client for the whole test, so a remount asks the *cache* rather than the mock. */
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  formatSpecs.mockReset().mockResolvedValue([COMMANDER, CASUAL]);
});

describe("useFormatSpecs", () => {
  /**
   * The rules are data (spec §6) and the data is seeded by a migration, so this table can
   * change exactly once per app version — never while the app is running, and never because
   * of a sync. `staleTime: Infinity` is that sentence, and this is what proves it: a second
   * mount under the same cache asks nobody.
   *
   * Unlike `["sets"]`, which needs a *function* staleTime because its first launch can
   * answer `[]` while the opening sync is still writing the table. `format_specs` is written
   * by `migrate()` before a command can be served, so an empty answer is not reachable.
   */
  it("reads the format table once and holds it for the session", async () => {
    const first = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(first.result.current.specs).toHaveLength(2));
    expect(client.getQueryData(["formatSpecs"])).toEqual([COMMANDER, CASUAL]);
    first.unmount();

    const second = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(second.result.current.specs).toHaveLength(2));

    expect(formatSpecs).toHaveBeenCalledTimes(1);
  });

  /**
   * Every deck carries a `formatKey` and nothing else; the rules it is judged by are this
   * lookup. `null` for a key the table does not carry rather than a thrown error or a
   * casual-shaped stand-in: a deck whose format left the seed is a deck that must still
   * open, and the caller decides what to say about it.
   */
  it("finds a spec by key, and answers null for one the table does not carry", async () => {
    const { result } = renderHook(() => useFormatSpecs(), { wrapper });
    await waitFor(() => expect(result.current.specs).toHaveLength(2));

    expect(result.current.formatSpecFor("casual")).toEqual(CASUAL);
    expect(result.current.formatSpecFor("pauperoathbreaker")).toBeNull();
  });

  /** Before the table has answered there is no spec for anything — and asking is not an
   *  error, because every consumer of this hook renders through its own loading pass. */
  it("answers null while the table is still loading", () => {
    const { result } = renderHook(() => useFormatSpecs(), { wrapper });

    expect(result.current.specs).toEqual([]);
    expect(result.current.formatSpecFor("commander")).toBeNull();
  });
});
