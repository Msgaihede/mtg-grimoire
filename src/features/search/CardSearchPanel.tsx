import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronLeft } from "lucide-react";
import { motion } from "motion/react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { TRANSITION } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Why the disclosure will not open, said where it is refused. */
const NO_ROOM = "Not enough room — close the card details or widen the window";

/**
 * Which of the three lists this column files into — the `data-search-over` value, and the word a
 * probe asks about.
 *
 * A sibling of `useSearchOpen`'s `SearchSection` and deliberately two names for one vocabulary:
 * that one is the key a preference is stored under, this one is what is stamped on the DOM. They
 * are equal today and they answer to different things, so neither is derived from the other.
 */
export type SearchSurface = "deck" | "collection" | "wishlist";

/**
 * Stamped on this panel while it is drawn **over** the list rather than docked beside it — the
 * phone case, where the desk cannot hold {@link MIN_PANEL_WIDTH_PX} and the list's floor at once.
 *
 * **It was a sibling of `DeckEditor`'s `PANE_OVER_ATTR`, and that attribute is gone** — deleted
 * with the docked card pane on 2026-09-03, when the card became a centred modal that covers no
 * column. While both existed the rule was that a second element answering `[data-pane-over]`
 * would make the editor's own probes ambiguous, and that is still why this attribute is not
 * tripled per surface: one name, three values, because the three panels live on three routes and
 * can never be on screen together. What is reused is the argument, word for word: the difference
 * between the two placements is a `position` and a
 * width, both of which jsdom reads as nothing, so the *choice* is stamped where a suite and a
 * CDP pass can both ask about it and the geometry stays a live-window question.
 *
 * **One attribute for three panels rather than three attributes**, which is the 2026-09-07
 * decision and the same reasoning read once more: the three surfaces live on three routes and can
 * never be on screen together, and the attribute's own *value* ({@link SearchSurface}) already
 * discriminates. `"deck"` keeps every meaning it had.
 */
export const SEARCH_OVER_ATTR = "data-search-over";

/**
 * How wide the panel is **when it is first opened**, in px — the reader may then drag its edge
 * (see {@link ResizeHandle}), and this is where every surface starts.
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
 * is a share of it ({@link CardSearchPanelProps.maxWidth}). A page opened on a 2560px monitor
 * would otherwise start with a 768px search column nobody asked for; 384 is a column, and what
 * a wider window buys is room to drag rather than a wider default.
 */
export const DEFAULT_PANEL_WIDTH_PX = 384;

/**
 * The narrowest the panel may be dragged, in px — **and the width a page decides "there is no
 * room for this at all" by**, which is the whole reason it is a measurement rather than a round
 * number.
 *
 * One card, and the chrome around it: a 150px tile ({@link TILE_BASE}), the panel's own left
 * border and padding (1 + 12), the wall's border and padding (2 + 24) and the wall's scrollbar
 * (15, measured — not the 17 an older note here guessed) — **204**, taken as **206** for two
 * pixels of slack. Driven in the shipped window on 2026-08-14, a panel held at this width
 * measured **152px** of wall inside it: one 150px tile with a pixel either side of it. Below it
 * the wall cannot draw a whole card at the size this column is scoped for, and a search column
 * with no card in it is a filter row taking width off the list.
 *
 * That is what the rail is for. Each page compares this against what its row can spare, so a
 * window too narrow for one card collapses the panel to its rail rather than squeezing it —
 * and the width the reader had dragged to is still here when the room comes back, because this
 * component stays mounted through a railing.
 */
export const MIN_PANEL_WIDTH_PX = 206;

/** How far one arrow press moves the edge. A pointer drags continuously; a caret needs a step
 *  big enough to be worth pressing and small enough to aim with. */
const RESIZE_STEP_PX = 24;

