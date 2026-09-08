import { useEffect, useId, useState, type JSX, type ReactNode } from "react";
import { keepPreviousData, skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { FILTER_FIELD, ToggleChip } from "@/components/FilterChips";
import { ManaText } from "@/components/ManaText";
import { COMBO_TAG } from "@/features/decks/DeckBracket";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { count, plural } from "@/lib/counts";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { WALL_CARD_VARIANT } from "@/lib/images";
import {
  ipc,
  ipcError,
  type CardCombo,
  type CardCombosPage,
  type CardDetail,
  type ComboPiece,
  type ComboStatus,
} from "@/lib/ipc";
import { COMBOS_STATUS_KEY, cardCombosKey } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { cardDetailKey } from "./cardDetailKey";

/**
 * Combos per request.
 *
 * **The list is paged because the corpus says it has to be.** Measured on the real corpus
 * 2026-09-08: 107 016 combos over 7 330 distinct cards, and the distribution is not remotely
 * flat — Ashnod's Altar is in **6 044** of them and 114 cards are in more than 500. A dialog that
 * asked for "this card's combos" would therefore be asking for six thousand rows, each with two
 * to five card pictures in it, for the one card a reader is most likely to open it on.
 *
 * 25 rather than the search wall's 60: a combo row is a wall of art, so a page here is nearer a
 * screen of reading than a screen of tiles, and **Show more** is one press away.
 *
 * **Paging is not a way to *find* anything, which is the other half of that 6 044 and why the box
 * above the chips exists.** Twenty-five at a time with no search is 242 presses to reach the end of
 * one card's list, and a reader who wants the combo with Krark-Clan Ironworks in it has no way to
 * ask for it. The search narrows in SQL, like the chips, for the chips' reason: a term applied to
 * the page in hand would be searching 0.4 % of the list and calling the answer *no match*.
 *
 * **It stays 25 now that the rows collapse**, which is worth saying because the argument above got
 * smaller and the number did not. A page is a fraction of the height it was — the five prose
 * sections are behind a press — but the pictures are not, and they are what a page of this list
 * costs to draw and to scroll. What the accordion bought is a list a reader can *scan*; a bigger
 * page would spend that on a longer scroll.
 */
const PAGE_SIZE = 25;

/**
 * What an empty answer means when the feed has never been ingested.
 *
 * **This sentence is the whole reason this dialog reads {@link ipc.combosStatus} at all**, and it
 * is `OracleTagsDialog`'s split one feed over: `combos_for_card` cannot tell a card with no combos
 * from a database with no combo table, because both are zero rows, and the two answers are not
 * close. One is a fact about the reader's card; the other is a fact about the reader's database.
 *
 * A never-ingested table is a **supported state** rather than a failure — it is where every
 * install is before its first launch fetch lands, where a machine that cannot reach Spellbook
 * stays, and where `combos_clear` puts one back on purpose. The last clause is
 * `DeckBracket`'s, in this surface's own words: the feed is fetched at launch, there is no button
 * for it anywhere in the app, so the honest instruction is that nothing needs a press.
 */
const NEVER_FETCHED =
  "No combos yet — Commander Spellbook's combo list has not been downloaded. " +
  "The app fetches it in the background shortly after launch. Nothing here needs a press.";

/** An empty answer from a feed that *is* here: Spellbook lists no combo naming this card. The
 *  other half of {@link NEVER_FETCHED}'s split, and the claim that needs the status row. */
const NO_COMBOS = "No combos. Commander Spellbook has none on record naming this card.";

/**
 * A printing with no oracle card behind it.
 *
 * `CardDetail.oracleId` is nullable and a handful of rows really are null, so this is a state
 * rather than a defect — and it is the one case where the dialog asks nothing at all. There is no
 * question to put: `combos_for_card` matches on oracle id, so a null id has nothing to look up and
 * a call would only be this component asking the backend to confirm that zero is zero.
 */
const NO_ORACLE_CARD =
  "No combos. This printing is not linked to an oracle card, and a combo is a fact about the " +
  "card rather than about the printing.";

/**
 * The **fourth** empty, and it must never borrow one of the three above.
 *
 * A filter that leaves nothing is a statement about the filter, not about the card or the
 * database — and the chips are still on screen above it, each carrying the count that says so. It
 * is drawn only where `total > 0`, which is what keeps it from ever standing in for
 * {@link NEVER_FETCHED}: a database with no rows has no chips to have narrowed with.
 *
 * **A search that matches nothing is this sentence and not a fifth one.** The box is a filter like
 * the chips are — it narrows the same list, it is undone the same way, and it sits in the same row
 * of controls above this line — so a term that leaves nothing has left the reader in exactly the
 * state a chip does. `total` is over the unfiltered set and the search does not move it, which is
 * what keeps this branch reachable with a term in the box: the empty answer is `matching`.
 */
const NO_MATCH = "No combo matches that filter.";

/**
 * Where the combos came from and how old they are — the app's rule that data with an age says its
 * age, in the voice `pricesAsOf` set and `OracleTagsDialog`'s `AS_OF` repeated one feed over.
 *
 * **It does not say "as of the last card-data sync".** Commander Spellbook's `variants.json.gz` is
 * a separate bulk download on a refresh interval of its own (`combos::REFRESH_INTERVAL_SECS`, a
 * week, against a file Spellbook rebuilds through the day) — so a card sync that finished this
 * morning says nothing whatever about how old these rows are. Blurring the two is the thing the
 * root `CLAUDE.md` asks in bold not to do, and a caption that names the wrong clock is worse than
 * one that names none.
 */
const AS_OF = "Combos come from Commander Spellbook, as of the last combo refresh.";

/** Where one combo lives on the web — Spellbook's own permalink, keyed on the variant id the feed
 *  publishes. Built here rather than in `lib/externalLinks.ts` because this dialog is its only
 *  caller; a second one is the moment it moves next to the three that live there. */
function spellbookComboUrl(id: string): string {
  return `https://commanderspellbook.com/combo/${encodeURIComponent(id)}/`;
}

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * `useCollection`'s `nextOffset` in this page's own shape — `CardCombosPage` counts `matching`
 * rather than `total`, because the count a pager has to walk is the count **after** the two
 * filters and not the census the chips are drawn from. The short-page rule is that one's, for its
 * reason: a page shorter than asked for ends the list whatever the count says, so a refresh
 * landing between two requests cannot leave this fetching the same empty page for ever.
 */
function nextComboOffset(pages: readonly CardCombosPage[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last || last.combos.length === 0) return undefined;
  const seen = pages.reduce((n, page) => n + page.combos.length, 0);
  return seen >= last.matching ? undefined : seen;
}

/**
 * The combos a card is in, over the card detail modal.
 *
 * **Self-mounting, and drawn as a sibling of the modal rather than inside it.** It takes no props
 * and reads `cardOverlay` and `selectedCardId` off the store, which is the shape its three rail
 * siblings already have and the one the card modal's panel forces: that panel is a
 * `@container/card` context, and a container box is the containing block for its `fixed`
 * descendants — so this dialog's `fixed inset-0` scrim rendered *inside* it would resolve against
 * the panel and cover the card modal and nothing else.
 *
 * `layer="stacked"` for the half of that hazard a container cannot fix. This opens **over**
 * another dialog, and at `LAYER.overlay` the two scrims would tie — two `fixed inset-0` boxes,
 * neither inside the other, in the root stacking context — with the winner decided by document
 * order. A rung is a claim about the highest thing a surface can be asked to cover.
 *
 * **Escape needs no code here.** `Dialog` registers its `"inner"` rung on the open flag, and this
 * one mounts after the card modal, so it lands above it on `useDismissOnEscape`'s capture stack
 * and takes the press.
 *
 * ## Why a combo is a surface at all
 *
 * A two-card infinite combo is a fact about an **interaction**, so no amount of reading either
 * card's own text finds one — which is why the deck bracket's fourth signal needed a feed of its
 * own, and why a reader looking at Boros Reckoner has no way to discover Boros Charm from the card
 * in front of them. This is that feed asked the other way round: not *what does this deck contain*
 * but *what is this card a piece of*.
 *
 * ## Three empties, and telling them apart is the point
 *
 * Spellbook's feed is optional in the tagger files' sense: a launch fetches it uninvited, a failed
 * fetch keeps whatever was stored, and a database that has never got it answers with three bracket
 * signals rather than four. An empty panel would read as "this card is in no combos", which is a
 * different claim and, on a first launch, a false one. So an empty answer says which of the three
 * it is — {@link NO_ORACLE_CARD}, {@link NEVER_FETCHED}, {@link NO_COMBOS} — and never draws an
 * empty box. {@link NO_MATCH} is a fourth and is about the reader's own filter.
 */
export function CombosDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Nothing here draws a price — but the marketplace is in `card_detail`'s **key**, because it is
  // in `card_detail`'s answer, and a key that left it out would open a second cache entry for a
  // card the modal behind this one has already fetched. See {@link cardDetailKey}.
  const { marketplace } = useMarketplace();

  const open = overlay === "combos" && cardId !== null;

  // **Gated on `open`**, which is what makes this component free to mount unconditionally at
  // `App` level: a dialog nobody has opened asks the backend nothing. `skipToken` rather than
  // `enabled`, so the closed state is *no query function at all* rather than a disabled one.
  const card = useQuery({
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  return (
    <Dialog
      open={open}
      // The heading says which *question* is open — which is what a reader choosing between the
      // rail's entries is picking — and the subtitle says which card it is being asked about.
      title="Combos"
      subtitle={card.data?.name}
      closeLabel="Close combos"
      size="w-[45rem]"
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      {/* Mounted only while it is open — `Dialog`'s own rule, and the whole of why the search box
          and the two chips below are `useState` rather than store fields: closing the dialog
          unmounts the body, so a reader who narrowed card A's combos to three-card ones with
          "altar" in the box opens card B on **All** with an empty box, without a single effect
          having to reset anything. */}
      <Body
        open={open}
        card={card.data ?? null}
        loading={card.isPending}
        oracleId={card.data?.oracleId ?? null}
      />
    </Dialog>
  );
}

/**
 * The panel's contents — the search box, the two chips, the page, and the five things that are not
 * a list.
 *
 * Split out from the shell for `LegalityDialog`'s reason (the states read as one list rather than
 * as conditions threaded through a `Dialog` call) and for one of its own: **the filters live
 * here**, and all three are in the query key, so both reads have to be here with them.
 */
function Body({
  open,
  card,
  loading,
  oracleId,
}: {
  open: boolean;
  card: CardDetail | null;
  loading: boolean;
  oracleId: string | null;
}) {
  /**
   * How many cards a combo is made of, or `null` for every size.
   *
   * **Sent to the backend rather than applied to the page in hand**, which is not an optimisation
   * — it is the only correct answer. A filter applied here would narrow the 25 rows this dialog
   * happens to be holding and call the result "3-card combos", which on a card with 6 044 of them
   * is a claim about 0.4 % of the list. The same goes for {@link ownedOnly}.
   */
  const [cardCount, setCardCount] = useState<number | null>(null);
  /** Only combos every piece of which the reader has a copy of. Also the backend's business. */
  const [ownedOnly, setOwnedOnly] = useState(false);

  /**
   * What is in the box, and what has been asked for — two states rather than one, and the split is
   * the debounce.
   *
   * {@link text} is the controlled value, so a keystroke is on screen in the same frame it was
   * typed and is never gated on a round trip; {@link asked} follows it {@link DEBOUNCE_MS} later
   * and is what the query is keyed on, so a five-letter word costs one request rather than five.
   * `useCardSearch`'s constant rather than a number of this dialog's own: how long a search box in
   * this app stays quiet is one question, and a box that answered it differently from the three
   * card searches would be a second answer to a settled one.
   */
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setAsked(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  /**
   * The term, or `null` for no search at all.
   *
   * **Trimmed here rather than at the backend**, so `"bolt "` and `"bolt"` are one query key and
   * one cache entry rather than two spellings of the same question. `""` collapses to `null` for
   * the same reason: the wire carries one shape for *no search*, and a key holding the empty
   * string would be a second one that had to answer identically for ever.
   */
  const search = asked.trim() === "" ? null : asked.trim();

  const combos = useInfiniteQuery({
    // **The search is in the key**, with the two filters and for their reason: it narrows in SQL
    // before the page is cut, so a searched answer is a different question rather than a subset of
    // the unsearched one — and a key that left it out would hold the old pages, and with them an
    // offset into a list that no longer exists.
    queryKey: cardCombosKey(oracleId ?? "", search, cardCount, ownedOnly),
    // **No call at all for a card with no oracle id**, which is the state {@link NO_ORACLE_CARD}
    // draws: the command matches on oracle id, so a null one has nothing to ask about and the
    // answer is known here without a round trip.
    queryFn:
      open && oracleId !== null
        ? ({ pageParam }) =>
            ipc.combosForCard({
              oracleId,
              search,
              cardCount,
              ownedOnly,
              limit: PAGE_SIZE,
              offset: pageParam,
            })
        : skipToken,
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextComboOffset(pages),
    // A narrowed filter keeps the previous page on screen rather than blanking the panel — the
    // shape every other filtered list in this app uses (`useCollection`, `useCardSearch`). Without
    // it the list would blink to *Reading the combos…* once per debounced keystroke, which is the
    // one thing a search box may not do to the list it is narrowing.
    //
    // **What it costs is one frame of a stale census**, and that is new: `byCardCount` and
    // `ownedTotal` follow the search now, so while a term is in flight the chips are still the
    // previous term's. The alternative is a chip row that empties and refills per keystroke, which
    // is worse — and the numbers a *chip press* moves are still none of them.
    placeholderData: keepPreviousData,
  });

  const status = useQuery<ComboStatus>({
    queryKey: COMBOS_STATUS_KEY,
    queryFn: open ? () => ipc.combosStatus() : skipToken,
  });

  const headingId = useId();

  /**
   * The census, off the first page.
   *
   * **The search changes the *subject*; the chips are facets of it.** So there are three sets in
   * one page and each of the four numbers names a different one: `total` is every combo naming
   * this card, filtered by nothing at all; `byCardCount` and `ownedTotal` are over the
   * **search-filtered** set; `matching` is over that set with the chips applied as well.
   *
   * What a reader sees follows from that and is the whole of the row's legibility: **the chip
   * counts move when they type and do not move when they press a chip.** A `3 cards · 60` chip
   * that read 60 until pressed and then 60-of-60 would be a control that changed its mind about
   * what it was counting — but the same chip reading 4 after a search has not changed its mind,
   * it has been asked about a different list.
   *
   * `total` is the one number no control here can move, which is why the empty branches below test
   * it rather than `matching`: a card with combos has a filter row whatever is typed into it, and
   * {@link NEVER_FETCHED} can never be reached by narrowing.
   */
  const page = combos.data?.pages[0] ?? null;
  const total = page?.total ?? 0;
  const matching = page?.matching ?? 0;
  const rows = combos.data?.pages.flatMap((p) => p.combos) ?? [];

  /**
   * The body proper, chosen once.
   *
   * **Every state is drawn inside the same frame below**, rather than each returning a shape of
   * its own: the scroller and the caption are properties of the *panel*, so a dialog that dropped
   * them for its empty states would change size and lose its as-of line exactly when a reader is
   * being told something about where the data came from.
   */
  const content =
    loading ? (
      <Note>Reading the card…</Note>
    ) : // `card_detail` answers `null` for an id `cards` has no row for, which is a real state
    // rather than a failure: a collection or a deck can hold a printing the corpus has dropped.
    card === null ? (
      <Note>This printing is no longer in the card database.</Note>
    ) : oracleId === null ? (
      <Note>{NO_ORACLE_CARD}</Note>
    ) : combos.isError ? (
      <p className="text-sm text-destructive">
        Could not read the combos — {ipcError(combos.error)}.
      </p>
    ) : // Both reads, not just the combo one: the sentence an empty answer gets is *decided* by
    // the status row, so drawing before it lands would flash whichever of the two claims the
    // default happened to be — and one of them is about the reader's database rather than about
    // their card.
    combos.isPending || status.isPending ? (
      <Note>Reading the combos…</Note>
    ) : total === 0 ? (
      // An unanswered status reads as never-fetched rather than as "no combos", and that is the
      // safe way round: `combos_status` reads one small table and makes no network call, so this
      // branch is all but unreachable — and of the two claims, "the file has not been downloaded"
      // is the one that stays true of a database nobody can read the status of.
      <Note>{(status.data?.fetchedAt ?? null) === null ? NEVER_FETCHED : NO_COMBOS}</Note>
    ) : (
      <>
        <SearchField value={text} onChange={setText} />
        <Filters
          page={page}
          cardCount={cardCount}
          ownedOnly={ownedOnly}
          onCardCount={setCardCount}
          onOwnedOnly={setOwnedOnly}
        />
        {matching === 0 ? (
          <Note className="mt-3">{NO_MATCH}</Note>
        ) : (
          <section aria-labelledby={headingId} className="mt-3 space-y-3">
            {/* One text node, and the count is in it: a `gap` is not a word separator to the
                accessible-name computation, so a label and its figure in two elements compute
                as one run-together token. This repo has been bitten by exactly that. */}
            <h3 id={headingId} className="text-xs uppercase tracking-wide text-dim">
              Showing {count(rows.length)} of {count(matching)}
            </h3>
            {/* The list keeps a name of its own, the more exact of the two: the heading says how
                much of the list is on screen, this says what the items in it are. */}
            <ul aria-label="Combos" className="space-y-4">
              {rows.map((combo) => (
                <ComboRow key={combo.id} combo={combo} />
              ))}
            </ul>
            {/* Drawn on `hasNextPage`, which is {@link nextComboOffset} — "fewer rows in hand
                than `matching`, and the last page was not short". Never on `rows.length <
                matching` alone: a page shorter than asked for means the list ended whatever the
                count says, and a button that went on asking would refetch the same empty page
                for ever. */}
            {combos.hasNextPage && (
              <button
                type="button"
                onClick={() => void combos.fetchNextPage()}
                aria-disabled={combos.isFetchingNextPage || undefined}
                className={cn(
                  "w-full rounded-md border border-border px-3 py-2 text-xs text-dim",
                  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                {combos.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            )}
          </section>
        )}
      </>
    );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{content}</div>
      {/* Outside the scroller: the caption is about the whole panel, so it must not scroll away
          from the thing it qualifies. */}
      <p className="border-t border-border px-4 py-3 text-xs text-dim">{AS_OF}</p>
    </>
  );
}

/**
 * The box that narrows *this* list — a case-insensitive substring against any piece's name, the
 * asked-about card included.
 *
 * **Named for the list rather than for the act.** The card modal is on screen behind this dialog
 * and the app is full of boxes that say `Search cards`, so a bare `Search` here is the control
 * lying about which list it narrows — `FilterBar`'s `labels` rule, at a surface that has to obey
 * it because the *other* box is a different component on a different layer. A `useId` stem rather
 * than a constant for the second half of the same rule: two mounted boxes sharing one `id` is a
 * `getByLabelText` that cannot tell them apart, and `Dialog` mounts and unmounts this one.
 *
 * **`clearFieldOnEscape` is deliberately absent, and the omission is not a gap.** This box is
 * inside a dialog, `Dialog` registers its `"inner"` rung in the **capture** phase, and the capture
 * stack acts before an element's own `keydown` — so the call would be a line that cannot execute.
 * Escape closes the combos, which is what a reader in a modal means by it. `src/CLAUDE.md` states
 * the exception at the rule's own site.
 *
 * **{@link FILTER_FIELD} and never `FILTER_CONTROL`** — the row's chips dip 3 % under a press and a
 * box the reader types into must not, or Chromium's own ✕ slides out from under the pointer and
 * the box bounces without clearing (issue #179; the measurement is on the constant, and
 * `motion.test.ts` sweeps for the class). It is also where the finger's 44px floor comes from,
 * with no number spelled a second time here.
 */
function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        Search these combos
      </label>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search these combos by piece…"
        className={cn(
          FILTER_FIELD,
          FOCUS,
          // Full width, because this is the panel's own row rather than one control in a wrapping
          // filter bar — there is nothing beside it to leave room for.
          "w-full min-w-0 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />
    </div>
  );
}

/**
 * The two filters — a chip per combo size, and a toggle for the ones the reader can build today.
 *
 * **A chip is drawn only for a size the backend has combos for.** `byCardCount` is the census, so
 * a bucket that is not in it is a size that does not exist for this card — and inventing a `5+`
 * chip would send the backend a `cardCount` it reads as an exact size and get an empty list back.
 * A bucket that somehow arrives at zero is dropped for the same reason: a chip that can only ever
 * empty the list is a control that lies.
 *
 * **The census these are drawn from is the searched one, and the one exception to the sentence
 * above is what the search made necessary.** A reader can narrow to `3 cards` and then type a term
 * no three-card combo matches, at which point the size the query is still carrying has no bucket —
 * so the chip that is emptying the list would vanish from the row and take the way back with it,
 * leaving *No combo matches that filter* over a row of controls none of which is on. So a **pressed**
 * size keeps its chip at `· 0`. That is not the control that lies: it is the one that is doing the
 * emptying, said out loud, and pressing it again is the way out.
 */
function Filters({
  page,
  cardCount,
  ownedOnly,
  onCardCount,
  onOwnedOnly,
}: {
  page: CardCombosPage | null;
  cardCount: number | null;
  ownedOnly: boolean;
  onCardCount: (cards: number | null) => void;
  onOwnedOnly: (only: boolean) => void;
}) {
  const census = page?.byCardCount ?? [];
  const buckets = census
    .filter((bucket) => bucket.combos > 0)
    // The pressed size, kept even where the search left it no bucket — see the header. Appended
    // before the sort, so it lands in size order like any other chip.
    .concat(
      cardCount !== null && !census.some((bucket) => bucket.cards === cardCount)
        ? [{ cards: cardCount, combos: 0 }]
        : [],
    )
    // Ascending, and sorted here rather than trusted: the display order of a filter row is this
    // file's decision, it costs one pass over at most a handful of buckets, and a row whose chips
    // moved with the backend's `GROUP BY` would reorder under the reader for no reason they could
    // see.
    .sort((a, b) => a.cards - b.cards);

  return (
    // `flex-wrap`, because the narrowest surface that draws a row of chips decides its height —
    // this panel is `w-[45rem]` above the phone fold and the whole glass below it, and an unwrapped
    // row just hangs out of the panel and turns into a horizontal scrollbar.
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ToggleChip
        // **Summed from `byCardCount` rather than read off `total`, and that is the whole of what
        // makes this chip agree with the ones beside it.** `total` is the census *before* the
        // search, so on a searched list it would read six thousand over a row of chips adding up
        // to four — the `All` chip claiming to be a wider set than the union of its own parts.
        // There is no field for this number and there must not be: a figure that has to equal a
        // sum is a figure with two sources to drift between.
        label={`All · ${count(census.reduce((n, bucket) => n + bucket.combos, 0))}`}
        pressed={cardCount === null}
        onClick={() => onCardCount(null)}
      />
      {buckets.map((bucket) => (
        <ToggleChip
          key={bucket.cards}
          // `2 cards · 40` in **one** string, which is the whole of why this is a `label` rather
          // than two spans in a chip of its own: `ToggleChip` renders it as a single text node, so
          // the accessible name is what is written on the control. Two elements with a `gap`
          // between them compute to `2 cards40`.
          label={`${plural(bucket.cards, "card")} · ${count(bucket.combos)}`}
          pressed={cardCount === bucket.cards}
          // Pressing the chip that is already on goes back to All — the row has no "off" state of
          // its own, and a reader who narrowed by mistake should not have to find the other chip.
          onClick={() => onCardCount(cardCount === bucket.cards ? null : bucket.cards)}
        />
      ))}
      <ToggleChip
        // `ownedTotal` is over the searched set too, so this figure and the sizes beside it are
        // counts of one list and can be read against each other. It is still answered whether or
        // not the toggle is on, which is what lets it say what pressing it would leave.
        label={`I own every piece · ${count(page?.ownedTotal ?? 0)}`}
        pressed={ownedOnly}
        onClick={() => onOwnedOnly(!ownedOnly)}
      />
    </div>
  );
}

/**
 * What one row's header is called, built rather than left to fall out of the layout.
 *
 * **A `gap` is not a word separator to the accessible-name computation.** Left to compute itself
 * from its children the header would read `Boros ReckonerOwned+Boros CharmNot ownedS · Spicy —
 * probably 3 or 4…` — every caption, count and ownership mark in the pieces run together, because
 * the accname spec concatenates text nodes and the *spaces* on this row are flex gaps. This repo
 * has been bitten by exactly that with a label and its count computing as `Missing2`.
 *
 * So the button carries this string as its `aria-label`, which also makes its children
 * presentational — which is right rather than a side effect: a disclosure's name is the thing it
 * opens, and the thing it opens is *this combo*, not the four facts printed under each picture.
 * The pieces and the letter are what the reader sees and what this says, in that order.
 */
function comboLabel(combo: CardCombo): string {
  const tag = COMBO_TAG[combo.bracketTag];
  const pieces = combo.pieces.map((piece) => piece.name).join(" + ");
  return `${pieces} — ${combo.bracketTag} ${tag.name}`;
}

/**
 * One combo, collapsed: what it is made of and what its letter means, with everything else one
 * press away.
 *
 * **Every row draws its header and nothing else until it is opened, and the reason is what driving
 * the shipped window found.** Expanded, a row is the pieces, the bracket line, `produces`, both
 * prerequisite blocks, the numbered steps, the mana, the template caveat and the Spellbook link —
 * most of a screen — so twenty-five of them read as a wall rather than as a list. What a reader is
 * doing in this dialog is *scanning*: which cards, and how strong. That is the header, and it is
 * the whole header.
 *
 * **Closed is nothing mounted**, which is `Dialog`'s own rule one surface down rather than a
 * performance note: the body is `{open && …}` and not a class that hides it, so a page of
 * twenty-five costs twenty-five headers — and a `Section` that would have drawn nothing anyway
 * does not have to be reasoned about at all. It also keeps the collapsed row honest for a test and
 * for a find-in-page: text that is not on screen is not in the document either.
 *
 * The disclosure is `DeckBracket`'s *What this read* — a real `<button aria-expanded>` with a
 * `ChevronRight` that takes `rotate-90`, and **never** `<details>`/`<summary>`, whose open state
 * the browser owns and whose styling and animation this app would then be arguing with.
 *
 * Everything in the body is optional and most of it is usually absent — `produces`, `description`,
 * both prerequisite fields and `manaNeeded` all arrive `""` very often — so every one of them goes
 * through {@link Section}, which draws **nothing** rather than an empty heading. That rule is
 * structural here rather than repeated five times, because five call sites each remembering to
 * check a string is five chances to ship a heading with nothing under it.
 */
function ComboRow({ combo }: { combo: CardCombo }) {
  const tag = COMBO_TAG[combo.bracketTag];
  /**
   * Open, per row and per mount.
   *
   * Local rather than lifted, and that is what makes *collapsed by default, every time the list
   * changes* free: a row is keyed on the combo id, so a search, a chip or a **Show more** hands
   * React a different set of children and every row that arrives arrives closed, with no effect
   * anywhere having to reset anything. It is `Body`'s own argument for `useState` over a store
   * field, one level further in.
   */
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-lg border border-border">
      {/* **The header *is* the toggle** — the whole of what a collapsed row shows is what opens
          it, so there is no separate affordance to find. Nothing interactive may go inside it: a
          button inside a button is invalid, and the Spellbook link is in the body for that reason
          as much as for its own. The pieces are a row of spans rather than the `<ul aria-label>`
          they used to be, because a list inside a button is neither valid content nor a list any
          more — a button's descendants are presentational, so the markup would promise a structure
          the accessibility tree has already flattened. {@link comboLabel} is what says them. */}
      <button
        type="button"
        aria-expanded={open}
        aria-label={comboLabel(combo)}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2 rounded-lg p-3 text-left",
          "transition-colors duration-150 hover:bg-surface motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <ChevronRight
          className={cn(
            "mt-0.5 size-3 shrink-0 text-dim",
            "transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          {/* The pieces are the headline: a combo is a *set of cards*, and the shape a reader
              already knows from every combo list they have read is the names joined by a plus. The
              art is what makes that shape scannable in a list of twenty-five — and it is why the
              header keeps the pictures rather than shrinking to a line of names. */}
          <span className="flex flex-wrap items-start gap-2">
            {combo.pieces.map((piece, i) => (
              <span key={`${piece.oracleId}:${i}`} className="flex items-start gap-2">
                {i > 0 && (
                  // The offset puts it against the middle of the art rather than its top: a `w-24`
                  // frame is 5:7, so 96 × 7/5 = 134px tall, and half of that less half a text line
                  // is ~60px. Derived rather than measured — the pieces row has not been driven in
                  // the shipped window, and a live pass is what would settle it.
                  <span className="mt-[3.75rem] text-dim">+</span>
                )}
                {/* **Ownership stays in the header**, unlike everything else that was under the
                    pieces. The whole reason to filter on *I own every piece* is to find the combo
                    you could assemble tonight, so a reader scanning a collapsed list has to be
                    able to see which pieces they are missing without opening anything. */}
                <Piece piece={piece} />
              </span>
            ))}
          </span>

          {/* Spellbook's own classification, in Spellbook's own words — `COMBO_TAG` imported from
              the deck bracket rather than spelled a second time here, because a letter described
              two ways in one app is a letter the reader cannot trust either drawing of. The
              **letter** leads because it is what the feed publishes and what Spellbook's own site
              prints; the sentence after it is what the letter means, and both are one text node so
              the two cannot be read apart. It is in the header rather than the body because *how
              strong is this* is half of what a reader is scanning for. */}
          <span className="mt-2 block text-xs text-dim">
            {combo.bracketTag} · {tag.name} — {tag.forces}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          <Section title="Produces" lines={splitLines(combo.produces)} />
          <Section title="Prerequisites" lines={splitLines(combo.easyPrerequisites)} />
          <Section title="Notable prerequisites" lines={splitLines(combo.notablePrerequisites)} />
          {combo.manaNeeded !== "" && (
            <div className="mt-2 first:mt-0">
              <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">Mana needed</h4>
              {/* The symbols, not the braces — the direction doc's rule, and `ManaText` carries the
                  `sr-only` token beside each glyph so `{2}` is still spoken. */}
              <ManaText source={combo.manaNeeded} className="mt-0.5 text-sm" />
            </div>
          )}
          <Section title="Steps" lines={splitLines(combo.description)} ordered />

          {/* **Their own sentence, and everything about it says *not the whole combo*.** A
              `requires[]` template — "a creature with flying", "a mana outlet" — is not a card id
              and can be resolved against no card list at all, so a row that listed its named pieces
              and stopped would be this app implying a two-card combo where the feed says three
              things are needed. `DeckBracket`'s "Possible, and not counted" block is the same
              sentence one surface over. */}
          {combo.templateCount > 0 && (
            <p className="mt-2 text-xs leading-snug text-dim first:mt-0">
              Also needs {plural(combo.templateCount, "piece")} no card list can name — a creature
              with flying, a way to sacrifice — so the cards above are not the whole combo.
            </p>
          )}

          {/* `openExternal` is the app's single call that leaves it, and it is made **on the
              press**. Never a raw `window.open`, which in a Tauri webview navigates the app's own
              window — the rule `CardModalRail` states at its own site.

              In the body rather than the header, which is the accordion's own constraint agreeing
              with the one this link already had: a link nested inside the disclosure button would
              be a control inside a control, and a press on it would toggle the row it left. */}
          <button
            type="button"
            onClick={() => void openExternal(spellbookComboUrl(combo.id))}
            className={cn(
              "mt-2 rounded-md text-xs text-dim first:mt-0",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            View on Commander Spellbook
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * One card of a combo — its picture, its name, and whether the reader has it.
 *
 * **Ownership is a word and never only a colour.** A green frame would say nothing to the readers
 * this rule exists for, and this is the surface where it matters most: the whole reason to filter
 * on *I own every piece* is to find the combo you could assemble tonight.
 */
function Piece({ piece }: { piece: ComboPiece }) {
  return (
    <span className="flex w-24 flex-col gap-1">
      <CardArt
        cardId={piece.cardId}
        name={piece.name}
        // **The protocol URL is computed here and passed in**, which is `lib/images.ts`'s rule and
        // load-bearing rather than a style: `.storybook/main.ts` aliases `@/lib/images` to a fake
        // whose whole job is to replace `cardImageUrl` with generated art, and a call made *inside*
        // that module would reach the real function and paint every story a broken image.
        //
        // `cardId === null` is a card this corpus has never synced — the feed names cards the
        // reader's database may simply not have — and `CardArt` draws its named, empty frame for
        // it, which is this app's existing "no art" state rather than an error.
        imageUrl={piece.imageUris?.[WALL_CARD_VARIANT] ?? null}
      />
      <span className="text-xs leading-snug">{piece.name}</span>
      {/* A count laid **beside** a card keeps its `×` — `CountTag`'s bare number is for a count
          laid *on* one, where the tag it is printed on says what is being counted. */}
      {piece.quantity > 1 && <span className="text-[0.6875rem] text-dim">×{piece.quantity}</span>}
      {piece.mustBeCommander && (
        <span className="text-[0.6875rem] text-dim">Must be your commander</span>
      )}
      <span
        className={cn("text-[0.6875rem]", piece.owned >= piece.quantity ? "text-ok" : "text-dim")}
      >
        {ownedNote(piece.owned, piece.quantity)}
      </span>
    </span>
  );
}

/**
 * What the reader has of one piece, in words.
 *
 * `0` is an answer rather than a gap, and it is the answer this surface is most often about. The
 * partial case is spelled out because "Owned" over one copy of a combo that wants two would be
 * wrong in the direction that costs the reader a game.
 */
function ownedNote(owned: number, quantity: number): string {
  if (owned === 0) return "Not owned";
  if (owned >= quantity) return "Owned";
  return `${owned} of ${quantity} owned`;
}

/**
 * A `'\n'`-joined feed field, as lines.
 *
 * Blank entries are dropped rather than drawn: a trailing newline is a wire artefact and an empty
 * `<li>` is a bullet with nothing beside it. An all-blank field therefore comes back `[]`, which
 * is what {@link Section} tests — so "the field was empty" and "the field was three newlines" draw
 * the same nothing.
 */
function splitLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * A titled block of lines, or nothing at all.
 *
 * **The empty case is the whole reason this exists.** Four of the five fields it draws are `""`
 * on a large share of the feed's rows, and a heading with nothing under it reads as content that
 * failed to load — which on a surface whose *other* empty states are carefully distinguished
 * sentences would be the one place the panel said something it did not mean.
 */
function Section({
  title,
  lines,
  ordered = false,
}: {
  title: string;
  lines: string[];
  /** Numbered, for `description` — Spellbook's steps are a sequence and reading them out of order
   *  is reading a different combo. Everything else is a set. */
  ordered?: boolean;
}) {
  if (lines.length === 0) return null;
  // Written out twice rather than picking the tag with a variable: `<List>` over a `"ol" | "ul"`
  // union is a JSX element type TypeScript resolves to the intersection of the two elements'
  // props, and the numbering is the whole difference between the two anyway.
  const items = lines.map((line, i) => <li key={i}>{line}</li>);
  return (
    // `first:mt-0`, because which of these is first is the *feed's* decision: a combo whose only
    // filled field is `description` opens on its steps, and a body whose first block carried the
    // gap meant for a block above it would sit 8px low for that row alone.
    <div className="mt-2 first:mt-0">
      <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">{title}</h4>
      {ordered ? (
        <ol
          aria-label={title}
          className="mt-0.5 list-decimal space-y-0.5 pl-5 text-sm leading-snug marker:text-dim"
        >
          {items}
        </ol>
      ) : (
        <ul aria-label={title} className="mt-0.5 space-y-0.5 text-sm leading-snug">
          {items}
        </ul>
      )}
    </div>
  );
}

/**
 * One dim sentence in the body — every state that is not a list of combos.
 *
 * **One text node, and that is load-bearing rather than tidy.** Testing Library reads an element's
 * *own* text children, so a sentence broken by a `<span>` becomes unfindable by anything that
 * queries it as a sentence — which is how a reader reads it, and how the test for it is written.
 * `OracleTagsDialog`'s `Note` and `LegalityDialog`'s two captions say the same thing at their own
 * sites; this is the third.
 */
function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-relaxed text-dim", className)}>{children}</p>;
}
