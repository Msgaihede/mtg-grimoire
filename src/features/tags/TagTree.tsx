import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, ChevronRight, EyeOff, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuItem } from "@/components/menu/types";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type TagHit, type TagNamespace } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { TAG_NAMESPACE_LABEL, TagNamespaceMark, tagReachLabel } from "./namespaces";
import { chipKey } from "./tagFilters";

/**
 * The rail: one level of the tag graph at a time, or the type-ahead's answer when the box has
 * text in it.
 *
 * ## Three things it has to get right, each with a fact behind it
 *
 * **It is lazy.** `tag_children` with no slug answers the *roots* and there are 3 219 art roots
 * alone; the two taxonomies hold ~16 000 tags between them. A level is fetched by the component
 * that draws it, which mounts when its disclosure is opened and never before — the same promise
 * `MenuLazy` makes, for the same reason.
 *
 * **A tag renders under EACH of its parents.** 43 % of art tags have more than one (4 970 of
 * 11 531, measured 2026-08-20) and the graph is 10 deep, so a rail that drew each tag once would
 * be hiding it from whichever branch the reader happened to be in — wrong for two tags in five.
 * `tag_children` lists a multi-parent tag under every parent, and each row here is its own
 * subtree with its own expansion state, so this comes out right by construction rather than by
 * anyone deduplicating.
 *
 * **A muted tag is absent from the whole of this** — from the rows, from a parent's `childCount`
 * and from anyone's `parents` — because the backend leaves it out. Muting a *category* therefore
 * takes its subtree off the rail with it: the children are not roots and nothing else reaches
 * them unless they have a second parent. That is accepted, recoverable and documented, and the
 * two places it must not read as breakage are handled here — the menu row says what it is about
 * to take before the press, and the rail says where the tag went afterwards.
 *
 * ## Why this is not `role="tree"`
 *
 * An ARIA `tree` is a promise about the keyboard: one tab stop, a roving caret, and Up/Down/
 * Left/Right walking the rows (WAI-ARIA APG). This rail does not implement that model, and a
 * `tree` role over a set of ordinary tab stops announces a keyboard contract nothing keeps — the
 * reader hears "tree" and presses Down and nothing moves. Nested lists of disclosure buttons say
 * exactly what is there, which is also the shape `FolderTree` settled on one floor away.
 */

/** How far one level is pushed in, in pixels. An inline style rather than a Tailwind class,
 *  because Tailwind scans source text for whole class names and an interpolated `pl-${n}`
 *  emits no rule at all. */
const INDENT_STEP = 14;
const indentStyle = (level: number): CSSProperties => ({ paddingLeft: level * INDENT_STEP });

/**
 * Where a row sits in the rail — the route to it, not the tag on it.
 *
 * **The route, because a tag is not one row.** 43 % of art tags have more than one parent, so
 * `forest` is drawn under `plant` *and* under `landscape`; keyed on the slug, opening either
 * would open both and the reader would watch a branch they never touched unfold. It doubles as
 * the cycle guard the graph's depth-10 shape would otherwise need: a route is finite because a
 * reader clicks a finite number of times, and each open row is its own subtree.
 */
const childPath = (parentPath: string, hit: TagHit): string => {
  const own = chipKey(hit.namespace, hit.slug);
  return parentPath === "" ? own : `${parentPath}/${own}`;
};

/**
 * Everything a row needs that is the same for every row, so the recursion carries three props
 * instead of nine.
 *
 * A context rather than prop drilling because the tree is recursive and unbounded in depth: a
 * tenth-level row would otherwise be reached by ten hand-written hand-offs.
 */
interface TagRailApi {
  /** Which **paths** are open — never which slugs. Two rows for one multi-parent tag are two
   *  rows, and opening the `forest` under `plant` must not open the one under `landscape`. */
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  onPick: (hit: TagHit) => void;
  hide: (hit: TagHit) => void;
  /** Chip keys, so a row already in the chip row can say so. */
  picked: ReadonlySet<string> | undefined;
  /** Whether a row draws its taxonomy. Only in `"both"`, where a column of identical marks
   *  would be noise but the two id spaces genuinely share slugs. */
  showNamespace: boolean;
}

