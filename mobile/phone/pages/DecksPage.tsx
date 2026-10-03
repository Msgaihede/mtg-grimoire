import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Folder } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { DeckColorBar } from "@/features/decks/DeckColorBar";
import { coverUrl, deckBadge, hasCover } from "@/features/decks/deckCover";
import { deckColorsLabel } from "@/features/decks/deckPips";
import { sortDecks } from "@/features/decks/deckSort";
import { bracketLabel, useDeckBrackets } from "@/features/decks/useDeckBrackets";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDeckPips } from "@/features/decks/useDeckPips";
import { useDecks } from "@/features/decks/useDecks";
import { useDeckSort } from "@/features/decks/useDeckSort";
import { ANY_GAME, gameLabel, useFormatSpecs } from "@/features/decks/useFormatSpecs";
import { plural } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { buildFolderTree, flattenFolders, type FolderNode } from "@/lib/folderTree";
import { ART_ASPECT } from "@/lib/images";
import type { DeckFolder, DeckRow } from "@/lib/ipc";
import type { PipCounts } from "@/lib/mana";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { linkTo } from "../router";
import { DimNote, ReadError } from "./parts";

/** The gallery's address for a folder, or for the top of the cabinet. */
const galleryAt = (folderId: number | null) =>
  ({ view: "decks", deckId: null, cardId: null, folderId }) as const;

/**
 * The reader's decks: the folders filed at the level the reader is standing in, then the decks
 * filed there as covers, then that level's archived decks behind a disclosure — the desktop
 * gallery's cabinet, read through the desktop's own hooks so the two faces order, count and
 * colour a deck the same way.
 *
 * **One folder at a time, and the folder is in the URL** (`?folder=<id>`, `routes.ts`). A drawer
 * is a place the reader walks into, so Back — Android's gesture included — walks out of it, and a
 * deck's way back lands in the folder the deck is filed in. A folder the URL names that the
 * cabinet does not hold reads as the top level, `buildFolderTree`'s rule for a missing parent: a
 * stale link is one press from everywhere rather than an empty page.
 *
 * **Two columns of covers at 360px.** A cover is the art crop at its own aspect (626 × 457), and
 * at two columns each is about 160px wide — the picture still reads as the card it is, the name
 * and the caption fit under it on a line each, and a screen holds six decks with their names. One
 * column would hold two; a list of names alone would throw away the one thing a reader picks a
 * deck by. The grid does not reflow by width (`grid-cols-2` up to 640px, three to 1024) — the
 * phone face is never drawn wider than that.
 *
 * **Each deck and each folder is a link, not a button**: it changes the URL, so it answers what
 * a link answers — a middle click, "copy link" — and a screen reader hears *link*.
 */
