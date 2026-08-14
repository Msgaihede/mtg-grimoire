import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FILTER_CONTROL, FILTER_FOCUS } from "@/components/FilterChips";
import { OwnedBadge } from "@/components/OwnedBadge";
import { CardGrid } from "@/features/search/CardGrid";
import { FilterBar } from "@/features/search/FilterBar";
import { summaryOf } from "@/features/search/SearchPage";
import { useCardSearch, type FormatFilterOption } from "@/features/search/useCardSearch";
import { ipcError, type CardSummary, type DeckCategory } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { autoCategoryFor } from "./autoCategory";
import { FOCUS } from "./cardControl";
import { cardDraggable } from "./dnd";
import type { Deck } from "./useDeck";

/** Why the disclosure will not open, said where it is refused. */
const NO_ROOM = "Not enough room — close the card details or widen the window";

/**
 * How wide the panel is when it is open, in px and in the class that draws it — the editor
 * reads the number to decide whether there is room for the panel at all.
 *
 * The direction's docked column is 320 and this is 384, and the reason is the wall rather than
 * the filter row: 320 leaves **267** inside the panel's padding, the wall's padding and the
 * scrollbar, which is one tile at any floor a card is still legible at (two would be 127px
 * each). 384 leaves 331 and holds two. The filter row is the smaller half of it — the
 * mana-value chips are nine 36px squares 4px apart, **356px**, which at 320 would *squash* to
 * fit (their group has no `flex-wrap`, and a flex item with a set width still shrinks); with
 * one `flex-wrap` on that group they would instead wrap to a second line, costing 44px of the
 * wall's height for the privilege of a narrower panel. Neither is a break, and neither is
 * worth the tile.
 *
 * Measured in the running window at 1280×800: header 36, filter row 168 (four wrapped lines),
 * count line 16, and 341px of card wall.
 */
export const PANEL_WIDTH_PX = 384;
const PANEL_WIDTH = "w-96";

/**
 * The "Add to" value meaning **the card's type line decides** — the default, and the one value
 * in that select that is not a category.
 *
 * `0`, because `deck_categories.id` is an `INTEGER PRIMARY KEY` and `dnd.ts`'s `isCategoryId`
 * refuses anything but a positive safe integer, so no real category can ever collide with it.
 * `DeckEditor` already held `0` as a sentinel meaning "nothing picked yet", replaced by its
 * clamp on the first render that had a deck — and *that* is what made a fresh deck file every
 * quick add into `categories[0]`, which is the seeded **Commander** pile. Giving the sentinel a
 * meaning instead of a replacement is the whole of the fix: nothing overwrites it, so an add
 * nobody filed is filed by `autoCategoryFor`.
 *
 * Exported because the editor owns the state and this panel draws the choice; one constant is
 * one place for the two of them to agree what zero means.
 */
export const AUTO_CATEGORY = 0;

/**
 * What the select calls {@link AUTO_CATEGORY}. Named for what it reads rather than for what it
 * does — "Auto" alone would not say *how*, and the how is the whole predictability of it.
 *
 * It read `Auto (by card type)` while the type line was the whole of the rule, and that was
 * still on screen after the rule changed — **found by driving the shipped window on 2026-08-14,
 * not by the suite**, which pinned the string in four places and so agreed with itself. The
 * wording matches the Categories dialog's button ("File cards by what they do") on purpose: they
 * are the same rule, and a reader who meets it twice under two names has to work out that it is
 * one rule.
 */
const AUTO_LABEL = "Auto (by what it does)";

/**
 * The wall's tile floor in here, and the number that decides whether this column shows one
 * card or two.
 *
 * 384 is **331** by the time the panel's own left padding (12), the scrollbar (17) and the
 * wall's padding (24) are off it — measured at 330 in the running window — which is 23 short
 * of two of `CardGrid`'s standard 170px tiles. At the standard floor this column drew one
 * 330×490 card per row inside a 341px-tall wall: less than a whole card, ever. At 150 the same
 * 331 is two 159px tiles, which is the "~2 tiles per row" this panel was scoped around.
 *
 * **All of that describes 100% zoom, and only 100%.** `CardGrid` scales whatever floor it is
 * handed by the reader's `cardZoom`, this number included, so the two-per-row scoping above is
 * the *resting* shape rather than an invariant: at 2× this column draws one 300px tile and at
 * 0.5× it draws four 75px ones, which is the reader asking for exactly that and getting it. The
 * measurement is kept unqualified because it is what sets the resting value; nothing here needs
 * a per-zoom override.
 */
