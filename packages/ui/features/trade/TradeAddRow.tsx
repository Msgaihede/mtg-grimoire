import { useCallback, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import { Camera, Plus, Search, TriangleAlert } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { ToggleChip } from "@/components/FilterChips";
import { PopupPanel } from "@/components/PopupListbox";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import { ipcError } from "@/lib/ipc";
import type { Trade, TradeSide } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { formatPrice } from "@/lib/prices";
import { clearFieldOnEscape, useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FIGURE, REFUSAL, TRADE_ICON_BUTTON } from "./tradeControls";
import {
  DECK_COPIES_HEADING,
  DECK_COPIES_WARNING,
  deckHolding,
  sideWords,
  tradeCurrency,
} from "./tradeWords";
import {
  CANDIDATE_LIMIT,
  useTradeCandidates,
  type TradeCandidate,
  type TradeScope,
} from "./useTradeCandidates";
import { useTradeWrites } from "./useTrades";

/**
 * How a card gets onto a side: a field to type a name into, and a camera.
 *
 * ## The two sides are not the same row
 *
 * **The reader's side has a scope.** Most of what they give is something they hold, so the field
 * opens on *Collection* — it answers the printing and finish of the copies they have, with how
 * many — and *All cards* is one press away for the card that is not in the binder yet. **Their
 * side has no scope to choose**: nothing they give is in the reader's collection, so the field
 * reads every card and says so in its placeholder.
 *
 * ## The list under the field
 *
 * A listbox the field points into rather than a set of buttons the caret has to travel to, which
 * is `QuickAdd`'s shape and its reasons: a reader typing a name must be able to take the answer
 * without leaving the field. The arrows move the highlight, **Enter adds the highlighted row** —
 * the first, unless they moved it — and the field empties for the next name. A press on a row
 * adds one copy and leaves the list up, because a reader using the mouse is often taking two or
 * three cards out of one search.
 *
 * **Enter waits for the rows to be the answer to what is in the field.** The search is debounced,
 * so for 300ms after the last key the list still answers the text before it; adding its top row
 * then would add a card the reader has already typed past. `pending` covers that window and
 * Enter does nothing in it — the row arrives, and the next press takes it.
 *
 * ## Two sections, and the second one is red
 *
 * The collection scope answers the reader's copies outside their decks and, apart from them, the
 * copies a deck is holding. **A deck's copies are never mixed in with the others**: they are a
 * group of their own under the rest, headed *In your decks* with a sentence saying what a finish
 * does to them, and every row in it is drawn in the destructive colour and names its deck. The
 * colour is not the only signal — the heading, the sentence and `1 in Serah` all say it in words.
 *
 * **One highlight runs through both, in the order they are drawn**, and it starts at the top: so
 * Enter lands on a deck's copy only where no other copy matched, or after the reader walked the
 * highlight down past the heading. It follows a row rather than a position — a list that changes
 * under it puts it back at the top, never on whatever slid into the place it was.
 *
 * ## Escape is two presses, in the app's order
 *
 * The first closes the list — it is an `"inner"` layer, registered only while it is up. The
 * second, with the list gone and text still in the field, clears the field
 * ({@link clearFieldOnEscape}). An empty field owns nothing and the press goes on to whatever is
 * behind it.
 *
 * **Between those two presses the list is put away and its rows are still there**, so Enter and
 * the arrows act only on a list that is up: on one that is not, each brings it back and does
 * nothing else. Otherwise Enter adds a card the reader cannot see.
 */
export function TradeAddRow({
  trade,
  side,
  onScan,
}: {
  trade: Trade;
  side: TradeSide;
  /**
   * Open the scanner onto this side. The dialog is the page's to mount, and so is the caret's way
   * back — which is why the press hands over the button it came from.
   */
  onScan: (opener: HTMLElement) => void;
}): JSX.Element {
  const tip = useTooltip();
  const writes = useTradeWrites();
  const id = useId();
  const listboxId = `${id}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState("");
  /** Their side never shows the chips, and never reads anything but every card. */
  const [picked, setPicked] = useState<TradeScope>("collection");
  const scope: TradeScope = side === "mine" ? picked : "all";
  /** The highlighted row, by its key. `null` is the top one. */
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const { rows, deckRows, pending, error } = useTradeCandidates(scope, text, trade.marketplace);
  const currency = tradeCurrency(trade);
  const asked = text.trim();
  /** Every option in the order it is drawn: the copies outside a deck, then the decks' own. */
  const options = deckRows.length > 0 ? [...rows, ...deckRows] : rows;
  /**
   * Found on read, and the top when the row is gone: the list changes under the highlight as a
   * query narrows or a read lands, and a highlight kept as a position would then sit on whichever
   * row took that place — which, past the last ordinary row, is a deck's.
   */
  const activeIndex = Math.max(
    0,
    options.findIndex((row) => row.key === active),
  );
  /** The popup is up for anything typed — rows, a wait, a miss or a refusal are all answers. */
  const listOpen = open && asked.length > 0;

  const add = (row: TradeCandidate, then: "clear" | "stay") => {
    setFailure(null);
    writes
      .addLines(trade.id, side, [
        { cardId: row.cardId, finish: row.finish, quantity: 1, source: row.source },
      ])
      .catch((e: unknown) => {
        setFailure(`Couldn't add ${row.name} — ${ipcError(e)}`);
      });
    if (then === "clear") {
      setText("");
      setActive(null);
    }
  };

  /** Move the highlight to a row, and bring it into the list's view: the list scrolls. */
  const point = (index: number) => {
    setActive(options[index].key);
    // Absent in jsdom, and a row already in view is left where it is.
    document.getElementById(optionId(id, index))?.scrollIntoView?.({ block: "nearest" });
  };

  const dismiss = useCallback(() => setOpen(false), []);
  // Only while the list is actually drawn: with the caret in an empty field the press belongs to
  // whatever layer is open over the page, and a capture rung here would eat it and close nothing.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: listOpen });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // A list put away with Escape still has its rows and its highlight, and neither is on
      // screen: Enter there would add a card the reader cannot see. It brings the list back, and
      // the next Enter is about a row they are looking at.
      if (!open) {
        setOpen(true);
        return;
      }
      const row = pending ? undefined : options[activeIndex];
      if (row) add(row, "clear");
      return;
    }
    // Reads `defaultPrevented`, so the press the rung above has just spent closing the list does
    // not also empty the field. See the helper for why that is the only honest way to ask.
    clearFieldOnEscape(e, text, () => setText(""));
    if (options.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // The same rule for the arrows, either way: on a list that is put away they bring it back
      // rather than moving a highlight nobody can see.
      if (!open) setOpen(true);
      else if (e.key === "ArrowDown") point(Math.min(activeIndex + 1, options.length - 1));
      else point(Math.max(activeIndex - 1, 0));
    }
  };

  const inTrade = (row: TradeCandidate): number =>
    trade.lines
      .filter((l) => l.side === side && l.cardId === row.cardId && l.finish === row.finish)
      .reduce((sum, l) => sum + l.quantity, 0);

  return (
    <div
      ref={rootRef}
      className="relative flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5"
      // Focus leaving the row puts the list away, which also covers a click anywhere else on the
      // page without a window listener that could race the Escape rung.
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label
        className={cn(
          "flex h-9 min-w-40 flex-1 items-center gap-2 rounded-md border bg-bg px-2.5 text-dim",
          "focus-within:border-accent",
          listOpen ? "border-accent" : "border-border",
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label={`Add a card to ${sideWords(side)}`}
          aria-expanded={listOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            listOpen && options.length > 0 ? optionId(id, activeIndex) : undefined
          }
          placeholder={side === "mine" ? "Add a card…" : "Add any card…"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(null);
            // Typing is how a list put away with Escape comes back: a new question is asked.
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          // The frame is the label's; the box inside it draws nothing of its own. The label's
          // `focus-within` border is the caret's mark, so the box needs no outline to repeat it.
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-text outline-none"
        />
      </label>

      {side === "mine" && (
        <>
          <ToggleChip
            label="Collection"
            pressed={scope === "collection"}
            onClick={() => setPicked("collection")}
          />
          <ToggleChip
            label="All cards"
            pressed={scope === "all"}
            onClick={() => setPicked("all")}
          />
        </>
      )}

      <button
        type="button"
        aria-label={`Scan cards onto ${sideWords(side)}`}
        onClick={(e) => onScan(e.currentTarget)}
        className={TRADE_ICON_BUTTON}
        {...tip("Scan cards", { describes: false })}
      >
        <Camera className="size-[1.125rem]" aria-hidden="true" />
      </button>

      {failure !== null && (
        <p role="alert" className={cn(REFUSAL, "basis-full")}>
          {failure}
        </p>
      )}

      <AnimatePresence>
        {listOpen && (
          <PopupPanel
            key="candidates"
            className={cn(
              "absolute inset-x-4 top-[calc(100%-0.375rem)] flex origin-top flex-col gap-0.5",
              "rounded-[10px] border border-border bg-surface p-1 shadow-lg",
              // Over the side's own lines, which are the next thing down the panel.
              LAYER.popup,
            )}
          >
            <ul
              id={listboxId}
              role="listbox"
              aria-label={scope === "collection" ? "Matches in your collection" : "Matching cards"}
              // Bounded, and the one scroller here: two sections of eight are taller than a short
              // window, and a row past its foot would be a card nobody could press.
              className="flex max-h-[min(34rem,60dvh)] flex-col gap-0.5 overflow-y-auto"
            >
              {rows.map((row, i) => (
                <CandidateRow
                  key={row.key}
                  id={optionId(id, i)}
                  row={row}
                  active={i === activeIndex}
                  inTrade={inTrade(row)}
                  price={formatPrice(row.unitPrice, currency)}
                  onPoint={() => setActive(row.key)}
                  onAdd={() => add(row, "stay")}
                />
              ))}
              {deckRows.length > 0 && (
                // A group of options inside the listbox, named by its heading and described by
                // its warning — so a screen reader arriving on a row in it hears both. The two
                // wrappers are presentational: a listbox owns options and groups of them only.
                <li role="presentation">
                  <ul
                    role="group"
                    aria-labelledby={`${id}-decks`}
                    aria-describedby={`${id}-decks-warning`}
                    className={cn(
                      "flex flex-col gap-0.5",
                      rows.length > 0 && "mt-1 border-t border-destructive/40 pt-1",
                    )}
                  >
                    <li role="presentation" className="flex flex-col gap-0.5 px-2 pt-1.5 pb-1">
                      <span
                        id={`${id}-decks`}
                        className="flex items-center gap-1.5 text-xs font-semibold text-destructive"
                      >
                        <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                        {DECK_COPIES_HEADING}
                      </span>
                      <span
                        id={`${id}-decks-warning`}
                        className="text-xs leading-snug text-destructive"
                      >
                        {DECK_COPIES_WARNING}
                      </span>
                    </li>
                    {deckRows.map((row, i) => {
                      const at = rows.length + i;
                      return (
                        <CandidateRow
                          key={row.key}
                          id={optionId(id, at)}
                          row={row}
                          active={at === activeIndex}
                          inTrade={inTrade(row)}
                          price={formatPrice(row.unitPrice, currency)}
                          onPoint={() => setActive(row.key)}
                          onAdd={() => add(row, "stay")}
                        />
                      );
                    })}
                  </ul>
                </li>
              )}
            </ul>
            {/* Outside the listbox, which may own only options. A live region that is always
                here while the popup is, so the sentence changing in it is what gets announced. */}
            <div
              className={cn(
                "flex items-center gap-2 px-2 pt-2 pb-1.5 text-xs text-dim",
                options.length > 0 && "mt-0.5 border-t border-border",
              )}
            >
              <span
                role="status"
                className={cn("min-w-0 flex-1", error !== null && "text-destructive")}
              >
                {statusLine(scope, asked, rows.length, deckRows.length, pending, error)}
              </span>
              {scope === "collection" && (
                <button
                  type="button"
                  // Keeps the caret in the field: the press changes what the field searches, and
                  // the reader's next key is still a letter of the name.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPicked("all")}
                  className="shrink-0 rounded-sm whitespace-nowrap text-accent hover:underline"
                >
                  Search all cards for “{asked}”
                </button>
              )}
            </div>
          </PopupPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

function optionId(id: string, index: number): string {
  return `${id}-option-${index}`;
}

/**
 * The one sentence under the rows.
 *
 * It says how many matches there are only when that is known: each section is cut at
 * {@link CANDIDATE_LIMIT}, so a full one is "the first eight" and never "eight matches".
 *
 * **A deck's copies are counted apart, and are a match**: `deckCount` is the second section's
 * rows, and "nothing matches" is said only when both are empty — a card whose every copy is
 * sleeved is in the collection, and the sentence must not say otherwise over a list that shows it.
 */
function statusLine(
  scope: TradeScope,
  asked: string,
  count: number,
  deckCount: number,
  pending: boolean,
  error: string | null,
): string {
  if (error !== null) return `Couldn't search — ${error}`;
  if (count === 0 && deckCount === 0) {
    if (pending) return "Searching…";
    return scope === "collection"
      ? `Nothing in your collection matches “${asked}”.`
      : `No card found for “${asked}”.`;
  }
  const counted = (n: number) =>
    n < CANDIDATE_LIMIT ? plural(n, "match", "matches") : `The first ${n} matches`;
  const found: string[] = [];
  if (count > 0) found.push(`${counted(count)}${scope === "collection" ? " in your collection" : ""}`);
  if (deckCount > 0) {
    // After the first count the noun is already said: `2 matches in your collection, 1 in your
    // decks`.
    const inDecks =
      count === 0
        ? counted(deckCount)
        : deckCount < CANDIDATE_LIMIT
          ? String(deckCount)
          : `the first ${deckCount}`;
    found.push(`${inDecks} in your decks`);
  }
  return `${found.join(", ")} · Enter adds one copy`;
}

/**
 * One card the side could take.
 *
 * **The row is the option and the whole of it is the press.** The plus at its end is drawn like a
 * button and is not one: an option's children are presentational to a screen reader, so a real
 * button in there would be a control nobody using one could reach — and the row already does what
 * it would. The row's accessible name is its own text, which names the card, the printing and the
 * price; an `aria-label` would replace all three with whatever sentence was written for it.
 *
 * **A deck's copy is the same row in the destructive colour**, name and line both, and its count
 * names the deck — `1 in Serah` where another row says `3 owned`. The price is left as it is: a
 * figure in red reads as a loss, and what is being lost here is a card from a deck. The plus
 * follows the row's colour, so the highlight on a deck's copy is not the gold of an ordinary add.
 */
function CandidateRow({
  id,
  row,
  active,
  inTrade,
  price,
  onPoint,
  onAdd,
}: {
  id: string;
  row: TradeCandidate;
  active: boolean;
  /** Copies of this printing and finish already on the side. */
  inTrade: number;
  price: string;
  onPoint: () => void;
  onAdd: () => void;
}) {
  const inDeck = row.place === "deck";
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      data-place={row.place ?? undefined}
      // Keeps the caret, and so the arrow keys and the next name, in the field while a card is
      // taken with the mouse. Without it the click blurs the input and the list closes under it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAdd}
      onPointerMove={onPoint}
      className={cn(
        "grid cursor-pointer grid-cols-[3.5rem_minmax(0,1fr)_auto_2rem] items-center gap-2.5",
        "rounded-md py-1.5 pr-1.5 pl-2",
        active && "bg-bg",
      )}
    >
      {/* The art crop, not the whole card: at this size the crop is the part of a card a reader
          recognises it by. */}
      <span className="block h-[2.5625rem] w-14 overflow-hidden rounded-[3px] bg-bg">
        <CardImage
          src={cardImageUrl(row.cardId, 0, "art")}
          alt=""
          className="size-full object-cover"
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn("truncate text-sm font-medium", inDeck ? "text-destructive" : "text-text")}
        >
          {row.name}
        </span>
        <span className={cn("truncate text-xs", inDeck ? "text-destructive" : "text-dim")}>
          <span className={FIGURE}>
            {row.setCode.toUpperCase()} {row.collectorNumber} · {FINISH_LABEL[row.finish]}
          </span>
          {row.owned !== null &&
            ` · ${
              row.deckName === null ? `${row.owned} owned` : deckHolding(row.owned, row.deckName)
            }`}
          {inTrade > 0 && ` · ${inTrade} in this trade`}
        </span>
      </span>
      <span className={cn(FIGURE, "text-[0.8125rem] text-text")}>{price}</span>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 place-items-center rounded-md border",
          !active
            ? "border-border text-dim"
            : inDeck
              ? "border-destructive text-destructive"
              : "border-accent text-accent",
        )}
      >
        <Plus className="size-4" />
      </span>
    </li>
  );
}
