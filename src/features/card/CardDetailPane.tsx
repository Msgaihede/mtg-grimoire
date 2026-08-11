import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlipHorizontal2, X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable, deckCardSlot, DECK_CARD_ATTR } from "@/features/decks/dnd";
import { useSwapFromPane } from "@/features/decks/useDeck";
import { FoilOverlay } from "@/components/CardArt";
import { FinishMark } from "@/components/FinishMark";
import { FINISH_LABEL, finishPrice, parseFinishes, soleFinish } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardDetail, type CardFace, type Printing } from "@/lib/ipc";
import { dialog } from "@/lib/motion";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { faceCount, groupByIllustration, legalityChips } from "./printings";
import {
  PrintingPreview,
  PREVIEW_FRAME_ATTR,
  usePrintingDwell,
  type DwellRowProps,
} from "./PrintingPreview";

/**
 * Keyboard focus, in the shape the rest of the app uses: an outline standing off the
 * control's edge, never a ring (see `FilterBar`'s `FOCUS` — outline is focus, border and
 * ring are state).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The colour of a legality chip.
 *
 * `not_legal` is already dropped, so nearly every chip says "legal" — which makes legal
 * the *quiet* case and the exceptions the ones worth ink. Gold is the app's interactive
 * colour and is deliberately not spent here: twenty gold chips under the art would out-
 * shout the focus outline that has to mean something.
 */
const STATUS_CLASS: Record<string, string> = {
  legal: "border-border text-text",
  restricted: "border-border text-dim",
  banned: "border-destructive/40 text-destructive",
};

/**
 * What one pane leaves for the next when a swap re-keys it under the reader's hands.
 *
 * A successful swap writes `selectedCardId`, `App` keys the pane on it, and this component is
 * therefore **unmounted and remounted** on the printing the deck now holds — so what the write
 * did has to cross that gap, and there is no prop to carry it: the pane that could say it is
 * gone before the sentence exists.
 *
 * Module-scoped rather than store state for the reason `store.ts` gives about `returnToDeckId` —
 * a note between two mounts of one component is not application state — with the difference that
 * this one never outlives the commit it was written in: the mounting pane consumes it, and a
 * pane that is not the one it was left for discards it. Stamped with the card it belongs to so
 * it can tell those two apart.
 *
 * **The caret is deliberately not in here.** The obvious other passenger would be the opener the
 * replaced pane was holding — but that opener is the deck control the reader pressed the card
 * open from, and the swap *deletes* it: the row it drew is gone and the new printing's row is a
 * different React key. Passing it on would hand the caret to an element the next refetch
 * unmounts. `close` asks the deck for the control standing for the slot **now** instead.
 */
let handover: { cardId: string; report: string | null } | null = null;

/**
 * The deck's own control for a slot, or `null` — where the caret belongs when a pane opened
 * from a deck row closes and the control it was opened from has been replaced.
 *
 * The card ids this interpolates are Scryfall UUIDs and the category ids are `INTEGER PRIMARY
 * KEY` rowids, so there is nothing here a quoted attribute selector can be broken by — the
 * category's *name* is the user's and would be, which is why the slot is keyed by the id. The
 * search is document-wide and does not name a deck, which is safe for as long as one editor is
 * mounted at a time — see {@link deckCardSlot}, which is where that assumption is written down.
 */
function deckControlFor(row: PaneDeckContext | null): HTMLElement | null {
  if (!row) return null;
  return document.querySelector<HTMLElement>(
    `[${DECK_CARD_ATTR}="${deckCardSlot(row.categoryId, row.cardId)}"]`,
  );
}

/**
 * What a printings row needs to offer "Use this printing", or `null` on a pane that was not
 * opened from a deck row.
 *
 * One object rather than five props threaded through two components, and it is the *whole*
 * condition: a row draws the action if and only if this is here. Spec §2 scopes the swap to
 * decks — the collection's printing identity carries finish and condition, and a swap there
 * would invent facts the same way a drop onto it would.
 */
interface SwapOffer {
  /** The deck slot the pane was opened from — the swap's `deck`, `category` and `from`. */
  row: PaneDeckContext;
  /** The printing whose swap is in flight, or `null`. Every row is inert while one is: they
   *  would all be sent the same `from` printing, which that write is in the middle of moving. */
  pendingId: string | null;
  /** The printing whose swap was refused, and the sentence to say beside it. */
  refused: { printingId: string; reason: string } | null;
  /**
   * The deck read answers nothing: another view deleted it, so there is nothing left to offer.
   *
   * Not `null`-the-whole-offer, because the commonest way to learn this is **the refusal
   * itself** — a press against a deleted deck answers GONE, the mutation's `onError` re-reads,
   * and the read comes back empty. Dropping the offer wholesale would take the sentence
   * explaining that down with the buttons it explains.
   */
  gone: boolean;
  onUse: (printingId: string) => void;
}

