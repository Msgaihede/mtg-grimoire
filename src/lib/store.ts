import { create } from "zustand";
import { DEFAULT_SECTION_ZOOMS, stepZoom, type ZoomSection } from "./cardZoom";
import type { DeckFinish, DeckVariant } from "./ipc";

/** The five top-level destinations in the sidebar. */
export type ViewId = "search" | "collection" | "wishlist" | "decks" | "settings";

/**
 * The deck row the open card was opened *from* — which is the whole of what the card pane
 * needs to offer "Use this printing", and nothing more.
 *
 * A slot, addressed the way every deck write addresses one: the deck, the category, and the
 * printing that is in it. Not a `deck_cards.id`, for `useDeck`'s reason — a stale row id is
 * the difference between rewriting the slot the reader is looking at and rewriting one
 * somebody else already refilled.
 */
export interface PaneDeckContext {
  /** `decks.id` is an INTEGER primary key, so this is a number all the way to the command. */
  deckId: number;
  /**
   * The `deck_categories.id` the row is filed under — what the swap is addressed by.
   *
   * **Paired with {@link categoryName} on purpose, and the pair is not redundant.** Schema v8
   * made a category a row the user names, so the word is no longer derivable from the id by a
   * lookup table the way `ZONE_LABEL` was: it lives in the deck's own `categories` list, and
   * the pane is a *sibling* of the deck editor with nothing between them but this store. The
   * pane spells the name out twice — the fold announcement and the accessible name of every
   * "Use this printing" — so the alternative is the pane holding a copy of the deck's category
   * list to translate one id with. The writer already has both in hand (the editor draws the
   * column), so it hands both over.
   */
  categoryId: number;
  /** The category's name as the deck's own column heading reads it — see {@link categoryId}. */
  categoryName: string;
  /** The printing the deck holds in that slot — the swap's `from`, and normally the card the
   *  pane is showing. */
  cardId: string;
  /**
   * **Which of the deck's two lists the row is in — the fourth part of the slot.**
   *
   * Schema v8 made a deck two lists and put `variant` in `DECK_CARD_GRAIN`, so a context naming
   * only the deck, the category and the printing names three quarters of a row. It was that for
   * one task, and the cost was measurable rather than theoretical: `useSwapFromPane` defaults to
   * `live`, so a pane opened from a **Theory** row either had its swap refused (no row matched)
   * or — where the same printing sits in the same category of *both* lists — **rewrote the live
   * row while the reader was looking at the theory one**, silently and with the right-looking
   * answer.
   *
   * Written by whichever surface opened the card, because that surface is the one that knows
   * which list it is drawing; read at `CardDetailPane`'s `useSwapFromPane` call, which is the
   * only place the swap is pressed.
   */
  variant: DeckVariant;
  /**
   * **Which object the row plays — the fifth part of the slot** (schema v18).
   *
   * `variant`'s story one column over, and the same lesson: a context naming only the deck, the
   * category, the printing and the list names four fifths of a row, because a pile can hold the
   * regular copy and the foil as two rows. Without it the pane's swap would address whichever
   * one the grain's `coalesce` matched first — the regular copy — so a reader who opened the
   * foil row and picked a new printing would watch their plain copy change instead.
   *
   * It is also what the pane's own foil button writes against, and what makes it able to open
   * showing the copy the deck actually plays.
   */
  finish: DeckFinish;
}

/** How the search results are laid out. */
export type SearchView = "table" | "grid";

