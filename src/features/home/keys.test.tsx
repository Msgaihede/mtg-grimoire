import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **The transport is mocked; `ipc` is not** — `SummaryWidget.test.tsx`'s note verbatim, and for
 * its reason: a `vi.fn()` laid over a member of the `ipc` object erases the typed mirror, and a
 * field the command does not return then fails at runtime rather than at `tsc`. The default is a
 * promise that never settles, so every read a case does not seed simply stays pending — which is
 * all this file needs, because it is about *which key* a read is filed under and never about
 * what came back.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { optimizePlanKey } from "@/features/wishlist/useWishlistOptimize";
import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import { makeFit } from "./fit";
import {
  activityKey,
  collectionBreakdownKey,
  collectionTotalKey,
  deckCompletionKey,
  deckListKey,
  deckReviewCountKey,
  deckValuesKey,
  NEW_PRINTINGS_ROOT,
  newPrintingsKey,
  priceHistoryKey,
  priceMoversKey,
  RECENT_CARDS_ROOT,
  recentCardsKey,
  scannerTrayCountKey,
  setCompletionKey,
  stickyNotesKey,
  upcomingSetsKey,
  valueHistoryKey,
  wishlistBreakdownKey,
  wishlistReviewCountKey,
  wishlistSavingsKey,
  wishlistTotalKey,
} from "./keys";
import type { WidgetBodyProps } from "./widgetProps";
import { CollectionValueWidget } from "./widgets/CollectionValueWidget";
import { SummaryWidget } from "./widgets/SummaryWidget";
import { WishlistValueWidget } from "./widgets/WishlistValueWidget";

const MARKETPLACE: MarketplaceId = "tcgplayer";

/**
 * Every key at its exact shape.
 *
 * These read as ceremony and are not: **a key's shape decides what invalidation reaches it**, so
 * a segment added, dropped or reordered here is a widget that silently stops refreshing after a
 * write while every render test in the suite stays green. Two of them carry a segment somebody
 * would reasonably "tidy" — `"home"`, which is what keeps the unfiltered total out of
 * `useCollection`'s summary entry, and `deckListKey`, which is `useDecks`' key verbatim and is
 * shared on purpose.
 */
