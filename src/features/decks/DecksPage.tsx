import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  FolderInput,
  Plus,
  Trash2,
} from "lucide-react";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { CardImage } from "@/components/CardImage";
import { ART_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type DeckRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import {
  buildFolderTree,
  deckDraggable,
  flattenFolders,
  folderDescendants,
  FolderTree,
  MoveToFolder,
  plural,
  useDeckDragging,
  useDeckDropTarget,
  type DeckDrag,
  type FolderNode,
} from "./FolderTree";
import { useDeckFolders } from "./useDeckFolders";
import { useDecks, type Decks } from "./useDecks";
import { useFormatSpecs } from "./useFormatSpecs";

/**
 * The wall.
 *
 * `auto-fill`, not `auto-fit`: with two decks in the gallery `auto-fit` collapses the empty
 * tracks and stretches those two across the whole window, which blows a 626 px art crop up to
 * half a screen. `auto-fill` keeps a tile a tile.
 */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4";

/** Every icon control on a tile, so four of them are one row rather than four sizes. */
const ICON_BUTTON = cn(
  "grid size-6 place-items-center rounded-md text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/** The quiet controls in the wall's heading row — everything that is not "New deck". Same
 *  height as it, because a row of controls that disagree about their own size reads as two
 *  rows that happen to be next to each other. */
const HEADING_BUTTON = cn(
  "h-9 rounded-md border border-border bg-surface px-3 text-sm text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * What a new deck's format is until the reader says otherwise — `decks.format_key`'s own DDL
 * default and `deck::DEFAULT_FORMAT`, spelled here because the picker has to *select*
 * something before the seeded table has answered.
 *
 * Casual rather than the first row of the list: Casual caps nothing and is judged against no
 * card pool, so a deck that has not been given a format yet is not a deck full of complaints.
 */
const DEFAULT_FORMAT = "casual";

/**
 * Scryfall's image policy (spec §5/§10), which is why it is not conditional on there being
 * any art on screen: the credit belongs to the interface that shows card images, and this
 * gallery is one whether or not a deck has picked a cover yet.
 */
const CREDIT = "Card images © Wizards of the Coast · Data © Scryfall";

/** How many member covers a folder card shows. Three, because the strip is 96px tall and a
 *  fourth crop at that width is a smear rather than a picture. */
const FOLDER_ARTS = 3;

/**
 * Which of a deck's two lists exist — the one thing a tile can say about a deck that a
 * card count cannot.
 *
 * Derived rather than stored, from the two fields `deck_list` already answers.
 * {@link DeckRow.cardCount} counts the **live** list only, so a deck with theory switched on
 * and nothing live in it is a plan and not yet a deck: `THEORY ONLY`. One derivation, because
 * a badge and the editor's Live/Theory switch must never disagree about which lists a deck has.
 */
export type DeckBadge = "LIVE" | "LIVE + THEORY" | "THEORY ONLY";

export function deckBadge(deck: DeckRow): DeckBadge {
  if (!deck.theoryEnabled) return "LIVE";
  return deck.cardCount === 0 ? "THEORY ONLY" : "LIVE + THEORY";
}

/**
 * The one dismissible layer this view can have open, and there is deliberately only ever one.
 *
 * `useDismissOnEscape` orders exactly two rungs — one capture-phase `"inner"` layer and one
 * bubble-phase `"outer"` one — so two `"inner"` peers open at once are not ordered at all and
 * would both close on a single press. Modelling every panel on this screen as *one* piece of
 * state is what makes "never two" structural rather than remembered; the tree's create field
 * is in here for that reason even though it is drawn inline rather than floating.
 */
type Panel =
  | { kind: "createDeck" }
  | { kind: "deleteDeck"; deckId: number }
  | { kind: "moveDeck"; deckId: number }
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | null;

/**
 * The decks, filed.
 *
 * Two columns: the folders on the left, and on the right the one folder the reader is standing
 * in — its sub-folders as dashed cards, then its decks as the art they were built around. The
 * gallery's whole story is still the covers, so the chrome is a heading, a count, four controls
 * and one credit line.
 */
export function DecksPage() {
  const decks = useDecks();
  const folders = useDeckFolders();
  const { query } = decks;
  const queryClient = useQueryClient();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const returnToDeckId = useAppStore((s) => s.returnToDeckId);
  const clearReturnToDeck = useAppStore((s) => s.clearReturnToDeck);
  const [panel, setPanel] = useState<Panel>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** Which drawer is open. `null` is the top level, which is also where every deck is drawn
   *  when the folder list could not be read. */
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const newDeckRef = useRef<HTMLButtonElement>(null);
  const wallRef = useRef<HTMLElement>(null);
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);

  /** The deck in the air, or `null` — what every drawer that could take *it* lights up for. */
  const drag = useDeckDragging();

  /**
   * Filing a deck, which is the one write on this screen that {@link DeckPatch} cannot express.
   *
   * A patch writes every column with `coalesce(?n, column)`, so a bound NULL reads as "leave
   * it": there is no patch that un-files a deck, and a drag out of a folder written as one
   * would silently do nothing. `deck_set_folder` is the command where `null` means the root.
   *
   * Defined here rather than in `useDecks` because this screen is the only surface that files
   * anything; it invalidates the same `["decks"]` root every other deck write does, on the way
   * out as well as on the way in — a refusal here is a busy database or a folder another
   * surface has already deleted, and the second must not leave a tile drawn in a drawer that is
   * gone.
   */
  const setFolder = useMutation({
    mutationFn: ({ deckId, folderId }: { deckId: number; folderId: number | null }) =>
      ipc.deckSetFolder(deckId, folderId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["decks"] }),
    onError: () => void queryClient.invalidateQueries({ queryKey: ["decks"] }),
  });

  /**
   * The folder a deck is drawn in.
   *
   * A `folderId` naming a folder this list does not carry reads as the root — the same rule
   * `buildFolderTree` uses for a folder whose parent is missing, and the reason a refused
   * folder list still shows every deck the reader has rather than hiding the filed ones behind
   * a tree that never arrived.
   */
  const known = useMemo(() => new Set(folders.folders.map((f) => f.id)), [folders.folders]);
  const folderOf = useCallback(
    (deck: DeckRow) => (deck.folderId !== null && known.has(deck.folderId) ? deck.folderId : null),
    [known],
  );

  const nodes = useMemo(
    () => buildFolderTree(folders.folders, decks.decks),
    [folders.folders, decks.decks],
  );

  const live = useMemo(() => decks.decks.filter((d) => !d.archived), [decks.decks]);
  const archived = useMemo(() => decks.decks.filter((d) => d.archived), [decks.decks]);

  /**
   * The open drawer, resolved against the tree rather than trusted.
   *
   * A folder deleted by this screen or by another surface leaves `selectedFolderId` naming
   * nothing, and this is where that is corrected — by *deriving* the answer instead of writing
   * it back. There is no effect, so there is no render where the heading says a folder that is
   * not there; the stale number simply stops resolving and the reader is at the top level, one
   * click from anywhere.
   */
  const openNode = useMemo(
    () =>
      selectedFolderId === null
        ? null
        : (flattenFolders(nodes).find((n) => n.folder.id === selectedFolderId) ?? null),
    [nodes, selectedFolderId],
  );
  /** The selection as the wall can honour it: the number above, or the root. */
  const folderView = openNode?.folder.id ?? null;
  const childFolders = openNode === null ? nodes : openNode.children;

  const here = useMemo(
    () => live.filter((d) => folderOf(d) === folderView),
    [live, folderOf, folderView],
  );
  const archivedHere = useMemo(
    () => archived.filter((d) => folderOf(d) === folderView),
    [archived, folderOf, folderView],
  );

  /** The deck an editor just closed on, once the wall has read enough to know where it is
   *  filed. `null` while the query is out, and for a deck deleted from inside its own editor. */
  const returningDeck = useMemo(
    () =>
      returnToDeckId === null
        ? null
        : (decks.decks.find((d) => d.id === returnToDeckId) ?? null),
    [returnToDeckId, decks.decks],
  );

  /**
   * Coming back from an editor opens the drawer the deck is filed in — because a tile in a
   * folder nobody is standing in is not a tile the caret can be handed back to.
   *
   * A **render-phase** adjustment, which is React's own answer to "change some state when
   * something upstream changes" and not an effect: React throws this render away and restarts
   * it before committing, so the tile exists in the DOM by the time the focus effect below
   * runs — one pass, no flash of the wrong wall, and no cascade for the lint rule to object to.
   * Latched on the deck's id so it happens once per return rather than on every render.
   */
  const [returnedFor, setReturnedFor] = useState<number | null>(null);
  if (returningDeck !== null && returnedFor !== returningDeck.id) {
    setReturnedFor(returningDeck.id);
    setSelectedFolderId(folderOf(returningDeck));
  }

  // …and the hand-back itself. It waits for the query rather than running on mount, and it
  // clears the note either way once the answer is in, so a deck deleted from inside its own
  // editor does not leave one pending forever.
  useEffect(() => {
    if (returnToDeckId === null || query.isPending) return;
    wallRef.current
      ?.querySelector<HTMLButtonElement>(`[data-deck-id="${returnToDeckId}"]`)
      ?.focus();
    clearReturnToDeck();
  }, [returnToDeckId, query.isPending, decks.decks, clearReturnToDeck]);

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab
  // restarts from the top of the app.
  //
  // This is the **keyboard** way out — Escape, and the panels' own Cancel controls. The
  // click-away way out is `close` below and is a different function on purpose: CLAUDE.md's
  // rule is that an outside click does *not* hand the caret back, because the reader is
  // already somewhere else, and one function wired to both paths breaks it in two visible
  // ways (a Tab forward out of Cancel bounces backwards, and a control that disables itself
  // mid-write blurs into a hand-back nobody asked for).
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);

  /** The click-away way out: the layer goes, the caret stays where the reader put it. */
  const close = useCallback(() => setPanel(null), []);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: panel !== null });

  const openCreate = useCallback(() => {
    // A refusal from the last attempt is not news about this one.
    decks.create.reset();
    openerRef.current = newDeckRef.current;
    setPanel({ kind: "createDeck" });
  }, [decks.create]);

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLButtonElement) => {
    openerRef.current = opener;
    setPanel(next);
  }, []);

  const askDelete = useCallback(
    (deck: DeckRow, opener: HTMLButtonElement) =>
      open({ kind: "deleteDeck", deckId: deck.id }, opener),
    [open],
  );

  const askMove = useCallback(
    (deck: DeckRow, opener: HTMLButtonElement) => open({ kind: "moveDeck", deckId: deck.id }, opener),
    [open],
  );

  const confirmDelete = useCallback(
    (deck: DeckRow) => {
      decks.remove.mutate(deck.id, {
        onSuccess: () => {
          // The tile the caret was on is about to leave with the deck, so the hand-back goes
          // to the one control that is certainly still there.
          openerRef.current = null;
          setPanel(null);
          newDeckRef.current?.focus();
        },
      });
    },
    [decks.remove],
  );

  const onCreated = useCallback(
    (deck: DeckRow) => {
      // Nobody makes a deck in order to look at a tile of it.
      setOpenDeckId(deck.id);
      dismiss();
    },
    [dismiss, setOpenDeckId],
  );

  const createFolder = useCallback(
    (parentId: number | null, name: string) => {
      folders.create.mutate(
        { parentId, name },
        {
          onSuccess: (folder) => {
            // Made in order to put something in it: the new drawer is the one the reader is
            // standing in when the field closes.
            setSelectedFolderId(folder.id);
            dismiss();
          },
        },
      );
    },
    [folders.create, dismiss],
  );

  const fileDeck = useCallback(
    (drag: DeckDrag, folderId: number | null) =>
      setFolder.mutate({ deckId: drag.deckId, folderId }),
    [setFolder],
  );

  // Back where it already is is not a move: it would write nothing, bump `updated_at` and
  // leave the wall exactly as it was — `dropWrite`'s rule about a card dropped in its own
  // column, one floor up.
  const canFile = useCallback(
    (drag: DeckDrag, folderId: number | null) => {
      const deck = decks.decks.find((d) => d.id === drag.deckId);
      return deck !== undefined && folderOf(deck) !== folderId;
    },
    [decks.decks, folderOf],
  );

  const failure = query.isError ? ipcError(query.error) : null;
  const status = query.isPending ? "Reading your decks…" : failure;
  // The *latest* write on the screen, not whichever is still holding an error: a refused
  // archive used to leave its banner up while the reader went on to duplicate something
  // successfully, which is an alert about a thing already dealt with (the collection table's
  // lesson). The folder writes are in the list because they are writes this screen makes —
  // including the one refusal that is a sentence worth reading, a folder moved into its own
  // descendant.
  const writes = [
    decks.update,
    decks.remove,
    decks.duplicate,
    setFolder,
    folders.create,
    folders.move,
    folders.remove,
  ];
  const lastWrite = writes.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a));
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;

  const heading = openNode === null ? "All decks" : openNode.folder.name;
  const counts = [
    childFolders.length > 0 ? plural(childFolders.length, "folder") : null,
    plural(here.length, "deck"),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <section ref={wallRef} className="flex h-full flex-col gap-3">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second "Decks" under it
          would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Decks</h2>

      {writeFailure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not change your decks — {writeFailure}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-5">
        <FolderTree
          nodes={nodes}
          totalDecks={live.length}
          selectedId={folderView}
          onSelect={setSelectedFolderId}
          drag={drag}
          canDropIn={canFile}
          onDropIn={fileDeck}
          creatingAt={panel?.kind === "newFolder" ? { parentId: panel.parentId } : null}
          onOpenCreate={(parentId, opener) => {
            folders.create.reset();
            open({ kind: "newFolder", parentId }, opener);
          }}
          onCloseCreate={close}
          onCreate={createFolder}
          creating={folders.create.isPending}
          failure={folders.query.isError ? ipcError(folders.query.error) : null}
          pending={folders.query.isPending}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* A heading, not a caption: the tree's own `h2` is beside it and the wall is the
                other half of the same outline. */}
            <h2 className="font-heading text-xl leading-none">{heading}</h2>
            <span className="font-mono text-[0.7rem] tabular-nums text-dim">{counts}</span>

            <div className="ml-auto flex items-center gap-2">
              {openNode !== null && (
                <>
                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={panel?.kind === "moveFolder"}
                      aria-haspopup="dialog"
                      onClick={(e) =>
                        panel?.kind === "moveFolder"
                          ? dismiss()
                          : open({ kind: "moveFolder", folderId: openNode.folder.id }, e.currentTarget)
                      }
                      className={HEADING_BUTTON}
                    >
                      Move folder…
                    </button>
                    {panel?.kind === "moveFolder" && (
                      <MoveToFolder
                        label={`Move ${openNode.folder.name} into a folder`}
                        nodes={nodes}
                        currentId={openNode.folder.parentId}
                        forbidden={
                          new Set([
                            openNode.folder.id,
                            ...folderDescendants(folders.folders, openNode.folder.id),
                          ])
                        }
                        forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
                        pending={folders.move.isPending}
                        onPick={(parentId) => {
                          folders.move.mutate(
                            { id: openNode.folder.id, parentId },
                            { onSuccess: dismiss },
                          );
                        }}
                        onClose={close}
                      />
                    )}
                  </div>

                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={panel?.kind === "deleteFolder"}
                      aria-haspopup="dialog"
                      onClick={(e) =>
                        panel?.kind === "deleteFolder"
                          ? dismiss()
                          : open(
                              { kind: "deleteFolder", folderId: openNode.folder.id },
                              e.currentTarget,
                            )
                      }
                      className={cn(HEADING_BUTTON, "hover:text-destructive")}
                    >
                      Delete folder
                    </button>
                    {panel?.kind === "deleteFolder" && (
                      <DeleteFolderConfirm
                        node={openNode}
                        pending={folders.remove.isPending}
                        onConfirm={() =>
                          folders.remove.mutate(openNode.folder.id, {
                            onSuccess: () => {
                              openerRef.current = null;
                              setPanel(null);
                              setSelectedFolderId(openNode.folder.parentId);
                            },
                          })
                        }
                        onCancel={dismiss}
                        onClose={close}
                      />
                    )}
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={(e) => {
                  folders.create.reset();
                  open({ kind: "newFolder", parentId: folderView }, e.currentTarget);
                }}
                className={HEADING_BUTTON}
              >
                New folder
              </button>

              <NewDeck
                buttonRef={newDeckRef}
                open={panel?.kind === "createDeck"}
                onOpen={openCreate}
                onDismiss={dismiss}
                onClose={close}
                create={decks.create}
                onCreated={onCreated}
              />
            </div>
          </div>

          {/* Mounted for the life of the view and swapped into: a live region that appears
              together with its own text announces nothing, because there was no change for a
              screen reader to notice. */}
          <p
            role="status"
            className={cn(
              status && "py-16 text-center text-sm",
              failure ? "text-destructive" : "text-dim",
            )}
          >
            {status}
          </p>

          {!status && decks.decks.length === 0 && (
            <p className="mx-auto max-w-prose py-16 text-center text-sm text-dim">
              A deck is a list you build for a format. Start one and the app checks it as you go —
              deck size, copy limits, the commander's colours — and tells you which of the cards
              you already own.
            </p>
          )}

          {!status && decks.decks.length > 0 && childFolders.length === 0 && here.length === 0 && (
            <p className="mx-auto max-w-prose py-12 text-center text-sm text-dim">
              {openNode === null
                ? "Every deck you have is filed in a folder. Open one on the left."
                : `Nothing is filed in ${openNode.folder.name} yet. Drag a deck onto it, or use the Move control on a tile.`}
            </p>
          )}

          {(childFolders.length > 0 || here.length > 0) && (
            // Named, the way the search's wall of art is (`CardGrid`'s `role="group"` +
            // `aria-label`) — but left a list rather than made a group, because these tiles are
            // countable and a list says how many there are on the way in.
            <ul aria-label="Your decks" className={GRID}>
              {childFolders.map((node) => (
                <FolderCard
                  key={node.folder.id}
                  node={node}
                  members={decksUnder(node, live, folderOf)}
                  drag={drag}
                  canDrop={(d) => canFile(d, node.folder.id)}
                  onDropDeck={(d) => fileDeck(d, node.folder.id)}
                  onOpen={setSelectedFolderId}
                />
              ))}
              {here.map((deck) => (
                <DeckTile
                  key={deck.id}
                  deck={deck}
                  decks={decks}
                  nodes={nodes}
                  folderId={folderOf(deck)}
                  panel={panel}
                  moving={setFolder.isPending}
                  onOpen={setOpenDeckId}
                  onAskDelete={askDelete}
                  onAskMove={askMove}
                  onMove={(folderId) =>
                    setFolder.mutate({ deckId: deck.id, folderId }, { onSuccess: dismiss })
                  }
                  onConfirmDelete={confirmDelete}
                  onCancelPanel={dismiss}
                  onClosePanel={close}
                />
              ))}
            </ul>
          )}

          {!status && here.length === 0 && archivedHere.length > 0 && (
            <p className="py-8 text-center text-sm text-dim">
              Nothing here — every deck in this folder is filed away below.
            </p>
          )}

          {archivedHere.length > 0 && (
            <div className={cn(here.length > 0 && "mt-4 border-t border-border pt-4")}>
              {/* A disclosure rather than a second wall: filed decks are kept, not shown. */}
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md text-xs text-dim",
                  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                    showArchived && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                Archived <span className="font-mono tabular-nums">{archivedHere.length}</span>
              </button>
              {showArchived && (
                <ul aria-label="Archived decks" className={cn(GRID, "mt-3")}>
                  {archivedHere.map((deck) => (
                    <DeckTile
                      key={deck.id}
                      deck={deck}
                      decks={decks}
                      nodes={nodes}
                      folderId={folderOf(deck)}
                      panel={panel}
                      moving={setFolder.isPending}
                      onOpen={setOpenDeckId}
                      onAskDelete={askDelete}
                      onAskMove={askMove}
                      onMove={(folderId) =>
                        setFolder.mutate({ deckId: deck.id, folderId }, { onSuccess: dismiss })
                      }
                      onConfirmDelete={confirmDelete}
                      onCancelPanel={dismiss}
                      onClosePanel={close}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-[0.7rem] text-dim">{CREDIT}</p>
    </section>
  );
}

/** Every live deck filed in a folder **or in anything under it** — what a folder card draws
 *  its strip of art from, in `deck_list`'s own order (most recently touched first). */
function decksUnder(
  node: FolderNode,
  live: readonly DeckRow[],
  folderOf: (deck: DeckRow) => number | null,
): DeckRow[] {
  const ids = new Set(flattenFolders([node]).map((n) => n.folder.id));
  return live.filter((deck) => {
    const id = folderOf(deck);
    return id !== null && ids.has(id);
  });
}

/**
 * A folder on the wall: what is in it, drawn from the art of the decks it holds.
 *
 * Dashed, where a deck tile is not — and that dash is the screen's one visual rule: **dashed
 * means provisional**. A folder is a container rather than a thing you can play, and a deck
 * that exists only as a theory list is a plan rather than a deck. Both wear it; nothing else
 * does.
 */
function FolderCard({
  node,
  members,
  drag,
  canDrop,
  onDropDeck,
  onOpen,
}: {
  node: FolderNode;
  members: readonly DeckRow[];
  drag: DeckDrag | null;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  onOpen: (id: number) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  const eligible = drag !== null && canDrop(drag);

  // Scryfall's image policy, applied to a strip exactly as it is to a cover: an `art` crop has
  // no printed frame, so a cover this app cannot name an illustrator for is not drawn. That
  // also excludes a reader's own uploaded cover, which has no Scryfall artist by construction.
  const arts = members
    .flatMap((deck) =>
      deck.coverCardId !== null && deck.coverArtist !== null
        ? [{ id: deck.id, cardId: deck.coverCardId, artist: deck.coverArtist }]
        : [],
    )
    .slice(0, FOLDER_ARTS);
  const artists = [...new Set(arts.map((art) => art.artist))].join(", ");

  return (
    <li ref={ref} className={cn("group relative rounded-xl", eligible && DROP_RING)}>
      <button
        type="button"
        // Starts with the visible label, then says the two things the card's marks say — WCAG
        // 2.5.3, and the reason the count is not spliced into the middle of the name.
        aria-label={`${node.folder.name} folder, ${plural(node.deckCount, "deck")}`}
        onClick={() => onOpen(node.folder.id)}
        className={cn(
          "block w-full rounded-xl border border-dashed border-border p-2.5 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          over && cn("border-accent", DROP_OVER),
          FOCUS,
        )}
      >
        <span className="flex h-24 gap-[3px] overflow-hidden rounded-md bg-surface">
          {arts.length === 0 ? (
            <span
              aria-hidden="true"
              className="grid w-full place-items-center text-[0.7rem] text-dim"
            >
              {node.deckCount === 0 ? "Empty" : "No cover art"}
            </span>
          ) : (
            arts.map((art) => <MemberArt key={art.id} cardId={art.cardId} />)
          )}
        </span>
        <span className="mt-2 flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{node.folder.name}</span>
          <span className="flex-none font-mono text-[0.7rem] tabular-nums text-dim">
            {node.deckCount}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-dim">Folder</span>
      </button>

      {/* The price of the crop, per folder card, exactly as it is per tile: an art crop carries
          no printed frame, so every illustrator whose work is on this card is named. */}
      {artists && (
        <p className="mt-0.5 truncate text-[0.7rem] text-dim" title={artists}>
          Art by {artists}
        </p>
      )}
    </li>
  );
}

/** One member cover in a folder card's strip. Its own component because {@link useImageRetry}
 *  is a hook and a strip is a loop. */
function MemberArt({ cardId }: { cardId: string }) {
  const image = useImageRetry(cardImageUrl(cardId, 0, "art"));
  return (
    <span className="min-w-0 flex-1 overflow-hidden bg-surface">
      {image.src && (
        <CardImage
          // Decorative: the folder's name is under it, and the credit is its own line.
          alt=""
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}

/**
 * One deck: its cover art, its name, what it is and how big it is.
 *
 * The art is the tile — an `art` crop rather than a card image, because a wall of full cards
 * is what the *search* looks like and a deck is not a card. The price of the crop is the
 * credit line under it: an art crop carries no printed frame, so the illustrator is named
 * wherever one is shown.
 */
function DeckTile({
  deck,
  decks,
  nodes,
  folderId,
  panel,
  moving,
  onOpen,
  onAskDelete,
  onAskMove,
  onMove,
  onConfirmDelete,
  onCancelPanel,
  onClosePanel,
}: {
  deck: DeckRow;
  decks: Decks;
  nodes: readonly FolderNode[];
  /** The folder it is in now, normalised through the folder list this screen actually has. */
  folderId: number | null;
  panel: Panel;
  moving: boolean;
  onOpen: (id: number) => void;
  onAskDelete: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onAskMove: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onMove: (folderId: number | null) => void;
  onConfirmDelete: (deck: DeckRow) => void;
  /** Cancel: a control *in* the layer, so the caret goes back to what opened it. */
  onCancelPanel: () => void;
  /** Clicked or tabbed away: the layer goes and the caret stays where it went. */
  onClosePanel: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const { id, name } = deck;

  // The gesture half of filing. The whole tile is the handle — the art is the deck — and the
  // controls in the corner mark themselves `data-no-drag` so a press on Delete is a press on
  // Delete rather than the first five pixels of a drag.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return deckDraggable({ element, payload: () => ({ deckId: id, name }) });
  }, [id, name]);

  /** One derivation of the plural, for the caption and the question that quotes it. */
  const unit = deck.cardCount === 1 ? "card" : "cards";
  const badge = deckBadge(deck);
  const confirming = panel?.kind === "deleteDeck" && panel.deckId === deck.id;
  const choosingFolder = panel?.kind === "moveDeck" && panel.deckId === deck.id;

  return (
    <li ref={ref} className="group relative">
      {/* The art and the caption are one button — a deck is picked by looking at it, and a
          reader who aims at the name should not miss. The controls below are siblings of it
          rather than children: a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        // How the caret finds its way back here from an editor: the tile the reader left
        // through is the tile they should return to, and this is the only handle that
        // survives the gallery unmounting while the editor is up.
        data-deck-id={deck.id}
        className={cn("block w-full rounded-lg text-left", FOCUS)}
      >
        <Cover cardId={deck.coverCardId} />
        <span className="mt-2 block truncate text-sm">{deck.name}</span>
        <span className="mt-0.5 block truncate text-xs text-dim">
          {deck.formatName ?? deck.formatKey} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span> {unit}
        </span>
      </button>

      {/* Which lists this deck has, over its own art. Outside the button rather than in it:
          `aria-label` would otherwise read the badge before the name, and the tile is named
          for its deck. `pointer-events-none` so a corner of the picture is not a dead spot. */}
      <span
        className={cn(
          "pointer-events-none absolute left-1.5 top-1.5 rounded-sm border bg-bg/70 px-1.5",
          "font-mono text-[0.6rem] leading-4 tracking-wide",
          badge === "LIVE" ? "border-border text-dim" : "border-accent text-accent",
          // Dashed means provisional, here as on a folder card: a theory list is a plan.
          badge === "THEORY ONLY" && "border-dashed",
        )}
      >
        {badge}
      </span>

      {/* Scryfall's image policy, per tile — and the plan's ruling: a cover whose artist is
          unknown draws no line at all, never the word "null" and never a placeholder. An
          orphaned cover heals itself on the next sync. */}
      {deck.coverArtist && (
        <p className="mt-0.5 truncate text-[0.7rem] text-dim" title={deck.coverArtist}>
          Art by {deck.coverArtist}
        </p>
      )}

      {/* Invisible until the tile is hovered or holds the caret — a wall of art is not a wall
          of buttons — and always in the tab order, because "visible on hover" is not a state a
          keyboard has. Over the art's corner on the app's own felt at 85%, which is the
          quietest thing that can sit on a picture.

          Mounted through the delete question as well, rather than swapped out for it: the
          question hands the caret back to the control that asked it, and a control that
          unmounts on the way up is one that drops focus onto `<body>` on the way down. Focus
          being *inside* the tile is also what keeps this row visible while the question is
          open — `group-focus-within`, the same clause that answers a keyboard. */}
      <div
        className={cn(
          "absolute right-1 top-1 flex gap-0.5 rounded-md bg-bg/85 p-0.5",
          REVEAL_ON_HOVER,
        )}
      >
        <button
          type="button"
          data-no-drag=""
          aria-label={`Move ${deck.name} to a folder`}
          aria-expanded={choosingFolder}
          aria-haspopup="dialog"
          title="Move to a folder"
          onClick={(e) => (choosingFolder ? onCancelPanel() : onAskMove(deck, e.currentTarget))}
          className={ICON_BUTTON}
        >
          <FolderInput className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Duplicate ${deck.name}`}
          title="Duplicate"
          onClick={() => decks.duplicate.mutate(deck.id)}
          className={ICON_BUTTON}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`${deck.archived ? "Restore" : "Archive"} ${deck.name}`}
          title={deck.archived ? "Restore" : "Archive"}
          onClick={() => decks.update.mutate({ id: deck.id, patch: { archived: !deck.archived } })}
          className={ICON_BUTTON}
        >
          {deck.archived ? (
            <ArchiveRestore className="size-3.5" aria-hidden="true" />
          ) : (
            <Archive className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Delete ${deck.name}`}
          title="Delete"
          onClick={(e) => onAskDelete(deck, e.currentTarget)}
          className={cn(ICON_BUTTON, "hover:text-destructive")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {choosingFolder && (
        <MoveToFolder
          label={`Move ${deck.name} to a folder`}
          nodes={nodes}
          currentId={folderId}
          pending={moving}
          onPick={onMove}
          onClose={onClosePanel}
        />
      )}

      {confirming && (
        <DeleteConfirm
          deck={deck}
          cards={`${deck.cardCount} ${unit}`}
          pending={decks.remove.isPending}
          onConfirm={() => onConfirmDelete(deck)}
          onCancel={onCancelPanel}
          onClose={onClosePanel}
        />
      )}
    </li>
  );
}

/**
 * What a cover is doing about its image — `CardGrid`'s `Tile`, in the one shape a deck needs.
 *
 * The frame is its own, because the two disagree about what a failure *looks* like: a card
 * tile falls back to the card's own name inside the frame, while a deck tile already has its
 * name in the caption underneath and needs the frame to say what happened instead — and it has
 * a third thing to say, "No cover", which is not a failure at all. What is shared is
 * {@link useImageRetry}: the schedule, and the reason for it. A deck that changes its cover
 * hands this component a different id without remounting it, which is exactly the reset the
 * hook does.
 */
function Cover({ cardId }: { cardId: string | null }) {
  const url = cardId ? cardImageUrl(cardId, 0, "art") : null;
  const image = useImageRetry(url);

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // Decorative: the deck's name is in the caption two lines down, and an `alt` here
          // would announce the tile twice.
          alt=""
          // Keyed on the `src` inside {@link CardImage}, which is what makes the note above
          // this component true rather than merely intended: a deck that changes its cover is
          // handed a different id without remounting, and the frame would otherwise keep
          // painting the old cover until the new crop arrived.
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className={cn(
            "size-full object-cover transition-transform duration-150",
            "group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          )}
        />
      ) : (
        // Says what the empty frame is for rather than leaving a grey rectangle that reads as
        // a rendering fault — and tells "this deck has no cover yet" apart from "the art did
        // not arrive", which are two different things to do something about. Out of the
        // accessible name, which is the deck.
        <span aria-hidden="true" className="text-[0.7rem] text-dim">
          {!url ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deckDelete` really deletes — the deck, its cards and its claims, by cascade — and a deck
 * is minutes of work, so the destructive control asks once, in words, naming what it would
 * take and offering the reversible thing instead.
 */
function DeleteConfirm({
  deck,
  cards,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  deck: DeckRow;
  cards: string;
  pending: boolean;
  onConfirm: () => void;
  /** The Cancel control, which is *in* here: hands the caret back to what opened the layer. */
  onCancel: () => void;
  /** Focus left the layer on its own. Closes and hands nothing back. */
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // The caret moves into the layer, as it does for every other one in the app: the panel's
  // own controls are then the next thing Tab reaches, and Escape has something to hand back.
  // Neither button is focused — the reader has not decided yet, and a stray Enter should not
  // decide for them.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Delete ${deck.name}`}
      data-no-drag=""
      // Anchored to the tile, not portalled: the shipped CSP is `style-src 'self'` and every
      // overlay primitive in reach injects a runtime <style> the moment it opens — fine under
      // `tauri dev`, blank in a packaged build. `SetCombobox`'s decision, for its reason. Not
      // `aria-modal` either: the gallery behind it stays live.
      // `top-8` rather than the tile's own top edge: the actions row stays where it was, so
      // the question reads as having dropped out of the control that asked it — and the
      // control the caret goes back to is still on screen while the reader decides.
      className={cn(
        "absolute inset-x-0 top-8 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      // Clicking or tabbing away is an answer too, and it is the safe one — `onClose`, not
      // `onCancel`: the reader is already somewhere else, and yanking the caret back to the
      // trash icon would bounce a Tab forward straight backwards.
      //
      // Not while the delete is in flight. `Delete deck` disables itself on the press, a
      // disabled control is blurred by the browser with no `relatedTarget` at all, and this
      // handler would read that as the reader leaving and take the panel down mid-write —
      // so the pending state is never seen and the answer arrives over a question that is
      // no longer on screen.
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{deck.name}”?</p>
      <p className="mt-1 text-dim">
        Its {cards} {deck.cardCount === 1 ? "goes" : "go"} with it. Archiving keeps the deck
        instead.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete deck
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The other question, and the one whose answer a reader will guess wrong.
 *
 * **Deleting a folder does not delete the decks in it.** `decks.folder_id` is
 * `ON DELETE SET NULL`, so they surface at the top level, filed nowhere and otherwise exactly
 * as they were. `deck_folders.parent_id` is `ON DELETE CASCADE` on itself, so the folders
 * inside *do* go. The two cascades point opposite ways and the confirmation says both, in that
 * order — the reassuring half first, because the fear is what stops the press.
 */
function DeleteFolderConfirm({
  node,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  node: FolderNode;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const inside = flattenFolders(node.children).length;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Delete ${node.folder.name}`}
      className={cn(
        "absolute right-0 top-9 w-72 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{node.folder.name}”?</p>
      <p className="mt-1 leading-relaxed text-dim">
        {node.deckCount === 0
          ? "It holds no decks."
          : `The ${plural(node.deckCount, "deck")} in it ${
              node.deckCount === 1 ? "is" : "are"
            } kept — ${node.deckCount === 1 ? "it moves" : "they move"} to the top level.`}
        {inside > 0 &&
          ` The ${plural(inside, "folder")} inside ${inside === 1 ? "goes" : "go"} with it.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete folder
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The view's one primary action, and the form behind it. */
function NewDeck({
  buttonRef,
  open,
  onOpen,
  onDismiss,
  onClose,
  create,
  onCreated,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
  /** Escape, and the trigger pressed a second time: the caret comes back here. */
  onDismiss: () => void;
  /** Focus left the form on its own. Closes and hands nothing back. */
  onClose: () => void;
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rootRef}
      className="relative"
      // Clicking or tabbing away closes the form, and does it without a window listener that
      // could fight the Escape handshake — `AddToCollection`'s arrangement, for its reason.
      // The boundary is the whole control rather than the panel: on `relatedTarget` being the
      // trigger, closing here would race the toggle below and leave the form open forever.
      //
      // A half-typed name is discarded, exactly as every other popup in this app discards its
      // half-made decision (the quick-add loses its quantity, the set picker its query). One
      // rule for all of them is worth more than a rescued word — and the alternative, a
      // trigger that refuses to close while the field is dirty, is a control that stops
      // working for a reason the reader cannot see.
      //
      // Not while the deck is being written, though, and this is the same mechanism the delete
      // question guards against: `Create deck` disables itself on the press, the browser blurs
      // a disabled control with no `relatedTarget` at all, and this handler would read the
      // press as the reader leaving — closing the form *as if it had worked*. It is worse here
      // than there, because this form is the only place a refusal can be read: `writeFailure`
      // above covers the writes a tile makes, not this one, and reopening the form calls
      // `create.reset()`. So a refused create would leave no deck and no sentence saying why.
      onBlur={(e) => {
        if (create.isPending) return;
        if (open && !rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border border-accent px-3 text-sm",
          "text-accent transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
        New deck
      </button>
      {open && <CreateDeckForm create={create} onCreated={onCreated} />}
    </div>
  );
}

/**
 * Two questions and no more: what it is called, and what it is for.
 *
 * The format list is the seeded `format_specs` table read in its own `sort_order`, filtered
 * to `enabled_in_picker` — which is the whole of why Future Standard, a format you can test
 * a card against but cannot build for, is not offered here.
 */
function CreateDeckForm({
  create,
  onCreated,
}: {
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  const { specs } = useFormatSpecs();
  const picker = useMemo(() => specs.filter((s) => s.enabledInPicker), [specs]);
  const [name, setName] = useState("");
  const [formatKey, setFormatKey] = useState(DEFAULT_FORMAT);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // The caret starts in the field the reader has to fill.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const failure = create.isError ? ipcError(create.error) : null;
  const trimmed = name.trim();

  return (
    <div
      role="dialog"
      aria-label="New deck"
      // Anchored rather than portalled, and not `aria-modal`: `SetCombobox`'s decision, for
      // its reason — `style-src 'self'` refuses what every overlay library injects. Pinned to
      // the trigger's **right** edge, because nothing clips these popups and this one opens at
      // the end of the heading row: a 288px panel hanging off the right of a 1280px window
      // scrolls the whole app sideways rather than being cut off.
      className={cn(
        "absolute right-0 top-11 w-72 rounded-lg border border-border bg-surface p-3",
        "shadow-lg",
        LAYER.popup,
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          create.mutate({ name: trimmed, formatKey }, { onSuccess: onCreated });
        }}
        className="space-y-3"
      >
        <div>
          <label htmlFor={`${id}-name`} className="mb-1 block text-xs text-dim">
            Name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-bg px-2 text-sm",
              "focus:border-accent focus:outline-none",
            )}
          />
        </div>
        <div>
          <label htmlFor={`${id}-format`} className="mb-1 block text-xs text-dim">
            Format
          </label>
          <select
            id={`${id}-format`}
            value={formatKey}
            onChange={(e) => setFormatKey(e.target.value)}
            // The seeded table is read once per session and is normally already in hand by
            // the time this opens; on the one launch where it is not, the select still has to
            // *say* something, and what it would create is what it shows.
            disabled={picker.length === 0}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
              "disabled:opacity-60",
              FOCUS,
            )}
          >
            {picker.length === 0 ? (
              <option value={DEFAULT_FORMAT}>Casual</option>
            ) : (
              picker.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.displayName}
                </option>
              ))
            )}
          </select>
        </div>

        {failure && (
          <p role="alert" className="text-xs text-destructive">
            Could not create the deck — {failure}
          </p>
        )}

        <button
          type="submit"
          disabled={!trimmed || create.isPending}
          className={cn(
            "h-9 w-full rounded-md border border-accent text-sm text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Create deck
        </button>
      </form>
    </div>
  );
}