const TILE_FLOOR = 150;

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
   * Where a card may be put, in the order the select offers them — the editor's own list of
   * the open deck's categories, so this panel offers exactly the columns beside it.
   *
   * Not in the plan's sketch of this interface, and it has to be: the alternative is a second
   * component reading the deck's categories beside the one that already has them, which is how
   * a panel starts offering a pile the editor is not drawing.
   */
  categories: readonly DeckCategory[];
  /** The category every add lands in, by id. Owned by the editor, which clamps it when the
   *  picked category is renamed away, switched off or deleted under it. */
  targetCategoryId: number;
  onTargetCategoryChange: (categoryId: number) => void;
  /**
   * The format the filter row's Format select **opens** on — the open deck's, handed down
   * rather than read here, for the reason {@link DeckSearchPanelProps.categories} is: the
   * editor already holds the deck row and the `format_specs` row beside it, and a second
   * component reading the open deck's format beside the one that already has it is how a panel
   * starts filtering for a format the editor is not showing.
   *
   * **A default, never a constraint.** It seeds `useCardSearch`'s `format` state and reaches
   * nothing else: `Any format` stays first in the list, the reader may move the select to any
   * format including one this deck is not legal in, and the card they then press Add on is
   * added. Legality is `validation/engine.ts`'s `RULE BREAK` on the card once it is in the
   * deck, and why that is the only place it may be answered is the docked panel's bullet in
   * this folder's `CLAUDE.md`.
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
   */
  roomy?: boolean;
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
 * that rule; everything the reader merely *consults* is a `DeckDialog`.
 *
 * The tiles stay selectable, so the pane keeps working from inside the editor: clicking the
 * art opens the card exactly as it does on the search view, and the Add button beside it does
 * not.
 */
