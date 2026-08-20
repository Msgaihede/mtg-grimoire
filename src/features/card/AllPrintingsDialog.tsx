/**
 * Every paper printing of one card, as a wall of art the reader can narrow — and, from a deck
 * row, choose from.
 *
 * ## Why it is a modal and not a place
 *
 * `View all printings` used to have **two** destinations, chosen by whether the surface it was
 * pressed from was inside the deck editor. Outside it, the row navigated: one `set` wrote
 * `activeView: "search"`, `selectedCardId: null`, `paneDeckContext: null`, `openDeckId: null` and
 * `returnToDeckId: null`, so a reader on the Collection who asked *which printings does this
 * card have* was moved to the Search page with their card closed and their filtered collection
 * lost. Inside it, the row opened the 384px card detail pane — the right content at the wrong
 * width, since the editor's desk row measures 602px at the app's own 1280×800 with the pane
 * docked, so the list was subtracted from the deck whether or not anyone was reading it.
 *
 * `src/CLAUDE.md` already states the rule both broke: *a surface opened from a view is a centred
 * modal over a scrim, not a docked column — unless the reader works out of it while editing
 * beside it.* Printings are **consulted**, exactly like deck history, categories and settings,
 * all three of which are {@link Dialog}s. So this is one too, and the store field behind it
 * writes one thing and moves nothing.
 *
 * ## The shape
 *
 * Two components, and the split is the shell's rule rather than tidiness. {@link Dialog}
 * renders `children` **only while open**, so everything that costs something — the query, the
 * filter, the sort observer, the scroll position — lives in {@link Body} and therefore exists
 * only while the modal does. A closed modal costs a handful of store reads and nothing else, and
 * every open starts clean with no effect anywhere resetting anything.
 *
 * **A *step* starts just as clean, and `key` is the whole of how**: the body is keyed on the card
 * the request names, so walking to the next card mounts a new one exactly as an open does. That is
 * the same guarantee spent twice rather than a second mechanism — see the `key` at its own site.
 *
 * ## What a press means
 *
 * Two answers, decided by whether the surface that opened this named a deck slot
 * (`printingsRequest.deck`):
 *
 * * **From a deck row** — the press *is* the swap, through the same `useSwapFromPane` the card
 *   pane presses, and the modal closes on success. Click-commits rather than select-then-confirm
 *   for `PrintingRow`'s reason: the tile is the thing the reader is pointing at. The cost the
 *   pane pays for that gesture — no way to look at a printing without committing to it — is not
 *   paid here, because the whole wall is art and looking is what a wall is for. A mis-press is
 *   covered by the deck's undo.
 * * **From anywhere else** — the press opens the card detail pane on that printing and closes
 *   the modal, which is the "go and look at this one" the reader who is not building a deck
 *   asked for.
 *
 * ## Stepping along the list
 *
 * The modal is a **window onto the list the reader is standing in rather than onto one card**:
 * the chevrons and the arrow keys move it to the previous and next card in that list's own drawn
 * order, which is `store.cardWalk` — the open deck's cards as the desk is drawing them, or the
 * search results, or the collection, or the wishlist. It is published by whichever surface is
 * drawing the list, because the order depends on that surface's grouping, sorting and filter and
 * this component is mounted at `App` level with no way to ask. A reader checking which printing
 * of each card they have sleeved up walks the whole list without closing anything.
 *
 * **Everything hangs off one index**: where `printingsRequest` sits on that walk. Finding it is
 * the one place the two kinds of stop are told apart — a deck row by `sameDeckSlot`, because a
 * deck can hold one printing in two piles and all five parts of `DECK_CARD_GRAIN` are what tell
 * those rows apart, and everything else by `cardId`, because a plain list has no address finer
 * than the cardboard and `listWalkStops` has already made that unique. It is `-1` from a card
 * pane opened on something the list does not contain, from the deck editor's docked search panel
 * (which publishes nothing, so the desk's own walk stands), and from a deck that is not the one
 * the walk belongs to — and in every one of those there is no walk to step along, so there are no
 * chevrons and the arrow keys are not ours.
 *
 * **A step moves the selection behind the scrim, and that is the feature rather than a
 * courtesy** — see `step`. Closing the modal after walking six cards must leave the reader on the
 * sixth, with the wall's ring, the card pane and this modal all naming one card.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { sameDeckSlot } from "@/features/decks/deckWalk";
import { Dialog, type DialogFlanks } from "@/components/Dialog";
import { useSwapFromPane } from "@/features/decks/useDeck";
import { CardGrid } from "@/features/search/CardGrid";
import { keepCaretForCard } from "@/lib/caretWalk";
import { plural } from "@/lib/counts";
import { soleFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type Printing } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useAppStore, type CardWalkStop, type PrintingsRequest } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { buildCardMenu, type CardMenuDeps } from "./cardMenu";
import { CardMenuRefusal } from "./CardMenuRefusal";
import {
  EMPTY_PRINTING_FILTER,
  filterPrintings,
  isFilterActive,
  langOptions,
  setOptions,
  treatmentOptions,
  type PrintingFilter,
} from "./printingFilters";
import { buildPrintingGroups, cheapestPrice, printingTarget } from "./printings";
import { PrintingsFilterBar } from "./PrintingsFilterBar";
import { useCardMenuDeps } from "./useCardMenuDeps";
import { usePrintingGroupBy } from "./usePrintingGroupBy";

/**
 * The page size this modal asks for — the backend's own `MAX_PRINTINGS_HARD`.
 *
 * **Named here because this surface filters, and a filter over a truncated list lies.** The card
 * pane takes the default page (400) and can live with it, because it says so in its caption and
 * offers no filter; narrowing *this* wall to a set that fell outside the newest 400 would draw an
 * empty wall that reads as an answer rather than as a truncation.
 *
 * 1000 is not a number picked for the feel of it: counting paper only, exactly five oracle cards
 * exceed 400, and they are the five basic lands — Forest 862, Mountain 840, Swamp 832, Island
 * 827, Plains 818. So this clears the largest list in the corpus with headroom, and Rust clamps
 * anything sent to it anyway. It is also in the query key below, which is the point of spelling
 * it: the pane's read and this one are two different questions and get two cache entries, so the
 * modal cannot evict the pane.
 */
