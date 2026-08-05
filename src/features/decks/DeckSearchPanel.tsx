import { useId, useState } from "react";
import { Plus, Search } from "lucide-react";
import { FILTER_CONTROL, FILTER_FOCUS } from "@/components/FilterChips";
import { OwnedBadge } from "@/components/OwnedBadge";
import { CardGrid } from "@/features/search/CardGrid";
import { FilterBar } from "@/features/search/FilterBar";
import { summaryOf } from "@/features/search/SearchPage";
import { useCardSearch } from "@/features/search/useCardSearch";
import { ipcError, type DeckZone } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Deck } from "./useDeck";
import { ZONE_LABEL } from "./ZoneColumn";

/** The shared focus recipe: a gold outline standing off the control, never a ring. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * How wide the panel is when it is open.
 *
 * The direction's docked column is 320px and this is 384, because 320 is a width at which the
 * search view's own filter row stops working: the mana-value chips are nine 36px squares with
 * 4px between them — **356px**, which does not fit in 320 and cannot be made to wrap without
 * forking a control two views share. 384 is the next step up the app's own scale that holds
 * them, and the same 96px module as the card pane beside it.
 *
 * Measured in the running window at 1280×800: header 36, filter row 168 (four wrapped lines),
 * count line 16, and 341px of card wall.
 */
const PANEL_WIDTH = "w-96";

/**
 * The wall's tile floor in here, and the number that decides whether this column shows one
 * card or two.
 *
 * 384 is **343** by the time the panel's scrollbar (17) and the wall's own padding (24) are
 * off it — eleven pixels short of two of `CardGrid`'s standard 170px tiles, which drew one
 * 343×508 card per row in a 341px-tall wall: less than a whole card, ever. At 150 the same
 * 343 is two 165px tiles, which is the "~2 tiles per row" this panel was scoped around.
 */
const TILE_FLOOR = 150;

export interface DeckSearchPanelProps {
  /**
   * The editor's own `useDeck().addCard`, handed down rather than mounted again here — the
   * shape every other control in this editor takes (`ZoneColumn` is given `onSetQuantity`,
   * `onMove`, `onSetCover` and reaches for no hook of its own).
   *
   * Handed down rather than re-mounted for a measured reason: `useDeck` carries the deck's
   * *read* with it, and a second observer of `["decks","detail",id]` subscribing after the
   * first has settled is a background refetch on a query whose `staleTime` is zero — one
   * extra `deck_get` every time a deck is opened, and, where a test scripts consecutive
   * answers, the second one arriving a beat early.
   */
  add: Deck["addCard"];
  /**
   * Where a card may be put, in the order the select offers them — the editor's own
   * `moveTargets`, derived from the seeded format spec, so a Modern deck is never offered a
   * commander zone and a Commander deck is never offered a sideboard.
   *
   * Not in the plan's sketch of this interface, and it has to be: the alternative is a second
   * component deriving the zone list from `format_specs` beside the one that already has it,
   * which is how a panel starts offering a zone the editor is not drawing.
   */
  zones: readonly DeckZone[];
  /** The zone every add lands in. Owned by the editor, which clamps it when a re-format takes
   *  the picked zone away. */
  targetZone: DeckZone;
  onTargetZoneChange: (zone: DeckZone) => void;
}

/**
 * The path by which cards enter a deck.
 *
 * Not a second search: this is `useCardSearch` + `FilterBar` + `CardGrid` — the search view's
 * own parts — in a column beside the zones, with the wall's two slots pointed at this job. The
 * `badge` slot keeps telling the collection story (a card in the binder is one the deck can be
 * built out of today) and the `action` slot becomes **Add to deck**.
 *
 * A **fixture of the editor, not a dismissible layer**: Escape pressed in here belongs to the
 * card detail pane, which listens on `window` in the bubble phase, and the way to put the
 * panel away is the disclosure control it names itself by. The one dismissible thing inside it
 * is the set picker's listbox, which is already an `"inner"` layer of its own.
 *
 * The tiles stay selectable, so the pane keeps working from inside the editor: clicking the
 * art opens the card exactly as it does on the search view, and the Add button beside it does
 * not.
 */
