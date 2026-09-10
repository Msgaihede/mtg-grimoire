/**
 * The home page's deck shortcuts — six tiles that open a deck in one press.
 *
 * **The widget is a *shortcut*, not a second gallery.** `DecksPage` already draws every deck with
 * its colours, its bracket, its context menu and its drags; this draws the four facts a reader
 * picks a deck by from a landing page — the cover, the name, what it is, and what it is worth —
 * and hands the press straight to the editor. Anything more would be a wall to maintain twice.
 *
 * ## The three rules that are easy to get wrong
 *
 * **An empty `deckIds` means the six most recently updated, and the *backend* already answers
 * that.** `deck_list` is `ORDER BY archived ASC, updated_at DESC, id DESC`, so the fallback is a
 * filter and a `slice` — never a sort. A re-sort here would be a second opinion about a question
 * SQL has answered, and the two would drift the first time either changed.
 *
 * **A chosen set is drawn in the order the reader chose it**, which is the one place this widget
 * deliberately ignores `deck_list`'s order. Pinning is an arrangement: a reader who put their
 * Commander deck first meant it to be first, and re-sorting their choice into "most recently
 * touched" would silently rearrange the page every time they edited a deck.
 *
 * **Archived cuts both ways, and that is not an inconsistency.** The fallback excludes an
 * archived deck because "the six I touched most recently" is about decks in play, and a shelf of
 * retired lists would crowd out the ones that are not. An *explicitly pinned* archived deck is
 * drawn, because the reader pinned it and this widget does not overrule a reader — it says
 * `Archived` beside the name instead, so the tile is not mistaken for a live deck.
 *
 * ## What a missing pin costs
 *
 * Nothing, and it says nothing: a `deckIds` entry naming a deck that has been deleted is dropped
 * on the way through, exactly as a soft card reference is everywhere else in this app. The config
 * is not rewritten to match — a write on *render* would be a page that edits itself while being
 * read, and a deck can only come back the way it left (an undo, a restore, a sync from the device
 * that still has it), at which point the pin is right again.
 *
 * ## Prices
 *
 * `deck_values` is its own read with the marketplace **in its key**, which is the app's standing
 * rule for anything priced, and `DeckValue.value` is `null` when the marketplace priced *nothing*
 * in that deck — an em dash and never a zero. The figures land after the tiles do (`ipc.ts` says
 * so at the command), so an em dash is also what a tile shows for the beat before the read
 * answers; both are honest, and neither is another marketplace's number.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { CardArt } from "@/components/CardArt";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckRow, type DeckValue } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS_SOFT } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { widgetConfig, widgetSpan } from "../layout";
import type { WidgetProps } from "../widgetProps";
import { deckListKey, deckValuesKey } from "../keys";
import { WidgetCard } from "../WidgetCard";

// The two keys this widget reads through live in `../keys`. `deckListKey` is `useDecks`' own key
// verbatim and `SummaryWidget` reads it too, which is one fetch across the three.

/** How many decks the widget falls back to when the reader has pinned none. */
export const RECENT_DECK_COUNT = 6;

/** What this widget remembers: which decks are pinned, in the order they were pinned. */
export interface DecksWidgetConfig {
  deckIds: number[];
}

/** Stable identity for "the read has not answered", so nothing downstream re-runs on it. */
const NONE: readonly DeckRow[] = [];

const LOADING = "Loading your decks…";
const EMPTY = "No decks yet — make one on the Decks page and it will show up here.";
/**
 * Its own sentence, because it is its own situation.
 *
 * A reader with decks who has pinned only decks that no longer exist is not a reader with no
 * decks, and quietly falling back to the six most recent would answer a question they did not
 * ask — they chose a set, and every member of it has gone. Saying so is what points them at the
 * settings tray.
 */
const PINS_GONE = "The decks pinned here are not in this collection any more.";

/**
 * Which decks this widget draws, in the order it draws them.
 *
 * Exported because it is the whole of the widget's judgement and is worth reading — and testing —
 * without a render around it. Every rule in the module doc lives here: the fallback filters and
 * slices `deck_list`'s own order, a chosen set keeps the reader's order, a duplicate id draws one
 * tile, and an id nothing answers to is dropped in silence.
 */
export function decksToShow(decks: readonly DeckRow[], deckIds: readonly number[]): DeckRow[] {
  if (deckIds.length === 0) {
    return decks.filter((deck) => !deck.archived).slice(0, RECENT_DECK_COUNT);
  }
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const seen = new Set<number>();
  const chosen: DeckRow[] = [];
  for (const id of deckIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const deck = byId.get(id);
    if (deck !== undefined) chosen.push(deck);
  }
  return chosen;
}

