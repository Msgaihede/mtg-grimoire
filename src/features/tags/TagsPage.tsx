import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { FilterBar } from "@/features/search/FilterBar";
import { useCardSearch } from "@/features/search/useCardSearch";
import { ipc, ipcError, type ArtWeightFloor, type TagHit, type TagNamespace } from "@/lib/ipc";
import { ORACLE_TAGS_STATUS_KEY } from "@/lib/useOracleTagProgress";
import { TAG_NAMESPACE_LABEL } from "./namespaces";
import { TagChips } from "./TagChips";
import { TagResults } from "./TagResults";
import { TagSearchBox } from "./TagSearchBox";
import { TagTree } from "./TagTree";
import {
  addChip,
  chipKey,
  EMPTY_SELECTION,
  removeChip,
  termsFor,
  toggleChipMode,
  type TagSelection,
} from "./tagFilters";
import { useTagSearch } from "./useTagSearch";

/**
 * Everything the art taxonomy is cached under — the mirror of `ORACLE_TAGS_STATUS_KEY`, spelled
 * here because no hook owns the art side yet.
 *
 * The oracle key is **imported** rather than mirrored, which is what makes this page's read free:
 * `AppShell` mounts `useOracleTagProgress` for the life of the window, so that status is already
 * in the cache under exactly this key and a second observer of it costs no second `invoke`.
 */
const ART_TAGS_STATUS_KEY = ["artTags", "status"];

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
 * than to `removeChip`'s call site alone, because two paths reach the empty state — a removal and
 * a flip to exclude — and a third would otherwise be somebody else's to remember.
 */
function settleFloor(next: TagSelection): TagSelection {
  if (next.floor === "any") return next;
  if (next.chips.some((c) => c.namespace === "art" && c.mode === "include")) return next;
  return { ...next, floor: "any" };
}

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
 * — so they are side by side, each scrolling itself, and the two chrome rows that describe the
 * whole query (the chips, then the filter bar) span both. `min-h-0` is what lets either shrink
 * past its content; **a `min-h-*` would be the opposite of the fix**, since it replaces
 * `min-height: auto` with a *ceiling* on a flex item and the content spills instead.
 *
 * The rail is 256px and fixed. At the app's own 1280×800 with the card pane docked, the view is
 * ~632px wide, which leaves the wall ~360 — two columns of art at the default zoom, and four with
 * the pane closed. Wider would be a rail that reads better while browsing and a wall that cannot
 * show a theme.
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
        setMuteFailure(`Could not hide ${hit.label} — ${ipcError(e)}`);
        throw e;
      }
      // Only past the write: a refusal leaves both lists exactly as they were, so re-reading them
      // would be two round trips to be told the same thing.
      setMuteFailure(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tag-children"] }),
        queryClient.invalidateQueries({ queryKey: ["tag-search"] }),
      ]);
    },
    [queryClient],
  );

  const pickTag = useCallback((hit: TagHit) => update((s) => addChip(s, hit)), [update]);
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
    <section className="flex h-full flex-col gap-3">
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

      <FilterBar search={search} layoutFor="tags" />

      <div className="flex min-h-0 flex-1 gap-4">
        {/* The rail. `border-r` rather than a filled panel: the direction keeps its fills for the
            card art and the mana chips, and a hairline is enough to say that the column left of
            it asks the question and the one right of it answers. */}
        <div className="flex min-h-0 w-64 shrink-0 flex-col gap-3 border-r border-border pr-4">
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
            onPick={pickTag}
            onMute={hideTag}
            picked={picked}
          />
        </div>

        {/* `min-w-0`, or a long card name in the table would push the wall wider than its share
            and take the rail's width instead of truncating. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
 * a refresh, which is a page with every tag in it. One read each, no polling — a status that
 * changes under a reader is one the app's 30 s `staleTime` and its refetch-on-focus will pick up,
 * and a poll that never ends is the wrong price for a sentence that is right nearly always.
 */
function TaxonomyGaps() {
  const art = useQuery({ queryKey: ART_TAGS_STATUS_KEY, queryFn: () => ipc.artTagsStatus() });
  const oracle = useQuery({
    queryKey: ORACLE_TAGS_STATUS_KEY,
    queryFn: () => ipc.oracleTagsStatus(),
  });

  const missing: TagNamespace[] = [];
  // `data` is `undefined` until the read lands, and neither command refuses — a database with no
  // meta row answers every field null. So an unanswered read says nothing rather than claiming a
  // taxonomy is absent, which would flash this notice onto a page that has every tag.
  if (art.data && art.data.ingestedAt === null) missing.push("art");
  if (oracle.data && oracle.data.ingestedAt === null) missing.push("oracle");
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
        >{`${TAG_NAMESPACE_LABEL[namespace]} tags have not been downloaded yet.`}</p>
      ))}
      {/* Direction rather than mood, and it is the whole of what a reader can do: there is no
          button for this anywhere in the app. The backend asks Scryfall for both files on every
          launch that is due one, so the honest instruction is to leave it running or come back. */}
      <p className="mt-1">The app fetches them in the background. Nothing here needs a press.</p>
    </div>
  );
}