const PRINTINGS_PAGE = 1000;

/**
 * The wall's "fetch more" slot, wired to nothing.
 *
 * One request is the whole list — see {@link PRINTINGS_PAGE} — so there is no next page to ask
 * for. Module scope rather than an inline arrow because `CardGrid` runs it from an effect keyed
 * on the last rendered row, and a fresh identity per render is an effect that re-runs on every
 * scrolled row.
 */
const NO_NEXT_PAGE = () => {};

/**
 * One printing, dressed as something the wall can draw.
 *
 * `CardGrid` is generic over `GridCard` — `id`, `name`, `setCode`, `collectorNumber`, `rarity` —
 * and a {@link Printing} carries every one of those but the **name**, because a name is a fact
 * about the *card* and not about the piece of cardboard. See {@link printingRows} for what is
 * put there and why it is not simply the card's name.
 */
type PrintingRow = Printing & { name: string };

/**
 * The name each tile is drawn and announced under: the card, and which printing of it this is.
 *
 * **Not the bare card name, and this is the one place this file departs from "the adapter is one
 * line".** Every row of this wall is the same oracle card, so a bare name would make 862 buttons
 * called `Forest` — the exact defect `CardGrid`'s own notes keep circling (a wall of forty
 * buttons a screen reader cannot tell apart), and the reason `FoilOverlay` is `aria-hidden` and
 * the owned badge is a *sibling* of the tile's button rather than a child of it. The set and the
 * collector number are what differ, they are already printed in the caption under the tile, and
 * `AddToCollectionButton` already spells the same parenthetical (`Add Lightning Bolt (LEA 161)`)
 * for the same disambiguation.
 *
 * It is only the `alt`/accessible name and the no-picture fallback. The **menu** target is built
 * from the plain name (see `cardFacts` in {@link Body}), so "Copy card name" copies `Forest`.
 */
function printingRows(printings: readonly Printing[], name: string): PrintingRow[] {
  return printings.map((printing) => ({
    ...printing,
    name: `${name} (${printing.setCode.toUpperCase()} ${printing.collectorNumber})`,
  }));
}

/**
 * The finish a tile's printing **is** — the holo sheen and the corner chip `CardArt` draws.
 *
 * `soleFinish` rather than "does it list foil": the mark describes the cardboard, so a printing
 * sold in both finishes is not a foil card and marking it as one would be a claim. Module scope
 * because `CardGrid`'s prop asks for a stable identity — a fresh arrow per render re-registers
 * every tile on every scrolled row.
 */
const tileFinish = (row: PrintingRow) => soleFinish(row.finishes);

/**
 * The top-left corner: this printing's language, **only when it is not English**.
 *
 * A wall where every tile says `EN` says nothing, and the corner is one of only three a tile has.
 * On a heavily reprinted card the non-English rows are most of what is crowding the wall, which
 * is the same argument that puts a language picker in the filter bar.
 *
 * 10px scaled by the card's own `--mark-scale`, matching the search wall's printing count in the
 * same corner: a fixed size climbs out of the printed nameplate by 2×.
 */
const tileLanguage = (row: PrintingRow) =>
  row.lang === "en" ? null : (
    <span
      className={cn(
        "block whitespace-nowrap font-mono uppercase text-text",
        "text-[calc(10px*var(--mark-scale,1))] leading-none",
      )}
    >
      {row.lang}
    </span>
  );

