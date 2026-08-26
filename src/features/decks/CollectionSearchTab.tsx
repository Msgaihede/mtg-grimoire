import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { OwnedBadge } from "@/components/OwnedBadge";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardGrid } from "@/features/search/CardGrid";
import { FilterBar, type TrayCell } from "@/features/search/FilterBar";
import type { FormatFilterOption } from "@/features/search/useCardSearch";
import { COLLECTION_SORTS } from "@/features/collection/useCollection";
import { sortOptions } from "@/lib/options";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CollectionRow, type DeckCategory } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, autoCategoryFor } from "./autoCategory";
import { foldCopies, tileKeyOf, type CopyTile } from "./collectionTiles";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "./metaRows";
import { useCollectionSearch } from "./useCollectionSearch";

/**
 * How wide a tile is at 100 %, in px.
 *
 * `DeckSearchPanel`'s `TILE_BASE` for the card-search tab, spelled again here rather than
 * imported across, because the two tabs are two components and the shared value is the *panel's*
 * — see the note on the tab strip. Both walls also pass `zoomSection="deckSearch"`, so the reader
 * sizes this column once and gets that size on whichever tab they are on.
 */
const TILE_BASE = 150;

/**
 * Which of `FilterBar`'s tray cells this tab offers, and the three absences are each a fact about
 * a collection rather than a shortcut.
 *
 * - **No `owned`** — every row here is a copy the reader has. A filter whose two states select the
 *   same list is a control that reads as broken.
 * - **No `printings`** — that switch asks whether to fold a card's printings together, and these
 *   *are* the reader's printings. Folding them would hide which piece of cardboard is being moved.
 *   ({@link foldCopies} folds a printing's *conditions and folders* together, which is a different
 *   question and one the reader cannot get wrong: a tile's press picks the copy. The **finish** is
 *   not folded — a foil and a played nonfoil are two objects at two prices, and two tiles.)
 * - **`decks` in their place**, which is the one cell no other surface has and the whole of what
 *   this tab is for. See `FilterBar`'s own note on it.
 *
 * `set`, `format`, `rarity` and `price` are the card search's, drawn here over the reader's own
 * binder — the first three were already on the wire (`CollectionQuery extends CardFilters`) and
 * the band is `collection::scope`'s, banding the copy's own finish rather than the printing's
 * fallback chain.
 */
const COLLECTION_TRAY: readonly TrayCell[] = ["set", "format", "decks", "rarity", "price"];

/**
 * The orders this column can act on, alphabetically by the word on screen.
 *
 * **No pinned row, where the card search pins `Best match`.** There are no sortable headers here
 * to build a `Custom…` state out of — that option exists on the collection page because its
 * table's headers write the same state from the other end — and this list has no ranking to fall
 * back to: every value `sortSelection` can hold is one of these options, and the empty sort spec
 * reports as `name`, which is the row it really means.
 */
const COLLECTION_SORT_ROWS = sortOptions(COLLECTION_SORTS, (s) => s.label);

/**
 * What this tab calls its search box, and the `id` stem its labels bind through.
 *
 * **`Search your collection`, never `Search cards`** — the box beside it on the other tab is over
 * every printing Scryfall has published and this one is over the reader's own binder, so one name
 * on both would be the control lying about which list it narrows and a `getByLabelText` that
 * cannot tell the two apart. The words are the ones this tab drew before it shared `FilterBar`.
 *
 * The stem keeps the two rows' `id`s apart. Only one is mounted at a time — the panel's tabs are
 * two components — so it is a fence rather than a fix, which is the right time to build one.
 */
const COLLECTION_LABELS = { idStem: "deck-collection", search: "Search your collection" };

/**
 * As much of a row as the naming below reads, **with every field optional**.
 *
 * The optionality is the point rather than a convenience: `CollectionRow` types these as present,
 * and a type is a claim about the wire rather than a guarantee about the object in hand. Writing
 * the narrower shape down is also what says which fields naming a copy is allowed to depend on.
 */
type PartialCopy = Partial<
  Pick<CollectionRow, "name" | "setCode" | "collectorNumber" | "finish" | "condition">
