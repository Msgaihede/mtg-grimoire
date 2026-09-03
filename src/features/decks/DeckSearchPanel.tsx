import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { OwnedBadge } from "@/components/OwnedBadge";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardGrid } from "@/features/search/CardGrid";
import { FilterBar } from "@/features/search/FilterBar";
import { summaryOf } from "@/features/search/SearchPage";
import { useCardSearch, type FormatFilterOption } from "@/features/search/useCardSearch";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CardSummary, type DeckCategory } from "@/lib/ipc";
import { statusLine, TRANSITION } from "@/lib/motion";
import { pricesAsOf } from "@/lib/prices";
import { priceRange } from "@/lib/priceRange";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, autoCategoryFor } from "./autoCategory";
import { CollectionSearchTab } from "./CollectionSearchTab";
import { cardDraggable } from "./dnd";
import type { Deck } from "./useDeck";
import { useDeckSearchOpen } from "./useDeckSearchOpen";

/** Why the disclosure will not open, said where it is refused. */
const NO_ROOM = "Not enough room — close the card details or widen the window";

/**
 * Stamped on this panel while it is drawn **over** the deck rather than docked beside it — the
 * phone case, where the desk cannot hold {@link MIN_PANEL_WIDTH_PX} and the deck's floor at once.
 *
 * **A sibling of `DeckEditor`'s `PANE_OVER_ATTR` and deliberately not that attribute.** That one
 * says which of the desk's two columns the *card pane* covers, and a second element answering
 * `[data-pane-over]` would make the editor's own probes ambiguous. What is reused is the
 * argument, word for word: the difference between the two placements is a `position` and a
 * width, both of which jsdom reads as nothing, so the *choice* is stamped where a suite and a
 * CDP pass can both ask about it and the geometry stays a live-window question.
 */
export const SEARCH_OVER_ATTR = "data-search-over";

/**
 * How wide the panel is **when it is first opened**, in px — the reader may then drag its edge
 * (see {@link ResizeHandle}), and this is where every deck starts.
 *
 * The direction's docked column is 320 and this is 384, and the reason is the wall rather than
 * the filter row: 320 leaves **267** inside the panel's padding, the wall's padding and the
 * scrollbar, which is one tile at any size a card is still legible at (two would be 127px
 * each). 384 leaves 331 and holds two. The filter row is the smaller half of it — the
 * mana-value chips are ten 36px squares 4px apart, **396px**, which `flex-wrap` now breaks onto
 * a second line here and leaves alone in the two full-width filter bars.
 *
 * Measured in the running window at 1280×800: header 36, filter row 168 (four wrapped lines),
 * count line 16, and 341px of card wall.
 *
 * **A pixel default rather than a share of the window**, deliberately, while the *cap* on a drag
 * is a share of it ({@link DeckSearchPanelProps.maxWidth}). A deck opened on a 2560px monitor
 * would otherwise start with a 768px search column nobody asked for; 384 is a column, and what
 * a wider window buys is room to drag rather than a wider default.
 */
export const DEFAULT_PANEL_WIDTH_PX = 384;

/**
 * The narrowest the panel may be dragged, in px — **and the width the editor decides "there is
 * no room for this at all" by**, which is the whole reason it is a measurement rather than a
 * round number.
 *
 * One card, and the chrome around it: a 150px tile ({@link TILE_BASE}), the panel's own left
 * border and padding (1 + 12), the wall's border and padding (2 + 24) and the wall's scrollbar
 * (15, measured — not the 17 an older note here guessed) — **204**, taken as **206** for two
 * pixels of slack. Driven in the shipped window on 2026-08-14, a panel held at this width
 * measured **152px** of wall inside it: one 150px tile with a pixel either side of it. Below it
 * the wall cannot draw a whole card at the size this column is scoped for, and a search column
 * with no card in it is a filter row taking width off the deck.
 *
 * That is what the rail is for. `DeckEditor` compares this against what the desk can spare, so
 * a window too narrow for one card collapses the panel to its rail rather than squeezing it —
 * and the width the reader had dragged to is still here when the room comes back, because this
 * component stays mounted through a railing.
 */
export const MIN_PANEL_WIDTH_PX = 206;

/** How far one arrow press moves the edge. A pointer drags continuously; a caret needs a step
 *  big enough to be worth pressing and small enough to aim with. */
const RESIZE_STEP_PX = 24;

/**
 * How wide a tile is in here at 100%, and the number that decides whether this column shows one
 * card or two at its opening width.
 *
 * 384 is **331** by the time the panel's own left padding (12), the scrollbar (17) and the
 * wall's padding (24) are off it — measured at 330 in the running window — which is 23 short
 * of two of `CardGrid`'s standard 170px tiles. At the standard size this column drew one
 * 330×490 card per row inside a 341px-tall wall: less than a whole card, ever. At 150 the same
 * 331 is two tiles with 19px of gutter split either side, which is the "~2 tiles per row" this
 * panel was scoped around.
 *
 * **All of that describes 100% zoom at the opening width, and only that.** Two things move it
 * now and both are the reader's: `CardGrid` scales this by the zoom held for **this column's own
 * section** (`deckSearch` — every card section carries its own number), so at 2× the column
 * draws one 300px tile and at 0.5× four 75px ones; and the panel itself is draggable, so the 331
 * is only where it starts. Neither needs an override here — the measurement is what sets the
 * resting value, and everything downstream is arithmetic on it.
 */
const TILE_BASE = 150;

/**
 * Whether a tile's card is a Commander **game changer**, for the crown `CardArt` draws in the
 * tile's top-right chip.
 *
 * The same wall over the same rows, so it says the same thing: `gameChanger` is a fact about the
 * *card* and not about the view it is drawn in, and a card crowned on the search page and bare
 * here would teach the reader that the mark means something about the wall. It is this panel a
 * Commander deck is actually built out of, so this is where the fact is worth most.
 *
 * The chip is shared with the finish mark and holds the crown alone here, because this wall
 * passes no `finish` — its tiles are 150px and the sheen is the search view's.
 *
 * Module scope, which is what `CardGrid` asks of every per-card callback it takes: a tile
 * re-registers its drag when a callback in its ref's dependency list changes identity, and this
 * panel re-renders on every keystroke in its search box. `tileRef` below is held still for
 * exactly that reason, and this is held the same way so the wall's rule has no exception to
 * remember — the search view holds `tileFinish` and `tileDrag` at module scope for both.
 */
const tileGameChanger = (card: CardSummary) => card.gameChanger;

/**
 * Which of the two searches this column is showing.
 *
 * `"collection"` reads the reader's own binder — collection *rows*, one per printing, finish and
 * condition, with where each copy is filed — and `"all"` is the card search this panel has always
 * been, over every printing Scryfall has published.
 */
export type DeckSearchTab = "collection" | "all";

/**
 * The strip, as data — the shape {@link TABS}' `.map` is the whole of the control.
 *
 * **Two short words rather than "Collection Search" and "Normal Search", and the reason is a
 * measurement rather than taste.** This panel is dragged down to {@link MIN_PANEL_WIDTH_PX}, whose
 * content box measures **193px**. Driven headless over the built stylesheet at that width: the
 * strip is **141px** at these labels and **216px** at the spec's, and a segmented pair cannot wrap
 * inside itself without breaking the one rounded box it is drawn as. So the long labels put the
 * row at `scrollWidth` **216** against a `clientWidth` of **193** — a 23px overhang, which is the
 * `ManaValueChips` failure exactly (`src/CLAUDE.md`) — while these wrap under the disclosure at
 * **193/193** and the panel itself reads **205/205**. The spec's words survive as what this page's
 * prose calls the two tabs.
 *
 * **Collection first**, for `DeckEditor`'s Theory/Live reason read across: the first tab is the one
 * the panel opens on, and a reader arriving on the second half of a switch has to work out what
 * the first half was.
 */
const TABS = [
  { id: "collection", label: "Collection" },
  { id: "all", label: "All cards" },
] as const satisfies readonly { id: DeckSearchTab; label: string }[];

/**
 * Where the reader's answer about *which* search is kept for the life of the window.
 *
 * Exported for `DECK_SEARCH_OPEN_KEY`'s reason: a test or a story that wants the panel to open on
 * the card search seeds the cache rather than pressing the control, and a key spelled twice is a
 * key that drifts.
 */
export const DECK_SEARCH_TAB_KEY = ["deckSearchTab"];

/** Whether a value out of the cache is a tab this build draws — `isPrintingGroupBy`'s shape, and
 *  its reason: the entry is untyped at the cache and a story or an older build may have put
 *  anything in it. */
function isDeckSearchTab(value: unknown): value is DeckSearchTab {
  return TABS.some(({ id }) => id === value);
}

/**
 * The tab a reader who has never pressed one gets — **the collection, and that is the product
 * decision this whole change is** (spec §7.2).
 *
 * A deck is built out of cards you have. A search of everything ever printed is what you reach for
 * when your own binder does not answer, so it is the thing one press away rather than the thing in
 * front of you; until now this panel had it the other way round and there was no way to search a
 * collection from a deck at all.
 */
export const DEFAULT_DECK_SEARCH_TAB: DeckSearchTab = "collection";