/**
 * One printing, in full: the card itself, every printing of the same oracle card grouped
 * by artwork, and the credit Scryfall's image policy requires.
 *
 * A docked pane rather than a modal. The results list behind it stays live and reachable,
 * so there is nothing to trap focus into and nothing to mark `aria-modal` — a dialog that
 * claims the page behind it is inert while it demonstrably is not is worse for a screen
 * reader than no dialog at all. It is also an ordinary element in the app's own tree
 * rather than a portal: the shipped CSP is `style-src 'self'`, and every overlay primitive
 * in reach pulls in `react-remove-scroll`, which injects a runtime `<style>` the moment it
 * opens — fine under `tauri dev`, a blank pane in a packaged build.
 *
 * What it does borrow from a dialog is the focus contract, hand-rolled here as in
 * `SetCombobox`: focus moves in when it opens, and Escape hands it back to whatever opened
 * it.
 *
 * ## Two components, and the seam is where the animation had to go
 *
 * This half is the **box**: it is present for as long as *some* card is open, whichever card
 * that is, and it is the thing `App`'s `AnimatePresence` tracks. {@link Body} is the card in
 * it, keyed on the card, so a printings row still throws the whole per-card apparatus away —
 * the front face, the scroll position, the opener the caret is owed to — and builds a new one.
 * The key used to be on this component, at the mount site, and moving it down is the whole
 * point: an exit is only owed when the pane *goes*, and card-to-card is not that.
 *
 * **Transform and opacity, never width.** The pane is a flex sibling whose width `DeckEditor`
 * measures with a `ResizeObserver` to decide whether its search panel fits beside it, so a
 * width tween would flip that panel to its rail and back mid-animation. Layout is therefore
 * instant and only the paint moves.
 *
 * {@link dialog} rather than the drawer preset, which is the one this geometry argues for: a
 * right-docked panel is exactly what `drawerRight` describes, but it arrives from `x: 100%` —
 * off the right of its own slot, which here is already flush with the window — and the pane
 * lives inside `AppShell`'s `overflow-auto` main region, so those 384px of travel are 384px of
 * scrollable overflow and a horizontal scrollbar flashing on every card opened. A scale from
 * the right edge reads as the same arrival and cannot overflow anything, because it is never
 * larger than the box it lands in.
 */
