import { useEffect, useMemo, useState, type JSX } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { CardImage } from "@/components/CardImage";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { ART_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardSummary, type DeckCard, type DeckCoverKind } from "@/lib/ipc";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { FOCUS, FOCUS_INSET } from "./cardControl";
import { CAPTION, FIELD } from "./formFields";

/**
 * What the file picker will offer, and it is **the backend's decoder list written out**.
 *
 * `src-tauri/Cargo.toml` builds the `image` crate with exactly five formats — `png`, `jpeg`,
 * `gif`, `bmp`, `webp` — chosen as "the five a person actually has on disk". A filter wider
 * than that would let a reader pick a TIFF the re-encode then refuses, which is a refusal the
 * picker could have prevented; a filter narrower would hide files that work. `jpg` and `jpeg`
 * are one decoder and two extensions people really have.
 *
 * A list, not a scope: the dialog plugin has no path scope to grant (measured against the
 * generated ACL manifest — `dialog:allow-open` carries no `scope` and the plugin declares no
 * global scope schema), so *which files* may be offered is decided here and nowhere else.
 */
const COVER_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];

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
  coverKind: DeckCoverKind;
  /** Credited under the preview. `null` draws no line — never the word "null". */
  coverArtist: string | null;
  /**
   * A custom cover's URL names the deck, not the picture (`/cover/<deckId>`, served
   * `no-store`), so the preview keys on {@link DeckCoverPickerProps.customCoverKey} to notice a
   * replaced file. `null` at create — there is no deck id yet, and therefore no route.
   */
  customCoverUrl: string | null;
  /**
   * Whatever moves when the file behind {@link DeckCoverPickerProps.customCoverUrl} is
   * replaced — the deck's `updatedAt`, in the settings dialog. It becomes the image element's
   * React key, which is the only thing that can force a re-decode of a URL that did not change.
   */
  customCoverKey?: string | number;
  /** The deck's own printings, offered when the search box is empty. `[]` at create. */
  deckCards: readonly DeckCard[];
  onPickCard: (cardId: string) => void;
  /** The file picker's answer — a path the backend reads. */
  onPickFile: (sourcePath: string) => void;
  /**
   * A file chosen but not applied yet: the create dialog has no deck id to upload against, so
   * it shows the name instead of a preview. `null` in the settings dialog, which uploads on the
   * press and has a preview to show for it.
   */
  pendingFileName: string | null;
  uploading: boolean;
  /** Namespace for this instance's element ids — two of these on one page is two pickers. */
  idPrefix: string;
}

/**
 * The picture, the choices, and the credit the choices' own frames cannot carry.
 *
 * **Presentational, and it writes nothing.** Two commands set a cover and they are not
 * interchangeable — `deckUpdate({ coverCardId })` points a deck at a printing's art crop and
 * puts `coverKind` back to `card_art`, while `deck_set_cover_image` takes a *path* the backend
 * re-encodes and marks `custom` — but which of them runs, and when, belongs to the host. This
 * component answers `onPickCard` and `onPickFile` and knows nothing else about either.
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
 * gallery tile makes.
 *
 * **The tiles do not, and the search tiles are a fifth instance of a gap recorded rather than
 * quietly inherited.** {@link ChoiceTile}'s doc has the whole argument for the four that came
 * before — `CardStack`, `views/GridView`, `TheoryDiffDialog` and the in-deck tiles here — and it
 * covers a search result for the same two reasons plus one of its own: `CardSummary` carries no
 * `artist` field (`src/lib/ipc.ts:152-250`, and `search.rs`'s SELECT does not select one), and
 * widening the search command for a picker's thumbnails would put a column on every result row
 * in the app to credit a crop that sits inside a control naming its card. It is repeated here
 * rather than left to be read next door because **an undocumented instance of a known gap is how
 * a known gap becomes an unknown one**.
 */
export function DeckCoverPicker({
  coverCardId,
  coverKind,
  coverArtist,
  customCoverUrl,
  customCoverKey,
  deckCards,
  onPickCard,
  onPickFile,
  pendingFileName,
  uploading,
  idPrefix,
}: DeckCoverPickerProps): JSX.Element {
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
        {pendingFileName !== null ? (
          <PendingFile name={pendingFileName} />
        ) : (
          <CoverPreview
            coverCardId={coverCardId}
            coverKind={coverKind}
            coverArtist={coverArtist}
            customCoverUrl={customCoverUrl}
            customCoverKey={customCoverKey}
          />
        )}
        {/* Scryfall's image policy, and the gallery tile's ruling verbatim: an `art` crop has
            no printed frame, so the illustrator is credited wherever one is shown — and a cover
            whose artist is unknown draws no line at all rather than the word "null". A custom
            cover is the reader's own picture and has no Scryfall artist to credit, which is why
            `coverArtist` is `null` for one while the frame quite properly draws it. */}
        {pendingFileName === null && coverArtist !== null && coverKind === "card_art" && (
          <p className="mt-1.5 truncate text-[0.6875rem] text-dim" title={coverArtist}>
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
            coverKind={coverKind}
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
                  current={coverKind === "card_art" && coverCardId === card.cardId}
                  onPick={() => onPickCard(card.cardId)}
                />
              </li>
            ))}
          </ul>
        )}

        <Upload upload={onPickFile} pending={uploading} />
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
  coverKind,
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
  coverKind: DeckCoverKind;
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
              current={coverKind === "card_art" && coverCardId === row.id}
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
          Showing {results.length} of {total.toLocaleString("en-US")}
          {capped ? "+" : ""} matches — a narrower word reaches the rest.
        </p>
      )}
    </>
  );
}