export interface CardSearchPanelProps {
  /**
   * Which list this column files into — the {@link SEARCH_OVER_ATTR} value, and nothing else.
   *
   * It reaches no behaviour on purpose: every difference between the three surfaces is a string
   * or a slot below, so this is the one place a probe can ask *which* panel it found without the
   * component branching on the answer.
   */
  surface: SearchSurface;
  /** The column's name, centred over the title row and turned on its side down the rail. */
  title: string;
  /** The `<section>`'s accessible name — `Add cards` on the deck, and a sentence naming the list
   *  on the other two, because two panels' probes must not answer to one name. */
  sectionLabel: string;
  /**
   * The stem of the disclosure's two names and of the splitter's one: `Collapse <stem>`,
   * `Expand <stem>`, `Resize <stem>`.
   *
   * A stem rather than three strings, because the three names are one fact said three ways and a
   * caller given three fields is a caller who can make them disagree. It is the *thing* being
   * collapsed — `card search` — never a verb.
   */
  toggleLabel: string;
  /**
   * What the **reader** last chose, and the only thing that mounts the body.
   *
   * Hoisted rather than held here, because each surface remembers its own answer and a component
   * that read one hook could only ever be one of them. See `useSearchOpen`.
   *
   * **The press is what is stored, never the drawn state** — a railing is a measurement about a
   * narrow window and not a thing the reader asked for, so it must not reach whatever is behind
   * this pair. That is why {@link roomy} is a separate prop rather than folded in here.
   */
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Whether the page has room to draw this open — measured, not guessed.
   *
   * `false` renders the rail whatever the reader last chose, and the disclosure goes with it:
   * a control that cannot do the thing it names is worse than one that says why it cannot.
   *
   * **It decides what is _drawn_ and never what is _mounted_**, and the two are kept apart
   * because they answer to different things: this prop moves on a **width** change nobody
   * asked for, while {@link open} moves only on a press. So a panel the reader had opened is
   * *hidden* when the room goes rather than torn down, and the typed query, the filter row,
   * the facets and the pages already fetched are all still there when the room comes back.
   * Gating the mount on this as well threw every one of those away on a *resize*.
   *
   * **It is no longer the whole of whether the panel may be drawn** — see {@link overWidth}.
   * `roomy` answers one question, *is there room to draw this **beside** the list*, and below
   * that width there is now a second answer rather than a refusal.
   */
  roomy?: boolean;
  /**
   * How wide to draw this panel **over** the list, in px — the row's own width — for a row too
   * narrow to hold the list and this column side by side. Absent is a row that can.
   *
   * **This is the door out of the rail, and until 2026-08-29 there was none.** `roomy` is the
   * list's floor plus {@link MIN_PANEL_WIDTH_PX} plus the row's gap, so on a 390px phone the panel
   * railed *and the disclosure refused*: `aria-disabled`, a sentence about widening a window that
   * cannot be widened, and no way to reach a card search at all. The refusal was right about the
   * arithmetic it was doing and wrong about the question: there is no room for the two of them
   * **beside each other**, which is not the same as no room for the search.
   *
   * **The placement is issue #183's, reused rather than invented.** The card pane already drew
   * over one of the desk's two columns instead of taking width from either, on the argument that
   * opening a surface must not change the flow of what is behind it; this is that arrangement for
   * the one width at which the list and the panel cannot both be on screen. So the panel is
   * absolutely positioned over the row and the rail keeps its 36px place in the flow — the list
   * behind is laid out at exactly the width it had before the press.
   *
   * **What it costs is the drag, and that was chosen knowingly**: while the overlay covers the
   * list there is no folder to drag a tile onto, so adding a card from the search is a tap on its
   * Add button.
   *
   * A number and not a boolean because the width is the page's measurement and this panel is
   * inside a 36px dock: `right-0` gives the row's right edge for free and the width is the one
   * thing CSS in here cannot derive. `undefined` — which is also the first paint, before the
   * observer has answered — is the docked arrangement, which is what every test that says nothing
   * about width gets.
   */
  overWidth?: number;
  /**
   * The widest this panel may be drawn or dragged, in px — the page's answer, because the page is
   * what holds the two measurements it is made of.
   *
   * `min(half the window, what the row can spare over the list's floor)`. Two bounds because they
   * bind at different sizes and each is wrong on its own: at 1280 a crowded row is ~602px, so half
   * the window (640) is wider than the whole row and only the list's floor says anything useful;
   * at 1920 the row can spare ~1462 and only the half-window cap stops the search column becoming
   * the page.
   *
   * **A cap on the drawn width, not a correction to the reader's.** The width they dragged to is
   * held un-clamped, so a window narrowed and widened again gives it back rather than leaving
   * the panel at whatever the narrow moment allowed.
   *
   * Absent — and `Infinity` — mean *unmeasured*, which is the first paint's honest answer and
   * reads as no cap; a page's observer answers on the same frame. A story rendering this panel on
   * its own passes nothing and gets the width it asks for.
   */
  maxWidth?: number;
  /**
   * A strip drawn under the title row and above the body — the deck panel's `Collection` /
   * `All cards` pair, and nothing on the other two surfaces.
   *
   * **Above the body rather than inside it**, which is what makes it the panel's own chrome
   * rather than one tab's: it does not move when the tabs switch, and it survives the railing
   * that merely *hides* the body below — so a width change cannot take the reader's tab away any
   * more than it takes their query.
   *
   * Gated on the drawn state alone: {@link open} is what decides whether there is a search at
   * all, and a tab bar over nothing would be two words offering to switch between two things that
   * are not mounted. Collapsed, this column is a 36px rail and draws neither.
   */
  tabs?: ReactNode;
  /**
   * The wall and its furniture — `CardSearchBody`, or whatever a surface draws in its place.
   *
   * **Mounted on {@link open}, hidden on `!roomy`**, and the two are not the same gate. The press
   * is a choice and the room is a measurement, so a width change must not be able to throw the
   * reader's search away — which is exactly what one folded gate did.
   */
  children: ReactNode;
}

