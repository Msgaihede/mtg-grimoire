import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHeadingCaret, type HeadingCaretPlace } from "./useHeadingCaret";

/**
 * The machine on its own, with a folder tree handed in as a map of level → ids. The pages' suites
 * drive it through real walls; these pin the two decisions that are easiest to get subtly wrong
 * without a wall in the way — a Move to folder…'s wait, and where `leave` sends the caret.
 */
type Tree = Record<string, readonly number[]>;
const levelKey = (parentId: number | null) => (parentId === null ? "root" : String(parentId));

function mount(initial: { tree: Tree; fetching?: boolean; level?: number | null }) {
  const opener = { current: null as HTMLElement | null };
  return renderHook(
    ({ tree, fetching, level }: { tree: Tree; fetching: boolean; level: number | null }) => {
      const place: HeadingCaretPlace = {
        level,
        asked: level,
        view: "table",
        opener,
        fetching,
        levelIds: (parentId) => tree[levelKey(parentId)] ?? [],
      };
      return useHeadingCaret(place);
    },
    { initialProps: { fetching: false, level: null, ...initial } },
  );
}

describe("useHeadingCaret — a Move to folder… request", () => {
  /** The wait is the folder list's first answer after the write: the folder under its new parent,
   *  and the request is due for that heading's ⋯. */
  it("is due once the folder list files the folder under its new parent", () => {
    const { result, rerender } = mount({ tree: { root: [3, 4] }, fetching: true });

    act(() => result.current.record(result.current.ask(4, "manage", { into: { parentId: 3, id: 4 } })));
    expect(result.current.due).toBeNull();

    rerender({ tree: { root: [3], "3": [4] }, fetching: false, level: null });

    expect(result.current.due).toMatchObject({ shelfId: 4, control: "manage" });
  });

  /** An answer without it — another window moved the folder elsewhere — drops the request rather
   *  than leaving it for some later re-read that happens to agree. */
  it("is dropped when that answer does not have the folder there", () => {
    const { result, rerender } = mount({ tree: { root: [3, 4] }, fetching: true });

    act(() => result.current.record(result.current.ask(4, "manage", { into: { parentId: 3, id: 4 } })));
    rerender({ tree: { root: [3, 4] }, fetching: false, level: null });
    expect(result.current.due).toBeNull();

    rerender({ tree: { root: [3], "3": [4] }, fetching: false, level: null });
    expect(result.current.due).toBeNull();
  });
});

describe("useHeadingCaret — leave", () => {
  const button = () => document.createElement("button");
  const at = (tree: Tree) => (id: number) => {
    for (const [key, ids] of Object.entries(tree)) {
      if (ids.includes(id)) return key === "root" ? null : Number(key);
    }
    return null;
  };

  /** Into a heading the wall draws open: the moved heading's own ⋯, once the list agrees. */
  it("sends the caret to the moved heading when it lands where the wall draws it", () => {
    const tree = { root: [3, 4], "3": [9] };
    const { result, rerender } = mount({ tree, fetching: true });

    act(() =>
      result.current.leave({
        id: 9,
        into: 4,
        drawnOpen: (id) => id === 4,
        parentOf: at(tree),
        pathRowAdd: button,
      })(),
    );
    rerender({ tree: { root: [3, 4], "4": [9] }, fetching: false, level: null });

    expect(result.current.due).toMatchObject({ shelfId: 9, control: "manage" });
  });

  /** Anywhere the wall does not draw it, and on a delete: the heading it was filed under — due at
   *  once, since that heading does not move. */
  it.each([
    ["moved into a shut folder", 4],
    ["deleted", undefined],
  ] as const)("sends the caret to the parent heading when the folder is %s", (_how, into) => {
    const tree = { root: [3, 4], "3": [9] };
    const { result } = mount({ tree });

    act(() =>
      result.current.leave({
        id: 9,
        into,
        drawnOpen: () => false,
        parentOf: at(tree),
        pathRowAdd: button,
      })(),
    );

    expect(result.current.due).toMatchObject({ shelfId: 3, control: "manage" });
  });

  /** At the top of the level there is no heading above it: the path row's Add folder — unless a
   *  layer has opened since the press, which is that layer's business. */
  it("sends the caret to the path row at the top of the level, unless something opened since", () => {
    const tree = { root: [3] };
    const add = button();
    document.body.append(add);
    try {
      const { result } = mount({ tree });
      const leave = () =>
        result.current.leave({ id: 3, drawnOpen: () => false, parentOf: at(tree), pathRowAdd: () => add });

      const superseded = leave();
      act(() => result.current.supersede());
      superseded();
      expect(add).not.toHaveFocus();

      const land = leave();
      land();
      expect(add).toHaveFocus();
      expect(result.current.due).toBeNull();
    } finally {
      add.remove();
    }
  });
});
