/**
 * The card detail modal — the host that assembles the three columns, the header, the action row
 * and the step chevrons into one `Dialog`.
 *
 * **Mounted once, for the life of the app, and opened by a store field.** `selectedCardId` is the
 * flag; every surface that opens a card already writes it, and this is the only thing that draws
 * one. That is what replaces three mounts of the docked pane with one modal, and it is why
 * nothing here takes a card as a prop.
 *
 * ## The four rungs, and where each one is measured
 *
 * Spec §2.1 folds the *panel* at 640 / 900 / 1200, measured on `@container/card` — which
 * `Dialog`'s `container` prop puts on the panel. Everything inside this file queries that
 * container; the **panel's own size** cannot, and that is {@link PANEL_SIZE}'s whole paragraph.
 *
 * ## What it does not do, and each is a decision rather than an omission
 *
 * * **No printing *swap*.** A card opened out of a deck row could be re-pointed at another
 *   printing from the pane's printings list. The modal's printing picker calls `viewPrinting`,
 *   which browses; `AllPrintingsDialog` is where a swap still lives.
 *
 * ## The three things this host owns *for* `CardModalArt`, and why each is here
 *
 * That column is presentational — no store, no query — so three facts it draws have to arrive as
 * props, and all three were lost for a wave when the docked pane was deleted:
 *
 * * **The foil seed.** `paneFinish` is what a collection tile and the deck editor's search panel
 *   write when the copy a reader pressed *is* a foil; without it a foil tile opened plain. Read
 *   here, handed over as `openedAs`.
 * * **The meld relations**, from `ipc.cardMeldParts` — a query, so it cannot live in that file.
 * * **Which counterpart's picture is up** ({@link Body}'s `melded`), which has to be *here*
 *   rather than in the column that draws the picture, because the panel's artist credit names the
 *   illustrator whose art is on screen and that credit is drawn down in the action row. See
 *   {@link artistOf}.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { ManaText } from "@/components/ManaText";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { Dialog, type DialogFlanks } from "@/components/Dialog";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { sameDeckSlot } from "@/features/decks/deckWalk";
import { LabelSwatch } from "@/features/decks/LabelColorPicker";
import type { DropdownOption } from "@/components/Dropdown/types";
import { soleFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type CardDetail,
  type DeckFinish,
  type LabelColor,
  type MeldRelation,
} from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { useAppStore, type CardWalkStop } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { useOptionalAddCardToDeck } from "./cardMenu";
import { cardDetailKey } from "./cardDetailKey";
import { CardModalArt } from "./CardModalArt";
import { CardModalControls } from "./CardModalControls";
import { CardModalRail, type RailAction, type RailCounts } from "./CardModalRail";
import { useCardModalScope, type CardModalScope } from "./cardModalScope";
import { StepChevron } from "./StepChevron";
import { useCardMenuDeps } from "./useCardMenuDeps";

/**
 * The panel's size per rung — **viewport queries, at the one site in this feature where that is
 * the right question.**
 *
 * ## Why this cannot be a container query
 *
 * `Dialog`'s `container` prop puts `@container/card` on **this same element**. A container query
 * is a question a descendant asks about its container's size, so `@min-[640px]/card:w-…` written
 * here would be the panel asking about its own width in order to decide its own width — circular,
 * and it resolves to nothing. Every other fold in this file is inside the panel and is therefore
 * a legitimate container query; this one is not, and no amount of spelling fixes that.
 *
 * The alternative Task 10 offered — declare the container on a wrapper *outside* the panel — was
 * refused: `Dialog` owns the panel and its header, both fold on the same measurement, and a
 * container declared outside the panel would be measuring the scrim's whole grid area rather than
 * the panel. That is the window with extra steps.
 *
 * ## Why the window is the honest subject here
 *
 * `src/lib/viewports.ts` demands a reason at the site of any viewport branch, and spec §2.3
 * already licensed one for the scrim: the scrim is `fixed inset-0`, so it **is** the window, and
 * how big a panel to ask for out of that glass is a question about the glass. All three folds are
 * spelled out whole — Tailwind scans source text for whole class names and an interpolated one
 * emits no rule at all — and all three are `min-[…]`, which is not a style choice; see
 * {@link PANEL_SIZE}. 640 is the same fold `Dialog`'s own `p-0 sm:p-6` uses, spelled the other
 * way because that file has no arbitrary variant on padding to be out-ordered by.
 *
 * ## The two clamps are what keep the inside honest
 *
 * These are *requests*. `Dialog`'s panel carries `max-w-full` and `max-h-full`, so at a 900px
 * window the 1060px asked for here is clamped to whatever the scrim's column leaves — and the
 * container queries inside then measure that **real** width. So the columns fold on the panel
 * they are actually in rather than on the size it asked to be, which is exactly the property
 * spec §2.1 wanted and the reason mixing the two mechanisms is safe rather than merely tolerable.
 *
 * ## `cn` is `twMerge`, so this string was checked
 *
 * Six classes, three widths and three heights, every one at a **different** variant (`w-full`,
 * `min-[640px]:`, `min-[900px]:`, `min-[1200px]:`). Two widths at one variant would silently
 * collapse to the last; these do not. Note that `twMerge` was never the failure here — it kept
 * all four widths, and the CSS cascade then picked the wrong one. See {@link PANEL_SIZE}.
 */
/**
 * **Every rung is an arbitrary `min-[…]` variant, and mixing in a named one silently breaks all
 * of them.** Measured in the shipped window on 2026-09-03: with `sm:` spelling the 640 rung, the
 * panel drew **764px at a 2560px viewport** — the 900 and 1200 rungs never applied at any width.
 *
 * Tailwind v4 emits arbitrary `min-[…]` variants as one group, correctly sorted ascending, and
 * named breakpoints (`sm:`, `lg:`) as a **later** group. So at 2560px all three media queries
 * matched and the last one in source order won, which was `sm:`. The positions in the emitted
 * sheet: the `(width >= 900px)` block at 84141, `(width >= 1200px)` at 84306, and
 * `width: 47.75rem` at **84628** — after both.
 *
 * **No suite here can see it.** jsdom has no layout engine, so a test asserting these classes are
 * present passes either way; all four were, and one of them always won. The rule is therefore not
 * "prefer arbitrary variants" but **"never mix the two families on one property"** — a named
 * variant added to this string later re-breaks it exactly as invisibly.
 */
/**
 * **The heights are floors rather than sizes, and the artboard numbers are what they floor at.**
 *
 * They were fixed heights until 2026-09-03, which is a decision about the *panel* being made in a
 * file that cannot see the content: measured live at 2560×1392, the 1200 rung's `h-[50rem]` sat
 * the panel at y=296 with **~590px of window unused**, while the art column wanted 666px against
 * the 614px the panel left it — 52px of overflow, drawn as a scrollbar down the picture. A card
 * is the one thing in this app a reader opens *to look at*, so a tall monitor spending its height
 * on glass and then clipping the card is the arrangement backwards.
 *
 * So: `h-auto` from the 640 rung up, with the rung's own number as a `min-h`. On a tall window
 * the panel grows to whatever the columns need and the art column stops scrolling; on a short one
 * it is `Dialog`'s `max-h-full` that decides, exactly as before.
 *
 * **`min(…, 100%)` and never a bare `min-h`, and this is the trap rather than a flourish.** CSS
 * resolves `min-height` **after** `max-height`, so a bare `min-h-[50rem]` beats `max-h-full`: at a
 * 700px window the panel would draw 800px, centred, with its action row off the bottom of the
 * glass where neither pointer nor wheel reaches it — which is the exact failure `src/CLAUDE.md`
 * makes a rule of and `Dialog` documents at its own site. `100%` is the grid area the scrim's
 * `grid-rows-[minmax(0,1fr)]` bounds, so the floor can never ask for more window than there is.
 *
 * **The other half is `flex-auto` on the two boxes below**, and neither works without the other:
 * a `flex-1` child is `flex-basis: 0%`, so in an auto-height column it contributes *nothing* to
 * its parent's content height and the panel would sit at its floor at every window size — the fix
 * present, and the measurement unchanged. See {@link Body}'s two `flex-auto`s.
 */
