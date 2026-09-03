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
 * Three answers, decided by what the surface that opened this named — a wishlist row
 * (`printingsRequest.wish`), a deck slot (`printingsRequest.deck`), or neither. They are read in
 * that order, and the fall-through is the last of them:
 *
 * * **From a wishlist row** — the press *repoints the wish* onto that printing, through
 *   `wishlistSetPrinting`, and the modal closes on success. The same gesture as the swap below and
 *   for the same reason; the write is a different one only because a wish is addressed by its own
 *   row rather than by a deck card's five-part grain. A repoint that collides with another wish in
 *   the same folder **merges** rather than failing, which is the backend's rule and not something
 *   this surface can see or has to.
 * * **From a deck row** — the press *is* the swap, through `useSwapFromPane` — named for the
 *   docked pane that used to press it and this file's only caller since that pane was deleted on
 *   2026-09-03 — and the modal closes on success **unless the swap folded**, which is the one
 *   outcome that owes the reader a sentence and therefore a surface to read it on (see the live
 *   region in {@link Body}). Click-commits rather than select-then-confirm, which is what the
 *   pane's own printing rows did: the tile is the thing the reader is pointing at. The cost that
 *   gesture carried there — no way to look at a printing without committing to it — is not paid
 *   here, because the whole wall is art and looking is what a wall is for. A mis-press is
 *   covered by the deck's undo.
 * * **From anywhere else** — the press opens the card detail modal on that printing and closes
 *   this one, which is the "go and look at this one" the reader who is not building a deck
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
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { sameDeckSlot } from "@/features/decks/deckWalk";
import { Dialog, type DialogFlanks } from "@/components/Dialog";
import { useSwapFromPane } from "@/features/decks/useDeck";
import { CardGrid } from "@/features/search/CardGrid";
import { keepCaretForCard } from "@/lib/caretWalk";
import { plural } from "@/lib/counts";
import { soleFinish } from "@/lib/finish";
import { finishTreatments } from "@/lib/treatment";
import { ipc, ipcError, type Printing } from "@/lib/ipc";
import { languageHint } from "@/lib/languages";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import {
  useAppStore,
  type CardWalkStop,
  type PaneDeckContext,
  type PrintingsRequest,
} from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { buildCardMenu, type CardMenuDeps } from "./cardMenu";
import { handBackToDeckCard } from "./deckControl";
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
import { StepChevron } from "./StepChevron";
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
 * What a tile's printing is *called* — the answer issue #160 asked for, on the exact screen it
 * was reported from.
 *
 * Elesh Norn is the card in that report: three of its eleven printings drew the identical
 * `Sparkles`, and they are a Halo Foil (`mul 133`), a serialized Double Rainbow (`mul 133z`)
 * and an ordinary Secret Lair foil (`sld 811`). This is what tells them apart — **in words,
 * and no longer in the picture**: since issue #353 the glyph is the finish on every surface,
 * so all three still draw that `Sparkles` and it is the mark's label, its tooltip and the
 * tile's caption that answer *which* foil.
 *
 * Paired with {@link tileFinish} rather than read off the printing alone, so a foil word is
 * withheld from a printing that is also sold plain — see `finishTreatments`. Module scope for
 * {@link tileFinish}'s reason: a fresh arrow per render re-registers every tile on every
 * scrolled row.
 */
const tileTreatment = (row: PrintingRow) => finishTreatments(row.promoTypes, tileFinish(row));

/**
 * The top-left corner: this printing's language, **only when it is not English**.
 *
 * A wall where every tile says `EN` says nothing, and the corner is one of only three a tile has.
 * On a heavily reprinted card the non-English rows are most of what is crowding the wall, which
 * is the same argument that puts a language picker in the filter bar.
 *
 * 10px scaled by the card's own `--mark-scale`, matching the search wall's printing count in the
 * same corner: a fixed size climbs out of the printed nameplate by 2×.
 *
 * **Module scope, and the tooltip is bound one level down in {@link LanguageMark} rather than
 * here.** `CardGrid`'s `topLeft` wants a stable identity, and `useTooltip()` is a hook — a
 * `tip` closed over from `Body` would either re-register every tile on every scrolled row or
 * have to be called somewhere a hook may not run. A component costs one element and gets both.
 */
