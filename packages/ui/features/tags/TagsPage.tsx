import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { FilterBar } from "@/features/search/FilterBar";
import { FilterQuickBar } from "@/features/search/FilterQuickBar";
import { HIDDEN_TAGS_KEY } from "@/features/settings/useHiddenTags";
import { useCardSearch } from "@/features/search/useCardSearch";
import {
  ipc,
  ipcError,
  type ArtTagStatus,
  type ArtWeightFloor,
  type TagHit,
  type TagNamespace,
} from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useDockHeight } from "@/lib/useDockHeight";
import { useFilterQuickBar } from "@/lib/useFilterQuickBar";
import { ORACLE_TAGS_STATUS_KEY } from "@/lib/useOracleTagProgress";
import { cn } from "@/lib/utils";
import { TAG_NAMESPACE_LABEL } from "./namespaces";
import { TagChips } from "./TagChips";
import { TagResults } from "./TagResults";
import { TagSearchBox } from "./TagSearchBox";
import { TagTree } from "./TagTree";
import {
  chipKey,
  EMPTY_SELECTION,
  removeChip,
  termsFor,
  toggleChip,
  toggleChipMode,
  type TagSelection,
} from "./tagFilters";
import { useTagSearch } from "./useTagSearch";

/**
 * Everything the art taxonomy is cached under — `ORACLE_TAGS_KEY`'s twin, spelled here because
 * no hook in `lib/` owns the art side yet.
 *
 * A **prefix**, and that is what it is for: an ingest that lands has replaced the taxonomy under
 * every rail level and every type-ahead answer already drawn, and no key moved — the tags are
 * still tags. {@link useArtTagStatus} invalidates this subtree when a refresh finishes, so the
 * status read below regroups for free.
 */
const ART_TAGS_KEY = ["artTags"];

/** The art taxonomy's freshness — one small table, no network, safe before the first ingest.
 *
 *  The oracle twin is **imported** rather than mirrored, which is what makes this page's other
 *  read free: `AppShell` mounts `useOracleTagProgress` for the life of the window, so that status
 *  is already in the cache under exactly that key and a second observer costs no second `invoke`.
 *  Nothing mounts an art equivalent, which is why the hook below exists at all. */
const ART_TAGS_STATUS_KEY = [...ART_TAGS_KEY, "status"];

/** How often to re-read a status that says a refresh is running — `useOracleTagProgress`'s
 *  number, for its reason: a local SQLite read of one row, and only while the flag is up, so an
 *  idle window polls nothing at all. */
const TAG_REFRESH_POLL_MS = 1500;

/**
 * The art taxonomy's state, and **the thing that makes a cold first run heal itself**.
 *
 * `useOracleTagProgress` mirrored one dataset over, and it has to be mirrored rather than shared:
 * the two taxonomies are two files on two schedules, either may be refreshing while the other is,
 * and they emit on two channels. Without this the page's oracle sentence would disappear by
 * itself — `AppShell` mounts the oracle hook, which invalidates its prefix on the terminal event
 * — while the **art** sentence, the one this page is primarily about, sat there until a window
 * refocus. On the exact first launch the notice exists for, the primary half was the broken half.
 *
 * **Both halves of the oracle shape are here and both are load-bearing.** The event is what
 * carries "it has finished"; the poll is what covers the ordinary case in which nobody heard it,
 * because `lib.rs` spawns `tags::art::refresh_if_due` at startup and Tauri drops an event emitted
 * before the webview registered a listener. The poll is a function of the answer, so the first
 * status with `refreshing: false` turns it off.
 *
 * **Call this once.** Every extra call is another `listen` registration on the same channel for
 * as long as the page is up; {@link TaxonomyGaps} is the one caller.
 *
 * The invalidation reaches past the status to the two lists a reader is actually looking at. A
 * finished ingest means the rail has art tags in it now, and its levels are cached under
 * `["tag-children", …]` with the type-ahead's answers under `["tag-search", …]` — healing the
 * sentence while leaving the rail empty for the client's whole 30 s `staleTime` would be half a
 * fix, and the more visible half left undone.
 */