interface AppState {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
  searchView: SearchView;
  setSearchView: (view: SearchView) => void;
  /** How the collection is laid out. Separate from `searchView` on purpose — the search is
   *  for looking at cards, the collection is usually for counting them. */
  collectionView: SearchView;
  setCollectionView: (view: SearchView) => void;
  /**
   * How large the card tiles are drawn, as a multiplier on whatever size a surface calls its
   * own — one of `ZOOM_STEPS` per section, all starting at `DEFAULT_ZOOM`.
   *
   * **One number per card section rather than one for the app**, which is the reverse of what this
   * comment used to argue, and the reversal was paid for on screen. The deck editor puts its
   * docked card search column *beside* the deck, so a reader zooming the column to read the art in
   * a search result was resizing the deck at the same time — and those are two different questions
   * ("how big are the cards I am browsing" against "how big is my deck laid out") that a single
   * number can only ever answer together. The old argument — that a zoom is a posture about
   * reading cards rather than a per-list setting — is still true *within* a section, which is why
   * the sections are the four walls of cards and not the five views: Stacks and Grid share `deck`,
   * because they are one pile drawn two ways.
   *
   * Session-only and deliberately so — this store is UI state, and nothing here reaches SQLite or
   * `localStorage`. See `cardZoom.ts` for why restoring it on launch would be the wrong kindness.
   */
  cardZoom: Record<ZoomSection, number>;
  /**
   * A counter that ticks on **every** zoom gesture, including the ones that change nothing.
   *
   * The zoom badge is a HUD: it appears on a gesture and fades a moment later, so something has
   * to tell it "that was a gesture" — and `cardZoom` cannot, because at either end of the ladder
   * a reader who keeps scrolling produces a stream of gestures that all leave it identical.
   * Keyed off the value, the badge would fade out under their fingers at exactly the moment they
   * are asking for more, which reads as the app having stopped listening rather than as the
   * ladder having ended. So: the pulse is the *event*, `cardZoom` is the *value*, and the timer
   * watches the pulse.
   *
   * A monotonic counter rather than a timestamp or a boolean, because both of those have a
   * degenerate repeat — `Date.now()` twice inside one frame is one value, and a flag that is
   * already `true` is not a change anything re-renders on.
   *
   * **Still a single counter, and not one per section**, even though the zooms split. It is the
   * badge's clock, and there is exactly one badge: a reader makes one gesture at a time, so a map
   * of pulses would be four timers of which three are always idle, and the badge would still have
   * to pick one to obey. {@link zoomSection} is what carries the *which* — the pulse says a
   * gesture happened, that says where.
   */
  zoomPulse: number;
  /**
   * Which section the last gesture landed in, or `null` before any gesture in this session.
   *
   * The badge draws itself over the top-right corner of the section that was zoomed rather than
   * at a fixed spot in the window, so it needs a name for that section: this is how it knows both
   * which box to measure (`zoomSectionElement`) and which of the four `cardZoom` numbers to print.
   * `null` is the honest starting value — nothing has been zoomed, so there is nothing to draw and
   * nowhere to draw it.
   */
  zoomSection: ZoomSection | null;
  /**
   * Step one section's tiles one stop bigger (`1`) or smaller (`-1`), and pulse either way.
   *
   * The section comes first because it is the subject: this is "zoom *the deck*, in", not "zoom
   * in, on the deck". It is required rather than defaulted — a surface that has not decided which
   * section it is must not silently share another surface's number, which is the defect this
   * whole shape exists to fix.
   *
   * An action rather than a `setCardZoom`, because the ladder is the point: a setter would let a
   * caller write 1.37, and the exactness `stepZoom` buys — ten values, `=== 1` meaning something
   * — survives only as long as this is the one door. It is also the only writer of `zoomPulse`
   * and `zoomSection`, which is what keeps "every gesture pulses, and the badge knows where"
   * true by construction instead of by every call site remembering to say so.
   */
  zoomCards: (section: ZoomSection, direction: 1 | -1) => void;
  /** The printing the detail pane is showing, or `null` when it is closed. */
  selectedCardId: string | null;
  setSelectedCardId: (id: string | null) => void;
  /**
   * The deck row the open card came from, or `null` — which is every card opened from
   * anywhere else, and every card at all when no pane is open.
   *
   * It is here rather than in the pane because it is written by one view (the deck editor's
   * category columns) and read by another (the card pane docked beside them), and the two are
   * siblings under `App` with nothing between them but this store.
   */
  paneDeckContext: PaneDeckContext | null;
  /**
   * Open a card **as a deck row** — the one write that sets a context, and the only way to
   * set one.
   *
   * One action rather than a pair of setters, and that is the whole design: `setSelectedCardId`
   * clears the context (see there), so "every other way of opening a card leaves no context"
   * is structural rather than a rule six call sites have to remember. Two writers use this —
   * a click on a card in a category column, and a swap that succeeded, which re-anchors the
   * pane onto the printing the deck now holds in the same slot.
   */
  openCardFromDeck: (context: PaneDeckContext) => void;
  /**
   * Show another printing of the card the pane is already on — navigation *inside* the pane,
   * from a click on a printings row.
   *
   * The third way a card id lands in the pane, and the narrowest: `setSelectedCardId` means
   * "opened from somewhere that is not a deck row" and clears the context;
   * `openCardFromDeck` means "opened as a deck row" and sets it. This means neither — the
   * reader is browsing printings of whatever is open, so the context (and with it the pane's
   * "Use this printing" offers) must survive the click.
   */
  viewPrinting: (cardId: string) => void;
  /**
   * The deck the editor is open on, or `null` when Decks is showing its gallery.
   *
   * The one navigation fact decks need, and it is here for the same reason the whole store
   * is: the editor is the Decks view in its second state rather than a screen of its own,
   * and with no router there is nowhere else for "which one" to live. Everything *about*
   * that deck is TanStack Query's — this is an id and nothing more.
   */
  openDeckId: number | null;
  setOpenDeckId: (id: number | null) => void;
  /**
   * The deck an editor has just closed, waiting for the gallery to hand the caret back to its
   * tile — written by `setOpenDeckId(null)`, read and cleared once by `DecksPage`.
   *
   * Focus is not usually state, let alone global state, and this is the one case where it has
   * nowhere else to live: the tile that opened the editor **unmounts** while the editor is up,
   * so nothing on either side of the swap can hold a reference across it. Leaving it out drops
   * the caret onto `<body>` every time a reader comes back from a deck, and the next Tab
   * restarts from the top of the app.
   */
  returnToDeckId: number | null;
  clearReturnToDeck: () => void;
  /**
   * The card a reader asked to see every printing of, and the deck slot they asked from.
   *
   * **One field, written by one action that touches nothing else.** What this replaced —
   * `pendingCardSearch` plus `requestAllPrintings` — moved the reader to the Search view and
   * cleared the open card and the open deck in the same `set`, because its destination was a
   * *view*: asking a question about a card closed the deck it was being asked about, and a
   * reader on the Collection lost their place in a filtered list to get an answer. The modal is
   * drawn over whatever is already on screen, so there is nowhere to navigate to and nothing to
   * clear — and the three fields the old channel needed (an intent, a setter that navigated, a
   * consume-once reader) collapse to a value plus an open and a close.
   *
   * The name travels with the id because the modal captions itself with the card's name, and it
   * is handed the name by the menu that opened it rather than fetching a card to say one word.
   *
   * `deck` is the slot a press writes to: non-null only where the surface that opened the menu
   * is a row of an open deck, and it is the same {@link PaneDeckContext} the card pane's swap is
   * addressed by — every one of the five parts of `DECK_CARD_GRAIN`, for the reason that type's
   * own doc gives. Null is "there is no deck row to write to", and a press then opens the card
   * pane on that printing instead.
   */
  printingsRequest: { oracleId: string; name: string; deck: PaneDeckContext | null } | null;
  /** Open the printings modal. Writes one field — see {@link printingsRequest} for why. */
  openAllPrintings: (request: {
    oracleId: string;
    name: string;
    deck: PaneDeckContext | null;
  }) => void;
  /** Close it. */
  closeAllPrintings: () => void;
  /**
   * The open deck's cards in the order the desk draws them, or `[]` when no deck editor is open.
   *
   * The printings modal's left/right keys walk this. It is here for the same reason
   * {@link paneDeckContext} is, one size up: `AllPrintingsDialog` renders at `App` level, a
   * sibling of the shell and therefore *outside* `DeckEditor`, so no React context reaches it —
   * and unlike a slot, this cannot be handed over at the moment the menu row is pressed either,
   * because it changes underneath the open modal every time the reader types in the deck's
   * filter box.
   *
   * **The whole list rather than a cursor and a pair of neighbours.** Where the reader is in it
   * is derived by *finding* {@link printingsRequest}'s own slot, through `sameDeckSlot` — so the
   * two fields cannot disagree about which card the modal is on, which a stored index and a
   * stored request could and would the first time a write reordered the deck under them.
   *
   * **Only the editor writes it, and it is the editor's order rather than the deck's.** It is
   * `deckWalkStops(groups, deckId)` — the piles as `splitRail` lays them out, each pile's cards
   * as `sortBy` ordered them, narrowed by whatever the toolbar's text box and tag chips are
   * narrowing. That is what the reader is looking at, and it is knowable nowhere else: `groupBy`
   * and `sortBy` are `useState` inside that component.
   *
   * `[]` is "there is no walk", written on the editor's unmount. A stale walk through a deck
   * that is no longer open would step a modal opened from the Collection into somebody's
   * Sideboard.
   */
  deckWalk: DeckWalkStop[];
  /** Publish the walk. One field, like {@link openAllPrintings} — nothing about the open card,
   *  the open deck or the view is this write's business. */
  setDeckWalk: (stops: DeckWalkStop[]) => void;
}