const tileLanguage = (row: PrintingRow) =>
  row.lang === "en" ? null : <LanguageMark lang={row.lang} />;

/**
 * The corner's two letters, and the sentence they are short for.
 *
 * The mark is an abbreviation on a photograph with no caption beside it: `PH` on Elesh Norn is
 * unreadable to anyone who has not already learned that Scryfall files Phyrexian as a language
 * (issue #161). The words come from `languageHint` so the wall, the card pane's facts line and
 * its printings rows all say the same thing, and the corner can carry them at all because
 * `CardGrid` gives both marks `pointer-events-auto` — a tooltip inside a `pointer-events-none`
 * box is one that can never be shown.
 */
function LanguageMark({ lang }: { lang: string }) {
  const tip = useTooltip();
  return (
    <span
      {...tip(languageHint(lang))}
      className={cn(
        "block whitespace-nowrap font-mono uppercase text-text",
        "text-[calc(10px*var(--mark-scale,1))] leading-none",
      )}
    >
      {lang}
    </span>
  );
}

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
 *
 * **`select` was the original clause and is now the dead one.** `PrintingsFilterBar`'s controls
 * became `Dropdown`s on 2026-08-26, so what has to be exempted is a dropdown's two shapes instead:
 * the **trigger** while its panel is open — ArrowLeft/ArrowRight there belong to the control the
 * reader is inside, not to the walk — and anything **inside the panel**, which is where the caret
 * actually sits. `select` stays in the list because the app may grow one back, and a stale clause
 * that matches nothing costs nothing.
 */
const ARROW_OWNERS =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']," +
  '[aria-haspopup="listbox"][aria-expanded="true"], [role="listbox"]';

function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_OWNERS) !== null;
}