function useArtTagStatus(): ArtTagStatus | null {
  const queryClient = useQueryClient();
  const status =
    useQuery({
      queryKey: ART_TAGS_STATUS_KEY,
      queryFn: () => ipc.artTagsStatus(),
      refetchInterval: (query) =>
        query.state.data?.refreshing === true ? TAG_REFRESH_POLL_MS : false,
    }).data ?? null;

  // The unmount race and the registration that fails outside a Tauri window (a plain
  // `vite dev`, a story) belong to `lib/core/tauri.ts` now. Losing the fast path is not worth
  // taking the page down for: the status read still answers, and the poll above still covers a
  // refresh that is in flight.
  useEffect(
    () =>
      ipc.onArtTagProgress((event) => {
        // Both terminal phases, not just `done`. A failed refresh leaves the previous taxonomy
        // exactly where it was — so there is nothing new to read — but `refreshing` is still
        // true on the status this window last read, and only a refetch takes it down.
        if (event.phase !== "done" && event.phase !== "error") return;
        void queryClient.invalidateQueries({ queryKey: ART_TAGS_KEY });
        void queryClient.invalidateQueries({ queryKey: ["tag-children"] });
        void queryClient.invalidateQueries({ queryKey: ["tag-search"] });
      }),
    [queryClient],
  );

  return status;
}

/**
 * Keep the weight floor honest after a chip changes — **every** write to the selection goes
 * through this.
 *
 * The floor narrows the art side's *include* half and nothing else, so the moment the last art
 * include leaves — removed, or flipped to an exclude — there is nothing for it to act on.
 * `TagChips` greys it there, and a chip that is pressed *and* greyed at once is the one state
 * `filterChipState` says never occurs: a filter that is on and unreachable, with no way to turn
 * it off. `termsFor` already drops such a floor from the request, so leaving it set would also be
 * a control claiming to narrow a wall it is not narrowing.
 *
 * **At the page rather than in `tagFilters`' reducers**, deliberately: a reducer that preserves
 * state it was not asked to touch is the more predictable rule, and this is a fact about the one
 * control the *page* draws rather than about what a chip is. It is applied to every write rather
 * than to `removeChip`'s call site alone, because more than one path reaches the empty state —
 * the chip's ×, a flip to exclude, and now a rail row toggled back off — and each new one would
 * otherwise be somebody's to remember. The third arrived with issue #181 and cost nothing here,
 * which is the argument for the rule.
 */
function settleFloor(next: TagSelection): TagSelection {
  if (next.floor === "any") return next;
  if (next.chips.some((c) => c.namespace === "art" && c.mode === "include")) return next;
  return { ...next, floor: "any" };
}

/**
 * The dock `useDockHeight` is handed in **table** view: a ref that never holds an element.
 *
 * **Handing no dock is how the rail's pinned height is taken off**, and that is not a
 * workaround. In grid view the hook writes an inline `height` onto the rail so the sticky column
 * is exactly the visible part of `main` below its top; in table view the rail is a stretched flex
 * item again and must be sized by the row, and an inline height left behind would pin it at a
 * number no flex rule can override. The hook clears what it wrote when it unwires, and swapping
 * the dock for one whose `current` is `null` is what unwires it.
 *
 * At module scope so its identity never changes — the hook compares the *element*, not the ref,
 * so this is not load-bearing for correctness, but a fresh object per render would read as if it
 * were.
 */
const NO_RAIL: RefObject<HTMLElement | null> = { current: null };

