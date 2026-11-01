import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLECTION_VALUE } from "@/lib/collectionValue";

const collectionValue = vi.hoisted(() => vi.fn());
const setCollectionValue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionValue, setCollectionValue },
}));

import { useCollectionValue } from "./useCollectionValue";

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCollectionValue(), { wrapper });
}

describe("useCollectionValue", () => {
  beforeEach(() => {
    collectionValue.mockReset().mockResolvedValue(DEFAULT_COLLECTION_VALUE);
    setCollectionValue.mockReset().mockResolvedValue(undefined);
  });

  it("reads the defaults until the row answers, and asks no minimum with none set", async () => {
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0.5 });
    const { result } = setup();
    expect(result.current.settings).toEqual(DEFAULT_COLLECTION_VALUE);
    expect(result.current.minimum).toBeUndefined();
    await waitFor(() => expect(result.current.minimum).toBe(0.5));
  });

  /**
   * **The order the two boxes were committed in is the order the rows are written in.** Each write
   * is the whole row, so a second one sent while the first is still out could land first, and the
   * first would then put the newer figure back. Held open with a deferred promise: a mock that
   * resolves at once cannot show it.
   */
  it("sends a second write only once the first has settled", async () => {
    let finish = () => {};
    setCollectionValue.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { result } = setup();
    await waitFor(() => expect(collectionValue).toHaveBeenCalled());

    act(() => result.current.setSettings({ sellPercent: 70, minimumValue: 0 }));
    await waitFor(() => expect(setCollectionValue).toHaveBeenCalledTimes(1));

    act(() => result.current.setSettings({ sellPercent: 70, minimumValue: 0.5 }));
    // Drawn at once, and not sent: the first is still out.
    await waitFor(() => expect(result.current.minimum).toBe(0.5));
    expect(setCollectionValue).toHaveBeenCalledTimes(1);

    act(() => finish());
    await waitFor(() => expect(setCollectionValue).toHaveBeenCalledTimes(2));
    expect(setCollectionValue).toHaveBeenLastCalledWith({ sellPercent: 70, minimumValue: 0.5 });
  });
});