>;

/**
 * What a row says about **which copy** it is: the printing, its finish and its grade — each left
 * out where the row does not carry it.
 *
 * **Every one of these is the entry's own column and none is joined from `cards`**, which is why
 * they are the facts an orphan — a copy whose printing has left the card database — still has:
 * they are denormalised onto the row at write time for exactly that. So a row missing one is a row
 * missing something the schema says is there, and the honest answer is to say the rest rather than
 * to invent a placeholder for it.
 *
 * **Reading them defensively is not only about a stub.** `row.setCode.toUpperCase()` threw during
 * render until 2026-08-23, and this is the tab the panel *opens* on — so one unexpected row was
 * the whole deck editor rather than one line.
 */
function copyFacts(row: PartialCopy): string[] {
  const printing = [row.setCode?.toUpperCase(), row.collectorNumber].filter(Boolean).join(" ");
  const finish = row.finish ? (FINISH_LABEL[row.finish as Finish] ?? row.finish) : null;
  const condition = row.condition
    ? (CONDITION_LABEL[row.condition as Condition] ?? row.condition)
    : null;
  return [printing, finish, condition].filter((fact): fact is string => Boolean(fact));
}

/**
 * The copy a press is about, named the way a press has to name it.
 *
 * The wall's grain is the printing, so two tiles never differ only in a parenthesis the way the
 * list this replaced did — but the **button** still names the copy rather than the tile, because
 * what it moves is one entry with a finish, a grade and a place, and that is the half of the press
 * a wall of art cannot draw.
 *
 * The parenthesis is dropped **whole** where there is nothing to put in it rather than drawn
 * empty: "Unknown card ()" reads as a rendering fault, where "Unknown card" reads as a row about a
 * card nothing knows the name of.
 */
function copyLabel(name: string, row: PartialCopy): string {
  const facts = copyFacts(row);
  return facts.length > 0 ? `${name} (${facts.join(", ")})` : name;
}

/**
 * Which pile a press on this tile files into — **decided before the press and named on the
 * button**, which is the promise the card-search tab's Add button already makes.
 *
 * Three steps. A named `targetCategoryId` the deck actually carries is the deck setting and is used
 * as it stands. Otherwise it is `autoCategoryFor`'s answer over the one fact a collection row
 * carries — its type line, which is the documented floor for a card whose oracle tags have never
 * been downloaded — matched against the piles the deck **already has**. Then the deck's main pile.
 *
 * **The third step exists only here, and it is the backend's doing rather than a shortcut.**
 * `deck_add_card` takes a category *name* and finds-or-creates; the id arm of `collection_to_deck`
 * refuses one that is not there (`CATEGORY_GONE`), so there is no id to send for a pile that does
 * not exist yet. What makes the fallback honest rather than a surprise is that the button names
 * it: a reader adding an Instant to a deck with no Instant pile is told "to Main deck" before they
 * press.
 *
 * `null` only for a deck with no categories at all, which `deck_create` makes impossible — it seeds
 * four piles in the same transaction as the deck — so it is the fence for a story or a test
 * mounting this tab bare rather than a state the editor can reach.
 */
export function landingCategory(
  categories: readonly DeckCategory[],
  targetCategoryId: number,
  row: Pick<CollectionRow, "typeLine">,
): DeckCategory | null {
  // **An id the deck's `categories` does not carry reads as `AUTO_CATEGORY`** — this folder's
  // `CLAUDE.md`, and it is a *read* rather than the repairing write an old clamp used to be:
  // `deck_category_delete` puts the deck row back to `0` itself, so what is left is the one commit
  // where the deck row and the category list disagree, and Auto is where the deck already is.
  const named =
    targetCategoryId === AUTO_CATEGORY
      ? undefined
      : categories.find((c) => c.id === targetCategoryId);
  if (named) return named;
  const wanted = autoCategoryFor({ typeLine: row.typeLine });
  return (
    categories.find((c) => c.name === wanted) ??
    categories.find((c) => c.kind === "main") ??
    categories[0] ??
    null
  );
}

