import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollectionFolder,
  CollectionImportItem,
  ImportCommitOutcome,
  ScannerTrayRow,
} from "@/lib/ipc";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "./fixtures";

const collectionFolderList = vi.fn<() => Promise<CollectionFolder[]>>();
const scannerTray = vi.fn<() => Promise<ScannerTrayRow[]>>();
const setScannerTray = vi.fn<(rows: ScannerTrayRow[]) => Promise<void>>();
const scannerTrayCommit =
  vi.fn<
    (
      items: CollectionImportItem[],
      folderId: number | null,
      remaining: ScannerTrayRow[],
    ) => Promise<ImportCommitOutcome>
  >();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionFolderList: () => collectionFolderList(),
    scannerTray: () => scannerTray(),
    setScannerTray: (rows: ScannerTrayRow[]) => setScannerTray(rows),
    scannerTrayCommit: (
      items: CollectionImportItem[],
      folderId: number | null,
      remaining: ScannerTrayRow[],
    ) => scannerTrayCommit(items, folderId, remaining),
  },
}));

import { NO_FINISHED_ROWS } from "./reader/tray";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { TRAY_QUIET_MS, useTray } from "./useTray";
import { useTrayCommit, useTrayFolder } from "./useTrayCommit";
import { DB_BUSY } from "./verdictText";

const BINDER: CollectionFolder = {
  id: 7,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "f7",
};
const DECK_GROUP: CollectionFolder = { ...BINDER, id: 9, name: "Burn", kind: "deck", deckId: 4, syncUid: "f9" };

const OUTCOME: ImportCommitOutcome = {
  added: 3,
  updated: 0,
  removed: 0,
  copies: 5,
  leftInFolders: 0,
  undoId: null,
};

/** The three rows of the fixture tray that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);
const [SAGA, TOMB, LOTUS] = RESOLVED;
const lineOf = (row: ScannerTrayRow) => ({
  cardId: row.cardId,
  quantity: row.quantity,
  finish: row.finish,
  condition: "NM",
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** A promise a test settles by hand — a write waiting on the connection a sync holds. */
function gate<T>() {
  let open: (value: T) => void = () => {};
  const held = new Promise<T>((resolve) => (open = resolve));
  return { held, open };
}

beforeEach(() => {
  collectionFolderList.mockReset();
  collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP]);
  scannerTray.mockReset();
  scannerTray.mockResolvedValue([...RESOLVED]);
  setScannerTray.mockReset();
  setScannerTray.mockResolvedValue(undefined);
  scannerTrayCommit.mockReset();
  scannerTrayCommit.mockResolvedValue(OUTCOME);
});

