/**
 * The home page's deck shortcuts — rows that open a deck in one press.
 *
 * **The widget is a *shortcut*, not a second gallery.** `DecksPage` already draws every deck with
 * its colours, its bracket, its context menu and its drags; this draws the four facts a reader
 * picks a deck by from a landing page — the cover, the name, what it is, and what it is worth —
 * and hands the press straight to the editor. Anything more would be a wall to maintain twice.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip, the settings popover and the
 * Customize tray; this draws rows cut to the box `fit` describes. The pin picker that used to sit
 * in this widget's own popover is {@link DecksWidgetSettings}, which the card draws at the foot of
 * its settings under the registry's `Which decks` row.
 *
 * ## The three scopes, and the rules that are easy to get wrong
 *
 * **`recent` is `deck_list`'s own order with the archived decks taken out, and the *backend*
 * already answers it.** `deck_list` is `ORDER BY archived ASC, updated_at DESC, id DESC`, so the
 * scope is a filter — never a sort. A re-sort here would be a second opinion about a question SQL
 * has answered, and the two would drift the first time either changed. `archived` is the same list
 * with nothing taken out, which by that same order puts every archived deck *after* the live ones:
 * "Archived too" adds the shelf, it does not interleave it.
 *
 * **`pinned` is drawn in the order the reader chose**, which is the one place this widget
 * deliberately ignores `deck_list`'s order. Pinning is an arrangement: a reader who put their
 * Commander deck first meant it to be first. An *explicitly pinned* archived deck is drawn, because
 * the reader pinned it, and it says `Archived` in its caption so it is not mistaken for a live deck.
 *
 * **A config written before the scope pick existed reads as `pinned` when it holds pins.** The old
 * widget had no scope: a non-empty `deckIds` *was* "pinned", and an empty one "most recent". A
 * default of `recent` read naively would silently throw away every reader's pinned set on upgrade.
 * See {@link deckScope}.
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
 * in that deck — an em dash and never a zero. The figures land after the rows do, so an em dash is
 * also what a row shows for the beat before the read answers; both are honest, and neither is
 * another marketplace's number.
 *
 * ## Customize
 *
 * The old widget swapped each tile for a plain `<div>` while the page was being customized, so a
 * press meant to pick the card up could not navigate away mid-arrangement. **That special case is
 * gone**: the card makes the whole body `inert` while editing (`widgetProps.ts`), which does the
 * same thing for every widget at once. A body only stops pressing when it is a catalogue `still`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { CardArt } from "@/components/CardArt";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { plural } from "@/lib/counts";
import { ipc, ipcError, type DeckRow, type DeckValue, type HomeWidget } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { deckListKey, deckValuesKey } from "../keys";
import { widgetConfig } from "../layout";
import { WidgetFooter, WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";
import { widgetMeta } from "../widgets";

// The two keys this widget reads through live in `../keys`. `deckListKey` is `useDecks`' own key
// verbatim and `SummaryWidget` reads it too, which is one fetch across the three.

/** Which decks the widget draws — the registry's `scope` pick. */
export type DeckScope = "recent" | "pinned" | "archived";

/** Stable identity for "the read has not answered", so nothing downstream re-runs on it. */
const NONE: readonly DeckRow[] = [];

/**
 * Row heights in pixels, grown with the type — the design's numbers (`widget-home.dc.html`'s
 * `body()`). A row with a 34px card frame is the frame's 5:7 height plus the row's padding; a row
 * with a caption is two lines; a bare row is one.
 */
const ROW_WITH_ART = 60;
const ROW_WITH_CAPTION = 51;
const ROW_BARE = 36;
/** What the price note under the rows takes off the body before rows are counted. */
const FOOTER_ROOM = 22;