export function CardDetailPane({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const paneRef = useRef<HTMLElement>(null);
  /** False from the render that starts the fade out. */
  const present = useIsPresent();

  return (
    <motion.aside
      {...dialog}
      ref={paneRef}
      tabIndex={-1}
      aria-label="Card details"
      // On the way out it is a picture: not clickable, and not a second card sitting in the
      // accessibility tree beside whatever the reader moved on to. `close` handed the caret
      // back before this render, so nothing focused is being hidden.
      aria-hidden={present ? undefined : true}
      // The box a printings row's hover preview is positioned in and clipped by — one mark,
      // because they are one box: `relative` makes the pane the containing block those
      // coordinates are in, and it is the scroller, so it is also what would cut a picture in
      // half. See {@link PREVIEW_FRAME_ATTR}.
      {...{ [PREVIEW_FRAME_ATTR]: "" }}
      // A block that scrolls, not a flex column: in a column the art is a flex item, and a
      // pane shorter than the card would compress the image to fit rather than scroll —
      // which is the one thing Scryfall's usage rules forbid outright.
      className={cn(
        "relative w-96 shrink-0 space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-4",
        // Grown from the edge it is docked against, so the gesture points at where the pane
        // comes from rather than at its own middle.
        "origin-right",
        !present && "pointer-events-none",
        FOCUS,
      )}
    >
      <Body key={cardId} cardId={cardId} onClose={onClose} paneRef={paneRef} />
    </motion.aside>
  );
}

/**
 * One card in the pane — every piece of state that belongs to *this* card rather than to the
 * pane, which is why it is keyed on the card and torn down with it.
 *
 * It draws the pane's children and not its box: the box is {@link CardDetailPane} above, and
 * the two are split so that a card-to-card move is a remount of this and not an exit of that.
 */
function Body({
  cardId,
  onClose,
  paneRef,
}: {
  cardId: string;
  onClose: () => void;
  /** The pane's own element, which outlives this body: the scroll reset, the focus on the way
   *  in and the hand-back after a refused swap are all writes to it. */
  paneRef: RefObject<HTMLElement | null>;
}) {
  const [face, setFace] = useState(0);
  const [shown, setShown] = useState(cardId);
  const openerRef = useRef<HTMLElement | null>(null);
  /** What the write that re-keyed this pane did, once there is a pane to say it in. Set from
   *  the {@link handover} in the mount effect — see the live region it is drawn in. */
  const [report, setReport] = useState<string | null>(null);

  /**
   * The deck row this card was opened from — read first, because the pane's *close* depends on
   * it: a pane opened out of a deck owes the caret to that deck's control (see `close`).
   *
   * The pane is a sibling of the deck editor rather than part of it, so what joins them is the
   * store on one side (`openCardFromDeck`, written by a category column's click) and a shared query
   * cache on the other ({@link useSwapFromPane} mounts the editor's own `["decks", "detail"]`
   * read, so this costs no `deck_get` while an editor is up). With no context it is an idle
   * mutation over a query that asks for nothing.
   */
  const deckRow = useAppStore((s) => s.paneDeckContext);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);
  // The context's own variant, so the swap rewrites the list the reader is looking at. Passing
  // nothing here would take the hook's `live` default — which, where the same printing sits in
  // the same category of both lists, rewrites the live row from a theory pane and reports
  // success. `undefined` with no context is the default again, which is the idle case.
  const { swap, deckGone } = useSwapFromPane(deckRow, deckRow?.variant);

  // A different card is a different card, and the back of the last one is not where a
  // reader wants to arrive. Reset during render — React's own answer to state that has to
  // follow a prop, and the same shape `CardGrid`'s tiles use: an effect would paint one
  // frame of the previous card's back face under the new card's name.
  if (shown !== cardId) {
    setShown(cardId);
    setFace(0);
  }

  // The scroll position is the DOM's, not React's, so it is reset where DOM writes belong.
  // `paneRef` is the pane's, handed down and stable for its life, so it changes nothing about
  // when this runs — it is in the list because the rule is "every value read", not "every value
  // that moves".
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [cardId, paneRef]);

  // Once, on the way up: whatever had the caret is where Escape has to put it back.
  //
  // Never the pane itself, and that guard is the whole reason this is not one line.
  // StrictMode runs a mount effect twice in development — mount, unmount, mount — and the
  // first run has already moved the caret *into* the pane, so the second would record the
  // pane as its own opener. `close()` then focuses an element that is unmounting, the caret
  // lands on `<body>`, and the next Tab restarts from the top of the app. Measured live on
  // 2026-08-06: every Escape out of the pane dropped focus to `<body>` under `tauri dev`.
  // Nothing is skipped in production, where the effect runs once and the caret is outside.
  //
  // And **never `<body>`**, which is the state a swap leaves behind: the button that was
  // pressed disabled itself for the write, so the browser blurred it with no `relatedTarget` at
  // all, and this pane was then re-keyed onto the printing the swap chose. Recording `<body>`
  // as an opener makes the next Escape a hand-back to nowhere — `close` has the answer for that
  // case, and it is a better one than any element this effect could record.
  useEffect(() => {
    const passed = handover;
    // Consumed or discarded, never left lying: a note for a pane that never mounted would be
    // read by whichever card the reader opened next.
    handover = null;
    // **The second commit is the feature here, not a cost to be optimised away.** This sentence
    // goes into the live region in the shell above — mounted and empty on this pane's *first*
    // commit, whatever the card query is doing — and a region that appears together with its
    // text announces nothing. It has to be mounted first and change afterwards, which is
    // exactly what a state write from a mount effect is. Reading the handover during render
    // instead would fill the region on commit one and silence it; so would drawing the region
    // anywhere behind `card.data`, which after a re-key is a fetch away (see the region).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (passed?.cardId === cardId) setReport(passed.report);
    const active = document.activeElement as HTMLElement | null;
    if (active !== document.body && !paneRef.current?.contains(active)) {
      openerRef.current = active;
    }
    paneRef.current?.focus();
    // `cardId` is this body's identity — the pane keys on it — so this list is constant for the
    // life of the component and the effect still runs exactly once. `paneRef` is the box's own
    // ref, stable for as long as any card is open, and changes nothing about that.
  }, [cardId, paneRef]);

  const close = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    // Called before React flushes the close, while this pane still holds the focus: an
    // element that unmounts with the caret on it drops it to `<body>`, and the next Tab
    // restarts from the top of the app.
    //
    // The opener of a pane opened from a deck row is the control on that row — and a swap
    // **replaces that control**: the row it was drawn from is deleted and the printing's new
    // row is a different key, so by the time the reader presses Escape the element the caret
    // is owed to has been unmounted by the refetch. The deck's own controls carry the slot
    // they draw (`DECK_CARD_ATTR`), so the caret goes to the card the deck holds *now*, which
    // is the card the reader was working on. Measured in the running window: without this the
    // caret lands on `<body>` after every swap, whatever was stashed.
    const home = opener?.isConnected ? opener : deckControlFor(deckRow);
    if (home?.isConnected) home.focus();
  }, [onClose, deckRow]);

  // The outer layer: bubble phase, and it yields to any control open over the results —
  // the set filter's listbox, a printings row's hover preview, anything later — that consumed
  // the press from the capture phase. Without that the pane closes underneath such a control on
  // the same press, and the two focus hand-backs fight over where the caret lands. See
  // `useDismissOnEscape`.
  //
  // **The `"inner"` rung is one at a time, and no z-index or state union enforces it** — the
  // protocol orders exactly two rungs, so two inner layers open at once would both consume the
  // same press. What keeps this pane's apart is that each yields to the thing that would open
  // the other:
  //
  // * the **quick-add popup** on a printings row closes when focus leaves its own root, and
  //   opening anything else moves the caret into that instead;
  // * the **hover preview** closes on the hover-leave or blur that ended its dwell, and on the
  //   press inside a row — which is how the popup is opened — *and* refuses to start at all
  //   while a popup is open in this pane (a trigger carrying both `aria-haspopup` and
  //   `aria-expanded="true"`), which is the case a press cannot cover: hovering a neighbouring
  //   row with the popup open presses nothing.
  //
  // Both halves are `usePrintingDwell`'s, and its doc has the measurement they came from.
  useDismissOnEscape({ layer: "outer", onDismiss: close });

  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => ipc.cardDetail(cardId),
  });

  const swapping = swap.isPending;
  const startSwap = swap.mutate;
  const usePrinting = useCallback(
    (toCardId: string) => {
      // One swap at a time. The buttons disable themselves on the press, so this is the press
      // that arrives before that paint — and it is not a double-click guard alone: every row's
      // button sends the *same* `from` printing, and the write in flight is in the middle of
      // moving it, so a second press would be refused for a row that no longer exists.
      if (!deckRow || swapping) return;
      startSwap(
        { fromCardId: deckRow.cardId, toCardId, categoryId: deckRow.categoryId },
        {
          onSuccess: (result) => {
            // What this pane knows and the one replacing it cannot: where the caret came from,
            // and what the write did. Left before the store write, because that write is what
            // unmounts this component.
            handover = {
              cardId: toCardId,
              // **A category holds a printing at most once**, so a swap onto one it already
              // had turns two rows into one — a line disappears out of the deck list, and a
              // list that silently loses a line reads like a bug (`ipc.ts`'s `SwapResult`).
              // The server's arithmetic, never a guess: `quantity` is what the surviving row
              // holds. Nothing is said when nothing merged.
              //
              // The name is the context's own, not a lookup: a category is a row the user named,
              // so there is no table to translate an id through and the pane has no category
              // list of its own (see `PaneDeckContext`, where the pairing is written down).
              report: result.folded
                ? `Folded into one row of ${result.quantity} in ${deckRow.categoryName}.`
                : null,
            };
            // The pane follows the deck. The reader asked for this printing to be the one in
            // the deck, so it becomes the card in front of them — and the mark moves onto the
            // row they pressed, in one store write, because `openCardFromDeck` is both.
            openCardFromDeck({ ...deckRow, cardId: toCardId });
          },
        },
      );
    },
    [deckRow, swapping, startSwap, openCardFromDeck],
  );

  // **The caret, one step after the refusal took it back.**
  //
  // A refused swap is usually a deck that has been deleted: the button re-enables itself and
  // takes the caret (see `DeckLine`), then the `onError` re-read lands, `deckGone` turns true,
  // and every button in the list — including the one now holding the caret — is unmounted. That
  // drops it to `<body>` with the refusal still on screen, which is the same stranding the
  // hand-back exists to prevent, one commit later. The pane is where that sentence lives, so
  // the pane takes the caret: Escape still closes what the reader is reading, and Tab carries
  // on from here rather than from the top of the app.
  //
  // Only out of `<body>`, like every other hand-back in this file — a reader who has moved on
  // owns where they are — and only where there is a refusal to read.
  const refusedSwap = swap.isError;
  useEffect(() => {
    if (deckGone && refusedSwap && document.activeElement === document.body) {
      paneRef.current?.focus();
    }
  }, [deckGone, refusedSwap, paneRef]);

  const offer: SwapOffer | null = deckRow && {
    row: deckRow,
    pendingId: swapping ? (swap.variables?.toCardId ?? null) : null,
    refused:
      swap.isError && swap.variables
        ? { printingId: swap.variables.toCardId, reason: ipcError(swap.error) }
        : null,
    gone: deckGone,
    onUse: usePrinting,
  };

  const oracleId = card.data?.oracleId ?? null;
  const printings = useQuery({
    queryKey: ["card", "printings", oracleId],
    queryFn: () => ipc.cardPrintings(oracleId as string),
    // `oracleId` is nullable on the wire, so there is a state with nothing to ask for.
    //
    // It is *not* the reversible-card state, whatever the comment here used to say:
    // Scryfall omits only the top-level `oracle_id` on those, and `card_row` falls back to
    // `card_faces[0]`, so the column is filled. 0 of 116,590 live rows (2026-08-05) are
    // null, all 81 reversible printings included. This gate is a fence around the type, not
    // around a card — which is why the section below renders nothing instead of explaining
    // itself.
    enabled: oracleId !== null,
  });

  return (
    <>
      <div className="flex items-start gap-2">
        {/* The card's name is content, not a section header, so it stays in Geist —
            Cinzel is for view titles and hero copy, and never below 18px. */}
        <h2 className="min-w-0 flex-1 text-base font-medium">
          {card.data?.name ?? (card.isPending ? "Loading…" : "Card")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close card details"
          className={cn(
            "shrink-0 rounded-md border border-border p-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* What the write that opened this pane did — and the pane's **live region**, which is
          why it is out here in the shell rather than beside the mark it is about.

          A region has to be mounted *before* its text arrives or nothing announces it (this
          app's own rule, kept the same way by `SearchPage`, `WishlistPage` and
          `AddToCollection`: mounted for the life of the surface, empty until there is something
          to say). Everything below this point is behind `card.data`, and a swap re-keys the
          pane onto a printing whose detail has not been fetched yet — so a region drawn down
          there would first appear several commits later with its sentence already inside it,
          which announces nothing. Here it exists on the first commit of every pane, and the
          mount effect fills it on the second.

          `sr-only` while empty rather than hidden: `display: none` takes a region out of the
          accessibility tree, and a region that has to be put back is a region that was never
          mounted. Absolutely positioned, so an empty one costs no space in this `space-y-4`
          column either. */}
      <p role="status" className={cn("text-xs text-dim", !report && "sr-only")}>
        {report}
      </p>

      {card.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not read this card — {ipcError(card.error)}
        </p>
      )}

      {!card.isPending && !card.isError && card.data === null && (
        <p className="text-sm text-dim">
          This printing is not in the card database any more. It may have been removed by the last
          sync — close this and search again.
        </p>
      )}

      {card.data && (
        <>
          <Art card={card.data} face={face} onFlip={() => setFace((f) => (f === 0 ? 1 : 0))} />
          <Facts card={card.data} face={face} />
          <Legalities card={card.data} />
          <Printings
            card={card.data}
            items={printings.data?.items ?? []}
            total={printings.data?.total ?? 0}
            loading={printings.isPending && oracleId !== null}
            error={printings.isError ? ipcError(printings.error) : null}
            swap={offer}
          />
          {/* Not decoration and not optional: Scryfall requires the artist and the source
              to be identifiable in the same interface that shows the art. The artist is
              the one whose art is on screen — the two sides of a double-faced card are not
              always the same illustrator. */}
          <p className="border-t border-border pt-3 text-[0.7rem] leading-relaxed text-dim">
            {artistOf(card.data, face) && <>Illustrated by {artistOf(card.data, face)}. </>}
            Card images © Wizards of the Coast · Data © Scryfall
          </p>
        </>
      )}
    </>
  );
}

