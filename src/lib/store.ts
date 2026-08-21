import { create } from "zustand";
import {
  DEFAULT_SECTION_ZOOMS,
  isZoomSection,
  snapZoom,
  stepZoom,
  type ZoomSection,
} from "./cardZoom";
import type { Condition } from "./conditions";
import { defaultFields } from "@/features/transfer/fields";
import type { TransferFieldId, TransferSurface } from "@/features/transfer/fields";
import type { ExportFormat } from "@/features/transfer/formats";
import type { DeckFinish, DeckVariant } from "./ipc";

/** The six top-level destinations in the sidebar. */
export type ViewId = "search" | "tags" | "collection" | "wishlist" | "decks" | "settings";

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
  /** How the wishlist is laid out. Its own field beside the other two, not a third reader of
   *  either — the three lists are looked at for three different reasons, and a reader who put
   *  their collection in a table was not saying anything about their shopping list. */
  wishlistView: SearchView;
  setWishlistView: (view: SearchView) => void;
  /**
   * How the Tags page's wall is laid out. A fourth field rather than a fourth reader of
   * `searchView`, for the reason the other three split: a reader who put the search in a table
   * to compare prices was not saying anything about a wall they browse *by motif*, and the two
   * pages are read one after the other rather than instead of each other.
   *
   * The Tags page draws `FilterBar`, whose layout pair is bound to a stored preference — so
   * without a field of its own that pair would move the **search's** while changing nothing the
   * reader can see on the search page, which is the "control that lies" the deck panel's
   * `layoutToggle={false}` exists to avoid.
   */
  tagsView: SearchView;
  setTagsView: (view: SearchView) => void;
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
   * **Restored at launch since issue #175**, which reverses the second half of what this comment
   * used to say. The store is still UI state and still reaches nothing itself: the value lives in
   * one `app_meta` row, and `useCardZoomPersistence` — mounted once, in `AppShell` — is the only
   * thing that reads or writes it. `cardZoom` is built out of `DEFAULT_SECTION_ZOOMS` and seeded
   * a round trip later through {@link hydrateCardZoom}, so every wall is drawable from the first
   * frame whatever storage eventually says.
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
  /**
   * Seed the sections from what the database remembered, once, at launch.
   *
   * The **second** door onto `cardZoom`, and it holds the same guarantee the first one does:
   * every value goes through `snapZoom`, so the store still only ever holds one of the sixteen exact
   * stops and `zoom === 1` stays a question worth asking. What arrives is `Record<string, number>`
   * rather than a typed map, because it is a JSON object written by some build of this app — a
   * key that is not a section this build draws (`isZoomSection` says no) is dropped rather than
   * trusted, and a section the row says nothing about keeps the default it was built with.
   *
   * **It does not pulse, and that is the point of it being separate from {@link zoomCards}.** The
   * badge is a HUD about a gesture; a value arriving from storage is not one, and pulsing here
   * would greet every launch with a percentage floating in the corner of a wall nobody touched.
   *
   * **A gesture already made wins**, which is what `zoomPulse !== 0` buys. The read is a round
   * trip, so a reader who spins the wheel inside it would otherwise have their new size
   * overwritten by last session's a moment later — a wall visibly snapping back under their hand,
   * with nothing on screen explaining it. Whole-store rather than per-section because that is what
   * the pulse can answer, and the case is a sub-second window in which the reader has, by
   * definition, only reached one wall: dropping the whole seed there costs at most the other six
   * their memory for one session, and no reader can tell that from having zoomed them back.
   */
  hydrateCardZoom: (stored: Readonly<Record<string, number>>) => void;
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
   *
   * **`cardId` is the printing the reader asked *from*, and it does two things a deck slot used
   * to do alone.** It is the wall's "you are here" mark — the tile the question was asked about,
   * which on a deck row is the printing that row plays and on every other surface is the row the
   * menu was opened on; and it is how the modal finds its place on {@link cardWalk} where the
   * stops are not deck rows, because a list of search results has no `DECK_CARD_GRAIN` to be
   * addressed by. It is **not** derived from `deck` even where there is one: `PaneDeckContext`
   * carries the same id, and one of the two would have to be the definition — this is the one
   * every surface can answer, so it is the one the modal reads.
   */
  printingsRequest: PrintingsRequest | null;
  /** Open the printings modal. Writes one field — see {@link printingsRequest} for why. */
  openAllPrintings: (request: PrintingsRequest) => void;
  /** Close it. */
  closeAllPrintings: () => void;
  /**
   * **The list the reader is standing in**, in the order it is drawn — the open deck's cards,
   * the search results, the collection, the wishlist — or an empty walk when whatever is on
   * screen has no list of cards on it.
   *
   * The printings modal's left/right keys walk this. It is here for the same reason
   * {@link paneDeckContext} is, one size up: `AllPrintingsDialog` renders at `App` level, a
   * sibling of the shell and therefore *outside* every view, so no React context reaches it —
   * and unlike a slot, this cannot be handed over at the moment the menu row is pressed either,
   * because it changes underneath the open modal every time the reader types in the deck's
   * filter box or the search's.
   *
   * **The whole list rather than a cursor and a pair of neighbours.** Where the reader is in it
   * is derived by *finding* {@link printingsRequest}'s own stop — through `sameDeckSlot` for a
   * deck row and through `cardId` for everything else — so the two fields cannot disagree about
   * which card the modal is on, which a stored index and a stored request could and would the
   * first time a write reordered the list under them.
   *
   * **One writer at a time, and `ActiveView` is what guarantees it**: exactly one of the five
   * views is mounted, so the deck editor and the three card lists can never publish over each
   * other. The order is the drawing surface's own and is knowable nowhere else — the editor's
   * `groupBy` and `sortBy` are `useState` inside that component, and a page's rows are a query
   * narrowed by a filter bar.
   *
   * **The deck editor's docked search panel deliberately publishes nothing.** The editor already
   * owns the walk while it is open, and a panel that overwrote it would step a modal opened from
   * a *deck row* through a list of search results. A modal opened from that panel finds no stop
   * and gets no chevrons, which is the honest answer rather than a wrong walk.
   *
   * Empty is "there is no walk", written on the publishing surface's unmount. A stale walk
   * through a deck that is no longer open would step a modal opened from the Collection into
   * somebody's Sideboard.
   */
  cardWalk: CardWalk;
  /** Publish the walk. One field, like {@link openAllPrintings} — nothing about the open card,
   *  the open deck or the view is this write's business. */
  setCardWalk: (walk: CardWalk) => void;
  /**
   * The format and field set each surface was last exported with.
   *
   * **Per surface rather than globally**: a deck export wants Moxfield's printing line and a
   * collection export wants a CSV with a condition column, and one remembered setting would
   * make each of them wrong half the time.
   */
  exportPrefs: Record<TransferSurface, { format: ExportFormat; fields: TransferFieldId[] }>;
  setExportPrefs: (
    surface: TransferSurface,
    prefs: { format: ExportFormat; fields: TransferFieldId[] },
  ) => void;
  /**
   * What a bulk import line that says nothing becomes — the collection's condition and finish,
   * and the wishlist's finish alone (it draws the same field and ignores `condition`, which is
   * this app's collection-only vocabulary).
   *
   * **One shared pair rather than one per surface**, unlike {@link exportPrefs}: a reader who has
   * just told the collection's import "assume Near Mint, foil" is answering a question about
   * *their box*, not about the collection screen — so a wishlist import opened next re-reads the
   * same answer rather than asking again. `NM` matches Rust's `DEFAULT_CONDITION`.
   */
  importDefaults: { condition: Condition; finish: DeckFinish };
  setImportDefaults: (defaults: { condition: Condition; finish: DeckFinish }) => void;
}