const LOADING = "Loading your decks…";
const EMPTY = "No decks yet — make one on the Decks page and it will show up here.";
/**
 * Its own sentence, because it is its own situation.
 *
 * A reader with decks who has pinned only decks that no longer exist is not a reader with no
 * decks, and quietly falling back to the most recent would answer a question they did not ask —
 * they chose a set, and every member of it has gone. Saying so is what points them at the settings.
 */
const PINS_GONE = "The decks pinned here are not in this collection any more.";
/**
 * `Pinned` with nothing pinned says so rather than falling back to the most recent decks.
 *
 * **The chip beside a wide card's title reads `Pinned`**, so a card drawing the recent decks under
 * it would be the card claiming something it is not doing — and the reader who picked `Pinned`
 * picked it in order to choose, so the sentence that sends them to the picker is the useful answer.
 */
const NOTHING_PINNED = "No decks pinned yet — choose them in this card's settings under Customize.";
/**
 * `Most recent` over a collection whose every deck is archived.
 *
 * The old widget answered this with {@link PINS_GONE}, which was the wrong sentence: nothing was
 * pinned, and nothing was gone. The shelf is there and the scope is what hides it.
 */
const ALL_ARCHIVED = "Every deck is archived — choose Archived too in this card's settings to show them.";

/**
 * The pins, narrowed.
 *
 * `widgetConfig`'s shape check is shallow by its own admission — an array fallback with no first
 * element accepts any array — so the *elements* are narrowed here. A hand-edited row carrying
 * `["3"]` or a `NaN` is a pin that answers to no deck, which this drops the same way it drops a
 * deleted one. A **fresh** fallback per call, so no two widgets can come to share one array.
 */
export function pinnedDeckIds(widget: HomeWidget): number[] {
  return widgetConfig(widget, { deckIds: [] as number[] }).deckIds.filter((id) =>
    Number.isInteger(id),
  );
}

/**
 * Which scope this widget draws.
 *
 * **A stored config with pins and no `scope` at all is `pinned`**, and that is an upgrade rather
 * than a guess: every `decks` widget configured before the grid redesign stored `deckIds` alone,
 * where a non-empty set was the whole of what "pinned" meant. Reading the registry's default there
 * would draw the recent decks under a reader who had chosen theirs. Anything else is the pick's
 * own value — including a stored word no option carries, which `pickOf` reads as the default.
 */
export function deckScope(widget: HomeWidget): DeckScope {
  const stored = widgetConfig(widget, { scope: "" });
  if (stored.scope === "" && pinnedDeckIds(widget).length > 0) return "pinned";
  const scope = pickOf(widget, "scope");
  return scope === "pinned" || scope === "archived" ? scope : "recent";
}

/**
 * Which decks this widget draws, in the order it draws them — before the box cuts the list.
 *
 * Exported because it is the whole of the widget's judgement and is worth reading — and testing —
 * without a render around it. Every rule in the module doc lives here: `recent` filters
 * `deck_list`'s own order, `archived` keeps it whole, a pinned set keeps the reader's order, a
 * duplicate id draws one row, and an id nothing answers to is dropped in silence.
 */