/**
 * What a keypress inside this dialog belongs to before it belongs to the walk.
 *
 * `PrintingsFilterBar` is a row of `<select>`s and a search box, and **ArrowLeft on a focused
 * `<select>` changes its value** in Chromium and in WebView2 with it — so a reader narrowing the
 * wall by set would step to the next card instead, or step *and* re-sort, depending on the engine.
 * `<input>`, `<textarea>` and a `contenteditable` are here for the same reason one rung along: the
 * arrows move a caret, and a caret's owner has the better claim.
 *
 * **A third predicate rather than a widening of one of the two that exist**, which is
 * `src/CLAUDE.md`'s standing rule about `isTextField` and `isTextEntry`: those answer *does the
 * browser's own context menu survive here* and *does an open menu panel yield its keys to a
 * caret*, and this answers *does this control own the arrow keys*. `<select>` is the one element
 * where the three genuinely disagree, and it is the one this exists for.
 *
 * `closest` rather than a tag test, because the press lands on whatever is under the caret and a
 * `contenteditable` region is a tree.
 */
const ARROW_OWNERS = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_OWNERS) !== null;
}

/**
 * One step control, drawn in the room {@link Dialog}'s `flanks` reserved beside the panel.
 *
 * **`disabled` and not `aria-disabled`, which is the reverse of this app's usual rule** and is
 * `QuantityStepper`'s exception rather than a new one: that rule is for a control that greys as
 * the reader types, where leaving the tab order under their hands is what makes it wrong. A
 * chevron at the end of the walk has nothing left to do at all — there is no next card, and no
 * keystroke made in this dialog can produce one — so holding a tab stop buys the caret a place to
 * stop and no action to take there. It is also the state `trapTab` already reads: it filters
 * `disabled` out of the cycle, so the end of a walk costs Tab one stop rather than swallowing a
 * wrap.
 *
 * **Both chevrons are drawn whenever either is**, one of them greyed, rather than the ends of the
 * walk dropping their control. The pair is positioned against the panel's edges, so a chevron that
 * came and went would move nothing on screen — but the *first* step of a walk would then be the
 * moment a second control appeared under the reader's pointer, which is exactly where they are
 * pointing.
 *
 * The name says what the press does, **which list it does it in, and what it will land on**,
 * because a chevron says none of the three: `Next card in the deck, Lightning Bolt`. The list is
 * the walk's own `label` rather than a constant here, which is the whole of what that field is
 * for — this same control is drawn over the collection and the wishlist, and "in the deck" there
 * would be the one part of the feature that lies. It is the `title` as well — a glyph is silent
 * to a pointer too — and the app's own `Move <name>, <n> of <total>` shape, where the comma is
 * what keeps a card's name out of the verb.
 */
function StepChevron({
  direction,
  listLabel,
  stop,
  onStep,
}: {
  direction: "previous" | "next";
  /** What to call the list being walked, as a noun phrase — `the deck`, `your collection`. */
  listLabel: string;
  /** The card that press lands on, or `null` at that end of the walk. */
  stop: CardWalkStop | null;
  onStep: (stop: CardWalkStop) => void;
}) {
  const Glyph = direction === "previous" ? ChevronLeft : ChevronRight;
  const label = `${direction === "previous" ? "Previous" : "Next"} card in ${listLabel}`;
  const name = stop === null ? label : `${label}, ${stop.name}`;
  const tip = useTooltip();

  return (
    // **Wrapped, where nothing else here is.** `aria-label` already carries the whole of what
    // this button says, so the tooltip is `describes: false` — pure redundancy for a pointer that
    // cannot read the name. At the end of the walk the button is `disabled`, and a `disabled`
    // element fires no pointer events at all: `{...tip()}` bound to the button directly would be
    // silently inert exactly there, which is a real loss (Chromium still draws a native `title`
    // on a disabled control today) rather than a no-op. The wrapper has no box of its own beyond
    // the button's, so hovering the disc still hits *something* — the disabled button is skipped
    // by hit-testing and the span underneath it answers instead — while an enabled button keeps
    // working exactly as before, because entering the span's rect (which the button fills) fires
    // the span's handlers too.
    <span {...tip(name, { describes: false })}>
      <button
        type="button"
        disabled={stop === null}
        aria-label={name}
        onClick={() => {
          // The `disabled` attribute above already refuses this press from both hands; the test is
          // what narrows `stop` for the type checker, and it costs nothing to have both.
          if (stop !== null) onStep(stop);
        }}
        // A filled disc rather than a bare glyph: it is drawn on the scrim, which is the app at 75%
        // — a 1px outline with a card wall showing through it is `QuantityStepper`'s own
        // "disappears over art of any brightness", one layer up. `bg-bg` is the app's own ground, so
        // the disc reads as part of the dialog rather than as part of the view behind it.
        className={cn(
          "grid size-9 place-items-center rounded-full border border-border bg-bg text-dim",
          "hover:text-text disabled:opacity-40 disabled:hover:text-dim disabled:active:scale-100",
          PRESS,
          FOCUS,
        )}
      >
        <Glyph className="size-4" aria-hidden="true" />
      </button>
    </span>
  );
}