export function DecksPage({ folderId }: { folderId: number | null }) {
  const { decks, query } = useDecks();
  const { folders } = useDeckFolders();
  const { byDeck: pipsByDeck } = useDeckPips();
  const { sort } = useDeckSort();
  const { formatSpecFor } = useFormatSpecs();
  const [showArchived, setShowArchived] = useState(false);

  // The desktop gallery's own question, asked the same way: which decks have a bracket at all is
  // a fact about the *format*, and an empty list is no read.
  const commanderDeckIds = useMemo(
    () => decks.filter((d) => formatSpecFor(d.formatKey)?.commanderRule != null).map((d) => d.id),
    [decks, formatSpecFor],
  );
  const { floorByDeck } = useDeckBrackets(commanderDeckIds);

  const nodes = useMemo(() => buildFolderTree(folders, decks), [folders, decks]);
  // The drawer as the cabinet can honour it: the URL's folder, or the top level.
  const open = useMemo(
    () =>
      folderId === null
        ? null
        : (flattenFolders(nodes).find((n) => n.folder.id === folderId) ?? null),
    [nodes, folderId],
  );
  const level = open?.folder.id ?? null;
  const known = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const folderOf = (deck: DeckRow) =>
    deck.folderId !== null && known.has(deck.folderId) ? deck.folderId : null;

  const context = useMemo(
    () => ({ pips: pipsByDeck, brackets: floorByDeck }),
    [pipsByDeck, floorByDeck],
  );
  const here = sortDecks(
    decks.filter((d) => !d.archived && folderOf(d) === level),
    sort,
    context,
  );
  const archived = sortDecks(
    decks.filter((d) => d.archived && folderOf(d) === level),
    sort,
    context,
  );
  const childFolders = open === null ? nodes : open.children;

  const bracketFor = (deck: DeckRow) =>
    formatSpecFor(deck.formatKey)?.commanderRule != null
      ? bracketLabel(deck.bracket, floorByDeck.get(deck.id))
      : null;

  if (query.isLoadingError) return <ReadError>Your decks could not be read.</ReadError>;
  if (!query.isPending && decks.length === 0) return <DimNote>No decks</DimNote>;

  const tiles = (rows: readonly DeckRow[], label: string) => (
    <ul aria-label={label} className="grid grid-cols-2 gap-x-3 gap-y-4 px-3 sm:grid-cols-3">
      {rows.map((deck) => (
        <DeckCover
          key={deck.id}
          deck={deck}
          pips={pipsByDeck.get(deck.id) ?? null}
          bracket={bracketFor(deck)}
        />
      ))}
    </ul>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
      {open !== null && <FolderBar node={open} parentId={open.folder.parentId} known={known} />}

      {childFolders.length > 0 && (
        <ul aria-label="Folders" className="border-b border-border">
          {childFolders.map((node) => (
            <FolderRow key={node.folder.id} node={node} />
          ))}
        </ul>
      )}

      <div className="pt-3">
        {here.length > 0
          ? tiles(here, open === null ? "Your decks" : `Decks in ${open.folder.name}`)
          : !query.isPending &&
            childFolders.length === 0 && (
              <DimNote>
                {archived.length > 0
                  ? open === null
                    ? "All your decks are archived."
                    : "All decks in this folder are archived."
                  : "This folder is empty."}
              </DimNote>
            )}
      </div>

      {archived.length > 0 && (
        <div className="mt-4">
          {/* A disclosure, the desktop's: an archived deck is one the reader put away, so the
              wall does not open on it. Local state — a deck's way back to this level does not
              need to remember it, and the desktop face keeps it in the page too. */}
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((on) => !on)}
            className={cn(
              "flex min-h-11 w-full items-center gap-1.5 px-4 text-left text-sm text-dim",
              FOCUS_INSET,
            )}
          >
            {showArchived ? (
              <ChevronDown aria-hidden className="size-4 shrink-0" />
            ) : (
              <ChevronRight aria-hidden className="size-4 shrink-0" />
            )}
            Archived <span className="font-mono tabular-nums">{archived.length}</span>
          </button>
          {showArchived && tiles(archived, "Archived decks")}
        </div>
      )}
    </div>
  );
}

/**
 * The drawer the reader is standing in, and the way out of it — one level up, to the parent
 * folder or to the top of the cabinet. A link, like every other change of place here.
 */
function FolderBar({
  node,
  parentId,
  known,
}: {
  node: FolderNode<DeckFolder>;
  parentId: number | null;
  known: ReadonlySet<number>;
}) {
  // A parent the cabinet no longer holds is the top level — `buildFolderTree` drew this folder
  // at the root for exactly that reason, so the way up has to agree with where it was drawn.
  const up = parentId !== null && known.has(parentId) ? parentId : null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
      <a
        {...linkTo(galleryAt(up))}
        aria-label={up === null ? "Back to all decks" : "Up one folder"}
        className={cn("flex size-11 items-center justify-center rounded-md text-dim", FOCUS)}
      >
        <ChevronLeft aria-hidden className="size-5" />
      </a>
      <h2 className="min-w-0 flex-1 truncate text-base">{node.folder.name}</h2>
    </div>
  );
}

/** One folder at this level: its name and how many decks are filed anywhere beneath it. */
function FolderRow({ node }: { node: FolderNode<DeckFolder> }) {
  return (
    <li className="border-t border-border first:border-t-0">
      <a
        {...linkTo(galleryAt(node.folder.id))}
        className={cn("flex min-h-12 items-center gap-3 px-4 py-2", FOCUS_INSET)}
      >
        <Folder aria-hidden className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm">{node.folder.name}</span>
        {/* A sibling space, so the link's computed name is `Commander 1 deck` and not
            `Commander1 deck` — `src/CLAUDE.md`'s `Missing2` rule. */}{" "}
        <span className="shrink-0 text-xs text-dim">
          <span className="font-mono tabular-nums">{node.count}</span>{" "}
          {plural(node.count, "deck").replace(/^\d+ /, "")}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
      </a>
    </li>
  );
}