export function decksToShow(
  decks: readonly DeckRow[],
  scope: DeckScope,
  deckIds: readonly number[],
): DeckRow[] {
  if (scope === "recent") return decks.filter((deck) => !deck.archived);
  if (scope === "archived") return [...decks];
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

/** What the deck is, in the words a caption carries: `Modern · 60 cards`, `· Archived` on a shelf. */
function deckCaption(deck: DeckRow): string {
  const format = deck.formatName ?? deck.formatKey;
  return `${format} · ${plural(deck.cardCount, "card")}${deck.archived ? " · Archived" : ""}`;
}

/**
 * Has this deck a cover the app is **allowed** to draw — a printing, and an illustrator to credit?
 *
 * `DeckTile.tsx`'s `hasCover`, restated: `docs/reference/home-page.md` §8 records this as the third
 * copy and the decision to leave it one (two lines and a comment rather than a figure). Here the
 * frame is a whole printed card rather than an art crop, so the credit is printed on the picture
 * and the artist half is not what makes it legal — but `coverArtist` is `null` exactly when the
 * printing has left `cards`, which is a cover with nothing to fetch, so the test is still the right
 * one: a request that can only miss is not made.
 */
function hasCover(deck: DeckRow): boolean {
  return deck.coverCardId !== null && deck.coverArtist !== null;
}

export function DecksWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const scope = deckScope(widget);
  const deckIds = pinnedDeckIds(widget);

  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);

  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const valuesQuery = useQuery({
    queryKey: deckValuesKey(marketplace.id),
    queryFn: () => ipc.deckValues(marketplace.id),
  });

  if (decksQuery.isPending) return <WidgetMessage>{LOADING}</WidgetMessage>;
  if (decksQuery.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read your decks — {ipcError(decksQuery.error)}
      </WidgetMessage>
    );
  }

  const decks = decksQuery.data ?? NONE;
  if (decks.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;
  if (scope === "pinned" && deckIds.length === 0) {
    return <WidgetMessage>{NOTHING_PINNED}</WidgetMessage>;
  }
  const listed = decksToShow(decks, scope, deckIds);
  if (listed.length === 0) {
    return <WidgetMessage>{scope === "pinned" ? PINS_GONE : ALL_ARCHIVED}</WidgetMessage>;
  }

  /**
   * What the box carries, from the design's `body()`.
   *
   * **A cover needs a tile at least three cells wide and two tall**, because a 34px frame beside a
   * name on a two-cell tile leaves the name no room; the caption needs a panel and a comfortable
   * density. **On a two-cell tile the figure moves under the name** — there is no width for a name
   * and a figure side by side — so that row carries a second line even though it has no caption,
   * and is counted at a caption row's height: counting it at a bare row's would cut the list to
   * more rows than the box holds, which is the half-row this arithmetic exists to avoid.
   */
  const tile = fit.tier === 0;
  const withArt = fit.tier >= 1 && fit.h >= 2 && toggleOn(widget, "art");
  const withCaption = fit.tier >= 1 && !fit.compact;
  const rowH = withArt ? ROW_WITH_ART : withCaption || tile ? ROW_WITH_CAPTION : ROW_BARE;

  /**
   * The note under the rows — which marketplace these figures are, and what they are missing.
   *
   * **A refused `deck_values` is always said**, because the rows are still right and only the
   * money is missing: the em dashes get a reason rather than the deck list getting an error it did
   * not have. The ordinary note is a band's furniture and is drawn from four cells wide.
   */
  const footerShown = valuesQuery.isError || fit.tier >= 2;
  const rows = listed.slice(0, fit.rowsFit(rowH, footerShown ? FOOTER_ROOM : 0));

  const values = new Map<number, DeckValue>(
    (valuesQuery.data ?? []).map((row) => [row.deckId, row]),
  );
  // The unpriced copies are summed over the rows on screen, at the same marketplace as the figures
  // beside them, and never travel across a switch.
  const unpriced = rows.reduce((sum, deck) => sum + (values.get(deck.id)?.unpriced ?? 0), 0);
  const footer = valuesQuery.isError
    ? `Could not read what these decks are worth — ${ipcError(valuesQuery.error)}`
    : unpriced > 0
      ? `${pricesAsOf(marketplace)} ${plural(unpriced, "copy", "copies")} here have no price at it.`
      : pricesAsOf(marketplace);

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

  return (
    <>
      <WidgetRowList fit={fit}>
        {rows.map((deck) => {
          const caption = deckCaption(deck);
          // `null` while `deck_values` is still out as well as for a deck it priced nothing in —
          // both are an em dash, and the note under the list is what tells them apart.
          const price = formatPrice(values.get(deck.id)?.value ?? null, currency);
          return (
            <WidgetRow
              key={deck.id}
              name={deck.name}
              caption={tile ? price : withCaption ? caption : undefined}
              captionStrong={tile}
              value={tile ? undefined : price}
              art={
                withArt ? (
                  <CardArt
                    cardId={hasCover(deck) ? deck.coverCardId : null}
                    // Decorative: the deck's name is the line beside it, and an `alt` here would
                    // be the row announced twice.
                    name=""
                    // **A whole printed card, never the `art` crop the gallery draws.** A crop has
                    // no printed frame, so wherever one is shown its illustrator must be named;
                    // a `thumb` carries the credit printed on the card itself (Scryfall's second
                    // arm), which is the only honest answer in a 34px frame with no room for a
                    // tooltip target anybody could find.
                    variant="thumb"
                    imageUrl={deck.imageUris?.thumb}
                    // This body is not virtualised, so the browser's own gate is what bounds what
                    // a tall card asks for — `CardArt`'s `loading` doc.
                    loading="lazy"
                  />
                ) : undefined
              }
              onPress={still ? undefined : () => openDeck(deck.id)}
              /**
               * The whole row in one string, because the parts would not survive name
               * computation: three flex children separated by a `gap` and no whitespace text node
               * concatenate to "BurnModern · 60 cards$120.00". Every word a wide row shows is in
               * here, in the same order, whatever this box happens to be drawing — so the name a
               * reader drives by voice does not change as the card is resized.
               */
              pressLabel={still ? undefined : `${deck.name} · ${caption} · ${price}`}
            />
          );
        })}
      </WidgetRowList>
      {footerShown && <WidgetFooter>{footer}</WidgetFooter>}
    </>
  );
}