/**
 * Which search the reader last chose — remembered across decks, for the length of the session.
 *
 * **The query cache rather than a `useState` here, for {@link useDeckSearchOpen}'s reason and with
 * one difference.** The editor is keyed on the deck id, so leaving a deck and coming back tears
 * this panel down and builds a new one; state held in it would put a reader who works from the
 * wider search back on the collection tab on every deck they opened, which is exactly the
 * complaint that moved the disclosure into `app_meta` (issue #183). The cache is app-scoped —
 * one `QueryClient` per process — so it survives a remount the way that setting does.
 *
 * **The difference is that there is no command behind this one**, so the memory ends with the
 * window. That is deliberate rather than pending: `SCHEMA_VERSION` does not move for this PR, and
 * a tab is a smaller answer than a disclosure — which of two searches you last used is a fact
 * about the deck-building you are in the middle of, where "do I work with a search column at all"
 * is a standing preference. If it turns out to want an `app_meta` row, this hook is the one place
 * that changes and every reader of it is already going through {@link DECK_SEARCH_TAB_KEY}.
 *
 * `staleTime`/`gcTime: Infinity` are what make "for the session" literal: nothing else writes this
 * entry, so there is nothing to go stale against, and without the second the entry is collected
 * once the last editor closes and the next deck opens on the default again.
 */
function useDeckSearchTab(): { tab: DeckSearchTab; setTab: (tab: DeckSearchTab) => void } {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DECK_SEARCH_TAB_KEY,
    // Never actually run once a value is in the cache, and the honest answer if it ever is — a
    // fetch here can only mean the entry was thrown away, and the default is what a session with
    // no press in it means.
    queryFn: () => DEFAULT_DECK_SEARCH_TAB,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setTab = useCallback(
    (tab: DeckSearchTab) => queryClient.setQueryData(DECK_SEARCH_TAB_KEY, tab),
    [queryClient],
  );

  const stored = query.data;
  // Narrowed on the way out rather than trusted: `undefined` is the first render, before the
  // resolved `queryFn` has landed, and a seeded entry is whatever the seeder wrote.
  return { tab: isDeckSearchTab(stored) ? stored : DEFAULT_DECK_SEARCH_TAB, setTab };
}

export interface DeckSearchPanelProps {
  /**
   * The editor's own `useDeck().addCard`, handed down rather than mounted again here — the
   * shape every other control in this editor takes: the four views are handed a
   * `DeckCardActions` of plain callbacks (`cardControl.tsx`) and reach for no hook of their own.
   *
   * Handed down rather than re-mounted for a measured reason: `useDeck` carries the deck's
   * *read* with it, and a second observer of `["decks","detail",id]` subscribing after the
   * first has settled is a background refetch on a query whose `staleTime` is zero — one
   * extra `deck_get` every time a deck is opened, and, where a test scripts consecutive
   * answers, the second one arriving a beat early.
   */
  add: Deck["addCard"];
  /**
   * A press on this panel's Add button landed in a deck row — `EntryChange.id`, which is the row
   * the write **created or folded into**.
   *
   * It exists because this panel is the one add path in the editor that does not go through the
   * editor's own `addTo`: it holds the mutation and presses it itself, which is what makes the
   * button predictable (see the button's own note on never being disabled). The editor marks
   * that row as freshly landed for five seconds so the reader can find it in a deck they are not
   * looking at, and nothing here knows or cares what it does with it.
   *
   * Optional, so a story or a test can mount this panel with a mutation and nothing else.
   */
  onAdded?: (entryId: number) => void;
  /*
   * **The own/need pair stood here from 2026-08-23 to 2026-08-25 and is gone.**
   *
   * It was `mode`/`onMode`, drawn as a segmented pair beside the disclosure, and it decided what
   * this tab's Add button *wrote*: a `deck_cards` row that reads as missing, or a move of a copy
   * the reader already had. Two things retired it. It was reported as clutter on the one row this
   * column can least afford, and — the reason it is a deletion rather than a relocation — the
   * **Collection tab is the better answer to the question it asked**: it searches the copies the
   * reader actually holds, names the deck a spoken-for copy would be taken from, and asks before
   * taking it. "I own this" done from a wall of Scryfall printings was the same write with none
   * of that.
   *
   * Every add from this panel therefore means "I need this" — `DEFAULT_ADD_MODE`, which is what
   * a reader who never pressed the pair already got. `useDeck.addCard`'s `owned` arm and
   * `NormalSearchAdd`'s hunt for a free copy went with it.
   */
  /**
   * Where a card may be put, in the order the select offers them — the editor's own list of
   * the open deck's categories, so this panel offers exactly the columns beside it.
   *
   * Not in the plan's sketch of this interface, and it has to be: the alternative is a second
   * component reading the deck's categories beside the one that already has them, which is how
   * a panel starts offering a pile the editor is not drawing.
   */
  categories: readonly DeckCategory[];
  /**
   * The deck this column is docked beside — what {@link CollectionSearchTab}'s write is
   * addressed with.
   *
   * **Passed rather than inferred**, and the inference it replaces is worth naming because it
   * worked: the tab used to read `categories[0].deckId`, on the true observation that every
   * category of one deck carries the same id and that `deck_create` seeds four of them in the
   * deck's own transaction. It is still an inference from a list that is a *different* fact, and
   * the editor holds the id itself — so a deck with no categories (a state only a story or a
   * half-answered query can be in) silently disabled the write instead of being a case nobody
   * has to think about.
   */
  deckId: number;
  /**
   * The category every add from this panel lands in, by id — `AUTO_CATEGORY` (`0`) for "let
   * each card's own text decide", which is what a deck is born on.
   *
   * **Read-only here, and that is the change of 2026-08-15.** This panel drew the select that
   * set it, in its own header row; the choice is a **deck setting** now
   * (`DeckSettingsForm`, written to `decks.default_category_id`), so what arrives here is the
   * deck row's answer and there is nothing to hand back. Two things follow, and both are the
   * point of the move: a pick survives the deck being closed, and the two surfaces that file by
   * it — this panel's Add button and the toolbar's quick-add field — cannot come to two answers,
   * because there is only one place it can be set.
   */
  targetCategoryId: number;
  /**
   * The format the filter row's Format select **opens** on — the open deck's, handed down
   * rather than read here, for the reason {@link DeckSearchPanelProps.categories} is: the
   * editor already holds the deck row and the `format_specs` row beside it, and a second
   * component reading the open deck's format beside the one that already has it is how a panel
   * starts filtering for a format the editor is not showing.
   *
   * **A default, never a constraint.** It seeds `useCardSearch`'s `format` state and reaches
   * nothing else: `Any format` stays in the list under the wider `Any card`, the reader may move
   * the select to any format including one this deck is not legal in, and the card they then
   * press Add on is added. Legality is `validation/engine.ts`'s `RULE BREAK` on the card once it
   * is in the deck, and why that is the only place it may be answered is the docked panel's
   * bullet in this folder's `CLAUDE.md`.
   *
   * `null` and absent both mean **Any format**, and that is a working panel rather than a
   * degraded one. It has to be: the editor's answer is `null` while the format seed is still
   * loading, and `null` again for a deck whose format has no legality data to filter by at all
   * — a key `search_cards` does not recognise draws an empty wall with nothing on screen to
   * explain it.
   */
  defaultFormat?: FormatFilterOption | null;
  /**
   * Whether the editor has room to draw this open — measured, not guessed (see
   * `DeckEditor`'s `DECK_FLOOR`).
   *
   * `false` renders the rail whatever the reader last chose, and the disclosure goes with it:
   * a control that cannot do the thing it names is worse than one that says why it cannot.
   *
   * **It decides what is _drawn_ and never what is _mounted_**, and the two are kept apart
   * because they answer to different things: this prop moves on a **width** change nobody
   * asked for, while `open` moves only on a press. So a panel the reader had opened is
   * *hidden* when the room goes rather than torn down, and the typed query, the filter row,
   * the facets and the pages already fetched are all still there when the room comes back —
   * closing the card pane at 1024 is enough, and the panel comes back as they left it.
   * Gating the mount on this as well threw every one of those away on a *resize*: at 1024 a
   * tile press opens the card pane, the pane's arrival rails the panel, and Escape brought it
   * back empty on the deck's default format.
   *
   * **It is no longer the whole of whether the panel may be drawn** — see
   * {@link DeckSearchPanelProps.overWidth}. `roomy` answers one question, *is there room to draw
   * this **beside** the deck*, and below that width there is now a second answer rather than a
   * refusal.
   */
  roomy?: boolean;
  /**
   * How wide to draw this panel **over** the deck, in px — the desk's own width — for a desk too
   * narrow to hold the deck and this column side by side. Absent is a desk that can.
   *
   * **This is the door out of the rail, and until 2026-08-29 there was none.** `roomy` is
   * `DECK_FLOOR` (192) plus {@link MIN_PANEL_WIDTH_PX} (206) plus the desk's gap (16) — **414** —
   * so on a 390px phone the panel railed *and the disclosure refused*: `aria-disabled`, a
   * sentence about widening a window that cannot be widened, and no way to reach a card search
   * from a deck at all. The refusal was right about the arithmetic it was doing and wrong about
   * the question: there is no room for the two of them **beside each other**, which is not the
   * same as no room for the search.
   *
   * **The placement is issue #183's, reused rather than invented.** The card pane already draws
   * over one of the desk's two columns instead of taking width from either, on the argument that
   * opening a surface must not change the flow of the deck; this is that arrangement for the one
   * width at which the deck and the panel cannot both be on screen. So the panel is absolutely
   * positioned over the desk and the rail keeps its 36px place in the flow — the deck behind is
   * laid out at exactly the width it had before the press, and a masonry of a hundred piles is
   * not re-measured twice per disclosure.
   *
   * **What it costs is the drag, and that was chosen knowingly**: while the overlay covers the
   * deck there is no pile to drag a tile into, so adding a card from the search is a tap on its
   * Add button. Every drag *within* the deck is untouched — this adds no drag source, no drop
   * target and no `touch-action`, and covers no element that carries one.
   *
   * A number and not a boolean because the width is the editor's measurement (`deskWidth`) and
   * this panel is inside a 36px dock: `right-0` gives the desk's right edge for free and the
   * width is the one thing CSS in here cannot derive. `undefined` — which is also the first
   * paint, before the observer has answered — is the docked arrangement, which is what every
   * test that says nothing about width gets.
   */
  overWidth?: number;
  /**
   * What a tile offers on a right-click — **the handler already built**, from the editor.
   *
   * A tile here is a search result rather than a deck card, so it gets the plain card menu every
   * other wall in the app draws: none of the deck editor's own rows (Move to, the two zones, Label
   * card) means anything about a printing that is in no deck. It is built by `DeckEditor` all the
   * same, so that one `CardMenuDeps` serves both surfaces of that screen — two would be two
   * collection-add observers and two places to draw one refusal.
   *
   * Absent is a panel with no menu, which is what a story or `DeckSearchPanel.test.tsx` mounts.
   */
  cardMenu?: (card: CardSummary, picked: readonly CardSummary[]) => (e: ReactMouseEvent) => void;
  /** The same menu from the keyboard — Shift+F10 and the ContextMenu key, anchored at the
   *  tile's own corner. Its own slot rather than something derived from the one above, because
   *  a keypress has no coordinates; see `CardGrid`'s `cardMenuKey`. */
  cardMenuKey?: (
    card: CardSummary,
    picked: readonly CardSummary[],
  ) => (e: ReactKeyboardEvent) => void;
  /**
   * The widest this panel may be drawn or dragged, in px — the editor's answer, because the
   * editor is what holds the two measurements it is made of.
   *
   * `min(half the window, what the desk can spare over `DECK_FLOOR`)`. Two bounds because they
   * bind at different sizes and each is wrong on its own: at 1280 with the card pane docked the
   * desk is 602, so half the window (640) is wider than the whole row and only the deck's floor
   * says anything useful; at 1920 with the pane closed the desk can spare ~1462 and only the
   * half-window cap stops the search column becoming the deck builder.
   *
   * **A cap on the drawn width, not a correction to the reader's.** The width they dragged to is
   * held un-clamped, so a window narrowed and widened again gives it back rather than leaving
   * the panel at whatever the narrow moment allowed.
   *
   * Absent — and `Infinity` — mean *unmeasured*, which is the first paint's honest answer and
   * reads as no cap; the editor's observer answers on the same frame. A story rendering this
   * panel on its own passes nothing and gets the width it asks for.
   */
  maxWidth?: number;
}

