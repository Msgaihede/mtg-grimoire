import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlipHorizontal2, Gem, Sparkles, X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable, deckCardSlot, DECK_CARD_ATTR } from "@/features/decks/dnd";
import { useSwapFromPane } from "@/features/decks/useDeck";
import { FoilOverlay } from "@/components/CardArt";
import { FinishMark } from "@/components/FinishMark";
import { FINISH_LABEL, parseFinishes, soleFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardDetail, type CardFace, type Printing } from "@/lib/ipc";
import type { Marketplace, MarketplaceId } from "@/lib/marketplace";
import { dialog, PRESS } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "./cardMenu";
import { CardMenuRefusal } from "./CardMenuRefusal";
import { useCardMenuDeps } from "./useCardMenuDeps";
import {
  buildPrintingGroups,
  faceCount,
  isPrintingGroupBy,
  legalityChips,
  PRINTING_GROUP_BY_OPTIONS,
  type PrintingGroupBy,
} from "./printings";
import {
  PrintingPreview,
  PREVIEW_FRAME_ATTR,
  usePrintingDwell,
  type DwellRowProps,
} from "./PrintingPreview";
import { usePrintingGroupBy } from "./usePrintingGroupBy";

/**
 * A header control that is not a chip — here, the one `<select>` in this pane.
 *
 * **Copied from `DeckEditor.tsx`'s `CONTROL`**, which is not exported, because the printings
 * list's `Group by` is meant to be the *same* control as the deck editor's `Group by` two
 * inches to its left: same height, same border, same press. A lookalike built from whatever
 * classes fitted would be a second grouping control in one window that behaved almost like the
 * first. If that constant is ever exported, this should become an import of it.
 *
 * The press is {@link PRESS}, the app's one recipe; the box, and the `disabled:` clause for
 * the grouping select that greys while the specs have not answered, are this pane's own.
 */
const CONTROL =
  "h-8 rounded-md border border-border bg-surface px-2 text-xs text-dim " +
  `${PRESS} ` +
  "disabled:active:scale-100";

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
 * What a printings row needs to *be* a swap, or `null` on a pane that was not opened from a
 * deck row.
 *
 * One object rather than five props, and it is the *whole* condition: a row's click rewrites
 * the deck slot if and only if this is here (and this row is not already the printing in it).
 * Spec §2 scopes the swap to decks — the collection's printing identity carries finish and
 * condition, and a swap there would invent facts the same way a drop onto it would.
 *
 * It used to be threaded through a second component, `DeckLine`, which drew a "Use this
 * printing" button on a line of its own under each row. The button is gone and the row is the
 * press; see {@link PrintingRow} for what that buys and what it costs.
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
 * **{@link dialog}, and the geometry argues for a slide that this pane cannot have.** It really
 * is a right-docked panel, and the obvious arrival for one is a travel in from `x: 100%` — off
 * the right of its own slot, which here is already flush with the window. That is 384px of
 * travel inside `AppShell`'s `overflow-auto` main region, so it is 384px of scrollable overflow
 * and a horizontal scrollbar flashing on every card opened. A scale from the right edge reads as
 * the same arrival and cannot overflow anything, because it is never larger than the box it
 * lands in. `lib/motion.ts` has no drawer preset at all now, for a related reason at the other
 * end of the app — the deck editor's two right-hand drawers became centred modals — so this is
 * the only preset a docked surface here has, and the reasoning above is why that costs nothing.
 */
/**
 * The one `card_detail` read this pane makes, named once.
 *
 * The marketplace is in the key because it is in the answer — `card_detail` prices every finish
 * with it, so two marketplaces are two different cards as far as the cache is concerned. It is a
 * function rather than a literal at each site because {@link CardDetailPane} reads this entry
 * *without* observing it: the box holds no card state (that is {@link Body}'s, keyed on the
 * card), so its right-click menu asks the cache for whatever the body has already fetched, at the
 * moment of the press. Two spellings of one key would be a menu that silently found nothing.
 */
function cardDetailKey(cardId: string, marketplace: MarketplaceId) {
  return ["card", cardId, marketplace];
}

/** The card the pane is open on, as a menu target. Every field is the card's own. */
function paneTarget(card: CardDetail): CardMenuTarget {
  return {
    cardId: card.id,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    oracleId: card.oracleId,
    finishes: card.finishes,
    typeLine: card.typeLine,
  };
}

/**
 * A printings row, as a menu target — **the one adapter in the app that reads two objects**.
 *
 * A `Printing` carries `setCode`, `collectorNumber` and `finishes` and **no name, no oracle id
 * and no type line**: it is a printing *of the card the pane is open on*, so those three come
 * from that `CardDetail`. Getting it wrong is invisible — the menu still draws, "Copy card name"
 * copies `undefined`, and a `null` oracle id greys "View all printings" out with the fence's own
 * sentence (*this printing has left the card database*) over a card that is perfectly healthy.
 *
 * The three fields that *are* the row's are the three that identify the piece of cardboard: the
 * Scryfall permalink is this printing's, and so is the finish list an "Add to → Collection"
 * records against. That split is the whole of what this function is for, and it is the same one
 * the row's own {@link AddToCollectionButton} target already makes.
 */
function printingTarget(printing: Printing, card: CardDetail): CardMenuTarget {
  return {
    cardId: printing.id,
    name: card.name,
    setCode: printing.setCode,
    collectorNumber: printing.collectorNumber,
    oracleId: card.oracleId,
    finishes: printing.finishes,
    typeLine: card.typeLine,
  };
}