/** The marks over a cover's corner — the deck's kind and its bracket. `TILE_MARK`'s shape on the
 *  desktop tile, at the phone's one size. */
const MARK = cn(
  "whitespace-nowrap rounded-sm border border-accent bg-bg/75 px-1.5 font-mono text-[0.625rem] leading-4",
  "tracking-wide text-accent",
);

/**
 * One deck: its cover, what colours it is, its name, and what it is and how big.
 *
 * **The picture, the band, the name and the caption are one link**, as the desktop tile's are one
 * button — a deck is picked by looking at it, and a reader aiming at the name must not miss. The
 * two marks and the art's credit are siblings laid over the picture rather than children of the
 * link, so the link is named for its deck: an accessible name is computed from the contents in
 * order, and a mark inside would be read before the deck's name.
 *
 * **The illustrator is credited in visible type on the picture.** An art crop has no printed
 * frame, and Scryfall's image guidelines allow one only where the illustrator is named; the
 * desktop names them in the cover's tooltip, and a phone has no hover. `hasCover` is the same
 * guard either way — a crop is drawn only where there is a name to credit it to.
 */
function DeckCover({
  deck,
  pips,
  bracket,
}: {
  deck: DeckRow;
  pips: PipCounts | null;
  bracket: string | null;
}) {
  const image = useImageRetry(coverUrl(deck));
  const badge = deckBadge(deck);
  const colors = deckColorsLabel(pips);

  return (
    <li className="relative min-w-0">
      <a
        {...linkTo({ view: "decks", deckId: deck.id, cardId: null })}
        className={cn("block rounded-lg", FOCUS)}
      >
        <span
          className="grid w-full place-items-center overflow-hidden rounded-t-lg bg-surface"
          style={{ aspectRatio: ART_ASPECT }}
        >
          {image.src ? (
            <CardImage
              alt=""
              src={image.src}
              loading="lazy"
              onError={image.onError}
              className="size-full object-cover"
            />
          ) : (
            <span aria-hidden className="text-[0.6875rem] text-dim">
              {!hasCover(deck) ? "No cover" : image.retrying ? "Retrying…" : "No image"}
            </span>
          )}
        </span>
        <DeckColorBar pips={pips} />
        <span className="mt-1.5 block truncate text-sm leading-5">{deck.name}</span>
        {/* The bar in words, after the name — `DeckTile`'s order and its reason. */}
        {/* Each behind a sibling space: a name computation trims every element's part before
            joining them, so only a text node between two spans keeps their words apart. */}
        {colors !== null && (
          <>
            {" "}
            <span className="sr-only">{colors}</span>
          </>
        )}{" "}
        <span className="block truncate text-xs leading-4 text-dim">
          {deck.formatName ?? deck.formatKey}
          {deck.gameKey !== ANY_GAME && ` · ${gameLabel(deck.gameKey)}`} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span>{" "}
          {deck.cardCount === 1 ? "card" : "cards"}
        </span>
      </a>

      {(badge !== null || bracket !== null || (image.src && deck.coverArtist)) && (
        <span
          className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between p-1.5"
          style={{ aspectRatio: ART_ASPECT }}
        >
          {/* Stacked down one corner rather than spread across the top edge: a cover is about
              160px wide at 360, and `THEORY + ACTUAL` beside `BRACKET ~3` does not fit on one
              line there — each mark keeps its words whole, and the second goes under the first. */}
          <span className="flex flex-col items-start gap-1">
            {badge !== null && (
              <span className={cn(MARK, badge === "THEORY ONLY" && "border-dashed")}>{badge}</span>
            )}
            {bracket !== null && <span className={cn(MARK, "uppercase")}>{bracket}</span>}
          </span>
          {image.src && deck.coverArtist && (
            <span className="self-start truncate rounded-sm bg-bg/70 px-1 text-[0.5625rem] leading-3.5 text-dim">
              Art by {deck.coverArtist}
            </span>
          )}
        </span>
      )}
    </li>
  );
}