export function AllPrintingsDialog() {
  const request = useAppStore((s) => s.printingsRequest);
  const close = useAppStore((s) => s.closeAllPrintings);
  const walk = useAppStore((s) => s.cardWalk);
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);
  const selectCard = useAppStore((s) => s.setSelectedCardId);

  /**
   * Where the open modal sits on the walk, or `-1` — see this file's doc for everything that
   * hangs off it.
   *
   * **The one place the two kinds of stop are told apart**, and each side is matched the only way
   * its own list can be addressed.
   *
   * A deck row goes through `sameDeckSlot`, because a deck can hold one printing in two piles and
   * in two finishes: all five parts of `DECK_CARD_GRAIN` are what tell those rows apart, and
   * matching on fewer would land the walk on whichever one came first in the list.
   *
   * Everything else goes through `cardId`, and the `stop.deck === null` half of that test is not
   * decoration: without it a modal opened from the deck editor's docked search panel — which has
   * no slot, and so no address — would find *the deck's* row for the same printing and start
   * arrow-stepping the desk from a surface that is not the desk.
   */
  const stops = walk.stops;
  const at = useMemo(() => {
    if (request === null) return -1;
    const slot = request.deck;
    return slot === null
      ? stops.findIndex((stop) => stop.deck === null && stop.cardId === request.cardId)
      : stops.findIndex((stop) => stop.deck !== null && sameDeckSlot(stop.deck, slot));
  }, [stops, request]);
  const previous = at > 0 ? stops[at - 1] : null;
  const next = at >= 0 && at + 1 < stops.length ? stops[at + 1] : null;

  /**
   * A step: **two writes, and the second one is the point of the feature rather than a courtesy.**
   *
   * `openAllPrintings` alone would leave the list behind the scrim marking the card the reader
   * started from — so closing the modal after walking six cards would drop them back at the first,
   * with the wall's ring and the card pane both about a row they had left. The second write is
   * what makes the selection *actually follow*, and it is the store's own way of saying where the
   * card was opened from rather than a third one invented here:
   *
   * * **A deck row** — `openCardFromDeck`, which is "this card, out of *this* row", so the desk's
   *   gold ring, the pane and this modal's own `request.deck` stay one answer; it is also what
   *   keeps a press on a tile swapping the row the desk is pointing at.
   * * **Anything else** — `setSelectedCardId`, which is what every non-deck surface in this app
   *   opens a card with and which *clears* `paneDeckContext`. That clearing is load-bearing here:
   *   a reader who had a deck card open, walked away to the Collection and stepped along it would
   *   otherwise be sat in a pane still anchored to the deck row they left, offering to swap it
   *   onto whatever they had walked to. It is also what moves the ring on the wall behind the
   *   scrim, since all three lists draw their selection from that one field.
   *
   * They are two `set` calls and therefore two renders. Folding them into one store action was the
   * alternative and is refused: each of these is one field's single writer, and an action writing
   * both would be a second definition of what opening a card from a list means.
   */
  const step = useCallback(
    (stop: CardWalkStop) => {
      /**
       * **Said before either write, and this surface is where it matters most.**
       *
       * Either write re-keys the card pane behind the scrim, and that pane's body focuses itself
       * as it mounts — so a step used to move the caret *out of an `aria-modal` dialog* and into
       * the view behind it. Not merely "the walk stops after one press", which is what it costs
       * the two walls: `trapTab` cannot reach a caret that is no longer inside the panel, so Tab
       * carried on through the page under the scrim and the modal's own keydown never fired
       * again. Reported by the reader and measured in the shipped window the same day. See
       * `caretWalk.ts`.
       */
      keepCaretForCard(stop.cardId);
      openAllPrintings(stop);
      if (stop.deck === null) selectCard(stop.cardId);
      else openCardFromDeck(stop.deck);
    },
    [openAllPrintings, openCardFromDeck, selectCard],
  );

  /**
   * ArrowLeft and ArrowRight, on the **panel** — `Dialog` composes this with `trapTab`.
   *
   * On the panel rather than on `window`, which is the whole shape of the thing: an open modal
   * must not arrow-drive the deck editor behind its scrim, and the editor must not reach into the
   * modal. Whoever has the caret answers, and `aria-modal` says that is this dialog.
   *
   * **ArrowUp and ArrowDown are not handled at all** — no branch, no `preventDefault`, nothing —
   * because the thing under them is a virtualised wall of card art and its native scrolling is
   * what a reader wants from those two keys. "Up does nothing" would be a claim; leaving the keys
   * alone is the absence of one.
   *
   * Three guards, and each closes a real press. `defaultPrevented` yields to anything inside the
   * dialog that has already answered. A modifier held means the press was aimed at the browser or
   * at a shortcut, never at a chevron. And {@link ownsArrowKeys} keeps the filter row's `<select>`s
   * usable, which is the one that would have shipped.
   *
   * At either end of the walk the matching side is `null` and the press falls through **without**
   * a `preventDefault`, so the key does whatever it would have done — which is nothing, and is
   * still the honest answer rather than a swallowed press.
   */
  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (ownsArrowKeys(e.target)) return;
      const stop = e.key === "ArrowLeft" ? previous : e.key === "ArrowRight" ? next : null;
      if (stop === null) return;
      e.preventDefault();
      step(stop);
    },
    [previous, next, step],
  );

  // No walk, no flanks — and `undefined` rather than a pair of nulls, because that is what tells
  // the shell to leave its scrim exactly as every other dialog draws it.
  const flanks: DialogFlanks | undefined =
    at === -1
      ? undefined
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

  return (
    <Dialog
      open={request !== null}
      // The card, in the display face. The count line is the body's rather than this shell's
      // `subtitle`, and that is a consequence of the shell's best guarantee: the count depends on
      // the filter, the filter lives in the body, and the body is the only thing here that exists
      // only while the modal is open. Lifting either one out to reach the header would mean a
      // filter that survives a close, and then an effect out here to clear it — which is exactly
      // what `Dialog`'s doc says a host must not need.
      title={request?.name ?? ""}
      closeLabel="Close printings"
      // **The whole column the shell reserves for a panel, and no number of its own.**
      //
      // This is the one dialog in the builder whose body is a *grid to pick out of* rather than a
      // form or a list, so every tile the window can hold is a tile the reader does not scroll
      // past. A fixed `w-[72rem]` — 1152px — was that at the app's own 1280 default, where
      // `max-w-full` clamped it to 1120 and it filled the window anyway; on a 2560 display it went
      // on drawing six 170px tiles in the middle of a 2400px scrim and left the rest to the dim.
      //
      // `w-full` is 100% of the panel's grid area, which is exactly the room the shell has already
      // worked out: `p-4 sm:p-6` off the scrim, and — this is the part the number could not track
      // — `Dialog`'s `FLANK_COLUMNS`, 3.5rem either side, whenever `flanks` are asked for.
      // **So the chevrons keep their room by construction rather than by arithmetic here agreeing
      // with arithmetic there.** They are `absolute right-full mr-2` off this panel's edges, a
      // 36px disc plus an 8px gap into a 56px column, and a width spelled as `calc(100vw - 10rem)`
      // would have had to restate both of those constants to say the same thing and would have
      // gone quietly wrong the first time either moved.
      //
      // 13 tiles across at 2560 maximised, 6 at the 1280 default (which is what it drew before),
      // and 4 at the 1024 floor — 5 where there is no walk and so no flank column to reserve.
      width="w-full"
      flanks={flanks}
      onPanelKeyDown={onPanelKeyDown}
      onDismiss={close}
      onClose={close}
    >
      {/* The `request &&` is not redundant with `open` above: `Dialog` keeps the panel mounted
          for the length of its fade, and the flag is already false on the render that starts it —
          so without this the body would re-render for a frame against a `null` request.

          **The `key` is how a step clears the filter, and it is one word rather than an effect.**
          `Dialog` renders `children` only while open, which is what makes every piece of
          {@link Body}'s state a *session* with nothing anywhere resetting it — so a step to the
          next card asks for the same thing an open asks for, a new session, and `key` is what says
          that to React. An effect watching the oracle id would be a second description of the same
          rule, running a render later, with a window in which the old card's filter is applied to
          the new card's wall. It matters because the filter belongs to the card the reader left:
          narrowing to a set that the next card was never printed in draws an empty wall, and an
          empty wall reads as an answer about the card rather than as a filter.

          **Keyed on the oracle id and not on the slot**, so stepping between two piles holding the
          same card keeps the filter — it is the same wall, and the same question about it.

          What this does *not* reset is the sort, and that is right rather than an omission: it is
          not `Body`'s state at all but `usePrintingGroupBy`'s `app_meta` row, shared with the card
          pane, so it survives a step exactly as it survives a close and a restart. Remounting
          re-reads a resolved query, which is a read of the cache and not a round trip — the card
          pane's body is keyed on its card id for the same reason and gets the same answer. */}
      {request && <Body key={request.oracleId} request={request} onDone={close} />}
    </Dialog>
  );
}

