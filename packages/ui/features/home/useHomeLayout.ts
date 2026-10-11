import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type HomeLayout } from "@/lib/ipc";
import { copy, parseLayout, toStored } from "./layout";
import { DEFAULT_LAYOUT } from "./widgets";
import { priceWatchOf } from "./priceMoversScope";

/**
 * Where the home page's layout document is kept for the life of the window.
 *
 * Exported for `NAV_COLLAPSED_KEY`'s reason: a test or a story that wants the page to open on a
 * particular arrangement — or on none at all — seeds the cache rather than mocking the command,
 * and a key spelled twice is a key that drifts. Wave 6's stories are the second reader of this
 * and they seed through here.
 */
export const HOME_LAYOUT_KEY = ["homeLayout"];

/**
 * The one query behind the hook — spelled once so nothing can ask for the same row under
 * different terms and end up with two cache entries.
 *
 * **The answer is run through {@link parseLayout} on the way in, so a malformed document is the
 * default here as well as in Rust and the page never sees a shape it has to guard.** `home.rs`
 * already folds a missing row, an unparseable row and a row holding something that is not a
 * layout into the seeded default — but the *webview* can still be handed a document a newer build
 * wrote, one a hand-edit left half-formed, one entry that is not a widget, or a version-1 document
 * from before the grid. Every one of those has an answer in `layout.ts` and none of them is an
 * error; parsing at the door is what makes that true for every consumer at once rather than once
 * per widget — and it is where a version-1 row is placed on the grid, so the page never meets a
 * widget with no cells.
 *
 * `staleTime`/`gcTime: Infinity` for `useNavCollapsed`'s reason, and "for this session" made
 * literal: nothing else writes this row, every change goes through the mutation below which
 * writes the answer straight into the cache, and a collected entry would re-read `app_meta` and
 * get the arrangement a refused write never stored — the rollback this hook refuses to do,
 * arriving late.
 */