const TagRailContext = createContext<TagRailApi | null>(null);

function useRail(): TagRailApi {
  const api = useContext(TagRailContext);
  // Not reachable from the app — `TagTree` is the only thing that renders a row — and thrown
  // rather than defaulted so that a future caller who lifts `TagRow` out gets a name for it.
  if (api === null) throw new Error("A tag row must be drawn inside <TagTree>");
  return api;
}

export interface TagTreeProps {
  /** The **box's** taxonomy: what the roots are asked for. A row descends in its own. */
  namespace: TagNamespace | "both";
  /**
   * The type-ahead's answer, or `null` when the box is empty and the tree is what is drawn.
   *
   * `null` and `[]` are different states and both are real: `[]` is "that motif matches no tag",
   * which is an answer worth printing, and `null` is "nothing has been asked".
   */
  hits: readonly TagHit[] | null;
  /** A search is in flight, including its debounce — the list says so rather than looking like
   *  a search that found nothing. */
  pending?: boolean;
  onPick: (hit: TagHit) => void;
  /**
   * Hide a tag everywhere. The write is the page's, because it is the page that has to
   * invalidate `tag_search` and `tag_children` afterwards; awaited here so the rail only claims
   * a tag was hidden once it actually was.
   */
  onMute: (hit: TagHit) => void | Promise<void>;
  /** `chipKey` values for the tags already picked. */
  picked?: ReadonlySet<string>;
}

export function TagTree({
  namespace,
  hits,
  pending = false,
  onPick,
  onMute,
  picked,
}: TagTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [hidSomething, setHidSomething] = useState(false);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const hide = useCallback(
    (hit: TagHit) => {
      // Fire-and-forget from the row's point of view, and the note is only written once the
      // write has actually settled: a rail that said "hidden tags come back from Settings" after
      // a refused `tag_mute` would be pointing at a list the tag is not on.
      //
      // **The `catch` is load-bearing rather than tidiness.** `onMute` is the page's, and the
      // page's is `ipc.tagMute` plus two invalidations — a function that rejects whenever the
      // `invoke` does. An awaited promise nobody catches is an unhandled rejection: silent in
      // the shipped window, and the noise that once printed 336 lines through a green suite.
      // The rail's own answer to a refused hide is to say nothing new — the row is still there,
      // which is already the truth — and reporting *why* belongs to the page that made the call.
      void (async () => {
        try {
          await onMute(hit);
        } catch {
          return;
        }
        setHidSomething(true);
      })();
    },
    [onMute],
  );

  const api = useMemo<TagRailApi>(
    () => ({ expanded, toggle, onPick, hide, picked, showNamespace: namespace === "both" }),
    [expanded, toggle, onPick, hide, picked, namespace],
  );

  return (
    <TagRailContext.Provider value={api}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* **The rail scrolls itself**, because `tag_children` is deliberately unlimited: there
            are 3 219 art roots and an arbitrary cut would silently lose branches. `relative`, so
            the scroller is the containing block for its own absolutely positioned content — an
            `.sr-only` label with no positioned ancestor is laid out at its static position inside
            the scrolled content, clipped by nothing, and stretches the *document* instead.
            `p-1.5` is 6px of room for the focus outlines the rows draw *outside* their border
            boxes: `overflow` clips at the padding box, `FOCUS` stands 4px proud, and half a focus
            indicator is a WCAG 2.4.7 failure. Same number as `CardGrid`'s `scroll-m-1.5`.
            **Not virtualised** — a recursive graph of disclosures is the wrong shape for
            `VirtualTable`, and how a 3 219-row level actually feels is a question for the live
            pass rather than for jsdom, which has no layout engine at all. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {hits === null ? (
            <TagLevel parent={null} namespace={namespace} path="" level={0} />
          ) : (
            <TagHitList hits={hits} pending={pending} />
          )}
        </div>
        {/* **Mounted for the life of the rail and empty until it has something to say.** That is
            the app's rule for a live region rather than a preference: one that first appears
            with its sentence already inside it announces nothing. This line's entire audience is
            the reader who cannot see that a heading and everything filed under it has just left
            the rail — so mounting it with the news in it would fail exactly the person it exists
            for. `Ribbon`, `AppShell` and `SyncProgress` are all this shape.

            `sr-only` while empty, `Ribbon`'s reason: an element left in the flow with nothing in
            it grows the gap above it by a phantom row. */}
        <p role="status" className={hidSomething ? "px-1 text-[0.6875rem] text-dim" : "sr-only"}>
          {hidSomething
            ? "Hidden tags, and anything filed under them, come back from Settings."
            : ""}
        </p>
      </div>
    </TagRailContext.Provider>
  );
}

