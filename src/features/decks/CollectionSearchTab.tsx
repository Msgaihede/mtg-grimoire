import { useState } from "react";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FILTER_CONTROL, FILTER_FIELD, FILTER_FOCUS, ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FORMATS, type FormatFilterOption } from "@/features/search/useCardSearch";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CollectionRow, type DeckCategory } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, autoCategoryFor } from "./autoCategory";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "./metaRows";
import { useCollectionSearch, type CopySource } from "./useCollectionSearch";

/** What the root of the collection is called on a row, in words. **Never a blank cell** — an
 *  empty "where is this filed" line reads as data that failed to arrive, where the root is a
 *  real and extremely ordinary place for a copy to be. */
const ROOT_LABEL = "Collection";

/**
 * What a card with no name is called — the collection page's `—` said in words, because this one
 * goes into an Add button's accessible name rather than into a cell.
 */
const UNKNOWN_CARD = "Unknown card";

/**
 * As much of a row as the two things below read, **with every field optional**.
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
 * the whole deck editor rather than one line. The collection page has always drawn an orphan
 * instead of crashing on one (`CollectionTable`'s `—`); this list now agrees with it.
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
 * One copy, named the way a *press* has to name it.
 *
 * The list's grain is the printing, its finish and its condition, so two rows of one card differ
 * only in the parenthesis — and the Add buttons on those two rows are two controls a screen reader
 * would otherwise be unable to tell apart. `CardGrid`'s "Add \<card\> to \<pile\>" rule, over a
 * row that carries three more facts than a search tile does.
 *
 * The parenthesis is dropped **whole** where there is nothing to put in it rather than drawn
 * empty: "Unknown card ()" reads as a rendering fault, where "Unknown card" reads as a row about a
 * card nothing knows the name of.
 */
function copyLabel(row: PartialCopy): string {
  const name = row.name ?? UNKNOWN_CARD;
  const facts = copyFacts(row);
  return facts.length > 0 ? `${name} (${facts.join(", ")})` : name;
}

