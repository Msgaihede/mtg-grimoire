import { useEffect, useId, useState, type JSX } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FIELD } from "@/features/decks/formFields";
import { DEBOUNCE_MS, searchTerms } from "@/features/search/useCardSearch";
import { PANEL_BUTTON, TOUCH_FIELD, TOUCH_FLOOR } from "@/features/settings/controls";
import { soleFinish } from "@/lib/finish";
import { FOCUS_INSET } from "@/lib/focus";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { radioKeys, type RadioKeyProps } from "@/lib/radioGroup";
import { cn } from "@/lib/utils";
import {
  chosenLine,
  noPrintingFound,
  PRINTINGS,
  printingLabel,
  printingsFound,
  printingWords,
  SEARCH_PLACEHOLDER,
  SEARCH_PROMPT,
  searchFailed,
  SEARCHING,
  SET_HINT,
  SHOW_MORE,
  WHICH_CARD,
} from "./submitText";

/**
 * How many printings one answer draws, and how many *Show more* adds.
 *
 * Twenty-four is six rows of the dialog's four columns and eight of a phone's three — enough
 * that every printing of an ordinary card is on the first answer, and few enough that a basic
 * land's hundreds are not all fetched to be scrolled past. `DeckCoverPicker` stops at one page on
 * purpose (a reader who cannot see their card wants a narrower word); here the reader is asked
 * for *the exact printing*, and a Forest's is as likely to be the ninetieth as the first — so the
 * answer can be made longer as well as narrower.
 */
export const PRINTINGS_STEP = 24;

/** The backend's own clamp on a page (`search_cards`): past it a longer ask is not a longer answer. */
export const PRINTINGS_MAX = 200;

export interface PrintingPickerProps {
  /** What the box opens holding: the card the scanner was naming, or `""`. Read once. */
  initialQuery: string;
  /** The reader's choice, or `null` before they have made one. */
  chosen: CardSummary | null;
  onChoose: (card: CardSummary) => void;
}

/**
 * *Which card is in the picture?* — a search box, and every printing it finds as a card to press.
 *
 * `DeckCoverPicker`'s shape, asked a different question. That one offers *pictures*, so its tiles
 * are art crops; this one asks for **the exact printing**, which is told apart by everything a
 * crop cuts off — the frame, the set symbol, the collector line — so each tile is the whole card
 * with its set and number set in type under it. The request is that picker's, for its reasons:
 * the app's own query syntax, uncollapsed (a row is a printing), unplayable printings left in (a
 * token or an art card can be what is lying under the camera).
 *
 * **Presentational about the choice**: it reports a press and is told what is chosen. What a
 * choice does to the finish is the dialog's to decide.
 *
 * ## The box is prefilled and nothing is chosen
 *
 * The scanner's own guess opens the search, because nine times in ten it has the *card* right
 * and the reader is here about the printing — and a guess that is wrong is one edit away. It
 * selects nothing: a tile already ringed would be a label nobody gave, which is the one thing
 * this dialog exists not to send.
 *
 * ## A choice outlives the search that found it
 *
 * The reader can pick a printing and then search again — to look at another set, or because
 * they are unsure — and the tile they picked may not be among the new answers. Clearing the
 * choice there would undo a decision behind the reader's back; keeping it with nothing on
 * screen to show for it would send a card they can no longer see. So the choice is kept and
 * **said in words under the grid**, whatever the grid is showing.
 */
