import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useWindowCount } from "./useWindowCount";

afterEach(() => {
  vi.restoreAllMocks();
});

function withClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useWindowCount", () => {
  it("answers one until the backend says otherwise", async () => {
    vi.spyOn(ipc, "windowCount").mockResolvedValue(3);
    const { result } = renderHook(() => useWindowCount(), { wrapper: withClient() });
    expect(result.current).toBe(1);
    await waitFor(() => expect(result.current).toBe(3));
  });
});