/**
 * Browse the corpus by what a card **is of** rather than by what it is called.
 *
 * ## The page in one sentence
 *
 * A reader types a motif, sees the tags that match it, drills into one, and gets a wall of cards
 * they can filter to their commander's colours and drag into a deck. Art themes are the primary
 * use and oracle tags the secondary one, which is why the taxonomy chooser opens on `Both` and
 * why the honest empty state below names the art file first.
 *
 * ## Why the rail and the wall are columns rather than rows
 *
 * They are read together, not one after the other: picking a tag is how the wall changes, and a
 * reader compares the tag they picked against the pictures it answered with. Stacked, the rail
 * would take a fixed slice off the top of an 800px window and the wall would get one row of art
 * — so they are side by side, and the two chrome rows that describe the whole query (the chips,
 * then the filter bar) span both. The rail is `w-72`, 288px and fixed; the measurement that chose
 * it over `w-64` is at the rail itself.
 *
 * ## Two arrangements, one per layout — and grid view is one scrolling page
 *
 * **In grid view `main` scrolls the whole page**, exactly as card search, the collection and the
 * wishlist do. The wall is `CardGrid`'s `grow`: as tall as its rows, no scrollport of its own,
 * virtualised against `main`. The rail beside it is `sticky self-start` and pinned while the wall
 * scrolls past, and `useDockHeight` draws it exactly as tall as the part of `main` on screen below
 * its top — the collection's docked search column, for the same reason: a sticky box has no height
 * CSS can name, `100%` of the row is the *wall's* height, and a viewport unit is wrong by the app
 * chrome above `main`. `TagTree` scrolls inside that measured height on its own `min-h-0 flex-1`.
 *
 * So the filter row **leaves the screen** in grid view, which it never did while the page was
 * `h-full` — and that is what the filter quick bar is for (spec 2026-09-29): once the whole
 * `FilterBar` block has scrolled above `main`'s top, `useFilterQuickBar` brings down a one-line
 * copy of it with **the picked tags as its lead**, and the rail pins `dockTop` (41px) lower so the
 * bar never covers the search box at the top of it. The weight floor stays on the page row only;
 * the bar is for narrowing a wall mid-scroll, and `Hide background details` is set once at the top.
 *
 * **In table view it is the old arrangement, unchanged**: the section is `h-full`, the body and
 * the results column are `min-h-0 flex-1`, and `VirtualTable` scrolls inside the definite height
 * that chain hands it — as the search page's table does. Nothing leaves the screen there, so the
 * quick bar is never drawn and the rail is handed no dock ({@link NO_RAIL}), which is what takes
 * the height grid view pinned on it back off. `min-h-0` is what lets either column shrink past
 * its content; **a `min-h-*` would be the opposite of the fix**, since it replaces `min-height:
 * auto` with a *ceiling* on a flex item and the content spills instead.
 */
