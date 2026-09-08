import {
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { OwnedBadge } from "@/components/OwnedBadge";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardSearchBody } from "@/features/search/CardSearchBody";
import { CardSearchPanel } from "@/features/search/CardSearchPanel";
import { useCardSearch, type FormatFilterOption } from "@/features/search/useCardSearch";
import { useSearchOpen } from "@/features/search/useSearchOpen";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CardSummary, type DeckCategory } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, autoCategoryFor } from "./autoCategory";
import { CollectionSearchTab } from "./CollectionSearchTab";
import { cardDraggable } from "./dnd";
import type { Deck } from "./useDeck";

/**
 * **Re-exported, not re-declared** — both moved to `features/search/CardSearchPanel.tsx` on
 * 2026-09-07 when the collection and the wishlist grew the same column, and both are still asked
 * for by this name: `DeckEditor` measures its desk against the minimum, and `DeckEditor.test.tsx`
 * and `DeckSearchPanel.test.tsx` both probe the overlay attribute.
 *
 * A re-export rather than a second constant, because a width spelled twice is a width that
 * drifts — and because `MIN_PANEL_WIDTH_PX` is not a number this editor chose. It is what one
 * card and its chrome measure, and the deck's floor is compared against it rather than the other
 * way round.
 */
export { MIN_PANEL_WIDTH_PX, SEARCH_OVER_ATTR } from "@/features/search/CardSearchPanel";

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
 * measurement rather than taste.** This panel is dragged down to `MIN_PANEL_WIDTH_PX`, whose
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
 * the first half was. That is one fact rather than two, so {@link DEFAULT_DECK_SEARCH_TAB} is read
 * off this array rather than spelled again beside it.
 */
const TABS = [
  { id: "collection", label: "Collection" },
  { id: "all", label: "All cards" },
] as const satisfies readonly { id: DeckSearchTab; label: string }[];

/**
 * One row of {@link TABS} — what {@link tabsFor} answers a list of and what {@link TabStrip}
 * draws.
 *
 * Structural rather than `(typeof TABS)[number]`, because {@link tabsFor} takes a row *out* of
 * that tuple and a type read off the whole of it would go on carrying `"collection"` into the
 * list that no longer has one.
 */
interface DeckSearchTabDef {
  id: DeckSearchTab;
  label: string;
}

/**
 * Which of the two searches this deck may show — **`Collection` is dropped whole for a deck that
 * tracks none**, rather than drawn and refused.
 *
 * A Virtual deck (issue #401) has no `collection_folders` group and draws no owned figure
 * anywhere in this editor, so a Collection tab here would be a search of the reader's binder
 * offering to file copies into a list that counts none of them. **Dropped rather than greyed**,
 * which is the editor's standing answer for a control that cannot act — `DeckStats`' two presses
 * one component over — and it is the stronger case of the two: the Theory tab's refusals are one
 * press from the tab that *can* act, where this one would refuse for the whole life of the deck.
 *
 * Filtered off {@link TABS} rather than written out as a second array, so a third tab is ordered
 * once and every label is spelled once.
 */
function tabsFor(tracksCollection: boolean): readonly DeckSearchTabDef[] {
  return tracksCollection ? TABS : TABS.filter(({ id }) => id !== "collection");
}

/**
 * Where the reader's answer about *which* search is kept for the life of the window.
 *
 * Exported for `SEARCH_OPEN_KEY`'s reason: a test or a story that wants the panel to open on
 * the card search seeds the cache rather than pressing the control, and a key spelled twice is a
 * key that drifts.
 */
export const DECK_SEARCH_TAB_KEY = ["deckSearchTab"];

/**
 * The tab to draw, given whatever is in the cache and whichever tabs *this deck* has — and it
 * answers two questions that look like one.
 *
 * **A value this build does not draw** — `isPrintingGroupBy`'s shape and its reason: the entry is
 * untyped at the cache, so a story, a stale build or a seeded test may have put anything in it.
 *
 * **A tab this deck does not draw**, which is the Virtual case (issue #401): the memory is
 * app-wide and the reader's last press may well have been `Collection` on some other deck, so a
 * deck with no such tab has to fall somewhere. `tabs[0].id` is where — the first tab is the one
 * the panel opens on, which is exactly what {@link DEFAULT_DECK_SEARCH_TAB} says of the full list.
 *
 * **It is a *read* and never a repairing write**, which is the half worth stating: nothing here
 * puts the fallback back into the cache, so a reader who works out of their collection keeps that
 * answer while they are standing in a deck that cannot honour it, and gets it back on the next
 * deck that can. `AUTO_CATEGORY`'s rule — an id the deck's `categories` does not carry reads as
 * Auto, because there is nothing to repair.
 */