const PANEL_SIZE =
  "w-full h-full " +
  "min-[640px]:w-[47.75rem] min-[640px]:h-auto min-[640px]:min-h-[min(52.5rem,100%)] " +
  "min-[900px]:w-[66.25rem] min-[900px]:min-h-[min(47.5rem,100%)] " +
  "min-[1200px]:w-[77.5rem] min-[1200px]:min-h-[min(50rem,100%)]";

/**
 * Whether the window has room for `Dialog`'s flank columns — spec §2.1's "chevrons as flanks at
 * `@[900px]/card` and above, the action row's left corner below that".
 *
 * **A viewport query and not a container one, and it is forced rather than chosen.** The flanks
 * are drawn in two columns the **scrim** reserves (`Dialog`'s `FLANK_COLUMNS`), and the scrim is
 * `fixed inset-0` — there is no container to ask, and `flanks` is a prop rather than a class, so
 * the decision has to be made in JavaScript before the panel exists. It is the same subject
 * {@link PANEL_SIZE} argues for one paragraph up: how much glass is either side of the panel.
 *
 * **Passing `flanks` unconditionally would be wrong at the phone rung, not merely wasteful.** The
 * scrim's columns are 3.5rem each, and at 390px that is 112px taken off a panel spec §2.1 draws
 * full-bleed. The chevrons would also be *outside* the window, which is the failure
 * `DialogProps.flanks` documents at its own site.
 *
 * `useSyncExternalStore` and a fresh `matchMedia` per read, which is `useNarrowWindow`'s shape
 * and for its two reasons: `src/CLAUDE.md` forbids `setState` inside an effect, and a
 * module-level `MediaQueryList` would be built against whatever `matchMedia` was at import time —
 * which under jsdom is before any test has stated a width.
 */
const FLANK_ROOM = "(min-width: 900px)";