/**
 * The path by which cards enter a deck.
 *
 * Not a second search: this is `useCardSearch` + `FilterBar` + `CardGrid` — the search view's
 * own parts — in a column beside the deck, with the wall's two slots pointed at this job. The
 * `badge` slot keeps telling the collection story (a card in the binder is one the deck can be
 * built out of today) and the `action` slot becomes **Add to deck**.
 *
 * A **fixture of the editor, not a dismissible layer**: Escape pressed in here belongs to the
 * card detail pane, which listens on `window` in the bubble phase, and the way to put the
 * panel away — and the way to get it out in the first place, since it opens collapsed — is the
 * disclosure control it names itself by. The one dismissible thing inside it is the set picker's
 * listbox, which is already an `"inner"` layer of its own.
 *
 * It is a docked column rather than one of the editor's dialogs because it is **worked out of**:
 * its tiles are drag sources into the deck's own category columns beside it, and a scrim would
 * end that drag path and cover the card pane a reader flips printings in. `src/CLAUDE.md` carries
 * that rule; everything the reader merely *consults* is a `Dialog`.
 *
 * The tiles stay selectable, so the pane keeps working from inside the editor: clicking the
 * art opens the card exactly as it does on the search view, and the Add button beside it does
 * not.
 */
export function DeckSearchPanel({
  add,
  onAdded,
  categories,
  deckId,
  targetCategoryId,
  defaultFormat,
  cardMenu,
  cardMenuKey,
  roomy = true,
  overWidth,
  maxWidth = Number.POSITIVE_INFINITY,
}: DeckSearchPanelProps) {
  /**
   * What the *reader* last chose, and it starts **open** — on this deck, on the next one, and on
   * the next launch (issue #183, 2026-08-22). What is drawn is this and `roomy` together.
   *
   * **This reverses the 2026-08-14 default and it is the same argument reaching the other
   * answer.** The case for opening collapsed was width: the panel is {@link PANEL_WIDTH_PX} plus
   * the desk row's 16px gap out of a row measured at **602px** at 1280×800 *with the card pane
   * docked beside the editor*, which left the deck **202px** — one stack column. The card pane is
   * not docked beside the editor any more; it is an overlay over one of these two columns and
   * takes no width from either (`DeckEditor`'s pane host), so the row that number was measured on
   * no longer exists. What is left is a search column against a full-width desk, which is what
   * `roomy` was already there to judge — and a disclosure whose whole cost was the width it took
   * from a case that has gone.
   *
   * **Remembered, and that is the half that makes the default defensible.** {@link
   * useDeckSearchOpen} keeps it in `app_meta` behind a query, so a reader who shuts the column
   * shuts it once rather than on every deck they open. The old note here argued the opposite —
   * that "whether it is open at all" is a fact about *one particular deck's* search column and so
   * belongs nowhere — and the reports this changed for say it is not: readers do not open a search
   * column per deck, they either work with one or they do not. The per-deck facts are still the
   * deck row's (`rememberView`'s `lastVariant`/`lastGroupBy`/`lastSortBy`), and the tile size in
   * this column is still the `deckSearch` zoom section's; this is the app-wide answer that sits
   * beside them.
   *
   * **The press is what is written, never the drawn state.** A railing is a measurement about a
   * narrow window and not a thing the reader asked for, so it must not reach the stored answer —
   * see {@link useDeckSearchOpen} and {@link DeckSearchPanelProps.roomy}.
   *
   * **The search comes up with the disclosure and costs nothing before it** — {@link OpenPanel}
   * is where `useCardSearch` lives, and **this flag on its own is what mounts it**. Closed is
   * nothing mounted, which is the rule every dialog in this editor is built on and the one this
   * panel used to be the exception to: the hook was unconditional here, so every deck a reader
   * opened fired a `search_cards` for a wall nobody was looking at. That gate is worth more now
   * rather than less — open is the resting state again, so the readers it saves a query for are
   * exactly the ones who shut the column on purpose.
   *
   * `shown` below is the *drawn* state, this and the editor's room together, and it reaches the
   * classes, the `aria-expanded` and the row's shape and nothing else. **A press is the only
   * thing that can unmount a search; a railing hides one** — see {@link DeckSearchPanelProps.roomy}.
   */
  const tip = useTooltip();
  const { open, setOpen } = useDeckSearchOpen();
  const { tab, setTab } = useDeckSearchTab();
  /**
   * Whether this panel is drawn over the deck rather than beside it — see
   * {@link DeckSearchPanelProps.overWidth}.
   *
   * `> 0` rather than a presence test, because the editor's own measurement is `0` until its
   * observer has answered and a zero-width overlay is a panel drawn as nothing at all.
   */
  const over = overWidth !== undefined && overWidth > 0;
  /**
   * Whether a press could do anything — **the question the disclosure is actually asking**, and
   * the one it got wrong for as long as `roomy` was the whole of it.
   *
   * Two placements answer it now: docked beside the deck where the desk can hold both, drawn
   * over the deck where it cannot. Only a desk that can do neither refuses, and it still says so
   * in words.
   */
  const drawable = roomy || over;
  const shown = open && drawable;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  /**
   * How wide the reader has dragged this column, in px — **only ever written by the reader**,
   * and clamped again where it is drawn.
   *
   * That split is the whole of "reopens at the last valid width". A narrowing window, a card
   * pane opening beside the editor, a `DECK_FLOOR` that will not give any more — each of those
   * caps what can be *drawn* without being a thing the reader asked for, so none of them may
   * overwrite what they did ask for. Let the environment write here instead and a momentary
   * squeeze is permanent: widen the window back and the panel stays where the narrow moment left
   * it. A *drag* does write clamped, because there the bound is the edge the reader is pushing
   * against rather than something that happened to the window while they were not looking.
   *
   * `useState` here, and **this is now the one thing about this panel that is not remembered** —
   * the disclosure beside it went to `app_meta` on 2026-08-22 (see {@link open}) and this
   * deliberately did not follow it. A width is an answer about *one deck's* desk: how much room
   * the piles beside it need is a fact about that deck, and a column dragged wide for a 17-pile
   * Commander list is the wrong column for a 60-card Standard deck. Whether the reader works with
   * a search column at all is not like that, which is why exactly one of the two crossed over.
   * It **does** survive a collapse and a railing, because it lives in this root rather than in
   * `OpenPanel`: the disclosure and the reader's width outlast the search they were pointed at,
   * so reopening gives back the column they had rather than the one the app ships.
   */
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH_PX);

  // What is actually drawn: the reader's width inside the editor's cap, and never below the one
  // card `MIN_PANEL_WIDTH_PX` is measured from. The `max` around the cap matters at exactly one
  // moment — a desk too narrow for the minimum, where `roomy` is already false and this element
  // is 36px of rail whose width nothing reads.
  const drawnWidth = Math.min(
    Math.max(width, MIN_PANEL_WIDTH_PX),
    Math.max(maxWidth, MIN_PANEL_WIDTH_PX),
  );

  // The drag's own clamp, which is the drawn one plus the fact that a drag cannot ask for a
  // width the editor has already refused.
  const resize = useCallback(
    (next: number) =>
      setWidth(
        Math.min(Math.max(next, MIN_PANEL_WIDTH_PX), Math.max(maxWidth, MIN_PANEL_WIDTH_PX)),
      ),
    [maxWidth],
  );

  const selectedCardId = useAppStore((s) => s.selectedCardId);

  /**
   * The caret, when the card pane closes and what opened it is not there any more.
   *
   * This panel is what took it away: at 1024 a tile press opens the pane, the pane's arrival
   * squeezes the row, the row squeezes this panel down to its rail — and the tile that was
   * pressed goes `display: none` with it, which is as good as gone to the caret, because focus
   * cannot land on a box that is not rendered. `CardDetailPane` hands the caret back to whatever
   * opened it and checks `isConnected` before it does; a hidden tile is still connected, so the
   * hand-back is attempted and does nothing, and either way the caret ends on `<body>` with the
   * next Tab restarting from the top of the app. The disclosure is the honest place for it: it
   * is where the reader's search went, and it is a Tab away from the search box and the results
   * either way.
   *
   * Read off a *remembered* collapse rather than off `roomy` at the moment the card closes,
   * because by then it is usually false again — closing the pane is what gives the width back,
   * so the panel is already reopening on the same commit. What matters is that this panel shut
   * while the card was open, which is the thing that unmounted the opener.
   *
   * And only when nothing else took the caret: an opener still on screen (a deck row, say) has
   * already been handed it, and stealing it from there would be worse than the bug.
   */
  const hadCard = useRef(selectedCardId !== null);
  const shutUnderCard = useRef(false);
  useEffect(() => {
    const had = hadCard.current;
    hadCard.current = selectedCardId !== null;
    if (selectedCardId !== null) {
      // **`drawable` rather than `roomy`, since the overlay** — the phone case reaches this by
      // the same road one width down: at 390 the panel is *already* drawn over the deck, and the
      // editor takes the overlay away when a card opens (there is room for one surface, and the
      // card is the one that was just asked for). So a tile pressed in the overlay goes
      // `display: none` with the body exactly as it does at 1024, and the caret has the same
      // nowhere to go.
      if (!drawable) shutUnderCard.current = true;
      return;
    }
    const shut = shutUnderCard.current;
    shutUnderCard.current = false;
    if (!had || !shut) return;
    if (document.activeElement === document.body) toggleRef.current?.focus();
  }, [selectedCardId, drawable]);

  /**
   * The disclosure, in both of its states — one control, one name, and `aria-expanded` for the
   * difference. Named for what it reveals rather than for what pressing it does, so the name
   * does not change under a reader who is looking for it.
   *
   * Refused, with the reason, in the one state where pressing it could not work: there is not
   * enough width for the deck and the panel both, so the press would be recorded and nothing
   * would move. The sentence says what to do about it, which is the app's rule for anything
   * that refuses.
   *
   * `aria-disabled` and a press that does nothing, **not** `disabled`: a disabled button is out
   * of the tab order, which would leave the reason hanging on a hover a keyboard reader cannot
   * perform — a rail that cannot be activated and never says why. This way the control is
   * reachable, the `title` is its description, and it is also somewhere the caret can be put
   * (see the effect above).
   */
  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={shown}
      // **`drawable`, not `roomy`** — the refusal used to fire for every desk under 414, which
      // is every phone, and there is nothing wrong with a search column at 390 except where it
      // was being asked to go. What still refuses is a desk that can hold the panel neither
      // beside the deck nor over it, which today is only ever a card pane taking the desk at a
      // width the panel could otherwise have overlaid — and the sentence below names exactly
      // that remedy first.
      aria-disabled={!drawable || undefined}
      // **An `aria-label`, which the words on the button used to be** (2026-08-25). This was an
      // icon *and* the text `Search cards`, so the visible words were the accessible name and a
      // label differing from them would have been a control voice control cannot reach (WCAG
      // 2.5.3). The words are a heading beside it now and this button draws nothing but a
      // chevron, so there is no visible text for a name to have to contain — and a name of its
      // own is owed, because "chevron" is not what pressing it does.
      //
      // It names the **result** rather than the state, which is the same rule the direction
      // arrow on the filter bar follows: `aria-expanded` already says which way round it is, and
      // a reader who has just heard "collapsed" wants to know what the press will do about it.
      aria-label={shown ? "Collapse card search" : "Expand card search"}
      {...tip(drawable ? null : NO_ROOM)}
      // `setOpen(!open)` rather than an updater, because the answer is a *query's* now rather
      // than a `useState`'s and there is no functional form to take one. Safe for the same
      // reason the updater was never load-bearing here: `open` is read in this render, a press
      // is one event, and the write is optimistic — the cache holds the new value before the
      // next press can be made.
      onClick={() => drawable && setOpen(!open)}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-dim",
        "transition-colors duration-150 motion-reduce:transition-none",
        drawable ? "hover:text-text" : "cursor-not-allowed opacity-60",
        // **Flat in both states, and that is the change of 2026-08-26.** Collapsed, this button
        // carried `border border-border` — the rail's own hairline, drawn on the only thing in
        // 36px that could hold one — which made the one control the reader sees at that width a
        // boxed button where every other icon button in the app is a bare glyph on the page. The
        // hairline is the *panel's* chrome rather than this button's, so it went back to the
        // `<section>` (below), where it is the same left edge the drawn panel carries and the
        // "two lines saying one thing" it was avoiding still cannot happen — there is one line
        // and it is not on the button.
        //
        // `w-full` rather than the `w-9` that came with the border: the rail's content box is a
        // pixel narrower than the rail now that the section is bordered, and the chevron is
        // centred by the button filling that box. A bare `size-7` would sit 28px wide at the
        // start of a 35px column, 3px off the rail's own centre.
        shown || "w-full",
        FOCUS,
      )}
    >
      {/* **The chevron points where the panel is going**, which is what makes it readable
          without the words: right when the panel is open, because pressing it slides this column
          away to the right edge it is docked against, and left when it is a rail, because
          pressing it brings the column back out.

          **One icon turned over, never `ChevronRight` swapped in for `ChevronLeft`.** That is
          `SortableHeader.tsx:51-55`'s rule and the filter bar's sort arrow follows it for the
          same reason: a different element in the same slot is unmounted and remounted, so the
          indicator *teleports*, and the whole of what the press means is that the direction
          reversed. Half a turn is that fact, drawn.

          `initial={false}`, so a panel that mounts already open draws its chevron turned rather
          than spinning it on first paint. `rotate` is a transform prop, so `MotionConfig
          reducedMotion="user"` reaches it and no `useReducedMotion` opt-out is owed here
          (`docs/reference/motion.md` — the trap there is the *non*-positional properties, and
          this animates none).

          `flex` on the span is load-bearing and not decoration: a bare `<span>` is a
          non-replaced inline box, a transform does not apply to one at all, and the rotation
          would silently do nothing. */}
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ rotate: shown ? 180 : 0 }}
        transition={TRANSITION.fast}
        className="flex"
      >
        <ChevronLeft className="size-4" />
      </motion.span>
    </button>
  );

  /** Drawn open, over the deck rather than beside it — see {@link DeckSearchPanelProps.overWidth}. */
  const overlaid = shown && over;

  return (
    <>
      {/* **The rail's 36px, kept in the flow while the panel is drawn over the deck.**
          Positioning the panel absolutely takes it out of this dock, which would otherwise
          collapse to nothing and hand the deck behind it 52px it does not get to keep — a
          re-measure of the whole masonry on the way in and another on the way out, twice per
          press, for a layout the reader cannot see. This holds the desk still instead, which is
          the half of issue #183's arrangement that is about the *deck* rather than about the
          surface over it.

          Its own slot in this fragment, exactly as the resize handle has one below: React
          reconciles static JSX children by position, so a slot that alternates between an
          element and `null` leaves every sibling's identity alone — which is what the caret
          hand-back depends on and what the note on the `<section>` is about. */}
      {overlaid && <div aria-hidden="true" className="w-9 shrink-0" />}
      {/* A `section`, not an `aside`: the card pane is the app's one complementary landmark, and
          a second unnamed one would answer to the same role query.

          **One root for both states**, rather than a bare rail in the collapsed one. React
          reconciles by position, so two shapes would mean the disclosure is a *different* button
          either side of a collapse — and the caret handed to the rail when the card pane closed
          would be dropped again one commit later, when the returning width reopened the panel
          around a freshly mounted copy of it. Measured in the running window; the effect above
          reads as if it works with either shape and only works with this one. **Three states
          now** — railed, docked, drawn over the deck — and it is still one element: what the
          third changes is a `position`, a background and where the width comes from.

          Which is why the open body is a **child** rather than a second root: `OpenPanel` mounts
          and unmounts with the reader's own press — closed really is nothing mounted — while this
          element, the row below it and the disclosure inside that row are the same three nodes
          throughout, and a railing takes the body out of the *layout* without taking it out of the
          tree. */}
      <section
        id={bodyId}
        aria-label="Add cards"
        {...(overlaid ? { [SEARCH_OVER_ATTR]: "deck" } : {})}
        // One hairline down the left edge, and it is the only chrome the panel adds: the
        // category columns beside it are bordered boxes and these controls sit on the page, so without it
        // the "Add to" select reads as part of the deck's own header row. Everything right of
        // the line is not your deck. **Railed too, since 2026-08-26** — that sentence is as true of
        // 36px of rail as of the drawn panel, and it used to be said by a border on the disclosure
        // instead, which drew the button as a box rather than the column as a column. The rail and
        // the panel are one edge now, so a collapse changes what is in this column and not what it
        // is. The `w-9` is unchanged and stays 36px: `box-sizing` is `border-box`, so the hairline
        // comes out of the rail rather than out of the desk beside it.
        // **No hairline in the overlay**, which is the one state it says nothing in: the panel is
        // the whole desk there, so a line down its left edge is a line down the window.
        // `relative` for the resize handle, which is drawn *over* the hairline rather than in the
        // column: a grab strip that took a place in this flex column would be a strip the length
        // of one row rather than the length of the edge.
        //
        // **Over the deck it is `absolute` and opaque.** The dock it sits in is `sticky` and
        // therefore already the containing block, so `inset-y-0` is the height the dock effect
        // measured — the same two ends the docked panel is drawn between — and `right-0` is the
        // desk's own right edge; only the width has to be told. `bg-bg` because it is covering
        // the deck rather than sitting beside it, and no z-index: a `sticky` ancestor is always
        // a stacking context, so a number here could never out-rank the deck's own
        // `LAYER.raised` — the dock is where that has to be said, and `DeckEditor` says it.
        className={cn(
          "flex min-h-0 shrink-0 flex-col gap-2",
          !overlaid && "border-l border-border",
          overlaid ? "absolute inset-y-0 right-0 bg-bg pl-3" : shown ? "relative pl-3" : "w-9",
        )}
        style={shown ? { width: overlaid ? overWidth : drawnWidth } : undefined}
      >
        {shown && !overlaid && (
          <ResizeHandle
            controls={bodyId}
            width={drawnWidth}
            max={Math.max(maxWidth, MIN_PANEL_WIDTH_PX)}
            onResize={resize}
          />
        )}
        {/* **The panel's title bar** — the chevron at the left edge and the name of the column
            centred over the rest of it.

            Collapsed, this row *is* the panel, so it takes the height and lets the rail stretch
            down it — a 36px strip reads as an edge, an 80px one reads as a stray button. Drawn, it
            is a heading row and `items-center` is what keeps the 28px chevron and the title on one
            baseline.

            **No `flex-wrap` any more, and nothing here can overhang without it.** That class was
            load-bearing while this row held three controls — the disclosure at 99px, the tab strip
            at 141 and the own/need pair at 175, none of which shared a line inside the panel's
            **193px** content box at its floor, so unwrapped they became a horizontal scrollbar
            across the whole deck builder (`src/CLAUDE.md`, and `ManaValueChips` shipped that bug
            once already). The strip is a line of its own and the pair is deleted; what is left is a
            28px square and a text node that can shrink to a word, so there is nothing here with a
            min-content wider than the panel. The title carries `truncate` rather than wrapping,
            because a two-line heading over a search box is a heading that moves when the reader
            drags the edge. */}
        <div
          className={cn(
            "flex gap-2",
            shown ? "shrink-0 items-center" : "min-h-0 flex-1 flex-col items-stretch",
          )}
        >
          {/* **The "Add to" select was here until 2026-08-15 and is now in deck settings.** It
              was the click path's answer to "where does this go" and it was the wrong place to
              answer it from: the choice was `useState` in `DeckEditor`, so a reader who set the
              panel to their Sideboard lost it the moment they closed the deck, and the same
              answer governed the toolbar's quick-add field, which drew no control at all. It is
              `decks.default_category_id` now, asked once in the settings dialog and remembered.
              Nothing on this row replaced it: every Add button below already names the pile it
              files into, per card, which is where the question is actually being asked.

              **The tab strip was here from 2026-08-23 to 2026-08-24 and is a line of its own now.**
              It sat here because the row had the space; what that cost is on {@link TabStrip}.

              **The own/need pair was here from 2026-08-23 to 2026-08-25 and is deleted** — see
              {@link DeckSearchPanelProps} for why the Collection tab is the better answer to the
              question it asked. */}
          {toggle}
          {/* The column's name, centred over the row — **a `<span>` and not the button's label**,
              which is the change of 2026-08-25. The two used to be one control: an icon and the
              words inside the disclosure, which made the heading a thing you could press by
              accident and put the panel's name hard against its left edge. Split, the button is an
              icon with an `aria-label` of its own and this is a heading a reader's eye lands on.

              `flex-1 text-center` plus the spacer below is how it is centred over the *panel*
              rather than over what the chevron leaves: without the spacer the midpoint of a
              `flex-1` text node sits 14px right of the panel's own. Cheaper than absolute
              positioning and it keeps the title in flow, so `truncate` still has a box to work
              against at the 193px floor.

              Down the rail when the panel is shut, so 36px of chrome still says what it is rather
              than leaving a bare icon to be guessed at — and `select-none` in that state alone,
              which is `TitleBar`'s rule for the wordmark reached from the other side. There the
              words sit in a drag region and a highlight fights the reader; here they *are* the
              rail, so a pointer moved down the shut column with the button held drags a selection
              across the whole of what the panel has left on screen. Drawn, this is an ordinary
              heading over a search box and there is nothing to protect it from.

              **`self-center` down the rail, and `text-center` is not what centres it there** —
              reported 2026-08-26, once the chevron's border stopped framing the misalignment. In
              `vertical-rl` the *inline* axis is the one running down the page and the **block**
              axis runs right to left, so `text-align` moves the words up and down (against a box
              whose height is their own content, i.e. not at all), and the line box is laid at
              block-start — which is the span's **right** edge. Stretched by the row's
              `items-stretch` to the rail's full width, that put the title's centre ~7px right of
              the chevron's in a 36px column.

              So the span stops stretching and is centred as an item instead: `align-self: center`
              shrink-wraps it to one line box's thickness and puts that box on the rail's own
              centre line, which is where `justify-center` has already put the chevron. `text-center`
              is left off that arm rather than kept as decoration — a class that cannot act in the
              writing mode it is written for is the thing somebody later "fixes" the real bug by
              adjusting. */}
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium text-text",
              shown ? "flex-1 text-center" : "select-none self-center",
            )}
            style={shown ? undefined : { writingMode: "vertical-rl" }}
          >
            Search cards
          </span>
          {/* The chevron's own width given back on the other side, so the title's centre is the
              panel's centre. `aria-hidden` and no text: it is a shim, not a control. */}
          {shown && <span aria-hidden="true" className="size-7 shrink-0" />}
        </div>

        {/* **Above the body rather than inside it**, which is what makes it the panel's own chrome
            rather than one tab's: it is drawn for both tabs, it does not move when they switch, and
            it survives the railing that merely *hides* the body below (see {@link OpenPanel}) — so
            a width change cannot take the reader's tab away any more than it takes their query.

            Gated on `shown` alone: `open` is what decides whether there is a search at all, and a
            tab bar over nothing would be two words offering to switch between two things that are
            not mounted. Collapsed, this column is a 36px rail and draws neither. */}
        {shown && <TabStrip tab={tab} onPick={setTab} />}

        {/* Everything below the row, and only once the reader has asked for it — see
            {@link OpenPanel}. One gate where there were five, which is what makes the search a
            thing the reader asks for rather than a thing every deck pays for.

            **Mounted on `open`, hidden on `!roomy`.** The press is a choice and the room is a
            measurement, so a width change must not be able to throw the reader's search away —
            which is exactly what `{shown && …}` here did.

            `display: contents` is what makes the wrapper free: it generates no box at all, so
            `OpenPanel`'s children stay flex items of this column and the `gap-2`, the `min-h-0`
            and the wall's `flex-1` distribute exactly as they did with no wrapper there. Hiding
            is `display: none` and deliberately not an `opacity` or a `visibility`: those two
            leave the wall holding its space in the layout and its tiles in the tab order, which
            is the whole of what the rail exists to give back. The `hidden` **attribute** beside
            the class says the same thing to the accessibility tree — and to the suite, which
            loads no stylesheet, so under jsdom the class alone would hide nothing from a role
            query. */}
        {open && (
          <div className={shown ? "contents" : "hidden"} hidden={!shown}>
            {/* **Two components, never one body with a branch in it**, and that is {@link OpenPanel}'s
                own reason one level in: each tab's data hook is called from a component that mounts
                with that tab, because a hook called from a branch is a hook called conditionally and
                React will not have it. Do not hoist the two hooks up here to "simplify" this — the
                collection tab would then run a `collection_list` for every reader browsing the wider
                search, and the card search would run a `search_cards` for every reader who never
                leaves their binder.

                Switching therefore throws the other tab's state away, exactly as a collapse does:
                a press is a decision, and a reader who goes back to the wall is starting a search
                rather than resuming one. */}
            {/* **Four props where `OpenPanel` takes seven, and each absence is a fact about this
                write rather than an oversight** — a prop nothing reads is a prop lint refuses, so
                the ones that cannot be read are not accepted:

                - **`add`** is `useDeck.addCard`, which is `deck_add_card` — it writes a deck row and
                  moves no copies. Putting a card the reader *owns* into a deck is
                  `collection_to_deck`, a different command with a different address, and sending
                  both would put the card in the deck twice.
                - **`onAdded`** carries the `deck_cards` row a write landed in, which is what the
                  editor glows for five seconds. `MoveOutcome.deckCardId` *is* that row and this tab
                  could hand it back — what it has instead is a status line of its own, which says
                  the thing this press has that an ordinary add does not: which deck the copies came
                  out of. Naming the donor is the report; a glow is not.
                - **`cardMenu` / `cardMenuKey`** are `(card: CardSummary) => …`, and this list draws
                  `CollectionRow`s. A collection row's own menu is the collection page's
                  (`Move to → folder`), and building a fake `CardSummary` to reach a menu written for
                  a different object is how one surface starts offering rows that mean nothing where
                  they are drawn.
                - **`mode` / `onMode`** are the own/need question, and a row of this list has already
                  answered it: the copy is in the reader's binder, which is what "I own this" *means*.
                  That is why {@link AddModeStrip} is drawn on the other tab only. */}
            {tab === "collection" ? (
              <CollectionSearchTab
                categories={categories}
                deckId={deckId}
                targetCategoryId={targetCategoryId}
                defaultFormat={defaultFormat}
              />
            ) : (
              <OpenPanel
                add={add}
                onAdded={onAdded}
                categories={categories}
                deckId={deckId}
                targetCategoryId={targetCategoryId}
                defaultFormat={defaultFormat}
                cardMenu={cardMenu}
                cardMenuKey={cardMenuKey}
              />
            )}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Which of the two searches this column is showing — **a full-width tab bar above the search
 * box**, the active tab marked by a rule under its own word.
 *
 * ## Why it stopped being a gold pill (2026-08-24)
 *
 * It was a 141px segmented pair sharing the header row with the disclosure and the own/need pair,
 * and it was reported as unsightly. Two things were wrong with it and neither was the shape:
 *
 * - **Gold is what this panel already uses to mean "this filter is on"** — the format select goes
 *   `border-accent text-accent` when it is narrowing, `ToggleChip` fills when pressed, `ResetAll`
 *   carries a gold count. A filled gold block for *which search you are in* put the loudest paint
 *   on the page on the one control that is not a filter, so the eye read the tab bar before the
 *   thing it was filtering.
 * - **Three segmented pairs on one wrapping row** read as one undifferentiated bank of chrome —
 *   measured at the panel's 384px opening width, the disclosure and this sat on line one and the
 *   own/need pair took line two, so the reader met two rows of grey pills before the search box.
 *
 * A rule under a word is the quietest thing that can say "you are here", it needs no box of its
 * own, and it puts the two words on the panel's own left margin where the reader's eye already is.
 * **The own/need pair keeps its pill** and is now alone beside the disclosure: it is a control that
 * changes what a press *writes*, which is exactly the kind of state gold means here.
 *
 * ## What did not change
 *
 * **`aria-pressed` over a `.map`, and deliberately not `role="tab"`.** That role is a contract
 * rather than a name: roving focus on the arrow keys, `aria-controls` pointing at a `tabpanel`,
 * and a panel that takes the caret. Nothing else in this app implements it — `DeckEditor`'s
 * Theory/Actual switch, `FilterChips`' layout pair and the card pane's toggles are all pressed
 * buttons — so adopting it here would either be half-built (a `tab` role with no keyboard
 * behaviour is worse than no role at all, because a screen reader announces a contract the control
 * does not honour) or would make the one control that picks a *search* behave unlike the control
 * that picks a *list* two feet away. Two buttons, one pressed. **The bar looking like tabs is not
 * a claim that it is one** — the words say which search you are in either way, and what a screen
 * reader is told is the pressed state, which is honoured.
 *
 * **The words are written out rather than derived**, for the reason the Theory/Actual switch gives:
 * `text-transform` changes what is drawn and not what a control is *called*, so a capitalised
 * label is one voice control has to be asked for in the uncapitalised word (WCAG 2.5.3).
 *
 * `FOCUS` rather than `FOCUS_INSET`, and that reverses with the box: the pair was drawn as a
 * single `overflow-hidden` box so the two buttons met with no seam, which clipped an outline
 * standing 2px *off* a control filling it — no focus indicator at all. There is no clipping box
 * now, so the outline is drawn where it belongs, and the `pb-1.5` under the row is what keeps it
 * off the search field below.
 *
 * ## The width
 *
 * Safe at {@link MIN_PANEL_WIDTH_PX} without measuring anything, which the pill it replaced was
 * not: a segmented pair cannot wrap inside the one rounded box it is drawn as — that is why the
 * labels had to be two short words.
 *
 * **Full width since 2026-08-25** — `flex-1` apiece, so each tab is half the panel and the lit
 * rule is half the bar. Still safe at the floor and for a stronger reason than the `flex-wrap`
 * row it replaced: two items each asking for half a line cannot wrap past each other, and the
 * wider word is ~68px against the 96 that half of a 193px content box gives it. `min-w-0` is what
 * keeps that true if the labels ever grow — without it a flex item's floor is its own min-content
 * and a long word would push the pair into an overhang, which in this editor is a horizontal
 * scrollbar across the whole deck builder.
 */
function TabStrip({ tab, onPick }: { tab: DeckSearchTab; onPick: (tab: DeckSearchTab) => void }) {
  return (
    // Named for the question rather than for the control: "Search in — Collection" is what the
    // pair says, and `role="group"` is what holds the two buttons together for a reader stepping
    // through the panel.
    //
    // The hairline is on the *row* and the accent rule is on the button, so the inactive tab sits
    // on a continuous border rather than in a gap — one line across the panel with a lit segment
    // in it, which is what makes this read as a bar instead of as two underlined words.
    <div
      role="group"
      aria-label="Search in"
      // **No `gap-x` and no `flex-wrap` since the tabs went full width** (2026-08-25). The gap
      // was what separated two words sitting on the panel's left margin; halves of a bar meet at
      // its midpoint instead, and a gap there would be a break in the hairline. `flex-wrap` went
      // with it for a reason of its own: a wrapped tab bar is two bars, and two `flex-1` items
      // cannot wrap — each is already asking for half a line, and the min-content of the wider
      // word (`Collection`, ~68px) fits half of even the 193px floor.
      className="flex shrink-0 border-b border-border"
    >
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(id)}
          aria-pressed={tab === id}
          className={cn(
            // 28px rather than the 36 of `DeckEditor`'s ribbon: that row's height is the app's
            // agreement about a *toolbar* press, and this is chrome on a column whose own
            // title row is a `text-sm` line and whose Add buttons are 24px squares.
            "h-7 text-xs",
            // **Half the panel each, and the lit rule under the active one is therefore half the
            // bar.** Two words on the left margin read as a pair of links; two halves of a
            // bordered row read as tabs, which is what they are — and it puts the target where
            // the reader's pointer already is rather than making them aim at a word.
            "min-w-0 flex-1",
            // The rule is a `border-bottom` on the button and is drawn **transparent** when the
            // tab is not active rather than left off: a border that appears on press would move
            // the word up by two pixels every time the reader switched tabs. `-mb-px` pulls it
            // over the row's own hairline so the two are one line rather than two.
            "-mb-px border-b-2",
            "transition-colors duration-150 motion-reduce:transition-none",
            tab === id
              ? "border-accent font-medium text-accent"
              : "border-transparent text-dim hover:text-text",
            FOCUS,
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The panel's left edge, as something to pull on.
 *
 * A `separator` with a `tabIndex` and a value, which is the ARIA window-splitter pattern: the
 * pointer path and the keyboard path are one control rather than a drag with a settings dialog
 * beside it for anyone who cannot perform one. `aria-valuenow` is the width in px — the unit the
 * reader is actually choosing, and the one the editor's cap is expressed in — so a screen reader
 * announcing "206" is announcing the same number the panel is drawn at.
 *
 * **Absolutely positioned over the hairline, not a flex item beside it.** This column is a
 * `flex-col`, so a child of it would be one row's worth of grab strip at the top of a
 * several-hundred-pixel edge. It straddles the border instead — 9px wide, 4px of it out in the
 * desk's own 16px gap and the rest over the panel's padding — which is Fitts' law rather than
 * taste: a 1px hairline is not a target, and every pixel of the strip that is *outside* the panel
 * is a pixel the reader can overshoot into without hitting the deck.
 *
 * **Pointer capture rather than window listeners**, which is what makes the drag survive the
 * pointer leaving the strip — and it will, immediately, because the strip moves with the edge
 * and the hand does not track it exactly. Capture also ends the drag correctly when the pointer
 * is released outside the window, where a `pointerup` listener on `window` hears nothing.
 *
 * The grip is drawn only on hover and focus. At rest this edge is the hairline the panel already
 * had — the one piece of chrome it adds — and a permanent handle down it would be a second line
 * saying the same thing, on the border this app spent a lot of care making quiet.
 */
function ResizeHandle({
  controls,
  width,
  max,
  onResize,
}: {
  controls: string;
  width: number;
  max: number;
  onResize: (width: number) => void;
}) {
  // Where the drag started, in both senses. `null` is "not dragging", which is also what a
  // `pointermove` over an idle handle has to be told.
  const from = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls={controls}
      // Named for what pulling it does, not for what it is: "separator" is the role's job and
      // "Resize card search" is the reader's.
      aria-label="Resize card search"
      aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH_PX}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        // The primary button only: a right-press opening a context menu mid-drag would leave the
        // capture on and the panel following the pointer with nothing held down.
        if (e.button !== 0) return;
        e.preventDefault();
        from.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = from.current;
        if (!start) return;
        // Leftward is wider: the panel is docked right, so its edge moving left is the column
        // growing into the desk.
        onResize(start.width + (start.x - e.clientX));
      }}
      onPointerUp={(e) => {
        from.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      // A cancelled pointer — the OS taking the gesture, a touch turning into a scroll — is an
      // ended drag and not a dropped one. Without this the handle stays armed and the next
      // ordinary move over it resizes the panel.
      onPointerCancel={() => {
        from.current = null;
      }}
      onKeyDown={(e) => {
        // Left widens and right narrows, matching the pointer: the key moves the *separator*,
        // which is what the role says this is, rather than moving a value that happens to be a
        // width. Home and End are the two ends of the same range.
        const next =
          e.key === "ArrowLeft"
            ? width + RESIZE_STEP_PX
            : e.key === "ArrowRight"
              ? width - RESIZE_STEP_PX
              : e.key === "Home"
                ? MIN_PANEL_WIDTH_PX
                : e.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        // The arrows scroll the editor otherwise — it is an `overflow-y-auto` page — and Home
        // and End take it to its ends.
        e.preventDefault();
        onResize(next);
      }}
      // `touch-none` so a drag on a touch screen is a drag rather than the browser deciding
      // partway through that it was a scroll and cancelling the pointer.
      className={cn(
        // No z-index, and none is owed: the strip lives in the panel's own left padding and the
        // desk's gap, where nothing else in this column paints. `LAYER` is the only place a
        // z-index may come from in this app, and asking it for one here would be asking for a
        // rung this element does not need.
        "group absolute inset-y-0 -left-1 flex w-[9px] cursor-col-resize touch-none items-center justify-center",
        FOCUS,
      )}
    >
      {/* The grip: three columns of nothing, drawn as one 2px line the height of a fingertip.
          `bg-border` at rest under the pointer and `bg-accent` while the caret is on it, so the
          keyboard's own state is visible on a control whose whole affordance is otherwise a
          cursor change. */}
      <span
        aria-hidden="true"
        className={cn(
          "h-8 w-0.5 rounded-full bg-border opacity-0",
          "transition-opacity duration-150 motion-reduce:transition-none",
          "group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100",
        )}
      />
    </div>
  );
}

/**
 * The panel with its wall in it — **mounted only while the reader has the disclosure open**,
 * which is the whole reason it is a component rather than a branch inside
 * {@link DeckSearchPanel}.
 *
 * A hook cannot be called conditionally, so `useCardSearch` sitting in the root meant its query
 * ran for every deck the reader opened whether or not they had asked for a wall. Closed is
 * nothing mounted here for the same reason it is in `Dialog`: the search, its filter state,
 * its facets and its scroll position all begin at the press and cost nothing before it. A
 * *reader's* collapse throws that state away rather than hiding it, and that is the intended
 * reading — this is a column you open to do a job and shut when the job is done, and its own
 * `open` state is deliberately not remembered either.
 *
 * **A railing is not a collapse and must not be read as one.** `roomy` goes false on a width
 * change nobody asked for — the card pane opening at 1024 is the measured case — so the parent
 * *hides* this subtree and leaves it mounted. The query, the typed text, the filters and the
 * facets are where the reader left them when the room comes back. The one thing that does not
 * survive is the wall's scroll offset, which is the browser's rather than this component's: a
 * box that has been `display: none` comes back at the top. That is what a railing already did,
 * so it is no regression — it is simply the part of the reader's place this cannot hold on to.
 *
 * **What stays in the root is what a collapse must not be able to take**: the disclosure button,
 * whose identity across the two states the caret depends on, and the `roomy` refusal drawn on
 * it. That is the whole of it now — the "Add to" select used to be drawn up there beside them
 * and was never an example of it, sitting inside the row's own `shown` gate and going with
 * everything else. What outlived a collapse was the *choice* it drew, and it still does, for a
 * better reason than it did: `targetCategoryId` is the **deck row's** answer
 * (`decks.default_category_id`) rather than a `useState` one component up, so it outlives the
 * deck being closed too.
 */
function OpenPanel({
  add,
  onAdded,
  categories,
  deckId,
  targetCategoryId,
  defaultFormat,
  cardMenu,
  cardMenuKey,
}: Pick<
  DeckSearchPanelProps,
  | "add"
  | "onAdded"
  | "categories"
  | "deckId"
  | "targetCategoryId"
  | "defaultFormat"
  | "cardMenu"
  | "cardMenuKey"
>) {
  // The deck's format seeds the Format select and nothing else — the hook owns what a default
  // does to filter state, this panel owns only handing it the deck's answer. See
  // {@link DeckSearchPanelProps.defaultFormat} for why that is a seed rather than a fence.
  //
  // **The seed is applied on mount, and this component mounts on the press** — so a reader who
  // opens the panel, changes the Format filter and then collapses it gets the deck's format
  // back on the next open, rather than the filter they left. That is the same throw-away rule
  // the doc above states for every other piece of this panel's state, and it is the right one
  // here for a reason of its own: a *default* the reader has to re-clear on every open would be
  // a fence, which is exactly what `defaultFormat` promises not to be — but a default that
  // silently stopped applying after the first open would be a seed that only worked once.
  //
  // **A railing is the case that deliberately does not re-seed.** The editor taking the width
  // back does not unmount this component, so nothing is applied a second time and the format
  // the reader picked is still theirs when the room returns. A resize is not a decision, and
  // this used to answer one as though it were: the panel remounted on the way back and put the
  // deck's format over a filter the reader had cleared.
  const tip = useTooltip();
  // **`availableForDeck` is not a filter and does not belong with the seed above it.** It
  // changes what the word *owned* means for this whole request: every tile's `×N` and the
  // Owned/Missing chip count the copies **this deck can use**, so a playset sleeved into
  // another deck stops being an offer this column makes. The Collection tab two components
  // over has answered the same question since folders landed (`DEFAULT_ALLOCATION`), and until
  // now the two tabs of one panel disagreed about the same card — issue #349. The deck's own
  // group still counts, which is what keeps this number and the deck row's "you own 2 of 4"
  // one story rather than two.
  const search = useCardSearch({ defaultFormat, availableForDeck: deckId });
  const { query, rows, searchKey, marketplace } = search;
  // The currency this column's chins quote in. Taken off the search's own marketplace rather
  // than read again here, so the rows and the money on them come from one answer — that
  // marketplace is in the query key, so a switch refetches instead of re-labelling figures from
  // another feed.
  const currency = marketplace.currency;

  // Read here rather than handed down: the root's own `selectedCardId` is for the caret effect,
  // and this is the wall's selection. One field, two subscriptions, no round trip either side.
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  /**
   * **`openCardFromDeckSearch`, not `setSelectedCardId`** — the one write in the app that says a
   * card was opened from *this* column.
   *
   * What it buys is on the other side of the desk: the editor draws the card pane as an overlay,
   * and this is what puts it over the **deck** attached to this column's left edge rather than
   * over this column itself (issue #183). A search whose answer covers the search is the failure
   * the flag exists to prevent, and it has to be written where the press is: every other opener
   * in the editor — a deck tile, a validation-panel card name — means the other side, and says so
   * by going through `setSelectedCardId`, which clears the flag in the same `set`.
   */
  const selectCard = useAppStore((s) => s.openCardFromDeckSearch);

  /**
   * What the picked id is *called*, for the two names every Add button carries — or `null` under
   * {@link AUTO_CATEGORY}, where the pile is not chosen here at all and is named per card below.
   *
   * The editor answers `AUTO_CATEGORY` for an id its `categories` does not carry, so the miss
   * below is not a state this panel expects — but it is one a single render can be caught in,
   * because a deleted pile reaches the deck row and the category list on the same commit and
   * nothing orders those two. "this deck" is the honest thing to say about an id whose name is
   * not in hand: the deck is what the press writes to, and if the id really is stale
   * `deck_add_card` refuses it in words (`category_of_deck`) into the alert above the wall.
   * Reading `.name` off `undefined` would instead take the whole panel down over a label.
   */
  const auto = targetCategoryId === AUTO_CATEGORY;
  const targetName = auto
    ? null
    : (categories.find((c) => c.id === targetCategoryId)?.name ?? "this deck");

  /**
   * Every drawn tile, as a card that can be dragged into a category.
   *
   * The wall builds its own tiles, so this is the only way to hand a library an element: one
   * `draggable()` per tile, torn down by the cleanup React 19 takes from a ref callback. The
   * *drop* is the category column's business — this end only says what is being carried.
   *
   * A stable identity, so the registration is not torn down and rebuilt on every render of a
   * panel that re-renders on every keystroke. The tile's element is passed fresh each time,
   * and the card with it, so nothing here goes stale.
   *
   * The Add button beside the art does the same thing for the keyboard and for anyone who
   * would rather press than drag (spec §7's click-to-add fallback, which is the *primary*
   * path — this is a shortcut over it), and it marks itself `data-no-drag` so that a press on
   * it is a press: `cardDraggable` has the story, and the tile's *art* stays draggable
   * because the exclusion is marked rather than guessed from the tag.
   */
  const tileRef = useCallback(
    (card: CardSummary, element: HTMLElement | null) =>
      element
        ? cardDraggable({
            element,
            payload: () => ({
              kind: "search-card",
              cardId: card.id,
              name: card.name,
              // Carried even though every drop target inside this editor is a category that
              // names itself: a tile can also be let go on the sidebar's Decks entry, which
              // names none. One payload shape, whichever target takes it (`dnd.ts`).
              typeLine: card.typeLine,
            }),
          })
        : undefined,
    [],
  );

  const addFailure = add.isError ? ipcError(add.error) : null;
  // query-core keeps the pages it has when a fetch fails, so `isError` arrives with rows still
  // in hand — reading it as "show the error instead" would throw away results the reader is
  // part way through.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    // A fragment, so these stay flex children of the panel's own column: the row above them, the
    // banners, the filter row, the count line and the wall are one stack and this component is
    // not a box in the middle of it.
    <>
      {/* Grown into place rather than shoved in: this panel is a fixed-width column of stacked
          rows, so a banner appearing at the top of it pushes the filter row, the summary and
          the whole wall of tiles down together. The animated element is the wrapper and carries
          only `overflow-hidden` — `statusLine` takes `height` to 0, and under `box-sizing:
          border-box` a box with its own padding and border can never be shorter than the two of
          them. */}
      <AnimatePresence initial={false}>
        {addFailure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              Could not add that card — {addFailure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <FilterBar search={search} layoutToggle={false} />

      {/* One live region, mounted for as long as the panel is open: a region that appears
          together with its text announces nothing, because there was no change to notice. */}
      <p
        role="status"
        className={cn(
          "shrink-0 text-xs",
          empty && failure ? "text-destructive" : "text-dim",
          empty && "py-8 text-center",
        )}
      >
        {summaryOf(search, failure)}
      </p>

      {/* The wall below is what moves when this arrives, so it grows in for the reason the
          add banner above it does. Same split for the same reason: padding and border on the
          child, height and `overflow-hidden` on the animated wrapper. */}
      <AnimatePresence initial={false}>
        {!empty && failure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              <span className="min-w-0">
                {query.isFetchNextPageError
                  ? "Could not load more cards"
                  : "Could not refresh these"}{" "}
                — {failure}
              </span>
              {query.isFetchNextPageError && (
                <button
                  type="button"
                  onClick={() => void query.fetchNextPage()}
                  className={cn(
                    "ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-0.5",
                    "transition-colors duration-150 hover:bg-destructive/20 motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  Try again
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!empty && (
        <CardGrid
          rows={rows}
          // The panel's own search, so a new one starts at the top of the wall rather than
          // wherever the last one was scrolled to.
          listKey={searchKey}
          // **The section this whole change was made for.** This column and the deck laid out
          // beside it are on screen together, and until now one number sized both — so a reader
          // asking for bigger art in here got bigger cards in their deck, which they had not
          // asked for and had no way to undo separately. `deckSearch` is this column's alone;
          // the deck's two views share `deck`. See `CardGrid`'s `zoomSection`.
          zoomSection="deckSearch"
          // Ctrl and Shift build a set of tiles here, and a drag from any member carries all of
          // them into a category column beside it (issue #214).
          //
          // **A constant rather than a per-deck string, and that is `deckCardSlot`'s rule read
          // across**: one editor is mounted at a time, so this column belongs to whichever deck is
          // open and cannot be confused with another's. What matters is only that it differs from
          // the deck's own `deck:<id>` — which is what makes a press on a tile in here put the
          // deck's selection down, since a pick in a new scope replaces the whole set.
          selectionScope="deck-panel"
          baseTileWidth={TILE_BASE}
          selectedId={selectedCardId}
          // **A one-argument arrow, and the parameter is dropped rather than adapted.**
          // `CardGrid`'s `onSelect` widened to `(id, card)` on 2026-08-26, for the walls whose
          // tiles are not simply printings and which need to read something off the row. This
          // column's are — one tile per printing, no keys, no finishes — so there is nothing on
          // the row it wants.
          //
          // It can no longer be passed bare, which is the whole of why this is not still
          // `onSelect={selectCard}`: `openCardFromDeckSearch`'s **second** parameter is an
          // optional `Finish`, so a bare reference lines the tile's `CardSummary` up against that
          // and fails to compile. The arrow says the same thing the bare reference always meant —
          // a search tile names no finish, so the card opens at the store's own `null` default,
          // exactly as it did before the widening.
          onSelect={(id) => selectCard(id)}
          tileRef={tileRef}
          // The crown in a tile's top-right chip: the same fact the search view's wall marks,
          // marked the same way here — see `tileGameChanger`.
          gameChanger={tileGameChanger}
          // What the chin says one copy costs — the **spread**, through `priceRange`, which is
          // the search page's own helper over the same rows. This tab *is* the card search in a
          // 384px column: same hook, same collapse, so a card that costs one thing on the search
          // page and another in here would be the reader learning that a price means something
          // about which wall they found it on. A collapsed row stands for every printing that got
          // past the filters, so a single figure would be a claim about one of them; equal ends
          // collapse to one price rather than repeating themselves.
          //
          // Spec §5's as-of sentence is said once for this wall, not on every tile, which is why
          // this slot is a bare figure.
          money={(card) => priceRange(card.priceLow, card.priceHigh, currency)}
          // The whole tile is the target — the art, its corner chip and the caption under it.
          // The wall's own `cardMenu` slot, so this panel knows nothing about menus beyond
          // where a right-click lands.
          cardMenu={cardMenu}
          cardMenuKey={cardMenuKey}
          badge={(card) => <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />}
          action={(card) => {
            // Where this card would land, named before the press rather than reported after it.
            // Under `Auto` that is `autoCategoryFor`'s own answer for *this* card, which is the
            // whole reason the rule reads the type line and nothing else: it is the only kind of
            // answer a button can promise in advance and a reader can predict from the card in
            // their hand. Found or created on the way in, so a deck with no Artifact pile grows
            // one and the button said so.
            const landsIn = targetName ?? autoCategoryFor(card);
            return (
              <button
                type="button"
                // The tile is draggable and this is its one control: a press that slips a few
                // pixels is a press, not a drag (`cardDraggable`).
                data-no-drag=""
                // Named for the card *and* where it is going: two tiles' buttons both called
                // "Add" are two controls a screen reader cannot tell apart, and the category is
                // the one thing about this press that is not visible on the tile.
                aria-label={`Add ${card.name} to ${landsIn}`}
                {...tip(`Add to ${landsIn}`, { describes: false })}
                // Never disabled while a write is in flight, and that is the behaviour rather
                // than an omission: `deck_add_card` **folds into** the row it finds, so pressing
                // three times is three copies. Disabling would drop presses two and three, and
                // "press it again for another one" is how a deck gets built.
                //
                // Under `Auto` this sends **no category and the card's type line**, which is what
                // puts the rule on `useDeck`'s single definition rather than here: this component
                // computes the *word on the button* and the hook computes the word it sends, from
                // the same function over the same fact.
                // The per-call `onSuccess` carries the row the write landed in back to the
                // editor, which marks it for five seconds — the whole point being that the deck
                // is over *there* and the reader is looking *here*. It is per call rather than
                // on the mutation because the mutation is shared: `useDeck`'s own `onSuccess`
                // answers for every surface that borrows it, including one with no editor on
                // screen. See {@link DeckSearchPanelProps.onAdded}.
                onClick={() =>
                  add.mutate(
                    auto
                      ? { cardId: card.id, typeLine: card.typeLine, quantity: 1 }
                      : { cardId: card.id, categoryId: targetCategoryId, quantity: 1 },
                    { onSuccess: (change) => onAdded?.(change.id) },
                  )
                }
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-md border border-border text-dim",
                  "transition-colors duration-150 motion-reduce:transition-none",
                  "hover:border-accent hover:text-accent",
                  FOCUS,
                )}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            );
          }}
          onNeedNextPage={() => {
            if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
              void query.fetchNextPage();
            }
          }}
        />
      )}

      {/* **Spec §5: a price is never shown without saying how old it is** — said once under the
          wall, in the same words and the same voice as the other three catalogue walls, so the
          four read as one thing.

          **This is the narrowest surface in the app, so it is the one where the sentence costs
          height — and it costs less than it looks like it will.** Measured headless over the built
          stylesheet with the real webfont, at the 193px content box `MIN_PANEL_WIDTH_PX` (206)
          leaves: **two lines, 33.59px**, and the same two lines for all five marketplaces —
          including the longest, `"Card Kingdom prices as of the last price-feed refresh."` At the
          panel's 384px opening width it is **one line, 16.8px**. So the worst case is one extra
          line of 11.2px type at a width the reader has to drag to.

          Drawn unconditionally either way: the rule has no narrow-surface exemption, and a price
          with no date is worse than a wall one line shorter. `shrink-0` so the wall gives up the
          height rather than this being squeezed to nothing.

          **Serve dist over http to re-measure this, never `file://`** — dist's CSS references its
          fonts with absolute `/assets/…` URLs, which from a file page resolve to the drive root
          and fall back to the generic sans-serif without saying so. The tell is measuring one
          string twice, once in the app's stack and once forced to `sans-serif`: identical widths
          mean the real face never loaded (265.2px against the true 272.78px here).

          Unconditional on the layout, unlike the search page's and the Tags page's, because this
          panel has no table: `leaves the grid-or-table choice to the search view` is its own
          test, so the wall is the only thing that can be on screen here. */}
      {!empty && (
        <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
      )}
      {/* No `prefetchImages` effect, deliberately — the search view's warms a page of 50
          because a 1 200px wall shows forty tiles at once, and the reader is a scroll away from
          the rest. Two tiles per row is not that wall: `CardGrid`'s overscan already mounts the
          next two rows of `<img>`s, which is four images ahead of the reader by the same
          protocol and no round trip of its own. */}
    </>
  );
}
