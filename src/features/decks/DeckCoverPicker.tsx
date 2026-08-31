import { useEffect, useMemo, useState, type JSX } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CardImage } from "@/components/CardImage";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { count } from "@/lib/counts";
import { FOCUS_INSET } from "@/lib/focus";
import { ART_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardSummary, type DeckCard } from "@/lib/ipc";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { CAPTION, FIELD } from "./formFields";

/**
 * How many printings one search offers.
 *
 * `PAGE_SIZE` from `useCardSearch`, written out rather than imported, because it means
 * something different here: there it is one screenful of a pager that goes on asking for more,
 * and here it is **the whole answer** — a cover picker is a picker, not a browse, and a reader
 * who cannot see their card in fifty tiles wants a narrower word rather than a scrollbar. What
 * the two share is the backend's clamp (200) and nothing else, so they are free to drift.
 */
const COVER_SEARCH_LIMIT = 50;

/**
 * The grid both sources are drawn in — written once, because two lists that must look identical
 * will not.
 *
 * Every printing rather than the first eight: a reader looking for one particular card's art
 * should not have to reorder the deck to reach it. Four columns and a scroller, so the list
 * cannot push the fields beside it off screen — which is also what keeps a fifty-tile search
 * answer from being taller than the panel it is in.
 */
const CHOICE_GRID = "grid max-h-52 grid-cols-4 gap-1.5 overflow-y-auto";

export interface DeckCoverPickerProps {
  /** What the preview draws, and what a tile marks as current. `null` before a deck has one. */
  coverCardId: string | null;
  /** Credited under the preview. `null` draws no line — never the word "null". */
  coverArtist: string | null;
  /**
   * Where the cover printing's `art` crop is on `cards.scryfall.io` — **the web build's only
   * way to draw the preview**, and ignored on desktop, where `cardArtSrc` prefers the local
   * cache. Absent or `null` is "no picture", never a URL to build one from.
   *
   * A prop rather than a lookup of this component's own, because the two hosts know it from two
   * places: the settings dialog has the deck's own `DeckRow.imageUris`, and the create dialog —
   * which has no deck yet — reads the `CardDetail` it already fetches for the credit line. The
   * tiles below take theirs the same way, off whichever row the reader is picking from.
   */
  coverImageUrl?: string | null;
  /** The deck's own printings, offered when the search box is empty. `[]` at create. */
  deckCards: readonly DeckCard[];
  onPickCard: (cardId: string) => void;
  /** Namespace for this instance's element ids — two of these on one page is two pickers. */
  idPrefix: string;
}

