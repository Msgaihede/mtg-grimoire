import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { dndDraggable } from "@/lib/dndTarget";
import { folderDraggable, type FolderScope } from "@/lib/folderDrag";
import { boxed, startPointerDrag } from "@/test-drag";
import { useFoldOnFolderDrag } from "./useFoldOnFolderDrag";

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function mount(register: (element: HTMLElement) => () => void): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "a source";
  document.body.append(element);
  const release = register(element);
  undo.push(() => {
    release();
    element.remove();
  });
  return element;
}

const folderIn = (scope: FolderScope) =>
  mount((element) =>
    folderDraggable({
      element,
      folder: () => ({ folderId: 7, name: "Binder", parentId: null, scope }),
    }),
  );
const card = () =>
  mount((element) => dndDraggable({ element, data: () => ({ kind: "card", cardId: "c1" }) }));

/**
 * Spec §3.9: for the length of a folder heading's drag every shelf folds to its heading, so the
 * whole tree is on screen. The page asks this hook; a card drag folds nothing, and neither does a
 * deck folder carried out of the sidebar's tree — it cannot land on a shelf at all.
 */
describe("useFoldOnFolderDrag", () => {
  it("is false at rest, true for the length of a collection folder's drag, and false after", async () => {
    const view = renderHook(() => useFoldOnFolderDrag());
    expect(view.result.current).toBe(false);

    const held = await startPointerDrag(folderIn("collection"));
    expect(view.result.current).toBe(true);

    await held.cancel();
    expect(view.result.current).toBe(false);
  });

  it("folds for a wishlist folder too", async () => {
    const view = renderHook(() => useFoldOnFolderDrag());
    const held = await startPointerDrag(folderIn("wishlist"));

    expect(view.result.current).toBe(true);
    await held.cancel();
  });

  it("folds nothing for a deck folder from the sidebar's tree", async () => {
    const view = renderHook(() => useFoldOnFolderDrag());
    const held = await startPointerDrag(folderIn("deck"));

    expect(view.result.current).toBe(false);
    await held.cancel();
  });

  it("folds nothing for a card", async () => {
    const view = renderHook(() => useFoldOnFolderDrag());
    const held = await startPointerDrag(card());

    expect(view.result.current).toBe(false);
    await held.cancel();
  });

  it("answers true on a mount in the middle of the drag", async () => {
    const held = await startPointerDrag(folderIn("collection"));
    const late = renderHook(() => useFoldOnFolderDrag());

    expect(late.result.current).toBe(true);
    await held.cancel();
    expect(late.result.current).toBe(false);
  });

  it("unfolds when the folder is let go over nothing", async () => {
    const view = renderHook(() => useFoldOnFolderDrag());
    const held = await startPointerDrag(folderIn("collection"));
    await held.leave();
    await held.drop();

    expect(view.result.current).toBe(false);
  });
});
