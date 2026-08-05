import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { filterChipState } from "@/components/FilterChips";
import { QuantityStepper } from "@/components/QuantityStepper";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/** The printing a quick-add is about. Every surface that shows a card can build one. */
export interface AddTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  /** For an "any printing" wish. `null` on a reversible card, which has no oracle id. */
  oracleId: string | null;
  /** The finishes this printing exists in. Empty means "unknown", and nonfoil is offered. */
  finishes: Finish[];
}

/**
 * How a surface full of cards carries this button: invisible until the row or tile it
 * belongs to is hovered or holds the caret — a wall of art is not a wall of plus signs —
 * and always in the tab order, because "visible on hover" is not a state a keyboard has.
 *
 * The caller's row or tile has to be a `group`. An open popup overrides the opacity from
 * inside the component, so walking the mouse off the row does not take the popup with it.
 */
export const REVEAL_ON_HOVER =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 " +
  "group-focus-within:opacity-100 motion-reduce:transition-none";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Small, quiet, and the same three sizes wherever they appear in the popup. */
const CHIP =
  "rounded-md border px-2 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none";

const MODES = ["collection", "wishlist"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = { collection: "Collection", wishlist: "Wishlist" };

/**
 * The "+" that adds a card, and the popup behind it.
 *
 * One component for all three surfaces (printings row, art tile, table row) because the
 * decision being made is the same one every time: which finish, what condition, how many —
 * and the direction's rule that a control means the same thing wherever it appears is
 * cheaper to keep than to restore.
 */
export function AddToCollectionButton({
  target,
  className,
  align = "end",
}: {
  target: AddTarget;
  className?: string;
  /**
   * Which edge of the popup is pinned to its anchor. `"end"` everywhere the button sits at
   * the right of a wide row, so the popup opens back across it; `"start"` in the art grid,
   * where the anchor is the tile's caption (the caller makes this control `static`) and a
   * popup opening leftwards off the first column would be clipped by the scroller — left
   * overflow, unlike right, cannot be scrolled back into view.
   */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape hands the caret back before React unmounts the popup — an element that
  // disappears with focus on it drops the caret to `<body>`, and the next Tab restarts from
  // the top of the app.
  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  return (
    <span
      ref={rootRef}
      // `open` last, so an open popup outlives the hover that revealed its button.
      className={cn("relative inline-flex", className, open && "opacity-100")}
      // Closing on focus leaving covers the click-outside case as well, and does it without
      // a window listener that could fight the Escape handshake. The boundary is the whole
      // control rather than the popup: on `relatedTarget` being this button — a second
      // click on it, or Escape's hand-back — closing here would race the toggle below and
      // leave the popup open forever.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // Named for the card and the printing, not for the control: forty of these in a
        // printings list are forty different cards, and "Add" is the same word on all of
        // them.
        aria-label={`Add ${target.name} (${target.setCode.toUpperCase()} ${target.collectorNumber}) to collection`}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md border border-border text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
      {open && <AddPopup target={target} align={align} onDismiss={dismiss} />}
    </span>
  );
}

function AddPopup({
  target,
  align,
  onDismiss,
}: {
  target: AddTarget;
  align: "start" | "end";
  /** Escape: close *and* hand focus back. An outside click closes from the root's `onBlur`
   *  and deliberately does not hand it back — the reader is already somewhere else. */
  onDismiss: () => void;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const finishes = target.finishes.length > 0 ? target.finishes : (["nonfoil"] as Finish[]);
  const [mode, setMode] = useState<Mode>("collection");
  const [finish, setFinish] = useState<Finish>(finishes[0]);
  const [condition, setCondition] = useState<Condition>("NM");
  const [quantity, setQuantity] = useState(1);
  const [anyPrinting, setAnyPrinting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // The caret moves into the layer, as it does for the card pane and the set picker: the
  // popup's own controls are then the next thing Tab reaches, focus leaving it is what
  // closes it, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // The innermost open layer: capture phase, and the press is consumed so the card detail
  // pane underneath does not close on the same one. See `useDismissOnEscape` — and note
  // that two "inner" peers are *not* ordered by it, so this popup and the set picker must
  // never be open at once (they cannot be: they live in different views).
  useDismissOnEscape({ layer: "inner", onDismiss });

  const add = useMutation({
    mutationFn: () =>
      mode === "collection"
        ? ipc.collectionAdd({ cardId: target.cardId, finish, condition, quantity })
        : ipc.wishlistAdd(
            // A wish for "any printing" is keyed on the oracle card and carries its own
            // name, because a shopping list outlives the printing it was made from. The
            // `null` arm is unreachable — the control is disabled without an oracle id —
            // and is written as a pin rather than a cast so it stays that way.
            anyPrinting && target.oracleId !== null
              ? {
                  oracleId: target.oracleId,
                  name: target.name,
                  quantity,
                  preferredFinish: finish,
                }
              : { cardId: target.cardId, quantity, preferredFinish: finish },
          ),
    onSuccess: () => {
      // The button said "Add", so the report says "Added" — one verb through the whole
      // action.
      setDone(`Added ${quantity} × ${target.name} to your ${mode}.`);
      // Everything that counts cards: the two lists, their summary, and the search results
      // that badge what is owned.
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Add ${target.name}`}
      // Anchored, not portalled: the shipped CSP is `style-src 'self'` and every overlay
      // primitive in reach injects a runtime <style> the moment it opens (fine under
      // `tauri dev`, blank in a packaged build). Same decision as `SetCombobox`. Not
      // `aria-modal` either — the list behind it stays live, and a dialog that claims the
      // page is inert while it demonstrably is not is worse than no dialog at all.
      className={cn(
        "absolute top-7 z-20 w-64 space-y-3 rounded-lg border border-border bg-surface p-3",
        "text-left shadow-lg",
        align === "start" ? "left-0" : "right-0",
        FOCUS,
      )}
    >
      <div role="group" aria-label="Add to" className="flex gap-1">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              if (m === mode) return;
              setMode(m);
              // Both messages name a destination, and this is the control that changes it:
              // left alone, a failed add to the collection would re-read as a failed add to
              // the wishlist, which is a sentence about something that never happened.
              setDone(null);
              add.reset();
            }}
            className={cn(CHIP, "flex-1", FOCUS, filterChipState(mode === m))}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* The backend takes any finish for any card — this row is the guard, and it offers
          what the printing exists in and nothing else. */}
      <div role="group" aria-label="Finish" className="flex flex-wrap gap-1">
        {finishes.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={finish === f}
            onClick={() => setFinish(f)}
            className={cn(CHIP, FOCUS, filterChipState(finish === f))}
          >
            {FINISH_LABEL[f]}
          </button>
        ))}
      </div>

      {mode === "collection" ? (
        <div className="space-y-1">
          {/* A select shows its value, so its name has to be written beside it. The chips
              above are their own labels, which is why only this one is spelled out. */}
          <label htmlFor={`${id}-condition`} className="block text-xs text-dim">
            Condition
          </label>
          <select
            id={`${id}-condition`}
            value={condition}
            onChange={(e) => setCondition(e.target.value as Condition)}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
              FOCUS,
            )}
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="space-y-1">
          <div role="group" aria-label="Which printing" className="flex gap-1">
            {[
              { any: false, label: "This printing" },
              { any: true, label: "Any printing" },
            ].map(({ any, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={anyPrinting === any}
                // A wish for "any printing" is keyed on the oracle card, and there is not
                // always one to key it on: a reversible card has no oracle id at all, and
                // the search DTO does not carry one. Disabled rather than hidden, with the
                // way to it in the line below — a choice that silently disappears on some
                // screens is a feature the reader has no reason to believe exists.
                disabled={any && target.oracleId === null}
                onClick={() => setAnyPrinting(any)}
                className={cn(
                  CHIP,
                  "flex-1 disabled:opacity-40 disabled:hover:text-dim",
                  FOCUS,
                  filterChipState(anyPrinting === any),
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {target.oracleId === null && (
            <p className="text-[0.7rem] leading-snug text-dim">
              Open the card to wish for any printing of it.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <QuantityStepper
            value={quantity}
            onChange={setQuantity}
            min={1}
            size="sm"
            label={`Quantity of ${target.name}`}
          />
          <button
            type="button"
            onClick={() => add.mutate()}
            disabled={add.isPending}
            // The visible word is the verb; the name says where it goes, and starts with
            // the visible word so the button is still addressable by voice (WCAG 2.5.3).
            aria-label={`Add to ${mode}`}
            className={cn(
              "h-7 rounded-md border border-accent px-3 text-xs text-accent",
              "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
              "disabled:opacity-50 motion-reduce:transition-none",
              FOCUS,
            )}
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>

        {/* One live region, mounted with the popup and empty until there is something to
            say: a region that appears together with its text is a region a screen reader
            never saw change. Cleared on a failure so the last success is not read back as
            though it were this one. */}
        <p role="status" className="text-xs text-dim">
          {add.isError ? "" : done}
        </p>
        {add.isError && (
          // Stays open behind this, with every answer still in it: recording the same card
          // twice is one interaction, and so is trying again.
          <p role="alert" className="text-xs text-destructive">
            Could not add to your {mode} — {ipcError(add.error)}
          </p>
        )}
      </div>
    </div>
  );
}