/**
 * The picture, the choices, and the credit the choices' own frames cannot carry.
 *
 * **Presentational, and it writes nothing.** One command sets a cover —
 * `deckUpdate({ coverCardId })`, which points the deck at a printing's art crop — and *when* it
 * runs belongs to the host: this component answers {@link DeckCoverPickerProps.onPickCard} and
 * knows nothing about the command behind it, which is what lets the settings dialog write on
 * the press while the create dialog folds the id into its draft and sends one `deck_create`.
 *
 * **There was a second command and a second control, and both are gone.** A cover could also be
 * a picture the reader chose off disk — `deck_set_cover_image` took a *path*, the backend
 * re-encoded it beside the database and set `cover_kind` to `custom`, and this picker carried an
 * `Upload an image…` button, a `PendingFile` frame for the create dialog's no-deck-id case and
 * an `onPickFile` callback beside `onPickCard`. It was deleted whole rather than ported to the
 * web and Android builds, because the file **never survived a sync** (the stored path was
 * absolute, so a phone was handed `D:\…\covers\7.webp`) and every device but the one that set it
 * already drew the card art instead. A cover is a card id now — a short string that syncs, that
 * is identical on all three targets, and that needs no encoder, no directory and no URL scheme.
 * So the grid below is not one of two ways in any more; it is the picker.
 *
 * ## Two sources for one grid
 *
 * An empty search box offers **the deck's own printings** ({@link coverChoices}); a query
 * offers **every printing in the database**. The second exists because the first has nothing to
 * offer at create: a deck being made has no cards, and "Pick art from cards in this deck" in
 * front of an empty grid is a control that cannot be used at the one moment a cover is most
 * worth choosing.
 *
 * The query is **disabled while the box is empty**, unlike `useCardSearch`'s, whose empty box
 * is deliberately a browse of the whole database. Here an empty box already has an answer — the
 * deck's own cards — so asking the backend for a second one would be a round trip whose result
 * is never drawn.
 *
 * ## The art credit, and the gap this instance inherits
 *
 * The rule is absolute and lives in **`src/CLAUDE.md`'s binding rules**, in full in
 * **`docs/reference/frontend-design.md`**: an `art` crop has no printed frame, so wherever one
 * is shown the illustrator must be credited (Scryfall's image policy). The **preview** below
 * obeys it strictly — it draws `Art by {coverArtist}` and refuses to draw a crop whose artist is
 * unknown, which is {@link DeckRow.coverArtist}'s own ruling and the same refusal `DecksPage`'s
 * gallery tile makes. Since a cover can only be a crop now, "no artist" and "no picture" are one
 * condition here rather than two that had to be kept in step across two kinds of cover.
 *
 * **The tiles do not, and the search tiles are a fifth instance of a gap recorded rather than
 * quietly inherited.** {@link ChoiceTile}'s doc has the whole argument for the four that came
 * before — `CardStack`, `views/GridView`, `TheoryDiffDialog` and the in-deck tiles here — and it
 * covers a search result for the same two reasons plus one of its own: `CardSummary` carries no
 * `artist` field (`src/lib/ipc.ts`, and `search.rs`'s SELECT does not select one), and widening
 * the search command for a picker's thumbnails would put a column on every result row in the app
 * to credit a crop that sits inside a control naming its card. It is repeated here rather than
 * left to be read next door because **an undocumented instance of a known gap is how a known gap
 * becomes an unknown one**.
 */