/**
 * One stop on {@link AppState.deckWalk}: **exactly the shape {@link AppState.openAllPrintings}
 * takes**, so a step is one call and nothing between the deck editor and the modal has to
 * reassemble a request.
 *
 * `deck` is non-nullable where {@link AppState.printingsRequest}'s own `deck` is not, and that
 * difference is the whole of what this type is: that field is `null` for every surface which is
 * not a deck row, and a walk is made of nothing but deck rows.
 *
 * **Here rather than in `features/decks/deckWalk.ts`, where the stops are built**, for
 * {@link PaneDeckContext}'s reason: it is an address this store carries between two surfaces that
 * cannot see each other, and `lib` sits underneath `features`. `deckWalk.ts` re-exports it, so
 * the callers who reach for it beside `deckWalkStops` still find it there.
 */
export interface DeckWalkStop {
  /** Non-null, unlike `DeckCard.oracleId` — a row with no oracle id is not a stop at all, since
   *  an orphan whose printing has left the corpus has no printings to walk to. */
  oracleId: string;
  /** `deck_cards.name`, denormalized at write time, so an orphaned row still has one. The modal
   *  captions itself with this rather than fetching a card to say one word. */
  name: string;
  /** The row this stop *is*, as every write to it is addressed — all five parts of the grain
   *  plus the category's name. See {@link PaneDeckContext}. */
  deck: PaneDeckContext;
}

