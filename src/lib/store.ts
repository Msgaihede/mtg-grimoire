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
   * A card the reader asked to see every printing of, waiting for Search to pick it up.
   *
   * `useCardSearch` keeps every filter in component-local `useState` inside `SearchPage`, so
   * nothing outside that component can set one — and "View all printings" is pressed from every
   * card surface, nearly all of which are not Search. This is the channel, and it is the same
   * shape as {@link returnToDeckId}: written by one view, read and cleared once by another.
   *
   * The name travels with the id because the chip that draws the filter says the card's name,
   * and Search would otherwise have to fetch a card to caption a filter it was handed.
   */
  pendingCardSearch: { oracleId: string; name: string } | null;
  /** Go to Search and show every printing of one card. Sets `activeView` too. */
  requestAllPrintings: (target: { oracleId: string; name: string }) => void;
  /** Read it once and clear it. Returns null when there is nothing waiting. */
  consumePendingCardSearch: () => { oracleId: string; name: string } | null;
}

/**
 * UI state that outlives a single component tree.
 *
 * Deliberately not a router: this is a single-window desktop app with no URLs, no
 * history and no deep links, so a store is the whole of what a router would provide.
 * Server-ish state (cards, sync status) does not belong here — that is TanStack Query's
 * job and `useSync`'s.
 */
export const useAppStore = create<AppState>((set, get) => ({
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
  pendingCardSearch: null,
  // The intent and the navigation in **one** `set`, because `setActiveView` clears the open
  // deck and the open card — calling it separately would either clear the intent or race it.
  // The clears themselves are wanted: leaving the view closes the deck, as it always has.
  requestAllPrintings: (pendingCardSearch) =>
    set({
      pendingCardSearch,
      activeView: "search",
      selectedCardId: null,
      paneDeckContext: null,
      openDeckId: null,
      returnToDeckId: null,
    }),
  // Read once. A reader who clears the filter and comes back to Search must not find it
  // re-applied — the same reason `clearReturnToDeck` exists.
  consumePendingCardSearch: () => {
    const pending = get().pendingCardSearch;
    if (pending !== null) set({ pendingCardSearch: null });
    return pending;
  },
}));