export function DeckSearchPanel({
  add,
  categories,
  targetCategoryId,
  onTargetCategoryChange,
  defaultFormat,
  roomy = true,
}: DeckSearchPanelProps) {
  /**
   * What the *reader* last chose, and it starts **collapsed** (changed 2026-08-14). What is
   * drawn is this and `roomy` together.
   *
   * The panel is {@link PANEL_WIDTH_PX} plus the desk row's 16px gap out of a row measured at
   * **602px** at 1280×800 with the card pane docked (`DeckEditor`'s `DECK_FLOOR` carries that
   * measurement), which leaves the deck **202px** — one stack column. Open by default, every
   * reader paid that on every deck they opened whether or not they were adding cards; collapsed,
   * the deck starts with the whole desk and one press on the rail gets the wall back.
   *
   * **Per editor-open, and deliberately not remembered.** This is `useState` and not a
   * `useAppStore` field, so a reader who opens the panel, leaves the deck and comes back finds it
   * collapsed again. That is the choice rather than the omission it looks like: `cardZoom`,
   * `searchView` and `collectionView` are session-wide answers to questions about the *app*, and
   * which way a reader last left one particular deck's search column is not one of them. It is
   * not the deck's either — `rememberView` keeps `lastVariant`/`lastGroupBy`/`lastSortBy` on the
   * deck row because they say where the reader had got to *in that deck*, and a search column is
   * a thing you open to do a job and shut when the job is done.
   *
   * **The search comes up with the disclosure and costs nothing before it** — {@link OpenPanel}
   * is where `useCardSearch` lives, and **this flag on its own is what mounts it**. Closed is
   * nothing mounted, which is the rule every dialog in this editor is built on and the one this
   * panel used to be the exception to: the hook was unconditional here, so every deck a reader
   * opened fired a `search_cards` for a wall nobody was looking at. That was defensible while
   * the rail was the rare case — it only happened when `roomy` was false — and stopped being
   * defensible the day collapsed became the resting state.
   *
   * `shown` below is the *drawn* state, this and the editor's room together, and it reaches the
   * classes, the `aria-expanded` and the row's shape and nothing else. **A press is the only
   * thing that can unmount a search; a railing hides one** — see {@link DeckSearchPanelProps.roomy}.
   */
  const [open, setOpen] = useState(false);
  const shown = open && roomy;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const categoryFieldId = useId();

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
      if (!roomy) shutUnderCard.current = true;
      return;
    }
    const shut = shutUnderCard.current;
    shutUnderCard.current = false;
    if (!had || !shut) return;
    if (document.activeElement === document.body) toggleRef.current?.focus();
  }, [selectedCardId, roomy]);

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
      aria-disabled={!roomy || undefined}
      title={roomy ? undefined : NO_ROOM}
      onClick={() => roomy && setOpen((v) => !v)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md text-xs text-dim",
        "transition-colors duration-150 motion-reduce:transition-none",
        roomy ? "hover:text-text" : "cursor-not-allowed opacity-60",
        shown ? "px-1 py-1" : "w-9 flex-col justify-start border border-border py-2",
        FOCUS,
      )}
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      {/* Down the rail when the panel is shut, so 36px of chrome still says what it is
          rather than leaving a bare icon to be guessed at. The words are the button's
          accessible name either way — `aria-label` would be a second, invisible copy of
          them, and a name that differs from the visible text is a control voice control
          cannot reach (WCAG 2.5.3). */}
      <span style={shown ? undefined : { writingMode: "vertical-rl" }}>Search cards</span>
    </button>
  );

  return (
    // A `section`, not an `aside`: the card pane is the app's one complementary landmark, and
    // a second unnamed one would answer to the same role query.
    //
    // **One root for both states**, rather than a bare rail in the collapsed one. React
    // reconciles by position, so two shapes would mean the disclosure is a *different* button
    // either side of a collapse — and the caret handed to the rail when the card pane closed
    // would be dropped again one commit later, when the returning width reopened the panel
    // around a freshly mounted copy of it. Measured in the running window; the effect above
    // reads as if it works with either shape and only works with this one.
    //
    // Which is why the open body is a **child** rather than a second root: `OpenPanel` mounts
    // and unmounts with the reader's own press — closed really is nothing mounted — while this
    // element, the row below it and the disclosure inside that row are the same three nodes
    // throughout, and a railing takes the body out of the *layout* without taking it out of the
    // tree.
    <section
      aria-label="Add cards"
      // One hairline down the left edge, and it is the only chrome the panel adds: the
      // category columns beside it are bordered boxes and these controls sit on the page, so without it
      // the "Add to" select reads as part of the deck's own header row. Everything right of
      // the line is not your deck. The rail carries its own border instead — at 36px a hairline
      // beside a bordered button would be two lines saying one thing.
      className={cn(
        "flex min-h-0 shrink-0 flex-col gap-2",
        shown ? cn("border-l border-border pl-3", PANEL_WIDTH) : "w-9",
      )}
    >
      {/* Collapsed, this row *is* the panel, so it takes the height and lets the rail stretch
          down it — a 36px strip reads as an edge, an 80px one reads as a stray button. */}
      <div
        className={cn(
          "flex gap-2",
          shown ? "shrink-0 items-center" : "min-h-0 flex-1 items-stretch",
        )}
      >
        {toggle}
        {/* The category choice sits above the results rather than on each of them: it is the
            click path's answer to "where does this go", and therefore the keyboard's — which is
            what makes drag a shortcut in Task 14 rather than the only way in. */}
        {shown && (
          <>
            <label htmlFor={categoryFieldId} className="ml-auto shrink-0 text-xs text-dim">
              Add to
            </label>
            {/* A `<select>` speaks strings and a category is addressed by number, so the id
                makes the round trip through `String`/`Number` here rather than anywhere the
                write can see it: every value in this list is one this component wrote out of a
                `DeckCategory.id`, so the parse cannot meet anything else.

                **Deliberately not alphabetical**, and one of the exceptions `src/lib/options.ts`
                names. The categories arrive in `cat.sort_order, cat.id` — the order the reader
                dragged them into in `CategoriesDialog`, and the order every deck view draws its
                columns in. Sorting them here would make this dropdown disagree with the deck
                beside it and would overwrite an order the reader chose. */}
            <select
              id={categoryFieldId}
              value={String(targetCategoryId)}
              onChange={(e) => onTargetCategoryChange(Number(e.target.value))}
              className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
            >
              {/* First and default. A pick made here *stays* picked, which is what makes
                  "everything into the Sideboard" one choice and then ten presses rather than ten
                  choices — and why this is a plain option rather than a mode that resets. */}
              <option value={String(AUTO_CATEGORY)}>{AUTO_LABEL}</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

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
          <OpenPanel
            add={add}
            categories={categories}
            targetCategoryId={targetCategoryId}
            defaultFormat={defaultFormat}
          />
        </div>
      )}
    </section>
  );
}

