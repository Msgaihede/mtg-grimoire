import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scannerHold = vi.fn<() => Promise<void>>();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { scannerHold: () => scannerHold() },
}));

import { SCANNER_ELSEWHERE_KEY, SCANNER_ELSEWHERE_POLL_MS } from "./useScannerElsewhere";
import { useRefusedElsewhere, useScannerHold } from "./useScannerHold";
import { DB_BUSY, SCANNER_OPEN_ELSEWHERE } from "./verdictText";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** The clock moved by `ms`, with every promise that settles on the way drained. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  scannerHold.mockReset();
  scannerHold.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("useScannerHold", () => {
  it("holds the scanner on mount and once a poll after, and lets go on unmount", async () => {
    const { unmount } = renderHook(() => useScannerHold(false), { wrapper: wrapperFor(client()) });
    expect(scannerHold).toHaveBeenCalledTimes(1);
    await advance(SCANNER_ELSEWHERE_POLL_MS);
    expect(scannerHold).toHaveBeenCalledTimes(2);
    await advance(SCANNER_ELSEWHERE_POLL_MS * 2);
    expect(scannerHold).toHaveBeenCalledTimes(4);

    unmount();
    await advance(SCANNER_ELSEWHERE_POLL_MS * 3);
    expect(scannerHold).toHaveBeenCalledTimes(4);
  });

  it("stops while released, and beats at once on the way back", async () => {
    const { rerender } = renderHook(({ released }) => useScannerHold(released), {
      wrapper: wrapperFor(client()),
      initialProps: { released: false },
    });
    expect(scannerHold).toHaveBeenCalledTimes(1);

    rerender({ released: true });
    await advance(SCANNER_ELSEWHERE_POLL_MS * 3);
    expect(scannerHold).toHaveBeenCalledTimes(1);

    rerender({ released: false });
    expect(scannerHold).toHaveBeenCalledTimes(2);
  });

  it("never holds for a view that mounted released", async () => {
    renderHook(() => useScannerHold(true), { wrapper: wrapperFor(client()) });
    await advance(SCANNER_ELSEWHERE_POLL_MS * 2);
    expect(scannerHold).not.toHaveBeenCalled();
  });

  it("asks the gate again on every refusal by the lease, and on no other failure", async () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    scannerHold.mockRejectedValue(SCANNER_OPEN_ELSEWHERE);
    renderHook(() => useScannerHold(false), { wrapper: wrapperFor(qc) });
    await advance(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: SCANNER_ELSEWHERE_KEY });
    // A run of refusals is a run of asks.
    await advance(SCANNER_ELSEWHERE_POLL_MS);
    expect(invalidate).toHaveBeenCalledTimes(2);

    scannerHold.mockRejectedValue(DB_BUSY);
    await advance(SCANNER_ELSEWHERE_POLL_MS);
    expect(scannerHold).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

describe("useRefusedElsewhere", () => {
  it("asks the gate once per run of frames the lease refused", () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { rerender } = renderHook(({ error }) => useRefusedElsewhere(error), {
      wrapper: wrapperFor(qc),
      initialProps: { error: null as string | null },
    });
    expect(invalidate).not.toHaveBeenCalled();

    rerender({ error: SCANNER_OPEN_ELSEWHERE });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: SCANNER_ELSEWHERE_KEY });
    // The same refusal on the next frame is the same run.
    rerender({ error: SCANNER_OPEN_ELSEWHERE });
    expect(invalidate).toHaveBeenCalledTimes(1);

    rerender({ error: null });
    rerender({ error: SCANNER_OPEN_ELSEWHERE });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("says nothing to the gate about any other failure", () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useRefusedElsewhere(DB_BUSY), { wrapper: wrapperFor(qc) });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