/**
 * Which pile a press on this row files into — **decided before the press and named on the button**,
 * which is the promise the card-search tab's Add button already makes.
 *
 * Three steps. A named `targetCategoryId` the deck actually carries is the deck setting and is used
 * as it stands. Otherwise it is `autoCategoryFor`'s answer over the one fact a collection row
 * carries — its type line, which is the documented floor for a card whose oracle tags have never
 * been downloaded — matched against the piles the deck **already has**. Then the deck's main pile.
 *
 * **The third step exists only here, and it is the backend's doing rather than a shortcut.**
 * `deck_add_card` takes a category *name* and finds-or-creates; `collection_to_deck` takes a
 * category **id** and refuses one that is not there (`CATEGORY_GONE`), so there is no id to send for
 * a pile that does not exist yet. What makes the fallback honest rather than a surprise is that the
 * button names it: a reader adding an Instant to a deck with no Instant pile is told "to Main deck"
 * before they press.
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
 * ## What it draws, and why it is not `CardGrid`
 *
 * A wall of art answers "which card", and this list answers "**which copy**". The grain is the
 * printing, its finish, its condition and the folder it sits in, and the last of those is the whole
 * point: the same printing filed in two places is two rows, and which one the reader adds decides
 * whether another deck loses a card. None of that survives a tile, so this is a list of text rows.
 *
 * ## Why it does not draw `FilterBar`
 *
 * `FilterBar`'s prop is a `CardSearch` — `ReturnType<typeof useCardSearch>` — and that hook *is* a
 * `search_cards`, with no `enabled` to switch it off. Drawing it here would run the 116 k-row card
 * search for every reader who never leaves their binder, which is the exact cost the two-component
 * split in `DeckSearchPanel` exists to have removed. So this row is built out of
 * `@/components/FilterChips`, which is the sanctioned reuse: that module owns the controls, and
 * each surface owns which of them it offers and how they lay out. `CollectionFilterBar` is the
 * other surface that does this, for the same reason.
 *
 * The row is deliberately three controls rather than the collection page's thirty: this column is
 * ~193px wide at {@link MIN_PANEL_WIDTH_PX} and the reader is looking for a card they already have
 * in mind. It wraps, which is what makes that width safe (`src/CLAUDE.md`).
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
  /** The format the list opens on — the deck's, already fenced by `spec.hasLegalityData` in
   *  `DeckEditor`. A default and never a constraint. */
  defaultFormat?: FormatFilterOption | null;
}) {
  const search = useCollectionSearch({ deckId, defaultFormat });
  const { query, rows, move } = search;

  /**
   * The row whose copies are in **another deck**, waiting on an answer — `null` when nothing is
   * being asked.
   *
   * One at a time, by construction: a second press replaces the question rather than opening a
   * second one, which is the context menu's rule and the right one here for the same reason. The
   * row itself rather than its id, so the question can quote the copy without looking it back up
   * in a list the answer is about to change.
   */
  const [asking, setAsking] = useState<CollectionRow | null>(null);

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
  const empty = rows.length === 0;

  /** Send it. The confirm — where there is one — has already been answered by the time this runs. */
  const commit = (row: CollectionRow, categoryId: number) => {
    setAsking(null);
    move.mutate({ row, categoryId, quantity: 1 });
  };

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

      {/* `flex-wrap` is what makes this row safe at the panel's 206px floor, where the content box
          is ~193px: a flex item cannot shrink below its own min-content, so unwrapped this is an
          *overhang*, and `DeckEditor`'s page section computes `overflow-x` to `auto` — a
          horizontal scrollbar across the whole deck builder, which the app's 1024px floor forbids.
          `src/CLAUDE.md` carries the rule; `ManaValueChips` shipped it once already. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label htmlFor="deck-collection-text" className="sr-only">
          Search your collection
        </label>
        <input
          id="deck-collection-text"
          type="search"
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          placeholder="Search your collection…"
          // `FILTER_FIELD` rather than `FILTER_CONTROL`: a box the reader types into must not dip
          // under the press, or Chromium's own ✕ slides out from under the pointer clearing it
          // (issue #179 — the reason is on the constant).
          className={cn(
            FILTER_FIELD,
            FILTER_FOCUS,
            "min-w-32 flex-1 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
          )}
        />

        {/* **The toggle this tab exists for.** Pressed is the default and means "only the copies
            no deck is holding" — the root, a drawer the reader made, and `Recently removed`, which
            are the three places a card is still on the desk. Unpressed shows the spoken-for copies
            too, and pressing Add on one of those is what the confirmation below is for.

            One chip rather than a segmented pair: it is one axis with two ends and `aria-pressed`
            is how this app says that (`ToggleChip`, `TabStrip`, the Owned chip). The `hint` is
            folded into the accessible name, so the visible words are contained in it (WCAG
            2.5.3). */}
        <ToggleChip
          label="Not in a deck"
          hint="only the copies no deck is holding"
          pressed={search.allocation === "unallocated"}
          onClick={() =>
            search.setAllocation(search.allocation === "unallocated" ? "all" : "unallocated")
          }
        />

        <label htmlFor="deck-collection-format" className="sr-only">
          Format
        </label>
        <select
          id="deck-collection-format"
          value={search.format}
          onChange={(e) => search.setFormat(e.target.value)}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "bg-surface px-2",
            search.format ? "border-accent text-accent" : "border-border text-dim",
          )}
        >
          {/* Pinned above the sorted list because it is the *absence* of this filter rather than a
              format — `CollectionFilterBar`'s own note, and the same trap: it happens to sort
              first today, so nothing on screen tells the two apart. */}
          <option value="">Any format</option>
          {sortOptions(FORMATS, (f) => f.label).map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

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
              : // **Matches, not copies and not cards**, and the word is chosen rather than
                // loose: `CollectionPage.total` counts *rows*, and a row here is one printing in
                // one finish, one condition and one folder — so it is neither a card (two rows
                // can be one card) nor a copy (one row can hold four). The second half appears
                // only while there is more to fetch, so a fully loaded list reads as one number.
                rows.length < search.total
                ? `${plural(search.total, "match", "matches")} — ${rows.length} shown`
                : plural(search.total, "match", "matches")}
      </p>

      {!empty && (
        // `min-h-0` so the list is what scrolls rather than the panel: a flex item's default
        // `min-height: auto` is its content, which would push the column past its own height.
        // `relative` because a scroll container has to be the containing block for its own
        // absolutely positioned content — `.sr-only` is `position: absolute`, and one with no
        // positioned ancestor stretches the *document* (`src/CLAUDE.md`).
        <ul className="relative min-h-0 flex-1 space-y-1 overflow-y-auto">
          {rows.map((row) => (
            <CopyRow
              key={row.id}
              row={row}
              source={search.sourceOf(row)}
              lands={landingCategory(categories, targetCategoryId, row)}
              asking={asking?.id === row.id}
              onAsk={setAsking}
              onCommit={commit}
              pending={move.isPending}
            />
          ))}
        </ul>
      )}

      {/* One press rather than a scroll sentinel: this column is sixty rows deep before it needs
          asking again, and a reader who has not found their card by then narrows the filter. */}
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className={cn(
            "shrink-0 rounded-md border border-border px-2 py-1 text-xs text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Show more
        </button>
      )}
    </>
  );
}