/**
 * The words the `Which decks` row and its `Pinned` option carry, read off the registry — so the
 * sentence that points at them cannot come to name a control that has been renamed.
 */
function scopeWords(): { row: string; pinned: string } {
  const pick = widgetMeta("decks").picks.find((entry) => entry.key === "scope");
  return {
    row: pick?.label ?? "Which decks",
    pinned: pick?.options.find((option) => option.id === "pinned")?.label ?? "Pinned",
  };
}

/**
 * The pinning control: every deck, alphabetically, ticked where it is pinned.
 *
 * **Drawn only while the card's scope is `Pinned`**, with a sentence in its place otherwise. A
 * picker under `Most recent` would be a control whose every press changes nothing on the card,
 * which reads as broken; the scope row is directly above this in the same popover, and the pins
 * are **kept** while hidden, so switching back to `Pinned` brings the reader's set back as it was.
 */
export function DecksWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const scope = deckScope(widget);
  const deckIds = pinnedDeckIds(widget);

  if (scope !== "pinned") {
    const words = scopeWords();
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.pinned} under {words.row} to pick the decks this card shows.
      </p>
    );
  }

  const decks = decksQuery.data ?? NONE;
  /**
   * Sorted by the deck's **name** rather than by the row's label, so the `(archived)` suffix a
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
   * chose. **The patch also writes `scope: "pinned"`**: a pre-redesign config reads as pinned only
   * while it holds pins (see {@link deckScope}), so unpinning its last deck with the word still
   * unwritten would flip the card to `Most recent` under the reader's hand and take this picker
   * away mid-press. Writing the value it already reads makes the choice stored rather than inferred.
   * The page merges the patch, so every other key — a newer build's included — is kept.
   */
  const toggle = (value: string) => {
    const id = Number(value);
    const next = deckIds.includes(id) ? deckIds.filter((each) => each !== id) : [...deckIds, id];
    onConfig({ deckIds: next, scope: "pinned" });
  };

  return (
    <div className="flex flex-col gap-2">
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
        triggerLabel={deckIds.length === 0 ? "None pinned" : plural(deckIds.length, "deck")}
      />
      {decksQuery.isError && (
        <p className="m-0 text-xs text-destructive">
          Could not read your decks — {ipcError(decksQuery.error)}
        </p>
      )}
    </div>
  );
}