export function DecksWidget({
  widget,
  editing,
  onConfig,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
}: WidgetProps): ReactElement {
  /**
   * A **fresh** fallback object per render rather than a module-level constant.
   *
   * `widgetConfig` hands the fallback straight back for a widget that has never been configured,
   * so a shared one would be a single array every unconfigured widget on the page holds a
   * reference to — one caller mutating it would rewrite the others. Nothing here mutates it
   * today; the cost of not depending on that is one object literal.
   */
  const config = widgetConfig(widget, { deckIds: [] as number[] });
  /**
   * `widgetConfig`'s shape check is shallow by its own admission — an array fallback with no
   * first element accepts any array — so the *elements* are narrowed here. A hand-edited row
   * carrying `["3"]` or a `NaN` is a pin that answers to no deck, which this drops the same way
   * it drops a deleted one.
   */
  const deckIds = config.deckIds.filter((id) => Number.isInteger(id));

  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);

  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const valuesQuery = useQuery({
    queryKey: deckValuesKey(marketplace.id),
    queryFn: () => ipc.deckValues(marketplace.id),
  });

  const decks = decksQuery.data ?? NONE;
  const shown = decksToShow(decks, deckIds);
  const values = new Map<number, DeckValue>(
    (valuesQuery.data ?? []).map((row) => [row.deckId, row]),
  );

  /**
   * **`decks` is one view with two states, not two views.** The gallery and the editor are told
   * apart by `openDeckId`, so opening a deck is a view change *and* an id — and in that order,
   * because `setActiveView` clears `openDeckId` on the way in (it hands back a *parked* deck,
   * which is a different thing from the one being asked for here).
   */
  const openDeck = (id: number) => {
    setActiveView("decks");
    setOpenDeckId(id);
  };

  /**
   * The pinning control: every deck, alphabetically, ticked where it is pinned.
   *
   * Sorted by the deck's **name** rather than by the row's label, so the `Archived` suffix a
   * retired deck carries does not file it under A. `sortOptions` is the app's one option order
   * and this list is not one of its documented exceptions — a reader looking for "Burn" looks
   * for it under B, not wherever `deck_list` happened to put it.
   */
  const options: DropdownOption[] = sortOptions(decks, (deck) => deck.name).map((deck) => ({
    value: String(deck.id),
    label: deck.archived ? `${deck.name} (archived)` : deck.name,
    hint: deck.formatName ?? deck.formatKey,
  }));

  /**
   * Add at the end, remove in place — which is what makes the stored order the order the reader
   * chose. **The current config is spread**, so a key a newer build stored on this widget is
   * carried through rather than deleted by an older one writing its own settings back.
   */
  const toggle = (value: string) => {
    const id = Number(value);
    const next = deckIds.includes(id) ? deckIds.filter((each) => each !== id) : [...deckIds, id];
    onConfig({ ...config, deckIds: next });
  };

  const settings = (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-dim">
        Pin the decks this widget shows. With none pinned it draws the{" "}
        {RECENT_DECK_COUNT} you edited most recently.
      </p>
      <MultiDropdown
        fill
        size="sm"
        label="Decks to pin"
        // Searchable only where scrolling would be the alternative: a reader with four decks
        // gets a list, a reader with forty gets a box. The number is `SetCombobox`'s judgement
        // one order of magnitude down — a panel this narrow shows about eight rows.
        searchable={options.length > 8}
        searchLabel="Search decks"
        options={options}
        selected={deckIds.map(String)}
        onToggle={toggle}
        triggerLabel={deckIds.length === 0 ? "Most recent" : plural(deckIds.length, "deck")}
      />
    </div>
  );

  /**
   * The note under the tiles — which marketplace these figures are, and what they are missing.
   *
   * A failed `deck_values` is **not** the widget's refusal state: the tiles are still right and
   * only the money is missing, so the em dashes get a reason rather than the deck list getting an
   * error it did not have. The `unpriced` count is summed at the same marketplace as the figures
   * beside it and never travels across a switch.
   */
  const unpriced = shown.reduce((sum, deck) => sum + (values.get(deck.id)?.unpriced ?? 0), 0);
  const note = valuesQuery.isError
    ? `Could not read what these decks are worth — ${ipcError(valuesQuery.error)}`
    : unpriced > 0
      ? `${pricesAsOf(marketplace)} ${plural(unpriced, "copy", "copies")} here have no price at it.`
      : pricesAsOf(marketplace);

  let body: ReactNode;
  if (decksQuery.isPending) {
    body = <p className="text-sm text-dim">{LOADING}</p>;
  } else if (decksQuery.isError) {
    body = (
      <p className="text-sm text-destructive">
        Could not read your decks — {ipcError(decksQuery.error)}
      </p>
    );
  } else if (decks.length === 0) {
    body = <p className="text-sm text-dim">{EMPTY}</p>;
  } else if (shown.length === 0) {
    body = <p className="text-sm text-dim">{PINS_GONE}</p>;
  } else {
    body = (
      <>
        <ul className="flex flex-col gap-1.5">
          {shown.map((deck) => (
            <li key={deck.id}>
              <DeckShortcut
                deck={deck}
                value={values.get(deck.id) ?? null}
                currency={currency}
                editing={editing}
                onOpen={openDeck}
              />
            </li>
          ))}
        </ul>
        <p className="text-xs text-dim">{note}</p>
      </>
    );
  }

  return (
    <WidgetCard
      heading="Decks"
      editing={editing}
      span={widgetSpan(widget)}
      settings={settings}
      onRemove={onRemove}
      onSpan={onSpan}
      dragHandleRef={dragHandleRef}
      onNudge={onNudge}
    >
      {body}
    </WidgetCard>
  );
}