/** Who drew the side on screen, falling back to the card's own credit. */
function artistOf(card: CardDetail, face: number): string | null {
  return card.faces[face]?.artist ?? card.artist;
}

/**
 * The card, as big as the pane allows.
 *
 * The direction doc's one absolute: on a screen that has card art, the art is the loudest
 * thing on it. Everything below is 12–14px grey.
 */
function Art({ card, face, onFlip }: { card: CardDetail; face: number; onFlip: () => void }) {
  const sides = faceCount(card.layout, card.faces.length);
  const src = cardImageUrl(card.id, face, "display");
  // The src that failed, so a flip or a new card clears it without an effect.
  const [broken, setBroken] = useState<string | null>(null);
  const shown = card.faces[face];
  const other = card.faces[face === 0 ? 1 : 0];

  return (
    <div className="space-y-2">
      {/* Positioned, so the foil overlay has something to hang from. Wrapped rather than
          routed through `CardArt`: this frame keeps a flip fade, a bespoke "no image yet"
          panel and no retry hook, and trading those three deliberate behaviours for one
          shared frame would be a bad bargain. What it *must* share with the wall is the
          marking, which is why `FoilOverlay` is its own component. */}
      <span className="relative block overflow-hidden rounded-xl">
      {broken === src ? (
        // A rate-limited image is a 503 the `<img>` cannot read, so this says what is known
        // rather than guessing: the card is still identified, and the way back is stated.
        <div
          style={{ aspectRatio: CARD_ASPECT }}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-xl bg-bg px-6 text-center"
        >
          <span className="text-sm">{shown?.name || card.name}</span>
          <span className="text-xs text-dim">
            No image yet — it may still be downloading. Reopen the card to try again.
          </span>
        </div>
      ) : (
        <CardImage
          // The name, not "card image": this is what a screen reader announces and what
          // shows if the fetch fails, and both readers want the card.
          alt={shown?.name || card.name}
          // Keyed on the `src` inside {@link CardImage}, which is both the flip and the card:
          // a new face is a new image, so the fade *is* the flip (150ms, the whole motion
          // budget, gone entirely under `prefers-reduced-motion`; a 3D card turn would be the
          // biggest animation in an app whose only other one is the sync sweep) — and a new
          // *card* is a new image too, which a `key={face}` was not. That mattered on the one
          // path the pane does not blank itself first: a card already in the query cache is
          // handed over in the same render, with no pending state to unmount the picture, so
          // browsing back to a card you just looked at kept the other card's art on screen.
          src={src}
          onError={() => setBroken(src)}
          decoding="async"
          style={{ aspectRatio: CARD_ASPECT }}
          // No filters and no crop: distorting, recolouring or cropping a card image is
          // forbidden by Scryfall's usage rules. `object-cover` on a 5:7 frame holding a
          // 5:7 image is a no-op that stays safe if the frame ever changes.
          className="w-full animate-in rounded-xl bg-bg object-cover fade-in duration-150 motion-reduce:animate-none"
        />
      )}
        <FoilOverlay finish={soleFinish(card.finishes)} />
      </span>
      {sides === 2 && (
        <button
          type="button"
          onClick={onFlip}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border border-border",
            "py-1.5 text-xs text-dim transition-colors duration-150 hover:text-text",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <FlipHorizontal2 className="size-3.5" aria-hidden="true" />
          Flip to {other?.name || "the other face"}
        </button>
      )}
    </div>
  );
}