/**
 * The reader's own binder, in the column beside the deck — **the tab this panel opens on**, and
 * the first thing in the app to call `collection_to_deck`.
 *
 * ## It is the card search's wall, over the collection
 *
 * Until 2026-08-24 this was a list of text rows, on the argument that a wall of art answers "which
 * card" while this tab has to answer "**which copy**": the grain was the printing, its finish, its
 * condition and the folder it sat in, and the last of those decides whether pressing Add costs
 * another deck a card. The argument was sound and the conclusion was wrong, for a reason no amount
 * of reasoning about grain reaches — **a reader picks a card by looking at it**. Two searches an
 * inch apart, one a wall of illustrations and one a column of 11px type, read as two different
 * applications rather than as two scopes of one search, and the tab this panel *opens* on was the
 * one that did not look like the app.
 *
 * So the wall is `CardGrid` — the same component, the same zoom section, the same tile — and the
 * grain question is answered where it can be answered without a picture: {@link foldCopies} folds
 * the copies of a printing **in one finish** into one tile and **{@link pickCopy} chooses which of
 * them a press moves**, desk before deck, real card before proxy, oldest entry first. What the
 * reader loses is picking between two copies they hold; what they keep is the guarantee that
 * mattered, which is that a copy another deck is holding is never taken silently.
 *
 * **The finish is not folded away, since 2026-08-26**: a foil and a played nonfoil of one printing
 * are two objects at two prices sharing only a set and a number, so they are two tiles — and the
 * chin under each can then quote its own money. The collection page's wall splits on the same
 * pair; two drawings of one collection that disagreed about what a tile *is* would be exactly the
 * drift the shared `CardGrid` exists to remove.
 *
 * ## Why it draws `FilterBar` (2026-08-25)
 *
 * It did not, for two days, and the reason was a type: `FilterBar`'s prop was a `CardSearch` —
 * `ReturnType<typeof useCardSearch>` — and that hook *is* a `search_cards` with no `enabled` to
 * switch it off, so reaching for the component would have run the 116 k-row card search for every
 * reader who never leaves their binder. That is the exact cost `DeckSearchPanel`'s two-component
 * split exists to have removed, and it is still removed: the hook here is
 * {@link useCollectionSearch} and nothing on this tab touches the card search.
 *
 * What was wrong was the *fence*, not the conclusion. The row this drew instead was built out of
 * `@/components/FilterChips` the sanctioned way — which is still the right module boundary, and is
 * still how `PrintingsFilterBar` is built — but it was the same arrangement of the same controls
 * as the tab next to it, written twice, and a reader switching tabs met two different filter rows.
 * `FilterBar`'s prop is a structural `FilterSurface` now, which both hooks satisfy, so the two tabs
 * are one control over two backends. {@link COLLECTION_TRAY} is where this tab says which of its
 * cells it offers.
 */