/** The type-ahead's rows: one flat list, in the backend's own rank order — exact hit first, then
 *  the prefix hits, then the rest. Not through `sortOptions`, because that ranking *is* the
 *  information and alphabetising it would bury the exact match. */
function TagHitList({ hits, pending }: { hits: readonly TagHit[]; pending: boolean }) {
  if (hits.length === 0) {
    return <Aside>{pending ? "Searching…" : "No tags match that."}</Aside>;
  }
  return (
    <ul aria-label="Matching tags" className="flex flex-col">
      {hits.map((hit) => (
        <TagRow
          key={chipKey(hit.namespace, hit.slug)}
          hit={hit}
          path={childPath("", hit)}
          level={0}
        />
      ))}
    </ul>
  );
}

/**
 * One level of the graph, fetched when this component mounts.
 *
 * **The fetch is the mount, and that is the whole lazy contract.** A parent renders this only
 * while its disclosure is open, so a closed branch has never asked the backend anything.
 *
 * `parent === null` asks for the roots in the *box's* namespace. A named parent is asked in
 * **its own** namespace rather than the box's: `"both"` looks the same slug up in each taxonomy,
 * which is right for the roots and is two unrelated questions once the rail has descended, since
 * the two id spaces share plenty of slugs and mean different things by them.
 */
function TagLevel({
  parent,
  namespace,
  path,
  level,
}: {
  parent: TagHit | null;
  namespace: TagNamespace | "both";
  path: string;
  level: number;
}) {
  const ns = parent?.namespace ?? namespace;
  const slug = parent?.slug ?? null;
  const query = useQuery({
    queryKey: ["tag-children", ns, slug],
    queryFn: () => ipc.tagChildren(ns, slug),
  });

  if (query.isPending) return <Aside>Loading tags…</Aside>;
  if (query.isError) {
    return (
      <p role="alert" className="px-1 py-2 text-sm text-dim">
        Could not load tags — {ipcError(query.error)}
      </p>
    );
  }
  const rows = query.data;
  if (rows.length === 0) {
    // Reachable two ways and neither is a fault: a taxonomy this machine has never fetched, and
    // a branch whose last visible child was hidden between the count and the fetch.
    return <Aside>{parent === null ? "No tags to show." : `Nothing under ${parent.label}.`}</Aside>;
  }

  return (
    <ul
      aria-label={parent === null ? "Tags" : `Tags under ${parent.label}`}
      className="flex flex-col"
    >
      {rows.map((hit) => (
        <TagRow
          key={chipKey(hit.namespace, hit.slug)}
          hit={hit}
          path={childPath(path, hit)}
          level={level}
        />
      ))}
    </ul>
  );
}

/** A quiet line where rows would be — loading, empty, nothing matched. Not a `role="status"`:
 *  none of these is news, they are what is in front of the reader. */
function Aside({ children }: { children: ReactNode }) {
  return <p className="px-1 py-2 text-sm text-dim">{children}</p>;
}

/**
 * One tag: a disclosure, the tag, and how far it reaches.
 *
 * The disclosure is a **second button** rather than the row itself, because opening a branch and
 * picking a tag are two different intentions and a reader browsing a category must be able to
 * look inside it without filtering by it.
 */
