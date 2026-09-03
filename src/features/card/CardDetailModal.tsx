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
 * * **No meld controls.** The docked pane could show a melded counterpart's picture in place of
 *   the open card's; `CardModalArt` is presentational and has no seat for it, so the modal never
 *   has a melded face on screen. {@link artistOf} keeps its `melded` parameter anyway — it is
 *   lifted verbatim from the file being deleted, and the day a meld control comes back it is the
 *   credit that has to move with it.
 * * **No printing *swap*.** A card opened out of a deck row could be re-pointed at another
 *   printing from the pane's printings list. The modal's printing picker calls `viewPrinting`,
 *   which browses; `AllPrintingsDialog` is where a swap still lives.
 * * **No foil seed from `paneFinish`.** `CardModalArt` opens on the shiny copy only where a
 *   *deck row* names one, so a foil collection tile now opens plain. Recorded as a regression by
 *   Task 7's own doc; closing it means a seed prop on that component.
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
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { ManaText } from "@/components/ManaText";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { Dialog, type DialogFlanks } from "@/components/Dialog";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { playKey, useDecksPlaying } from "@/features/decks/useDeckPlays";
import { useDecks } from "@/features/decks/useDecks";
import { sameDeckSlot } from "@/features/decks/deckWalk";
import type { DropdownOption } from "@/components/Dropdown/types";
import { soleFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CardDetail, type DeckFinish, type MeldRelation } from "@/lib/ipc";
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
 * how big a panel to ask for out of that glass is a question about the glass. `sm` is Tailwind's
 * 640, which is the same fold `Dialog`'s own `p-0 sm:p-6` uses; 900 and 1200 are spelled out
 * whole because Tailwind scans source text for whole class names and an interpolated one emits no
 * rule at all.
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
 * `sm:`, `min-[900px]:`, `min-[1200px]:`). Two widths at one variant would silently collapse to
 * the last; these do not.
 */
