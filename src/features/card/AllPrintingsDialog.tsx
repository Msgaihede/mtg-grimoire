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
 * all three of which are {@link DeckDialog}s. So this is one too, and the store field behind it
 * writes one thing and moves nothing.
 *
 * ## The shape
 *
 * Two components, and the split is the shell's rule rather than tidiness. {@link DeckDialog}
 * renders `children` **only while open**, so everything that costs something — the query, the
 * filter, the sort observer, the scroll position — lives in {@link Body} and therefore exists
 * only while the modal does. A closed modal costs one store read, and every open starts clean
 * with no effect anywhere resetting anything.
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
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { DeckDialog } from "@/features/decks/DeckDialog";
import { useSwapFromPane } from "@/features/decks/useDeck";
import { CardGrid } from "@/features/search/CardGrid";
import { plural } from "@/lib/counts";
import { soleFinish } from "@/lib/finish";
import { ipc, ipcError, type Printing } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
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

export function AllPrintingsDialog() {
  const request = useAppStore((s) => s.printingsRequest);
  const close = useAppStore((s) => s.closeAllPrintings);

  return (
    <DeckDialog
      open={request !== null}
      // The card, in the display face. The count line is the body's rather than this shell's
      // `subtitle`, and that is a consequence of the shell's best guarantee: the count depends on
      // the filter, the filter lives in the body, and the body is the only thing here that exists
      // only while the modal is open. Lifting either one out to reach the header would mean a
      // filter that survives a close, and then an effect out here to clear it — which is exactly
      // what `DeckDialog`'s doc says a host must not need.
      title={request?.name ?? ""}
      closeLabel="Close printings"
      // Written out whole, never interpolated: Tailwind scans source text for class names.
      // 72rem is a wall rather than a list — six 170px tiles across at the default zoom.
      width="w-[72rem]"
      onDismiss={close}
      onClose={close}
    >
      {/* The `request &&` is not redundant with `open` above: `DeckDialog` keeps the panel mounted
          for the length of its fade, and the flag is already false on the render that starts it —
          so without this the body would re-render for a frame against a `null` request. */}
      {request && <Body request={request} onDone={close} />}
    </DeckDialog>
  );
}

/**
 * Everything that costs something: the query, the filter, the wall and what a press means.
 *
 * Mounted only while the modal is open ({@link DeckDialog} renders `children` on the flag), so
 * every piece of state below is a *session* rather than something an effect has to clear.
 */
function Body({
  request,
  onDone,
}: {
  request: { oracleId: string; name: string; deck: PaneDeckContext | null };
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
        title={`Cheapest finish at ${marketplace.label}`}
      >
        {formatPrice(cheapestPrice(row.finishPrices), marketplace.currency)}
      </span>
    ),
    [marketplace.label, marketplace.currency],
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
            // The "you are here" mark: the printing the deck slot currently plays. Null where
            // there is no deck, because then no printing on this wall is special.
            selectedId={request.deck?.cardId ?? null}
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