function subscribeFlankRoom(onChange: () => void): () => void {
  const query = window.matchMedia(FLANK_ROOM);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function hasFlankRoom(): boolean {
  return window.matchMedia(FLANK_ROOM).matches;
}

function useFlankRoom(): boolean {
  return useSyncExternalStore(subscribeFlankRoom, hasFlankRoom);
}

/**
 * Who drew the side on screen, falling back to the card's own credit.
 *
 * **Lifted verbatim from `CardDetailPane`** rather than rewritten, because that file was deleted
 * with the dock on 2026-09-03 and this is the one piece of it the credit depends on. `melded`
 * wins outright
 * rather than falling back to the open card: while a melded card's picture is up, the open card's
 * illustrator is not the one being credited, and a fallback that reached for it would print a
 * name that is wrong rather than missing.
 *
 * **The `melded` argument is wired, and that is a licence condition rather than a nicety.** The
 * two halves of a meld are not always the same artist — which is the whole reason `MeldRelation`
 * carries one at all — so while the melded card's picture is up, the open card's illustrator is
 * the *wrong* name under the right art, and Scryfall's usage rules require the artist to be
 * identifiable wherever the art is shown. It was passed a literal `null` for the wave the meld
 * control was missing; `null` — a relation whose printing has left `cards` — still draws no
 * credit, which is the honest answer for a frame that is also drawing no picture.
 */
function artistOf(card: CardDetail, face: number, melded: MeldRelation | null): string | null {
  if (melded !== null) return melded.artist;
  return card.faces[face]?.artist ?? card.artist;
}

/**
 * An action-row button. 44px below `@min-[900px]/card` and the app's own 36px above it, which is
 * the fold `CardModalControls` draws its own controls at — the two rows sit under one another and
 * a row that changed height on a different measurement would read as a mistake.
 */
const ACTION =
  "flex h-11 min-w-0 items-center justify-center rounded-md border border-border px-4 " +
  "text-sm text-dim transition-colors duration-[var(--duration-fast)] ease-standard " +
  "hover:text-text motion-reduce:transition-none @min-[900px]/card:h-9";

/**
 * The gold one. `border-accent text-accent` filling on hover is this app's primary button
 * wherever a dialog has one (`CreateDeckDialog`'s **Create deck**), rather than a solid fill
 * invented here.
 */
const ACTION_PRIMARY =
  "flex h-11 min-w-0 items-center justify-center rounded-md border border-accent px-4 " +
  "text-sm text-accent transition-colors duration-[var(--duration-fast)] ease-standard " +
  "hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none " +
  "@min-[900px]/card:h-9";

/** The condition a one-press add records — `useCardMenuDeps`' `MENU_CONDITION`, and for its
 *  reason: something has to choose, an unmarked card is assumed NM everywhere else in this app,
 *  and the quick-add popup is still there for a played copy. */
const MODAL_CONDITION = "NM" as const;

/**
 * The **In your grimoire** figures, under `["card", …]` beside this file's other two card reads.
 *
 * **`["card"]` and not one of the three roots the answer is derived from, because no key can be
 * under all three.** `invalidateQueries` matches by key *prefix*, so a key rooted at
 * `["collection"]` is refreshed by a collection write and missed by a wish; one rooted at
 * `["decks"]` is missed by both. The old block sidestepped this by being **three** queries, one
 * under each root — that is what it cost to have the app's existing invalidation vocabulary
 * reach it, and folding them into one read gives the property up. {@link useHoldingsFreshness}
 * is what replaces it.
 *
 * The bare prefix is what a caller invalidates: only one oracle card is ever mounted here, and a
 * key naming the card would have to be rebuilt at every site that settles a write.
 */
const HOLDINGS_KEY = ["card", "holdings"] as const;

/**
 * Refetch the grimoire figures whenever **any** write in the app has finished.
 *
 * **This is the price of one read replacing three, and it is a mechanism rather than a
 * belt-and-braces.** Every writer that can move these three numbers settles its own roots and
 * only its own: `useCardMenuDeps`' collection add fires all four of `query.ts`'s
 * `OWNED_WRITE_KEYS`, its wishlist add fires `["wishlist"]` and `["cards", "search"]`,
 * `AllPrintingsDialog`'s wish fires the same pair, and an ordinary deck write fires `["decks"]`
 * alone. {@link HOLDINGS_KEY} can sit under exactly one of those, so a key chosen for any one
 * writer is a figure that silently stops moving for the others — and `query.ts`'s 30 s
 * `staleTime` is what turns that into *a wrong number on screen* rather than a slow one.
 *
 * **The falling edge of `useIsMutating` is the one signal that catches all of them**, including
 * the three presses this file makes through callbacks it cannot chain: the action row's two adds
 * go through `CardMenuDeps`, whose `mutate` returns `void`, and `Add to deck` reaches the app's
 * single `useCardToDeck` through a context that returns `void` too. A mutation's own `onSuccess`
 * has already run by the time its status leaves `pending`, so by the falling edge every root the
 * writer meant to settle is settled and the backend row is committed — this read is the last one
 * to be asked and gets the written answer.
 *
 * What it costs is **one extra read per press, and only while a card is open** — the modal is the
 * only thing that mounts this. A write that cannot have moved a holding (a label, a deck cover)
 * pays it too; that is the same trade `settle` below already makes by firing four roots for a
 * write that moves one of them.
 */
function useHoldingsFreshness(): void {
  const queryClient = useQueryClient();
  const writing = useIsMutating();
  // A ref rather than state: this is an edge detector and a re-render of its own would be one.
  const wasWriting = useRef(writing);
  useEffect(() => {
    const settled = wasWriting.current > 0 && writing === 0;
    wasWriting.current = writing;
    if (settled) void queryClient.invalidateQueries({ queryKey: HOLDINGS_KEY });
  }, [writing, queryClient]);
}

export function CardDetailModal() {
  const cardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);
  const walk = useAppStore((s) => s.cardWalk);
  const scope = useCardModalScope();
  const { marketplace } = useMarketplace();

  /**
   * The card the panel is *drawing*, which outlives the flag by the length of the exit.
   *
   * `Dialog` keeps the panel mounted while it fades, and `open` is already false on the render
   * that starts the fade — so a body rendered straight off `selectedCardId` would blank the
   * modal for the whole of its own exit. Held in state and only ever moved to a **non-null** id,
   * which is the entire rule: a close leaves the last card on screen, and an open replaces it.
   *
   * Written during render rather than in an effect, which is React's own answer for state that
   * follows a prop and is what the docked pane's face reset did before this file inherited it —
   * an effect would paint one frame of the previous card under the new card's name.
   */
  const [shown, setShown] = useState(cardId);
  if (cardId !== null && cardId !== shown) setShown(cardId);

  const card = useQuery({
    // **The entry every other card surface is served out of** — see {@link cardDetailKey}. The
    // three overlays the rail opens mount an observer on this same key, so opening one is a
    // cache read rather than a round trip.
    queryKey: cardDetailKey(shown, marketplace.id),
    queryFn: shown === null ? skipToken : () => ipc.cardDetail(shown, marketplace.id),
  });

  /**
   * The card's own close, published upward by {@link Body} — the one that hands the caret back to
   * whatever opened the modal before it clears the card.
   *
   * Read through a ref rather than rebuilt here because what it does is not reconstructible from
   * outside: it holds the element the body stashed on mount. `close` below is the fallback for
   * the window between this component's render and the body's mount effect — a window no press
   * can land in, and a close that merely forgot the caret is the right thing to do in it rather
   * than a throw.
   */
  const closeRef = useRef<(() => void) | null>(null);
  const close = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);
  const dismiss = useCallback(() => (closeRef.current ?? close)(), [close]);

  /**
   * Where the open card sits on the walk, or `-1` — `AllPrintingsDialog`'s arithmetic, and the
   * two kinds of stop are told apart the only way each list can be addressed.
   *
   * A deck row goes through `sameDeckSlot`, because a deck can hold one printing in two piles and
   * in two finishes and all five parts of the grain are what tell those rows apart. Everything
   * else goes through `cardId`, and the `stop.deck === null` half is not decoration: without it a
   * card opened from the deck editor's docked search panel — which has no slot — would find *the
   * deck's* row for the same printing and start arrow-stepping the desk from a surface that is
   * not the desk.
   *
   * ## The plain arm is two tries, and the second one is the whole of issue "detached modal"
   *
   * **A different printing of a card is the same entry in the list it was opened from.** Picking
   * one out of `AllPrintingsDialog` writes a `selectedCardId` the walk has never heard of — the
   * wall published the printing *it* drew — so a lookup by `cardId` alone answered `-1`, both
   * chevrons vanished, and the modal had quietly lost its place in the list behind the scrim.
   * Measured in the shipped window on 2026-09-03: `indexOfSelected: -1`, zero chevrons rendered.
   * `AllPrintingsDialog` is the working example of the other answer — it anchors on the card it
   * was *opened* on, which does not move while a reader browses printings — and the oracle id is
   * that same anchor expressed as a fact about the card rather than as a remembered argument.
   *
   * **Exact first, and that order is load-bearing rather than defensive.** A wall searched with
   * `collapse: false` lists several printings of one card as separate stops, so an oracle-only
   * match would land the reader on the first of those — a chevron pair that walks from a card
   * they are not on. The oracle arm is reached only when no stop *is* the open printing.
   *
   * `CardWalkStop.oracleId` is non-null by construction (a printing with no oracle id is not a
   * stop), so the fallback needs no lookup of its own; the open card's own id comes off the
   * detail this component already has in hand, and is `null` only for the length of that read.
   */
  const stops = walk.stops;
  const deckSlot = scope.deck;
  const shownOracle = card.data?.oracleId ?? null;
  const at = useMemo(() => {
    if (shown === null) return -1;
    if (deckSlot !== null) {
      return stops.findIndex((stop) => stop.deck !== null && sameDeckSlot(stop.deck, deckSlot));
    }
    const exact = stops.findIndex((stop) => stop.deck === null && stop.cardId === shown);
    if (exact !== -1 || shownOracle === null) return exact;
    return stops.findIndex((stop) => stop.deck === null && stop.oracleId === shownOracle);
  }, [stops, shown, deckSlot, shownOracle]);
  const previous = at > 0 ? stops[at - 1] : null;
  const next = at >= 0 && at + 1 < stops.length ? stops[at + 1] : null;

  /**
   * A step: the list behind the scrim follows, in the store's own words for where a card was
   * opened from.
   *
   * `openCardFromDeck` for a deck stop — "this card, out of *this* row", so the desk's ring and
   * this modal's own scope stay one answer — and `setSelectedCardId` for everything else, which
   * *clears* `paneDeckContext`. That clearing is load-bearing: a reader who had a deck card open,
   * walked away to the Collection and stepped along it would otherwise be sat in a modal still
   * anchored to the deck row they left.
   */
  const step = useCallback(
    (stop: CardWalkStop) => {
      if (stop.deck === null) setSelectedCardId(stop.cardId);
      else openCardFromDeck(stop.deck);
    },
    [setSelectedCardId, openCardFromDeck],
  );

  /**
   * The pair, or `null` when the walk holds no stop for the open card.
   *
   * **The decision is about the pair and is made here, where the pair exists** — `StepChevron`
   * renders `disabled` at either end of a walk by design, and both chevrons are drawn whenever
   * either is, so teaching one to vanish would delete the greyed end-of-walk state from the
   * printings modal too. A card reached from a meld relation or a printing swap has no position
   * in any list, and a chevron that cannot say where it would go is worse than no chevron.
   */
  const pair =
    at === -1
      ? null
      : {
          left: (
            <StepChevron
              direction="previous"
              listLabel={walk.label}
              stop={previous}
              onStep={step}
            />
          ),
          right: (
            <StepChevron direction="next" listLabel={walk.label} stop={next} onStep={step} />
          ),
        };

  // Flanks above 900 and the action row's corner below it — {@link useFlankRoom}. `undefined`
  // rather than a pair of nulls, because that is what tells the shell to leave its scrim exactly
  // as every other dialog draws it.
  const room = useFlankRoom();
  const flanks: DialogFlanks | undefined = room && pair !== null ? pair : undefined;
  const chevrons: ReactNode =
    !room && pair !== null ? (
      <div className="mr-auto flex shrink-0 items-center gap-2">
        {pair.left}
        {pair.right}
      </div>
    ) : null;

  return (
    <Dialog
      open={cardId !== null}
      // The one host that asks for this, and spec §2.2 is why nothing may render a `fixed`
      // overlay inside the panel: a layout-contained box is the containing block for its `fixed`
      // descendants, so a nested scrim drawn in here would cover the panel and nothing else. The
      // three overlays the rail opens are `App`-level siblings for exactly that reason.
      container
      size={PANEL_SIZE}
      title={<Title card={card.data ?? null} pending={card.isPending} />}
      closeLabel="Close card details"
      flanks={flanks}
      // **Two different functions, and the difference is the caret.** Escape and the ✕ are the
      // reader saying "put me back", so they go through the body's own close and whatever opened
      // the card gets the caret. A press on the **scrim** is not: they have already moved the
      // pointer somewhere else, and pulling focus back to a tile they are no longer looking at is
      // the app arguing with them. That split is `src/CLAUDE.md`'s rule for every dismissible
      // layer, restated here because the doors live in `Dialog`'s chrome now.
      onDismiss={dismiss}
      onClose={close}
    >
      {/* **Escape needs no code here.** `Dialog` registers the `"inner"` rung on its own open
          flag, and a nested overlay mounting later lands above it on `useDismissOnEscape`'s
          capture stack — so the ladder overlay → card → view falls out of mount order. A rung
          added here would be a second `"inner"` peer for one surface.

          Not keyed on the card: a card-to-card step is not this modal leaving and another
          arriving, and the opener stashed on the way in has to survive a whole walk. Per-card
          state resets inside {@link Body} instead. */}
      {shown !== null && (
        <Body
          cardId={shown}
          card={card.data ?? null}
          pending={card.isPending}
          error={card.isError ? ipcError(card.error) : null}
          scope={scope}
          chevrons={chevrons}
          onClose={close}
          closeRef={closeRef}
        />
      )}
    </Dialog>
  );
}