/**
 * What the card says, and what it costs.
 *
 * Which faces are printed here is a layout question, not a face-count one: a `transform`
 * shows the side on screen and swaps with the flip control, while a `split` shows both
 * halves at once because both are printed on the one side the image is of.
 */
function Facts({ card, face }: { card: CardDetail; face: number }) {
  const finishes = parseFinishes(card.finishes);
  const sides = faceCount(card.layout, card.faces.length);
  const faces: CardFace[] =
    card.faces.length === 0
      ? [
          {
            name: "",
            typeLine: card.typeLine,
            oracleText: card.oracleText,
            manaCost: card.manaCost,
            artist: card.artist,
          },
        ]
      : sides === 2
        ? [card.faces[face] ?? card.faces[0]]
        : card.faces;

  return (
    <div className="space-y-3">
      {/* Provenance, in the data face: set, collector number, printing language. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
        <span className="font-mono" title={card.setName ?? undefined}>
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {card.setName && <span className="min-w-0 truncate">{card.setName}</span>}
        {card.lang !== "en" && <LangBadge lang={card.lang} />}
        {/* Tinted text with a gem, never a filled badge — the shared component, which is
            where that judgement now lives for all four surfaces that show a rarity. */}
        {card.rarity && <RarityGem rarity={card.rarity} withLabel />}
      </p>

      {faces.map((f, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0">
              {/* Named only when both halves are on screen at once — otherwise the pane's
                  own heading already carries the name. */}
              {faces.length > 1 && f.name && <span className="mr-1.5 font-medium">{f.name}</span>}
              <span className="text-dim">{f.typeLine ?? "—"}</span>
            </span>
            <ManaText source={f.manaCost} className="shrink-0" />
          </div>
          {f.oracleText && (
            <p className="whitespace-pre-line text-sm leading-relaxed">
              {/* `inline`, not the component's default `inline-flex`: rules text wraps, and
                  a flex run of it would be one unbreakable line. */}
              <ManaText source={f.oracleText} className="inline" />
            </p>
          )}
        </div>
      ))}

      {finishes.length > 0 && (
        <>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {finishes.map((f) => (
              <div key={f} className="flex items-baseline gap-1.5">
                <dt className="text-dim">{FINISH_LABEL[f]}</dt>
                <dd className="font-mono tabular-nums">{usdPrice(finishPrice(card.prices, f))}</dd>
              </div>
            ))}
          </dl>
          {/* Spec §5: a price is never shown without saying how old it is. The ribbon
              carries the date of the data these came in with. */}
          <p className="text-[0.7rem] text-dim">{PRICES_AS_OF}</p>
        </>
      )}
    </div>
  );
}