/**
 * One copy, with the press that puts it in the deck.
 *
 * Its own component so the confirmation can be a piece of state per row without the list holding a
 * map of them — and so the three sources ({@link CopySource}) are branched on in exactly one place.
 */
function CopyRow({
  row,
  source,
  lands,
  asking,
  onAsk,
  onCommit,
  pending,
}: {
  row: CollectionRow;
  source: CopySource;
  lands: DeckCategory | null;
  asking: boolean;
  onAsk: (row: CollectionRow | null) => void;
  onCommit: (row: CollectionRow, categoryId: number) => void;
  pending: boolean;
}) {
  const tip = useTooltip();
  const copy = copyLabel(row);
  /**
   * The row's own line of facts — {@link copyFacts} plus how many copies it holds.
   *
   * Joined here rather than drawn as separate children, which is what lets a missing fact be
   * *absent* rather than leave a stranded separator: "LEA 161 · · NM" is worse than "LEA 161 ·
   * NM", and both are worse than the crash this used to be.
   */
  const facts = [
    ...copyFacts(row),
    typeof row.quantity === "number" ? `×${row.quantity}` : null,
  ].filter((fact): fact is string => fact !== null);

  /**
   * Why this row cannot be pressed, or `null`.
   *
   * Two of them, and both are said in the button's **name** rather than only in a tooltip: a
   * greyed control whose name has not changed reads as a control that broke, and a hover sentence
   * is not something a keyboard reader can produce (`src/CLAUDE.md`'s greyed-row rule).
   */
  const refusal =
    source.kind === "here"
      ? `${copy} is already in this deck`
      : lands === null
        ? `${copy} — this deck has no pile to file it in`
        : null;

  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Direct text children on each line, no wrapping spans: they are read as one string by
              a screen reader and are the row's whole content. */}
          <p className="truncate text-xs">{row.name ?? UNKNOWN_CARD}</p>
          <p className="truncate text-[0.6875rem] text-dim">{facts.join(" · ")}</p>
          {/* **Where the copies are filed** — the half of this list a wall of art could not draw,
              and the fact that decides whether pressing Add costs another deck a card. */}
          <p className="truncate text-[0.6875rem] text-dim">{row.folderName ?? ROOT_LABEL}</p>
        </div>

        <button
          type="button"
          // `aria-disabled`, never `disabled`: a disabled button leaves the tab order, which would
          // put the reason on a hover a keyboard reader cannot perform.
          aria-disabled={refusal ? true : undefined}
          aria-label={refusal ?? `Add ${copy} to ${lands?.name}`}
          {...tip(refusal ?? `Add to ${lands?.name}`, { describes: false })}
          // **Never disabled while a write is in flight**, exactly as the card tab's Add button is
          // not: `collection_to_deck` folds into the deck row it finds, so pressing twice is two
          // copies — and "press it again for another one" is how a deck gets built.
          onClick={() => {
            if (refusal || !lands) return;
            // The one branch this whole tab is about: a copy another deck is holding is asked
            // about first, because confirming takes it out of that deck's *list* as well as its
            // group — and that deck is not on screen.
            if (source.kind === "otherDeck") onAsk(row);
            else onCommit(row, lands.id);
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
      </div>

      {/**
       * The question, drawn **under the row it was asked from** and not as a layer.
       *
       * `ClearCategory`'s shape, and this app's confirmations carry no `dialog` or `alertdialog`
       * role at all — the caret goes into the *question* rather than onto a button in it, because
       * the reader has not decided yet and a stray Enter must not decide for them.
       */}
      {asking && lands && (
        <Confirm
          copy={copy}
          deckName={source.deckName}
          pile={lands.name}
          pending={pending}
          onCancel={() => onAsk(null)}
          onConfirm={() => onCommit(row, lands.id)}
        />
      )}
    </li>
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
 * `CONFIRM_DESTRUCTIVE` on the affirmative, which reads oddly for an *add* and is right: what is
 * being confirmed is the subtraction from the other deck, and that is the part that cannot be
 * undone by pressing something else on this screen.
 */
function Confirm({
  copy,
  deckName,
  pile,
  pending,
  onCancel,
  onConfirm,
}: {
  copy: string;
  deckName: string | null;
  pile: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirm = useConfirmFocus(`Move ${copy} into this deck`);

  return (
    <div {...confirm}>
      <p className="text-[0.6875rem] leading-relaxed text-destructive">
        This copy is in “{deckName ?? "another deck"}”. Moving it here takes it off that deck’s
        list too.
      </p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">It lands in {pile}.</p>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
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