export function CollectionSearchTab({
  categories,
  deckId,
  targetCategoryId,
  defaultFormat,
}: {
  /** The open deck's piles — where a copy may land. */
  categories: readonly DeckCategory[];
  /**
   * The deck the copies move **into** — what `collection_to_deck` is addressed with.
   *
   * **The editor's own id, threaded through the panel**, and it replaces a working inference:
   * this read `categories[0]?.deckId` for a day, on the true observations that every category of
   * one deck carries the same id and that `deck_create` seeds four piles in the deck's own
   * transaction. What was wrong with it is not that it answered incorrectly — it is that a list
   * of *piles* is a different fact from *which deck this is*, so an empty list (a story, a query
   * that has not landed) silently turned the write off instead of being a state nobody has to
   * think about. The fact was in hand one component up the whole time.
   */
  deckId: number;
  /** The deck's `default_category_id` — {@link AUTO_CATEGORY} for "by what the card does". See
   *  {@link landingCategory} for the one way this tab's resolution differs from an ordinary add. */
  targetCategoryId: number;
  /** The format the wall opens on — the deck's, already fenced by `spec.hasLegalityData` in
   *  `DeckEditor`. A default and never a constraint. */
  defaultFormat?: FormatFilterOption | null;
}) {
  const tip = useTooltip();
  const search = useCollectionSearch({ deckId, defaultFormat });
  const { query, rows, move, sourceOf, marketplace } = search;

  /**
   * Read here rather than handed down: the root's own `selectedCardId` is for the caret effect,
   * and this is the wall's selection. One field, two subscriptions, no round trip either side.
   */
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  /**
   * The finish the pane was opened as — the other half of which **tile** is the open one.
   *
   * A tile here is a printing *and* a finish, so the card id alone names two of them and the ring
   * would be on both. Read beside `selectedCardId` and joined with it by {@link tileKeyOf}.
   */
  const paneFinish = useAppStore((s) => s.paneFinish);
  /**
   * **`openCardFromDeckSearch`, not `setSelectedCardId`** — the one write in the app that says a
   * card was opened from *this* column, so the editor draws the card pane over the **deck**
   * attached to this column's left edge rather than over the search itself (issue #183). The
   * card-search tab beside this one has always done it; a wall that covered its own results when
   * you pressed a tile would be the same failure on the other tab.
   *
   * **It carries the finish since 2026-08-26**, which is why it is that opener widened rather than
   * `openCardAsFinish` borrowed: the second sets `paneFromDeckSearch: false` and would draw the
   * pane over this very column. The two facts are written in one `set`, so the pane can never be
   * told it came from here as one finish and from somewhere else as another.
   */
  const selectCard = useAppStore((s) => s.openCardFromDeckSearch);

  /**
   * The printing whose copies are all in **other decks**, waiting on an answer — `null` when
   * nothing is being asked.
   *
   * One at a time, by construction: a second press replaces the question rather than opening a
   * second one, which is the context menu's rule and the right one here for the same reason. The
   * tile itself rather than its id, so the question can quote the copy and the deck without
   * looking either back up in a list the answer is about to change.
   */
  const [asking, setAsking] = useState<CopyTile | null>(null);

  /**
   * What the last move took, and from where — `MoveOutcome.fromDeck` and `.quantity`, read rather
   * than assumed.
   *
   * The deck it came out of is the one thing about this press the reader cannot see for
   * themselves, because they are looking at the deck it went *into*. `quantity` is the number that
   * actually moved, which is not always the one that was asked for.
   */
  const took = move.data?.fromDeck ? move.data : null;

  const failure = move.isError ? ipcError(move.error) : null;
  const listFailure = query.isError ? ipcError(query.error) : null;

  /**
   * The wall's rows — every copy folded to one tile per printing.
   *
   * A memo because `CardGrid` virtualises off this array's identity, and because `sourceOf` is one
   * `find` over the folder census per row. Both inputs are held still by the hook, so this refolds
   * when a page lands or the census answers and not on every keystroke.
   */
  const tiles = useMemo(() => foldCopies(rows, sourceOf), [rows, sourceOf]);
  const empty = tiles.length === 0;

  /** Send it. The confirm — where there is one — has already been answered by the time this runs. */
  const commit = (tile: CopyTile, categoryId: number) => {
    setAsking(null);
    if (tile.add) move.mutate({ row: tile.add, categoryId, quantity: 1 });
  };

  /**
   * Every tile's finish, as `CardArt`'s chip reads it.
   *
   * Module-scope-stable through `useCallback` with no dependencies, which `CardGrid` asks for at
   * this prop: a fresh arrow per render tears down and rebuilds every tile's drag registration on
   * every scrolled row.
   */
  const tileFinish = useCallback((tile: CopyTile) => tile.finish, []);

  return (
    // A fragment, so these stay flex children of the panel's own column — `OpenPanel`'s rule, and
    // the reason the two tab bodies are interchangeable at that call site at all.
    <>
      {/* Grown into place rather than shoved in, exactly as the card tab's add banner is: this
          panel is a fixed-width column of stacked rows, so a banner at the top of it pushes
          everything below it down together. The animated element carries only `overflow-hidden` —
          `statusLine` takes `height` to 0, and a box with its own padding can never be shorter
          than that padding. */}
      <AnimatePresence initial={false}>
        {failure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              Could not move that copy — {failure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The card-search tab's own row, over this tab's backend — see the note on this component
          for why that is one component now and was two until 2026-08-25. `layoutToggle={false}`
          for `OpenPanel`'s reason: this wall has no table to switch to, so the pair would move the
          *search view's* stored preference and change nothing the reader can see. */}
      <FilterBar
        search={search}
        sortRows={COLLECTION_SORT_ROWS}
        tray={COLLECTION_TRAY}
        labels={COLLECTION_LABELS}
        layoutToggle={false}
      />

      {/**
       * The question, **above the wall rather than under the tile it was asked from**.
       *
       * It was drawn under its own row while this tab was a list, which is `ClearCategory`'s shape
       * and the better place for it — a confirmation belongs next to the thing it is about. A
       * folded tile has no row to sit under: putting it inside the grid would reflow the wall
       * around the card the reader is aiming at, and `CardGrid` virtualises, so a tile scrolled out
       * from under an open question would unmount it mid-answer.
       *
       * So it takes the banner's place, in the same `statusLine` grow-in the failure above uses,
       * and **quotes the copy and the deck by name** — which is what makes the position survivable:
       * the question never depended on the reader remembering which tile they pressed, because it
       * has always had to say whose card it is taking.
       *
       * This app's confirmations carry no `dialog` or `alertdialog` role at all, and the caret goes
       * into the *question* rather than onto a button in it — the reader has not decided yet and a
       * stray Enter must not decide for them.
       */}
      <AnimatePresence initial={false}>
        {asking && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <Confirm
              tile={asking}
              lands={landingCategory(categories, targetCategoryId, asking)}
              pending={move.isPending}
              onCancel={() => setAsking(null)}
              onConfirm={(categoryId) => commit(asking, categoryId)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/**
       * One live region, mounted for as long as this tab is — a region that appears together with
       * its text announces nothing, because there was no change to notice.
       *
       * **It carries the result of the last move as well as the count**, and that is why there is
       * one region here rather than two: two live regions in a 193px column both announce, in an
       * order nothing controls, and the second would be mounted only when it has something to say
       * — which is the failure this comment opens with.
       */}
      <p
        role="status"
        className={cn(
          "shrink-0 text-xs",
          empty && listFailure ? "text-destructive" : "text-dim",
          empty && "py-8 text-center",
        )}
      >
        {took && (
          <span className="text-text">
            Took {plural(took.quantity, "copy", "copies")} from {took.fromDeck}.{" "}
          </span>
        )}
        {listFailure
          ? `Could not read your collection — ${listFailure}`
          : query.isPending
            ? "Reading your collection…"
            : empty
              ? "No copies match"
              : // **Cards, and the word changed with the fold.** It counted *matches* while a row
                // was one printing in one finish, one condition and one folder; a tile is a
                // printing, so what is drawn is cards and `search.total` — which is still the
                // backend's row count — is no longer the same number. Saying "N cards" over a
                // total of rows would be two units in one sentence, so the caption counts what is
                // on screen and says whether there is more.
                `${plural(tiles.length, "card", "cards")}${query.hasNextPage ? " — scroll for more" : ""}`}
      </p>

      {!empty && (
        <CardGrid
          rows={tiles}
          label="Your collection"
          // The panel's own search, so a new one starts at the top of the wall rather than
          // wherever the last one was scrolled to.
          listKey={search.queryKeyString}
          // **The card-search tab's section, shared deliberately.** The two tabs are one column and
          // one press apart, so a reader who sized the cards on one has sized the cards they are
          // looking at — a second key here would make switching tabs resize the wall.
          zoomSection="deckSearch"
          // Its **own** scope, where the zoom above is deliberately shared: a size is a fact about
          // the column, and a picked set is a fact about a particular list of cards. Switching
          // tabs puts the other tab's set down, which is right — the rows are different rows.
          selectionScope="deck-collection"
          baseTileWidth={TILE_BASE}
          // **A tile's key, not a card id** — `CardGrid` compares this against `card.key ?? card.id`
          // and every tile here carries a key, so the pane's card id alone would match nothing and
          // ring nothing at all, silently. Composed through the same {@link tileKeyOf} the fold
          // stamps, so the two strings cannot drift apart.
          selectedId={selectedCardId === null ? null : tileKeyOf(selectedCardId, paneFinish)}
          // The finish travels with the press, so the pane opens showing the object the reader
          // pointed at rather than the plain one — and so the ring above lands on the tile they
          // pressed rather than on its sibling. The tile is `CardGrid`'s second argument because a
          // tile here is a printing *and* a finish; the wall itself knows nothing about finishes.
          onSelect={(cardId, tile) => selectCard(cardId, tile.finish)}
          finish={tileFinish}
          // What one copy of this printing **in this finish** costs — the tile's own figure, so a
          // foil tile and the nonfoil beside it quote different money, which is the whole reason
          // they are two tiles. `CollectionRow.unitPrice` is already per copy, per finish, at the
          // marketplace this hook's query named, so nothing here recomputes or converts it, and a
          // printing the marketplace does not quote draws an em dash rather than borrowing
          // another one's number.
          money={(tile) => formatPrice(tile.unitPrice, marketplace.currency)}
          // The copies behind the art, in the corner the collection page's own wall marks them in.
          // No `wishlisted`: this wall shows what is owned and has no opinion about what is wanted.
          badge={(tile) => <OwnedBadge owned={tile.copies} />}
          action={(tile) => (
            <AddButton
              tile={tile}
              lands={landingCategory(categories, targetCategoryId, tile)}
              tip={tip}
              onAsk={setAsking}
              onCommit={commit}
            />
          )}
          onNeedNextPage={() => {
            if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
              void query.fetchNextPage();
            }
          }}
        />
      )}

      {/* **The failure that arrives with rows still on screen.** query-core keeps the pages it has
          when a fetch fails, so this is drawn under the wall rather than instead of it — the same
          split the card tab makes, and the reason the caption above cannot carry it. */}
      {!empty && listFailure && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {query.isFetchNextPageError ? "Could not load more copies" : "Could not refresh these"} —{" "}
          {listFailure}
        </p>
      )}
    </>
  );
}

/**
 * One tile's press — the control that puts a copy in the deck.
 *
 * Its own component so the two names it carries are built in one place, and so the three
 * {@link CopySource} answers are branched on exactly once.
 */
function AddButton({
  tile,
  lands,
  tip,
  onAsk,
  onCommit,
}: {
  tile: CopyTile;
  lands: DeckCategory | null;
  tip: ReturnType<typeof useTooltip>;
  onAsk: (tile: CopyTile) => void;
  onCommit: (tile: CopyTile, categoryId: number) => void;
}) {
  const copy = tile.add ? copyLabel(tile.name, tile.add) : tile.name;

  /**
   * Why this tile cannot be pressed, or `null`.
   *
   * Two of them, and both are said in the button's **name** rather than only in a tooltip: a
   * greyed control whose name has not changed reads as a control that broke, and a hover sentence
   * is not something a keyboard reader can produce (`src/CLAUDE.md`'s greyed-row rule).
   */
  const refusal =
    tile.add === null
      ? `${tile.name} is already in this deck`
      : lands === null
        ? `${tile.name} — this deck has no pile to file it in`
        : null;

  /**
   * **Where the copy is coming from** — the fact the list this replaced drew on every row, and the
   * one thing about this press that a picture cannot show.
   *
   * It is on the button rather than in the caption because the caption is `SET · number` on both
   * tabs and that parity is the whole point of the wall; and because this is a fact about the
   * *press* rather than about the card. Two shapes, and the difference is what the press costs:
   * a deck's group is named as a **taking** (`from Mono-Red Aggro`), because that deck loses the
   * card, and a drawer the reader made is named as a place (`in Serah`), because nothing loses
   * anything.
   *
   * **The root says nothing at all, which reverses the list's rule rather than forgetting it.**
   * That list drew the place in a *cell*, where blank reads as data that failed to arrive, so the
   * root was written out in words. This is a button's **name**, where there is no cell to leave
   * empty — and the root is where most copies sit, so naming it would add four words to nearly
   * every control on the wall to say "filed nowhere in particular".
   */
  const place =
    tile.from === null || tile.add === null
      ? null
      : tile.from.kind === "otherDeck"
        ? { taking: true, name: tile.from.deckName ?? "another deck" }
        : tile.add.folderName
          ? { taking: false, name: tile.add.folderName }
          : null;

  const where = place ? (place.taking ? `taking it from ${place.name}` : `in ${place.name}`) : null;

  return (
    <button
      type="button"
      // The tile is draggable and this is its one control: a press that slips a few pixels is a
      // press, not a drag (`cardDraggable`).
      data-no-drag=""
      // `aria-disabled`, never `disabled`: a disabled button leaves the tab order, which would put
      // the reason on a hover a keyboard reader cannot perform.
      aria-disabled={refusal ? true : undefined}
      aria-label={refusal ?? `Add ${copy} to ${lands?.name}${where ? ` — ${where}` : ""}`}
      {...tip(
        refusal ??
          (place
            ? place.taking
              ? `Take from ${place.name} → ${lands?.name}`
              : `Add to ${lands?.name} — your copy in ${place.name}`
            : `Add to ${lands?.name}`),
        { describes: false },
      )}
      // **Never disabled while a write is in flight**, exactly as the card tab's Add button is
      // not: `collection_to_deck` folds into the deck row it finds, so pressing twice is two
      // copies — and "press it again for another one" is how a deck gets built.
      onClick={() => {
        if (refusal || !lands || !tile.add) return;
        // The one branch this whole tab is about: a copy another deck is holding is asked about
        // first, because confirming takes it out of that deck's *list* as well as its group — and
        // that deck is not on screen. `pickCopy` has already preferred a desk copy where the
        // reader has one, so this is reached only when every copy is spoken for.
        if (tile.from?.kind === "otherDeck") onAsk(tile);
        else onCommit(tile, lands.id);
      }}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border border-border text-dim",
        "transition-colors duration-150 motion-reduce:transition-none",
        refusal ? "cursor-not-allowed opacity-45" : "hover:border-accent hover:text-accent",
        FOCUS,
      )}
    >
      <Plus className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * "This copy is in Mono-Red Aggro. Move it to this deck?"
 *
 * **The name of the other deck is the load-bearing half.** The side effect of saying yes lands
 * somewhere the reader is not looking: the copies leave that deck's group *and* its live list, so
 * a deck they have not opened is one card shorter afterwards. A question that said only "are you
 * sure" would be asking about a consequence it had not stated.
 *
 * **It names the card too, which the row-anchored version did not have to.** Drawn above the wall
 * it is no longer adjacent to the tile it was asked from, so the sentence carries the identity the
 * position used to.
 *
 * `CONFIRM_DESTRUCTIVE` on the affirmative, which reads oddly for an *add* and is right: what is
 * being confirmed is the subtraction from the other deck, and that is the part that cannot be
 * undone by pressing something else on this screen.
 */
function Confirm({
  tile,
  lands,
  pending,
  onCancel,
  onConfirm,
}: {
  tile: CopyTile;
  lands: DeckCategory | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (categoryId: number) => void;
}) {
  const confirm = useConfirmFocus(`Move ${tile.name} into this deck`);
  const deckName = tile.from?.deckName ?? "another deck";

  return (
    <div
      {...confirm}
      className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5"
    >
      <p className="text-[0.6875rem] leading-relaxed text-destructive">
        Your copy of “{tile.name}” is in “{deckName}”. Moving it here takes it off that deck’s list
        too.
      </p>
      {lands && <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">It lands in {lands.name}.</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          // `aria-disabled` rather than the attribute, so the button that is about to be pressed
          // again does not leave the tab order under the reader's caret mid-write.
          aria-disabled={pending || !lands ? true : undefined}
          onClick={() => {
            if (pending || !lands) return;
            onConfirm(lands.id);
          }}
          className={CONFIRM_DESTRUCTIVE}
        >
          Move it here
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Leave it there
        </button>
      </div>
    </div>
  );
}