function TagRow({ hit, path, level }: { hit: TagHit; path: string; level: number }) {
  const { expanded, toggle, onPick, hide, picked, showNamespace } = useRail();
  const { menu, menuKey } = useContextMenu();
  const tip = useTooltip();

  const open = expanded.has(path);
  const isPicked = picked?.has(chipKey(hit.namespace, hit.slug)) ?? false;
  const reach = tagReachLabel(hit);
  // Composed rather than left to name-from-content: the accname algorithm puts no separator
  // between inline boxes, so this row would announce as "Forest" + "Art" + "3 illustrations" run
  // together — the same defect that made Reset all say "Reset all6". The visible label still
  // leads it (WCAG 2.5.3) and both other visible strings are in it.
  const name = `${hit.label}, ${TAG_NAMESPACE_LABEL[hit.namespace].toLowerCase()} tag, ${reach}${
    isPicked ? ", picked" : ""
  }`;

  /**
   * The row's menu, built on the press rather than on every render — a rail can be thousands of
   * rows long.
   *
   * **The hide row says what it is about to take.** A muted category leaves with its subtree,
   * because the children are not roots; a reader who was told that before the press reads the
   * shorter rail as the thing they asked for rather than as a rail that broke.
   */
  const items = (): MenuItem[] => {
    const unmutable = hit.id === "";
    return [
      {
        kind: "action",
        id: "pick",
        label: "Add this tag to the filter",
        Icon: Plus,
        onSelect: () => onPick(hit),
      },
      { kind: "separator", id: "sep" },
      {
        kind: "action",
        id: "hide",
        label: hit.childCount > 0 ? "Hide this tag and the tags under it" : "Hide this tag",
        Icon: EyeOff,
        // A blank `id` is a real value: `oracle_tags.id` arrived by an `ALTER TABLE` that could
        // not add a `NOT NULL` column without a default, so every row predating a refresh new
        // enough to write ids carries `""`. `tag_mute` refuses one — a stored mute with a blank
        // id would equal every such row and take the whole taxonomy off the page — so the row
        // greys with the reason rather than failing on the press.
        disabled: unmutable,
        reason: unmutable ? "not until the next tag refresh" : undefined,
        onSelect: () => hide(hit),
      },
    ];
  };

  return (
    <li>
      <div className="flex items-center gap-1" style={indentStyle(level)}>
        {hit.childCount > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggle(path)}
            // Says which branch as well as which direction, because a rail ten levels deep has
            // a column of these and "Show children" would name every one of them the same.
            aria-label={`${open ? "Hide" : "Show"} tags under ${hit.label}`}
            className={cn(
              "grid size-6 flex-none place-items-center rounded text-dim hover:text-text",
              FOCUS,
            )}
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
                open && "rotate-90",
              )}
              aria-hidden="true"
            />
          </button>
        ) : (
          // A leaf keeps the disclosure's width so the labels of a level line up. `childCount`
          // counts only children that exist and are not muted, so a triangle never opens onto
          // nothing and this gap is never a hidden branch.
          <span aria-hidden="true" className="size-6 flex-none" />
        )}

        <button
          type="button"
          onClick={() => onPick(hit)}
          onContextMenu={menu(items)}
          onKeyDown={menuKey(items)}
          aria-label={name}
          // The tag's own description, where Scryfall gave it one. A description rather than part
          // of the name: most tags have none, and a row whose name grew a sentence would be
          // announced differently from the row above it for no reason the reader can see.
          {...tip(hit.description)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm",
            PRESS,
            FOCUS,
            isPicked ? "text-accent" : "text-text hover:bg-surface",
          )}
        >
          {isPicked && <Check className="size-3.5 flex-none" aria-hidden="true" />}
          <span className="truncate">{hit.label}</span>
          {showNamespace && <TagNamespaceMark namespace={hit.namespace} />}
          {/* Mono and tabular, because it is a figure and a column of them has to line up.
              The unit is written out — see `tagReachLabel` for why a bare number here would be
              a quantity of nothing in particular. */}
          <span className="ml-auto flex-none font-mono text-[0.6875rem] tabular-nums text-dim">
            {reach}
          </span>
        </button>
      </div>

      {/* Mounted only while open: this is where the laziness actually lives. */}
      {open && <TagLevel parent={hit} namespace={hit.namespace} path={path} level={level + 1} />}
    </li>
  );
}