function drawnTab(stored: unknown, tabs: readonly DeckSearchTabDef[]): DeckSearchTab {
  return tabs.find(({ id }) => id === stored)?.id ?? tabs[0].id;
}

/**
 * The tab a reader who has never pressed one gets — **the collection, and that is the product
 * decision this whole change is** (spec §7.2).
 *
 * A deck is built out of cards you have. A search of everything ever printed is what you reach for
 * when your own binder does not answer, so it is the thing one press away rather than the thing in
 * front of you; until now this panel had it the other way round and there was no way to search a
 * collection from a deck at all.
 *
 * **Read off {@link TABS} rather than written out**, because that array's order already *is* this
 * decision — the first tab is the one the panel opens on, which is what its own note says. Two
 * spellings would be two places a reordering has to reach.
 *
 * It stays the whole list's answer even where the panel cannot honour it: a Virtual deck's
 * fallback is {@link drawnTab}'s, taken off the tabs that deck actually draws, and nothing writes
 * that fallback back over this.
 */
export const DEFAULT_DECK_SEARCH_TAB: DeckSearchTab = TABS[0].id;

/**
 * Which search the reader last chose — remembered across decks, for the length of the session.
 *
 * **The query cache rather than a `useState` here, for `useSearchOpen`'s reason and with
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
function useDeckSearchTab(tabs: readonly DeckSearchTabDef[]): {
  tab: DeckSearchTab;
  setTab: (tab: DeckSearchTab) => void;
} {
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
  // Resolved on the way out rather than trusted, and against the tabs *this deck* draws rather
  // than against the vocabulary: `undefined` is the first render before the resolved `queryFn`
  // has landed, a seeded entry is whatever the seeder wrote, and `"collection"` is what a reader
  // who works out of their binder leaves behind on every other deck. See {@link drawnTab}.
  return { tab: drawnTab(stored, tabs), setTab };
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
   * Does the deck this column is docked beside read the reader's collection at all?
   * `deckKind.ts`'s `tracksCollection(deck)`, answered by the host.
   *
   * `false` is a **Virtual** deck (issue #401) and takes the whole Collection tab with it — the
   * search of the reader's binder, its `collection_to_deck` write, and, with one tab left, the
   * strip that would offer to switch between them. What is left is the card search this panel has
   * always been. See {@link tabsFor} for why the tab is dropped rather than greyed, and
   * {@link drawnTab} for what happens to a reader whose last press was `Collection` on some other
   * deck.
   *
   * **The boolean and not the deck, and not the helper either**: this panel is handed facts and
   * draws them, exactly as it is handed {@link DeckSearchPanelProps.categories} and
   * {@link DeckSearchPanelProps.defaultFormat} rather than reading the deck row itself. It has the
   * `deckId` and could fetch one — which is the second observer of `["decks","detail",id]` that
   * every other prop on this interface exists to avoid.
   *
   * **Required rather than optional**, which is `DeckStats`' rule for the same answer one
   * component over: a host that has not thought about it must not silently get the
   * collection-reading case, because that is the arm that offers a reader's binder to a deck that
   * counts none of it.
   */
  tracksCollection: boolean;
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
   * What the *reader* last chose about the disclosure, and it starts **open** — on this deck, on
   * the next one, and on the next launch (issue #183, 2026-08-22). What is drawn is this and
   * {@link roomy} together.
   *
   * **Hoisted into `DeckEditor` on 2026-09-07 and optional here, which is a pair of decisions
   * rather than one.** The hoist is what lets the three surfaces each remember their own answer
   * without this component knowing which of them it is — the editor reads the setting and hands
   * the pair down, exactly as it already hands down `add` and `categories`. The *optionality* is
   * what keeps this panel mountable on its own: `DeckSearchPanel.test.tsx` and
   * `DeckSearchPanel.stories.tsx` both render it with a mutation and nothing else, and both seed
   * the stored answer through the query cache rather than through a prop, which is the state a
   * *stored* preference actually puts the panel in.
   *
   * So absent means "ask `useSearchOpen("deck")` yourself", and given means "the editor has
   * already asked". The hook is called either way — it cannot be called conditionally — and costs
   * nothing when it is not read: the query is `staleTime`/`gcTime: Infinity` behind one prefetch
   * at `AppShell`, so a second observer of it is a cache read and never a round trip.
   *
   * **The press is what is written, never the drawn state.** A railing is a measurement about a
   * narrow window and not a thing the reader asked for, so it must not reach the stored answer.
   */
  open?: boolean;
  /** The other half of {@link open}. Absent with it, given with it. */
  setOpen?: (open: boolean) => void;
  /**
   * Whether the editor has room to draw this open — measured, not guessed (see
   * `DeckEditor`'s `DECK_FLOOR`), and forwarded to `CardSearchPanel` whose doc carries the whole
   * of what it decides.
   *
   * `false` renders the rail whatever the reader last chose. **It decides what is _drawn_ and
   * never what is _mounted_**: a panel the reader had opened is *hidden* when the room goes rather
   * than torn down, so the typed query, the filter row, the facets and the pages already fetched
   * are all still there when the room comes back.
   */
  roomy?: boolean;
  /**
   * How wide to draw this panel **over** the deck, in px — the desk's own width — for a desk too
   * narrow to hold the deck and this column side by side. Absent is a desk that can.
   *
   * The door out of the rail, added 2026-08-29: below 414 the panel used to rail *and refuse*, on
   * a 390px phone that has no width to give. `CardSearchPanel`'s own prop doc carries the whole
   * argument and the placement it borrows from issue #183.
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
   * **A cap on the drawn width, not a correction to the reader's** — the clamp split is
   * `CardSearchPanel`'s, and its doc is where that is written out.
   *
   * Absent — and `Infinity` — mean *unmeasured*, which is the first paint's honest answer and
   * reads as no cap; the editor's observer answers on the same frame.
   */
  maxWidth?: number;
}