/**
 * Everything that costs something: the query, the filter, the wall and what a press means.
 *
 * Mounted only while the modal is open ({@link Dialog} renders `children` on the flag), so
 * every piece of state below is a *session* rather than something an effect has to clear.
 */
function Body({
  request,
  onDone,
}: {
  request: PrintingsRequest;
  /** Close the modal — pressed on a successful swap, and on a press that opens the card pane. */
  onDone: () => void;
}) {
  const [filter, setFilter] = useState<PrintingFilter>(EMPTY_PRINTING_FILTER);
  /**
   * The ordering, which is **the card pane's preference and not this modal's**.
   *
   * `usePrintingGroupBy` is an `app_meta` row behind a query, so a reader who sorts by price here
   * finds the pane sorted by price too — the same question asked twice, answered once. The
   * control is labelled *Sort* rather than *Group by* only because this wall draws no headings;
   * see `sorted` below for why it cannot.
   */
  const { mode, setMode } = usePrintingGroupBy();
  // Which marketplace every price on this wall is quoted at. In the query key, like every priced
  // read in this app, so switching refetches rather than re-labelling numbers from another feed.
  const { marketplace } = useMarketplace();
  const viewCard = useAppStore((s) => s.setSelectedCardId);
  const tip = useTooltip();

  const query = useQuery({
    // The page size is part of the key, and deliberately: the card pane reads the same card's
    // printings without one, so the two are two entries and the modal's wide page cannot evict
    // the pane's narrow one (nor the pane's answer be mistaken for a complete list here).
    queryKey: ["card", "printings", request.oracleId, marketplace.id, PRINTINGS_PAGE],
    queryFn: () => ipc.cardPrintings(request.oracleId, marketplace.id, PRINTINGS_PAGE),
  });
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;

  /**
   * The page in the reader's chosen order, with the headings simply not drawn.
   *
   * **The pane's own ordering, reused whole.** `CardGrid` takes a flat `rows` array and positions
   * rows absolutely inside a virtualiser, so a heading cannot be interleaved without this file
   * owning the virtualisation. Flattening `buildPrintingGroups` is the trade that keeps a single
   * ordering rule: artist, release date, price and set cannot drift between the pane's list and
   * this wall, because there is only one implementation of each.
   */
  const sorted = useMemo(
    () => buildPrintingGroups(items, mode).flatMap((group) => group.printings),
    [items, mode],
  );
  const shown = useMemo(() => filterPrintings(sorted, filter), [sorted, filter]);
  const rows = useMemo(() => printingRows(shown, request.name), [shown, request.name]);

  // The three option lists, built from the **fetched page** rather than from what survives the
  // filter: a picker whose options vanished as you used it would be a picker that broke. Memoised
  // on `items` alone for that reason — narrowing does not rebuild them.
  const sets = useMemo(() => setOptions(items), [items]);
  const langs = useMemo(() => langOptions(items), [items]);
  const treatments = useMemo(() => treatmentOptions(items), [items]);

  /**
   * The write this modal can make, borrowed from the editor rather than defined here.
   *
   * `useSwapFromPane` mounts the whole of `useDeck` for the named deck, so the refusal rule that
   * carries a GONE answer back to an open editor lives on one definition — and with an editor up
   * this costs no `deck_get` at all, because TanStack shares a query's cache between observers.
   * The variant is the context's own: defaulting it would address the `live` list from a Theory
   * row, which either refuses or — where the same printing sits in the same category of both —
   * rewrites the wrong one and reports success.
   */
  const { swap, deckGone } = useSwapFromPane(request.deck, request.deck?.variant);
  const swapping = swap.isPending;
  const startSwap = swap.mutate;

  const onSelect = useCallback(
    (cardId: string) => {
      // One write at a time. This is the *only* fence available on a tile: `CardGrid` exposes no
      // per-tile disabled hook, so what the wall's wrapper does below (dimming and `aria-busy`)
      // says so and this refuses it — including from the keyboard, which `pointer-events` cannot
      // reach. Not a double-click guard alone: every tile sends the same `from` printing, and the
      // write in flight is in the middle of moving it.
      if (swapping) return;
      /**
       * No deck to write to — so the press is a *look*.
       *
       * `setSelectedCardId` rather than `viewPrinting`, and the difference is load-bearing.
       * `viewPrinting` means "another printing of the card the pane is already on" and
       * deliberately leaves `paneDeckContext` alone; this modal is opened from twelve surfaces
       * and is not the pane. A reader with a card open from a deck row who then asks about some
       * *other* card from a search tile would, with `viewPrinting`, land in a pane still anchored
       * to the first card's deck slot — and the pane draws its swap offer from the context alone,
       * so it would cheerfully offer to swap that deck row onto this unrelated printing.
       * `setSelectedCardId` clears the context, which is what "opened from somewhere that is not
       * a deck row" means everywhere else in this app.
       *
       * `deckGone` joins it: a deck another view has deleted has no slot to write to either, and
       * offering a write the backend can only refuse is worse than offering none.
       */
      if (!request.deck || deckGone) {
        viewCard(cardId);
        onDone();
        return;
      }
      startSwap(
        {
          fromCardId: request.deck.cardId,
          toCardId: cardId,
          categoryId: request.deck.categoryId,
          // Carried across rather than cleared: the reader is choosing a printing, not an object,
          // so the foil copy of the old printing becomes the foil copy of the new one.
          finish: request.deck.finish,
        },
        // **No `deckId` in that object, and it is not an omission.** `useSwapFromPane` mounted
        // `useDeck(context.deckId, variant)`, so the mutation closes over both; its `mutationFn`
        // takes exactly these four fields and passing a fifth would not type-check.
        { onSuccess: () => onDone() },
      );
    },
    [swapping, request.deck, deckGone, startSwap, viewCard, onDone],
  );

  const { menu, menuKey } = useContextMenu();
  /**
   * The card menu's dependencies, and the two facts this surface adds to them.
   *
   * `printingsOracleId` is what greys *View all printings* on every tile in here — the row would
   * otherwise offer to open the list the reader is looking at, and it is an **oracle** comparison
   * rather than a printing one because a different printing of this card is the same list.
   * `printingsDeck` is what makes the same menu's adds and a press mean the same slot.
   */
  const { deps, error: menuFailure } = useCardMenuDeps();
  const menuDeps = useMemo<CardMenuDeps>(
    () => ({ ...deps, printingsOracleId: request.oracleId, printingsDeck: request.deck }),
    [deps, request.oracleId, request.deck],
  );
  /**
   * What a `Printing` cannot say about itself, off the request that opened this.
   *
   * `typeLine: null` rather than the key omitted, and the two are different: `useDeck.addCard`
   * reads **absent** as "this caller has nothing to say" and files the card under the default
   * category with no rule run at all, where `null` still goes through `autoCategoryFor`. The
   * store's request carries a name and an oracle id and has never loaded a card, so `null` is the
   * honest value — and the honest value is also the one that keeps the filing rule.
   */
  const cardFacts = useMemo(
    () => ({ name: request.name, oracleId: request.oracleId, typeLine: null }),
    [request.name, request.oracleId],
  );
  // A thunk per tile, and the items inside it are built on the right-click rather than on the
  // render — a wall of a thousand printings must not build a thousand menus to be scrolled past.
  const cardMenu = useCallback(
    (row: PrintingRow) => menu(() => buildCardMenu(printingTarget(row, cardFacts), menuDeps)),
    [menu, cardFacts, menuDeps],
  );
  const cardMenuKey = useCallback(
    (row: PrintingRow) => menuKey(() => buildCardMenu(printingTarget(row, cardFacts), menuDeps)),
    [menuKey, cardFacts, menuDeps],
  );

  /**
   * The cheapest of a printing's finishes, at the marketplace the whole wall is quoted from.
   *
   * "Cheapest across finishes" rather than the nonfoil price, for `cheapestPrice`'s reason: an
   * etched-only or foil-only promo is priced in that column and nowhere else, and ranking those
   * with the unpriced ones would put the expensive ones at the bottom.
   *
   * **A `null` price draws an em dash, never `$0.00`.** `formatPrice` never invents a zero, and a
   * marketplace that has not answered for this printing costs a dash rather than a number — no
   * other feed's figure is substituted, because no two feeds have the same holes.
   */
  const tilePrice = useCallback(
    (row: PrintingRow) => (
      <span
        className="shrink-0 font-mono tabular-nums"
        {...tip(`Cheapest finish at ${marketplace.label}`)}
      >
        {formatPrice(cheapestPrice(row.finishPrices), marketplace.currency)}
      </span>
    ),
    [marketplace.label, marketplace.currency, tip],
  );

  /**
   * What the wall is showing, in three wordings.
   *
   * * **unfiltered and uncapped** — `862 printings`
   * * **unfiltered and capped** — `1000 of 1204 printings`, which no card in the corpus reaches
   *   today; it is kept so that a future reprint cannot make this wall lie about being complete
   * * **filtered** — `showing 37 of 862 printings`
   *
   * The filtered line counts against `total` rather than against the page, which is the same
   * number the capped line names — so the two agree about what "the list" is even in the case
   * nothing can currently produce.
   */
  const countLine = isFilterActive(filter)
    ? `showing ${shown.length} of ${plural(total, "printing")}`
    : items.length < total
      ? `${items.length} of ${plural(total, "printing")}`
      : plural(total, "printing");

  return (
    // The body is the `flex flex-col` the shell's panel expects, and the wall inside it is what
    // scrolls: `CardGrid` owns its own scroller and virtualiser and needs a bounded parent, which
    // is what `min-h-0 flex-1` on this column and on the wall's wrapper make it.
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4">
      {/* A count, so it is set in the data face — and above the controls rather than below them,
          because it is what the controls are read against. */}
      {query.data && (
        <p className="shrink-0 font-mono text-xs tabular-nums text-dim">{countLine}</p>
      )}

      <div className="shrink-0">
        <PrintingsFilterBar
          filter={filter}
          setOptions={sets}
          langOptions={langs}
          treatmentOptions={treatments}
          sort={mode}
          onFilterChange={setFilter}
          onSortChange={setMode}
        />
      </div>

      {query.isPending && <p className="shrink-0 text-xs text-dim">Loading printings…</p>}
      {query.isError && (
        <p className="shrink-0 text-xs text-destructive">
          Could not read the printings — {ipcError(query.error)}
        </p>
      )}

      {/* A refused swap, said beside the wall — and the modal stays open behind it. The card pane
          had nowhere good to put this sentence, which is half of why the list moved here.
          `role="alert"` because the press that produced it has already been forgotten by the eye:
          the tile looks exactly as it did. */}
      {swap.isError && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          Could not use that printing — {ipcError(swap.error)}
        </p>
      )}
      {/* And a refused **menu** write, which is a different thing: an add the reader made from a
          panel that had already closed by the time the backend answered. Every surface mounting
          `useCardMenuDeps` owes this, or a card silently fails to be filed. */}
      <CardMenuRefusal error={menuFailure} className="shrink-0" />

      {/* Two empty states, because they are two different facts. One is about the filter and the
          reader can undo it; the other is about the card and they cannot.

          **Neither draws a control of its own.** `PrintingsFilterBar` renders `Clear all`
          whenever the filter is active, which is exactly when the first sentence is on screen —
          a second button with the same job would be one more thing to keep in step and an
          ambiguous target for anything addressing it by name. */}
      {items.length > 0 && shown.length === 0 && (
        <p className="shrink-0 text-sm text-dim">No printings match these filters.</p>
      )}
      {!query.isPending && !query.isError && items.length === 0 && (
        <p className="shrink-0 text-sm text-dim">This card has no paper printings.</p>
      )}

      {rows.length > 0 && (
        // Inert while a swap is in flight, which is the pane's own rule: the handler refuses the
        // press *and* the surface says so. `CardGrid` offers no per-tile disabled hook and this
        // file must not invent one, so the fence is drawn around the whole wall — one write is
        // moving the slot every tile on it would send.
        <div
          aria-busy={swapping || undefined}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            swapping && "pointer-events-none opacity-60",
          )}
        >
          <CardGrid
            rows={rows}
            onSelect={onSelect}
            onNeedNextPage={NO_NEXT_PAGE}
            // The filter and the sort are in it, so a narrowed wall starts at the top instead of
            // at the clamped scroll offset of the list it replaced.
            listKey={`${request.oracleId}:${mode}:${JSON.stringify(filter)}`}
            // Its own zoom section, not the search's: the modal opens *over* a wall the reader
            // has already sized, and a ctrl+wheel in here must not resize the page underneath.
            zoomSection="printings"
            // **`CardGrid`'s `arrowNav` is opt-in and this wall deliberately does not opt in**,
            // which is what makes the chevrons' keys reachable at all: the two would otherwise be
            // one press with two meanings — move the selection along the wall, and step to the
            // next card in the deck — decided by whichever handler saw the event first. The search
            // and collection walls take it because there the arrows have nothing else to mean.
            // Nothing is passed here on purpose; the absence *is* the decision, and `arrowNav`'s
            // own doc says so from the other end.
            //
            // **The "you are here" mark: the printing the question was asked about.** From a deck
            // row that is the printing the slot currently plays; from a search tile, a collection
            // entry or a wishlist row it is the row the menu was opened on, and from a step it is
            // the card the walk just landed on. It used to be `request.deck?.cardId`, so outside a
            // deck the wall was unmarked — which was defensible while the modal was about one
            // card and became wrong the moment the arrow keys could walk a list: two printings of
            // one card are two stops drawing the same wall, and with nothing ringed a step
            // between them moved nothing on screen at all.
            selectedId={request.cardId}
            label={`Printings of ${request.name}`}
            topLeft={tileLanguage}
            finish={tileFinish}
            action={tilePrice}
            cardMenu={cardMenu}
            cardMenuKey={cardMenuKey}
          />
        </div>
      )}
    </div>
  );
}