/** A surface's two doors into one menu — a right-click, and Shift+F10 or the ContextMenu key. */
interface MenuHandlers {
  onContextMenu: MouseEventHandler;
  onKeyDown: KeyboardEventHandler;
}

export function CardDetailPane({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const paneRef = useRef<HTMLElement>(null);
  /** False from the render that starts the fade out. */
  const present = useIsPresent();

  const { menu, menuKey } = useContextMenu();
  /**
   * **One `useCardMenuDeps` for both of this pane's surfaces** — the open card and every
   * printings row — because two would be two collection-add observers and two sentences to draw
   * for one refusal. It is here rather than in {@link Body} so that the pane's own menu and the
   * rows' share it; the body is keyed on the card and is thrown away on every row the reader
   * clicks, which is no place to keep a write's answer.
   */
  const { deps, error: menuFailure } = useCardMenuDeps();
  const client = useQueryClient();
  const openDeckId = useAppStore((s) => s.openDeckId);
  const viewPrinting = useAppStore((s) => s.viewPrinting);

  /**
   * Where "View all printings" lands, which is the one dep this pane overrides.
   *
   * **Inside the deck editor it must stay in the pane.** `requestAllPrintings` sets
   * `activeView`, and that write clears `openDeckId` *and* `selectedCardId` — so the default
   * would close the deck the reader is building and the pane they were reading it from, to show
   * them a list the pane is already showing under their pointer. `viewPrinting` is what a click
   * on a printings row already does: it moves the pane and deliberately leaves
   * `paneDeckContext` alone, so the swap offers survive.
   *
   * Outside the editor there is no deck to close, and the search wall is a genuinely bigger
   * answer than this 384px column — every printing as art, uncapped, with the filters cleared —
   * so the item keeps the app's default and navigates.
   *
   * **`paneCardId` is the second half of that override and travels with it.** Handing over a way
   * to move the pane is a claim that the row does something, and on this surface it is not always
   * true: the card the pane is *already* on is exactly the card `viewPrinting` cannot move it to.
   * The builder greys the row and says so; this is only the fact it needs, which no other surface
   * can answer for the pane. It is passed unconditionally rather than only inside the editor,
   * because a fact does not stop being true when the row happens to route elsewhere.
   */
  const menuDeps = useMemo<CardMenuDeps>(
    () => ({
      ...deps,
      viewPrintingsInPane: openDeckId === null ? null : viewPrinting,
      paneCardId: cardId,
    }),
    [deps, openDeckId, viewPrinting, cardId],
  );

  /**
   * The open card's own rows — **read from the cache on the press, never observed.**
   *
   * A thunk, like every other surface's: nothing is built until a reader actually right-clicks.
   * What is unusual here is where the card comes from. This component is the pane's *box* and
   * holds no card state by design, so rather than mount a second `card_detail` observer beside
   * the body's, the thunk asks the query cache for the entry the body has already filled. An
   * empty list is the honest answer while the card is still loading, and the primitive treats it
   * as "no menu" — the reader gets the plain suppression instead of an empty box.
   */
  const paneMenu = () => {
    const card = client.getQueryData<CardDetail | null>(
      cardDetailKey(cardId, menuDeps.marketplace.id),
    );
    return card ? buildCardMenu(paneTarget(card), menuDeps) : [];
  };

  return (
    <motion.aside
      {...dialog}
      ref={paneRef}
      tabIndex={-1}
      aria-label="Card details"
      // **The open card's menu, on the pane rather than on the art** — a right-click anywhere in
      // this column that is not a printings row is a right-click on the card the column is
      // about. A row's own handler stops the event, so the innermost surface still wins.
      //
      // **Every other control in the column is included, and that is the intent rather than an
      // oversight** — the close button, the two view toggles, the printings list's `Group by`
      // select. Only a text field is carved out, by `isTextField` inside the primitive, and a
      // `<select>` is not one: WebView2's own menu on a select offers nothing this app cannot,
      // while the whole column consistently answering about the card it is showing is worth
      // more than a handful of dead spots the reader would have to learn.
      //
      // `menuKey` is on the same element and that is the load-bearing half: the pane takes the
      // caret as it opens (see {@link Body}'s mount effect), so with nothing else focused
      // Shift+F10 is a press on this element and on no other. There is no focusable box inside
      // the pane standing for the card, so a wrapper further down would answer the pointer and
      // never the keyboard.
      onContextMenu={menu(paneMenu)}
      onKeyDown={menuKey(paneMenu)}
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
      {/* What a refused **collection or wishlist** add from either of this pane's menus left
          behind, drawn where the deps that made the write live. The menu cannot report its own
          refusals — the panel closes before a row's handler runs — and this pane is the surface
          the reader was on. The deck add is not here and needs nothing: it reaches the app's
          single mount through `CardToDeckProvider`, which draws its own sentence. */}
      <CardMenuRefusal error={menuFailure} />
      <Body key={cardId} cardId={cardId} onClose={onClose} paneRef={paneRef} menuDeps={menuDeps} />
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
  menuDeps,
}: {
  cardId: string;
  onClose: () => void;
  /** The pane's own element, which outlives this body: the scroll reset, the focus on the way
   *  in and the hand-back after a refused swap are all writes to it. */
  paneRef: RefObject<HTMLElement | null>;
  /** Everything a card menu needs that is not the card — the pane's one object, built by
   *  {@link CardDetailPane} and passed through to the printings list. */
  menuDeps: CardMenuDeps;
}) {
  // Which marketplace this pane quotes. Read here, at the one component that owns a card, and
  // then **sent with both reads** — the numbers come back priced, so the pane cannot say
  // TCGplayer at the top and euros halfway down, and it is not choosing between fields either.
  // It is in both query keys below, so switching refetches like every other priced surface.
  const { marketplace } = useMarketplace();
  // How the printings list below is grouped. Read *here* rather than inside `Printings`, which
  // would be the obvious place: this body is keyed on the card, so it is thrown away and rebuilt
  // on every row the reader clicks, and the preference has to survive that. It does, because the
  // answer is a query rather than component state — see {@link usePrintingGroupBy}, where the
  // remount is exactly the case the cache is there for. The hook is called at the same level as
  // `useMarketplace` for the same reason: both are settings the whole pane is drawn under.
  const printingGroupBy = usePrintingGroupBy();
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
  // And **never `<body>`**, which is the state a swap leaves behind: a successful swap re-keys
  // this pane onto the printing it chose, so the row the reader pressed — and the control inside
  // it that held the caret — is unmounted with the body that drew it, and the browser drops
  // focus to `<body>` with no `relatedTarget` at all. (It used to be the *button* that caused
  // this, by disabling itself for the write; that button is gone and the re-key does it on its
  // own, which is why the guard outlived it.) Recording `<body>` as an opener makes the next
  // Escape a hand-back to nowhere — `close` has the answer for that case, and it is a better one
  // than any element this effect could record.
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
  // **The `"inner"` rung is one at a time here, and no z-index or state union enforces it.** The
  // hook would cope if it were not — it keeps a stack of capture-phase registrations and only the
  // token on top acts — but Escape was never the reason these two are exclusive: **two of them
  // open at once means a card image drawn over the finish chips the reader is choosing from**,
  // which is a picture problem and no key press fixes it. What keeps this pane's apart is that
  // each yields to the thing that would open the other:
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

  // The marketplace is in the key because it is in the answer: `card_detail` prices every finish
  // with it, so two marketplaces are two different cards as far as the cache is concerned.
  const card = useQuery({
    // One spelling of this key, shared with the pane's own menu — see {@link cardDetailKey}.
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: () => ipc.cardDetail(cardId, marketplace.id),
  });

  const swapping = swap.isPending;
  const startSwap = swap.mutate;
  const usePrinting = useCallback(
    (toCardId: string) => {
      // One swap at a time, and this is the *second* fence rather than the first: a row that
      // would swap goes `aria-disabled` while any write is in flight and refuses the press in
      // its own handler (see {@link PrintingRow}, and `src/CLAUDE.md` for why it is never the
      // `disabled` attribute). This one covers the press that arrives before that paint, and it
      // is not a double-click guard alone: every row sends the *same* `from` printing, and the
      // write in flight is in the middle of moving it, so a second press would be refused for a
      // row that no longer exists.
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

  // **The caret, one step after a refusal, for the reader it stranded.**
  //
  // A refused swap is usually a deck that has been deleted, and this used to be the common path:
  // the pressed button re-enabled itself and took the caret back, the `onError` re-read landed,
  // `deckGone` turned true, and every "Use this printing" button in the list — including the one
  // holding the caret — was unmounted, dropping it to `<body>` with the refusal still on screen.
  // **A row that stays a row through all of that no longer strands anyone**: the press is now the
  // row's own name button, which is drawn whether the deck is there or not (only its label
  // changes), so nothing the reader was standing on is unmounted by the refusal.
  //
  // It stays because the *guard* is the point, not the path that used to trip it. Anything that
  // replaces the rows while a refusal is on screen — a printings refetch, a card leaving `cards`
  // — lands the caret on `<body>` in front of a sentence nobody can navigate away from except by
  // Tabbing from the top of the app. The pane is where that sentence lives, so the pane takes
  // the caret.
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
    queryKey: ["card", "printings", oracleId, marketplace.id],
    queryFn: () => ipc.cardPrintings(oracleId as string, marketplace.id),
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
          <Facts card={card.data} face={face} marketplace={marketplace} />
          <Legalities card={card.data} />
          <Printings
            card={card.data}
            items={printings.data?.items ?? []}
            total={printings.data?.total ?? 0}
            loading={printings.isPending && oracleId !== null}
            error={printings.isError ? ipcError(printings.error) : null}
            swap={offer}
            marketplace={marketplace}
            menuDeps={menuDeps}
            mode={printingGroupBy.mode}
            onModeChange={printingGroupBy.setMode}
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
 * The finish this printing can be **shown as** on demand, or `null` — which is every printing
 * where the question does not arise.
 *
 * **There is no foil photograph to fetch.** Scryfall publishes one image per printing and it is
 * the plain one; what the toggle turns on is `FoilOverlay` — this app's own sheen and chip, laid
 * over the same art (`CardArt`, where every number in that gradient was chosen at the window).
 * So this is a **view**, offered because a reader choosing between forty printings wants to know
 * what the shiny one looks like, and it says nothing whatever about which finish they own: that
 * question is answered by a collection entry's own `finish` and by nothing on this screen.
 *
 * A printing offers the view only when it exists in a plain finish *and* a shiny one, because
 * those are the two ends the toggle moves between. The two exclusions are deliberate and each
 * is somebody else's job:
 *
 * * a **foil-only** printing already wears the treatment permanently, through
 *   `soleFinish` — that is a statement about what the object *is* (12 366 printings exist only
 *   in foil, and Scryfall's photography of them is byte-identical to a nonfoil one), and
 *   turning it off would un-say a fact;
 * * a **nonfoil-only** printing has nothing to show.
 *
 * `foil` wins over `etched` where a printing has both, because foil is the far commoner of the
 * two and the one a reader means by "what does it look like shiny". Nothing here weakens
 * `soleFinish`, which answers only where there is exactly one non-plain finish and is what the
 * marking on every other card surface in the app is drawn from.
 */
function foilViewFinish(finishesJson: string | null): Finish | null {
  const finishes = parseFinishes(finishesJson);
  if (!finishes.includes("nonfoil")) return null;
  if (finishes.includes("foil")) return "foil";
  if (finishes.includes("etched")) return "etched";
  return null;
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

  /**
   * Whether the reader has asked to see this printing shiny.
   *
   * **Reset by a key rather than by an effect**, and the key is not this component's: `Body` is
   * mounted as `<Body key={cardId}>`, so browsing to another printing throws this whole subtree
   * away and builds a new one with the toggle off. That matters because the answer to "is there
   * a foil to show?" is per printing — a stale `true` carried onto a printing with no foil would
   * be a pressed toggle with nothing under it — and an effect watching `card.id` would paint one
   * frame of the previous printing's sheen over the new card's art before it corrected itself,
   * which is the same reason the face reset in `Body` is a render-time write and not an effect.
   */
  const [foilView, setFoilView] = useState(false);
  const foilable = foilViewFinish(card.finishes);
  // What the overlay is asked for. `soleFinish` is the statement — this printing *is* foil — and
  // the toggle is the only thing that ever adds to it; the two cannot both answer, because
  // `soleFinish` speaks only for a printing with one finish and `foilable` only for one with at
  // least two.
  const marked = foilView && foilable ? foilable : soleFinish(card.finishes);
  const FoilGlyph = foilable === "etched" ? Gem : Sparkles;

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
        <FoilOverlay finish={marked} />
      </span>
      {/* The two ways of looking at the card, on one line under it.
          **A row rather than two stacked bars**, because a double-faced card that also has a
          foil printing would otherwise put 60px of button under a picture the direction doc
          calls the loudest thing on the screen. Each takes half by `flex-1`, which is also what
          keeps a lone flip button the full-width bar it has always been — so the common case is
          unchanged and the pair is the special one. `min-w-0` and a truncating label because
          the flip button names a *card face*, and half of a 352px column is not enough for
          "Hanweir, the Writhing Township". */}
      {(sides === 2 || foilable) && (
        <div className="flex gap-2">
          {sides === 2 && (
            <button
              type="button"
              onClick={onFlip}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md",
                "border border-border py-1.5 text-xs text-dim transition-colors duration-150",
                "hover:text-text motion-reduce:transition-none",
                FOCUS,
              )}
            >
              <FlipHorizontal2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Flip to {other?.name || "the other face"}</span>
            </button>
          )}
          {foilable && (
            <button
              type="button"
              // A **toggle**, so the state is `aria-pressed` and not two buttons swapping places
              // — a reader who tabbed onto it is told both what it does and whether it is on.
              // The visible words change with it as well, because they *are* the accessible name
              // here and a name that no longer contains the visible label is a control voice
              // control can no longer press (WCAG 2.5.3, the rule `DeckStats`' send button set).
              aria-pressed={foilView}
              onClick={() => setFoilView((on) => !on)}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md",
                "border border-border py-1.5 text-xs text-dim transition-colors duration-150",
                "hover:text-text motion-reduce:transition-none",
                "aria-pressed:border-accent/40 aria-pressed:text-text",
                FOCUS,
              )}
            >
              {/* The glyph `FinishMark` draws for this finish, imported straight from lucide
                  rather than through that component — deliberately. `FinishMark` is a
                  `role="img"` carrying the finish as its accessible name, and a labelled image
                  inside a button *joins* the button's name: this control would be called
                  "Foil View as foil". It is the trap `FoilOverlay` documents from the wall's
                  tiles, one surface over. The two glyphs stay the same two so the button and the
                  finish marks on the printings rows below agree about what foil looks like. */}
              <FoilGlyph className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {foilView
                  ? `View as ${FINISH_LABEL.nonfoil.toLowerCase()}`
                  : `View as ${FINISH_LABEL[foilable].toLowerCase()}`}
              </span>
            </button>
          )}
        </div>
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
function Facts({
  card,
  face,
  marketplace,
}: {
  card: CardDetail;
  face: number;
  marketplace: Marketplace;
}) {
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
            {/* Priced by the backend at the marketplace this pane asked for, and **never
                across marketplaces**: an unpriced finish arrives as `null` and reads "—".
                The holes are real and differ per marketplace — `eur_etched` is not a key
                Scryfall has, so Etched on Cardmarket is always an em dash, and a printing a
                bulk feed has never listed is one there. Another marketplace's number is a
                different quote, and printing it here would invent one. */}
            {finishes.map((f) => (
              <div key={f} className="flex items-baseline gap-1.5">
                <dt className="text-dim">{FINISH_LABEL[f]}</dt>
                <dd className="font-mono tabular-nums">
                  {formatPrice(card.finishPrices[f], marketplace.currency)}
                </dd>
              </div>
            ))}
          </dl>
          {/* Spec §5: a price is never shown without saying how old it is — and, now that
              there is more than one answer, whose it is. `pricesAsOf` says which of the two
              clocks this marketplace runs on: the card-data sync for the blob-backed pair, the
              last price-feed refresh for the two this app downloads. */}
          <p className="text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
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
 * Every printing of this card, grouped the way the reader asked for.
 *
 * **Artist is still the default**, and for the reason grouping existed at all: "which art is
 * this?" is the question a printings list is asked, and a group whose heading is an
 * *illustrator* is a name the reader can check against the card — where "Artwork 2" would be a
 * number invented here. What changed is that it is no longer the only answer. A reader hunting
 * the cheapest copy, or the one from a set they remember, was reading a list ordered by a fact
 * they were not asking about, and the ordering rules for all four modes are `printings.ts`'s —
 * this component draws groups and does not decide them.
 *
 * `price` is deliberately a mode with **no groups**: a cheapest-first list has nothing to head
 * its runs with that is not a price already printed on the row, so it renders flat and the
 * summary line below drops its second half rather than counting something invisible.
 *
 * It is also the fastest way in the app to record "I have the Alpha one": every row adds
 * its own printing, which is why the whole card is passed rather than only its id — a wish
 * and an entry both need the name and the oracle id, and neither is on a `Printing`.
 *
 * And, when the card was opened from a deck row, the fastest way to *change* which printing a
 * deck is built from: see {@link SwapOffer} and {@link PrintingRow}.
 */
function Printings({
  card,
  items,
  total,
  loading,
  error,
  swap,
  marketplace,
  menuDeps,
  mode,
  onModeChange,
}: {
  card: CardDetail;
  items: Printing[];
  total: number;
  loading: boolean;
  error: string | null;
  swap: SwapOffer | null;
  /** Which marketplace each row's per-finish prices are quoted from. */
  marketplace: Marketplace;
  /** Everything a card menu needs that is not the card — the pane's one object. */
  menuDeps: CardMenuDeps;
  /** How the list is grouped. Owned one component up, because it outlives this card — see
   *  {@link usePrintingGroupBy}. */
  mode: PrintingGroupBy;
  onModeChange: (mode: PrintingGroupBy) => void;
}) {
  const headingId = useId();
  /**
   * One `useContextMenu` for the whole list, and one pair of handlers built per row.
   *
   * The **items** are a thunk inside `menu`, so a four-hundred-row list pays for nothing until a
   * reader right-clicks one of them; what is built per render is two closures, which is what the
   * rows already cost. Built here rather than in the row because `card` is what the row adapter
   * has to read alongside its printing — see {@link printingTarget}.
   */
  const { menu, menuKey } = useContextMenu();
  const rowMenu = (p: Printing): MenuHandlers => {
    const build = () => buildCardMenu(printingTarget(p, card), menuDeps);
    return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
  };
  // One dwell timer for the whole list — see {@link usePrintingDwell} for why it cannot be one
  // per row. Called before the early return below, because a hook is.
  const dwell = usePrintingDwell();
  const dropPreview = dwell.cancel;
  // Sorted and bucketed on every render of a pane that re-renders on every hover in this list
  // (the dwell is state), over up to 400 rows — so it is memoised on exactly the two things it
  // reads. Both hooks sit above the early return, because hooks do.
  const groups = useMemo(() => buildPrintingGroups(items, mode), [items, mode]);
  // A refetch that replaces the rows takes any picture with it. The preview is measured against
  // the row it hangs off, and a row that has left the document measures 0×0 — an invisible
  // layer, at the top of the pane, that Escape still has to be spent on. Nothing tells a hover
  // that its element was unmounted, so the list says so: this is the only place that knows the
  // rows changed. (`items` keeps its identity across a refetch that changed nothing — query
  // structural sharing — so this is not an effect that runs on every render.)
  //
  // **`mode` is in here for the same reason one step further on.** A new mode leaves every row
  // mounted and moves them: the element the picture is measured against is still in the
  // document, still the right size, and now under a *different* printing than the pointer that
  // asked for it was resting on. A preview that survived the re-order would be a picture of one
  // card hanging off another's row — worse than the detached case, because it looks correct.
  useEffect(() => {
    dropPreview();
  }, [items, mode, dropPreview]);
  // A card with no `oracleId` never asked for printings, so it has no list to fail at
  // loading: nothing to say, and no empty section to say it in. (Nor does a card whose
  // printings all left `cards` — same shape, same silence.)
  if (!loading && !error && items.length === 0) return null;

  // What the groups *are*, in this mode's own word — `null` in `price`, which makes none.
  const noun = PRINTING_GROUP_BY_OPTIONS.find((option) => option.value === mode)?.noun ?? null;
  return (
    // The rule separates "this card" from "every card like it", which is the pane's one
    // real division. Set in the same hairline as the credit line below it rather than a
    // heavier rule: three sections, two hairlines, no boxes. The heading is rendered while
    // the list is still loading so the pane does not reflow around it when it arrives.
    <section aria-labelledby={headingId} className="space-y-2 border-t border-border pt-3">
      {/* The heading and the control that reorders what it names, on one line — 32px of select
          against a 12px heading, so the row is the select's height and the words sit in it.
          `min-w-0 truncate` on the heading is the fence this pane needs everywhere: at 384px
          wide there is no width to give back, so the fixed thing is the control and the elastic
          one is the word. */}
      <div className="flex items-center gap-2">
        <h3
          id={headingId}
          className="min-w-0 flex-1 truncate text-xs uppercase tracking-wide text-dim"
        >
          Printings
        </h3>
        <select
          // **Labelled for a screen reader alone.** Every other `Group by` in the app carries a
          // visible `<label>` beside it (the deck editor's toolbar, two inches away, is the one
          // this control is copied from) — but that toolbar has a whole window's width and this
          // pane has 352px of content column already spent on the heading. The words would come
          // out of the only other thing on the line. The name says what it groups, not just
          // "Group by", because a reader listing this pane's controls hears it next to the
          // marketplace and the deck's own grouping.
          aria-label="Group printings by"
          value={mode}
          onChange={(event) => {
            // The same predicate that narrows the stored row narrows the event, so there is no
            // cast here and no second idea of what a mode is. A `<select>` cannot emit anything
            // else, which is exactly why this costs nothing to be right about.
            const chosen = event.target.value;
            if (isPrintingGroupBy(chosen)) onModeChange(chosen);
          }}
          className={cn(CONTROL, FOCUS, "shrink-0 text-text")}
        >
          {PRINTING_GROUP_BY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {loading && <p className="text-xs text-dim">Loading printings…</p>}
      {error && (
        <p className="text-xs text-destructive">
          Could not read the other printings — {error}. The card above is unaffected.
        </p>
      )}
      {/* A count line, so it is set in the data face. `items.length` is capped at 400 and
          `total` is not — saying only the first would report a Forest as having 400
          printings when it has 862.

          **The second half follows the mode**, because it is a gloss on the grouping the reader
          is looking at: "5 artists" under Artist, "3 release dates" under Released, "4 sets"
          under Set. It is dropped whole in `price` mode rather than reworded — there is one
          group there and it has no heading, so "1 price" would be a count of a thing that is
          not on screen. */}
      {items.length > 0 && (
        <p className="font-mono text-[0.7rem] tabular-nums text-dim">
          {items.length < total
            ? `${items.length} of ${total} printings`
            : `${total} printing${total === 1 ? "" : "s"}`}
          {noun && (
            <>
              {" · "}
              {groups.length} {groups.length === 1 ? noun.one : noun.many}
            </>
          )}
        </p>
      )}
      {groups.map((group) => (
        // The key is the group's own — `printings.ts` makes it, because only the thing that
        // decided what a group *is* can say what tells two of them apart (an illustration id, a
        // date, a set code, or the one bucket a flat list has).
        <div key={group.key} className="space-y-0.5">
          {/* No heading element at all when there is none — not an empty one, and not a
              placeholder word. A flat list with a blank line above it would read as a group
              whose name failed to load. */}
          {group.heading !== null && (
            <p className="flex items-baseline gap-1.5 pt-1 text-[0.7rem] text-dim">
              <span className="min-w-0 truncate">{group.heading}</span>
              <span className="font-mono tabular-nums">· {group.printings.length}</span>
            </p>
          )}
          <ul className="space-y-0.5">
            {group.printings.map((p) => (
              <PrintingRow
                key={p.id}
                printing={p}
                card={card}
                current={p.id === card.id}
                swap={swap}
                marketplace={marketplace}
                menu={rowMenu(p)}
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

/**
 * One printing, and what pressing it means.
 *
 * ## In a deck, the row *is* the swap
 *
 * A pane opened from a deck row used to draw a second line under every printing carrying a "Use
 * this printing" button (`DeckLine`, deleted with this change). Its argument was width: the pane
 * is 384px, the facts line already spends it on rarity, set, number, year, language, a price per
 * finish and the quick-add, and a button on that line would have taken its space out of the set
 * name — which is what the reader is choosing a printing *by*. That was a good argument for a
 * button and it is not an argument for a button existing: the row itself is 352px wide, already
 * clickable and already the thing the reader is pointing at. So the click is the swap.
 *
 * **What it costs, stated plainly: in a deck context there is no longer any way to look at a
 * printing in the pane without committing to it.** Clicking a row rewrites the deck slot, and
 * the write follows into the printing it chose (`usePrinting` re-opens the pane on it), so
 * "let me see this one first" is gone from this list for as long as the pane has a deck row
 * behind it. That is the deliberate trade. It is bearable because the two are almost always the
 * same act — a list opened *from* a deck row is being read in order to pick one (spec §2) — and
 * because the reader can still see any printing without committing by hovering it, which is what
 * {@link usePrintingDwell}'s picture is for, and can undo a swap by pressing the row they came
 * from.
 *
 * Six behaviours had to survive the button's deletion, and each one has its own note below: the
 * deck's own printing still says so, a refusal still lands beside the row that was refused, an
 * in-flight write still makes every other row inert, the accessible name still says what the
 * press does, the drag still starts from the row, and the quick-add still owns its own press.
 */
function PrintingRow({
  printing,
  card,
  current,
  swap,
  marketplace,
  menu,
  dwell,
}: {
  printing: Printing;
  card: CardDetail;
  current: boolean;
  swap: SwapOffer | null;
  /** Which marketplace this row's per-finish prices are quoted from. */
  marketplace: Marketplace;
  /** This row's right-click and its keyboard twin, built by {@link Printings} from the printing
   *  **and** the card — see {@link printingTarget}. */
  menu: MenuHandlers;
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
  // The type line is the **card's**, not this row's, and a `Printing` carries none anyway: it
  // is what `autoCategoryFor` files by when the row is carried somewhere with no column to
  // point at, and which pile a card belongs in is a fact about the card rather than about which
  // piece of cardboard it was picked up from.
  const printingId = printing.id;
  const cardName = card.name;
  const cardTypeLine = card.typeLine;
  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    return cardDraggable({
      element,
      payload: () => ({ kind: "card", cardId: printingId, name: cardName, typeLine: cardTypeLine }),
    });
  }, [printingId, cardName, cardTypeLine]);

  /**
   * The printing this deck already holds in the slot the pane was opened on.
   *
   * `gone` is in here as well as in {@link swaps}, and `DeckLine` had it in exactly the same
   * two places: **a deck that has been deleted offers nothing and claims nothing.** "This deck
   * uses this printing" is not true of a deck that is not there, and forty rows offering to
   * rewrite it are forty wrong offers whose only way of finding out is to be pressed. What
   * survives a deletion is the refusal that usually *taught* the pane about it, which is why
   * `gone` does not take the whole offer down with it (see {@link SwapOffer}).
   */
  const heldByDeck = swap !== null && !swap.gone && swap.row.cardId === printing.id;
  /** Whether a press here rewrites the deck slot. */
  const swaps = swap !== null && !swap.gone && !heldByDeck;
  /** A swap — any swap, on any row — is in flight. */
  const busy = swap !== null && swap.pendingId !== null;
  /** …and it is this row's. */
  const pending = swap !== null && swap.pendingId === printing.id;
  const refused = swap?.refused?.printingId === printing.id ? swap.refused.reason : null;
  /**
   * Out of reach while a write runs. Every row that would swap, not only the pressed one: they
   * all send the same `from` printing and the write in flight is in the middle of moving it.
   *
   * **`aria-disabled` and a guard, never the `disabled` attribute** (`src/CLAUDE.md`) — and here
   * that rule pays for itself twice over rather than merely being obeyed. `DeckLine`'s button
   * *was* `disabled`, so pressing it dropped it out of the tab order mid-press and the browser
   * blurred it to `<body>` with no `relatedTarget`; the whole of `DeckLine`'s focus hand-back
   * effect existed to put the caret back afterwards. A control that never leaves the tab order
   * needs no such repair, so that effect is **deleted with the button rather than carried over**:
   * there is nothing left for it to fix.
   */
  const inert = swaps && busy;

  /**
   * What a press on this row does — one function, because the row and the button inside it are
   * two ways into one destination and always have been (the button has no handler of its own;
   * its click bubbles here).
   */
  const press = () => {
    if (swap && swaps) {
      // The paint says so and this says so again: a press that lands between the state and the
      // frame must not queue a second write. `usePrinting` has the third fence.
      if (busy) return;
      // Swap **and follow**: `usePrinting`'s `onSuccess` re-opens the pane on the printing the
      // deck now holds, so calling `viewPrinting` as well would be two navigations for one
      // press — the second of them to a card the first has already moved past.
      swap.onUse(printing.id);
      return;
    }
    if (!current) viewPrinting(printing.id);
  };

  return (
    <li
      ref={rowRef}
      // **Focusable because it is a menu opener, and for no other reason.**
      //
      // `menu()` hands the element the press landed on to the panel, and the panel calls
      // `opener?.focus()` on Escape and before every row it runs — so an opener that cannot take
      // focus silently gets none: the caret stays on the panel and drops to `<body>` when it
      // unmounts, and the next Tab restarts from the top of the app. `focus()` on an `<li>` with
      // no `tabIndex` is exactly that no-op.
      //
      // `-1` and never `0`: this adds no tab stop. The row's keyboard handle is still the
      // set-code button inside it, and Tab reaches that; this only makes the row a place the
      // caret can be *put*. It is the same value, for the same reason, that the pane itself
      // carries.
      //
      // The dwell's `onFocus` therefore fires when a dismissed menu hands the caret back, and a
      // preview opens a quarter second later — which is the behaviour a caret arriving on this
      // row already had, since the set-code button's own focus bubbles to this same handler.
      tabIndex={-1}
      {...dwell}
      // The mouse's way into the printing: a click anywhere on the row that is not one of its
      // own controls does whatever this row does — show it, or put it in the deck. The
      // keyboard's way in is the set-code button below. The split is the reason: a
      // `role="button"` on the row would make the controls inside it presentational.
      onClick={press}
      // …and the right-click is the **whole row**, for the same reason the click is: the reader
      // is pointing at a printing, not at the four-character set code inside it. It cannot be
      // the press — a `contextmenu` is not a `click`, so nothing here navigates — and the
      // handler stops the event, so the pane's own menu (about the card this is a printing of)
      // does not replace these rows with the card's.
      onContextMenu={menu.onContextMenu}
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
            // The row's keyboard handle. The click bubbles to the row, which does the same
            // thing — one destination, two ways in — so **the name has to change with what
            // that thing is**. In a deck context the press rewrites a deck; a button still
            // called "Show SLD · 913" would be describing the version of this list that had a
            // separate button, and a reader who could not see the row would find out what it
            // really did by pressing it.
            //
            // The swapping register is `DeckLine`'s, kept word for word: forty rows, one
            // sentence, and the set with the collector number is what tells them apart — plus
            // the category, because the same printing can sit in the main deck and the
            // sideboard and the slot being rewritten is the one the pane was opened on. That
            // name is the context's own rather than a lookup: the pane is a sibling of the deck
            // editor and has no category list to translate an id through (`PaneDeckContext`).
            // A row moved to another category under an open pane, or a rename of the category,
            // makes that word stale and *only* that word — the write is addressed by the same
            // slot, finds no row in the category it names, and is refused beside this row. The
            // label lies for one press; the deck does not change.
            //
            // "Swapping…" while this row's write is in flight, for the reason the button said
            // it: the visible text cannot say it (the row's visible text is the printing), so
            // the name is the only place a screen reader hears that the press landed.
            aria-label={
              swap && swaps
                ? `${pending ? "Swapping…" : "Use this printing"} (${printing.setCode.toUpperCase()} ${printing.collectorNumber}) in ${swap.row.categoryName}`
                : `Show ${printing.setCode.toUpperCase()} · ${printing.collectorNumber}`
            }
            // **The keyboard's door to this row's menu, on the row's own handle** — the one
            // focusable element a printings row has, so it is the only element Shift+F10 or the
            // ContextMenu key can land on. It is `onKeyDown` and nothing else here, so Enter and
            // Space still press the row: the menu is **composed with** what the handle already
            // does rather than put in its place, which would buy a menu with the affordance it
            // was added beside. `menuKey` stops the event when it opens, so the pane's own
            // handler above does not answer with the card's menu on top of it.
            //
            // The row for the printing the pane is **showing** draws a `<span>` rather than this
            // button, so it has no keyboard route of its own — and needs none: it is the card
            // the pane's own menu is about, one press of the same keys away.
            onKeyDown={menu.onKeyDown}
            // Greyed and refused, never removed from the tab order — see {@link inert}.
            aria-disabled={inert}
            title={printing.setName ?? undefined}
            className={cn(
              "min-w-0 flex-1 truncate text-left font-mono aria-disabled:opacity-50",
              FOCUS,
            )}
          >
            {printing.setCode.toUpperCase()} · {printing.collectorNumber}
            {printing.releasedAt && <> · {printing.releasedAt.slice(0, 4)}</>}
          </button>
        )}
        {/* **The mark `DeckLine` used to say in words** ("This deck uses this printing"), in the
            width a row has for it. A badge in the language the row already speaks — the same
            border, padding and size as the language badge beside it — and **text, not colour**:
            the row's other mark is the gold hairline for `current`, which says "this is the
            printing the pane is showing" and is a different fact entirely. A reader who cannot
            tell gold from grey still reads the word, and a reader who can still has two distinct
            channels for two distinct states, which a second coloured edge would have collapsed.
            Static, because it is a fact about the deck rather than a control — dressing it as a
            button that cannot be pressed would be worse than saying it. */}
        {heldByDeck && (
          <span className="shrink-0 rounded border border-border px-1 text-[0.65rem] leading-4 text-dim">
            In deck
          </span>
        )}
        {printing.lang !== "en" && <LangBadge lang={printing.lang} />}
        {/* Per finish, priced at the marketplace the list was read at — never one number
            standing for both, and never another marketplace's. */}
        {parseFinishes(printing.finishes).map((f) => (
          <span key={f} className="flex shrink-0 items-center gap-0.5 font-mono tabular-nums">
            {/* A glyph rather than the letters `F` and `E` this used to draw. Nonfoil is
                still unmarked — it is the finish a price is assumed to be — and the full
                word rides in the accessible name, as the `<abbr>`'s title did. */}
            <FinishMark finish={f} />
            {formatPrice(printing.finishPrices[f], marketplace.currency)}
          </span>
        ))}
        {/* This row's printing, not the pane's card: the set and the collector number are the
            row's own, and so are the finishes it may be owned in. The wrapper stops the row's
            own click — and **that mark is worth more now than it was**: the press underneath
            used to navigate the pane, and it writes to a deck, so a quick-add whose click
            escaped would put a card in a deck the reader never pointed at. The button marks
            itself `data-no-drag`, which is the other half and is its own fact rather than this
            call site's (`dnd.ts`). */}
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

      {/* **The refusal, beside the row that was refused** — the one thing that tells a reader
          why nothing happened, and the reason `swap.gone` does not take the whole offer down
          with it: a press against a deleted deck is answered GONE, the re-read comes back empty,
          and this sentence is the only thing on screen explaining why forty rows have quietly
          stopped being offers.

          Where `DeckLine` put it, in the words `DeckLine` used, for the reason `DeckLine` gave:
          the reader is looking at this row, and a banner at the top of the pane would be one
          sentence for forty rows with nothing on screen saying which. `pt-0.5` and not a pixel
          more — the row's own padding is what separates one printing from the next (4px + 4px +
          the list's 2px), so a line hung further off its own facts than that reads as belonging
          to the row below. Measured in the running window at 1280 × 800 against a 62-printing
          list.

          **Nothing stops the click here any more, and that is the change rather than an
          oversight.** `DeckLine` wrapped its line in a `stopPropagation` because the row
          underneath meant *view this printing*, which is not what a reader pressing "Use this
          printing" asked for. The row now means the same thing the refused press meant, so a
          click that lands on the sentence is a retry — which, for a `BUSY` the reader has just
          read, is exactly the next thing they want. */}
      {refused && (
        <p role="alert" className="pt-0.5 text-[0.7rem] leading-tight text-destructive">
          Could not use this printing — {refused}
        </p>
      )}
    </li>
  );
}

// `DeckLine` stood here: the second line under every printings row that carried "Use this
// printing", the deck's own mark and the refusal. All three survive — on the row itself, in
// {@link PrintingRow}, which is where its doc comment's reasoning and its replacement now live.
// Its focus hand-back effect did **not** survive, and deliberately: it existed only to repair
// what its own `disabled` button broke, and an `aria-disabled` row never leaves the tab order
// for it to repair.