/**
 * The question the printings modal is open on — see {@link AppState.printingsRequest}, which is
 * the only field of this shape and where every part of it is argued.
 *
 * Named and exported rather than written inline three times, because it is written down in three
 * places that must not drift: the store's field, the card menu's `openAllPrintings` dependency,
 * and the modal body's own prop.
 */
export interface PrintingsRequest {
  /** The printing the question was asked *from*. */
  cardId: string;
  /** The oracle card whose printings are listed. */
  oracleId: string;
  /** What the modal captions itself with. */
  name: string;
  /** The deck row a press writes to, or `null` where there is none. */
  deck: PaneDeckContext | null;
}

/**
 * One stop on {@link AppState.cardWalk}: **exactly the shape {@link AppState.openAllPrintings}
 * takes**, so a step is one call and nothing between the drawing surface and the modal has to
 * reassemble a request.
 *
 * `deck` carries the same meaning it does on {@link AppState.printingsRequest} — the row a press
 * inside the modal *writes to*, or `null` on a surface whose rows are not deck rows. It is what
 * tells the two kinds of stop apart, and the modal needs them told apart at both ends: a step
 * onto a deck stop re-anchors the card pane to that row (`openCardFromDeck`), and a step onto a
 * plain one opens the card the way every non-deck surface in this app does (`setSelectedCardId`,
 * which clears the context — see there).
 *
 * **Here rather than in `features/decks/deckWalk.ts`, where the deck's stops are built**, for
 * {@link PaneDeckContext}'s reason: it is an address this store carries between two surfaces that
 * cannot see each other, and `lib` sits underneath `features`. `deckWalk.ts` re-exports it, so
 * the callers who reach for it beside `deckWalkStops` still find it there.
 */