/**
 * `Dialog`'s heading: the card's name, with its type line and mana cost beside it above the fold
 * and stacked under it below.
 *
 * **A `ReactNode` title is what makes this legal**, and it is why the type line is here rather
 * than in `subtitle`: the two facts are the card's identity read at a glance, and a subtitle
 * truncates to one line. The name is `font-heading` by `Dialog`'s own header; the two facts
 * beside it are `text-sm text-dim` so the name is still the loudest thing in the row.
 *
 * `Dialog` sets `aria-labelledby` to this heading, so the modal is addressed **by the card**
 * rather than by a category word — which is what `App.test.tsx`'s dialog queries become.
 */
function Title({ card, pending }: { card: CardDetail | null; pending: boolean }) {
  const name = card?.name ?? (pending ? "Loading…" : "Card");
  return (
    <span className="flex min-w-0 flex-col gap-1 @min-[640px]/card:flex-row @min-[640px]/card:items-baseline @min-[640px]/card:gap-3">
      <span className="min-w-0 truncate">{name}</span>
      {card !== null && (
        <span className="flex min-w-0 items-baseline gap-2 font-sans text-sm font-normal text-dim">
          {card.typeLine !== null && <span className="min-w-0 truncate">{card.typeLine}</span>}
          <ManaText source={card.manaCost} className="shrink-0" />
        </span>
      )}
    </span>
  );
}

/**
 * Everything that costs something — the queries, the writes, and the caret.
 *
 * Mounted only while the modal is open, because `Dialog` renders `children` only then. That is
 * what makes the opener stash below a *mount* effect rather than something watching a flag, and
 * what keeps every query here unasked while no card is open.
 */