/**
 * The docked, collapsible card-search column — **the chrome, with a hole in the middle of it.**
 *
 * Not a search: this draws a `<section>`, a disclosure, a heading, a splitter and the three
 * states they are arranged in, and mounts whatever the caller hands it as {@link
 * CardSearchPanelProps.children}. `CardSearchBody` is what all three surfaces put in that hole
 * today.
 *
 * **It was `DeckSearchPanel`'s own root until 2026-09-07**, and the extraction is the reason this
 * file exists rather than a third copy of it: `DeckSearchPanel.tsx` was 1595 lines and roughly two
 * thirds of them had nothing to do with decks. Copying that twice would be the mistake this repo
 * has already made and undone twice — `CollectionSearchTab`'s own filter row and the deck Grid
 * view's inline card frame, both deleted because *a resemblance is N independent decisions that
 * happen to agree today*. Every rule below was decided for the deck's column and is unchanged;
 * what is parameterised is four strings and a `surface`.
 *
 * A **fixture of the page, not a dismissible layer**: this panel registers no rung of its own, so
 * Escape pressed in here falls past it. The way to put it away — and the way to get it out — is
 * the disclosure it names itself by.
 *
 * It is a docked column rather than a dialog because it is **worked out of**: its tiles are drag
 * sources into the wall beside them, and a scrim would end that drag path. `src/CLAUDE.md`
 * carries that rule; everything the reader merely *consults* is a `Dialog`.
 */