export interface CardWalkStop {
  /**
   * The printing this stop is: what the card pane opens on, what the wall rings, and — for a
   * plain stop — how the modal finds its place on the walk.
   *
   * On a deck stop it is the same id as `deck.cardId` and is written from that one field, so
   * the two cannot drift. It is spelled out here anyway because it is the only part of a stop
   * every surface can answer, and the modal reads it without asking which kind of stop it has.
   */
  cardId: string;
  /** Non-null, unlike `DeckCard.oracleId` and `CardSummary.oracleId` — a row with no oracle id
   *  is not a stop at all, since an orphan whose printing has left the corpus has no printings
   *  to walk to. */
  oracleId: string;
  /** The card's name. On a deck row that is `deck_cards.name`, denormalized at write time, so an
   *  orphaned row still has one. The modal captions itself with this rather than fetching a card
   *  to say one word. */
  name: string;
  /** The deck row this stop *is*, as every write to it is addressed — all five parts of the
   *  grain plus the category's name (see {@link PaneDeckContext}) — or `null` where the surface
   *  drawing the list is not a deck. */
  deck: PaneDeckContext | null;
}

/**
 * A list of cards a reader can be walked along, and what to call it.
 *
 * **`label` is a noun phrase and it is the surface's own**: it is read straight into the step
 * chevrons' names — `Next card in your collection, Lightning Bolt` — and a chevron that said
 * "in the deck" over the wishlist would be the one part of this feature that lies. Each
 * publishing surface says its own once; there is no default, because a default is exactly how
 * one of them would come to say somebody else's noun.
 */
export interface CardWalk {
  label: string;
  stops: CardWalkStop[];
}

/** The one empty walk — see {@link AppState.setCardWalk} for why there is only one of it. */
const NO_WALK: CardWalk = { label: "", stops: [] };

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
  // Art by default, with the search rather than with the collection: a wishlist is what the
  // reader is going shopping for, and the cards on it are ones they have not held — the
  // picture is how you recognise the thing you are about to buy. The table is a press away
  // for the trip where the question is what it all costs.
  wishlistView: "grid",
  setWishlistView: (wishlistView) => set({ wishlistView }),
  // Art by default, and this is the one of the four where the grid is not merely the better
  // opening but the whole point: the page's question is "what does this illustration show",
  // and a table of set codes and prices answers none of it. The table is still a press away
  // for the trip where the question is what a themed deck would cost.
  tagsView: "grid",
  setTagsView: (tagsView) => set({ tagsView }),
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
  // No pulse and no `zoomSection`: this is a value arriving, not a gesture happening. See the
  // interface above for the `zoomPulse !== 0` guard, which is the whole of "a reader who zoomed
  // during the read keeps what they asked for".
  hydrateCardZoom: (stored) =>
    set((s) => {
      if (s.zoomPulse !== 0) return {};
      const cardZoom = { ...s.cardZoom };
      for (const [section, zoom] of Object.entries(stored)) {
        if (isZoomSection(section)) cardZoom[section] = snapZoom(zoom);
      }
      return { cardZoom };
    }),
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
  // No walk until a surface with a list of cards on it publishes one, and back to this the
  // moment that surface unmounts.
  cardWalk: NO_WALK,
  // **An empty walk is always the same object**, which is what makes clearing one that is
  // already clear free: zustand compares a subscriber's selected slice with `Object.is`, so a
  // fresh `{ label, stops: [] }` on every teardown is a new identity and re-renders whoever is
  // reading the walk — including the closed modal, which selects this field to decide nothing at
  // all. Collapsed here rather than at the call site so that it holds for every caller rather
  // than for the one that remembered — and the label goes with the stops, because a walk with no
  // stops has no list to name.
  //
  // Deliberately not cleared in `setOpenDeckId` or `setActiveView` beside `paneDeckContext`:
  // those two are *navigations*, and this is a fact about what is drawn, which only the surface
  // drawing it knows. A second writer would be a second place for the two to disagree.
  setCardWalk: (walk) => set({ cardWalk: walk.stops.length === 0 ? NO_WALK : walk }),
  // A collection opens on CSV because that is the only format that can carry a condition, and a
  // collection without conditions is a card list rather than a record of what the reader owns.
  exportPrefs: {
    deck: { format: "plain", fields: defaultFields("plain", "deck") },
    collection: { format: "csv", fields: defaultFields("csv", "collection") },
    wishlist: { format: "plain", fields: defaultFields("plain", "wishlist") },
  },
  setExportPrefs: (surface, prefs) =>
    set((s) => ({ exportPrefs: { ...s.exportPrefs, [surface]: prefs } })),
  importDefaults: { condition: "NM", finish: null },
  setImportDefaults: (importDefaults) => set({ importDefaults }),
}));
