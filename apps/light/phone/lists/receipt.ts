import { useCallback, useEffect, useState } from "react";
import { ipcError } from "@grimoire/ui/lib/ipc";
import { RECEIPT_MS, type ReceiptLine } from "../deck/receipt";

/**
 * What `Undo` takes back after one write, and the write that does it — or nothing, where the
 * desktop offers no way back from that write either.
 */
export interface TakeBack {
  /** What it puts back, for the button's name: `Undo — <this>`. */
  name: string;
  run: () => Promise<unknown>;
}

/**
 * The receipt for a write to **the collection or the wishlist** — the deck receipt's line
 * (`ReceiptBar`), fed by a list write rather than by a deck's history.
 *
 * A deck files every write as a step on its own cursor, so the deck receipt asks that cursor what
 * to offer. These two lists keep no such cursor, and **what `Undo` can do is whatever the desktop
 * already does for that write**, handed in by the caller at the press:
 *
 * - a removal offers the desktop's bulk undo — the ticket `collection_remove_many` answers, taken
 *   back through `bulk_undo` (`useBulkUndoAction`, the desktop's `UndoNotice` without its drawing);
 * - an add offers the desktop's stepper, one copy back — `set_quantity` to the count before the
 *   add, which deletes a row the add made;
 * - every other write offers nothing, and the line says what happened and goes.
 */
export interface ListReceipt extends ReceiptLine {
  /**
   * Call at the press with the write's promise, the sentence its answer makes, and — where there
   * is a way back — what `Undo` takes back once it has answered.
   */
  track: <T>(
    write: Promise<T>,
    said: (result: T) => string | null,
    takeBack?: (result: T) => TakeBack | null,
  ) => void;
}

/** Hands each press its own number, so a late answer to an older press cannot land. */
let presses = 0;

interface Tracked {
  press: number;
  said: string | null;
  error: string | null;
  back: TakeBack | null;
  /** The undo is out. */
  busy: boolean;
}

export function useListReceipt(): ListReceipt {
  const [tracked, setTracked] = useState<Tracked | null>(null);

  const track = useCallback(
    <T>(
      write: Promise<T>,
      said: (result: T) => string | null,
      takeBack?: (result: T) => TakeBack | null,
    ) => {
      presses += 1;
      const press = presses;
      const land = (patch: Partial<Tracked>) =>
        setTracked((now) => (now !== null && now.press === press ? { ...now, ...patch } : now));
      // Nothing is said until the write answers: a list write is one round trip, and a line that
      // reported a write before it landed would have to take the words back on a refusal.
      setTracked({ press, said: null, error: null, back: null, busy: false });
      write.then(
        (result) => land({ said: said(result), back: takeBack?.(result) ?? null }),
        (error: unknown) => land({ error: ipcError(error) }),
      );
    },
    [],
  );

  const text = tracked?.error ?? tracked?.said ?? null;

  // The line goes by itself, once there is something to say — `useReceipt`'s timer.
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => setTracked(null), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return {
    track,
    text,
    refused: tracked?.error != null,
    undoName: tracked?.error == null ? (tracked?.back?.name ?? null) : null,
    busy: tracked?.busy === true,
    undo: () => {
      const now = tracked;
      if (now === null || now.back === null || now.busy) return;
      const press = now.press;
      setTracked({ ...now, busy: true });
      now.back.run().then(
        // Taken back: the line has nothing left to say.
        () => setTracked((at) => (at !== null && at.press === press ? null : at)),
        (error: unknown) =>
          setTracked((at) =>
            at !== null && at.press === press
              ? { ...at, busy: false, back: null, error: `Couldn't undo — ${ipcError(error)}` }
              : at,
          ),
      );
    },
    dismiss: () => setTracked(null),
  };
}