/** The two-letter printing language, shown only when it is not the assumed one. */
function LangBadge({ lang }: { lang: string }) {
  return (
    <span className="rounded border border-border px-1 font-mono text-[0.65rem] uppercase leading-4">
      <span className="sr-only">Language: </span>
      {lang}
    </span>
  );
}

function Legalities({ card }: { card: CardDetail }) {
  const chips = legalityChips(card.legalities);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Format legality" className="flex flex-wrap gap-1">
      {chips.map(({ format, status }) => (
        <li
          key={format}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.7rem] capitalize",
            STATUS_CLASS[status] ?? "border-border text-dim",
          )}
        >
          {format}
          {/* Never colour alone: a banned chip says "banned". "Legal" is the case that
              needs no ink, so its word is there for a screen reader and nowhere else.
              `lowercase` undoes the chip's `capitalize`, which would otherwise make it
              "Commander Banned" — sentence case is the app's voice. */}
          <span className={status === "legal" ? "sr-only" : "ml-1 lowercase opacity-80"}>
            {status}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every printing of this card, grouped by the artwork it carries.
 *
 * Grouped by illustration rather than listed flat because "which art is this?" is the
 * question a printings list is asked — and the group's heading is its *illustrator*,
 * which is a name the reader can check against the card, rather than "Artwork 2", which
 * is a number invented here.
 *
 * It is also the fastest way in the app to record "I have the Alpha one": every row adds
 * its own printing, which is why the whole card is passed rather than only its id — a wish
 * and an entry both need the name and the oracle id, and neither is on a `Printing`.
 *
 * And, when the card was opened from a deck row, the fastest way to *change* which printing a
 * deck is built from: see {@link SwapOffer}.
 */
function Printings({
  card,
  items,
  total,
  loading,
  error,
  swap,
}: {
  card: CardDetail;
  items: Printing[];
  total: number;
  loading: boolean;
  error: string | null;
  swap: SwapOffer | null;
}) {
  const headingId = useId();
  // One dwell timer for the whole list — see {@link usePrintingDwell} for why it cannot be one
  // per row. Called before the early return below, because a hook is.
  const dwell = usePrintingDwell();
  const dropPreview = dwell.cancel;
  // A refetch that replaces the rows takes any picture with it. The preview is measured against
  // the row it hangs off, and a row that has left the document measures 0×0 — an invisible
  // layer, at the top of the pane, that Escape still has to be spent on. Nothing tells a hover
  // that its element was unmounted, so the list says so: this is the only place that knows the
  // rows changed. (`items` keeps its identity across a refetch that changed nothing — query
  // structural sharing — so this is not an effect that runs on every render.)
  useEffect(() => {
    dropPreview();
  }, [items, dropPreview]);
  // A card with no `oracleId` never asked for printings, so it has no list to fail at
  // loading: nothing to say, and no empty section to say it in. (Nor does a card whose
  // printings all left `cards` — same shape, same silence.)
  if (!loading && !error && items.length === 0) return null;

  const groups = groupByIllustration(items);
  return (
    // The rule separates "this card" from "every card like it", which is the pane's one
    // real division. Set in the same hairline as the credit line below it rather than a
    // heavier rule: three sections, two hairlines, no boxes. The heading is rendered while
    // the list is still loading so the pane does not reflow around it when it arrives.
    <section aria-labelledby={headingId} className="space-y-2 border-t border-border pt-3">
      <h3 id={headingId} className="text-xs uppercase tracking-wide text-dim">
        Printings
      </h3>
      {loading && <p className="text-xs text-dim">Loading printings…</p>}
      {error && (
        <p className="text-xs text-destructive">
          Could not read the other printings — {error}. The card above is unaffected.
        </p>
      )}
      {/* A count line, so it is set in the data face. `items.length` is capped at 400 and
          `total` is not — saying only the first would report a Forest as having 400
          printings when it has 862. */}
      {items.length > 0 && (
        <p className="font-mono text-[0.7rem] tabular-nums text-dim">
          {items.length < total
            ? `${items.length} of ${total} printings`
            : `${total} printing${total === 1 ? "" : "s"}`}
          {" · "}
          {groups.length} artwork{groups.length === 1 ? "" : "s"}
        </p>
      )}
      {groups.map((group, i) => (
        <div key={group.illustrationId ?? `ungrouped-${i}`} className="space-y-0.5">
          <p className="flex items-baseline gap-1.5 pt-1 text-[0.7rem] text-dim">
            <span className="min-w-0 truncate">
              {group.printings[0].artist ?? "Artist unknown"}
            </span>
            <span className="font-mono tabular-nums">· {group.printings.length}</span>
          </p>
          <ul className="space-y-0.5">
            {group.printings.map((p) => (
              <PrintingRow
                key={p.id}
                printing={p}
                card={card}
                current={p.id === card.id}
                swap={swap}
                dwell={dwell.rowProps(p.id)}
              />
            ))}
          </ul>
        </div>
      ))}
      {/* The one picture the whole list shares, drawn last so it stands over the rows it
          covers, and positioned against the pane rather than against this section — which is
          why it can be mounted anywhere inside it. */}
      <PrintingPreview printingId={dwell.printingId} anchor={dwell.anchor} />
    </section>
  );
}

function PrintingRow({
  printing,
  card,
  current,
  swap,
  dwell,
}: {
  printing: Printing;
  card: CardDetail;
  current: boolean;
  swap: SwapOffer | null;
  /** The row's half of the list's one hover preview — see {@link usePrintingDwell}. */
  dwell: DwellRowProps;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const viewPrinting = useAppStore((s) => s.viewPrinting);

  // The row is the printing, and it can be carried off the list — spec §1's fourth drag
  // source, and the only one where the reader is choosing a *piece of cardboard* rather than a
  // card: every row here is the same card, and the id is what tells them apart.
  //
  // The name is the card's, because a `Printing` has none of its own. Re-registered only when
  // what the row would carry changes, rather than on every render: this pane re-renders on
  // every hover in the list (the dwell is state), and a source that unregisters mid-drag is a
  // drop that never arrives.
  //
  // The dwell's own `onDragStart` above takes the hover preview down as this starts — wired
  // where the preview lives, so it was already right on the day these rows grew a drag.
  const printingId = printing.id;
  const cardName = card.name;
  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    return cardDraggable({
      element,
      payload: () => ({ kind: "card", cardId: printingId, name: cardName }),
    });
  }, [printingId, cardName]);

  return (
    <li
      ref={rowRef}
      {...dwell}
      // The mouse's way into the printing: a click anywhere on the row that is not one of its
      // own controls shows this printing in the pane. The keyboard's way in is the set-code
      // button below. The split is the reason: a `role="button"` on the row would make the
      // controls inside it presentational.
      onClick={current ? undefined : () => viewPrinting(printing.id)}
      className={cn(
        "group rounded-md px-2 py-1 text-xs",
        // The one printing this pane is about. A gold hairline down its edge rather than a
        // fill: gold means "here" everywhere else in the app, and a filled row in a list of
        // forty would be the brightest thing under the art.
        current
          ? "border-l-2 border-accent bg-bg pl-1.5 text-text"
          : cn(
              "text-dim transition-colors duration-150 hover:bg-surface",
              "motion-reduce:transition-none",
            ),
      )}
    >
      {/* The facts, on one line. `items-center` rather than baseline because the line ends in
          a control: a 24px button hung off a baseline sits a third of its height below the
          prices it lines up with. */}
      <div className="flex items-center gap-2">
        <RarityGem rarity={printing.rarity} className="shrink-0" />
        {current ? (
          <span className="min-w-0 flex-1 truncate font-mono" title={printing.setName ?? undefined}>
            {printing.setCode.toUpperCase()} · {printing.collectorNumber}
            {printing.releasedAt && <> · {printing.releasedAt.slice(0, 4)}</>}
          </span>
        ) : (
          <button
            type="button"
            // The row's keyboard handle: show this printing. The click bubbles to the row,
            // which does the same thing — one destination, two ways in.
            aria-label={`Show ${printing.setCode.toUpperCase()} · ${printing.collectorNumber}`}
            title={printing.setName ?? undefined}
            className={cn("min-w-0 flex-1 truncate text-left font-mono", FOCUS)}
          >
            {printing.setCode.toUpperCase()} · {printing.collectorNumber}
            {printing.releasedAt && <> · {printing.releasedAt.slice(0, 4)}</>}
          </button>
        )}
        {printing.lang !== "en" && <LangBadge lang={printing.lang} />}
        {/* Per finish, from the blob — never one number standing for both. */}
        {parseFinishes(printing.finishes).map((f) => (
          <span key={f} className="flex shrink-0 items-center gap-0.5 font-mono tabular-nums">
            {/* A glyph rather than the letters `F` and `E` this used to draw. Nonfoil is
                still unmarked — it is the finish a price is assumed to be — and the full
                word rides in the accessible name, as the `<abbr>`'s title did. */}
            <FinishMark finish={f} />
            {usdPrice(finishPrice(printing.prices, f))}
          </span>
        ))}
        {/* This row's printing, not the pane's card: the set and the collector number are the
            row's own, and so are the finishes it may be owned in. The wrapper stops the row's
            own click: a press on the quick-add (or inside its popup) is not a request to show
            this printing. */}
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <AddToCollectionButton
            className={REVEAL_ON_HOVER}
            target={{
              cardId: printing.id,
              name: card.name,
              setCode: printing.setCode,
              collectorNumber: printing.collectorNumber,
              oracleId: card.oracleId,
              finishes: parseFinishes(printing.finishes),
            }}
          />
        </span>
      </div>

      {/* Stopped for the quick-add's reason: "Use this printing" writes to the deck, and the
          row underneath must not also swap the pane to the row it was pressed on. */}
      {swap && (
        <div onClick={(e) => e.stopPropagation()}>
          <DeckLine printing={printing} swap={swap} />
        </div>
      )}
    </li>
  );
}

