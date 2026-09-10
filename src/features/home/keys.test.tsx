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
import {
  activityKey,
  collectionBreakdownKey,
  collectionTotalKey,
  deckListKey,
  deckValuesKey,
  wishlistBreakdownKey,
  wishlistTotalKey,
} from "./keys";
import type { WidgetProps } from "./widgetProps";
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

  const chrome = (): Omit<WidgetProps, "widget"> => ({
    editing: false,
    onConfig: vi.fn(),
    onRemove: vi.fn(),
    onSpan: vi.fn(),
    dragHandleRef: vi.fn(),
    onNudge: vi.fn(),
  });

  const widget = (id: string, kind: string): HomeWidget => ({ id, kind, span: 1, config: null });

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
