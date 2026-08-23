import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  ADD_MODES,
  DEFAULT_ADD_MODE,
  addModeKey,
  chooseFreeCopy,
  freeCopiesQuery,
  useAddMode,
  type FreeCopy,
} from "./NormalSearchAdd";

/** One collection row, as much of it as the choice reads. The fields are `CollectionRow`'s
 *  own, so a row off `collection_list` is one of these without adaptation. */
const copy = (over: Partial<FreeCopy> & { id: number }): FreeCopy => ({
  cardId: "exact",
  oracleId: "o1",
  quantity: 1,
  proxy: false,
  ...over,
});

const WANT = { cardId: "exact", oracleId: "o1" };

describe("chooseFreeCopy", () => {
  /**
   * The deleted allocator's first key, and the reason the whole order was kept: a reader who
   * used to let it choose sees the same copy chosen now.
   */
  it("takes the exact printing before another printing of the same card", () => {
    const other = copy({ id: 1, cardId: "other" });
    const exact = copy({ id: 9, cardId: "exact" });

    expect(chooseFreeCopy([other, exact], WANT)).toBe(exact);
  });

  /** The second key. A proxy is a card you own the *slot* of, not the card. */
  it("takes a real copy before a proxy", () => {
    const proxy = copy({ id: 1, proxy: true });
    const real = copy({ id: 9, proxy: false });

    expect(chooseFreeCopy([proxy, real], WANT)).toBe(real);
  });

  /**
   * The keys are lexicographic, exactly as `sort_by_key((card_id != want, proxy, entry_id))`
   * was — so an exact **proxy** outranks a real copy of another printing. It looks wrong and
   * it is the order that shipped.
   */
  it("keeps the keys in order: an exact proxy beats a real copy of another printing", () => {
    const otherReal = copy({ id: 1, cardId: "other", proxy: false });
    const exactProxy = copy({ id: 9, cardId: "exact", proxy: true });

    expect(chooseFreeCopy([otherReal, exactProxy], WANT)).toBe(exactProxy);
  });

  /** The last key, and the reason it is last: with nothing else to separate two copies, the
   *  one recorded first is the one the reader has had longest. */
  it("breaks a tie on the entry id, ascending", () => {
    const older = copy({ id: 3 });
    const newer = copy({ id: 4 });

    expect(chooseFreeCopy([newer, older], WANT)).toBe(older);
  });

  /** The pool was `WHERE c.oracle_id = ?` — a different card is not a candidate at any key. */
  it("never takes a different oracle card", () => {
    expect(chooseFreeCopy([copy({ id: 1, cardId: "other", oracleId: "o2" })], WANT)).toBeNull();
  });

  /**
   * An orphan — a row whose printing has left `cards` — answers `oracleId: null`, and the
   * allocator's `JOIN cards` dropped it. It is dropped here even when its `cardId` matches,
   * because the identity that makes two printings the same card is the one it does not have.
   */
  it("never takes an orphaned row", () => {
    expect(chooseFreeCopy([copy({ id: 1, oracleId: null })], WANT)).toBeNull();
  });

  /** A row holding nothing is a row the reader emptied, not a copy on the desk. */
  it("never takes a row holding no copies", () => {
    expect(chooseFreeCopy([copy({ id: 1, quantity: 0 })], WANT)).toBeNull();
  });

  /** One row covers the whole ask or it is not a candidate — the one place this departs from
   *  the allocator, which could spend three rows on one card because it was rebuilding a whole
   *  deck rather than answering one press. */
  it("never takes a row that cannot cover the whole ask", () => {
    const two = copy({ id: 1, quantity: 2 });

    expect(chooseFreeCopy([two], { ...WANT, atLeast: 3 })).toBeNull();
    expect(chooseFreeCopy([two], { ...WANT, atLeast: 2 })).toBe(two);
  });

  /** The wall can only answer a printing that is in `cards`, so this is a fence rather than a
   *  state — and the honest answer for a card with no identity is "I cannot match it". */
  it("finds nothing for a card with no oracle id", () => {
    expect(chooseFreeCopy([copy({ id: 1 })], { cardId: "exact", oracleId: null })).toBeNull();
  });

  it("finds nothing in an empty binder", () => {
    expect(chooseFreeCopy([], WANT)).toBeNull();
  });
});

describe("freeCopiesQuery", () => {
  /**
   * **`unallocated` is the whole of "free", and it is the one line of this module that keeps
   * another deck's cards out of reach.** This path is silent — nothing confirms it — so a copy
   * sitting in another deck's group must never be a candidate; taking one is only ever done
   * through the Collection Search tab's confirm.
   */
  it("asks only for copies no deck is holding", () => {
    expect(freeCopiesQuery("o1").allocation).toBe("unallocated");
  });

  /** Narrowed to the one oracle card server-side, so a page of 200 is a page of *this* card. */
  it("narrows to the oracle card", () => {
    expect(freeCopiesQuery("o1")).toMatchObject({ oracleId: "o1", offset: 0 });
    expect(freeCopiesQuery("o1").limit).toBeGreaterThan(0);
  });
});

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe("useAddMode", () => {
  /** Today's behaviour is what a reader who has pressed nothing gets: a `deck_cards` row and
   *  no copy, which is what drives the deck→wishlist sweep. */
  it("starts on the mode that changes nothing", async () => {
    const { result } = renderHook(() => useAddMode(4), { wrapper });

    await waitFor(() => expect(result.current.mode).toBe(DEFAULT_ADD_MODE));
    expect(DEFAULT_ADD_MODE).toBe("need");
  });

  /** One decision for a brewing session: the editor is keyed on the deck id, so a remount
   *  must not put the reader back on the default half way through building. */
  it("keeps the reader's answer across a remount of the same deck", async () => {
    const first = renderHook(() => useAddMode(4), { wrapper });
    await waitFor(() => expect(first.result.current.mode).toBe("need"));
    act(() => first.result.current.setMode("own"));
    await waitFor(() => expect(first.result.current.mode).toBe("own"));
    first.unmount();

    const again = renderHook(() => useAddMode(4), { wrapper });

    expect(again.result.current.mode).toBe("own");
  });

  /** **Per deck**, which is the whole of the key: a cube being assembled out of the binder and
   *  a deck being shopped for are two answers, and one entry would make them one. */
  it("keeps one answer per deck", async () => {
    const four = renderHook(() => useAddMode(4), { wrapper });
    await waitFor(() => expect(four.result.current.mode).toBe("need"));
    act(() => four.result.current.setMode("own"));
    await waitFor(() => expect(four.result.current.mode).toBe("own"));

    const seven = renderHook(() => useAddMode(7), { wrapper });

    await waitFor(() => expect(seven.result.current.mode).toBe("need"));
    expect(four.result.current.mode).toBe("own");
  });

  /** A story or an older build may have put anything in the entry; a value this build does not
   *  draw is the default rather than a mode nothing has a label for. */
  it("reads an unrecognised stored value as the default", () => {
    client.setQueryData(addModeKey(4), "borrowed");

    const { result } = renderHook(() => useAddMode(4), { wrapper });

    expect(result.current.mode).toBe(DEFAULT_ADD_MODE);
  });

  /** Every mode has a label, because the mode is never allowed to be invisible. */
  it("labels both modes", () => {
    expect(ADD_MODES.map((m) => m.id).sort()).toEqual(["need", "own"]);
    for (const mode of ADD_MODES) expect(mode.label.length).toBeGreaterThan(0);
  });
});