describe("useTrayFolder", () => {
  it("lets the stored folder stand until the list has answered", () => {
    collectionFolderList.mockReturnValue(new Promise(() => {}));
    const onStale = vi.fn();
    const { result } = renderHook(() => useTrayFolder(404, true, onStale), {
      wrapper: wrapperFor(client()),
    });
    expect(result.current.folderId).toBe(404);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("keeps a drawer the reader made", async () => {
    const onStale = vi.fn();
    const { result } = renderHook(() => useTrayFolder(BINDER.id, true, onStale), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(result.current.folderList.query.isSuccess).toBe(true));
    expect(result.current.folderId).toBe(BINDER.id);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("reads a folder that is gone, or a deck's group, as the root — and stores it so", async () => {
    for (const stale of [404, DECK_GROUP.id]) {
      const onStale = vi.fn();
      const { result } = renderHook(() => useTrayFolder(stale, true, onStale), {
        wrapper: wrapperFor(client()),
      });
      await waitFor(() => expect(result.current.folderId).toBeNull());
      await waitFor(() => expect(onStale).toHaveBeenCalledWith({ folderId: null }));
    }
  });

  it("draws the root at once and writes nothing until the prefs have loaded", async () => {
    const onStale = vi.fn();
    const { result, rerender } = renderHook(({ loaded }) => useTrayFolder(404, loaded, onStale), {
      wrapper: wrapperFor(client()),
      initialProps: { loaded: false },
    });
    await waitFor(() => expect(result.current.folderId).toBeNull());
    expect(onStale).not.toHaveBeenCalled();
    rerender({ loaded: true });
    await waitFor(() => expect(onStale).toHaveBeenCalledWith({ folderId: null }));
  });

  it("lets the stored folder stand when the list would not load", async () => {
    collectionFolderList.mockRejectedValue("database is locked");
    const onStale = vi.fn();
    const { result } = renderHook(() => useTrayFolder(404, true, onStale), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(result.current.folderList.query.isError).toBe(true));
    // Nothing has said the id is not the reader's, so it is neither redrawn nor rewritten.
    expect(result.current.folderId).toBe(404);
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe("useTrayCommit", () => {
  /**
   * The hook over **the real tray** — `useTray`, its cache entry and its one write queue per
   * client — because what a commit files is decided between the two: a mock tray here would be a
   * second answer to when the lines are built.
   */
  async function mount(folderId: number | null, qc = client()) {
    const view = renderHook(
      () => {
        const tray = useTray();
        const folderList = useCollectionFolderList();
        return { tray, commit: useTrayCommit({ tray, condition: "NM", folderId, folderList }) };
      },
      { wrapper: wrapperFor(qc) },
    );
    await waitFor(() => expect(view.result.current.tray.loaded).toBe(true));
    return view;
  }

  it("files every row with a known finish, in the stored condition, and says what it took", async () => {
    scannerTray.mockResolvedValue([NEEDS_A_FINISH_ROW, ...RESOLVED]);
    const { result } = await mount(BINDER.id);
    let filed: Awaited<ReturnType<typeof result.current.commit.commit>> = null;
    await act(async () => {
      filed = await result.current.commit.commit();
    });

    expect(scannerTrayCommit).toHaveBeenCalledTimes(1);
    const [items, folderId, remaining] = scannerTrayCommit.mock.calls[0];
    expect(folderId).toBe(BINDER.id);
    expect(items).toEqual(RESOLVED.map(lineOf));
    // The row of unknown finish was never taken, so it is what the store is left holding.
    expect(remaining).toEqual([NEEDS_A_FINISH_ROW]);
    expect(filed).toEqual({ outcome: OUTCOME, copies: 5, folderId: BINDER.id });
    expect(result.current.tray.rows).toEqual([NEEDS_A_FINISH_ROW]);
    expect(result.current.commit.error).toBeNull();
    expect(result.current.commit.committing).toBe(false);
  });

  it("leaves a card that landed while the commit was in flight", async () => {
    const wire = gate<ImportCommitOutcome>();
    scannerTrayCommit.mockReturnValue(wire.held);
    const { result } = await mount(null);
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.commit.commit();
    });
    await waitFor(() => expect(scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(result.current.commit.committing).toBe(true);

    act(() => result.current.tray.setRows([NEEDS_A_FINISH_ROW, ...result.current.tray.latest()]));
    await act(async () => {
      wire.open(OUTCOME);
      await pending;
    });
    expect(result.current.tray.latest()).toEqual([NEEDS_A_FINISH_ROW]);
    expect(result.current.commit.committing).toBe(false);
  });

  it("files to the root when the stored folder is not the reader's own", async () => {
    const { result } = await mount(DECK_GROUP.id);
    let filed: Awaited<ReturnType<typeof result.current.commit.commit>> = null;
    await act(async () => {
      filed = await result.current.commit.commit();
    });
    expect(scannerTrayCommit.mock.calls[0][1]).toBeNull();
    expect(filed).toMatchObject({ folderId: null });
  });

  it("leaves the id to the backend when the folder list would not load", async () => {
    collectionFolderList.mockRejectedValue("database is locked");
    const { result } = await mount(404);
    await act(async () => {
      await result.current.commit.commit();
    });
    expect(scannerTrayCommit.mock.calls[0][1]).toBe(404);
  });

  it("refuses in the plan's words, before anything is sent", async () => {
    scannerTray.mockResolvedValue([...TRAY_ROWS]);
    const waiting = await mount(null);
    await act(async () => {
      expect(await waiting.result.current.commit.commit()).toBeNull();
    });
    expect(waiting.result.current.commit.error).toMatch(/still waiting for a printing to be picked/);

    scannerTray.mockResolvedValue([NEEDS_A_FINISH_ROW]);
    const unfinished = await mount(null);
    await act(async () => {
      expect(await unfinished.result.current.commit.commit()).toBeNull();
    });
    expect(unfinished.result.current.commit.error).toBe(NO_FINISHED_ROWS);
    expect(scannerTrayCommit).not.toHaveBeenCalled();
  });

  it("keeps every row and says the backend's sentence on a refusal, then clears it on the next press", async () => {
    scannerTrayCommit.mockRejectedValueOnce(DB_BUSY);
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = await mount(null, qc);
    await act(async () => {
      expect(await result.current.commit.commit()).toBeNull();
    });
    expect(result.current.commit.error).toBe(DB_BUSY);
    expect(result.current.tray.latest()).toEqual(RESOLVED);
    // Nothing was filed, so nothing that reads "what is owned" is asked again.
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => {
      expect(await result.current.commit.commit()).not.toBeNull();
    });
    expect(result.current.commit.error).toBeNull();
    // The import's own set: copies the collection did not hold a moment ago.
    expect(invalidate).toHaveBeenCalled();
  });

  it("is one commit at a time on one mount", async () => {
    const wire = gate<ImportCommitOutcome>();
    scannerTrayCommit.mockReturnValue(wire.held);
    const { result } = await mount(null);
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.commit.commit();
    });
    await waitFor(() => expect(result.current.commit.committing).toBe(true));
    await act(async () => {
      expect(await result.current.commit.commit()).toBeNull();
    });
    expect(scannerTrayCommit).toHaveBeenCalledTimes(1);
    await act(async () => {
      wire.open(OUTCOME);
      await first;
    });
  });

  /**
   * `committing` is one mount's state. A view that went away while its commit waited on a sync —
   * a tab away and back on the phone, a resize across the app's two faces — comes back able to be
   * pressed, over the very rows the first press took: the cache still holds them, because the
   * first commit has not answered. Built at the press, the second commit's lines were those rows
   * again, sent behind the first: the same cards filed twice.
   */
  it("does not file a pile twice when a second mount presses Add while the first's commit waits", async () => {
    const wire = gate<ImportCommitOutcome>();
    scannerTrayCommit.mockReturnValueOnce(wire.held);
    const qc = client();
    const first = await mount(BINDER.id, qc);
    let waiting: Promise<unknown> = Promise.resolve();
    act(() => {
      waiting = first.result.current.commit.commit();
    });
    await waitFor(() => expect(scannerTrayCommit).toHaveBeenCalledTimes(1));
    first.unmount();

    // The view again, on the same client: the tray is the rows the first press took, and nothing
    // on this mount says a commit is in flight.
    const second = await mount(BINDER.id, qc);
    expect(second.result.current.tray.rows).toEqual(RESOLVED);
    expect(second.result.current.commit.committing).toBe(false);
    let again: Awaited<ReturnType<typeof second.result.current.commit.commit>> | undefined;
    let pressed: Promise<unknown> = Promise.resolve();
    act(() => {
      pressed = second.result.current.commit.commit().then((filed) => {
        again = filed;
      });
    });

    await act(async () => {
      wire.open(OUTCOME);
      await waiting;
      await pressed;
    });
    // One write, and the second press came to nothing: its rows were filed by the first.
    expect(scannerTrayCommit).toHaveBeenCalledTimes(1);
    expect(again).toBeNull();
    expect(second.result.current.tray.latest()).toEqual([]);
    expect(second.result.current.commit.error).toBeNull();
    expect(second.result.current.commit.committing).toBe(false);
  });

  it("files the pressed rows as they stand when the write goes out, and leaves one edited meanwhile", async () => {
    // A tray write on the wire ahead of the commit — the stepper pressed just before Add, and a
    // sync holding the write connection.
    const ahead = gate<void>();
    setScannerTray.mockReturnValueOnce(ahead.held);
    const { result } = await mount(null);
    act(() => result.current.tray.setRows([...result.current.tray.latest()]));
    await waitFor(() => expect(setScannerTray).toHaveBeenCalledTimes(1), {
      timeout: TRAY_QUIET_MS * 5,
    });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.commit.commit();
    });
    // Queued behind the tray write, not sent.
    expect(scannerTrayCommit).not.toHaveBeenCalled();
    const stepped = { ...SAGA, quantity: SAGA.quantity + 1 };
    act(() => result.current.tray.setRows([stepped, TOMB, LOTUS]));

    await act(async () => {
      ahead.open();
      await pending;
    });
    expect(scannerTrayCommit).toHaveBeenCalledTimes(1);
    const [items, , remaining] = scannerTrayCommit.mock.calls[0];
    // The row that changed under the press is not filed as it was: it stays, as it is now.
    expect(items).toEqual([TOMB, LOTUS].map(lineOf));
    expect(remaining).toEqual([stepped]);
    expect(result.current.tray.latest()).toEqual([stepped]);
  });
});
