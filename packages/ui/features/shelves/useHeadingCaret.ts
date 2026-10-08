/**
 * **The caret handed back to a heading that may no longer be drawn** — one machine for both
 * cabinets (`CollectionPage` and `WishlistPage`), which carried it as two verbatim copies until
 * the final review (C-M7 / W-M5) and had already drifted once.
 *
 * After **Add folder in a heading** the caret belongs on that heading's `Add folder`, and after
 * **Move up / Move down** on the moved heading's `⋯`. A wall is virtualised: a new folder's field is
 * revealed at the end of its parent's subtree, which scrolls the parent's heading out of the window,
 * and a move carries the heading past its neighbour's whole subtree. Either way the element the
 * page remembered as the opener can be gone, and `focus()` on a detached node is a silent no-op.
 *
 * So the page records **which heading's control** the caret belongs on ({@link CaretBack}), both
 * views bring that heading into view (the wall's `revealShelfId`, the table's `revealIndex`), and
 * the heading takes the caret itself as it is drawn (`useTakeHeadingCaret` in `headingCaret.ts`) —
 * **only while nothing else has it**, spending the request whether it took it or not
 * ({@link HeadingCaretMachine.claim}).
 *
 * - **Asked** at the press ({@link HeadingCaretMachine.ask}), which stamps it with a fresh id, and
 *   **recorded** when its moment comes ({@link HeadingCaretMachine.record}) — after a *successful*
 *   write, after Add folder in a heading on a commit and on a keyboard cancel (Escape, ✕). A record
 *   is refused if anything newer has been asked, or a layer opened, since.
 * - **A blur-discard decides one task later** ({@link HeadingCaretMachine.afterBlur}): during a blur
 *   the caret is on `<body>` whether or not a click is about to put it somewhere, so "has it nowhere
 *   else to be" can only be asked once the focus change has finished.
 * - **Dropped** on a level change (drawn or asked), a view change and the next layer
 *   ({@link HeadingCaretMachine.supersede}). A move is decided at the folder list's **first** answer
 *   after the write: its planned order there, and it goes on to the reveal; not there — another
 *   window moved something, or the read failed — and it is dropped rather than left to fire on some
 *   later re-read that happens to match.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SearchView } from "@/lib/store";
import type { HeadingCaret } from "./headingCaret";

/**
 * A heading the caret is owed to: which request it is, the heading and its control, the element
 * that was pressed, and **where the request was made** — the level drawn, the level asked for and
 * the view — because it lives there and nowhere else. A move carries what the folder list has to
 * say before the heading is where it will stay — `order` for Move up / Move down, `into` for Move to
 * folder… — until the list's first answer after the write decides it.
 */
export interface CaretBack {
  id: number;
  shelfId: number;
  control: HeadingCaret["control"];
  from: HTMLElement | null;
  level: number | null;
  asked: number | null;
  view: SearchView;
  /** Move up / Move down: the level reads exactly these ids, in this order. */
  order?: { parentId: number | null; ids: readonly number[] };
  /** Move to folder…: the folder is filed under this parent, wherever among its siblings. A move
   *  leaves `sort_order` alone, so the place it lands in the level is not the page's to predict. */
  into?: { parentId: number | null; id: number };
}

/** What a request waits on before it is due — see {@link CaretBack}'s two fields. */
export type CaretUntil = Pick<CaretBack, "order" | "into">;

/** Two id lists, same ids in the same order. */
export const sameIds = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, at) => id === b[at]);