/** The one empty walk — see {@link AppState.setDeckWalk} for why there is only one of it. */
const NO_WALK: DeckWalkStop[] = [];

/**
 * UI state that outlives a single component tree.
 *
 * Deliberately not a router: this is a single-window desktop app with no URLs, no
 * history and no deep links, so a store is the whole of what a router would provide.
 * Server-ish state (cards, sync status) does not belong here — that is TanStack Query's
 * job and `useSync`'s.
 */
export const useAppStore = create<AppState>((set) => ({
  activeView: "search",
  // Leaving the view closes the card: the detail pane belongs to the list that opened it,
  // and a card sitting beside the Decks placeholder is a pane with nothing to be next to.
  // The open deck goes with it, for the same reason read the other way round: an editor is
  // the Decks view, so a deck left open through a trip to Settings would be waiting behind
  // the sidebar with the gallery it was opened from nowhere in sight.
  setActiveView: (activeView) =>
    set({
      activeView,
      selectedCardId: null,
      paneDeckContext: null,
      openDeckId: null,
      returnToDeckId: null,
    }),
  // Art by default: this is a card app, and the table is the view you switch to when you
  // are comparing prices rather than looking at cards.
  searchView: "grid",
  setSearchView: (searchView) => set({ searchView }),
  // The table by default, where the search takes the art: a collection is read for what is
  // in it — counts, conditions, what it is worth — and forty tiles answer none of that.
  collectionView: "table",
  setCollectionView: (collectionView) => set({ collectionView }),
  // A copy, not the constant itself. `Readonly<>` is a compile-time fence and nothing more, so an
  // in-place `state.cardZoom.deck = …` would write *through* the initial state into the exported
  // `DEFAULT_SECTION_ZOOMS` — and several suites reset this store from it, so the damage would
  // surface as an unrelated test file going red long after the write. One spread buys that off.
  cardZoom: { ...DEFAULT_SECTION_ZOOMS },
  zoomPulse: 0,
  zoomSection: null,
  // Only the named section's number moves; the other three are copied across untouched, which is
  // the whole of "zooming the deck editor's search column leaves the deck alone".
  //
  // The pulse is outside the `if` that the clamp would tempt you to write, and that is the whole
  // reason it exists as a second field: `stepZoom` answers a gesture at 200% with 200%, so a badge
  // keyed off `cardZoom` would go quiet exactly while the reader is still scrolling. Zustand
  // notices this even when the zoom did not move, because the pulse did — and `zoomSection` is
  // written on every gesture for the same reason, so a clamped one still aims the badge.
  zoomCards: (section, direction) =>
    set((s) => ({
      cardZoom: { ...s.cardZoom, [section]: stepZoom(s.cardZoom[section], direction) },
      zoomPulse: s.zoomPulse + 1,
      zoomSection: section,
    })),
  selectedCardId: null,
  // **And forgets which deck row the last card came from.** Every surface in the app that
  // opens a card goes through here — search tiles, collection rows, wishlist rows, the docked
  // panel's tiles, the validation panel's card names, and the pane's own close — and every one
  // of them opens something that is *not* the deck row the context named. Clearing it here is
  // what makes that true by construction instead of by six call sites remembering to say so;
  // the one surface that does mean it says so through `openCardFromDeck`.
  setSelectedCardId: (selectedCardId) => set({ selectedCardId, paneDeckContext: null }),
  paneDeckContext: null,
  openCardFromDeck: (paneDeckContext) =>
    set({ selectedCardId: paneDeckContext.cardId, paneDeckContext }),
  // Deliberately not touching `paneDeckContext` — see the interface doc.
  viewPrinting: (selectedCardId) => set({ selectedCardId }),
  // Decks opens on the gallery: a deck is something the reader picks, and reopening the last
  // one would be a decision made for them by the previous session.
  openDeckId: null,
  // Closing an editor remembers which deck it was, so the gallery it returns to can put the
  // caret back on that tile. Opening one leaves the note alone: it is consumed on arrival.
  // Closing or opening an editor also drops the deck row the card pane was anchored to: the
  // affordance it carries writes to a deck the reader can see, and with the gallery on screen
  // there is no editor to answer for the write or to re-read after a refusal. The card itself
  // stays open — the pane belongs to the reader, not to the view behind it.
  setOpenDeckId: (openDeckId) =>
    set((s) => ({
      openDeckId,
      paneDeckContext: null,
      returnToDeckId: openDeckId === null ? s.openDeckId : s.returnToDeckId,
    })),
  returnToDeckId: null,
  clearReturnToDeck: () => set({ returnToDeckId: null }),
  printingsRequest: null,
  // One field, and that is the whole point — see the interface. Its predecessor wrote six in
  // this `set` because it was a navigation; a modal drawn over the app is not one, so nothing
  // here has an opinion about the view, the open card or the open deck behind it.
  openAllPrintings: (printingsRequest) => set({ printingsRequest }),
  closeAllPrintings: () => set({ printingsRequest: null }),
  // No walk until a deck editor publishes one, and back to this the moment it unmounts.
  deckWalk: NO_WALK,
  // **An empty walk is always the same empty array**, which is what makes clearing one that is
  // already clear free: zustand compares a subscriber's selected slice with `Object.is`, so a
  // fresh `[]` on every teardown is a new identity and re-renders whoever is reading the walk —
  // including the closed modal, which selects this field to decide nothing at all. Collapsed
  // here rather than at the call site so that it holds for every caller rather than for the one
  // that remembered.
  //
  // Deliberately not cleared in `setOpenDeckId` or `setActiveView` beside `paneDeckContext`:
  // those two are *navigations*, and this is a fact about what is drawn, which only the editor
  // drawing it knows. A second writer would be a second place for the two to disagree.
  setDeckWalk: (stops) => set({ deckWalk: stops.length === 0 ? NO_WALK : stops }),
}));