function Body({
  cardId,
  card,
  pending,
  error,
  scope,
  chevrons,
  onClose,
  closeRef,
}: {
  cardId: string;
  card: CardDetail | null;
  pending: boolean;
  error: string | null;
  scope: CardModalScope;
  /** The step pair, when the window has no room for `Dialog`'s flanks. */
  chevrons: ReactNode;
  onClose: () => void;
  closeRef: React.RefObject<(() => void) | null>;
}) {
  const { marketplace } = useMarketplace();
  const queryClient = useQueryClient();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const viewPrinting = useAppStore((s) => s.viewPrinting);
  /**
   * How the meld controls under the art re-point the modal at the melded card.
   *
   * **`setSelectedCardId` and deliberately not `viewPrinting`.** That verb means "another printing
   * of the card that is already open" and keeps the deck context alive, so the modal's deck
   * controls survive the click. Brisela is not another printing of Gisela — it is a different
   * card, and it is not the card the deck row holds — so the context has to go, which is exactly
   * what this setter does (see the store).
   */
  const openCard = useAppStore((s) => s.setSelectedCardId);
  /**
   * The finish the surface that opened this card named, or `null` — `CardModalArt`'s foil seed.
   *
   * Read here because that column is presentational and reads no store; a collection tile that
   * *is* a foil and the deck editor's search panel are the two surfaces that write it, and
   * `setSelectedCardId` clears it, so a step along the walk correctly seeds nothing.
   */
  const paneFinish = useAppStore((s) => s.paneFinish);
  const { deps, error: menuFailure } = useCardMenuDeps();
  const addToDeck = useOptionalAddCardToDeck();

  /**
   * Which face the picture is of, reset when the card changes.
   *
   * **Reset during render rather than in an effect**, which was the docked pane's answer and for
   * its reason: a different card is a different card, and the back of the last one is not where
   * a reader wants to arrive. An effect would paint one frame of the previous card's back face.
   */
  const [shownFace, setShownFace] = useState(cardId);
  const [face, setFace] = useState(0);
  /**
   * The counterpart whose picture is standing in for this card's own, or `null` for the ordinary
   * state.
   *
   * **State rather than a second `selectedCardId`**, because the two acts under the art are
   * genuinely different: *Meld* shows the melded card here, on a panel that is still about the
   * card the reader opened, and *Open* makes it the open card. A reader comparing the two halves
   * against the whole wants the first; a reader who has decided they want Brisela's prices wants
   * the second, and collapsing them into one control would take the comparison away.
   *
   * Reset beside the face, and for the same reason it cannot be a key: {@link Body} is
   * deliberately *not* keyed on the card — the opener stashed on the way in has to survive a
   * whole walk — so per-card state is reset during render here instead.
   */
  const [melded, setMelded] = useState<MeldRelation | null>(null);
  if (shownFace !== cardId) {
    setShownFace(cardId);
    setFace(0);
    setMelded(null);
  }

  /** What a write this file makes was refused with, or `null`. Superseded by the next press,
   *  which is every banner's rule on these pages. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const openerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Whatever had the caret when the modal opened, stashed once.
   *
   * **This runs before `Dialog`'s own focus effect, and that ordering is the whole mechanism.**
   * React runs a child's effects before its parent's, and `Dialog` renders this body *inside* the
   * panel whose mount effect takes the caret — so at this point `document.activeElement` is still
   * the tile the reader pressed. A host-level effect would read the panel instead and stash
   * nothing.
   *
   * Never `<body>`: recording it would make the next Escape a hand-back to nowhere, and the
   * caret would restart the next Tab from the top of the app. **Never something inside the panel
   * either, and that guard is the whole reason this is not one line** — StrictMode runs a mount
   * effect twice in development (mount, unmount, mount), and `Dialog`'s own focus effect has run
   * in between, so the second pass would record the panel as its own opener. `close` would then
   * focus an element that is unmounting, the caret would land on `<body>`, and the next Tab would
   * restart from the top of the app. That was the docked pane's measured failure, verbatim.
   *
   * An effect rather than a render-time write, because a ref written during render is a value
   * React may throw away with the render that produced it — and the lint rule that says so is the
   * one this repo runs.
   */
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active === null || active === document.body) return;
    if (active.closest('[role="dialog"]') !== null) return;
    openerRef.current = active;
  }, []);

  const close = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    // Called before React flushes the close, while the panel still holds the caret: an element
    // that unmounts with focus on it drops it to `<body>`, and the next Tab restarts from the top
    // of the app. Only an element still in the document — a tile the list behind the scrim has
    // since re-rendered away is not somewhere to put a reader.
    if (opener?.isConnected) opener.focus();
  }, [onClose]);

  /**
   * Publish {@link close} upward, so the shell's ✕ and its Escape rung do the hand-back too.
   *
   * The opener is a fact only this component holds, so a host that closed the modal by calling
   * its own clear would drop the caret on `<body>`. **jsdom cannot see that** — nothing about the
   * DOM changes — which is why the test for it asserts `toHaveFocus` on the element that opened
   * the card rather than on anything about the panel.
   *
   * An effect rather than an assignment during render, because a render may be thrown away — and
   * the teardown clears the slot **only if the entry is still ours**, which is
   * `useCardZoomGesture`'s rule for the same reason: React may mount a replacement before
   * unmounting the one it replaced, and an unconditional clear would then drop a live
   * registration. Nothing can press the ✕ before the effect has run: effects flush in the same
   * commit, ahead of any event the browser can dispatch.
   */
  useEffect(() => {
    closeRef.current = close;
    return () => {
      if (closeRef.current === close) closeRef.current = null;
    };
  }, [close, closeRef]);

  const oracleId = card?.oracleId ?? null;

  /**
   * Every printing of the open card — the picker's options and the `View all printings (N)`
   * count.
   *
   * The pane's own key and page size verbatim, so this shares that cache entry rather than
   * opening a second one: `MAX_PRINTINGS` is what `cardPrintings` answers with no `limit`, and
   * the printings **modal** names the backend's ceiling instead because it filters client-side.
   */
  const printings = useQuery({
    queryKey: ["card", "printings", oracleId, marketplace.id],
    queryFn: oracleId === null ? skipToken : () => ipc.cardPrintings(oracleId, marketplace.id),
  });

  /**
   * The cards this printing melds with — **asked only of a `meld` card**, which is 72 of the
   * 116 590 live rows.
   *
   * `enabled` on the layout rather than a `skipToken`, because the fence is a fact about the card
   * rather than about whether an argument exists: the command answers `[]` for every other layout
   * and never rejects, so the gate is a saved round trip rather than a correctness guard. The
   * other 116 518 cards a reader opens cost neither the call nor the parse.
   *
   * **No marketplace in the key**, unlike every other read in this file: a meld relationship is
   * not priced, so switching marketplace must not refetch a fixed fact.
   */
  const meld = useQuery({
    queryKey: ["card", "meld", cardId],
    queryFn: () => ipc.cardMeldParts(cardId),
    enabled: card?.layout === "meld",
  });
  const relations = useMemo(() => meld.data ?? [], [meld.data]);

  /**
   * What the reader holds — **read at the oracle grain, which is what "in your grimoire" means.**
   *
   * A reader who owns the Alpha Bolt and opens the 2X2 one owns *Lightning Bolt*, and Rust's
   * deck census resolves the same way (`PLAYED_KEY` is the oracle id with the printing as a
   * fallback). Counting only this printing would answer `0` beside a rail entry that says "In
   * your grimoire", which is a different and wrong claim.
   *
   * **One read where this file made three.** `collectionList`, `wishlistList` and
   * `deckIdsPlaying` each answered a *page of rows* so that the webview could sum a `quantity`
   * column and take the size of a set — three round trips and two list payloads to draw three
   * numbers. `card_holdings` composes the crate's own `copies_of_oracle`, `wished_copies` and
   * `decks_playing`, so a figure here cannot disagree with the wall it sits beside.
   *
   * **No `marketplace` in the key**, like the meld read above and unlike everything else here:
   * these are counts, and nothing about them moves when the setting does.
   */
  const holdings = useQuery({
    queryKey: [...HOLDINGS_KEY, oracleId],
    queryFn: oracleId === null ? skipToken : () => ipc.cardHoldings(oracleId),
  });
  useHoldingsFreshness();

  /**
   * The collection rows behind this card — **kept for the stepper alone, and asked for only where
   * there is one.**
   *
   * The figures above no longer come from here, but the collection surface's stepper writes
   * through `collection_set_quantity`, which is addressed by a **row id** — so deleting this read
   * with the count it used to feed would leave that control drawing a number it could not move.
   * That is the silently-inert handler this file's own deck test exists to catch, arrived at from
   * the other side.
   *
   * `enabled` on the **surface** rather than a `skipToken`, which is `meld`'s split one screen up:
   * `skipToken` is for an argument that does not exist, and `oracleId` exists on every wall. What
   * is missing on the search, tags and deck surfaces is a *reason* — `scope.quantity` says no
   * stepper is drawn there, so the rows would be fetched for nothing.
   */
  const owned = useQuery({
    queryKey: ["collection", "card", oracleId],
    queryFn:
      oracleId === null
        ? skipToken
        : () => ipc.collectionList({ oracleId, limit: 200, offset: 0 }),
    enabled: scope.quantity === "owned",
  });
  /** The same, for the wishlist's own stepper — `wishlist_set_quantity` takes a row id too. */
  const wished = useQuery({
    queryKey: ["wishlist", "card", oracleId],
    queryFn:
      oracleId === null ? skipToken : () => ipc.wishlistList({ oracleId, limit: 200, offset: 0 }),
    enabled: scope.quantity === "wished",
  });

  /**
   * The deck behind the modal, or the idle hook — `useDeck(null)` disables its own query, so this
   * costs nothing on a card opened from a wall.
   *
   * It is what fills the category and label pickers and what the quantity stepper writes through:
   * spec §7's deck column, resolved once by `useCardModalScope` and consumed here.
   */
  const deck = useDeck(scope.deck?.deckId ?? null, scope.deck?.variant);
  /** The deck row this card was opened out of, addressed by all of the grain the scope carries. */
  const deckCard =
    scope.deck === null
      ? null
      : (deck.cards.find(
          (row) =>
            row.cardId === scope.deck?.cardId &&
            row.categoryId === scope.deck.categoryId &&
            row.finish === scope.deck.finish,
        ) ?? null);

  /**
   * The deck gallery, for `Add to deck`'s picker — and the folder each deck sits in, drawn as the
   * row's dim second fact rather than as a tree.
   *
   * Two cached list reads under the `["decks"]` root, shared with the gallery and the editor. The
   * card menu makes the same pair lazy because a right-click on a wall of forty tiles must not
   * fire them; there is one modal, and it asks only while a card is open.
   */
  const { decks } = useDecks();
  const { folders: deckFolders } = useDeckFolders();

  /** The rows behind this exact **printing**, which is what a stepper in a modal about one
   *  printing can honestly address. Empty on every surface that draws no stepper, because the
   *  read behind each is `enabled` on exactly that — see {@link owned}. */
  const ownedRows = useMemo(
    () => (owned.data?.items ?? []).filter((row) => row.cardId === cardId),
    [owned.data, cardId],
  );
  const wishedRows = useMemo(
    () => (wished.data?.items ?? []).filter((row) => row.cardId === cardId),
    [wished.data, cardId],
  );

  /**
   * The block's four figures — three from Rust and the fourth from the deck already in hand.
   *
   * **Zero is a real answer and `undefined` is the only absence**, so the fallback is what the
   * panel draws for the length of one read rather than a claim about a card nobody holds. The
   * block has no pending state of its own by design: three dashes that turn into three zeros is
   * a flicker on the card a reader opens most often, which is the one they hold none of.
   *
   * `deck` stays outside the command, because `card_holdings` answers at the oracle grain and
   * this is a **row**: the copies in the one pile the card was opened out of, which
   * `RailCounts.deck` documents as the field nothing else can fill.
   */
  const counts: RailCounts = {
    owned: holdings.data?.owned ?? 0,
    wished: holdings.data?.wished ?? 0,
    decks: holdings.data?.decks ?? 0,
    deck: deckCard?.quantity ?? null,
  };

  /**
   * The collection's absolute set — `collection_set_quantity`, with the four keys
   * `useCardMenuDeps` settles a collection write with and for its reasons: the list and its
   * summary, every wish for the card (`ownedQuantity` is summed from `collection_entries`), every
   * deck (a claim is clamped to what the entry still holds), and the search results, which draw
   * `ownedQuantity` on every row.
   *
   * **{@link HOLDINGS_KEY} is deliberately not among them.** It is not under any of these roots
   * and could not be under all three, so it is settled by {@link useHoldingsFreshness} instead —
   * which catches this write and every write made through a callback this file cannot chain. A
   * key added here would refresh the figures after a stepper press and leave them stale after the
   * action row's, which is the half-fix that looks like a fix.
   */
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  };
  const setOwned = useMutation({
    mutationFn: ({ id, quantity }: { id: number | null; quantity: number }) =>
      id === null
        ? ipc.collectionAdd({
            cardId,
            finish: soleFinish(card?.finishes ?? null) ?? "nonfoil",
            condition: MODAL_CONDITION,
            quantity,
            // Never omitted: `folder_id` is the eleventh term of the collection's grain, so a
            // folder the caller failed to pass is a *second row* at the root rather than a copy
            // filed in the wrong drawer.
            folderId: null,
          })
        : ipc.collectionSetQuantity(id, quantity),
    onMutate: () => setRefusal(null),
    onSuccess: settle,
    onError: (e) => setRefusal(`Could not change what you own — ${ipcError(e)}`),
  });
  const setWished = useMutation({
    mutationFn: ({ id, quantity }: { id: number | null; quantity: number }) =>
      id === null
        ? ipc.wishlistAdd({ cardId, quantity, folderId: null })
        : ipc.wishlistSetQuantity(id, quantity),
    onMutate: () => setRefusal(null),
    // Two keys rather than four: a wish is a copy the reader does not have, so it moves no
    // collection figure and no deck's arithmetic.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
    onError: (e) => setRefusal(`Could not change your wishlist — ${ipcError(e)}`),
  });

  /**
   * What the stepper shows, per what `scope.quantity` says it edits.
   *
   * The deck arm is the row's own quantity; the other two are the copies of **this printing**,
   * which is the narrowest thing a control in a modal about one printing can claim to move. The
   * rail's figures beside it are the oracle-wide ones, and the two genuinely answer different
   * questions — a reader owning three Bolts of which one is this printing sees `3 owned` in the
   * rail and a stepper on `1`.
   */
  const quantity =
    scope.quantity === "deck"
      ? (deckCard?.quantity ?? 0)
      : scope.quantity === "owned"
        ? ownedRows.reduce((sum, row) => sum + row.quantity, 0)
        : wishedRows.reduce((sum, row) => sum + row.quantity, 0);

  /**
   * The press, per surface — and **the refusal is a sentence rather than a silence** where the
   * printing sits in more than one row.
   *
   * A tile's stepper on the collection page fences the same case by not being drawn at all
   * (`CollectionPage`'s `stepperByTile`): the number is a **sum**, and a press that moved a sum
   * spread over three drawers would move copies the reader never pointed at. The modal cannot
   * take the control away — whether a stepper is drawn is `scope.quantity`'s answer and it is a
   * fact about the *surface* — so it says so instead and names where the answer is.
   */
  const changeQuantity = (next: number) => {
    if (scope.quantity === "deck") {
      if (scope.deck === null) return;
      deck.setQuantity.mutate({
        cardId: scope.deck.cardId,
        categoryId: scope.deck.categoryId,
        finish: scope.deck.finish,
        quantity: next,
      });
      return;
    }
    const rows = scope.quantity === "owned" ? ownedRows : wishedRows;
    if (rows.length > 1) {
      setRefusal(
        `You hold this printing in ${rows.length} rows — open the ${
          scope.quantity === "owned" ? "collection" : "wishlist"
        } to change one of them.`,
      );
      return;
    }
    const id = rows[0]?.id ?? null;
    if (scope.quantity === "owned") setOwned.mutate({ id, quantity: next });
    else setWished.mutate({ id, quantity: next });
  };

  const printingOptions: DropdownOption[] = useMemo(
    () =>
      (printings.data?.items ?? []).map((p) => ({
        value: p.id,
        label: p.setName ?? p.setCode.toUpperCase(),
        hint: `#${p.collectorNumber}`,
      })),
    [printings.data],
  );

  const categoryOptions: DropdownOption[] = useMemo(
    () => deck.categories.map((c) => ({ value: String(c.id), label: c.name })),
    [deck.categories],
  );

  /**
   * **Every label the reader has**, not the ones this deck's list happens to be wearing.
   *
   * `deck.labels` comes off `deck_get`, and `ipc.ts` states the limit outright at
   * `deckLabelList`: it *cannot* answer a label nothing is wearing. So a label the reader made
   * and has not used here yet was missing from the picker — which is precisely the label they
   * opened it to apply, and it read as "my labels are gone". `deck_label_all` is the only list
   * that can answer one, and it is the same `["decks", "labelsAll"]` entry `useDeckMeta` reads,
   * so the Labels dialog and this picker share a cache line and one `["decks"]` invalidation
   * settles both.
   *
   * **Gated on the pickers being drawn.** A card opened off a wall has no deck behind it and
   * nothing to do with a label, so it must not pay for the list — `scope.deckControls` is the
   * same fact `CardModalControls` draws the two pickers on, rather than a second opinion about
   * when a deck is in play.
   */
  const allLabels = useQuery({
    queryKey: ["decks", "labelsAll"],
    queryFn: () => ipc.deckLabelAll(),
    enabled: scope.deckControls,
  });

  /**
   * "No label", then the labels this list wears, then the rest — and **nothing here sorts.**
   *
   * Both commands answer **most-used-first**, which `features/decks/CLAUDE.md` names as the first
   * of this app's two exemptions from the alphabetical option-list rule: an order that *is* the
   * information. Merging them alphabetically would throw away a count the backend went and made.
   * In-use first because those are the labels this deck already speaks in; `seen` is what keeps a
   * label from appearing in both halves, since `deck_label_all` answers every label including the
   * worn ones.
   *
   * The empty string is first because a row wears at most one label and `null` is a real answer,
   * so "no label" has to be a row a reader can press rather than only a placeholder. The swatch is
   * `aria-hidden`, so the row's name is still the label's name — colour is what a reader tells two
   * labels apart by on every other surface in the app, and a picker without it would be the one
   * place a label is only a word.
   */
  const labelOptions: DropdownOption[] = useMemo(() => {
    const seen = new Set(deck.labels.map((l) => l.id));
    const rest = (allLabels.data ?? []).filter((l) => !seen.has(l.id));
    const row = (l: { id: number; name: string; color: LabelColor }) => ({
      value: String(l.id),
      label: l.name,
      icon: <LabelSwatch color={l.color} />,
    });
    return [{ value: "", label: "No label" }, ...deck.labels.map(row), ...rest.map(row)];
  }, [deck.labels, allLabels.data]);

  /**
   * The two picks, as functions rather than as inline arrows — because the `Create new…` rows
   * below end in exactly the same two writes and a second copy of either would be a second
   * opinion about the slot a press addresses.
   */
  const pickCategory = (categoryId: number) => {
    if (scope.deck === null) return;
    deck.moveCard.mutate({
      cardId: scope.deck.cardId,
      from: scope.deck.categoryId,
      to: categoryId,
      finish: scope.deck.finish,
    });
  };
  const pickLabel = (labelId: number | null) => {
    if (scope.deck === null) return;
    deck.setLabel.mutate({
      cardId: scope.deck.cardId,
      categoryId: scope.deck.categoryId,
      finish: scope.deck.finish,
      labelId,
    });
  };

  /**
   * Making one, from inside the modal — the two writes behind `CardModalControls`' `Create new…`
   * rows, and the only writes in this file that bring something into existence rather than move
   * something that already exists.
   *
   * **Both take the whole `["decks"]` root, on success and on refusal alike** — `useDeckMeta`'s
   * rule for every label and category write, and it is what refreshes the picker that is about to
   * draw the new row. `["decks", "labelsAll"]` sits under it, which is the entire reason
   * {@link labelOptions}' read is keyed there rather than somewhere of this file's own.
   *
   * **A label needs a colour and the backend will not invent one**: `deck_labels.color` is NOT
   * NULL and `deck_label_create` refuses a name with no colour, which is `LabelColor`'s "picking
   * what a colour *is* belongs to the webview". The webview's answer is `labelColors.ts` and the
   * control is the Labels dialog's own picker, drawn in the form — never a hex written here.
   */
  const settleDecks = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };
  const createCategory = useMutation({
    mutationFn: ({ deckId, name }: { deckId: number; name: string }) =>
      ipc.deckCategoryCreate(deckId, name),
    onSuccess: settleDecks,
    onError: settleDecks,
  });
  const createLabel = useMutation({
    mutationFn: ({ deckId, name, color }: { deckId: number; name: string; color: LabelColor }) =>
      ipc.deckLabelCreate(deckId, name, color),
    onSuccess: settleDecks,
    onError: settleDecks,
  });

  /**
   * Make it, then use it — **`mutateAsync` and an explicit chain, never a `mutate`-scoped
   * `onSuccess`.**
   *
   * `features/decks/CLAUDE.md` states the rule at the editor's own create, with the failure
   * behind it: a callback passed to `mutate` belongs to its *observer*, and TanStack drops it
   * when that observer unmounts — so a create chained that way loses its attach to an Escape
   * landing during the round trip, leaving the label made and silently never worn. A chained
   * promise is held by the closure instead, so the second write lands whatever the panel does.
   *
   * The refusal is a sentence rather than a silence, like every other write in this file: a
   * duplicate name is the one refusal a reader can actually hit, and `CardModalControls` spends
   * a courtesy check to keep them off it — but the `UNIQUE INDEX` is the fence and two windows
   * racing one name is exactly what it is for.
   */
  const makeCategory = (name: string) => {
    const slot = scope.deck;
    if (slot === null) return;
    setRefusal(null);
    createCategory
      .mutateAsync({ deckId: slot.deckId, name })
      .then((category) => pickCategory(category.id))
      .catch((e: unknown) => setRefusal(`Could not make that category — ${ipcError(e)}`));
  };
  const makeLabel = (name: string, color: LabelColor) => {
    const slot = scope.deck;
    if (slot === null) return;
    setRefusal(null);
    createLabel
      .mutateAsync({ deckId: slot.deckId, name, color })
      .then((label) => pickLabel(label.id))
      .catch((e: unknown) => setRefusal(`Could not make that label — ${ipcError(e)}`));
  };

  const target = card === null ? null : cardTarget(card);

  /**
   * The rail's surface-specific entries.
   *
   * **`Set as commander` is deliberately not among them.** Spec §7 lists it beside `Set deck
   * image`, and it is not a write this file can make honestly: the row exists only where the
   * format has a command zone and only where the *card* is eligible, and both tests live in
   * `deckCardMenu.tsx` against `format_specs` and `validation/`. A looser rule here would offer a
   * card the validation panel then refuses, which is the one thing a deck surface must never do.
   * Reported rather than invented.
   */
  const railActions: readonly RailAction[] = useMemo(() => {
    if (!scope.deckControls || scope.deck === null || card === null) return [];
    return [
      {
        label: "Set deck image",
        onSelect: () => deck.update.mutate({ coverCardId: card.id }),
      },
    ];
  }, [scope.deckControls, scope.deck, card, deck.update]);

  /**
   * `Add to deck`'s decks — **a `Dropdown` inside the panel, and never the card menu's picker.**
   *
   * `src/CLAUDE.md` states the reason as a rule with a shipped failure behind it: *a menu opened
   * from inside a `LAYER.overlay` dialog paints behind that dialog's scrim.* The context menu is
   * mounted at the app root at `LAYER.popup` and this modal's scrim is at `LAYER.overlay`, two
   * rungs above it and neither inside the other — the numbers are `layers.ts`'s and are
   * deliberately not repeated here, because `layers.test.ts` sweeps `src/` for a spelled z-index
   * and reads a doc comment as markup. So `menuClick` here would open a picker that is invisible
   * and unreachable,
   * with **nothing going red**, because jsdom has no opinion about a z-index. A `Dropdown` is
   * rendered *inside* the panel, so its `fixed` panel is a descendant of the scrim's own stacking
   * context and paints above it whatever number it carries. That is also why the printing,
   * category and label pickers one column over work.
   *
   * **What it costs against the menu's picker is the folder tree and the Theory/Live question.**
   * The tree becomes a dim second fact per row, and the variant is `DEFAULT_VARIANT` — which is
   * the collection cabinet's own answer for a one-press filing (`useCardMenuDeps`' `toDeck`), on
   * its argument: this press is filing rather than deck-building, and a reader who means the plan
   * has the deck editor.
   *
   * `sortOptions` and never a bare `localeCompare` — the app's option-list rule, so a picker
   * cannot read one way on one machine and another on a reader's.
   */
  const deckOptions: DropdownOption[] = useMemo(() => {
    const named = new Map(deckFolders.map((f) => [f.id, f.name]));
    return sortOptions(
      decks.filter((d) => !d.archived),
      (d) => d.name,
    ).map((d) => ({
      value: String(d.id),
      label: d.name,
      hint: d.folderId === null ? undefined : named.get(d.folderId),
    }));
  }, [decks, deckFolders]);

  const artist = card === null ? null : artistOf(card, face, melded);

  return (
    <>
      {/* The panel's own scroller lives on the grid below; this wrapper is the flex column
          `Dialog`'s panel expects a body to be.

          **`flex-auto` rather than `flex-1`, and it is half of {@link PANEL_SIZE}'s height rule.**
          `flex-1` is `flex: 1 1 0%`, and a zero basis contributes *nothing* to an auto-height
          column's content height — so with the panel sized from its content this box would report
          0, the panel would sit at its `min-h` floor at every window size, and the fix would be
          present and inert. `flex: 1 1 auto` reports what is in it and still shrinks to nothing
          under `max-h-full`, which is what `min-h-0` beside it is for. */}
      <div ref={panelRef} className="flex min-h-0 flex-auto flex-col">
        <CardMenuRefusal error={refusal ?? menuFailure} className="mx-5 mt-3 shrink-0" />

        {error !== null && (
          <p role="alert" className="mx-5 mt-3 text-sm text-destructive">
            Could not read this card — {error}
          </p>
        )}
        {!pending && error === null && card === null && (
          <p className="mx-5 mt-3 text-sm text-dim">
            This printing is not in the card database any more. It may have been removed by the
            last sync — close this and search again.
          </p>
        )}

        {card !== null && (
          <div
            className={cn(
              // **Below `@min-[640px]/card` there are no columns at all**: one scroller, and
              // every block stacked in it, the rail's entries included. The *grid* is the
              // scroller there and the columns are not, which is the one arrangement that gives
              // a phone a single thumb-driven scroll rather than three nested ones.
              // `flex-auto` and not `flex-1`, for the reason spelled on the wrapper above: this
              // is the box whose content the panel's height is now driven *by*, and a zero
              // flex-basis would report none of it.
              "grid min-h-0 flex-auto grid-cols-1 gap-5 overflow-y-auto p-5",
              // At and above the fold the grid stops scrolling and each column starts.
              // `grid-rows-[minmax(0,1fr)_auto]` and not a bare `1fr`: an implicit row is
              // `auto`, which sizes to its own content, so the columns' `overflow-y-auto` would
              // have all the room it asked for and never scroll — the same circular clamp
              // `Dialog`'s scrim documents at its own site. The second, `auto` row is where the
              // rail sits at this rung.
              "@min-[640px]/card:grid-rows-[minmax(0,1fr)_auto] @min-[640px]/card:overflow-y-visible",
              "@min-[640px]/card:grid-cols-[18.75rem_1fr]",
              "@min-[900px]/card:grid-rows-[minmax(0,1fr)] @min-[900px]/card:grid-cols-[20rem_1fr_max-content]",
              "@min-[1200px]/card:grid-cols-[23.5rem_1fr_max-content]",
            )}
          >
            <div
              className={cn(
                "min-w-0",
                // Spans both rows at the two-column rung, so the picture is not cut off at the
                // height of the controls beside it.
                "@min-[640px]/card:row-span-2 @min-[640px]/card:min-h-0 @min-[640px]/card:overflow-y-auto",
                "@min-[900px]/card:row-span-1",
              )}
            >
              <CardModalArt
                // Keyed on the card, so a step throws the column's own state — the broken-image
                // note and the foil view — out with it rather than carrying it to the next card.
                key={cardId}
                card={card}
                face={face}
                onFlip={() => setFace((f) => (f === 0 ? 1 : 0))}
                marketplace={marketplace}
                // **The row and not a bare finish**: `DeckFinish` already admits `null`, so a
                // `DeckFinish | null` could not tell "no deck behind the modal" from "a deck row
                // playing a regular copy" — which is exactly what the button's `Set as …` /
                // `View as …` label turns on. A `PaneDeckContext` satisfies the shape
                // structurally, so it goes through unchanged.
                deckRow={scope.deck}
                // The other half of that seed, and the half a deck row cannot supply: a
                // collection tile that *is* a foil, or the deck editor's search panel, writes
                // `paneFinish` when it opens the card. Without it a foil tile opened plain.
                openedAs={paneFinish}
                onToggleFoil={(next: DeckFinish) => {
                  if (scope.deck === null) return;
                  deck.setCardFinish.mutate({
                    cardId: scope.deck.cardId,
                    categoryId: scope.deck.categoryId,
                    finish: scope.deck.finish,
                    to: next,
                  });
                }}
                // **`melded` is this component's state and not the column's**, which is the whole
                // of why the meld controls are wired this way round: the artist credit at the
                // foot of the panel has to name the illustrator of the face on screen, and it is
                // drawn down there. See {@link artistOf}.
                meld={{ relations, melded, onMeld: setMelded, onOpen: openCard }}
              />
            </div>

            <div
              className={cn(
                "flex min-w-0 flex-col gap-5",
                "@min-[640px]/card:col-start-2 @min-[640px]/card:row-start-1",
                "@min-[640px]/card:min-h-0 @min-[640px]/card:overflow-y-auto",
              )}
            >
              <CardModalControls
                card={card}
                scope={scope}
                printingCount={printings.data?.total ?? 0}
                onViewAllPrintings={() => {
                  if (card.oracleId === null) return;
                  openAllPrintings({
                    cardId: card.id,
                    oracleId: card.oracleId,
                    name: card.name,
                    deck: scope.deck,
                    // The reader is asking about *this card*, not repointing a wish — see
                    // `PrintingsRequest.wish`, where the field is required so that every caller
                    // has to say which it means.
                    wish: null,
                  });
                }}
                printings={printingOptions}
                onPickPrinting={viewPrinting}
                quantity={quantity}
                onQuantityChange={changeQuantity}
                categories={categoryOptions}
                onPickCategory={pickCategory}
                onCreateCategory={makeCategory}
                labels={labelOptions}
                labelId={deckCard?.labelId ?? null}
                onPickLabel={pickLabel}
                onCreateLabel={makeLabel}
              />

              <InlineCounts counts={counts} scope={scope} />
            </div>

            <div
              className={cn(
                "min-w-0",
                "@min-[640px]/card:col-start-2 @min-[640px]/card:row-start-2",
                "@min-[900px]/card:col-start-3 @min-[900px]/card:row-start-1",
                "@min-[900px]/card:min-h-0 @min-[900px]/card:overflow-y-auto",
              )}
            >
              <CardModalRail
                card={card}
                scope={scope}
                actions={railActions}
                counts={counts}
              />
            </div>
          </div>
        )}

        {/* **Outside the scrollers**, which is spec §2's one instruction about this row: the way
            to add a card must not be somewhere a reader has to scroll to find. */}
        <div className="shrink-0 border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Below 900 the pair sits in this row's left corner rather than off the panel's
                edges — {@link useFlankRoom} decides which, because the room they need is the
                scrim's and the scrim is the window. */}
            {chevrons}
            <button
              type="button"
              // **The name is the long form at every rung and the visible words shorten**, so a
              // test, a screen reader and voice control all read one name whatever the panel is.
              // Two spans swapped by a container query would join into "WishlistAdd to wishlist"
              // wherever the query does not resolve — which is every test in this repo.
              aria-label="Add to wishlist"
              disabled={target === null}
              onClick={() => target !== null && deps.addToWishlist(target, null)}
              className={cn(ACTION, "disabled:opacity-40", PRESS, FOCUS)}
            >
              <span className="@min-[900px]/card:hidden">Wishlist</span>
              <span className="hidden @min-[900px]/card:inline">Add to wishlist</span>
            </button>
            <button
              type="button"
              aria-label="Add to collection"
              disabled={target === null}
              onClick={() =>
                target !== null &&
                deps.addToCollection(
                  target,
                  // What the cardboard *is* where the printing has one answer, and the plain copy
                  // otherwise. `soleFinish` speaks only for a printing with a single finish, which
                  // is the one case a single press can be sure about.
                  soleFinish(card?.finishes ?? null) ?? "nonfoil",
                  null,
                )
              }
              className={cn(ACTION, "disabled:opacity-40", PRESS, FOCUS)}
            >
              <span className="@min-[900px]/card:hidden">Collection</span>
              <span className="hidden @min-[900px]/card:inline">Add to collection</span>
            </button>
            <Dropdown
              // The trigger *is* the button: `value=""` never matches an option, so the
              // placeholder is what it always reads — which is right for a control that performs
              // an action rather than holding a setting. Picking a deck writes and leaves the
              // trigger saying `Add to deck` again.
              value=""
              onChange={(deckId) => {
                if (target === null || addToDeck === null) return;
                addToDeck(target, Number(deckId), DEFAULT_VARIANT);
              }}
              options={deckOptions}
              placeholder="Add to deck"
              label="Add to deck"
              // A gallery can hold dozens of decks, which is exactly the list that needs a box.
              searchable
              searchLabel="Search decks"
              // `null` where nothing mounted `CardToDeckProvider` — the picker cannot write, so it
              // is out of reach rather than drawn and inert. That is `useOptionalAddCardToDeck`'s
              // documented shape one layer up.
              disabled={target === null || addToDeck === null}
              // Full width and first below the phone fold, where a right-aligned row of three
              // would be three cramped targets. It is the press this row exists for, so it is the
              // one that gets the whole line.
              className={cn(
                ACTION_PRIMARY,
                "order-first w-full @min-[640px]/card:order-none @min-[640px]/card:w-auto",
              )}
            />
          </div>

          {/* **Required wherever art is shown**, which is Scryfall's usage rule rather than a
              courtesy — the artist and the source have to be identifiable in the same interface
              that draws the picture. The artist is the one whose art is *on screen*, which is
              why {@link artistOf} takes the face **and the meld view**: the two sides of a
              double-faced card are not always the same illustrator, and neither are the two
              halves of a meld, so a credit naming the open card while a counterpart's picture is
              up would be the wrong illustrator under the right art.

              **`pricesAsOf` is not repeated here.** `CardModalArt` draws it under the price cells
              it dates, and a second copy of one sentence in one panel is worse than one — a
              printing with no finishes draws neither, which is right, because it draws no prices
              for a caption to be about. */}
          {card !== null && (
            <p className="mt-2 text-[0.7rem] leading-relaxed text-dim">
              {artist !== null && <>Illustrated by {artist}. </>}
              Card images © Wizards of the Coast · Data © Scryfall
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The grimoire figures, drawn **inline** — the other half of `CardModalRail`'s block.
 *
 * **All four artboards show these counts; the rail draws them only at `@min-[1200px]/card`.** So
 * `@min-[1200px]/card:hidden` here is not a duplicate but the complement: exactly one of the two
 * is visible at every width. Without it the counts vanish below 1200px with every test green,
 * because jsdom resolves no container query and both copies are in the DOM at once.
 *
 * A row rather than the rail's column, because this sits under the controls in a column that is
 * already wide — and it wraps, so the phone rung stacks it instead of squeezing four figures onto
 * one line.
 */
function InlineCounts({ counts, scope }: { counts: RailCounts; scope: CardModalScope }) {
  const deckLine =
    scope.deck === null || counts.deck === null
      ? null
      : // One text node, because a CSS `gap` is not a word separator to the accessible-name
        // computation — `4×` and `in Burn spells` in two elements read as "4×in Burn spells".
        `${counts.deck}× in ${scope.deck.categoryName}`;

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm @min-[1200px]/card:hidden">
      <h3 className="text-xs uppercase tracking-wide text-dim">In your grimoire</h3>
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Figure label="Owned" value={counts.owned} />
        <Figure label="Wished" value={counts.wished} />
        <Figure label="In decks" value={counts.decks} />
      </dl>
      {deckLine !== null && <p className="text-xs text-dim">{deckLine}</p>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-dim">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The open card as every card menu describes one — `CardDetailPane`'s `paneTarget`, copied out
 * before that file was deleted rather than imported from it.
 */
function cardTarget(card: CardDetail) {
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