export function DeckCoverPicker({
  coverCardId,
  coverArtist,
  coverImageUrl,
  deckCards,
  onPickCard,
  idPrefix,
}: DeckCoverPickerProps): JSX.Element {
  const tip = useTooltip();
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  // 300 ms, and `DEBOUNCE_MS` rather than a literal: this box is a card search like the other
  // three in the app (the search view, the collection, the wishlist), and a picker that felt
  // different from them would be a second answer to a question already settled.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const query = debounced.trim();
  const searching = query !== "";

  const search = useQuery({
    // Under `["cards","search", …]` with every other card search, so a sync that invalidates
    // the card data clears this too. The third segment names *this* search: the view's key is
    // a dozen filters long and these two must never answer each other from cache.
    queryKey: ["cards", "search", "deck-cover", query],
    queryFn: () =>
      ipc.searchCards({
        text: query,
        // **`collapse: false`.** Collapsing folds every printing of a card into one row, and
        // different printings are *different art* — which is the entire choice being made here.
        // The search view collapses because "which cards exist" is what a search box is asked;
        // a cover picker asks "which pictures exist", and they are not the same question.
        collapse: false,
        // **`playableOnly: false`.** Art series, tokens and emblems are some of the best crops
        // in Magic, and a cover is not a card you cast — the reason the search view hides them
        // (a legal-in-nothing printing above the card you searched for) does not apply to a
        // picker whose whole subject is the picture. Absent would mean the same thing; it is
        // written out because this is a decision rather than a default nobody thought about.
        playableOnly: false,
        // One page and no pager. See {@link COVER_SEARCH_LIMIT}.
        limit: COVER_SEARCH_LIMIT,
        offset: 0,
        // **No `marketplace`, and that is the one price rule not being broken.** Every
        // price-bearing query carries one and has it in its key — this one draws no money at
        // all, so there is nothing for a marketplace to decide and nothing for a switch to
        // refetch. Adding it would put a second copy of every search in the cache per feed.
      }),
    enabled: searching,
    // Keeps the tiles on screen while the next keystroke's answer is in flight, so the grid
    // does not blank between words.
    placeholderData: keepPreviousData,
  });

  const results = search.data?.items ?? [];
  // Gated on `searching` as well as on the query: a disabled query keeps whatever status it
  // last had, so a refusal the reader answered by clearing the box would otherwise leave its
  // red sentence over the deck's own cards, which is a list that never failed to load.
  const searchFailure = searching && search.isError ? ipcError(search.error) : null;
  const choices = useMemo(() => coverChoices(deckCards), [deckCards]);
  const headingId = `${idPrefix}-choices`;
  const searchId = `${idPrefix}-cover-search`;

  return (
    <div className="space-y-3.5">
      <div>
        <p className={cn(CAPTION, "mb-1.5")}>Deck picture</p>
        <CoverPreview
          coverCardId={coverCardId}
          coverArtist={coverArtist}
          coverImageUrl={coverImageUrl}
        />
        {/* Scryfall's image policy, and the gallery tile's ruling verbatim: an `art` crop has
            no printed frame, so the illustrator is credited wherever one is shown — and a cover
            whose artist is unknown draws no line at all rather than the word "null". The
            condition is the preview's own, so the credit and the picture appear together or
            not at all; while a deck could also wear a file there was a second test beside this
            one, and the two had to agree about which picture was on screen. */}
        {coverArtist !== null && (
          <p
            className="mt-1.5 truncate text-[0.6875rem] text-dim"
            {...tip(coverArtist, { whenClipped: true })}
          >
            Art by {coverArtist}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={searchId} className={cn(CAPTION, "mb-1.5")}>
          Search every card
        </label>
        <input
          id={searchId}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          // **Enter here means "I have finished typing a card name" and never "make the
          // deck".** Stated rather than inherited: this box shares a panel with a Name field
          // whose Enter *is* a submission (`DeckSettingsForm.onSubmit`), and nothing about that
          // arrangement is guaranteed by the markup — a host that wrapped the panel in a
          // `<form>` would get implicit submission from every single-line input in it,
          // including this one, mid-word. `preventDefault` is exactly what stops that, and it
          // costs nothing today: the query is the debounce's, so there is no "search now" for
          // the key to have meant.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="Name or type line…"
          className={cn(FIELD, "mb-2 h-8 placeholder:text-dim")}
        />

        {/* One heading over one grid, saying which of the two sources is under it. The in-deck
            wording is unchanged from the settings dialog's, because it is also this list's
            accessible name and a reader who knew it should still find it. */}
        <p id={headingId} className={cn(CAPTION, "mb-1.5")}>
          {searching ? "Pick art from any card" : "Pick art from cards in this deck"}
        </p>

        {/* A search that failed says so, above whatever is still on screen. Silence here would
            be indistinguishable from a word nothing matches, and the two want opposite things
            of the reader. */}
        {searchFailure !== null && (
          <p role="alert" className="mb-1.5 text-xs text-destructive">
            Could not search the cards — {searchFailure}
          </p>
        )}

        {searching ? (
          <SearchResults
            headingId={headingId}
            query={query}
            results={results}
            total={search.data?.total ?? 0}
            capped={search.data?.totalIsCapped ?? false}
            loading={search.isFetching && results.length === 0}
            failed={searchFailure !== null}
            coverCardId={coverCardId}
            onPickCard={onPickCard}
          />
        ) : choices.length === 0 ? (
          <p className="text-xs text-dim">
            Nothing to pick from yet — a card in the deck is a cover this deck can wear.
          </p>
        ) : (
          <ul aria-labelledby={headingId} className={CHOICE_GRID}>
            {choices.map((card) => (
              <li key={card.cardId}>
                <ChoiceTile
                  cardId={card.cardId}
                  name={card.name}
                  artUrl={card.imageUris?.art}
                  current={coverCardId === card.cardId}
                  onPick={() => onPickCard(card.cardId)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The other half of the one grid: every printing the database has for what was typed.
 *
 * Its own component so the four states a round trip has — in flight, nothing matched, more
 * matched than fit, and the tiles themselves — are four branches side by side rather than four
 * conditions threaded through the picker's body.
 */
function SearchResults({
  headingId,
  query,
  results,
  total,
  capped,
  loading,
  failed,
  coverCardId,
  onPickCard,
}: {
  headingId: string;
  query: string;
  /** Printings, never cards: the request is uncollapsed, so two rows can be one card's two
   *  pictures — which is the whole point of asking that way. */
  results: readonly CardSummary[];
  total: number;
  capped: boolean;
  loading: boolean;
  /** The failure is already said above this; all this branch owes is not to claim a miss. */
  failed: boolean;
  coverCardId: string | null;
  onPickCard: (cardId: string) => void;
}) {
  if (results.length === 0) {
    if (failed) return null;
    return (
      <p className="text-xs text-dim">{loading ? "Searching…" : `No card matches “${query}”.`}</p>
    );
  }

  return (
    <>
      <ul aria-labelledby={headingId} className={CHOICE_GRID}>
        {results.map((row) => (
          <li key={row.id}>
            <ChoiceTile
              cardId={row.id}
              name={row.name}
              artUrl={row.imageUris?.art}
              current={coverCardId === row.id}
              onPick={() => onPickCard(row.id)}
            />
          </li>
        ))}
      </ul>
      {/* Said only when it is true, and it usually is not: fifty tiles cover most words. The
          `+` is the backend counting no further than 5 000 — a floor, which is true, rather
          than a figure, which would not be. */}
      {total > results.length && (
        <p className="mt-1 text-[0.6875rem] text-dim">
          Showing {results.length} of {count(total)}
          {capped ? "+" : ""} matches — a narrower word reaches the rest.
        </p>
      )}
    </>
  );
}

/**
 * The cover as the gallery would draw it: the card's `art` crop.
 *
 * **One arm, and it used to be two.** `DeckCoverKind` decided between this crop and a file the
 * reader had uploaded, and a deck carried both at once because setting either left the other
 * alone — so the column was the only answer to which one was showing. The file half is deleted,
 * so a cover is a card id and this draws it or says there is none.
 */
function CoverPreview({
  coverCardId,
  coverArtist,
  coverImageUrl,
}: {
  coverCardId: string | null;
  coverArtist: string | null;
  coverImageUrl?: string | null;
}) {
  // The credit is the condition, not a line drawn beside one: an `art` crop with no printed
  // frame may be shown only where the illustrator is named, so a cover this app cannot credit
  // is a cover it does not draw. `DecksPage`'s gallery tile makes the same refusal.
  //
  // Whether it is *drawable* is a second question and `cardArtSrc` is the whole of it: on
  // desktop the protocol URL, on web the row's own URL and `null` when the row has none, since
  // wasm cannot register a URL scheme with a browser. Kept apart from `chosen` below so the
  // frame's three words stay true on both builds — `DeckTile.hasCover` makes the same split for
  // the same reason.
  const chosen = coverCardId !== null && coverArtist !== null;
  const url = chosen ? cardArtSrc(cardImageUrl(coverCardId, 0, "art"), coverImageUrl) : null;
  const image = useImageRetry(url);

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src !== null ? (
        <CardImage
          // Decorative: the deck's name is a field on the other half of this dialog, and the
          // credit line underneath already says whose picture it is.
          alt=""
          src={image.src}
          // No `key` of this component's own: `CardImage` keys itself on the `src`, which is
          // the whole answer for a card cover, because a different printing is a different URL.
          // The custom arm needed one — its route named the *deck*, so nothing keyed on the URL
          // could notice a replaced file, and the host passed the deck's `updatedAt` — and that
          // is the second thing the deletion took away.
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      ) : (
        // Three different things, said as three: no cover chosen, art on the way back, art that
        // did not arrive. The fourth case hides inside the first — a card cover whose artist
        // this app does not know is not drawn at all, and an orphaned cover heals on the next
        // sync — which is why this says "No cover" rather than claiming a failure.
        <span aria-hidden="true" className="text-xs text-dim">
          {!chosen ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * One printing offered as a cover.
 *
 * The `art` crop, at the shape a cover is: this is a picture of what pressing it would do, and
 * a 5:7 card face here would be a preview of a different picture.
 *
 * **Takes pieces rather than a row**, because the two sources it is drawn from are two types —
 * a {@link DeckCard} from the deck and a `CardSummary` from the search — and they agree about
 * exactly the three fields below. Narrowing to them is also what keeps the tile from acquiring
 * an opinion about which list it is in. (It was two fields until 2026-08-31; `imageUris` is the
 * third, and it is on both types for the same reason it is on the tile.)
 *
 * **A known gap against the art-credit rule, recorded here rather than quietly inherited.**
 * The rule is absolute — an `art` crop has no printed frame, so wherever one is shown the
 * illustrator must be credited — and it lives in **`src/CLAUDE.md`'s binding rules**, in full in
 * **`docs/reference/frontend-design.md`**, and on
 * {@link DeckRow.coverArtist}'s own doc, with the original statement in
 * `docs/superpowers/plans/2026-08-04-02-images-card-browsing.md`. These tiles do not credit
 * one. Nor do `CardStack` (the stacked card), `views/GridView` (the wall tile) or
 * `TheoryDiffDialog` (the diff row), which draw the same crop everywhere else in the editor;
 * this follows those three deliberately, because a picker that was stricter than the views it
 * picks *from* would be an inconsistency a reader could see, where this one is one only a
 * lawyer can. What holds it together is that each crop sits inside a control that **names the
 * card**, so the illustrator is one press away in the card pane, which does credit them.
 *
 * The way to close it for all four at once is a per-row `artist`, which neither `DeckCard` nor
 * `CardSummary` carries; the alternative here alone is the `grid` variant, whose printed frame
 * carries the credit, at the cost of the cover-shaped tile. The **cover preview** above is
 * strict either way: an unknown artist is not drawn at all, which is `DeckRow.coverArtist`'s own
 * ruling, and `DecksPage`'s gallery tile makes the same refusal.
 */
function ChoiceTile({
  cardId,
  name,
  artUrl,
  current,
  onPick,
}: {
  cardId: string;
  name: string;
  /**
   * The `art` crop's URL on `cards.scryfall.io`, off whichever row this tile was drawn from —
   * `DeckCard.imageUris` for the deck's own printings, `CardSummary.imageUris` for a search
   * answer. **The web build's only picture**, ignored on desktop by `cardArtSrc`, and `null`
   * for a row that carries none — which draws the empty, bordered tile below rather than a
   * broken `<img>`. The tile still names its card, so it is still pickable.
   *
   * It is the third field the two sources agree about, which is why the tile can go on taking
   * pieces rather than a row.
   */
  artUrl?: string | null;
  current: boolean;
  onPick: () => void;
}) {
  const image = useImageRetry(cardArtSrc(cardImageUrl(cardId, 0, "art"), artUrl));
  const tip = useTooltip();

  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={current}
      // The name is the whole accessible name: the picture is `alt=""` because it is the very
      // thing being chosen and "Shivan Dragon" twice is not more information.
      aria-label={name}
      {...tip(name, { describes: false })}
      className={cn(
        "block w-full overflow-hidden rounded-md border bg-surface",
        "transition-colors duration-150 motion-reduce:transition-none",
        current ? "border-accent" : "border-border hover:border-accent",
        // The button *is* the tile and the tile clips its own corners, so an outline standing
        // off its edge is painted entirely in the clipped region and is never seen.
        FOCUS_INSET,
      )}
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src !== null && (
        <CardImage
          alt=""
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </button>
  );
}

/**
 * Every printing in the deck, once each, commanders first.
 *
 * **Commanders first because a commander deck's cover is almost always its commander** — and
 * `categoryKind` is what answers that, not the category's name, which the reader may have
 * renamed to anything. `Array.prototype.sort` is stable, so everything else keeps the read's
 * own order: category `sortOrder`, then name.
 *
 * An orphan is left out. Its printing has left `cards`, so there is no art to fetch and no
 * artist to credit — and a cover pointing at one would be a cover the gallery declines to draw.
 */
export function coverChoices(cards: readonly DeckCard[]): DeckCard[] {
  const seen = new Set<string>();
  return [...cards]
    .sort((a, b) => rank(a) - rank(b))
    .filter((card) => {
      if (card.needsReview !== null || seen.has(card.cardId)) return false;
      seen.add(card.cardId);
      return true;
    });
}

const rank = (card: DeckCard): number => (card.categoryKind === "commander" ? 0 : 1);
