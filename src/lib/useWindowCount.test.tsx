import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";
import { useWindowCount } from "./useWindowCount";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isWebTarget).mockReturnValue(false);
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

  it("never asks the web build, which does not route the command", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    const ask = vi.spyOn(ipc, "windowCount");
    const { result } = renderHook(() => useWindowCount(), { wrapper: withClient() });
    expect(result.current).toBe(1);
    expect(ask).not.toHaveBeenCalled();
  });
});
