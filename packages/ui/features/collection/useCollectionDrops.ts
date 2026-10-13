/**
 * The collection's **drops and the lock** — everything a drag let go on this page turns into, and
 * the one question a drag across a set-aside drawer asks before it does.
 *
 * **Out of `CollectionPage` since issue #557**, verbatim, the way `useCollectionEntryWrites` left it
 * on 2026-10-03: the page was four thousand lines and this was the largest piece of it that is about
 * one thing. A copy dropped on a heading, an empty shelf, the sticky bar or a breadcrumb segment
 * (`canFile` / `fileCard`); a printing dropped off the sidebar's search wall (`addDropped`); a
 * folder heading dropped on another heading or on a path-row segment (`folderPlacement` /
 * `levelPlacement`); and the drawer boundary a drag may cross only after asking (`lockRootOf`,
 * `crossesLock`, `crossing`). The page calls this hook and draws what it answers; nothing about any
 * of it changed on the way out.
 *
 * **The wishlist has its own (`useWishDrops`), and that is not a missed share.** The two pages'
 * drops diverge on every rule that matters — this cabinet has deck groups, `Recently removed`, a
 * lock and a copy picker; the wishlist has managed folders and none of those — so one hook over both
 * would be a hook made of branches. What the two genuinely share is already shared one level down:
 * `reorderedLevel`, `folderDescendants`, `folderLevel`.
 *
 * What it is handed is the page's census and the page's writes, held still: the folder rows, the
 * trees built from them, the effective lock, the name lookup, and the two writes a drop reuses
 * (`setFolder` — twice, a silent observer and a reporting one — and the folder reorder) as their
 * `mutate`.
 */
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import type { Finish } from "@/lib/finish";
import { folderDescendants, folderLevel, type FolderNode } from "@/lib/folderTree";
import { MENU_CONDITION } from "@/lib/conditions";
import { ipc, ipcError, type CollectionFolder, type CollectionRow } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { refreshCardSearches } from "@/lib/searchMarks";
import type { CollectionDrop } from "./collectionDrag";
import { ROOT_LABEL } from "./CollectionFolderPanel";
import { addedReceipt, movedReceipt, report } from "./collectionReceipts";

/**
 * The root as `reorderedLevel` has to address it — an id no folder has, because
 * `collection_folders.id` is an `INTEGER PRIMARY KEY` and therefore always positive.
 *
 * Only a breadcrumb segment's folder drop needs it, and only to satisfy an argument it does not use: an `inside`
 * landing reads `target` for one thing, the "dropped on itself" refusal, and a folder can never
 * be dropped on the root. The alternative is widening `reorderedLevel`'s `target` to
 * `number | null`, which would put a case in the shared arithmetic that only one caller has.
 * `DecksPage` and `WishlistPage` spell the same constant for the same reason.
 */
const ROOT_TARGET = 0;

/**
 * A drag that would carry a copy across the edge of a drawer the reader has set aside — issue
 * #365, design §5 — held for as long as the question about it is on screen.
 *
 * **The drop and its destination, verbatim**, because the answer *replays the gesture*: `Move it`
 * hands both straight back to {@link CollectionPage.fileCard}, which is where a tile standing for
 * several rows still turns into the copy picker. Nothing here is a partial write waiting to be
 * finished; the gesture simply has not happened yet.
 *
 * **`out` and `into` are the locked *drawers*, by name, and either can be `null`** — a copy going
 * into a locked binder is leaving nothing, and one coming out of it is arriving nowhere set aside.
 * Both are the **outermost** locked ancestor rather than the folder the pointer is over, which is
 * what makes the sentence true for a sub-folder: dropped into `Trade binder / Foils`, the drawer
 * that is set aside is `Trade binder`, and naming `Foils` would leave the reader looking for a
 * lock on a card whose badge they were told is inherited.
 */
