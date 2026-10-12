import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckSearchWidth = vi.hoisted(() => vi.fn());
const setDeckSearchWidth = vi.hoisted(() => vi.fn());
// The original spread back in, `useFolderPane.test.ts`' reason.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckSearchWidth, setDeckSearchWidth },
}));

import { DEFAULT_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";
import {
  DECK_SEARCH_WIDTH_KEY,
  DECK_SEARCH_WIDTH_WRITE_DELAY_MS,
  useDeckSearchWidth,
} from "./useDeckSearchWidth";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckSearchWidth
    .mockReset()
    .mockImplementation((deckId: number) => Promise.resolve(deckId === 4 ? 512 : null));
  setDeckSearchWidth.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

const mount = (deckId: number) => renderHook(() => useDeckSearchWidth(deckId), { wrapper });

/** `useFolderPane.test.ts`' clock: `setTimeout`/`clearTimeout` only, so the mutation still runs. */
function holdTheClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function settle(fn: () => void = () => {}): Promise<void> {
  await act(async () => {
    fn();
    vi.advanceTimersByTime(0);
  });
}

describe("useDeckSearchWidth", () => {
  it("reads the width this deck's column was dragged to", async () => {
    const { result } = mount(4);
    await waitFor(() => expect(result.current.width).toBe(512));
    expect(deckSearchWidth).toHaveBeenCalledWith(4);
  });

  it("draws the default for a deck nobody has dragged, and for a read that fails", async () => {
    const { result } = mount(5);
    await waitFor(() => expect(deckSearchWidth).toHaveBeenCalledWith(5));
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH_PX);

    deckSearchWidth.mockRejectedValue("busy");
    const failed = mount(6);
    await waitFor(() => expect(deckSearchWidth).toHaveBeenCalledWith(6));
    expect(failed.result.current.width).toBe(DEFAULT_PANEL_WIDTH_PX);
  });

  it("follows a drag at once and writes it once the drag goes quiet, rounded", async () => {
    client.setQueryData([...DECK_SEARCH_WIDTH_KEY, 4], 512);
    holdTheClock();
    const { result } = mount(4);

    await settle(() => result.current.setWidth(450));
    await settle(() => result.current.setWidth(470.6));
    expect(result.current.width).toBe(470.6);
    expect(setDeckSearchWidth).not.toHaveBeenCalled();

    await settle(() => vi.advanceTimersByTime(DECK_SEARCH_WIDTH_WRITE_DELAY_MS));
    expect(setDeckSearchWidth).toHaveBeenCalledTimes(1);
    expect(setDeckSearchWidth).toHaveBeenCalledWith(4, 471);
  });

  it("keeps each deck's width apart", async () => {
    client.setQueryData([...DECK_SEARCH_WIDTH_KEY, 4], 512);
    client.setQueryData([...DECK_SEARCH_WIDTH_KEY, 5], 300);
    expect(mount(4).result.current.width).toBe(512);
    expect(mount(5).result.current.width).toBe(300);
  });

  it("flushes a pending write when the deck closes rather than dropping it", async () => {
    client.setQueryData([...DECK_SEARCH_WIDTH_KEY, 4], 512);
    holdTheClock();
    const { result, unmount } = mount(4);

    await settle(() => result.current.setWidth(600));
    expect(setDeckSearchWidth).not.toHaveBeenCalled();
    await act(async () => unmount());
    expect(setDeckSearchWidth).toHaveBeenCalledWith(4, 600);
  });

  it("keeps the reader's width when the write is refused", async () => {
    client.setQueryData([...DECK_SEARCH_WIDTH_KEY, 4], 512);
    setDeckSearchWidth.mockRejectedValue("The database is busy.");
    holdTheClock();
    const { result } = mount(4);

    await settle(() => result.current.setWidth(420));
    await settle(() => vi.advanceTimersByTime(DECK_SEARCH_WIDTH_WRITE_DELAY_MS));
    expect(setDeckSearchWidth).toHaveBeenCalledWith(4, 420);
    expect(result.current.width).toBe(420);
  });
});
