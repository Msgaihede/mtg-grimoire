import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { filterChipState } from "@/components/FilterChips";
import { QuantityStepper } from "@/components/QuantityStepper";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/** The printing a quick-add is about. Every surface that shows a card can build one. */
export interface AddTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  /** For an "any printing" wish. `null` mirrors the column's nullability; no live row is. */
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

/**
 * Small, quiet, and the same three sizes wherever they appear in the popup.
 *
 * The transition names its properties one by one rather than taking the colour shorthand,
 * because the press feedback is a **transform** and a colour-only rule would leave the scale to
 * snap. Same recipe as every other shared button constant in the app, verbatim, so a chip in
 * here and a chip anywhere else are pressed with the same weight. (The shorthand is not spelled
 * out in this sentence on purpose: `tokens.test.ts` sweeps prose as eagerly as code, and it
 * caught this very line.)
 */
const CHIP = cn(
  "rounded-md border px-2 py-1 text-xs",
  "transition-[color,background-color,border-color,opacity,transform,scale]",
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97]",
  "motion-reduce:transition-none",
);

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
  // Which list is being filled lives out here, above the popup that changes it, because it
  // is half of what this button's name says — a trigger reading "…to collection" over an
  // open wishlist form is wrong about what pressing it again would do. It therefore also
  // outlives a close, which is the right answer for a reader working down a printings list
  // adding wishes: the destination is their last choice, not a default reasserted each time.
  const [mode, setMode] = useState<Mode>("collection");
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape hands the caret back before React unmounts the popup — an element that
  // disappears with focus on it drops the caret to `<body>`, and the next Tab restarts from
  // the top of the app.
  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // The innermost open layer: capture phase, and the press is consumed so the card detail
  // pane underneath does not close on the same one. See `useDismissOnEscape` — and note
  // that two "inner" peers are *not* ordered by it, so this popup and the set picker must
  // never be open at once. They share the search view, so what keeps them apart is not
  // where they live: each closes when focus leaves its own root, and opening either moves
  // focus into it, which closes the other on the way.
  //
  // **Registered out here, on the flag, rather than inside the popup on its mount.** The popup
  // outlives `open` now by the length of its exit, and a rung that came down with the *element*
  // would still be consuming Escape while the reader is somewhere else — with a second popup
  // possibly already open, which is exactly the pair this protocol cannot order. Gated on the
  // flag, it is dead on the render that starts the fade.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  return (
    <span
      ref={rootRef}
      // **A press in here is a press, never a drag of what this sits on.** Three of the four
      // surfaces this appears on are drag sources now (a search tile, a printings row), and
      // Chromium starts a drag from the nearest draggable *ancestor* of whatever was pressed —
      // so without the mark a press on the "+" that travelled five pixels would carry the card
      // off and never open this popup at all. Marked here rather than at each call site
      // because it is this control's own fact, which is what `dnd.ts`'s rule asks for: anything
      // that owns its own press marks itself.
      data-no-drag=""
      // `open` last, so an open popup outlives the hover that revealed its button.
      className={cn("relative inline-flex", className, open && "opacity-100")}
      // Closing on focus leaving covers the click-outside case as well, and does it without
      // a window listener that could fight the Escape handshake. The boundary is the whole
      // control rather than the popup: on `relatedTarget` being this button — a second
      // click on it, or Escape's hand-back — closing here would race the toggle below and
      // leave the popup open forever.
      //
      // **The `open &&` is doing a second job now.** An exiting popup is still inside this
      // root, so focus leaving it during the fade fires this handler again — and the flag is
      // already false by then, which is what makes that press a no-op rather than a second
      // close racing whatever the reader has moved on to.
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
        // them. The destination is the popup's current one, not always the collection.
        aria-label={`Add ${target.name} (${target.setCode.toUpperCase()} ${target.collectorNumber}) to ${mode}`}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md border border-border text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <AddPopup key="add" target={target} align={align} mode={mode} onModeChange={setMode} />
        )}
      </AnimatePresence>
    </span>
  );
}

/** A success line, and which add it belongs to. See the `role="status"` region below. */
interface Report {
  text: string;
  seq: number;
}