/**
 * The path by which cards enter a deck.
 *
 * **Chrome from `CardSearchPanel`, wall from `CardSearchBody`, and what is left here is the deck**
 * (2026-09-07). This file was 1595 lines and roughly two thirds of them were a disclosure, a
 * splitter, three drawn states and a wall — none of which is about a deck, and all of which the
 * collection's and the wishlist's own sidebars now draw. What did not move is listed on {@link
 * DeckSearchPanelProps} and is exactly the deck-shaped half: the tab strip and its memory,
 * {@link CollectionSearchTab}, the categories, `AUTO_CATEGORY`, `deck_add_card`, the landed glow,
 * `availableForDeck` and the format seed.
 *
 * Not a second search: {@link OpenPanel} is `useCardSearch` + `CardSearchBody` — the search view's
 * own parts — in a column beside the deck, with the wall's two slots pointed at this job. The
 * `badge` slot keeps telling the collection story (a card in the binder is one the deck can be
 * built out of today) and the `action` slot becomes **Add to deck**.
 *
 * A **fixture of the editor, not a dismissible layer**: this panel registers no rung of its own,
 * so Escape pressed in here falls past it — to whatever card or dialog is open over the desk
 * (`"inner"`), and otherwise to the editor's own `"navigation"` floor, which closes the deck. The
 * way to put the panel away — and the way to get it out — is the disclosure it names itself by.
 * The one dismissible thing inside it is the set picker's listbox, which is already an `"inner"`
 * layer of its own.
 *
 * The tiles stay selectable, so the card surface keeps working from inside the editor: clicking
 * the art opens the card exactly as it does on the search view, and the Add button beside it does
 * not.
 */