export function CardSearchPanel({
  surface,
  title,
  sectionLabel,
  toggleLabel,
  open,
  setOpen,
  roomy = true,
  overWidth,
  maxWidth = Number.POSITIVE_INFINITY,
  tabs,
  children,
}: CardSearchPanelProps): ReactElement {
  const tip = useTooltip();
  /**
   * Whether this panel is drawn over the list rather than beside it — see
   * {@link CardSearchPanelProps.overWidth}.
   *
   * `> 0` rather than a presence test, because a page's own measurement is `0` until its observer
   * has answered and a zero-width overlay is a panel drawn as nothing at all.
   */
  const over = overWidth !== undefined && overWidth > 0;
  /**
   * Whether a press could do anything — **the question the disclosure is actually asking**, and
   * the one it got wrong for as long as `roomy` was the whole of it.
   *
   * Two placements answer it now: docked beside the list where the row can hold both, drawn over
   * the list where it cannot. Only a row that can do neither refuses, and it still says so in
   * words.
   */
  const drawable = roomy || over;
  const shown = open && drawable;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  /**
   * How wide the reader has dragged this column, in px — **only ever written by the reader**,
   * and clamped again where it is drawn.
   *
   * That split is the whole of "reopens at the last valid width". A narrowing window, a floor that
   * will not give any more — each of those caps what can be *drawn* without being a thing the
   * reader asked for, so none of them may overwrite what they did ask for. Let the environment
   * write here instead and a momentary squeeze is permanent: widen the window back and the panel
   * stays where the narrow moment left it. A *drag* does write clamped, because there the bound is
   * the edge the reader is pushing against rather than something that happened to the window while
   * they were not looking.
   *
   * `useState` and deliberately not remembered. A width is an answer about *this page's* row: how
   * much room the list beside it needs is a fact about what is in the list, and a column dragged
   * wide for a 17-pile Commander deck is the wrong column for a 60-card Standard one. Whether the
   * reader works with a search column at all is not like that, which is why exactly one of the two
   * is stored. It **does** survive a collapse and a railing, because it lives in this root rather
   * than in the body: the disclosure and the reader's width outlast the search they were pointed
   * at, so reopening gives back the column they had rather than the one the app ships.
   */
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH_PX);

  // What is actually drawn: the reader's width inside the page's cap, and never below the one
  // card `MIN_PANEL_WIDTH_PX` is measured from. The `max` around the cap matters at exactly one
  // moment — a row too narrow for the minimum, where `roomy` is already false and this element
  // is 36px of rail whose width nothing reads.
  const drawnWidth = Math.min(
    Math.max(width, MIN_PANEL_WIDTH_PX),
    Math.max(maxWidth, MIN_PANEL_WIDTH_PX),
  );

  // The drag's own clamp, which is the drawn one plus the fact that a drag cannot ask for a
  // width the page has already refused.
  const resize = useCallback(
    (next: number) =>
      setWidth(
        Math.min(Math.max(next, MIN_PANEL_WIDTH_PX), Math.max(maxWidth, MIN_PANEL_WIDTH_PX)),
      ),
    [maxWidth],
  );

  const selectedCardId = useAppStore((s) => s.selectedCardId);

  /**
   * The caret, when the open card closes and what opened it is not there any more.
   *
   * This panel is what took it away. **The case this was written for was the deck's docked pane**:
   * at 1024 a tile press opened the pane, the pane's arrival squeezed the row, the row squeezed
   * this panel down to its rail — and the tile that was pressed went `display: none` with it,
   * which is as good as gone to the caret, because focus cannot land on a box that is not
   * rendered. The card is a centred modal since 2026-09-03 and takes width from neither column, so
   * that road is closed; what still reaches this is the overlay case, where a page takes the
   * panel's overlay away because there is room for one surface. Either way the card surface hands
   * the caret back to whatever opened it and checks `isConnected` before it does; a hidden tile is
   * still connected, so the hand-back is attempted and does nothing, and the caret ends on
   * `<body>` with the next Tab restarting from the top of the app. The disclosure is the honest
   * place for it: it is where the reader's search went, and it is a Tab away from the search box
   * and the results either way.
   *
   * Read off a *remembered* collapse rather than off `drawable` at the moment the card closes,
   * because by then it is usually true again — closing the card is what gives the overlay back, so
   * the panel is already reopening on the same commit. What matters is that this panel shut while
   * the card was open, which is the thing that unmounted the opener.
   *
   * And only when nothing else took the caret: an opener still on screen has already been handed
   * it, and stealing it from there would be worse than the bug.
   */
  const hadCard = useRef(selectedCardId !== null);
  const shutUnderCard = useRef(false);
  useEffect(() => {
    const had = hadCard.current;
    hadCard.current = selectedCardId !== null;
    if (selectedCardId !== null) {
      // **`drawable` rather than `roomy`, since the overlay** — the phone case reaches this by
      // the same road one width down: at 390 the panel is *already* drawn over the list, and the
      // page takes the overlay away when a card opens (there is room for one surface, and the
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
   * enough width for the list and the panel both, so the press would be recorded and nothing
   * would move. The sentence says what to do about it, which is the app's rule for anything
   * that refuses.
   *
   * `aria-disabled` and a press that does nothing, **not** `disabled`: a disabled button is out
   * of the tab order, which would leave the reason hanging on a hover a keyboard reader cannot
   * perform — a rail that cannot be activated and never says why. This way the control is
   * reachable, the tooltip is its description, and it is also somewhere the caret can be put
   * (see the effect above).
   */
  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={shown}
      // **`drawable`, not `roomy`** — the refusal used to fire for every row under 414, which is
      // every phone, and there is nothing wrong with a search column at 390 except where it was
      // being asked to go. What still refuses is a row that can hold the panel neither beside the
      // list nor over it — and the sentence below names exactly that remedy first.
      aria-disabled={!drawable || undefined}
      // **An `aria-label`, which the words on the button used to be** (2026-08-25). This was an
      // icon *and* the text of the title, so the visible words were the accessible name and a
      // label differing from them would have been a control voice control cannot reach (WCAG
      // 2.5.3). The words are a heading beside it now and this button draws nothing but a
      // chevron, so there is no visible text for a name to have to contain — and a name of its
      // own is owed, because "chevron" is not what pressing it does.
      //
      // It names the **result** rather than the state, which is the same rule the direction
      // arrow on the filter bar follows: `aria-expanded` already says which way round it is, and
      // a reader who has just heard "collapsed" wants to know what the press will do about it.
      aria-label={shown ? `Collapse ${toggleLabel}` : `Expand ${toggleLabel}`}
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

  /** Drawn open, over the list rather than beside it — see {@link CardSearchPanelProps.overWidth}. */
  const overlaid = shown && over;

  return (
    <>
      {/* **The rail's 36px, kept in the flow while the panel is drawn over the list.**
          Positioning the panel absolutely takes it out of this dock, which would otherwise
          collapse to nothing and hand the list behind it 52px it does not get to keep — a
          re-measure of the whole wall on the way in and another on the way out, twice per
          press, for a layout the reader cannot see. This holds the row still instead, which is
          the half of issue #183's arrangement that is about the *list* rather than about the
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
          reads as if it works with either shape and only works with this one. **Three states** —
          railed, docked, drawn over the list — and it is still one element: what the third
          changes is a `position`, a background and where the width comes from.

          Which is why the open body is a **child** rather than a second root: it mounts and
          unmounts with the reader's own press — closed really is nothing mounted — while this
          element, the row below it and the disclosure inside that row are the same three nodes
          throughout, and a railing takes the body out of the *layout* without taking it out of the
          tree. */}
      <section
        id={bodyId}
        aria-label={sectionLabel}
        {...(overlaid ? { [SEARCH_OVER_ATTR]: surface } : {})}
        // One hairline down the left edge, and it is the only chrome the panel adds: what sits
        // beside it is the page's own list, and without the line these controls read as part of
        // that list's header row. Everything right of the line is not your list. **Railed too,
        // since 2026-08-26** — that sentence is as true of 36px of rail as of the drawn panel, and
        // it used to be said by a border on the disclosure instead, which drew the button as a box
        // rather than the column as a column. The rail and the panel are one edge now, so a
        // collapse changes what is in this column and not what it is. The `w-9` is unchanged and
        // stays 36px: `box-sizing` is `border-box`, so the hairline comes out of the rail rather
        // than out of the row beside it.
        // **No hairline in the overlay**, which is the one state it says nothing in: the panel is
        // the whole row there, so a line down its left edge is a line down the window.
        // `relative` for the resize handle, which is drawn *over* the hairline rather than in the
        // column: a grab strip that took a place in this flex column would be a strip the length
        // of one row rather than the length of the edge.
        //
        // **Over the list it is `absolute` and opaque.** The dock it sits in is `sticky` and
        // therefore already the containing block, so `inset-y-0` is the height the dock hook
        // measured — the same two ends the docked panel is drawn between — and `right-0` is the
        // row's own right edge; only the width has to be told. `bg-bg` because it is covering the
        // list rather than sitting beside it, and no z-index: a `sticky` ancestor is always a
        // stacking context, so a number here could never out-rank the list's own raised rungs —
        // the dock is where that has to be said, and each page says it.
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
            label={toggleLabel}
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

            **No `flex-wrap`, and nothing here can overhang without it.** That class was
            load-bearing while this row held three controls — the disclosure at 99px, a tab strip
            at 141 and an own/need pair at 175, none of which shared a line inside the panel's
            **193px** content box at its floor, so unwrapped they became a horizontal scrollbar
            across the whole page (`src/CLAUDE.md`, and `ManaValueChips` shipped that bug once
            already). The strip is a line of its own and the pair is deleted; what is left is a
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
              centre line, which is where `justify-center` has already put the chevron.
              `text-center` is left off that arm rather than kept as decoration — a class that
              cannot act in the writing mode it is written for is the thing somebody later "fixes"
              the real bug by adjusting. */}
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium text-text",
              shown ? "flex-1 text-center" : "select-none self-center",
            )}
            style={shown ? undefined : { writingMode: "vertical-rl" }}
          >
            {title}
          </span>
          {/* The chevron's own width given back on the other side, so the title's centre is the
              panel's centre. `aria-hidden` and no text: it is a shim, not a control. */}
          {shown && <span aria-hidden="true" className="size-7 shrink-0" />}
        </div>

        {shown && tabs}

        {/* Everything below the row, and only once the reader has asked for it. One gate where
            there were five, which is what makes the search a thing the reader asks for rather than
            a thing every page pays for.

            **Mounted on `open`, hidden on `!roomy`.** The press is a choice and the room is a
            measurement, so a width change must not be able to throw the reader's search away —
            which is exactly what `{shown && …}` here did.

            `display: contents` is what makes the wrapper free: it generates no box at all, so the
            body's children stay flex items of this column and the `gap-2`, the `min-h-0` and the
            wall's `flex-1` distribute exactly as they did with no wrapper there. Hiding is
            `display: none` and deliberately not an `opacity` or a `visibility`: those two leave
            the wall holding its space in the layout and its tiles in the tab order, which is the
            whole of what the rail exists to give back. The `hidden` **attribute** beside the class
            says the same thing to the accessibility tree — and to the suite, which loads no
            stylesheet, so under jsdom the class alone would hide nothing from a role query. */}
        {open && (
          <div className={shown ? "contents" : "hidden"} hidden={!shown}>
            {children}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * The panel's left edge, as something to pull on.
 *
 * A `separator` with a `tabIndex` and a value, which is the ARIA window-splitter pattern: the
 * pointer path and the keyboard path are one control rather than a drag with a settings dialog
 * beside it for anyone who cannot perform one. `aria-valuenow` is the width in px — the unit the
 * reader is actually choosing, and the one the page's cap is expressed in — so a screen reader
 * announcing "206" is announcing the same number the panel is drawn at.
 *
 * **Absolutely positioned over the hairline, not a flex item beside it.** This column is a
 * `flex-col`, so a child of it would be one row's worth of grab strip at the top of a
 * several-hundred-pixel edge. It straddles the border instead — 9px wide, 4px of it out in the
 * row's own 16px gap and the rest over the panel's padding — which is Fitts' law rather than
 * taste: a 1px hairline is not a target, and every pixel of the strip that is *outside* the panel
 * is a pixel the reader can overshoot into without hitting the list.
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
  label,
  width,
  max,
  onResize,
}: {
  controls: string;
  label: string;
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
      aria-label={`Resize ${label}`}
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
        // growing into the row.
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
        // The arrows scroll the page otherwise, and Home and End take it to its ends.
        e.preventDefault();
        onResize(next);
      }}
      // `touch-none` so a drag on a touch screen is a drag rather than the browser deciding
      // partway through that it was a scroll and cancelling the pointer.
      className={cn(
        // No z-index, and none is owed: the strip lives in the panel's own left padding and the
        // row's gap, where nothing else in this column paints. `LAYER` is the only place a
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