/**
 * The cover as the gallery would draw it: the card's `art` crop, or the reader's own picture.
 *
 * {@link DeckCoverKind} is the one answer to which of the two is showing — a deck usually
 * carries both, because setting one leaves the other alone.
 */
function CoverPreview({
  coverCardId,
  coverKind,
  coverArtist,
  customCoverUrl,
  customCoverKey,
}: {
  coverCardId: string | null;
  coverKind: DeckCoverKind;
  coverArtist: string | null;
  customCoverUrl: string | null;
  customCoverKey?: string | number;
}) {
  const custom = coverKind === "custom";
  const url = custom
    ? customCoverUrl
    : coverCardId !== null && coverArtist !== null
      ? cardImageUrl(coverCardId, 0, "art")
      : null;
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
          // **A custom cover's URL never changes**, because it names the deck and not the
          // picture (`/cover/<deckId>`, served `no-store` for exactly this reason). So
          // `CardImage`'s own key cannot notice a new upload, and this one does: the host
          // passes the deck's `updatedAt`, which moves on every write to the deck, including
          // the one that replaced the file.
          key={custom ? customCoverKey : undefined}
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
          {url === null ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * A file the reader has chosen for a deck that does not exist yet.
 *
 * **It cannot be previewed, and that is a fact about the route rather than a shortcut.** The
 * image protocol serves a custom cover at `/cover/<deckId>`, and the bytes behind that route are
 * the ones `deck_set_cover_image` re-encoded — so there is nothing to draw until there is a deck
 * to draw it for. Reading the file here instead is not the alternative it looks like: the picker
 * hands back a **path**, which is the whole of what `dialog:allow-open` grants, and this app asks
 * for no filesystem permission anywhere. So the frame says which file it is, which is the one
 * true thing there is to say.
 */
function PendingFile({ name }: { name: string }) {
  return (
    <>
      <span
        className={cn(
          "grid w-full place-items-center overflow-hidden rounded-lg border border-dashed",
          "border-border bg-surface px-3",
        )}
        style={{ aspectRatio: ART_ASPECT }}
      >
        <span className="line-clamp-3 text-center text-xs break-all text-dim">{name}</span>
      </span>
      <p className="mt-1.5 text-[0.6875rem] text-dim">
        Saved as the deck’s picture once the deck is made.
      </p>
    </>
  );
}

/**
 * One printing offered as a cover.
 *
 * The `art` crop, at the shape a cover is: this is a picture of what pressing it would do, and
 * a 5:7 card face here would be a preview of a different picture.
 *
 * **Takes an id and a name rather than a row**, because the two sources it is drawn from are two
 * types — a {@link DeckCard} from the deck and a `CardSummary` from the search — and they agree
 * about exactly these two fields. Narrowing to them is also what keeps the tile from acquiring
 * an opinion about which list it is in.
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
  current,
  onPick,
}: {
  cardId: string;
  name: string;
  current: boolean;
  onPick: () => void;
}) {
  const image = useImageRetry(cardImageUrl(cardId, 0, "art"));

  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={current}
      // The name is the whole accessible name: the picture is `alt=""` because it is the very
      // thing being chosen and "Shivan Dragon" twice is not more information.
      aria-label={name}
      title={name}
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
 * The reader's own picture, through the system file picker.
 *
 * **One press, one `open()`, and the path goes straight to the command that already existed.**
 * `deck_set_cover_image` takes a path the backend reads rather than bytes — that is its whole
 * contract — so the picker's answer is handed across unchanged. Nothing is read in the webview,
 * which is why this needs no filesystem permission of any kind: `dialog:allow-open` lets the
 * page *ask for a name*, and Rust is what opens the file.
 *
 * The disclosure this replaced asked the reader to type a path. It worked, and it was the wrong
 * affordance for a desktop app.
 */
function Upload({ upload, pending }: { upload: (sourcePath: string) => void; pending: boolean }) {
  /** The picker itself could not be opened — a different failure from a write the database
   *  refused, and it belongs beside the button rather than in the dialog's write banner. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const choose = async () => {
    setPickerFailure(null);
    setPicking(true);
    try {
      const chosen = await pickFile({
        multiple: false,
        directory: false,
        title: "Choose a deck picture",
        filters: [{ name: "Images", extensions: COVER_EXTENSIONS }],
      });
      // **A cancelled picker is not a failure.** `open` answers `null` when the reader closed
      // it without choosing, which is an ordinary way to use a file dialog — the most ordinary
      // one after changing your mind. Treating it as an error would put a red sentence under
      // the button every time somebody looked and decided not to.
      if (chosen !== null) upload(chosen);
    } catch (e) {
      setPickerFailure(ipcError(e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void choose()}
        // Disabled through both halves of the round trip — the picker being up and the
        // re-encode running — because both are states in which a second press does nothing
        // useful. The label does not change: an action keeps its name through the whole flow.
        disabled={picking || pending}
        className={cn(
          "mt-2 h-8 w-full rounded-md border border-dashed border-border text-xs text-dim",
          "transition-colors duration-150 hover:border-accent hover:text-accent",
          "disabled:opacity-50 disabled:hover:border-border disabled:hover:text-dim",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Upload an image…
      </button>
      <p className="mt-1 text-[0.6875rem] text-dim">
        Copied and re-encoded into the deck’s own picture, so moving or deleting the original
        afterwards changes nothing.
      </p>
      {pickerFailure !== null && (
        <p role="alert" className="mt-1 text-[0.6875rem] text-destructive">
          Could not open the file picker — {pickerFailure}
        </p>
      )}
    </>
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
