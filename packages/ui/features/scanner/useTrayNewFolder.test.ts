import { createElement, useState, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionFolder } from "@/lib/ipc";

const collectionFolderList = vi.fn<() => Promise<CollectionFolder[]>>();
const collectionFolderCreate =
  vi.fn<(parentId: number | null, name: string) => Promise<CollectionFolder>>();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionFolderList: () => collectionFolderList(),
    collectionFolderCreate: (parentId: number | null, name: string) =>
      collectionFolderCreate(parentId, name),
  },
}));

import { useTrayFolder } from "./useTrayCommit";
import { useTrayNewFolder } from "./useTrayNewFolder";

const BINDER: CollectionFolder = {
  rules: [],
  id: 7,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "f7",
};
const SEALED: CollectionFolder = {
  ...BINDER,
  id: 12,
  name: "Sealed",
  sortOrder: 1,
  syncUid: "f12",
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

/** The page's arrangement: the stored folder, `useTrayFolder` over it, and the new folder's
 *  pick writing the stored id — `ScannerPage`'s `update({ folderId })`. */
function usePicker(onStale: (patch: { folderId: null }) => void) {
  const [stored, setStored] = useState<number | null>(null);
  const tray = useTrayFolder(stored, true, onStale);
  const newFolder = useTrayNewFolder(setStored);
  return { stored, tray, newFolder };
}

describe("useTrayNewFolder", () => {
  beforeEach(() => {
    collectionFolderList.mockReset().mockResolvedValue([BINDER]);
    collectionFolderCreate.mockReset();
  });

  it("makes the folder at the top level and picks it, without the page reading it as gone", async () => {
    // The list's re-read is held: until it answers, the cached list is the one without the folder,
    // and only the hook's own entry keeps the page from writing the root back.
    let answer!: (folders: CollectionFolder[]) => void;
    collectionFolderCreate.mockResolvedValue(SEALED);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onStale = vi.fn();
    const { result } = renderHook(() => usePicker(onStale), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.tray.folderList.query.isSuccess).toBe(true));
    collectionFolderList.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    let made = false;
    await act(async () => {
      made = await result.current.newFolder.create("Sealed");
    });
    expect(made).toBe(true);
    expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Sealed");
    expect(result.current.stored).toBe(SEALED.id);
    expect(result.current.tray.folderId).toBe(SEALED.id);
    expect(onStale).not.toHaveBeenCalled();

    await act(async () => answer([BINDER, SEALED]));
    expect(result.current.tray.folderId).toBe(SEALED.id);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("answers a refusal in the backend's words, and picks nothing", async () => {
    collectionFolderCreate.mockRejectedValue("A folder needs a name.");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePicker(vi.fn()), { wrapper: wrapper(client) });

    let made = true;
    await act(async () => {
      made = await result.current.newFolder.create("x");
    });
    expect(made).toBe(false);
    expect(result.current.newFolder.error).toBe("A folder needs a name.");
    expect(result.current.stored).toBeNull();

    act(() => result.current.newFolder.reset());
    await waitFor(() => expect(result.current.newFolder.error).toBeNull());
  });
});