export function TagsPage() {
  /**
   * What the reader has picked, and which taxonomy the box is searching.
   *
   * **Page state rather than the app store**, which the other three walls' *layout* is in but
   * none of their filters are: `useCardSearch` holds the search view's filters and the collection
   * holds its own, so a trip to another view and back opens a fresh query everywhere in this app.
   * The store is also `lib/`, and a selection type belongs to this feature — a `lib` module
   * importing `features/tags` would invert the app's one layering rule to buy a consistency
   * nothing else here has.
   */
  const [selection, setSelection] = useState<TagSelection>(EMPTY_SELECTION);
  /** What is in the tag box. Its own state, because {@link useTagSearch} owns the debounce and
   *  the query and this is only the characters. */
  const [text, setText] = useState("");
  /** A refused `tag_mute`, said where the reader asked for it. See {@link hideTag}. */
  const [muteFailure, setMuteFailure] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const update = useCallback((step: (s: TagSelection) => TagSelection) => {
    setSelection((prev) => settleFloor(step(prev)));
  }, []);

  const { hits, isPending } = useTagSearch(text, selection.namespace);
  // `null` and `[]` are different states to the rail and both are real: `[]` is "that motif
  // matches no tag", and `null` is "nothing has been asked", which is when the tree is drawn.
  const needle = text.trim();
  const railHits = needle.length > 0 ? hits : null;

  /** Which rows the rail should mark as already picked — chip keys, so the two taxonomies'
   *  shared slugs stay two tags. */
  const picked = useMemo(
    () => new Set(selection.chips.map((c) => chipKey(c.namespace, c.slug))),
    [selection.chips],
  );

  /**
   * The chips as request fields, handed to the card query.
   *
   * `termsFor` is the one place the payload is derived: it intersects the includes, leaves out a
   * taxonomy nobody picked from, and drops a floor with nothing to narrow. Memoised on the
   * selection so a keystroke in the tag box does not rebuild it, though nothing depends on its
   * identity — `useCardSearch` keys on the string this serialises to.
   */
  const tagTerms = useMemo(() => termsFor(selection), [selection]);

  /**
   * The card query, with the chips ANDed in and **collapse off**.
   *
   * `defaultAllPrintings` is the whole of the second half and it is not a preference: an art tag
   * is a fact about *this illustration*, so a collapsed row would fold five printings into one
   * drawn by whichever is newest — showing a reader a picture that need have nothing to do with
   * the motif they searched for. Art results are printings. It is a **seed** rather than a lock,
   * because the filter row still draws All printings and a reader narrowed to an oracle tag is
   * asking "which cards do this", where one row per card is the right answer.
   */
  const search = useCardSearch({ tagTerms, defaultAllPrintings: true });

  /**
   * Which layout the wall is in — and on this page it decides the **page's** arrangement as well
   * as the wall's (see the docblock above): grid is one scrolling page with a pinned rail, table
   * is the bounded column it always was.
   */
  const view = useAppStore((s) => s.tagsView);

  /**
   * **The filter quick bar** (spec 2026-09-29): a one-line copy of the page's filters, led by the
   * picked tags, that docks across the top of `main` once the whole `FilterBar` block has scrolled
   * above it.
   *
   * The block is held in **state** through a callback ref, not a `useRef`: the hook builds its
   * `IntersectionObserver` from the element it is handed, and a ref object changes without a
   * render — an observer built on the first commit, while `.current` was still null, would never
   * be rebuilt onto the real node. Grid only, and the hook is where that is enforced: in table
   * view the filter row never leaves `main`, so there is nothing for a bar to stand in for.
   */
  const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
  const quick = useFilterQuickBar(filterRow, view === "grid");

  /**
   * The rail's pinned height, in grid view — `useDockHeight` over the rail (`dock`) and the body
   * row it sits in (`anchor`), inset by `quick.dockTop` so the rail pins below a docked quick bar
   * rather than under it, and is shortened by the same 41px so its foot still meets the window's.
   *
   * **Grid only**: in table view the rail is bounded by the flex column again and must carry no
   * pinned height — handing no dock is what makes `useDockHeight` take its height off, since the
   * hook clears the height it wrote whenever it unwires.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useDockHeight(view === "grid" ? railRef : NO_RAIL, bodyRef, quick.dockTop);

  /**
   * Hide a tag everywhere, and put the two lists that draw it out of date.
   *
   * **Both invalidations are load-bearing.** The rail's levels are cached under `["tag-children",
   * …]` and the type-ahead's answers under `["tag-search", …]`, and the app's client holds a
   * query fresh for 30 s — so without these the tag the reader just hid stays on screen for half
   * a minute, which reads as the mute having silently failed. Prefixes rather than the exact
   * keys: a mute can take a tag out of *any* level and out of every needle that reached it.
   *
   * **It catches and then rethrows, and both halves are load-bearing.** Refusals are real:
   * `tag_mute` turns down a blank `TagHit.id` in words, because one stored mute with a blank id
   * would equal every row that predates an id-writing refresh and take the whole taxonomy off the
   * page. The catch is what says so — reporting *where the reader asked* is the caller's job,
   * since the rail has no idea why a write it did not make was refused. The rethrow is what keeps
   * the rail honest: it awaits this before writing "hidden tags come back from Settings", and a
   * handler that swallowed would have it print that sentence over a tag that is still on screen.
   *
   * The rethrow is safe rather than a hazard because `TagTree`'s own wrapper catches: it is
   * fire-and-forget, so an escaping rejection would be an unhandled one — silent in the shipped
   * window, and the noise that once printed 336 lines through a green suite. Two nets, and each
   * covers what the other cannot.
   */
  const hideTag = useCallback(
    async (hit: TagHit) => {
      try {
        await ipc.tagMute(hit.namespace, hit.id, hit.slug);
      } catch (e) {
        setMuteFailure(`Couldn't hide ${hit.label} — ${ipcError(e)}`);
        throw e;
      }
      // Only past the write: a refusal leaves all three lists exactly as they were, so re-reading
      // them would be three round trips to be told the same thing.
      //
      // **`HIDDEN_TAGS_KEY` is the third and it is the one that is easy to forget**, because it
      // is not on this page. The rail's answer to a hide is "hidden tags come back from
      // Settings", and Settings' list is a cached read with the app's ordinary 30 s `staleTime`
      // — so without this a reader who had opened Settings once, come back, hidden a tag and
      // followed that sentence inside half a minute would arrive at a list that does not have it
      // on. Which is the same broken promise `HiddenTagsPanel` was built to end, in a narrower
      // window. `useHiddenTags` invalidates in the other direction for the mirror of this
      // reason; a write and its reader have to name each other.
      setMuteFailure(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tag-children"] }),
        queryClient.invalidateQueries({ queryKey: ["tag-search"] }),
        queryClient.invalidateQueries({ queryKey: HIDDEN_TAGS_KEY }),
      ]);
    },
    [queryClient],
  );

  /**
   * A press on a rail row: on if the tag is off, off if it is on.
   *
   * `toggleChip` rather than `addChip`, which is the whole of issue #181 — the row could turn a
   * filter on and not off, so the way back was the chip's ×, a control the reader had no reason
   * to be looking at. It goes through `update` like every other write, so {@link settleFloor}
   * sees the un-pick: toggling the last art include off is a third path into the state where a
   * `strong` floor narrows nothing.
   */
  const toggleTag = useCallback((hit: TagHit) => update((s) => toggleChip(s, hit)), [update]);
  const removeTag = useCallback(
    (slug: string, namespace: TagNamespace) => update((s) => removeChip(s, slug, namespace)),
    [update],
  );
  const toggleTagMode = useCallback(
    (slug: string, namespace: TagNamespace) => update((s) => toggleChipMode(s, slug, namespace)),
    [update],
  );
  const setFloor = useCallback(
    (floor: ArtWeightFloor) => update((s) => ({ ...s, floor })),
    [update],
  );
  const setNamespace = useCallback(
    (namespace: TagNamespace | "both") => update((s) => ({ ...s, namespace })),
    [update],
  );

  return (
    <section
      className={cn(
        "flex flex-col gap-3",
        // **`h-full` is the table's, not the page's** — the search page's rule, for its reason.
        // `VirtualTable` has a height only while every box above it has one, and this section
        // pinned to `main`'s height is the top of that chain. Under the wall's `grow` it is the
        // opposite: a section clamped to one screen is a containing block one screen tall, so
        // the rail's `sticky` and the quick bar's would both travel off the top with its end
        // after the first viewport of cards.
        view === "table" && "h-full",
      )}
    >
      {/* **First child, before the heading**: the wrapper is `sticky top-0 h-0`, so it has to
          start at the section's top edge to be pinned from the first pixel of scroll. `-mb-3` is
          the section's `gap-3` cancelled, or a zero-height wrapper would push the page down 12px
          for a bar that is not drawn. The lead is the picked tags, on one line that scrolls
          sideways (`singleLine`) — and **no `onFloorChange`**: the weight toggle stays on the
          page row, since it is set once rather than reached for mid-scroll, and the bar has no
          room for a control that greys more often than it is used. `widest` folds the mana
          values one rung earlier than the search page does, to pay for the chips' width. */}
      <FilterQuickBar
        search={search}
        shown={quick.shown}
        className="-mb-3"
        manaValuesFrom="widest"
        lead={
          <TagChips
            selection={selection}
            onRemove={removeTag}
            onToggleMode={toggleTagMode}
            singleLine
            emptyMessage="No tags picked"
          />
        }
      />

      {/* Not shown: the ribbon already says `Tags` and the window is short. It is here to name
          the view for assistive tech, exactly as the search view's does. */}
      <h2 className="sr-only">Browse cards by tag</h2>

      {/* What is being asked, in two rows over both columns. The chips lead because they are this
          page's filter — everything on the row below refines what a motif already answered. */}
      <TagChips
        selection={selection}
        onRemove={removeTag}
        onToggleMode={toggleTagMode}
        // **Wiring this is what draws the weight control at all** — `TagChips` follows
        // `ManaValueChips`' X-chip shape, where a page that cannot move a setting is not shown
        // one. Left off, the control would be silently absent rather than dead.
        onFloorChange={setFloor}
      />

      {/* `rootRef` hands the quick bar's hook the whole block — row, open tray, "Filtering by",
          `TagQueryRow` — whose bottom edge is what brings the bar down. */}
      <FilterBar search={search} layoutFor="tags" rootRef={setFilterRow} />

      {/* The body: rail and wall. **`bodyRef` is the rail's anchor** — the row whose top says how
          much of the page is still above the rail — and in table view it is also the flex item
          that hands both columns their bounded height, which is the only view where it gets one.
          In grid view it is as tall as the wall, and that height is what the sticky rail travels
          down. */}
      <div ref={bodyRef} className={cn("flex gap-4", view === "table" && "min-h-0 flex-1")}>
        {/* The rail. `border-r` rather than a filled panel: the direction keeps its fills for the
            card art and the mana chips, and a hairline is enough to say that the column left of
            it asks the question and the one right of it answers.

            **`w-72` and not `w-64`, and the 32px was measured.** A row is a disclosure, the name,
            the namespace mark and the reach figure, and the name is the only one of the four that
            shrinks. Driving the shipped window on 2026-08-20 at 1920×1080 (debug build) with the
            real taxonomy in, `w-64` left the name 14–55px of a 199px row and clipped **23 of the
            24** widest roots; dropping the unit word off the reach (`tagReachFigure`) took that
            to **3**, and `w-72` took it to **0**. Measured as a pair, in the window, and both
            wanted — `w-80` alone also left 3. It costs the wall 32px of 1660.

            **Two arrangements.** In table view it is a stretched flex item bounded by the body
            (`min-h-0`), as it always was. In grid view it is `sticky self-start`: pinned while
            the wall scrolls `main` past it, `self-start` so the row's `stretch` does not draw it
            as tall as the wall, and its height written by `useDockHeight` — the collection's
            docked column, the same three classes for the same reasons. Its `top` is
            `quick.dockTop`, so it stands 41px lower while the quick bar is down and the bar never
            covers the tag box; the hook is handed the same number, so its foot still meets the
            window's. `TagTree` scrolls inside that height on its own `min-h-0 flex-1` in both
            views, which is why the rail's `min-h-0` can be the table's alone: in a row the rail's
            height is its cross axis, where `min-height: auto` never applies. */}
        <div
          ref={railRef}
          className={cn(
            "flex w-72 shrink-0 flex-col gap-3 border-r border-border pr-4",
            view === "table" ? "min-h-0" : "sticky self-start",
          )}
          style={view === "grid" ? { top: quick.dockTop } : undefined}
        >
          <TagSearchBox
            value={text}
            onChange={setText}
            namespace={selection.namespace}
            onNamespaceChange={setNamespace}
          />

          <TaxonomyGaps />

          {/* A refused hide, said beside the rail the reader asked it of. `CardMenuRefusal` is
              the app's one banner for a write a **menu** started and the backend turned down —
              the menu closes before the answer arrives, so the surface has to carry the
              sentence. Its name is its first caller's; the mechanism is exactly this one. */}
          <CardMenuRefusal error={muteFailure} className="shrink-0" />

          <TagTree
            namespace={selection.namespace}
            hits={railHits}
            pending={isPending}
            onToggle={toggleTag}
            onMute={hideTag}
            picked={picked}
          />
        </div>

        {/* `min-w-0`, or a long card name in the table would push the wall wider than its share
            and take the rail's width instead of truncating. `min-h-0` is the table's alone — it
            is what lets `VirtualTable` scroll inside a bounded column, and under a growing wall
            there is no bounded column for it to shrink into: the wall is as tall as its rows. */}
        <div className={cn("flex min-w-0 flex-1 flex-col", view === "table" && "min-h-0")}>
          <TagResults search={search} />
        </div>
      </div>
    </section>
  );
}