export function PrintingPicker({ initialQuery, chosen, onChoose }: PrintingPickerProps): JSX.Element {
  const id = useId();
  const [text, setText] = useState(initialQuery);
  // Seeded with the prefill, so the box's opening answer is asked for at once rather than after
  // a debounce nobody typed through.
  const [debounced, setDebounced] = useState(initialQuery);

  // `DEBOUNCE_MS`, with every other card search in the app.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const query = debounced.trim();
  const searching = query !== "";

  // **The longer answer belongs to the search it was asked of.** Kept with its query rather than
  // as a bare number, so a new word starts again at one step without an effect to reset it — a
  // reader who paged through the Forests has not asked for two hundred Islands.
  const [more, setMore] = useState({ query, limit: PRINTINGS_STEP });
  const limit = more.query === query ? more.limit : PRINTINGS_STEP;

  const search = useQuery({
    // Under `["cards","search", …]` with every other card search, so a sync that replaces the
    // card data clears this too; the third segment keeps it from answering any of them.
    queryKey: ["cards", "search", "scan-submit", query, limit],
    queryFn: () =>
      ipc.searchCards({
        ...searchTerms(query),
        // A row is a printing. Collapsed, the four Lightning Bolts are one tile and the question
        // this dialog asks cannot be answered.
        collapse: false,
        // Whatever can be photographed can be the card in the picture.
        playableOnly: false,
        limit,
        offset: 0,
      }),
    enabled: searching,
    // The tiles stay while the next answer is in flight — a keystroke's, or a longer page's.
    placeholderData: keepPreviousData,
  });

  // Gated on `searching`: a disabled query keeps what it last held, and an emptied box must not
  // go on drawing the printings of the word that was in it.
  const results = searching ? (search.data?.items ?? []) : [];
  const total = search.data?.total ?? 0;
  const capped = search.data?.totalIsCapped ?? false;
  const failure = searching && search.isError ? ipcError(search.error) : null;
  const unshown = results.length > 0 && (capped || total > results.length);

  /** The one line under the box: what to do, what is happening, or what came back. */
  const said = !searching
    ? SEARCH_PROMPT
    : results.length > 0
      ? printingsFound(results.length, total, capped)
      : failure !== null
        ? ""
        : search.isFetching
          ? SEARCHING
          : noPrintingFound(query);

  const ids = results.map((row) => row.id);
  const choose = (cardId: string | null) => {
    const row = results.find((one) => one.id === cardId);
    if (row !== undefined) onChoose(row);
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-search`} className="text-sm font-medium text-text">
        {WHICH_CARD}
      </label>
      <input
        id={`${id}-search`}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={SEARCH_PLACEHOLDER}
        autoComplete="off"
        spellCheck={false}
        // No press dip — a box the reader types into never wears one (`motion.test.ts`) — and
        // 16px type under a finger, below which a phone zooms the page as the box takes the caret.
        className={cn(FIELD, "h-9 placeholder:text-dim", TOUCH_FIELD, TOUCH_FLOOR)}
      />

      {/* Mounted whatever it has to say, and filled: a region that first appears with its words
          already in it announces nothing, and "4 printings" is news to a reader who cannot see
          the grid change. */}
      <p role="status" aria-live="polite" className="min-h-4 text-xs text-dim">
        {said}
      </p>

      {/* A search that could not run is not a card nothing matches, and the two ask opposite
          things of the reader. */}
      {failure !== null && (
        <p role="alert" className="text-xs text-destructive">
          {searchFailed(failure)}
        </p>
      )}

      {results.length > 0 && (
        // A scroller of its own, so a long answer does not push the finish and the press that
        // sends off the bottom of the dialog. Three columns at a phone's width, four from the
        // dialog's own.
        <div
          role="radiogroup"
          aria-label={PRINTINGS}
          className="grid max-h-80 grid-cols-3 content-start gap-2 overflow-y-auto overscroll-contain sm:grid-cols-4"
        >
          {results.map((row, index) => (
            <PrintingTile
              key={row.id}
              card={row}
              checked={chosen?.id === row.id}
              // One Tab stop for the whole grid and the arrows to walk it — `radioGroup.ts`,
              // which every radio group in the app goes through. A choice that is not among
              // these answers leaves the stop on the first tile.
              keys={radioKeys<string | null>(ids, chosen?.id ?? null, choose, index)}
              onChoose={() => onChoose(row)}
            />
          ))}
        </div>
      )}

      {unshown && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Not offered past the backend's clamp, where a longer ask would come back the same
              length and the press would have done nothing. The hint is what is left. */}
          {limit < PRINTINGS_MAX && (
            <button
              type="button"
              onClick={() =>
                setMore({ query, limit: Math.min(PRINTINGS_MAX, limit + PRINTINGS_STEP) })
              }
              className={cn(PANEL_BUTTON, "border-border px-2.5 py-1 text-xs text-dim hover:text-text")}
            >
              {SHOW_MORE}
            </button>
          )}
          <p className="min-w-0 flex-1 basis-48 text-xs text-dim">{SET_HINT}</p>
        </div>
      )}

      {/* The choice in words — see the component's note. Always here, so the finish below it does
          not move when a card is chosen. */}
      <p className="min-h-5 text-sm text-text">{chosen === null ? "" : chosenLine(chosen)}</p>
    </div>
  );
}

/**
 * One printing, as a radio: the whole card, and its set and number under it.
 *
 * Named `<card> — <SET> <number>`, the tray's spelling of a candidate printing, so a reader, a
 * screen reader and a test all ask for a tile by what is printed under it. The picture is
 * `CardArt`'s — a card is never a bare image element here — in the `grid` size, which is the
 * smallest a collector line can still be made out in at four across.
 *
 * **Chosen is said three ways and only one of them is colour**: `aria-checked`, a gold edge, and
 * a tick laid on the card's corner — two gold-edged tiles side by side under a focus outline
 * would otherwise be told apart by hue alone.
 *
 * A printing sold in one finish wears the walls' own mark for it (`soleFinish`): Scryfall's
 * picture of a foil-only printing is the plain card's, and "the foil one" is often exactly what
 * the reader is trying to find among three tiles that look alike.
 */
function PrintingTile({
  card,
  checked,
  keys,
  onChoose,
}: {
  card: CardSummary;
  checked: boolean;
  keys: RadioKeyProps;
  onChoose: () => void;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={printingLabel(card)}
      {...keys}
      // The set by its name, for a pointer: three letters under a card are a code, and the set
      // symbol at this size is a smudge.
      {...tip(card.setName)}
      onClick={onChoose}
      className={cn(
        "relative flex min-w-0 flex-col gap-1 rounded-lg border p-1",
        PRESS,
        // Inside the tile's own edge: the grid is a scroller, and an outline standing off a tile
        // in its first column or its last row is painted where the scroller clips.
        FOCUS_INSET,
        checked ? "border-accent ring-2 ring-accent ring-inset" : "border-border hover:border-accent",
      )}
    >
      <CardArt
        cardId={card.id}
        name={card.name}
        variant="grid"
        finish={soleFinish(card.finishes)}
        // Not virtualised: every tile of the answer is mounted, so the browser's own gate is
        // what bounds how many pictures a two-hundred-printing answer asks for.
        loading="lazy"
      />
      {checked && (
        <span
          aria-hidden="true"
          data-chosen-mark=""
          className="absolute top-2 left-2 grid size-5 place-items-center rounded-full bg-accent text-accent-fg"
        >
          <Check className="size-3.5" />
        </span>
      )}
      <span aria-hidden="true" className="truncate text-center font-mono text-[0.6875rem] text-dim">
        {printingWords(card)}
      </span>
    </button>
  );
}
