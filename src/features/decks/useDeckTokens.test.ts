import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckTokenRow } from "@/lib/ipc";

const deckTokens = vi.hoisted(() => vi.fn());
const deckTokenSetQuantity = vi.hoisted(() => vi.fn());
const deckTokenSwap = vi.hoisted(() => vi.fn());
const deckTokenAddPrinting = vi.hoisted(() => vi.fn());
const deckTokenRemove = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckTokens,
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenRemove,
    getMarketplace,
  },
}));

import { entryRef } from "./deckTokens";
import { useDeckTokens } from "./useDeckTokens";

/** One entry as Rust answers it — the implicit Treasure unless a case says otherwise. */
const row = (over: Partial<DeckTokenRow> = {}): DeckTokenRow => ({
  oracleId: "o-treasure",
  name: "Treasure",
  typeLine: "Token Artifact — Treasure",
  layout: "token",
  power: null,
  toughness: null,
  colors: "",
  oracleText: "{T}, Sacrifice this token: Add one mana of any color.",
  defaultCardId: "c-default",
  sources: [{ cardId: "d-1", name: "Smothering Tithe" }],
  derived: true,
  state: "auto",
  cardId: "c-default",
  finish: "nonfoil",
  quantity: 1,
  implicit: true,
  setCode: "tafr",
  collectorNumber: "15",
  setName: null,
  rarity: null,
  finishes: '["nonfoil","foil"]',
  unitPrice: null,
  ...over,
});

let client: QueryClient;

function mount(deckId: number | null = 7, variant: "live" | "theory" = "live") {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useDeckTokens(deckId, variant), { wrapper });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of [
    deckTokens,
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenRemove,
    getMarketplace,
  ]) {
    fn.mockReset();
  }
  getMarketplace.mockResolvedValue("tcgplayer");
  deckTokens.mockResolvedValue([row()]);
  for (const write of [
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenRemove,
  ]) {
    write.mockResolvedValue(undefined);
  }
});

describe("useDeckTokens", () => {
  /**
   * **An implicit entry travels as `null`**, and a stored one as its grain — the whole of what
   * turns a tile's press into rule 2. Sending the implicit entry's own `cardId` would ask Rust to
   * change an entry that is not stored; sending `null` for a stored one would materialise a
   * second entry beside it.
   */
  it("names an implicit entry as null and a stored one by its printing and finish", async () => {
    deckTokens.mockResolvedValue([
      row(),
      row({
        oracleId: "o-wurm",
        name: "Wurm",
        cardId: "c-wurm",
        finish: "foil",
        implicit: false,
      }),
    ]);
    const { result } = mount(7, "theory");
    await waitFor(() => expect(result.current.tokens).toHaveLength(2));
    const [treasure, wurm] = result.current.tokens;

    act(() => result.current.setQuantity(entryRef(treasure), 3));
    await waitFor(() =>
      expect(deckTokenSetQuantity).toHaveBeenLastCalledWith(7, "theory", "o-treasure", null, 3),
    );
    act(() => result.current.setQuantity(entryRef(wurm), 0));
    await waitFor(() =>
      expect(deckTokenSetQuantity).toHaveBeenLastCalledWith(
        7,
        "theory",
        "o-wurm",
        { cardId: "c-wurm", finish: "foil" },
        0,
      ),
    );

    act(() => result.current.swap(entryRef(treasure), { cardId: "c-b", finish: "foil" }));
    await waitFor(() =>
      expect(deckTokenSwap).toHaveBeenLastCalledWith(7, "theory", "o-treasure", null, {
        cardId: "c-b",
        finish: "foil",
      }),
    );

    act(() => result.current.addPrinting("c-b", "etched"));
    await waitFor(() =>
      expect(deckTokenAddPrinting).toHaveBeenLastCalledWith(7, "theory", "c-b", "etched"),
    );

    // **Remove printing names the entry by its grain, always** (managed tokens spec §3.4): the
    // command deletes one stored entry, so there is no `null` arm — an implicit entry draws no
    // Remove button, and a stored one is sent as the two fields the command reads.
    act(() => result.current.remove(entryRef(wurm)));
    await waitFor(() =>
      expect(deckTokenRemove).toHaveBeenLastCalledWith(7, "theory", "o-wurm", {
        cardId: "c-wurm",
        finish: "foil",
      }),
    );
  });

  /**
   * **Dismiss, restore and reset are gone, and so is the switch that revealed a dismissal**
   * (managed tokens spec §3.3, §3.4). A `hidden` row is drawn like any other — Review Focus 1: a
   * dismissal an older peer syncs in after the launch pass ran must not vanish from a wall that
   * has no control left to bring it back.
   */
  it("offers no dismiss, restore, reset or dismissed switch, and draws a hidden row", async () => {
    deckTokens.mockResolvedValue([
      row({ state: "hidden" }),
      row({ oracleId: "o-emblem", name: "Emblem", layout: "emblem", derived: false, sources: [] }),
    ]);
    const { result } = mount();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    for (const retired of ["dismiss", "restore", "reset", "showDismissed", "setShowDismissed"]) {
      expect(result.current, retired).not.toHaveProperty(retired);
    }
    expect(result.current.tokens.map((view) => view.oracleId)).toEqual(["o-treasure", "o-emblem"]);
    // Four writes, Remove printing among them — each journalled, so each is a deck write the
    // editor's redo stack has to be thrown away after.
    expect(result.current.writes).toHaveLength(4);
  });

  /** A refused remove is the newest write's sentence, like every other token write's. */
  it("says a refused remove through the hook's one failure line", async () => {
    deckTokenRemove.mockRejectedValue("That printing of the token is not in this list any more.");
    deckTokens.mockResolvedValue([row({ implicit: false, cardId: "c-a" })]);
    const { result } = mount();
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));

    act(() => result.current.remove(entryRef(result.current.tokens[0])));
    await waitFor(() =>
      expect(result.current.failure).toBe("That printing of the token is not in this list any more."),
    );
  });

  /**
   * **A token write refreshes the deck's undo state**, so the Undo button reads *"Undo —
   * Treasure 1 → 3"* the moment the step exists. Since v52 every token write files a history row
   * and an undo step, and the undo query lives at `["decks", "undo", deckId, redoId]` — a key a
   * `["decks", "tokens", deckId]` invalidation, which is what these writes fired until then,
   * never reached. The root is what every other deck write fires.
   */
  it("invalidates the deck root, the undo state and the history included", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    const spy = vi.spyOn(client, "invalidateQueries");

    act(() => result.current.setQuantity(entryRef(result.current.tokens[0]), 3));
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const keys = spy.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["decks"]);
    // **And the wishlist since user schema v55** (managed tokens spec §3.8): a theory deck's
    // managed wishlist files the plan's missing tokens in a `Tokens` subfolder, and its dirty
    // triggers watch the two token tables — so a token step re-settles it like a card step does,
    // and `useDeck`'s own reason for firing `["wishlist"]` after every deck write is this one's too.
    expect(keys).toContainEqual(["wishlist"]);
  });

  /** The setters are stable while nothing they read changes — the editor hands `setQuantity` to
   *  all four views inside a `useMemo`, and a fresh one per render re-renders the whole pile. */
  it("keeps setQuantity stable across renders", async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    const first = result.current.setQuantity;
    rerender();
    expect(result.current.setQuantity).toBe(first);
  });
});