/**
 * What this machine has never downloaded, said plainly.
 *
 * **This is not a failure and must not read as one.** A taxonomy with no rows is what every
 * install is on its first launch, and what a machine that cannot reach Scryfall stays in
 * permanently — the page still works for whichever file *did* arrive, which is why each is named
 * on its own line rather than folded into one sentence about "tags". Without this the rail would
 * simply be short a taxonomy with nothing saying why, and a reader typing `forest` into a page
 * that has only oracle tags would blame their spelling.
 *
 * `ingestedAt` is the test and `stale` is not: the latter is true of a taxonomy that is merely due
 * a refresh, which is a page with every tag in it.
 *
 * **Both halves take themselves back down when the file arrives**, and by two different routes
 * that come to the same thing: the oracle status is `AppShell`'s, which invalidates its prefix on
 * the terminal event for the whole window's life, and the art status is
 * {@link useArtTagStatus}'s, which does the same one channel over. Neither is polled once it has
 * said a refresh is not running.
 */
function TaxonomyGaps() {
  const art = useArtTagStatus();
  // The oracle side needs no hook of its own: `AppShell` mounts `useOracleTagProgress`, so this
  // is a second observer of a key that is already in the cache, already invalidated when a
  // refresh lands, and already polled while one is running.
  const oracle = useQuery({
    queryKey: ORACLE_TAGS_STATUS_KEY,
    queryFn: () => ipc.oracleTagsStatus(),
  }).data;

  const missing: TagNamespace[] = [];
  // `null`/`undefined` until the read lands, and neither command refuses — a database with no
  // meta row answers every field null. So an unanswered read says nothing rather than claiming a
  // taxonomy is absent, which would flash this notice onto a page that has every tag.
  if (art && art.ingestedAt === null) missing.push("art");
  if (oracle && oracle.ingestedAt === null) missing.push("oracle");
  if (missing.length === 0) return null;

  return (
    <div
      role="status"
      className="shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-dim"
    >
      {/* One line per taxonomy, and the sentence is one **string** rather than an emphasised
          span plus a tail: `getByText` reads an element's own text nodes, so a wrapped noun
          would leave the sentence unfindable by anything that queries it as a sentence — which
          is how a reader reads it, and how the test for it is written. "Art tags"/"Oracle tags"
          come from the shared labels, so the words here and the mark on a rail row cannot
          drift. */}
      {missing.map((namespace) => (
        <p
          key={namespace}
        >{`${TAG_NAMESPACE_LABEL[namespace]} tags are still downloading.`}</p>
      ))}
    </div>
  );
}