/** Whether the caret has nowhere to be — `<body>`, or nothing at all. */
export function caretIsNowhere(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * The path row's Add folder inside `row` — `ShelfToolbar`'s button, found by its visible word
 * because it carries no name of its own and the toolbar takes no ref. `null` where the level can
 * hold no folder and the button is not drawn.
 */
export function pathRowAddFolder(row: HTMLElement | null): HTMLElement | null {
  return (
    [...(row?.querySelectorAll<HTMLElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Add folder",
    ) ?? null
  );
}

/** What {@link HeadingCaretMachine.leave} needs to know about the folder that is leaving. */
export interface LeavingFolder {
  id: number;
  /** Move to folder…'s destination; absent for a delete. */
  into?: number | null;
  /** Whether this wall draws a heading for `id`, open — so a folder filed inside it is drawn too. */
  drawnOpen: (id: number) => boolean;
  /** The folder's parent as the tree draws it (`null` for the root). */
  parentOf: (id: number) => number | null;
  /** The path row's Add folder, asked for when the write answers. */
  pathRowAdd: () => HTMLElement | null;
}

/** Where the page is, as the machine needs to know it. */
export interface HeadingCaretPlace {
  /** The level **drawn** (`folderId`). */
  level: number | null;
  /** The level **asked for** (`requestedFolderId`) — one round trip early while a level is held. */
  asked: number | null;
  view: SearchView;
  /** The element the open layer was raised from — stamped on every request as its `from`. */
  opener: RefObject<HTMLElement | null>;
  /** Whether the folder list is reading — a move is decided when it stops. */
  fetching: boolean;
  /** One level of the reader's own folders, in the order the tree draws them. */
  levelIds: (parentId: number | null) => readonly number[];
}

export interface HeadingCaretMachine {
  /** The heading the caret is owed to, once it is where it is going — `null` while there is none
   *  or while a move is still waiting on its answer. What both views reveal. */
  due: CaretBack | null;
  /** What to hand one heading as its `caret` — the due request's, on that heading alone. */
  caretFor: (shelfId: number) => HeadingCaret | undefined;
  /** A request stamped with where it is made — the levels, the view, the pressed element — and a
   *  fresh id. Made at the press; {@link record} files it once its moment comes. */
  ask: (shelfId: number, control: HeadingCaret["control"], until?: CaretUntil) => CaretBack;
  /** File a request — unless another has been asked, or a layer opened, since it was asked. */
  record: (request: CaretBack) => void;
  /** `true` exactly once per id, and the answer spends the request — see the note at its site. */
  claim: (id: number) => boolean;
  /** The next layer's `open`: a request still owed is the last layer's business, and one whose
   *  write or blur has not answered yet is superseded, so it is never recorded at all. */
  supersede: () => void;
  /**
   * A blur-discard's decision: `then` runs one task later, and only if the caret is still nowhere
   * and nothing has been asked or opened in between. A newer blur replaces a waiting one, and the
   * page going clears it.
   */
  afterBlur: (then: () => void) => void;
  /**
   * **Where the caret goes once a folder has left its heading** — Move to folder… and Delete… (the
   * final review's C-M5). Both used to hand it back through the page's `dismiss` to the `⋯` the
   * strip was raised from, which the write had just moved, virtualised away or deleted, so it
   * landed on `<body>`. Asked at the press, so a layer opened before the write answers supersedes
   * it; the answer is what to do when the write succeeds:
   *
   * - **Moved to a folder this wall draws open** (or to the level itself): that heading's `⋯`, once
   *   the folder list says it is filed there — `into`, revealed like a move.
   * - **Otherwise, and on a delete**: the heading it was filed under, which is where the reader was
   *   and which the write leaves where it is.
   * - **Unless that is the level itself**, which has no heading: the path row's Add folder.
   */
  leave: (folder: LeavingFolder) => () => void;
}

/** The caret-return machine — see the module's own paragraph. Called once per page, where the
 *  folder tree its move decision reads already exists. */
export function useHeadingCaret({
  level,
  asked,
  view,
  opener,
  fetching,
  levelIds,
}: HeadingCaretPlace): HeadingCaretMachine {
  const [caretBack, setCaretBack] = useState<CaretBack | null>(null);
  /** The newest request's id. `supersede` moves it on too, so a request whose write answers after
   *  the reader has opened something else finds itself superseded and is never recorded. */
  const seq = useRef(0);
  const claimed = useRef<number | null>(null);

  // A claim **spends** the request: its reveal has done its job, and a request left standing would
  // reveal the heading again — the table's `revealIndex` answers every new index — whenever
  // something above it moved.
  //
  // ⚠️ **A deliberate exception to "no `setState` inside an effect"**: the heading calls this from
  // its layout effect, once it has put the caret somewhere, and the write below is the page
  // hearing about that *event* rather than a value synchronised from props. It is guarded and
  // cannot loop — the ref answers `false` to every second call for one id (StrictMode's second run
  // included), and clearing the request removes the prop that made the heading call it.
  const claim = useCallback((id: number) => {
    if (claimed.current === id) return false;
    claimed.current = id;
    setCaretBack((current) => (current?.id === id ? null : current));
    return true;
  }, []);

  const ask = useCallback(
    (shelfId: number, control: HeadingCaret["control"], until?: CaretUntil): CaretBack => {
      seq.current += 1;
      return {
        id: seq.current,
        shelfId,
        control,
        from: opener.current,
        level,
        asked,
        view,
        ...until,
      };
    },
    [level, asked, view, opener],
  );

  const record = useCallback((request: CaretBack) => {
    if (seq.current === request.id) setCaretBack(request);
  }, []);

  const supersede = useCallback(() => {
    seq.current += 1;
    setCaretBack(null);
  }, []);

  // A ticket for an answer that is not a heading's — the path row's Add folder, focused straight
  // away rather than taken by a heading. Taking one supersedes every request asked before it, and
  // the ticket answers `true` while nothing newer has been asked or opened since: `record`'s
  // refusal, for a caret that has no request to carry it.
  const ticket = useCallback(() => {
    seq.current += 1;
    const at = seq.current;
    return () => seq.current === at;
  }, []);

  const leave = useCallback(
    ({ id, into, drawnOpen, parentOf, pathRowAdd }: LeavingFolder): (() => void) => {
      if (into !== undefined && (into === level || (into !== null && drawnOpen(into)))) {
        const request = ask(id, "manage", { into: { parentId: into, id } });
        return () => record(request);
      }
      const parent = parentOf(id);
      if (parent !== null && parent !== level) {
        const request = ask(parent, "manage");
        return () => record(request);
      }
      const current = ticket();
      return () => {
        if (current()) pathRowAdd()?.focus();
      };
    },
    [level, ask, record, ticket],
  );

  const blurDecision = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (blurDecision.current !== null) window.clearTimeout(blurDecision.current);
    },
    [],
  );
  const afterBlur = useCallback((then: () => void) => {
    const at = seq.current;
    if (blurDecision.current !== null) window.clearTimeout(blurDecision.current);
    blurDecision.current = window.setTimeout(() => {
      blurDecision.current = null;
      // A layer opened in the same task as the click that blurred the field, or anything newer
      // asked, has moved the sequence on.
      if (seq.current === at && caretIsNowhere()) then();
    }, 0);
  }, []);

  /*
   * **The request's lifetime, answered as the page renders** — React's adjustment of state from
   * information in the render, never an effect, and each write terminates because it removes its
   * own condition.
   *
   * A request walked away from — another level drawn or asked for, the other view — is dropped
   * rather than kept for a return: a wall that remounts would otherwise reveal a heading the reader
   * has long left. A move is **decided at the folder list's first answer after the write**, data or
   * error — `fetching` falling, since the write's own settle started that read before the request
   * was recorded: the planned order on screen (or the folder under its new parent), and the request
   * goes on to its reveal with the wait spent; anything else, and it is dropped rather than waiting
   * for a later re-read. An answer that lands while the write is still in flight decides nothing,
   * because nothing has been recorded yet.
   */
  const here =
    caretBack !== null &&
    caretBack.level === level &&
    caretBack.asked === asked &&
    caretBack.view === view
      ? caretBack
      : null;
  if (caretBack !== null && here === null) setCaretBack(null);
  const waiting = here !== null && (here.order !== undefined || here.into !== undefined);
  if (here !== null && waiting && !fetching) {
    const landed =
      here.order !== undefined
        ? sameIds(levelIds(here.order.parentId), here.order.ids)
        : here.into !== undefined && levelIds(here.into.parentId).includes(here.into.id);
    setCaretBack(landed ? { ...here, order: undefined, into: undefined } : null);
  }
  const due = here !== null && !waiting ? here : null;

  const caretFor = useCallback(
    (shelfId: number): HeadingCaret | undefined =>
      due !== null && due.shelfId === shelfId
        ? { id: due.id, control: due.control, from: due.from, claim }
        : undefined,
    [due, claim],
  );

  return { due, caretFor, ask, record, claim, supersede, afterBlur, leave };
}