/**
 * The panel with its wall in it — **mounted only while the reader has the disclosure open**,
 * which is the whole reason it is a component rather than a branch inside
 * {@link DeckSearchPanel}.
 *
 * A hook cannot be called conditionally, so `useCardSearch` sitting in the root meant its query
 * ran for every deck the reader opened whether or not they had asked for a wall. Closed is
 * nothing mounted here for the same reason it is in `DeckDialog`: the search, its filter state,
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
 * it. The "Add to" select is drawn up there too and is **not** an example of that — it sits
 * inside the row's own `shown` gate and goes with everything else. What actually outlives a
 * collapse is the *choice* it draws, `targetCategoryId`, and it outlives it because the
 * **editor** owns it (`DeckEditor.tsx`) rather than because of where the control is rendered.
 */
function OpenPanel({
  add,
  categories,
  targetCategoryId,
  defaultFormat,
}: Pick<DeckSearchPanelProps, "add" | "categories" | "targetCategoryId" | "defaultFormat">) {
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
  const search = useCardSearch({ defaultFormat });
  const { query, rows, searchKey } = search;

  // Read here rather than handed down: the root's own `selectedCardId` is for the caret effect,
  // and this is the wall's selection. One field, two subscriptions, no round trip either side.
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const selectCard = useAppStore((s) => s.setSelectedCardId);

  /**
   * What the picked id is *called*, for the two names every Add button carries — or `null` under
   * {@link AUTO_CATEGORY}, where the pile is not chosen here at all and is named per card below.
   *
   * The editor clamps `targetCategoryId` to a category it is drawing, so the miss below is not
   * a state this panel expects — but it is one a single render can be caught in, because a
   * category that has just been deleted or renamed reaches the clamp and the select above on the
   * same commit and nothing orders those two. "this deck" is the honest thing to say about an
   * id whose name is not in hand: the deck is what the press writes to, and if the id really is
   * stale `deck_add_card` refuses it in words (`category_of_deck`) into the alert above the
   * wall. Reading `.name` off `undefined` would instead take the whole panel down over a label.
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
          minTileWidth={TILE_FLOOR}
          selectedId={selectedCardId}
          onSelect={selectCard}
          tileRef={tileRef}
          // The crown in a tile's top-right chip: the same fact the search view's wall marks,
          // marked the same way here — see `tileGameChanger`.
          gameChanger={tileGameChanger}
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
                title={`Add to ${landsIn}`}
                // Never disabled while a write is in flight, and that is the behaviour rather
                // than an omission: `deck_add_card` **folds into** the row it finds, so pressing
                // three times is three copies. Disabling would drop presses two and three, and
                // "press it again for another one" is how a deck gets built.
                //
                // Under `Auto` this sends **no category and the card's type line**, which is what
                // puts the rule on `useDeck`'s single definition rather than here: this component
                // computes the *word on the button* and the hook computes the word it sends, from
                // the same function over the same fact.
                onClick={() =>
                  add.mutate(
                    auto
                      ? { cardId: card.id, typeLine: card.typeLine, quantity: 1 }
                      : { cardId: card.id, categoryId: targetCategoryId, quantity: 1 },
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
      {/* No `prefetchImages` effect, deliberately — the search view's warms a page of 50
          because a 1 200px wall shows forty tiles at once, and the reader is a scroll away from
          the rest. Two tiles per row is not that wall: `CardGrid`'s overscan already mounts the
          next two rows of `<img>`s, which is four images ahead of the reader by the same
          protocol and no round trip of its own. */}
    </>
  );
}