describe("shape", () => {
  it("files the collection's reads under the collection root", () => {
    expect(collectionTotalKey("tcgplayer")).toEqual(["collection", "summary", "home", "tcgplayer"]);
    expect(collectionBreakdownKey("rarity", "cardmarket")).toEqual([
      "collection",
      "breakdown",
      "rarity",
      "cardmarket",
    ]);
  });

  it("files the wishlist's reads under the wishlist root", () => {
    expect(wishlistTotalKey("tcgplayer")).toEqual(["wishlist", "summary", "tcgplayer"]);
    expect(wishlistBreakdownKey("set", "cardkingdom")).toEqual([
      "wishlist",
      "breakdown",
      "set",
      "cardkingdom",
    ]);
  });

  it("files the decks' reads under the decks root, sharing the gallery's own key", () => {
    expect(deckListKey).toEqual(["decks", "list"]);
    expect(deckValuesKey("manapool")).toEqual(["decks", "values", "manapool"]);
  });

  // The one exception to the root rule. `ActivityWidget`'s cache bridge is what keeps it fresh,
  // and the bridge finds this feed by its root — so the root is as load-bearing here as an
  // invalidation is everywhere else.
  it("files the feed under its own root, carrying the limit", () => {
    expect(activityKey(50)).toEqual(["activity", "recent", 50]);
  });

  // Both under the collection root: a copy added or removed changes what is owned, and a feed
  // landing sweeps that root — which is also when a price snapshot is taken. The movers key
  // carries every part of the question, the marketplace included.
  it("files set completion and the price movers under the collection root", () => {
    expect(setCompletionKey).toEqual(["collection", "setCompletion"]);
    expect(priceMoversKey("30d", "up", "cardmarket", 100)).toEqual([
      "collection",
      "priceMovers",
      "30d",
      "up",
      "cardmarket",
      100,
    ]);
  });

  // The movers popup's history under the same root as the row it opens from, so one feed landing
  // refreshes both. The finish is in the key because a foil copy is priced apart from its nonfoil
  // printing — two popups for one card id must be two entries.
  it("files one printing's price history under the collection root, finish and marketplace included", () => {
    expect(priceHistoryKey("bolt-lea", "foil", "manapool")).toEqual([
      "collection",
      "priceHistory",
      "bolt-lea",
      "foil",
      "manapool",
    ]);
    expect(priceHistoryKey("bolt-lea", "foil", "manapool")).not.toEqual(
      priceHistoryKey("bolt-lea", "nonfoil", "manapool"),
    );
  });

  // Under the collection root so an add, a removal and a feed landing each reach it with no
  // mutation learning a new key. Four segments and no more: the range and the measure are the
  // widget's own arithmetic over one answer, so a fifth segment here would be a re-read per chip
  // press — and a key that no longer starts with `["collection"]` is a graph that stops moving.
  it("files the value graph under the collection root, carrying the split and the marketplace only", () => {
    const key = valueHistoryKey("type", "cardmarket");
    expect(key).toEqual(["collection", "valueHistory", "type", "cardmarket"]);
    expect(key.slice(0, 1)).toEqual(["collection"]);
    // Each of the two arguments is part of the question, so each has to change the key.
    expect(valueHistoryKey("set", "cardmarket")).not.toEqual(key);
    expect(valueHistoryKey("type", "tcgplayer")).not.toEqual(key);
  });

  // The second exception: a root with one writer, the card modal's recorder, which invalidates
  // the root rather than a spelled-out key. So the list key has to sit under that root, or the
  // recorder's invalidation reaches nothing.
  it("files the recently viewed strip under the root the recorder invalidates", () => {
    expect(RECENT_CARDS_ROOT).toEqual(["recentCards"]);
    expect(recentCardsKey(8)).toEqual(["recentCards", "list", 8]);
    expect(recentCardsKey(8).slice(0, RECENT_CARDS_ROOT.length)).toEqual(RECENT_CARDS_ROOT);
  });

  // A root of its own, and the shortest key in the file: `sticky_notes` is read by nothing else,
  // so there is no root its data already lives under. `crossWindow.ts` maps the table to exactly
  // this key — a segment added here is a note another window's write stops refreshing, with
  // nothing on screen saying so.
  it("files the sticky notes under a root of their own", () => {
    expect(stickyNotesKey).toEqual(["stickyNotes"]);
  });

  // The third exception, and the second one's shape: a root of its own whose only writer is the
  // widget's own *seen* cursor. Every segment after it is part of the question, so each one has
  // to be able to re-issue the read.
  it("files the new printings feed under its own root, carrying the whole question", () => {
    expect(NEW_PRINTINGS_ROOT).toEqual(["newPrintings"]);
    const key = newPrintingsKey(
      "chosen",
      [7, 3],
      90,
      ["ja", "en"],
      { virtual: false, theory: true, basics: false },
      100,
    );
    expect(key).toEqual(["newPrintings", "feed", "chosen", "3,7", 90, "en,ja", "t", 100]);
    expect(key.slice(0, NEW_PRINTINGS_ROOT.length)).toEqual(NEW_PRINTINGS_ROOT);
  });

  // **Two arrays with the same members are one cache entry.** The ids and the languages are
  // sorted before they are joined, so a reader ticking two decks in the other order — or a
  // narrowing that happens to emit `["ja","en"]` — does not cost a second read of one answer.
  it("hashes an id list and a language list to one key whatever order they arrive in", () => {
    const flags = { virtual: true, theory: false, basics: true };
    expect(newPrintingsKey("chosen", [3, 7], 30, ["en", "ja"], flags, 25)).toEqual(
      newPrintingsKey("chosen", [7, 3], 30, ["ja", "en"], flags, 25),
    );
    // And the flag segment is three independent switches, not one word: `vb` is virtual and
    // basics on with theory off, which is a different question from all three on.
    expect(newPrintingsKey("all", [], 30, [], flags, 25)[6]).toBe("vb");
    expect(
      newPrintingsKey("all", [], 30, [], { virtual: true, theory: true, basics: true }, 25)[6],
    ).toBe("vtb");
    // Every language is the empty list, which joins to the empty string rather than to a word —
    // the same sentinel the wire carries.
    expect(newPrintingsKey("all", [], 30, [], flags, 25)[5]).toBe("");
  });

  // Round two (2026-09-26). Each sits under the root its data's writes already invalidate — deck
  // completion carries the marketplace because its cost is priced at it, the upcoming feed its
  // window because the window is the question — and the two review counts under the table each
  // counts, which is also the root Needs review's clear now fires.
  it("files round two's reads under the roots their writes already invalidate", () => {
    expect(deckCompletionKey("cardkingdom")).toEqual(["decks", "completion", "cardkingdom"]);
    expect(upcomingSetsKey(90)).toEqual(["decks", "upcoming", 90]);
    expect(deckReviewCountKey).toEqual(["decks", "reviewCount"]);
    expect(wishlistReviewCountKey).toEqual(["wishlist", "reviewCount"]);
    expect(scannerTrayCountKey).toEqual(["scanner", "trayCount"]);
    // Not the gallery's value key: that one is the narrower main + commander + maybe pile.
    expect(deckCompletionKey("tcgplayer")).not.toEqual(deckValuesKey("tcgplayer"));
  });

  // **The savings widget and the Wishlist page's hand-off dialog plan one question, so they are
  // one cache entry**: the widget's key *is* `useWishlistOptimize`'s for the whole list, and the
  // dialog the widget opens is handed the widget's answer rather than asking again.
  it("files wishlist savings under the optimise plan's own key for the whole list", () => {
    expect(wishlistSavingsKey("manapool")).toEqual([
      "wishlist",
      "optimize",
      { flatten: true, marketplace: "manapool" },
    ]);
    expect(wishlistSavingsKey("manapool")).toEqual(optimizePlanKey(wholeWishlistQuery("manapool")));
    expect(wishlistSavingsKey("manapool")).not.toEqual(wishlistSavingsKey("cardmarket"));
  });

  // `["scanner", "tray"]` *is* the tray in the window that owns the scanner, written with
  // `setQueryData`; a count that shared it would be a second reader able to refetch it out from
  // under the scanner's own write.
  it("keeps the tray count off the scanner's own tray entry", () => {
    expect(scannerTrayCountKey).not.toEqual(["scanner", "tray"]);
    expect(scannerTrayCountKey.slice(0, 1)).toEqual(["scanner"]);
  });
});

