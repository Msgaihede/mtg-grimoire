import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { errorLogList, errorLogClear } = vi.hoisted(() => ({
  errorLogList: vi.fn(),
  errorLogClear: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { errorLogList, errorLogClear },
}));

import { useNotifications } from "@/lib/notifications";
import { useErrorLog } from "./useErrorLog";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useErrorLog", () => {
  beforeEach(() => {
    errorLogList.mockReset().mockResolvedValue([]);
    errorLogClear.mockReset().mockResolvedValue(3);
  });

  it("answers a clear with a receipt that counts what went", async () => {
    const { result } = renderHook(() => useErrorLog(), { wrapper });

    act(() => result.current.clear());

    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        tone: "success",
        title: "Cleared 3 errors from the log",
      }),
    );
  });

  it("keeps a refused clear on the panel's own line rather than in a toast", async () => {
    errorLogClear.mockRejectedValueOnce("The database is busy.");
    const { result } = renderHook(() => useErrorLog(), { wrapper });

    act(() => result.current.clear());

    await waitFor(() => expect(result.current.error).toBe("The database is busy."));
    expect(useNotifications.getState().notices).toHaveLength(0);
  });
});