export function DeckSearchPanel({
  add,
  onAdded,
  categories,
  deckId,
  targetCategoryId,
  tracksCollection,
  defaultFormat,
  open: openProp,
  setOpen: setOpenProp,
  cardMenu,
  cardMenuKey,
  roomy,
  overWidth,
  maxWidth,
}: DeckSearchPanelProps) {
  // The fallback for a panel mounted on its own — see {@link DeckSearchPanelProps.open}. Called
  // unconditionally because a hook must be, and free when the editor has already answered: the
  // query behind it is `staleTime`/`gcTime: Infinity` over one prefetch at `AppShell`.
  const stored = useSearchOpen("deck");
  const open = openProp ?? stored.open;
  const setOpen = setOpenProp ?? stored.setOpen;
  // The tabs *this* deck draws, and the one the reader is on — resolved together, because the
  // second is only answerable against the first. See {@link tabsFor} and {@link drawnTab}.
  const tabs = tabsFor(tracksCollection);
  const { tab, setTab } = useDeckSearchTab(tabs);

  return (
    <CardSearchPanel
      surface="deck"
      title="Search cards"
      // **`Add cards`, not a sentence naming the deck**, and it is the one section label of the
      // three that says nothing about which list it files into: this panel is inside a deck
      // editor, which is a landmark that has already said so. The two page sidebars name theirs,
      // because each of those shares a route with the list it is adding to.
      sectionLabel="Add cards"
      toggleLabel="card search"
      open={open}
      setOpen={setOpen}
      roomy={roomy}
      overWidth={overWidth}
      maxWidth={maxWidth}
      // **Above the body rather than inside it**, which is what makes it the panel's own chrome
      // rather than one tab's: it is drawn for both tabs, it does not move when they switch, and
      // it survives the railing that merely *hides* the body below — so a width change cannot take
      // the reader's tab away any more than it takes their query. The shell draws it only while
      // the panel is, which is why this is handed over whole rather than gated here.
      //
      // **No strip at all where there is one tab left**, which is the Virtual deck (issue #401):
      // a two-way control drawn with one answer is a control that cannot be used, and a lit rule
      // under the only word on the row says *you are here* to a reader who could not be anywhere
      // else. Nothing else lives on that row — `CardSearchPanel` draws this node and nothing
      // beside it, with the chevron and the heading in the row above and the search box in the
      // body below — so dropping it drops one strip and no affordance. The panel then reads as
      // what it is: one search, under its own heading.
      //
      // `undefined` rather than `false`, because that is what the shell's prop is typed as absent.
      tabs={tabs.length > 1 ? <TabStrip tabs={tabs} tab={tab} onPick={setTab} /> : undefined}
    >
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
            they are drawn. */}
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
          targetCategoryId={targetCategoryId}
          defaultFormat={defaultFormat}
          deckId={deckId}
          cardMenu={cardMenu}
          cardMenuKey={cardMenuKey}
        />
      )}
    </CardSearchPanel>
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
 * Safe at `MIN_PANEL_WIDTH_PX` without measuring anything, which the pill it replaced was
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
function TabStrip({
  tabs,
  tab,
  onPick,
}: {
  /**
   * The tabs to draw — {@link tabsFor}'s answer for this deck, not {@link TABS}.
   *
   * Handed in rather than read here, so that "which tabs does this deck have" is decided once and
   * the strip cannot come to draw a tab the panel below it will not mount. The call site draws
   * this at all only when there are two of them, so what arrives is always the pair; taking the
   * list anyway is what keeps that a fact about the call rather than an assumption in here.
   */
  tabs: readonly DeckSearchTabDef[];
  tab: DeckSearchTab;
  onPick: (tab: DeckSearchTab) => void;
}) {
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
      {tabs.map(({ id, label }) => (
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
 * The card search tab's body — **mounted only while the reader has the disclosure open and this
 * tab selected**, which is the whole reason it is a component rather than a branch inside
 * {@link DeckSearchPanel}.
 *
 * A hook cannot be called conditionally, so `useCardSearch` sitting in the root meant its query
 * ran for every deck the reader opened whether or not they had asked for a wall. Closed is
 * nothing mounted here for the same reason it is in `Dialog`: the search, its filter state,
 * its facets and its scroll position all begin at the press and cost nothing before it. A
 * *reader's* collapse throws that state away rather than hiding it, and that is the intended
 * reading — this is a column you open to do a job and shut when the job is done.
 *
 * **A railing is not a collapse and must not be read as one.** `roomy` goes false on a width
 * change nobody asked for — the card pane opening at 1024 is the measured case — so the shell
 * *hides* this subtree and leaves it mounted. The query, the typed text, the filters and the
 * facets are where the reader left them when the room comes back. The one thing that does not
 * survive is the wall's scroll offset, which is the browser's rather than this component's: a
 * box that has been `display: none` comes back at the top.
 *
 * **What stays in the shell is what a collapse must not be able to take**: the disclosure button,
 * whose identity across the two states the caret depends on, and the `roomy` refusal drawn on it.
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

  // Read here rather than handed down: the shell's own `selectedCardId` is for the caret effect,
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
   * **`tileRef` rather than `CardSearchBody`'s `dragRecord` seam**, which is the one place this
   * panel and the two page sidebars differ about the same wall: a deck category reads a
   * `DragPayload` through `dnd.ts`, and this registers `cardDraggable` on the element itself so
   * the deck's own auto-scroll and drop feedback are the ones already built. The two seams do not
   * compose and `CardGrid` enforces it.
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

  return (
    <CardSearchBody
      search={search}
      // **The section this whole change was made for.** This column and the deck laid out
      // beside it are on screen together, and until this landed one number sized both — so a
      // reader asking for bigger art in here got bigger cards in their deck, which they had not
      // asked for and had no way to undo separately. `deckSearch` is this column's alone; the
      // deck's two views share `deck`. See `CardGrid`'s `zoomSection`.
      zoomSection="deckSearch"
      // **A constant rather than a per-deck string, and that is `deckCardSlot`'s rule read
      // across**: one editor is mounted at a time, so this column belongs to whichever deck is
      // open and cannot be confused with another's. What matters is only that it differs from
      // the deck's own `deck:<id>` — which is what makes a press on a tile in here put the
      // deck's selection down, since a pick in a new scope replaces the whole set.
      selectionScope="deck-panel"
      addFailure={add.isError ? ipcError(add.error) : null}
      tileRef={tileRef}
      selectedId={selectedCardId}
      onSelect={selectCard}
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
    />
  );
}