const QUERY = {
  queryKey: HOME_LAYOUT_KEY,
  queryFn: async (): Promise<HomeLayout> => parseLayout(await ipc.homeLayout()),
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * A fresh copy of the seed arrangement.
 *
 * **A copy rather than {@link DEFAULT_LAYOUT} itself**, because what this hook hands out is a
 * document the page moves, resizes and configures. Every function in `layout.ts` answers a new
 * object, so nothing *should* reach in and mutate — but the module constant is also what
 * `widgets.test.ts` pins against a literal and what a first launch's fallback is, and one careless
 * splice into it would rewrite both for the rest of the process.
 */
function seedLayout(): HomeLayout {
  return copy(DEFAULT_LAYOUT);
}

/**
 * The one copy handed back while the read is in flight and after a read that failed.
 *
 * **Made once, at module load, and that is about identity rather than allocation.** A fresh copy
 * per render would give the page a new `layout` object on every pass through a state the app can
 * sit in permanently — a read that failed never answers again — so any consumer with an effect or
 * a memo keyed on the document would re-run for ever. It is still a copy rather than
 * {@link DEFAULT_LAYOUT} itself, for {@link seedLayout}'s reason: what leaves this hook is a
 * document the page holds, and the module constant is also the thing `widgets.test.ts` pins.
 */
const FALLBACK_LAYOUT: HomeLayout = seedLayout();

/**
 * The home page's arrangement — which widgets, on which cells, at what footprints — remembered
 * across restarts.
 *
 * TanStack Query rather than the zustand store, for `useNavCollapsed`'s reason repeated whole:
 * `store.ts` scopes itself to UI state and hands anything backed by the database to Query, and
 * this is one `app_meta` row that outlives the process. The cache is where the document *lives*;
 * there is no second home for it to be copied into, and `HomePage` is both the one component that
 * draws it and the one that changes it.
 *
 * **A read that fails is {@link DEFAULT_LAYOUT}, never an error.** Nothing here surfaces `isError`
 * and nothing branches on it: `home_layout` is infallible at the far end, so the only failures
 * left are the IPC boundary itself and a `BUSY` under a sync — a state the app spends whole
 * minutes in on a first run. Neither is worth a landing page that will not draw, and the whole
 * cost of falling back is a launch that opens on the seeded widgets instead of the reader's.
 *
 * **The writes are optimistic, and they are deliberately not rolled back.** The cache is written
 * before the command is sent, so a drag lands where the reader dropped it and a resize takes on
 * the release rather than a round trip later — this page is direct manipulation end to end, and a
 * card that answers late reads as a card that did not move. And `set_home_layout` can legitimately
 * fail: it answers `BUSY` while a sync holds the write connection, and it *refuses* a document
 * whose version it does not write. Snapping the widgets back under the reader's hand in either
 * window, with nothing on screen saying why, is worse than losing one launch's memory of the
 * arrangement. So a refused write keeps the reader's page for this session and says nothing. There
 * is no `onError` and nothing calls `mutateAsync`, so the rejection settles inside the mutation and
 * never reaches a boundary.
 */
export function useHomeLayout(): {
  /** The arrangement to draw. Never `undefined` and never a shape to guard — see {@link QUERY}. */
  layout: HomeLayout;
  /**
   * Has the stored document answered — either with a layout or with a failure?
   *
   * **The one thing `layout` alone cannot say, and the reason this is in the tuple at all: an
   * empty widget list is a real layout.** A reader who removed every widget has said something,
   * and `home.rs` keeps that document rather than re-seeding it — there is a Rust test on exactly
   * that. So a page holding no widgets has two entirely different meanings a beat apart: before
   * the read lands it is *the page has not answered yet*, and after it lands it is *the reader
   * cleared this page*, which is the empty state with **Add widget** in it. Drawing the second one
   * over the first would greet every launch with a "your home page is empty" card that vanishes a
   * moment later.
   *
   * `false` only while the read is genuinely in flight. **A read that failed is ready**, because
   * the default it fell back to is a complete page and there is nothing further to wait for.
   */
  ready: boolean;
  /** Remember this whole arrangement — the document, not a widget, so a move cannot half land. */
  update: (next: HomeLayout) => void;
  /** Put the seeded widgets back, on their seeded cells and at their seeded footprints. */
  reset: () => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (layout: HomeLayout) => ipc.setHomeLayout(layout),
  });

  const startWrite = write.mutate;

  const update = useCallback(
    (next: HomeLayout) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are the
      // same commit either way, and doing it here says outright that the cache is the reader's
      // page and the command is only how it is remembered.
      //
      // The whole document is replaced rather than merged, which is what `layout.ts` is shaped for
      // — every function there takes a layout and answers a new one, so the caller always holds
      // the complete next arrangement and a merge here would have nothing to merge.
      //
      // **Through `toStored` on the way out, and the cache holds the same document the command
      // is sent.** That is where every widget is given the version-1 `span` an older build reads
      // — so a portable copy one release behind still opens this database on a page it can draw —
      // and doing it here means no gesture on the page has to remember it. The cache takes the
      // stored form too, rather than the caller's, so "the cache is the reader's page" and "the
      // row is the reader's page" stay one document rather than two that differ by a field.
      const stored = toStored(next);
      queryClient.setQueryData(HOME_LAYOUT_KEY, stored);
      startWrite(stored);
    },
    [queryClient, startWrite],
  );

  usePriceWatch(query.data);

  const reset = useCallback(() => {
    // Through `update` rather than beside it, so Reset is optimistic, unrolled-back and stored on
    // exactly the terms every other change to this page is.
    update(seedLayout());
  }, [update]);

  return {
    // `undefined` is the read still in flight *and* the read that failed, and both mean the same
    // thing to a page that has to draw: the seeded widgets. There is nothing further to narrow —
    // anything the query holds came either from {@link QUERY}, which parsed it, or from
    // {@link update}, which was handed a document `layout.ts` built.
    layout: query.data ?? FALLBACK_LAYOUT,
    ready: !query.isPending,
    update,
    reset,
  };
}

/**
 * Keep the device's price watch list the cards the page's Price movers widgets name (issue #906).
 *
 * **Rust never reads a widget's config** — `widgets.ts`' rule — so the snapshot that remembers a
 * price for a card the reader does not own is told which cards through `set_price_watch`, a
 * derived index of this document. Sent whenever the set changes, the stored layout's first answer
 * included, so a list a refused write (a `BUSY` under a sync) left stale, or a layout another build
 * wrote, is put right on the next launch. `set_price_watch` writes nothing for a list it already
 * holds.
 *
 * **Nothing is sent until there is something to say**: a page that has never named a card sends
 * nothing at all, so no launch pays a write for a feature the reader has not used. Once a list has
 * been sent this session, emptying it is sent too. A refusal is swallowed — `record_recent_card`'s
 * reading: the cost is a day of history, and the next change sends the list again.
 */
const WATCH_REFUSED = "\u0000refused";

function usePriceWatch(layout: HomeLayout | undefined): void {
  const sent = useRef<string | null>(null);
  const watch = layout === undefined ? null : priceWatchOf(layout);
  const key = watch === null ? null : watch.join("\n");
  useEffect(() => {
    if (watch === null || key === null || key === sent.current) return;
    if (sent.current === null && watch.length === 0) return;
    sent.current = key;
    ipc.setPriceWatch(watch).catch(() => {
      // A key no list spells, so the next change is sent whatever it is — an emptied list too.
      sent.current = WATCH_REFUSED;
    });
    // `key` is `watch` spelled as a string, so the effect runs when the set changes and not on
    // every render's fresh array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