function AddPopup({
  target,
  align,
  mode,
  onModeChange,
}: {
  target: AddTarget;
  align: "start" | "end";
  /** Owned by the trigger, whose accessible name says it. */
  mode: Mode;
  onModeChange: (next: Mode) => void;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the fade out. */
  const present = useIsPresent();
  const finishes = target.finishes.length > 0 ? target.finishes : (["nonfoil"] as Finish[]);
  const [finish, setFinish] = useState<Finish>(finishes[0]);
  const [condition, setCondition] = useState<Condition>("NM");
  const [quantity, setQuantity] = useState(1);
  const [anyPrinting, setAnyPrinting] = useState(false);
  const [done, setDone] = useState<Report | null>(null);
  const queryClient = useQueryClient();

  // The caret moves into the layer, as it does for the card pane and the set picker: the
  // popup's own controls are then the next thing Tab reaches, focus leaving it is what
  // closes it, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

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
      // action. Numbered because two identical copies is the commonest second add there
      // is, and the same sentence set twice is a live region that never changed.
      setDone((prev) => ({
        text: `Added ${quantity} × ${target.name} to your ${mode}.`,
        seq: (prev?.seq ?? 0) + 1,
      }));
      // The list this write belongs to, and its summary. Which one that is depends on the
      // destination, and only one direction crosses over: a collection add changes what
      // every *wish* for that card counts as owned (`WishRow.ownedQuantity` is summed from
      // `collection_entries`, finish-aware), while a wish changes nothing the collection
      // shows. So a wishlist add leaves `["collection"]` alone rather than refetching a
      // list and a summary that cannot have moved.
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      if (mode === "collection") {
        void queryClient.invalidateQueries({ queryKey: ["collection"] });
        // And every deck, for the collection add only: a deck's claim is clamped to what the
        // entry still holds when the deck is read, so a copy added under a built deck is a
        // copy that deck may now read as owning. A *wish* is a copy the user does not have,
        // and changes no deck's arithmetic at all.
        void queryClient.invalidateQueries({ queryKey: ["decks"] });
      }
      // And the search results, which now *draw* what this write changed: `ownedQuantity`
      // and `wishlisted` are the badge on every row and every tile, so a wall the reader
      // added a third copy from would go on saying "×2" until they searched again.
      //
      // This used to carry `refetchType: "none"` for cost, and the cost is not small: an
      // infinite search holds every page the reader scrolled through — up to 100 of them,
      // ~53 ms each against the real database — and query-core refetches them in sequence,
      // so a deep scroll is a multi-second worst case behind an open popup. What bounds it
      // is that only *active* queries refetch: the search currently on screen, and this
      // popup is only ever open over one of them. A badge that is visibly wrong is worse
      // than background work nobody is waiting on.
      //
      // The upgrade is to stop asking rather than to ask more cheaply: patch
      // `ownedQuantity`/`wishlisted` into the cached search pages in place, the way
      // `WishlistPage`'s `patchWish` rewrites a wish, and refetch nothing at all.
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });

  return (
    <motion.div
      {...popup}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Add ${target.name}`}
      // On the way out it is a picture and nothing else: not pressable, and not a second copy
      // of this card's add form in the accessibility tree. The caret has already gone back to
      // the trigger (Escape) or moved on somewhere else (a click), so nothing focused is being
      // hidden here.
      aria-hidden={present ? undefined : true}
      // Anchored, not portalled: the shipped CSP is `style-src 'self'` and every overlay
      // primitive in reach injects a runtime <style> the moment it opens (fine under
      // `tauri dev`, blank in a packaged build). Same decision as `SetCombobox`. Not
      // `aria-modal` either — the list behind it stays live, and a dialog that claims the
      // page is inert while it demonstrably is not is worse than no dialog at all.
      className={cn(
        "absolute top-7 w-64 space-y-3 rounded-lg border border-border bg-surface p-3",
        "text-left shadow-lg",
        // Only ever effective against this popup's *siblings*: on a table row or a grid row
        // the anchor is inside a transformed element, which caps everything in it at that
        // row's own layer. See `LAYER`.
        LAYER.popup,
        align === "start" ? "left-0" : "right-0",
        // The corner the popup is pinned by is the corner it grows from — `popup` leaves the
        // origin to its consumer precisely because only the consumer knows which edge it hung
        // itself off. Both spellings written out whole: Tailwind scans source text, so a class
        // built by interpolation emits no rule at all.
        align === "start" ? "origin-top-left" : "origin-top-right",
        !present && "pointer-events-none",
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
              onModeChange(m);
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
        <div role="group" aria-label="Which printing" className="flex gap-1">
          {[
            { any: false, label: "This printing" },
            { any: true, label: "Any printing" },
          ].map(({ any, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={anyPrinting === any}
              // A wish for "any printing" is keyed on the oracle card, so a card that
              // reaches this popup without an `oracleId` cannot make one.
              //
              // That is a fence around the nullable type, not around a kind of card. The
              // belief that reversible cards have no `oracle_id` is false: Scryfall omits
              // only the *top-level* one, and `card_row` falls back to `card_faces[0]`, so
              // 0 of 116,590 live rows (2026-08-05) are null and all 81 reversible
              // printings can be wished for by oracle. Disabled rather than hidden all the
              // same: a choice that silently disappears is one the reader has no reason to
              // believe exists.
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
            though it were this one.

            The sentence is keyed by the add it reports, so adding the same copy twice
            replaces the node rather than rewriting it with itself — React bails out of a
            re-render on an identical string, and a live region whose text did not change
            announces nothing. */}
        <p role="status" className="text-xs text-dim">
          {!add.isError && done && <span key={done.seq}>{done.text}</span>}
        </p>
        {add.isError && (
          // Stays open behind this, with every answer still in it: recording the same card
          // twice is one interaction, and so is trying again.
          <p role="alert" className="text-xs text-destructive">
            Could not add to your {mode} — {ipcError(add.error)}
          </p>
        )}
      </div>
    </motion.div>
  );
}