export function AllPrintingsDialog() {
  const request = useAppStore((s) => s.printingsRequest);
  const closeRequest = useAppStore((s) => s.closeAllPrintings);
  const walk = useAppStore((s) => s.cardWalk);
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);
  const selectCard = useAppStore((s) => s.setSelectedCardId);

  /**
   * The deck row a swap made, held for the caret — `null` whenever this modal has written nothing.
   *
   * **A ref rather than state**, because nothing on screen depends on it: it is a note from the
   * press to the close, exactly the shape the docked pane's `handover` was, and a `set` would
   * re-render the whole wall to record something no tile draws.
   *
   * It names the row the deck holds **now** — the old slot with the printing that was pressed in
   * it — because that is the control the caret is owed and the swap has just rebuilt it under a
   * different address. See `deckControl.ts`.
   */
  const swapped = useRef<PaneDeckContext | null>(null);

  /**
   * Escape and the ✕: close, then walk the caret home if a swap left it nowhere to stand.
   *
   * `Dialog` hands a host two closes and this is the one that owes the reader a caret — see the
   * shell's own doc, and {@link closeQuietly} for the other. `handBackToDeckCard` decides whether
   * the press is even entitled to one; all this knows is which row to name.
   *
   * **The note is cleared before the close rather than after the focus**, so a hand-back that
   * cannot be made (another modal still standing, a reader who has moved on) cannot be made twice
   * by the next press either.
   */
  const close = useCallback(() => {
    const home = swapped.current;
    swapped.current = null;
    closeRequest();
    handBackToDeckCard(home);
  }, [closeRequest]);

  /** A press on the scrim: close and move nothing. The reader pointed somewhere else, which is
   *  this app's standing rule that an outside click hands no caret back. */
  const closeQuietly = useCallback(() => {
    swapped.current = null;
    closeRequest();
  }, [closeRequest]);

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
      // A step is a new session — that is what the `key` below says about the body's filter, and
      // it is as true of the note a swap left. The caret is owed to the card the reader was
      // standing on when they wrote something, and after a step they are standing on another one.
      swapped.current = null;
      /**
       * **`wish: null` is the step's own decision, not a shape mismatch to be papered over.**
       *
       * A `CardWalkStop` carries no wish and deliberately never will, so stepping *clears* the
       * row a press would repoint: the reader asked about wish A, and arrowing to card B and
       * pressing a printing of B must not rewrite A onto a card it was never for. A press after
       * a step therefore falls through to the plain answer — the card pane on that printing.
       *
       * The field is required on `PrintingsRequest` precisely so this line has to say it. Made
       * optional it would read identically and mean the opposite by omission, which is a
       * silent write to somebody's wishlist.
       *
       * `deck` travels, and the asymmetry is right: a stop on a deck walk *is* a deck row, so the
       * next row is the next row's slot. A wish is the one thing the reader named that the list
       * behind the scrim knows nothing about.
       */
      openAllPrintings({ ...stop, wish: null });
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
      // **Three quarters of the window, floored at the window floor and ceilinged at the column
      // the shell reserves.**
      //
      // This is the one dialog in the builder whose body is a *grid to pick out of* rather than a
      // form or a list, and that argument has now been run to both of its ends. A fixed
      // `w-[72rem]` — 1152px — drew six 170px tiles in the middle of a 2400px scrim on a 2560
      // display and left the rest to the dim; `w-full` (2026-08-20) answered that by asking for
      // the whole reserved column, 13 tiles across. Issue #157 is what the second one costs at
      // the other end of the list, and it is not a wide-display problem: a card with **two**
      // printings drew two tiles against the left edge of a panel that was the window, at every
      // size. A modal nobody can see past is a modal that has stopped reading as a modal.
      //
      // So the request is a proportion, and the guard either side of it is doing the work the
      // number used to do badly:
      //
      // * `100%` is `w-full`'s meaning kept as a **ceiling**, so nothing below is a length this
      //   file has to keep in step with the shell. The grid area is `p-0 sm:p-6` off the scrim
      //   and — this is the part a `calc(100vw - 10rem)` could not track — `Dialog`'s
      //   `FLANK_COLUMNS`, 3.5rem either side, whenever `flanks` are asked for. **The chevrons
      //   therefore keep their room by construction rather than by arithmetic here agreeing with
      //   arithmetic there**: they are `absolute right-full mr-2` off this panel's edges, a 36px
      //   disc plus an 8px gap into a 56px column, and they travel with whatever the panel is.
      // * `64rem` is the **floor**, and it is the app's own 1024px window floor spelled as a
      //   panel width rather than a second opinion about how small is too small. At that window
      //   the reserved column is 864 and 75vw would ask for 768 — less than
      //   `PrintingsFilterBar` above the wall wants, and a narrowing that buys scrim nobody
      //   asked for on the one screen with none to spare. There the floor loses to the ceiling,
      //   which is the right answer: a window with nothing to give gives nothing.
      //
      // Measured in Storybook 2026-08-21, both the plain and the flanked story: **1920 at 2560,
      // 1024 at 1280, and the whole column at the 1024 floor**, centred at every one of them,
      // with `documentElement.scrollWidth` equal to `clientWidth` and both chevrons inside the
      // window. The panel is the same three numbers with or without flanks above the floor,
      // because 75vw is a fact about the *window* and binds before the column does.
      //
      // Tiles across at 100% zoom with no walk to flank the panel: 10 at 2560 maximised (13
      // before), 7 at 1920 (9), 5 at the 1280 default (6), and 5 at the 1024 floor, where nothing
      // moves at all — 4 there once a walk buys its flank columns, as it drew before.
      size="w-[min(100%,max(64rem,75vw))]"
      // **A rung is a claim about the highest thing a surface can be asked to cover, not about
      // where it usually sits** — which is why this one is the shell's `"stacked"` while every
      // other dialog in the app says nothing and takes `LAYER.overlay`.
      //
      // This modal is opened **two ways**: from a card menu over a bare view, which is what the
      // default rung describes, and from the card detail modal's `View all printings`, which is
      // not. In the second case both surfaces are `fixed inset-0` scrims, neither inside the
      // other, in the root stacking context — so at `overlay` they **tie**, and equal z-indexes
      // are resolved by document order, which is the bug `layers.ts` opens with. The common case
      // is therefore no evidence at all: a rung that is right for it would still be wrong here.
      layer="stacked"
      flanks={flanks}
      onPanelKeyDown={onPanelKeyDown}
      onDismiss={close}
      onClose={closeQuietly}
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
          not `Body`'s state at all but `usePrintingGroupBy`'s `app_meta` row, which outlives this
          component, so it survives a step exactly as it survives a close and a restart. Remounting
          re-reads a resolved query, which is a read of the cache and not a round trip —
          `CardModalArt` is keyed on its card id for the same reason and gets the same answer. */}
      {request && (
        <Body
          key={request.oracleId}
          request={request}
          onDone={close}
          onSwapped={(row) => {
            swapped.current = row;
          }}
        />
      )}
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
  onSwapped,
}: {
  request: PrintingsRequest;
  /** Close the modal — pressed on a successful swap or repoint, and on a press that opens the
   *  card detail modal. */
  onDone: () => void;
  /** The deck row a swap just made, so the shell can hand the caret to it when this closes. The
   *  row **after** the write: the old slot with the printing that was pressed in it. */
  onSwapped: (row: PaneDeckContext) => void;
}) {
  const [filter, setFilter] = useState<PrintingFilter>(EMPTY_PRINTING_FILTER);
  /**
   * The ordering, which is **a stored preference and not this modal's own state**.
   *
   * `usePrintingGroupBy` is an `app_meta` row behind a query, so a reader who sorts by price here
   * finds this wall sorted by price at the next open and after a restart. It was the docked
   * pane's preference too — the same question asked twice, answered once — until that pane was
   * deleted on 2026-09-03; this file is its only reader now. The control is labelled *Sort*
   * rather than *Group by* only because this wall draws no headings; see `sorted` below for why
   * it cannot.
   */
  const { mode, setMode } = usePrintingGroupBy();
  // Which marketplace every price on this wall is quoted at. In the query key, like every priced
  // read in this app, so switching refetches rather than re-labelling numbers from another feed.
  const { marketplace } = useMarketplace();
  const viewCard = useAppStore((s) => s.setSelectedCardId);
  /**
   * How a fold re-points the modal at the row the deck now holds — see {@link onSelect}.
   *
   * The same action the chevrons step with, spent on the same card rather than the next one: a
   * fold leaves `request.deck` naming a row the write has just deleted, so without this the wall
   * would go on offering to swap *from* a slot the backend can only refuse, and the "you are here"
   * ring would stay on a printing the deck no longer plays.
   */
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const queryClient = useQueryClient();
  /**
   * The wishlist row a press repoints, or `null` on every surface that names none — which is
   * all of them but the wishlist's own rows.
   *
   * Named once because it is both the discriminant of `onSelect`'s first branch and a dependency
   * of it, and the branch and the dependency have to be the same expression or the callback
   * decides with one value and is rebuilt on another.
   */
  const wish = request.wish;

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

  /**
   * The other write a press can be: the **wish** this modal was opened about, repointed onto the
   * printing pressed.
   *
   * Defined here rather than borrowed, unlike the swap above, because there is nothing to borrow
   * — a wish is addressed by its own row id, so this mutation is `wishlistSetPrinting` and two
   * invalidations and has no editor's refusal rule to share. `["wishlist"]` for the list itself
   * and `["cards", "search"]` because every search row draws `wishlisted`; the collection and the
   * decks are untouched, since a wish is a copy the reader does not have and moves no figure in
   * either. The same pair `useCardMenuDeps`' wishlist add settles, for the same two reasons.
   *
   * **The answer is deliberately not read.** `wishlist_set_printing` *merges* when the printing
   * chosen collides with another wish already in the same folder, so the `EntryChange` can name a
   * different row than the one asked about — the destination's. Nothing here patches a cache off
   * it, and nothing here may: the modal closes on success either way, and the invalidation above
   * is what makes the list right whichever row survived.
   */
  const repoint = useMutation({
    // The wish's id rides in the variables rather than being closed over, so the mutation cannot
    // be left holding the id of a wish the request has since moved off.
    mutationFn: ({ id, cardId }: { id: number; cardId: string }) =>
      ipc.wishlistSetPrinting(id, cardId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
      onDone();
    },
  });

  /**
   * **One flag for both writes**, because the wall is fenced by *a* write being in flight rather
   * than by which one: the fence is drawn around the whole wall (see the wrapper at the foot of
   * this file), and a second flag would be a second thing to remember to widen.
   *
   * It was `swapping` while a swap was the only write this surface could make. The name moved
   * with the meaning rather than staying and quietly covering a repoint too.
   */
  const writing = swap.isPending || repoint.isPending;
  const startSwap = swap.mutate;
  const startRepoint = repoint.mutate;

  /**
   * What the last successful swap **did**, or `null` — the sentence the live region below draws.
   *
   * Only ever a fold. A plain swap needs no words: the reader picked a printing, the deck redraws
   * on it under the modal, and the wall closes onto the answer. A fold is the outcome nothing on
   * screen explains — see the region for the whole of it.
   */
  const [report, setReport] = useState<string | null>(null);

  const onSelect = useCallback(
    (cardId: string) => {
      // One write at a time. This is the *only* fence available on a tile: `CardGrid` exposes no
      // per-tile disabled hook, so what the wall's wrapper does below (dimming and `aria-busy`)
      // says so and this refuses it — including from the keyboard, which `pointer-events` cannot
      // reach. Not a double-click guard alone: every tile sends the same `from` printing, and the
      // write in flight is in the middle of moving it.
      if (writing) return;
      // Whatever the last press did is not what this one did. Cleared here rather than in each
      // branch, so a refusal cannot be read under a fold's sentence from the press before it.
      setReport(null);
      /**
       * **A wish, and it is read before the deck slot and before the fall-through.**
       *
       * A reader who opened this from a wishlist row is asking to change *that wish's* printing,
       * so that is what the press does; the modal closes on the mutation's own success rather
       * than here, exactly as the swap below does, so a refusal leaves it open with the sentence
       * beside the wall.
       *
       * The two targets cannot both be set from any surface the app draws today — a wishlist row
       * is not a deck row — so the order costs nothing now and is written down anyway: the day
       * one surface can name both, "which write did my press make" must be a decision somebody
       * made rather than whichever branch happened to be first.
       */
      if (wish) {
        startRepoint({ id: wish.id, cardId });
        return;
      }
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
      // Named once, before the write, because the `onSuccess` below is a closure: TypeScript's
      // narrowing of `request.deck` does not survive into it, and the row this is about is the one
      // the press was made against rather than whatever the store holds when the answer lands.
      const from = request.deck;
      startSwap(
        {
          fromCardId: from.cardId,
          toCardId: cardId,
          categoryId: from.categoryId,
          // Carried across rather than cleared: the reader is choosing a printing, not an object,
          // so the foil copy of the old printing becomes the foil copy of the new one.
          finish: from.finish,
        },
        // **No `deckId` in that object, and it is not an omission.** `useSwapFromPane` mounted
        // `useDeck(context.deckId, variant)`, so the mutation closes over both; its `mutationFn`
        // takes exactly these four fields and passing a fifth would not type-check.
        {
          onSuccess: (result) => {
            /**
             * The row the deck holds now: the same slot, with the printing that was pressed in
             * it. Handed up before either branch below, because it is what the caret is owed
             * whichever way this press ends — see `deckControl.ts`.
             */
            const moved: PaneDeckContext = { ...from, cardId };
            onSwapped(moved);
            /**
             * **Nothing folded, so nothing to say — and this is the close every swap made until
             * now.** The deck redraws on the printing the reader picked, which is the answer to
             * the question they asked, and a wall that stayed up over it would be a modal nobody
             * dismissed.
             */
            if (!result.folded) {
              onDone();
              return;
            }
            /**
             * **A fold, so the modal stays open — and that is where the sentence can be read.**
             *
             * A category holds a printing at most once, so a swap onto one it already had turns
             * two rows into one: the card the reader was looking at *disappears from the deck*
             * and its copies land on another row. That is the one outcome of this press nothing
             * on screen explains, and closing on it would leave a reader watching a line vanish
             * with no account of where it went.
             *
             * It cannot be said on the way out. A live region has to be **mounted before its
             * text arrives** or nothing announces it, and a region inside a panel that is
             * unmounting has no second commit to change on — so a sentence written into a
             * closing dialog is a sentence nobody hears and nobody reads. Holding the modal open
             * is what gives it both: the region below has been mounted and empty since the wall
             * opened, and this write is the change that fills it.
             *
             * It is also the shape this dialog already uses for the two things it has to
             * explain — a refused swap and a refused repoint both keep it open and put the
             * sentence beside the wall — so a fold is a third of those rather than a new idea.
             *
             * The re-point is what keeps the open modal honest: `request.deck` names a row this
             * write has just deleted, and a wall left addressing it would refuse the reader's
             * next press for a reason they could not see. The oracle id does not move, so the
             * body is not re-keyed and this sentence survives the re-render.
             */
            openAllPrintings({ ...request, cardId, deck: moved });
            /**
             * The server's arithmetic, never a guess: `quantity` is what the surviving row holds
             * (`ipc.ts`'s `SwapResult`). The category's name is the context's own rather than a
             * lookup — a category is a row the user named, so there is no table to translate an
             * id through and this modal has no category list of its own.
             */
            setReport(`Folded into one row of ${result.quantity} in ${from.categoryName}.`);
          },
        },
      );
    },
    [
      writing,
      wish,
      startRepoint,
      request,
      deckGone,
      startSwap,
      viewCard,
      onDone,
      onSwapped,
      openAllPrintings,
    ],
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

      {/* **What a successful swap did** — the live region, and the one sentence on this surface
          that is not about a failure.

          It says a **fold**: the target category already held the printing, so two rows became one
          and the line the reader opened this modal from is no longer in the deck. `SwapResult`
          exists to answer that question and nothing was drawing it.

          **Mounted for the whole life of the open modal, empty until there is something to say.**
          A live region that first appears with its text already inside it announces nothing, which
          is this app's standing rule — the ribbon's status line, `SearchPage`, `WishlistPage` and
          `AddToCollection` all keep the same shape. So this is outside every gate the body has:
          not behind `query.data`, not behind the swap's state, not behind a fold. It exists on the
          first commit of every wall and changes on the commit after the write.

          **And the modal is held open on a fold precisely so that this can be read** — see the
          swap's `onSuccess`. Announcing into a panel that is unmounting announces nothing, and a
          sentence drawn for one frame of a fade is not one either.

          `sr-only` while empty rather than hidden: `display: none` takes a region out of the
          accessibility tree, and a region that has to be put back is a region that was never
          mounted. Tailwind's `.sr-only` is absolutely positioned, so an empty one is not a flex
          item and costs neither a row nor a gap in this column. */}
      <p role="status" className={cn("shrink-0 text-xs text-dim", !report && "sr-only")}>
        {report}
      </p>

      {/* A refused swap, said beside the wall — and the modal stays open behind it. The card pane
          had nowhere good to put this sentence, which is half of why the list moved here.
          `role="alert"` because the press that produced it has already been forgotten by the eye:
          the tile looks exactly as it did. */}
      {swap.isError && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          Could not use that printing — {ipcError(swap.error)}
        </p>
      )}
      {/* And a refused **repoint**, in the same place and for the same reason. Its own sentence
          rather than the one above with a wider subject: the two writes are refused by different
          things — a deck another view deleted, a wish another view removed — and "could not use
          that printing" over a wishlist would name the half of the failure the reader can do
          nothing about. Only one of the two can be on screen, since a request names at most one
          target. */}
      {repoint.isError && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          Could not repoint that wish — {ipcError(repoint.error)}
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
        // Inert while a write is in flight — a swap or a repoint, since the wall is fenced by
        // there being one rather than by which — which is the pane's own rule: the handler
        // refuses the press *and* the surface says so. `CardGrid` offers no per-tile disabled
        // hook and this file must not invent one, so the fence is drawn around the whole wall:
        // one write is moving the target every tile on it would send.
        <div
          aria-busy={writing || undefined}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            writing && "pointer-events-none opacity-60",
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
            treatment={tileTreatment}
            // What one copy of this printing costs, **in the chin** — the bar under the art that
            // already carries the rarity, the set and the finish.
            //
            // It was `action={tilePrice}` until 2026-08-26: a hover-revealed strip over the foot
            // of the picture. That was the wrong home for it twice over. A price that only exists
            // while a pointer rests on the tile is unreadable to a reader scanning a wall of 862
            // printings for the cheap one — and this is the one screen in the app built for
            // exactly that comparison. And the strip lies *inside* the tile's `relative` box,
            // whereas the chin is a sibling of the art button, so the figure is announced rather
            // than hidden behind a hover a keyboard cannot perform. Both are gone in favour of
            // one fact drawn once, in the place every other wall now draws it.
            //
            // The **cheapest finish**, not the nonfoil price: `cheapestPrice` is what this
            // dialog's own `price` group-by ranks on, so the order the reader picked and the
            // number under each tile come from one definition — and a foil-only or etched-only
            // promo is priced in that column and nowhere else, so quoting nonfoil would leave the
            // rows most worth comparing reading as unpriced.
            //
            // `formatPrice` draws an em dash for a printing this marketplace has not answered
            // for; it never invents `$0.00`, and no other feed's figure is substituted, because
            // no two feeds have the same holes. Spec §5's as-of sentence is said once for this
            // wall rather than on a thousand tooltips, which is why this is a bare figure.
            money={(row) => formatPrice(cheapestPrice(row.finishPrices), marketplace.currency)}
            cardMenu={cardMenu}
            cardMenuKey={cardMenuKey}
          />

          {/* **Spec §5: a price is never shown without saying how old it is** — and this wall is
              nothing but prices, so it is the last surface that should have been missing it.

              It restores the other half of what `tilePrice`'s tooltip used to say, and says it
              better. That tooltip read `Cheapest finish at <marketplace>`: it named *whose*
              prices these are, which matters with five in the picker, but never said *when* —
              and it said it once per tile, revealed on a hover a keyboard cannot perform.
              `pricesAsOf` answers both halves in one sentence, drawn once, under the wall it is
              about; it also names which of the two clocks this marketplace runs on, the card-data
              sync or the price-feed refresh, which a fixed phrasing could not.

              Under the wall rather than beside the count line above it, so it reads as a footnote
              to the figures it is about — the arrangement the deck's `PriceStrip` and the card
              pane both already use. */}
          <p className="shrink-0 pt-1 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        </div>
      )}
    </div>
  );
}