/**
 * One deck: its cover, its name, what it is, and what it is worth.
 *
 * **A button at rest and a plain row while the page is being customized**, which is the one thing
 * `widgetProps.ts` warns a widget may change about itself. A reader rearranging the page is not
 * browsing it, and a press that navigated away mid-drag would take the layout they were half way
 * through arranging off the screen — so in edit mode the tile is a preview of itself. The words
 * are identical either way; only the affordance goes.
 */
function DeckShortcut({
  deck,
  value,
  currency,
  editing,
  onOpen,
}: {
  deck: DeckRow;
  /** `null` while `deck_values` is still out as well as for a deck it priced nothing in — both
   *  are an em dash, and the note under the list is what tells them apart. */
  value: DeckValue | null;
  currency: Currency;
  editing: boolean;
  onOpen: (id: number) => void;
}): ReactElement {
  const tip = useTooltip();

  /**
   * The cover, and the **credit that is the price of drawing one**.
   *
   * Scryfall's guidelines: an `art` crop carries no printed frame, so the illustrator has to be
   * identifiable wherever one is shown — and this widget draws nothing but crops, so it takes
   * that arm rather than the "a full card image somewhere in the same interface" one. A cover
   * whose printing has left `cards` has no artist to name and is therefore not drawn at all,
   * which is a state the next sync heals. `DeckTile`'s `hasCover`/`coverUrl` make the same
   * decision in the same words for the gallery — the third surface to draw a deck cover is the
   * one that should move these two lines somewhere shared.
   */
  const drawable = deck.coverCardId !== null && deck.coverArtist !== null;

  const format = deck.formatName ?? deck.formatKey;
  const caption = `${format} · ${plural(deck.cardCount, "card")}${deck.archived ? " · Archived" : ""}`;
  const price = formatPrice(value?.value ?? null, currency);

  const art = (
    <span
      // The credit, on the picture it belongs to — the gallery's own answer since 2026-09-07,
      // and `useTooltip` binds nothing at all for a deck with no artist to name.
      {...tip(deck.coverArtist && `Art by ${deck.coverArtist}`)}
      className="w-10 shrink-0"
    >
      <CardArt
        cardId={drawable ? deck.coverCardId : null}
        // Decorative: the deck's name is the line beside it, and an `alt` here would be the
        // tile announced twice.
        name=""
        variant="art"
        imageUrl={deck.imageUris?.art}
      />
    </span>
  );

  const inner = (
    <>
      {art}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-text">{deck.name}</span>
        <span className="truncate text-xs text-dim">{caption}</span>
      </span>
      <span className="shrink-0 font-mono text-sm tabular-nums text-text">{price}</span>
    </>
  );

  const box = "flex w-full items-center gap-2.5 rounded-md border border-border p-1.5 text-left";

  if (editing) return <div className={box}>{inner}</div>;

  return (
    <button
      type="button"
      /**
       * The whole tile in one string, because the parts would not survive name computation:
       * three flex children separated by a `gap` and no whitespace text node concatenate to
       * "BurnModern · 60 cards$120.00". Every visible word is in here, in the same order, so a
       * reader driving by voice can still say what they see.
       */
      aria-label={`${deck.name} · ${caption} · ${price}`}
      onClick={() => onOpen(deck.id)}
      className={cn(box, "hover:border-accent/60", PRESS_SOFT, FOCUS)}
    >
      {inner}
    </button>
  );
}