export interface LockedMove {
  drop: CollectionDrop;
  to: number | null;
  card: string;
  /** The set-aside drawer the copy is leaving, or `null` when it is not leaving one. */
  out: string | null;
  /** The set-aside drawer it would land in, or `null` when it is not landing in one. */
  into: string | null;
}

/** What a folder write hands back as its plan — the destination level and its whole new order. */
type Placement = { parentId: number | null; ids: number[] };

export function useCollectionDrops({
  census,
  userFolders,
  deckGroups,
  lockedIds,
  nodes,
  treeParent,
  folderNameOf,
  setFolder,
  moveCopy,
  reorder,
  setPicking,
}: {
  /** Every folder there is, every kind — `useCollectionFolders`' `folders`. */
  census: readonly CollectionFolder[];
  /** The reader's own drawers — the page's `userFolders`, the tree's input. */
  userFolders: readonly CollectionFolder[];
  /** The decks' groups — `pinnedFolders`' `decks`, the drag's source fence. */
  deckGroups: readonly CollectionFolder[];
  /** The effective lock — `useCollection`'s `lockedIds`, every folder inside a locked one. */
  lockedIds: ReadonlySet<number>;
  /** The reader's tree, as the wall draws it. */
  nodes: readonly FolderNode<CollectionFolder>[];
  /** Every reader's folder's parent as the tree draws it — the page's `treeParent`. */
  treeParent: ReadonlyMap<number, number | null>;
  /** What to call a folder — the page's `folderNameOf`. */
  folderNameOf: (id: number | null) => string | null;
  /** `useSetCollectionFolder`'s `mutate` — a plain drag's write, which says nothing (the owner's
   *  exemption for drags between shelves of the open wall); the page's banner is its report. */
  setFolder: (variables: { entryId: number; folderId: number | null }) => void;
  /** The same write on the page's **second** observer, for a drag whose crossing into a locked
   *  drawer was asked and answered — that one toasts, and the page's banner, which can only tell
   *  calls apart by observer, must not say its refusal again. The options are `mutate`'s own,
   *  which the receipt hangs on. */
  moveCopy: (
    variables: { entryId: number; folderId: number | null },
    options: { onSuccess: () => void; onError: (error: unknown) => void },
  ) => void;
  /** The folder reorder's `mutate` — what a heading or a segment drop writes. */
  reorder: (plan: Placement) => void;
  /** Ask the copy picker — the page's own `picking` state, which the row menu sets too. */
  setPicking: (
    question: { cardName: string; entryIds: readonly number[]; folderId: number | null } | null,
  ) => void;
}) {
  const queryClient = useQueryClient();

  /**
   * **The other write a drop can make: an add, for a card the reader does not own yet.**
   *
   * The two are one gesture with two verbs behind it. A copy already in the binder dragged onto a
   * folder is `collection_set_folder` (the page's `setFolder`, handed in above); a printing dragged
   * off the sidebar's search wall is this, because there is no row to move — `folder_id` is the
   * eleventh term of the storage grain, so the folder is part of what the new row *is* rather than
   * somewhere it is put afterwards.
   *
   * **`MENU_CONDITION`, and it is the answer to the standing objection in `useSidebarDrops.ts`.**
   * That file refuses to make the sidebar's Collection entry a drop target in as many words — *a
   * drop that invented "NM nonfoil" would write facts the reader never said* — and the objection
   * is sound. It is already answered by the card menu's own add, which writes `CONDITION_NOT_SET`:
   * **an add that names no grade records that nobody named one, which is a fact, where `NM` would
   * be a guess dressed as one.** The finish is not guessed either — it travels on the drag, as the
   * printing's own first available finish. What is left for a reader who wants to say more is the
   * `+` popup beside the tile, which is where they say it.
   *
   * The four keys are `useCardMenuDeps`' verbatim and for its reasons: the list and its summary,
   * every wish for that card (`ownedQuantity` is summed from `collection_entries`), every deck (a
   * claim is clamped to what the entry holds), and the search results, which draw
   * `ownedQuantity` on every row and tile — including the wall this card was just dragged off.
   */
  const addDropped = useMutation({
    mutationFn: ({
      cardId,
      finish,
      folderId: into,
    }: {
      cardId: string;
      finish: Finish;
      folderId: number | null;
    }) =>
      ipc.collectionAdd({
        cardId,
        finish,
        condition: MENU_CONDITION,
        quantity: 1,
        // Where the reader pointed, and `null` for the root — never omitted, for the reason the
        // grain gives: a folder the caller failed to pass is not a copy filed in the wrong drawer
        // but a *second row* at the root for the same printing.
        folderId: into,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void refreshCardSearches(queryClient);
    },
  });
  // Held still for {@link commitFile}'s dependencies — `mutateAsync` is stable where the result
  // around it is a new object every render. The promise rather than `mutate`, so two cards
  // dropped in quick succession are two receipts (`collectionReceipts.ts`' `report`).
  const { mutateAsync: addDroppedAsync } = addDropped;

  /**
   * The question a **drag** asks when it crosses the edge of a drawer the reader has set aside,
   * or `null` while nothing is being asked — issue #365, design §5.
   *
   * The whole drop travels with it rather than a card id, because the answer replays the gesture:
   * a tile standing for several rows still has to reach {@link fileCard}'s own picker afterwards,
   * and the heading that took the drop is long gone from the conversation by then.
   *
   * **Only a drag raises one.** A drop target is a rectangle a pointer can land on by mistake and
   * this is the whole gesture the lock on the heading exists to slow down; the card menu's
   * `Add to → <folder>` and the row's `Move to folder…` both put the folder's name in the press
   * the reader made, so a confirmation there would ask them to agree with a sentence they had just
   * typed the answer to.
   */
  const [crossing, setCrossing] = useState<LockedMove | null>(null);

  /** Every folder's parent, for {@link lockRootOf}'s walk. A `Map` for {@link folderNames}' reason:
   *  the walk runs once per end of every drag frame, and the whole list is already in memory. */
  const parentById = useMemo(
    () => new Map(census.map((folder) => [folder.id, folder.parentId])),
    [census],
  );

  /**
   * **Which drawer a folder is set aside *inside*** — the outermost locked ancestor-or-self, or
   * `null` for a folder that is not locked at all. The root is never locked, so `null` in is
   * `null` out.
   *
   * **This is what makes "a move inside the drawer is not a move across the boundary" computable**
   * (design §5), and a boolean cannot answer it: dragging a copy between two sub-folders of one
   * locked binder has both ends effectively locked and has crossed nothing, while dragging between
   * two *different* locked binders has both ends effectively locked and has crossed twice. Naming
   * the drawer rather than counting the locks tells those two apart in one comparison —
   * {@link crossesLockedBoundary} is that comparison, and it is the whole of the rule.
   *
   * **Outermost rather than nearest**, which is the half a "walk up to the first locked ancestor"
   * reading gets wrong: a locked binder holding a separately-locked sub-folder is still one
   * drawer, and stopping at the sub-folder would ask a reader to confirm a move within it.
   *
   * The `seen` set is `lockedFolderIds`' own guard for the same reason it has one: `move_folder`
   * refuses to write a cycle, only a hand-edited database could hold one, and a walk that hung the
   * window over it would be worse than the corruption.
   */
  const lockRootOf = useCallback(
    (id: number | null): number | null => {
      let at = id;
      let root: number | null = null;
      const seen = new Set<number>();
      while (at !== null && !seen.has(at)) {
        seen.add(at);
        if (lockedIds.has(at)) root = at;
        at = parentById.get(at) ?? null;
      }
      return root;
    },
    [lockedIds, parentById],
  );

  /** The reader's own drawers and the app's deck groups, as sets, for the two fences in
   *  {@link canFile}. A `Set` because that question is asked once per target per drag frame. */
  const userFolderIds = useMemo(
    () => new Set(userFolders.map((folder) => folder.id)),
    [userFolders],
  );
  const deckGroupIds = useMemo(() => new Set(deckGroups.map((folder) => folder.id)), [deckGroups]);

  /**
   * **A place the reader themselves arranged: the root, or a drawer they made.** One predicate,
   * several questions, one answer.
   *
   * They are genuinely different questions — may a copy be dropped *into* this folder
   * ({@link canMoveCopy}), may a new folder be created *inside* it ({@link canMakeFolder}) — and
   * they share an answer because they share a backend rule: `collection_folders.rs`'s
   * `user_folder`, which both of those writes calls and which refuses a deck group and
   * `Recently removed` in words.
   *
   * **Changing how many copies a row holds is not one of those questions any more** (issue #506).
   * It used to ride this predicate too, and that fenced `Recently removed` for a reason that was
   * never its own: the fence on a count exists for *deck custody*, and the holding area's copies
   * belong to no deck. {@link countEditable} is that question, asked separately, and it is this
   * predicate plus exactly one folder. A spelling of it per call site is a call
   * site per edit to keep in step with that function, and this page has already watched two
   * gestures drift apart once (`collection-folders.md` records the `Move to` whose settle set took
   * `["decks"]` while the drag's did not). Grep this name rather than trusting a count written
   * here.
   *
   * **Written positively — `null` or `user` — and never as a blocklist of the two app-owned
   * kinds.** `collection_folders.kind` is three words today; a fourth added later defaults to
   * *fenced* under this spelling and to *permitted* under `!deckGroupIds.has(id)`, and a control
   * that quietly turns itself on for a kind nobody has thought about is the failure this shape
   * exists to prevent. It is also why `deckGroupIds` above is not the input: that set is
   * {@link canMoveCopy}'s *source* fence, which is a different question about the other end of a
   * drag, and it is deliberately narrower — `Recently removed` is not in it, because dragging back
   * out of the holding area is the whole of what #209 asked for.
   *
   * The root is a level too, and it is the one `null` names — hence the first arm rather than a
   * lookup that would fail for it.
   */
  const readersOwnLevel = useCallback(
    (id: number | null) => id === null || userFolderIds.has(id),
    [userFolderIds],
  );

  /**
   * Where a copy in the air may be let go — asked per target, because the answer differs per
   * target: the folder a row is already filed in refuses it and draws no ring at all, rather than
   * a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card dropped
   * back in its own column, one screen over.
   *
   * **Both of the other two clauses are about the deck boundary, and the drag is the only gesture
   * that can reach it by accident.**
   *
   * *The destination must be the root or a folder the reader made.* That is not this page's rule
   * but `collection_folders::set_entry_folder`'s: it calls `user_folder` on the destination and
   * refuses a deck group or `Recently removed` in words. **No gesture on this page reaches it
   * today** and that is deliberate: an app-owned shelf's heading takes no card
   * (`CollectionShelfParts`), and the only breadcrumb segment that could name one is the last,
   * which is never a target.
   * It is the fence rather than the affordance — the thing that keeps the invariant local the day
   * somebody makes a pinned entry droppable "because the ring looked missing". A mutation check
   * confirmed the reachability: removing this clause fails nothing, where removing either of the
   * other two fails exactly one test each.
   *
   * *The source must not be a deck group.* **`set_entry_folder` fences this end too**
   * (`ENTRY_IN_A_DECK`, a sibling of `FOLDER_NOT_YOURS` rather than a reuse of it — that one is
   * about the destination folder, this one about the row), so what this clause buys is the
   * refusal *before* the drop rather than a sentence after it. The reason both ends exist is
   * unchanged and is why neither may be dropped: the destination would be a perfectly legal user
   * folder, so an unfenced `collection_set_folder` would move the copy **out of the deck's
   * custody without touching `deck_cards`** — the mirror image of the bug the paragraph above
   * prevents, and worse, because the deck would go on listing a card whose copies have walked
   * off. Copies leave a deck through `deck_to_collection`, which decrements the list in the same
   * transaction. `Recently removed` is deliberately not in this set, at either end: dragging
   * *out* of the holding area is the whole of what #209 asked for.
   */
  const canMoveCopy = useCallback(
    (from: number | null, to: number | null) => {
      if (from === to) return false;
      // {@link readersOwnLevel}, which is this clause's own expression given a name so that
      // everything on this page asking `user_folder`'s question asks it once.
      if (!readersOwnLevel(to)) return false;
      return from === null || !deckGroupIds.has(from);
    },
    [readersOwnLevel, deckGroupIds],
  );
  /**
   * The same three clauses asked of whichever shape is in the air.
   *
   * **A tile is taken when *any* copy behind it could move, never only when all of them could.**
   * A printing a reader holds twice in one finish, one copy already in this drawer, is the
   * ordinary case — and a folder that refused the whole tile for it would strand the copy that
   * genuinely has somewhere to go. Which of them actually moves is {@link fileCard}'s question,
   * and where more than one row is behind the art the reader answers it rather than the page.
   *
   * (The example was "in two finishes" until 2026-08-26, when the finish joined the wall's grain
   * and stopped being a way one tile's rows can differ. The rule is unchanged — grade, language
   * and folder still split rows without splitting a tile.)
   *
   * Since shelves every copy behind a tile shares its folder (decision 11), so "any" and "all" give
   * one answer on the wall; the rule is kept as written because a **picked set** can still span
   * folders, and that reaches the picker the same way.
   */
  const canFile = useCallback(
    (drop: CollectionDrop, to: number | null) => {
      // **A card nobody owns has no `from`, so two of {@link canMoveCopy}'s three clauses have
      // nothing to say about it.** It is leaving no folder, so it cannot be leaving a deck's
      // group; and it is in no folder, so "already there" — the clause that stops a folder
      // offering a ring for a write that would move nothing — cannot be true of it either. A
      // reader may perfectly well add a second copy of a printing to the drawer one is already
      // in, which is a different sentence from moving the one they have. What is left is the
      // destination's own fence, which is the backend's (`user_folder`) and is
      // {@link readersOwnLevel} on this side.
      if (drop.kind === "new") return readersOwnLevel(to);
      return drop.kind === "entry"
        ? canMoveCopy(drop.entry.folderId, to)
        : drop.tile.copies.some((copy) => canMoveCopy(copy.folderId, to));
    },
    [canMoveCopy, readersOwnLevel],
  );
  /**
   * The write, or the question about **which copy** that has to come before it — everything a drop
   * did before the lock existed, and what {@link fileCard} hands a confirmed one back to.
   *
   * A table row is one entry and files straight away — the gesture has already said everything
   * there is to say. A wall tile files straight away too **when it stands for a single row**,
   * which is the common case and the one where a dialog would be a press for a choice with one
   * answer. More than one row behind the art is the case the app cannot decide: the copies differ
   * in condition, language and folder, the reader can see none of that on a piece of card art,
   * and choosing for them is the one answer that is always wrong for somebody. (They can no
   * longer differ in **finish** — that is what makes them two pieces of art since 2026-08-26 —
   * which narrows this question without answering it.)
   *
   * **Split out rather than guarded inside, so the confirmed gesture is the same code as the
   * unconfirmed one.** A lock question that re-implemented the single-row shortcut would be a
   * second definition of "which entry does this drop write", and the two would disagree the first
   * time either moved — which is `useSetCollectionFolder`'s own history, one write down.
   *
   * **Which of these toast** (`collectionReceipts.ts`): the search column's card always does — it
   * is a card *added* to the collection from another surface, the owner's rule's "sidebar drop" —
   * and a refile does only when `answered`, the lock's question having been asked and closed. A
   * plain drag between shelves of the open wall is the rule's exemption: the copy is drawn where
   * the reader let it go. The copy picker reports for itself.
   */
  const commitFile = useCallback(
    (drop: CollectionDrop, to: number | null, answered = false) => {
      const destination = folderNameOf(to) ?? ROOT_LABEL;
      // **The one branch that is an add rather than a refile**, and it never asks the reader
      // anything: there is exactly one row to write, so the picker below has nothing to pick
      // between. See {@link addDropped} for what the write says and why it says so little.
      if (drop.kind === "new") {
        const { name } = drop.card;
        report(
          addDroppedAsync({ cardId: drop.card.cardId, finish: drop.card.finish, folderId: to }),
          {
            done: () => addedReceipt(name, destination),
            failed: `Couldn't add “${name || "that card"}” to “${destination}”`,
          },
        );
        return;
      }
      const file = (entryId: number, name: string) =>
        answered
          ? moveCopy(
              { entryId, folderId: to },
              {
                onSuccess: () => notify.success(movedReceipt(1, name, destination)),
                onError: (error) =>
                  notify.error(`Couldn't move “${name || "that card"}” to “${destination}”`, {
                    body: ipcError(error),
                  }),
              },
            )
          : setFolder({ entryId, folderId: to });
      if (drop.kind === "entry") {
        file(drop.entry.entryId, drop.entry.name);
        return;
      }
      const { copies, name } = drop.tile;
      if (copies.length === 1) {
        file(copies[0].entryId, name);
        return;
      }
      setPicking({ cardName: name, entryIds: copies.map((copy) => copy.entryId), folderId: to });
    },
    [addDroppedAsync, setFolder, moveCopy, setPicking, folderNameOf],
  );

  /**
   * **Has this drop crossed the edge of a drawer the reader set aside** — the one comparison
   * design §5 rests on, and the reason {@link lockRootOf} names a folder rather than answering a
   * boolean.
   *
   * Two ends both *effectively* locked is not the question: two sub-folders of one locked binder
   * are both locked and the copy has not left the drawer, where two different locked binders are
   * both locked and it has left one and entered another. Comparing the drawers answers both, and
   * answers the ordinary cases for free — neither end locked is `null === null`, and exactly one
   * end locked is a difference by construction.
   */
  const crossesLock = useCallback(
    (from: number | null, to: number | null) => lockRootOf(from) !== lockRootOf(to),
    [lockRootOf],
  );

  /**
   * The write, or one of the two questions that can come before it.
   *
   * A table row is one entry and files straight away — the gesture has already said everything
   * there is to say. A wall tile files straight away too **when it stands for a single row**,
   * which is the common case and the one where a dialog would be a press for a choice with one
   * answer. More than one row behind the art is the case the app cannot decide: the copies differ
   * in condition, language and folder, the reader can see none of that on a piece of card art,
   * and choosing for them is the one answer that is always wrong for somebody. (They can no
   * longer differ in **finish** — that is what makes them two pieces of art since 2026-08-26 —
   * which narrows this question without answering it.) That half is {@link commitFile}.
   *
   * **The lock is the other question and it is asked first**, because it is about the gesture
   * rather than about which row the gesture is for: a reader who says *leave it there* never sees
   * the picker at all, and one who says *move it* is handed back to exactly the code path the drop
   * would have taken. Only the copies that could actually move are asked about — a tile whose one
   * movable copy is already in the destination is refused by {@link canFile} before this runs, and
   * a copy the destination would refuse is not part of what the reader is being warned about.
   *
   * **A drag only.** `Add to → <folder>` and `Move to folder…` reach {@link setFolder} through
   * their own handlers and are deliberately not routed through here.
   */
  const fileCard = useCallback(
    (drop: CollectionDrop, to: number | null) => {
      const sources =
        // **A card nobody owns comes from the root, and that is a statement rather than a
        // placeholder.** The lock question is *has this drop crossed the edge of a drawer the
        // reader set aside*, and it has two halves: leaving one, and landing in one. A new copy
        // cannot be leaving — `lockRootOf(null)` is `null`, so the "out of" half is silent — and
        // it can perfectly well be landing in one, which is the half the sentence *“X” is locked.
        // Filing “Y” there sets that copy aside.* already says. Writing `[]` here would have made
        // the sidebar the one door into a locked drawer that never asks.
        drop.kind === "new"
          ? [null]
          : drop.kind === "entry"
            ? [drop.entry.folderId]
            : drop.tile.copies
                .filter((copy) => canMoveCopy(copy.folderId, to))
                .map((copy) => copy.folderId);
      const crossed = sources.filter((from) => crossesLock(from, to));
      if (crossed.length === 0) {
        commitFile(drop, to);
        return;
      }
      // The first crossing source's drawer, where a tile could in principle be carrying copies out
      // of two different locked binders at once. The sentence stays true of the one it names, and
      // naming both would be a clause for an arrangement nobody has: a printing filed in two
      // separately locked drawers *and* dragged somewhere neither of them is.
      const leaving = crossed.map((from) => lockRootOf(from)).find((id) => id !== null) ?? null;
      const arriving = lockRootOf(to);
      setCrossing({
        drop,
        to,
        // The card, whichever of the three shapes is in the air — all of them carry a name, and
        // the sentence is about the printing rather than about the rows behind it.
        card:
          drop.kind === "entry"
            ? drop.entry.name
            : drop.kind === "tile"
              ? drop.tile.name
              : drop.card.name,
        out: leaving === null ? null : (folderNameOf(leaving) ?? "a folder you have set aside"),
        into: arriving === null ? null : (folderNameOf(arriving) ?? "a folder you have set aside"),
      });
    },
    [canMoveCopy, crossesLock, lockRootOf, folderNameOf, commitFile],
  );

  /**
   * Why one copy cannot go where the reader pointed, or `null` when it can — the sentence the
   * picker greys a row with.
   *
   * **Both refusals are the backend's, said early.** `collection_folders::set_entry_folder`
   * answers `ENTRY_IN_A_DECK` for a row sitting in a deck's group, and the wording here is that
   * sentence's job rather than a paraphrase of it: it names what to do instead, because there is
   * something to do. "Already there" is not a refusal the backend makes at all — it would write
   * the row back where it is and bump `updated_at` — and it is drawn because a row the reader
   * cannot usefully tick has to say why it is not ticked.
   */
  const blockedReason = useCallback(
    (row: CollectionRow, to: number | null): string | null => {
      if (row.folderId === to) return `Already in ${folderNameOf(to) ?? ROOT_LABEL}.`;
      if (row.folderId !== null && deckGroupIds.has(row.folderId)) {
        return `In ${row.folderName ?? "a deck"}. Remove it from the deck to get it back.`;
      }
      return null;
    },
    [deckGroupIds, folderNameOf],
  );

  /**
   * What a folder heading let go on another heading means as a write — the destination level and
   * that level's whole new order — or `null` for a drop this page will not make (spec §6).
   *
   * **One function for both halves of the gesture**, because a mark that promised a write the drop
   * then refused would be worse than no mark: `useShelfDropTarget` asks once per frame to decide
   * what to draw and again at the drop. The refusals are the backend's, said early:
   *
   * - **Both ends must be a folder the reader made.** `collection_folders::reorder_folders` calls
   *   `user_folder` on the destination and on every id it is handed, so a deck group or
   *   `Recently removed` at either end is `FOLDER_NOT_YOURS`. No gesture reaches it — an app-owned
   *   heading is neither a folder target nor a drag source (`CollectionShelfParts`) — so this is
   *   the fence rather than the affordance.
   * - **A folder may not land inside itself or inside anything it holds.** `parent_id` is
   *   `ON DELETE CASCADE` on itself, so a cycle is a graph SQLite would walk forever. **This one is
   *   reachable now**: the wall draws the whole subtree, so a parent's heading can be dropped on its
   *   own child's. Asked of the *destination parent*, which covers all three landings at once —
   *   `inside` a descendant and `before` one are the same cycle.
   * - **A drop that would reproduce the order already on screen is not a write** — `reorderedLevel`
   *   answers `null` for it, so a heading put back where it sits writes nothing.
   *
   * **Before and after reorder the level the target is drawn in** — {@link treeParent}, not its
   * row's `parentId` — so a drop beside a folder whose parent another surface deleted reorders the
   * root, where `buildFolderTree` draws it.
   */
  const folderPlacement = useCallback(
    (drag: FolderDrag, targetId: number, edge: FolderEdge): Placement | null => {
      if (!userFolderIds.has(drag.folderId) || !userFolderIds.has(targetId)) return null;
      const parentId = edge === "inside" ? targetId : (treeParent.get(targetId) ?? null);
      if (parentId !== null && !userFolderIds.has(parentId)) return null;
      if (
        parentId !== null &&
        (parentId === drag.folderId || folderDescendants(userFolders, drag.folderId).has(parentId))
      ) {
        return null;
      }
      const ids = reorderedLevel({
        // The destination level in the order the tree draws it — the target's children for a
        // nest, the target's own level for the other two.
        siblings: folderLevel(nodes, parentId).map((node) => node.folder.id),
        dragged: drag.folderId,
        target: targetId,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [userFolderIds, treeParent, userFolders, nodes],
  );
  const canPlaceFolder = useCallback(
    (drag: FolderDrag, targetId: number, edge: FolderEdge) =>
      folderPlacement(drag, targetId, edge) !== null,
    [folderPlacement],
  );
  const placeFolder = useCallback(
    (drag: FolderDrag, targetId: number, edge: FolderEdge) => {
      const plan = folderPlacement(drag, targetId, edge);
      // A `null` writes **nothing at all** — not a reorder of the level as it stands.
      if (plan !== null) reorder(plan);
    },
    [folderPlacement, reorder],
  );

  /**
   * **A folder dropped on a path-row segment**: moved into that level, last (spec §6). The only
   * segments that take a folder are the path row's — a heading's lead segments and the sticky bar's
   * are buttons only — and this is the way *up* the up tile used to be.
   *
   * `inside` is the landing a segment means, because a segment is one word with no order to point
   * into, and `reorderedLevel` already appends for it. The refusals are {@link folderPlacement}'s,
   * asked of a level rather than a heading, plus **already there** — the folder's tree parent is the
   * segment — which draws no ring rather than one that would shuffle it to the end of its own level.
   */
  const levelPlacement = useCallback(
    (drag: FolderDrag, levelId: number | null): Placement | null => {
      if (!userFolderIds.has(drag.folderId)) return null;
      if (levelId !== null && !userFolderIds.has(levelId)) return null;
      if ((treeParent.get(drag.folderId) ?? null) === levelId) return null;
      if (
        levelId !== null &&
        (levelId === drag.folderId || folderDescendants(userFolders, drag.folderId).has(levelId))
      ) {
        return null;
      }
      const ids = reorderedLevel({
        siblings: folderLevel(nodes, levelId).map((node) => node.folder.id),
        dragged: drag.folderId,
        target: levelId ?? ROOT_TARGET,
        edge: "inside",
      });
      return ids === null ? null : { parentId: levelId, ids: [...ids] };
    },
    [userFolderIds, treeParent, userFolders, nodes],
  );
  const canPlaceOnLevel = useCallback(
    (drag: FolderDrag, levelId: number | null) => levelPlacement(drag, levelId) !== null,
    [levelPlacement],
  );
  const placeOnLevel = useCallback(
    (drag: FolderDrag, levelId: number | null) => {
      const plan = levelPlacement(drag, levelId);
      if (plan !== null) reorder(plan);
    },
    [levelPlacement, reorder],
  );

  return {
    addDropped,
    crossing,
    setCrossing,
    readersOwnLevel,
    canFile,
    commitFile,
    fileCard,
    blockedReason,
    canPlaceFolder,
    placeFolder,
    canPlaceOnLevel,
    placeOnLevel,
  };
}