/**
 * **The regression this whole file exists for.**
 *
 * Three widgets read two keys between them: `SummaryWidget` shares the collection total with
 * `CollectionValueWidget` and the wishlist total with `WishlistValueWidget`. They were written in
 * parallel and each spelled its own copy, which *agreed* — so TanStack hashed them to one entry
 * and each pair cost one fetch. Nothing held that up. The day either copy drifted the page would
 * have quietly grown a second cache entry and a second round trip, with no test going red and
 * nothing on screen to see: both entries answer, both figures draw, and only the network and the
 * invalidations disagree.
 *
 * So the assertion is on the **cache**, not on the functions. Comparing `collectionTotalKey` to
 * itself is vacuous now that there is one definition; what has to stay true is that *mounting
 * both widgets produces one query with two observers*, which is what would go red if a widget
 * stopped reading through `./keys`.
 */
describe("one key, one fetch", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => new Promise(() => {}));
  });

  /** The page's half of a body's props — see `widgetProps.ts`. A 4×3 card is room enough for
   *  every widget here to draw, and what it draws is not this file's business anyway. */
  const chrome = (): Omit<WidgetBodyProps, "widget"> => ({
    fit: makeFit({ w: 4, h: 3, widthPx: 452, heightPx: 336, density: "comfortable" }),
    editing: false,
    still: false,
    onConfig: vi.fn(),
  });

  const widget = (id: string, kind: string): HomeWidget => ({
    id,
    kind,
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    config: null,
  });

  /**
   * One client both widgets mount under.
   *
   * The marketplace is seeded because it is in each priced key — an unanswered setting would put
   * the two widgets on `undefined` and the test would pass for the wrong reason. `staleTime:
   * Infinity` keeps a seeded entry fresh rather than merely present.
   */
  function mount(body: ReactNode): QueryClient {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(MARKETPLACE_KEY, MARKETPLACE);
    client.setQueryData(MARKETPLACE_FEEDS_KEY, []);
    render(<QueryClientProvider client={client}>{body}</QueryClientProvider>);
    return client;
  }

  /** Every cache entry filed under a prefix. Two entries where there should be one is exactly the
   *  drift this file is the fence against, so the count is the assertion. */
  function entriesUnder(client: QueryClient, prefix: QueryKey) {
    return client.getQueryCache().findAll({ queryKey: prefix });
  }

  it("gives the summary and the collection value one collection total between them", () => {
    const client = mount(
      <>
        <SummaryWidget widget={widget("summary", "summary")} {...chrome()} />
        <CollectionValueWidget
          widget={widget("collectionValue", "collectionValue")}
          {...chrome()}
        />
      </>,
    );

    const found = entriesUnder(client, ["collection", "summary"]);
    expect(found).toHaveLength(1);
    expect(found[0].queryKey).toEqual(collectionTotalKey(MARKETPLACE));
    // Two observers on one query is the whole claim: one fetch serves both cards.
    expect(found[0].getObserversCount()).toBe(2);
  });

  it("gives the summary and the wishlist value one wishlist total between them", () => {
    const client = mount(
      <>
        <SummaryWidget widget={widget("summary", "summary")} {...chrome()} />
        <WishlistValueWidget widget={widget("wishlistValue", "wishlistValue")} {...chrome()} />
      </>,
    );

    const found = entriesUnder(client, ["wishlist", "summary"]);
    expect(found).toHaveLength(1);
    expect(found[0].queryKey).toEqual(wishlistTotalKey(MARKETPLACE));
    expect(found[0].getObserversCount()).toBe(2);
  });
});