/**
 * What this printing is to the open deck row: the one it holds, or one press away from it.
 *
 * **A line of its own under the row's facts**, not a control squeezed onto the end of them. The
 * pane is 384px wide and the facts already spend it — rarity, set, number, year, language, a
 * price per finish, the quick-add — so a button on that line would take its width out of the
 * set name, which is what the reader is choosing a printing *by*. Underneath, the two states
 * read down the list as one column: every row says either "this is the one" or "use this one",
 * and a refusal has somewhere to land in the reader's own line of sight.
 *
 * **Visible rather than revealed on hover** (spec §2), unlike the quick-add above it: the
 * add is one of forty identical offers a reader may never want, while this list — opened from
 * a deck row — is being read *in order to* pick one.
 */
function DeckLine({ printing, swap }: { printing: Printing; swap: SwapOffer }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pending = swap.pendingId === printing.id;
  const refused = swap.refused?.printingId === printing.id ? swap.refused.reason : null;
  const wasPending = useRef(false);
  // A deck that is gone offers nothing — no button on any row, and no mark on its own: "this
  // deck uses this printing" is not true of a deck that is not there, and forty buttons whose
  // only way of finding out is to be pressed are forty wrong offers. The editor beside this is
  // already saying so. What survives is the refusal that usually *taught* the pane this.
  const offering = !swap.gone;

  // The disabled-on-press hazard, in the shape it takes **inside a dismissible layer**: a
  // browser blurs a control that disables itself, with no `relatedTarget` at all, so the caret
  // lands on `<body>` — and this button is in the card pane, whose Escape hands the caret back
  // to whatever opened it. A reader who pressed a row, read a refusal and then pressed Escape
  // would be closing the pane from nowhere. The button is still here when the write settles, so
  // it takes the caret back — and only from `<body>`, because a reader who has moved on in the
  // meantime owns where they are. `DeckStats`' send button is the same guard outside a layer.
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      buttonRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  // Nothing to offer and nothing to explain: the row is its facts again, with no empty line
  // under them.
  if (!offering && !refused) return null;

  return (
    // `pt-0.5` and not a pixel more: the row's own padding is what separates one printing from
    // the next (4px + 4px + the list's 2px), so an action line hung further off its own facts
    // than that reads as belonging to the row *below* it. Measured in the running window at
    // 1280 × 800 against a 62-printing list.
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 pt-0.5">
      {refused && (
        // Beside the row that was pressed, which is where the reader is looking — the docked
        // search panel's add says its refusals the same way. A banner at the top of the pane
        // would be one sentence for forty rows, with nothing on screen saying which.
        <p
          role="alert"
          className="min-w-0 flex-1 text-left text-[0.7rem] leading-tight text-destructive"
        >
          Could not use this printing — {refused}
        </p>
      )}
      {!offering ? null : swap.row.cardId === printing.id ? (
        // The deck's own printing says so rather than offering itself. Static text, in the
        // dim the rest of the row's facts are set in: it is a fact about the deck, not a
        // control, and dressing it as one that cannot be pressed would be worse than saying it.
        //
        // **Static, and not the pane's live region.** What a swap *did* — a fold — is said in
        // the shell (see the region under the heading): this list is drawn behind `card.data`,
        // and after a re-key that data is a fetch away, so a region here would first appear with
        // its sentence already in it and announce nothing.
        <p className="text-right text-[0.7rem] text-dim">This deck uses this printing</p>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          // The row is a drag handle, and Chromium starts a drag from the nearest draggable
          // *ancestor* of whatever was pressed — so without the mark a press here that
          // travelled five pixels would carry the printing off and never deliver the click
          // (`cardDraggable`). The quick-add above marks itself; this one is the row's own.
          data-no-drag=""
          // `disabled` while any swap is in flight — this is the half-second case, which is
          // what `disabled` is for in this app (`DeckStats`' two kinds of no). Every row, not
          // only the pressed one: they all send the same `from` printing, and the write in
          // flight is moving it.
          disabled={swap.pendingId !== null}
          onClick={() => swap.onUse(printing.id)}
          // Forty rows, forty buttons, one visible label: the set and the collector number are
          // what tell them apart, and the category is what says which slot is being rewritten —
          // the same printing can sit in the main deck and the sideboard. The visible words lead
          // and change with the button, because an accessible name that no longer contains the
          // visible label is a control voice control can no longer press (WCAG 2.5.3, and
          // `DeckStats`' send button is the precedent this borrows).
          //
          // The category is the context's, which is the slot the pane was opened on — its name
          // as well as its id, because the pane is a sibling of the deck editor and has no
          // category list to translate one through (see `PaneDeckContext`). A row moved to
          // another category under an open pane makes that word stale — as does a rename of the
          // category itself — and only the word: the write is addressed by the same slot, finds
          // no row in the category it names, and is refused in the pane beside the button. The
          // label lies for one press; the deck does not change.
          aria-label={`${pending ? "Swapping…" : "Use this printing"} (${printing.setCode.toUpperCase()} ${printing.collectorNumber}) in ${swap.row.categoryName}`}
          className={cn(
            "shrink-0 rounded-md border border-border px-2 py-0.5 text-[0.7rem] text-dim",
            "transition-colors duration-150 hover:text-text disabled:opacity-50",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          {pending ? "Swapping…" : "Use this printing"}
        </button>
      )}
    </div>
  );
}