export function DeckSearchPanel({
  add,
  zones,
  targetZone,
  onTargetZoneChange,
}: DeckSearchPanelProps) {
  const [open, setOpen] = useState(true);
  const zoneFieldId = useId();

  const search = useCardSearch();
  const { query, rows, searchKey } = search;

  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const selectCard = useAppStore((s) => s.setSelectedCardId);

  /**
   * The disclosure, in both of its states — one control, one name, and `aria-expanded` for the
   * difference. Named for what it reveals rather than for what pressing it does, so the name
   * does not change under a reader who is looking for it.
   */
  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md text-xs text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        open ? "px-1 py-1" : "w-9 flex-col justify-start border border-border py-2",
        FOCUS,
      )}
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      {/* Down the rail when the panel is shut, so 36px of chrome still says what it is
          rather than leaving a bare icon to be guessed at. The words are the button's
          accessible name either way — `aria-label` would be a second, invisible copy of
          them, and a name that differs from the visible text is a control voice control
          cannot reach (WCAG 2.5.3). */}
      <span style={open ? undefined : { writingMode: "vertical-rl" }}>Search cards</span>
    </button>
  );

  if (!open) return toggle;

  const addFailure = add.isError ? ipcError(add.error) : null;
  // query-core keeps the pages it has when a fetch fails, so `isError` arrives with rows still
  // in hand — reading it as "show the error instead" would throw away results the reader is
  // part way through.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    // A `section`, not an `aside`: the card pane is the app's one complementary landmark, and
    // a second unnamed one would answer to the same role query.
    <section
      aria-label="Add cards"
      // One hairline down the left edge, and it is the only chrome the panel adds: the zone
      // columns beside it are bordered boxes and these controls sit on the page, so without it
      // the "Add to" select reads as part of the deck's own header row. Everything right of
      // the line is not your deck.
      className={cn("flex min-h-0 shrink-0 flex-col gap-2 border-l border-border pl-3", PANEL_WIDTH)}
    >
      <div className="flex shrink-0 items-center gap-2">
        {toggle}
        {/* The zone choice sits above the results rather than on each of them: it is the click
            path's answer to "where does this go", and therefore the keyboard's — which is what
            makes drag a shortcut in Task 14 rather than the only way in. */}
        <label htmlFor={zoneFieldId} className="ml-auto shrink-0 text-xs text-dim">
          Add to
        </label>
        <select
          id={zoneFieldId}
          value={targetZone}
          onChange={(e) => onTargetZoneChange(e.target.value as DeckZone)}
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {ZONE_LABEL[zone]}
            </option>
          ))}
        </select>
      </div>

      {addFailure && (
        <p
          role="alert"
          className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          Could not add that card — {addFailure}
        </p>
      )}

      <FilterBar search={search} layoutToggle={false} />

      {/* One live region, mounted for the life of the panel: a region that appears together
          with its text announces nothing, because there was no change to notice. */}
      <p
        role="status"
        className={cn(
          "shrink-0 text-xs",
          empty && failure ? "text-destructive" : "text-dim",
          empty && "py-8 text-center",
        )}
      >
        {summaryOf(search, failure)}
      </p>

      {!empty && failure && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0">
            {query.isFetchNextPageError ? "Could not load more cards" : "Could not refresh these"} —{" "}
            {failure}
          </span>
          {query.isFetchNextPageError && (
            <button
              type="button"
              onClick={() => void query.fetchNextPage()}
              className={cn(
                "ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-0.5",
                "transition-colors duration-150 hover:bg-destructive/20 motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Try again
            </button>
          )}
        </div>
      )}

      {!empty && (
        <CardGrid
          rows={rows}
          // The panel's own search, so a new one starts at the top of the wall rather than
          // wherever the last one was scrolled to.
          listKey={searchKey}
          minTileWidth={TILE_FLOOR}
          selectedId={selectedCardId}
          onSelect={selectCard}
          badge={(card) => <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />}
          action={(card) => (
            <button
              type="button"
              // Named for the card *and* where it is going: two tiles' buttons both called
              // "Add" are two controls a screen reader cannot tell apart, and the zone is the
              // one thing about this press that is not visible on the tile.
              aria-label={`Add ${card.name} to ${ZONE_LABEL[targetZone]}`}
              title={`Add to ${ZONE_LABEL[targetZone]}`}
              // Never disabled while a write is in flight, and that is the behaviour rather
              // than an omission: `deck_add_card` **folds into** the row it finds, so pressing
              // three times is three copies. Disabling would drop presses two and three, and
              // "press it again for another one" is how a deck gets built.
              onClick={() => add.mutate({ cardId: card.id, zone: targetZone, quantity: 1 })}
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-md border border-border text-dim",
                "transition-colors duration-150 motion-reduce:transition-none",
                "hover:border-accent hover:text-accent",
                FOCUS,
              )}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
          )}
          onNeedNextPage={() => {
            if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
              void query.fetchNextPage();
            }
          }}
        />
      )}
      {/* No `prefetchImages` effect, deliberately — the search view's warms a page of 50
          because a 1 200px wall shows forty tiles at once, and the reader is a scroll away from
          the rest. Two tiles per row is not that wall: `CardGrid`'s overscan already mounts the
          next two rows of `<img>`s, which is four images ahead of the reader by the same
          protocol and no round trip of its own. */}
    </section>
  );
}