const PANEL_SIZE =
  "w-full h-full " +
  "sm:w-[47.75rem] sm:h-[52.5rem] " +
  "min-[900px]:w-[66.25rem] min-[900px]:h-[47.5rem] " +
  "min-[1200px]:w-[77.5rem] min-[1200px]:h-[50rem]";

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
 * **Lifted verbatim from `CardDetailPane`** rather than rewritten, because that file is deleted
 * with the dock and this is the one piece of it the credit depends on. `melded` wins outright
 * rather than falling back to the open card: while a melded card's picture is up, the open card's
 * illustrator is not the one being credited, and a fallback that reached for it would print a
 * name that is wrong rather than missing.
 *
 * **The parameter is always `null` today**, because `CardModalArt` draws no meld control — see
 * this file's own doc. It is kept rather than inlined so that the day the control comes back, the
 * credit is already asking the right question.
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
   * follows a prop and is what `CardDetailPane`'s face reset already does one file over — an
   * effect would paint one frame of the previous card under the new card's name.
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
   */
  const stops = walk.stops;
  const deckSlot = scope.deck;
  const at = useMemo(() => {
    if (shown === null) return -1;
    return deckSlot === null
      ? stops.findIndex((stop) => stop.deck === null && stop.cardId === shown)
      : stops.findIndex((stop) => stop.deck !== null && sameDeckSlot(stop.deck, deckSlot));
  }, [stops, shown, deckSlot]);
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
  const { deps, error: menuFailure } = useCardMenuDeps();
  const addToDeck = useOptionalAddCardToDeck();

  /**
   * Which face the picture is of, reset when the card changes.
   *
   * **Reset during render rather than in an effect**, which is `CardDetailPane`'s answer and for
   * its reason: a different card is a different card, and the back of the last one is not where
   * a reader wants to arrive. An effect would paint one frame of the previous card's back face.
   */
  const [shownFace, setShownFace] = useState(cardId);
  const [face, setFace] = useState(0);
  if (shownFace !== cardId) {
    setShownFace(cardId);
    setFace(0);
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
   * restart from the top of the app. That is `CardDetailPane`'s measured failure, verbatim.
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
   * What the reader holds — **read at the oracle grain, which is what "in your grimoire" means.**
   *
   * A reader who owns the Alpha Bolt and opens the 2X2 one owns *Lightning Bolt*, and the deck
   * census one field over already resolves the same way (`playKey` is the oracle id with the
   * printing as a fallback). Counting only this printing would answer `0` beside a rail entry
   * that says "In your grimoire", which is a different and wrong claim.
   *
   * **The rows come back as well as the count, because the stepper needs one to write to.** There
   * is no per-card holdings command; `collection_list` and `wishlist_list` both take an
   * `oracleId` filter and a card is a handful of rows, so one read answers both questions.
   */
  const owned = useQuery({
    queryKey: ["collection", "card", oracleId],
    queryFn:
      oracleId === null
        ? skipToken
        : () => ipc.collectionList({ oracleId, limit: 200, offset: 0 }),
  });
  const wished = useQuery({
    queryKey: ["wishlist", "card", oracleId],
    queryFn:
      oracleId === null ? skipToken : () => ipc.wishlistList({ oracleId, limit: 200, offset: 0 }),
  });

  /**
   * How many decks play this card — the census asked from the deck end, which is the only thing
   * that can answer it. `playKey` is the shared spelling of the join `deck_ids_playing` makes.
   */
  const cards = useMemo(
    () => (oracleId === null ? [] : [playKey({ oracleId, cardId })]),
    [oracleId, cardId],
  );
  const playing = useDecksPlaying(cards);

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
   *  printing can honestly address. */
  const ownedRows = useMemo(
    () => (owned.data?.items ?? []).filter((row) => row.cardId === cardId),
    [owned.data, cardId],
  );
  const wishedRows = useMemo(
    () => (wished.data?.items ?? []).filter((row) => row.cardId === cardId),
    [wished.data, cardId],
  );

  const counts: RailCounts = {
    owned: (owned.data?.items ?? []).reduce((sum, row) => sum + row.quantity, 0),
    wished: (wished.data?.items ?? []).reduce((sum, row) => sum + row.quantity, 0),
    decks: playing.deckIds.size,
    deck: deckCard?.quantity ?? null,
  };

  /**
   * The collection's absolute set — `collection_set_quantity`, with the four keys
   * `useCardMenuDeps` settles a collection write with and for its reasons: the list and its
   * summary, every wish for the card (`ownedQuantity` is summed from `collection_entries`), every
   * deck (a claim is clamped to what the entry still holds), and the search results, which draw
   * `ownedQuantity` on every row.
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

  /** Every label, with the empty string first — a row wears at most one and `null` is a real
   *  answer, so "no label" has to be a row a reader can press rather than only a placeholder. */
  const labelOptions: DropdownOption[] = useMemo(
    () => [
      { value: "", label: "No label" },
      ...deck.labels.map((l) => ({ value: String(l.id), label: l.name })),
    ],
    [deck.labels],
  );

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
   * mounted at the app root at `LAYER.popup` (z-30) and this modal's scrim is z-45, neither
   * inside the other — so `menuClick` here would open a picker that is invisible and unreachable,
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

  const artist = card === null ? null : artistOf(card, face, null);

  return (
    <>
      {/* The panel's own scroller lives on the grid below; this wrapper is the flex column
          `Dialog`'s panel expects a body to be. */}
      <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
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
              "grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto p-5",
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
                onToggleFoil={(next: DeckFinish) => {
                  if (scope.deck === null) return;
                  deck.setCardFinish.mutate({
                    cardId: scope.deck.cardId,
                    categoryId: scope.deck.categoryId,
                    finish: scope.deck.finish,
                    to: next,
                  });
                }}
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
                onPickCategory={(categoryId) => {
                  if (scope.deck === null) return;
                  deck.moveCard.mutate({
                    cardId: scope.deck.cardId,
                    from: scope.deck.categoryId,
                    to: categoryId,
                    finish: scope.deck.finish,
                  });
                }}
                labels={labelOptions}
                labelId={deckCard?.labelId ?? null}
                onPickLabel={(labelId) => {
                  if (scope.deck === null) return;
                  deck.setLabel.mutate({
                    cardId: scope.deck.cardId,
                    categoryId: scope.deck.categoryId,
                    finish: scope.deck.finish,
                    labelId,
                  });
                }}
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
              why {@link artistOf} takes the face.

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
 * The open card as every card menu describes one — `CardDetailPane`'s `paneTarget`, copied for
 * that file's deletion rather than imported from it.
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
