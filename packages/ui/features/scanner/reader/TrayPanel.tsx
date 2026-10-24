import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  Archive,
  ArrowDown,
  ChevronUp,
  Ellipsis,
  Folder,
  FolderPlus,
  Layers,
  LayoutGrid,
  List as ListIcon,
  LoaderCircle,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { CardArt } from "@/components/CardArt";
import { CardImage } from "@/components/CardImage";
import { CountTag } from "@/components/CountTag";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FILTER_CONTROL, FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { CONDITION_LABEL, CONDITIONS, type Condition } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { buildFolderTree, type FolderNode } from "@/lib/folderTree";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { CARD_ASPECT, cardImageUrl, type ImageVariant } from "@/lib/images";
import { LAYER } from "@/lib/layers";
import type {
  ScannerTrayChoice,
  ScannerTrayFinish,
  ScannerTrayLayout,
  ScannerTrayRow,
} from "@/lib/ipc";
import { DURATION, PRESS, TRANSITION, seconds } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { TrayDestinationFace } from "../useTrayDestination";
import {
  NEW_FOLDER_LABEL,
  newFolderRefusal,
  useTrayNewFolder,
  type TrayNewFolder,
} from "../useTrayNewFolder";
import { ADD_CARD_LABEL } from "./AddCardDialog";
import {
  addLabel,
  addRefusal,
  deckRefusal,
  EMPTY_REASON,
  needsDecision,
  needsFinishCount,
  needYouLabel,
  NEXT_DECISION_LABEL,
  nextDecisionKey,
  pickChoice,
  readyRows,
  removeRow,
  setFinish,
  setQuantity,
  totalCopies,
} from "./tray";

// The Add button's words and the walk's name are `tray.ts`'s now — the light app's phone page says
// the same ones — and are handed on from here for the importers that found them in this file.
export { addLabel, NEXT_DECISION_LABEL };
import { isKnownFinish, TRAY_FINISH_LABEL, trayFinishChoices } from "./trayFinish";
import { trayWorth } from "./trayPrice";
import { useGridColumns } from "./useGridColumns";
import { useHeadLanded } from "./useHeadLanded";
import { useTrayPrices } from "./useTrayPrices";

export interface TrayPanelProps {
  rows: readonly ScannerTrayRow[];
  /**
   * An edit, as a function of the rows — **never** the rows this render drew. The page applies it
   * to the tray as it is at the moment of the press: the pump writes the newest card between two
   * renders, and an edit built from `rows` would write the tray back without it.
   */
  onRows: (update: (rows: ScannerTrayRow[]) => ScannerTrayRow[]) => void;
  folderId: number | null;
  onFolder: (id: number | null) => void;
  /**
   * The condition Add files every copy in — the stored `prefs.condition`, which the page hands
   * down and the panel holds no copy of, like the folder. **Drawn in the footer beside the folder**
   * because it is read at the press and nowhere else: a fact about where the cards are going, not
   * about how the camera reads them. Unread with a {@link destination}, which files no condition.
   */
  condition: Condition;
  /** The footer's *Condition* was set to another grade. */
  onCondition: (condition: Condition) => void;
  onCommit: () => void;
  /**
   * *Create deck…* was pressed, from the header's `⋯` menu; absent draws no row. `opener` is the
   * `⋯`, as for {@link onClearAll}.
   */
  onCreateDeck?: (opener: HTMLElement) => void;
  committing: boolean;
  commitError: string | null;
  onMorePrintings: (row: ScannerTrayRow) => void;
  /** The row just added or bumped, for the flash. */
  flashKey: string | null;
  /**
   * How the rows are drawn — a grid of card tiles, or the line-per-card list. The page stores the
   * choice in the scanner prefs and hands it down; the panel holds no copy, like the rows.
   */
  layout: ScannerTrayLayout;
  /** The header's toggle was pressed onto the *other* layout. */
  onLayout: (layout: ScannerTrayLayout) => void;
  /**
   * *Clear all…* was pressed — **a request, never the clear itself.** The page asks first, and it is
   * the page that has to: the tray is drawn inside the view's `@container/scan` box, which is the
   * containing block for anything `fixed`, so a confirmation mounted here would be a scrim the size
   * of this column (`packages/ui/CLAUDE.md`, the `@container` rule). `opener` is the header's `⋯`
   * — never the menu's own row, which goes with the menu — for the caret to come back to.
   */
  onClearAll: (opener: HTMLElement) => void;
  /**
   * *Archive* was pressed: the rows an Add would take, into the scan history and **not** into the
   * collection (issue #989) — the trade page's Archive, for a pile the reader wants a record of
   * and does not own. Absent draws no button, and so does a {@link destination}: an archive is the
   * Scanner view's own history, and a side of a trade is not a pile to keep a record of here.
   */
  onArchive?: () => void;
  /** The archive is in flight — {@link committing}'s counterpart, and greys the same controls. */
  archiving?: boolean;
  /**
   * *Add card…* was pressed — a card the camera will not read, to be searched for by hand (issue
   * #978). A request, like *Clear all…*, for the same `@container` reason: the page mounts the
   * dialog and pauses the scanner under it. Absent draws no button.
   */
  onAddCard?: (opener: HTMLElement) => void;
  /**
   * The tray is filing somewhere that is not the collection (`useTrayDestination.ts`) — a side of
   * a trade. **Absent is the Scanner view's tray, drawn exactly as it was before this prop.** With
   * one, the heading and the press take the destination's words, the rows are priced at its
   * marketplace, and the folder picker gives its place to the destination's own summary: a folder
   * is a question about the collection. `folderId` and `onFolder` are then unread, and the page
   * leaves `onCreateDeck` out.
   */
  destination?: TrayDestinationFace;
  /** One sentence about the tray as a whole, under the heading — the destination's warning that
   *  the tray held cards before this surface opened. `null` or absent draws nothing. */
  notice?: string | null;
}

/**
 * What *Archive* does, in its tooltip — the one thing a reader cannot tell from the word, since
 * the trade page's Archive is the only other one in the app and a trade is not the collection.
 */
export const ARCHIVE_TIP =
  "Keep these scans in Scan history without adding them to your collection";

/** The collection's own word for its top level — `AddToCollection`'s `rootLabel`, one tree over. */
const ROOT_LABEL = "Collection";

/**
 * A row's finish choices: **only the finishes its printing exists in** (issue #982), so a foil-only
 * card offers no Nonfoil, and `Unknown`.
 *
 * **Deliberately not through `sortOptions` — the order is the information.** A printing's finishes
 * read plain before the premium treatments everywhere in this app, and `Unknown` comes last because
 * it is not a finish: it is the answer "not yet", which a reader can also give on purpose to hold a
 * card out of the next Add without removing it.
 */
function finishOptions(row: ScannerTrayRow): DropdownOption[] {
  return trayFinishChoices(row.finishes).map((f) => ({ value: f, label: TRAY_FINISH_LABEL[f] }));
}

/**
 * How far a row the walk lands on is kept from the scroller's top edge when it is too tall to
 * centre — `p-3.5`, the grid scroller's own padding, which is the room a card's lift and focus
 * outline need inside the clip.
 */
const DECISION_ROOM_PX = 14;

/**
 * Bring a row into the middle of the tray's own scroller, and **only** that scroller.
 *
 * `scrollIntoView` would do the centring and also scroll every ancestor that can scroll, the app's
 * `main` among them — taking the camera half of the page away to centre a tray row. So the offset is
 * set on the one box instead: `offsetTop` is measured against the scroller because it is `relative`,
 * which both layouts already are for the flash. A row taller than the tray is shown from its top,
 * where its question starts. jsdom has no `scrollTo` on an element, hence the optional call.
 */
function scrollRowIntoTray(list: HTMLElement, row: HTMLElement) {
  const centre = (list.clientHeight - row.offsetHeight) / 2;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  list.scrollTo?.({
    top: row.offsetTop - Math.max(DECISION_ROOM_PX, centre),
    behavior: reduce ? "auto" : "smooth",
  });
}

/**
 * Take the tray's own scroller back to its top, where a card that has just landed is drawn — and,
 * like {@link scrollRowIntoTray}, **only** that scroller, so the camera beside it stays put.
 */
function scrollTrayToTop(list: HTMLElement) {
  if (list.scrollTop === 0) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  list.scrollTo?.({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/** The two layouts in the order the toggle draws them, and the word each is called by. */
const TRAY_LAYOUTS = [
  { id: "grid", label: "Grid", Icon: LayoutGrid },
  { id: "list", label: "List", Icon: ListIcon },
] as const satisfies readonly { id: ScannerTrayLayout; label: string; Icon: LucideIcon }[];

/**
 * The size a tile's card is fetched at, and a waiting tile's choices with it — a whole card, never
 * the `art` crop, for the row's reason: the printed credit is on the card and nowhere else here.
 *
 * **`grid` (488×680), not the row's `thumb` and not the walls' `display`.** A tile is 144px at the
 * column floor and about 220px just before the grid gains a column, so on a 200%-scaled display
 * it asks for up to ~440 device pixels — `thumb`'s 146 would be tripled into a blur, and
 * `display`'s 672 is sized for a wall the reader can zoom to 340px, which this grid never is. The
 * home page's recent-cards strip picks `grid` on the same arithmetic.
 */
const TILE_VARIANT: ImageVariant = "grid";

/**
 * The grid's column template — an inline style, never an arbitrary Tailwind value, which is the
 * app's rule for a column template.
 *
 * `auto-fill` over a 9rem floor is the design: the tray is a third of a wide view and a 25rem
 * column below that, so the count falls out of the width — two columns at the narrow end, three
 * or four at the wide one. **The floor is `min(9rem, 50% − half a gap)` rather than 9rem alone**
 * so a tray squeezed under two 9rem columns still draws two rather than one card the width of the
 * tray; it is exactly 9rem wherever two 9rem columns fit — which is every width the page draws the
 * tray at. The half gap is `gap-x-3`'s, so the two have to move together. A waiting tile lays its
 * candidates out on as many columns as it spans, with the same gap, so they are the size of the
 * tiles around them (issue #1004) — and on this template itself until the grid has been measured.
 */
const TILE_COLUMNS = "repeat(auto-fill, minmax(min(9rem, calc(50% - 0.375rem)), 1fr))";

/**
 * A card that is a button rises a little under the pointer or the caret, with a shadow under it —
 * what says "this card opens something" on a surface where the card is also a picture.
 *
 * `translate` is its own longhand in Tailwind v4, as `scale` is (see `PRESS_STILL`), so the list
 * names it rather than `transform`. Reduced motion keeps the shadow and drops the travel, the way
 * `CardArt`'s hover zoom drops its scale. **A waiting tile's candidates wear it, and a resolved
 * tile's picture does not**: that picture is the top of one bordered card that clips what is in it,
 * so it has nowhere to rise to, and the card as a whole cannot rise either — a transformed ancestor
 * is the containing block for a `fixed` descendant, and the finish picker in its chin opens its
 * panel from a `fixed` frame.
 */
const LIFT =
  "transition-[translate,box-shadow] duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none " +
  "hover:-translate-y-0.5 hover:shadow-lg focus-visible:-translate-y-0.5 focus-visible:shadow-lg " +
  "motion-reduce:hover:translate-y-0 motion-reduce:focus-visible:translate-y-0";

/** `HOB 193`, or `""` for a row with no printing to name — the spelling every card row uses. */
function printingOf(p: { setCode: string; collectorNumber: string }): string {
  return [p.setCode.toUpperCase(), p.collectorNumber].filter((part) => part !== "").join(" ");
}

/**
 * **What a row is called, and it has to be more than the card's name.** A tray is a pile of
 * scans, and two Forests from two sets are the ordinary case in it — so `Quantity of Forest`
 * twice on one screen is two controls a screen reader cannot tell apart and a `getByRole` cannot
 * either. The printing rides along wherever there is one.
 */
function rowLabel(row: ScannerTrayRow): string {
  const printing = row.choices.length > 0 ? "" : printingOf(row);
  return printing === "" ? row.name : `${row.name} — ${printing}`;
}

/** What a candidate is called — `<name> — <SET> <number>`, the same in both layouts. */
function choiceLabel(choice: ScannerTrayChoice): string {
  const printing = printingOf(choice);
  return printing === "" ? choice.name : `${choice.name} — ${printing}`;
}

/**
 * The review tray: every card the scanner has taken, newest first, and the one press that files
 * them all.
 *
 * **It draws `rows` in the order it is handed them.** The reducer in `tray.ts` is what keeps the
 * tray newest first, and a second ordering here would be a second answer to one question — the
 * first time they disagreed, a bumped row would jump.
 *
 * **Every write goes back through `onRows` as a reducer call waiting for its rows**, and the page
 * hands it the latest. The panel holds no copy of the rows, so the page is the one owner, and the
 * page is what persists the tray: a crash mid-session loses nothing a reader pressed. An edit built
 * from `rows` instead was one render old — a card the pump had just added and this panel had not
 * yet drawn was written away by the next press of a stepper.
 *
 * **The rows scroll and the header and footer do not.** A reader with forty cards scanned still has
 * the folder, the condition and the Add button in view, because those are what the tray is *for* —
 * and the header's figures with them: the copies, what they are worth at the tray's marketplace,
 * and how many still need the reader, as the press that walks to the next one. The tray-wide
 * presses that are not the point of it — *Create deck…*, *Archive*, *Clear all…* — wait in the
 * header's `⋯`.
 *
 * **Two layouts over one set of rows, and only the drawing differs.** The grid lays each card out
 * as a tile you can read at a glance — the wide tray's default — and the list is the line per card
 * the tray began as, for a reader who would rather see forty names than twelve pictures. Every
 * press in either goes through the same reducer call with the same control names, so a reader who
 * switches mid-pile loses nothing, and the empty sentence, the commit error and the footer are
 * drawn once for both.
 *
 * **Add files the rows with a known finish and leaves the rest** (`tray.ts`'s `commitPlan`), and
 * its label says both halves — `Add 8 to collection · 2 need a finish` — so the rows it leaves are
 * never a surprise. With nothing it could file it is refused, with the reason, like every other
 * state it cannot act in.
 */
export function TrayPanel({
  rows,
  onRows,
  folderId,
  onFolder,
  condition,
  onCondition,
  onCommit,
  onCreateDeck,
  committing,
  commitError,
  onMorePrintings,
  flashKey,
  layout,
  onLayout,
  onClearAll,
  onArchive,
  archiving = false,
  onAddCard,
  destination,
  notice = null,
}: TrayPanelProps) {
  const titleId = useId();
  const title = destination?.title ?? "Scanned cards";
  const tip = useTooltip();
  const copies = totalCopies(rows);
  // The rows still asking the reader something — a printing or a finish — which is what the
  // header's *N need you* counts and its walk stops at, one row per stop.
  const asking = rows.filter(needsDecision).length;
  const ready = totalCopies(readyRows(rows));
  const needsFinish = needsFinishCount(rows);
  // The order `commitPlan` refuses in, so the drawing and the press agree.
  const refusal = addRefusal(rows);
  // Add and Archive put the same rows away, so either one in flight holds every press that would
  // act on them — the commit's own state, widened.
  const busy = committing || archiving;
  const refused = refusal !== null || busy;

  // The walk's cursor: the row the last press landed on, by key — `nextDecisionKey` says why a key.
  // Read-only over `rows`, so it is free of `onRows`' rule: nothing here writes the tray.
  const [cursor, setCursor] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The grid's explicit column count, for a waiting tile's span — read off an empty probe with the
  // grid's template, since an `auto-fill` template decides it from the width and the grid's own
  // resolved template counts the implicit tracks an oversized span makes (`useGridColumns`).
  const [columnProbe, columns] = useGridColumns<HTMLLIElement>();
  // **A card that lands takes the tray back to its top** (issue #1320): the tray is newest first,
  // so a reader forty cards down would otherwise see nothing of the card they just scanned — not
  // its row, not its flash. A pick, a finish or a removal is no landing and scrolls nothing.
  useHeadLanded(rows, () => {
    if (listRef.current !== null) scrollTrayToTop(listRef.current);
  });
  const nextDecision = () => {
    const key = nextDecisionKey(rows, cursor);
    const list = listRef.current;
    if (key === null || list === null) return;
    setCursor(key);
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-tray-row]")).find(
      (el) => el.dataset.trayRow === key,
    );
    if (row === undefined) return;
    scrollRowIntoTray(list, row);
    // The caret goes to the question itself — the first candidate, or the finish — so the answer
    // is one key away. `preventScroll`, because the scroll above has already put the row where it
    // belongs and a focus scroll would only nudge it against the edge.
    row.querySelector<HTMLElement>("[data-decision] button")?.focus({ preventScroll: true });
  };

  // An archive is the Scanner view's own history, and a side of a trade is not a pile to keep a
  // record of here — so a destination draws no Archive whatever the page hands down.
  const archive = destination === undefined ? onArchive : undefined;
  const { priceOf, currency, marketplaceLabel } = useTrayPrices(rows, destination?.marketplace);
  const money: Money = { currency, marketplaceLabel };
  // The same unit price each card shows, times its copies — so the figure in the header is the sum
  // of the figures under the cards, and a card whose price has not been read yet is in neither.
  const worth = trayWorth(rows, priceOf);

  // What a press on a card does — four writes, each a reducer call waiting for the latest rows, and
  // the printings dialog — built once here so the row and the tile cannot come to disagree.
  const handlers = (row: ScannerTrayRow) => ({
    onQuantity: (q: number) => onRows((latest) => setQuantity(latest, row.key, q)),
    onFinish: (f: ScannerTrayFinish) => onRows((latest) => setFinish(latest, row.key, f)),
    onPick: (cardId: string) => onRows((latest) => pickChoice(latest, row.key, cardId)),
    onRemove: () => onRows((latest) => removeRow(latest, row.key)),
    onMorePrintings: () => onMorePrintings(row),
  });

  return (
    // Labelled by the title alone and never by the whole heading: the count beside it is a figure
    // that moves on every scan, and a region whose name changed each time a card landed would be
    // re-announced by name to a reader who never left it. `flex-1` so the tray — and its empty
    // sentence — runs the whole height of the column the page gives it.
    <section
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface"
    >
      {/* `flex-wrap` for a narrow tray: the title, its figures and the right-hand controls can be
          wider than it together, and the right-hand group then wraps as one — still at the right
          end — rather than pushing the `⋯` out of the tray. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        {/* **The name is spelled, not computed.** The title and its count are two elements with a
            gap between them, which the name algorithm fuses into `Scanned cards3`; the label says
            the whole phrase with the unit a bare digit leaves the reader to guess. */}
        <h3
          aria-label={`${title}, ${plural(copies, "copy", "copies")}`}
          className="flex items-baseline gap-2 font-heading text-lg leading-none"
        >
          <span id={titleId}>{title}</span>
          <span aria-hidden="true" className="font-mono text-sm tabular-nums text-dim">
            {copies}
          </span>
        </h3>
        {/* **Only once a copy has a price.** A tray of unpriced cards, or one whose read has not
            answered yet, has no worth to state — `$0.00` there would be a claim about cards
            nobody has priced. */}
        {worth.priced > 0 && (
          <span className="inline-flex items-baseline gap-1.5 text-xs text-dim">
            Worth{" "}
            <span className="font-mono text-sm tabular-nums text-text">
              {formatPrice(worth.total, currency)}
            </span>
          </span>
        )}
        {/* Hidden rather than greyed when nothing is waiting, like *More printings…* for a card
            with no oracle id: a control that can do nothing is one a reader keeps trying. Gold,
            because it walks the questions gold already marks — the dashed waiting tile and the
            `Unknown` finish's border. **Named for the walk as well as the count**: the words say
            how many, and a press on `2 need you` alone would not say where it goes. */}
        {asking > 0 && (
          <button
            type="button"
            aria-label={`${needYouLabel(asking)}: ${NEXT_DECISION_LABEL}`}
            onClick={nextDecision}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 px-2.5 text-xs text-accent",
              "hover:bg-accent hover:text-accent-fg",
              PRESS,
              FOCUS,
            )}
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
            {needYouLabel(asking)}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {onAddCard && (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={(e) => onAddCard(e.currentTarget)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-dim",
                "hover:text-accent",
                PRESS,
                FOCUS,
              )}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {ADD_CARD_LABEL}
            </button>
          )}
          <LayoutToggle layout={layout} onLayout={onLayout} />
          <TrayActions
            rows={rows}
            busy={busy}
            archiving={archiving}
            onCreateDeck={onCreateDeck}
            onArchive={archive}
            onClearAll={onClearAll}
          />
        </div>
      </header>

      {/* Above the rows it is about, and outside their scroller: it is a fact about the whole
          list, and a reader forty cards down should not have to scroll back up to be told. A note
          rather than an alert — nothing has gone wrong, and it is there from the first paint. */}
      {notice !== null && (
        <p
          role="note"
          className="mx-3 mt-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-snug"
        >
          {notice}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-sm text-dim">
          Cards you scan appear here.
        </p>
      ) : layout === "grid" ? (
        // The list's scroller with a grid inside it: `relative` for the same reason, and `p-3.5`
        // rather than `p-1.5` because a waiting tile's candidates rise out of their box under the
        // pointer and their shadow falls wider still — the top row's lift and the outer columns'
        // focus outline both need room inside the clip. `content-start` so a short tray's rows stay
        // at the top instead of being stretched down the column.
        <ul
          ref={listRef}
          className="relative grid min-h-0 flex-1 content-start gap-x-3 gap-y-[18px] overflow-y-auto p-3.5"
          style={{ gridTemplateColumns: TILE_COLUMNS }}
        >
          {/* **The column probe**: the grid's template and column gap on an empty box exactly as
              wide as the grid's content — `inset-x-3.5` is the scroller's `p-3.5`, and an
              absolute box's containing block here is the scroller's padding box, which already
              leaves the scrollbar out. Empty, it makes no implicit tracks, so its count is the
              grid's explicit one (`useGridColumns`). Out of flow, so it takes no cell; no height,
              invisible and `aria-hidden`, so it is not a row to anyone. The three have to move
              with the grid's. */}
          <li
            ref={columnProbe}
            aria-hidden="true"
            data-column-probe=""
            className="pointer-events-none invisible absolute inset-x-3.5 top-0 grid h-0 gap-x-3"
            style={{ gridTemplateColumns: TILE_COLUMNS }}
          />
          {rows.map((row) => {
            const on = handlers(row);
            return row.choices.length > 0 ? (
              <WaitingTile
                key={row.key}
                row={row}
                columns={columns}
                flash={row.key === flashKey}
                onPick={on.onPick}
                onRemove={on.onRemove}
                onMorePrintings={on.onMorePrintings}
              />
            ) : (
              <TrayTile
                key={row.key}
                row={row}
                flash={row.key === flashKey}
                price={priceOf(row)}
                money={money}
                onQuantity={on.onQuantity}
                onFinish={on.onFinish}
                onRemove={on.onRemove}
                onMorePrintings={on.onMorePrintings}
              />
            );
          })}
        </ul>
      ) : (
        // `relative` because a scroll container has to be the containing block for its own
        // absolutely positioned content — each row's flash overlay among it — or that content is
        // laid out against something further up and clipped by nothing. `p-1.5` is the room the
        // focus outline of a control flush against the scroller's edge needs to be seen at all.
        <ul ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <TrayRow
              key={row.key}
              row={row}
              flash={row.key === flashKey}
              price={priceOf(row)}
              money={money}
              {...handlers(row)}
            />
          ))}
        </ul>
      )}

      {commitError !== null && (
        <p
          role="alert"
          className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {commitError}
        </p>
      )}

      {/* Where the cards go, how they are graded, and the press that sends them — the three things
          the tray is *for*, so they stay in view while the rows scroll. The pickers wrap above the
          press when the three no longer fit side by side, and the press keeps the far end. */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border p-3">
        {destination === undefined ? (
          <>
            <FolderPicker folderId={folderId} onFolder={onFolder} />
            <ConditionPicker condition={condition} onCondition={onCondition} />
          </>
        ) : (
          destination.summary?.(rows)
        )}
        <button
          type="button"
          aria-disabled={refused || undefined}
          aria-busy={committing || undefined}
          onClick={() => {
            if (refused) return;
            onCommit();
          }}
          // The reason while there is one; nothing while the write is in flight, where the spinner
          // already says what is happening and a sentence about emptiness would be untrue.
          {...tip(busy ? null : refusal)}
          className={cn(
            "ml-auto inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg",
            "hover:bg-accent/90",
            PRESS,
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-accent",
            "aria-disabled:active:scale-100",
            FOCUS,
          )}
        >
          {committing && (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {/* One label in both states: the name a reader pressed is the name the pending control
              keeps, and `aria-busy` is what says the write is under way. */}
          {addLabel(ready, needsFinish, destination?.name)}
        </button>
      </footer>
    </section>
  );
}

/**
 * The header's `⋯`: the tray-wide presses that are not the one it is for — *Create deck…*,
 * *Archive* and *Clear all…*, in that order — in an `AnchoredPopup` under it.
 *
 * **Each row keeps the refusal it had as a header button**: `aria-disabled` rather than the
 * attribute, the press doing nothing, and the reason in its tooltip. *Archive* and *Clear all…*
 * refuse on the same terms — an empty tray, or a write already putting these rows away — and a
 * card still waiting on a printing or a finish can be thrown away or archived all the same;
 * *Create deck…* adds `deckRefusal`'s, since a deck files every row or none.
 *
 * **The opener a row hands up is the `⋯`, never the row.** The row goes with the menu the moment it
 * is pressed, so a dialog that handed the caret back to it would be focusing a detached node and
 * the caret would drop to `<body>`; the `⋯` is drawn for as long as the tray is. The menu is shut
 * first, on Escape's own path, so the caret is already on the `⋯` when the page opens its dialog.
 */
function TrayActions({
  rows,
  busy,
  archiving,
  onCreateDeck,
  onArchive,
  onClearAll,
}: {
  rows: readonly ScannerTrayRow[];
  busy: boolean;
  archiving: boolean;
  onCreateDeck?: (opener: HTMLElement) => void;
  onArchive?: () => void;
  onClearAll: (opener: HTMLElement) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const deckRefused = deckRefusal(rows);
  // Nothing to clear, or a commit about to file these very rows.
  const clearRefused = rows.length === 0 || busy;
  // The reason, while there is one to give; none while a write is in flight, where the busy row
  // already says what is happening and a sentence about emptiness would be untrue.
  const emptyReason = busy ? null : rows.length === 0 ? EMPTY_REASON : null;
  // `AnchoredPopup` keeps its trigger to itself, and it is the first button in its root — the
  // panel is drawn after it.
  const trigger = () => rootRef.current?.querySelector<HTMLElement>("button") ?? null;
  const press = (close: () => void, act: (opener: HTMLElement) => void) => {
    const opener = trigger();
    close();
    if (opener !== null) act(opener);
  };

  return (
    <div ref={rootRef} className="flex">
      <AnchoredPopup
        label="Tray actions"
        panelLabel="Tray actions"
        icon={<Ellipsis className="size-4" aria-hidden="true" />}
        // The layout toggle's square beside it, and its floor for a finger.
        triggerClassName="size-8 coarse:min-h-[var(--target-min)] coarse:min-w-[var(--target-min)]"
        // Under the trigger rather than over its foot, and right-aligned: it is the header's last
        // control, so a panel opening rightwards would leave the tray.
        panelClassName="top-full mt-1 w-48 p-1"
      >
        {(close) => (
          <ul className="flex flex-col">
            {onCreateDeck && (
              <TrayAction
                label="Create deck…"
                Icon={Layers}
                held={deckRefused !== null || busy}
                reason={busy ? null : deckRefused}
                onPress={() => press(close, onCreateDeck)}
              />
            )}
            {onArchive && (
              <TrayAction
                label="Archive"
                Icon={Archive}
                spinning={archiving}
                held={clearRefused}
                // What it does, while it can — the one thing the word does not say.
                reason={busy ? null : rows.length === 0 ? EMPTY_REASON : ARCHIVE_TIP}
                onPress={() =>
                  press(close, () => {
                    onArchive();
                  })
                }
              />
            )}
            <TrayAction
              label="Clear all…"
              Icon={Trash2}
              destructive
              held={clearRefused}
              reason={emptyReason}
              onPress={() => press(close, onClearAll)}
            />
          </ul>
        )}
      </AnchoredPopup>
    </div>
  );
}

/** One row of the `⋯` menu: its icon and word, refused in place with its reason as a tooltip. */
function TrayAction({
  label,
  Icon,
  spinning = false,
  destructive = false,
  held,
  reason,
  onPress,
}: {
  label: string;
  Icon: LucideIcon;
  /** A write under way — the row spins and is `aria-busy`, and stays named what was pressed. */
  spinning?: boolean;
  destructive?: boolean;
  /** The press does nothing. */
  held: boolean;
  /** The tooltip — why it is held, or what it does — or `null` for none. */
  reason: string | null;
  onPress: () => void;
}) {
  const tip = useTooltip();
  return (
    <li>
      <button
        type="button"
        aria-disabled={held || undefined}
        aria-busy={spinning || undefined}
        onClick={() => {
          if (!held) onPress();
        }}
        {...tip(reason)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text",
          "transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
          destructive && "hover:text-destructive",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent",
          destructive && "aria-disabled:hover:text-text",
          FOCUS,
        )}
      >
        {spinning ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin text-dim motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Icon className="size-3.5 shrink-0 text-dim" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    </li>
  );
}

/** The footer's grades, in the order a picker draws them — `CONDITIONS`' own, a scale. */
const CONDITION_OPTIONS: DropdownOption[] = CONDITIONS.map((c) => ({
  value: c,
  label: CONDITION_LABEL[c],
}));

/**
 * The footer's *Condition*: the grade Add files every copy in, captioned beside the picker the way
 * *File into* captions the folder. The caption is a real `<label>` naming the trigger, so a press
 * on the word opens it too.
 */
function ConditionPicker({
  condition,
  onCondition,
}: {
  condition: Condition;
  onCondition: (condition: Condition) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <label id={labelId} htmlFor={id} className="text-xs text-dim">
        Condition
      </label>
      <Dropdown
        id={id}
        labelledBy={labelId}
        value={condition}
        onChange={(v) => onCondition(v as Condition)}
        options={CONDITION_OPTIONS}
      />
    </div>
  );
}

/** The marketplace a tray is priced at — how its figures are written, and whose they are. */
interface Money {
  currency: Currency;
  marketplaceLabel: string;
}

/**
 * One copy's price, at the marketplace the reader picked (issue #736) — `trayRowPrice`'s answer,
 * drawn the way every price in the app is: `formatPrice`, mono, tabular figures.
 *
 * **Three states and the first draws nothing.** `undefined` is a read not answered yet — a card
 * that has only just landed — and an em dash there would say "unpriced" about a card nobody has
 * asked about. `null` *is* unpriced: the marketplace does not quote this printing in this finish,
 * which `packages/ui/CLAUDE.md` says is drawn as an em dash and never filled in from another
 * marketplace. The dash is `aria-hidden` and the words beside it say which marketplace was asked,
 * because a bare dash is read out as "dash".
 *
 * **A unit price, never the row's total.** The stepper beside it and the count on a tile's card
 * already say how many; a figure that changed with every press of `+` would read as the card's
 * price moving.
 */
function TrayPrice({
  price,
  money,
  className,
}: {
  price: number | null | undefined;
  money: Money;
  className?: string;
}) {
  if (price === undefined) return null;
  return (
    <span
      className={cn(
        "shrink-0 font-mono tabular-nums",
        price === null ? "text-dim" : "text-text",
        className,
      )}
    >
      {price === null ? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">Not priced at {money.marketplaceLabel}</span>
        </>
      ) : (
        formatPrice(price, money.currency)
      )}
    </span>
  );
}

/**
 * The card just landed or just counted a second copy: a wash of accent that holds for one tier and
 * fades over the next, so the eye can find it in a moving tray without the tray itself moving.
 * Over the whole row in the list, over the card in the grid.
 *
 * **Keyed on the row's stamp**, which `addDecision` refreshes on a bump — so the second copy
 * flashes again even though the flashed key did not change. Opacity rather than anything
 * positional, so there is no travel for reduced motion to take away; the colour arriving and
 * leaving is the whole of it. The caller's box has to be `relative`, and says its own corner.
 */
function TrayFlash({ stamp, className }: { stamp: number; className: string }) {
  return (
    <motion.span
      key={stamp}
      aria-hidden="true"
      data-tray-flash=""
      className={cn("pointer-events-none absolute inset-0 bg-accent/15", className)}
      initial={{ opacity: 1 }}
      animate={{
        opacity: 0,
        transition: { ...TRANSITION.slow, delay: seconds(DURATION.slow) },
      }}
    />
  );
}

/**
 * The header's two-way switch between the grid and the list.
 *
 * **`FilterChips`' layout pair in everything but its words and its size**, and deliberately not
 * that component: its choices are the search's `grid`/`table` under the names *Card view* and
 * *Table view*, and a tray is neither a search result nor a table. So it is the same recipe —
 * the filter row's control, its focus, its on-and-off state, icon squares with the word in a
 * tooltip — at 32px rather than 36, because this sits in a panel header beside an 18px title
 * rather than on a filter row. The `coarse:` floor is the same pair's, for a finger.
 *
 * A press on the layout already drawn writes nothing: the choice is a stored pref, and a write
 * that changes nothing is an IPC round trip for a click that asked for nothing.
 */
function LayoutToggle({
  layout,
  onLayout,
}: {
  layout: ScannerTrayLayout;
  onLayout: (layout: ScannerTrayLayout) => void;
}) {
  const tip = useTooltip();
  return (
    <div role="group" aria-label="Tray layout" className="flex shrink-0 gap-1">
      {TRAY_LAYOUTS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={layout === id}
          aria-label={label}
          // `describes: false`: the words are the `aria-label` above.
          {...tip(label, { describes: false })}
          onClick={() => {
            if (layout !== id) onLayout(id);
          }}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            // Last, so tailwind-merge lets the square replace the recipe's own 36px height.
            "size-8 coarse:min-w-[var(--target-min)]",
            filterChipState(layout === id),
          )}
        >
          <Icon className="mx-auto size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/**
 * One scanned card.
 *
 * **Resolved, it is a line of controls; waiting, it is a question.** A row with candidates draws
 * no finish, no stepper and no *More printings…* — none of them means anything until the reader
 * has said which printing this is, and a stepper beside an unanswered question invites setting a
 * quantity of the wrong card. What stays in both is the way out: remove.
 */
function TrayRow({
  row,
  flash,
  price,
  money,
  onQuantity,
  onFinish,
  onPick,
  onRemove,
  onMorePrintings,
}: {
  row: ScannerTrayRow;
  flash: boolean;
  price: number | null | undefined;
  money: Money;
  onQuantity: (q: number) => void;
  onFinish: (f: ScannerTrayFinish) => void;
  onPick: (cardId: string) => void;
  onRemove: () => void;
  onMorePrintings: () => void;
}) {
  const waiting = row.choices.length > 0;
  const label = rowLabel(row);
  const printing = printingOf(row);
  // **The whole card, never the `art` crop.** A crop has no printed frame and so no artist credit,
  // a tray row carries no artist to name beside one, and the Scanner shows no other full card a
  // reader could read the credit off — `packages/ui/CLAUDE.md`'s art-credit rule, met by its second arm.
  // `thumb` is the smallest variant that is a whole card.
  const card = cardImageUrl(row.cardId, 0, "thumb");

  return (
    <li data-tray-row={row.key} className="relative rounded-md px-2 py-2">
      {flash && <TrayFlash stamp={row.addedAt} className="rounded-md" />}
      <div className="relative flex items-start gap-2.5">
        {/* A 5:7 portrait slot, decoration beside the name — `aria-hidden`, empty alt and
            `draggable={false}`. Through `CardImage`, never a bare `<img>`: this is a slot, and a
            pick changes the card in it. `object-contain` rather than `cover`, so not a pixel of
            the card — the credit line least of all — is ever cropped off at the slot's edge.
            Not `CardArt`: its no-picture fallback prints the card's name and a status line, which
            cannot be read in a 36px column and would repeat the name set in type beside it. */}
        <span
          aria-hidden="true"
          className="w-9 shrink-0 overflow-hidden rounded-[3px] bg-bg"
          style={{ aspectRatio: CARD_ASPECT }}
        >
          <CardImage
            src={card}
            alt=""
            draggable={false}
            // A plain scroller, so a long tray really is every row mounted.
            loading="lazy"
            className="size-full object-contain"
          />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm">{row.name}</span>
            {!waiting && printing !== "" && (
              <span className="shrink-0 font-mono text-xs text-dim">{printing}</span>
            )}
            <TrayPrice price={price} money={money} className="ml-auto text-xs" />
          </div>

          {waiting ? (
            <Choices row={row} onPick={onPick} />
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {/* **An unknown finish wears the accent**, the colour this tray already asks its other
                  question in (`Pick a printing`, `1 needs you`) — a question for the reader,
                  never the destructive red, which would say something had gone wrong. The trigger
                  reads `Unknown` and the Add button counts it out; the border is what finds it in a
                  long list. */}
              {/* `contents`, so the mark the header's walk finds an unknown finish by adds no box to
                  the wrapping row. On a known finish too: the walk only lands on a row whose
                  finish is the question, so the mark costs nothing there. */}
              <span data-decision="" className="contents">
                <Dropdown
                  size="sm"
                  label={`Finish of ${label}`}
                  value={row.finish}
                  onChange={(v) => onFinish(v as ScannerTrayFinish)}
                  options={finishOptions(row)}
                  active={!isKnownFinish(row.finish)}
                />
              </span>
              <QuantityStepper
                size="sm"
                min={1}
                value={row.quantity}
                onChange={onQuantity}
                label={`Quantity of ${label}`}
              />
              {row.oracleId !== null && (
                // Hidden rather than greyed for a card with no oracle id: the all-printings dialog
                // walks a card's printings by that id, so there is no list to open — and a greyed
                // control is one a reader keeps trying.
                <button
                  type="button"
                  aria-label={`More printings of ${label}`}
                  onClick={onMorePrintings}
                  className={cn(
                    "rounded-md px-1 py-0.5 text-xs text-dim underline-offset-2 hover:text-text hover:underline",
                    FOCUS,
                  )}
                >
                  More printings…
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-dim hover:text-text",
            PRESS,
            FOCUS,
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/**
 * The candidates an ambiguous row is waiting on, as small cards to press.
 *
 * **Whole cards and not art crops**, because what tells two printings of one card apart is almost
 * never the picture — reprints share art — and almost always the frame: the set symbol, the
 * border, the treatment. A `thumb` is the smallest variant that still draws those.
 *
 * Each press is named `<name> — <SET> <number>`, and the printing is also printed under the card:
 * at this size a set symbol is a smudge, and a reader choosing between three Forests needs to read
 * which three.
 */
function Choices({ row, onPick }: { row: ScannerTrayRow; onPick: (cardId: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-accent">Pick a printing</p>
      <div
        role="group"
        aria-label={`Printings of ${row.name}`}
        data-decision=""
        className="flex flex-wrap gap-1.5"
      >
        {row.choices.map((choice) => (
          <ChoiceButton key={choice.cardId} choice={choice} onPick={() => onPick(choice.cardId)} />
        ))}
      </div>
    </div>
  );
}

function ChoiceButton({ choice, onPick }: { choice: ScannerTrayChoice; onPick: () => void }) {
  const printing = printingOf(choice);
  const src = cardImageUrl(choice.cardId, 0, "thumb");
  return (
    <button
      type="button"
      aria-label={choiceLabel(choice)}
      onClick={onPick}
      className={cn(
        "flex w-16 flex-col items-stretch gap-0.5 rounded-md border border-border p-0.5 hover:border-accent",
        PRESS,
        FOCUS,
      )}
    >
      <span
        aria-hidden="true"
        className="block w-full overflow-hidden rounded-[3px] bg-bg"
        style={{ aspectRatio: CARD_ASPECT }}
      >
        <CardImage
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          className="size-full object-contain"
        />
      </span>
      <span aria-hidden="true" className="truncate text-center font-mono text-[0.625rem] text-dim">
        {printing}
      </span>
    </button>
  );
}

/**
 * One resolved card in the grid, as **one continuous bordered card**: the picture, then a chin with
 * its finish and its quantity, then its name, printing and price.
 *
 * **The picture is the *More printings…* press**, where the row spends a text link on it: a tile
 * has a picture big enough to aim at, and the one thing a reader does with a card they have just
 * scanned is check it is the right printing. It says so twice — in the button's name, and in a chip
 * over the picture's foot while the pointer or the caret is on it — because a card that opens
 * something looks exactly like one that does not. **For a card with no oracle id it is not a button
 * at all**, for the row's reason: the all-printings dialog walks a card's printings by that id, so
 * there is no list to open, and a card that answers the pointer and then does nothing is a control
 * that lies.
 *
 * **Remove is the picture's top-right corner, shown on hover and focus** — and always under a
 * finger, which has no hover to find it with. It is the tile's first press, ahead of the picture,
 * as on a waiting tile (issue #1004); laid over the picture, so it takes a layer of its own.
 *
 * **The chin is always drawn**, the finish and the stepper being what a reader changes most. The
 * finish takes what the stepper leaves and never truncates — an `Unknown` there is a question, and
 * a question cut to `Unkn…` is not one — so on a tile too narrow for both on one line, which is
 * most of them, the stepper wraps under it. The basis is a fixed width rather than each label's
 * own, so every tile in a row wraps or not together and the row's chins stay one height.
 *
 * **Why not one row, as the design canvas draws it.** Measured 2026-10-24 in headless Edge, 12px
 * Geist: `Unknown` is 51.67px, so the `sm` finish trigger holding it (its border, `px-2` and 14px
 * chevron add 32) is 83.67px. A 149px tile's chin has 137px inside its border and padding; the
 * `sm` stepper is 112px, and even `xs`'s 80px leaves the finish 52 — short of the trigger at any
 * legible size (10px type and `px-1` still need 67px), and `xs`'s 20px buttons are under WCAG
 * 2.5.8's 24px. The canvas fits because its stepper is a 56px strip this app has no size for.
 *
 * **The marks are the walls' own.** `CardArt`'s chip in the top-right says a foil or etched copy,
 * and a count laid on the top-left says more than one — `CountTag`, the bare number every surface
 * lays *on* a card. It is `aria-hidden` and its `title` is what a pointer gets; the words are the
 * stepper's, which says the same number to a screen reader in the same tile and is where it is
 * changed. The button's own name stays the row's `More printings of …` rather than growing a
 * count, so the name of the press does not change under a reader each time they step it.
 *
 * **Everything on the card keeps the row's names** — `Finish of …`, `Quantity of …`, `Remove …` —
 * so a reader, a screen reader and a test find the same control in either layout.
 */
function TrayTile({
  row,
  flash,
  price,
  money,
  onQuantity,
  onFinish,
  onRemove,
  onMorePrintings,
}: {
  row: ScannerTrayRow;
  flash: boolean;
  price: number | null | undefined;
  money: Money;
  onQuantity: (q: number) => void;
  onFinish: (f: ScannerTrayFinish) => void;
  onRemove: () => void;
  onMorePrintings: () => void;
}) {
  const tip = useTooltip();
  const label = rowLabel(row);
  const printing = printingOf(row);
  // The picture and what is laid on it, drawn the same whether the box around it is a button or
  // not. `CardArt`'s own frame is put down — no border, no corner — because the card around it is
  // the frame now, and its corner is what clips the picture's. The count is flush with the
  // picture's left edge and inset from its top by the finish chip's own 4px, so the two marks
  // start on one line.
  const face = (
    <>
      <CardArt
        cardId={row.cardId}
        name={row.name}
        variant={TILE_VARIANT}
        finish={isKnownFinish(row.finish) ? row.finish : null}
        loading="lazy"
        className="rounded-none border-0"
      />
      {row.quantity > 1 && (
        <CountTag
          count={row.quantity}
          title={plural(row.quantity, "copy", "copies")}
          className="absolute left-0 top-1"
        />
      )}
    </>
  );

  return (
    <li data-tray-row={row.key} className="min-w-0">
      <div className="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-bg">
        <div className="group/tile relative">
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
            className={cn(
              "absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full border border-border bg-bg/90 text-dim hover:text-text",
              LAYER.overlappingMark,
              // Opacity alone, so there is no travel for reduced motion to take away.
              "opacity-0 transition-opacity duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
              "group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 coarse:opacity-100",
              PRESS,
              FOCUS,
            )}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
          {row.oracleId !== null ? (
            // The outline inside the button's own edge: the button is the card's whole width, and
            // the card clips anything standing off it.
            <button
              type="button"
              aria-label={`More printings of ${label}`}
              onClick={onMorePrintings}
              className={cn("group/pic relative block w-full", FOCUS_INSET)}
            >
              {face}
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-2 bottom-2 rounded-md border border-border bg-bg/90 py-1.5",
                  "text-center text-xs text-text",
                  "opacity-0 transition-opacity duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
                  "group-hover/pic:opacity-100 group-focus-visible/pic:opacity-100",
                )}
              >
                More printings…
              </span>
            </button>
          ) : (
            // Decoration over the name set in type under it, as the row's thumbnail is.
            <div aria-hidden="true" className="relative">
              {face}
            </div>
          )}
        </div>

        {/* The chin: the finish taking what the stepper leaves, at a fixed basis — see above. */}
        <div className="flex flex-wrap items-center gap-[5px] border-t border-border p-[5px]">
          {/* The mark the header's walk finds an unknown finish by. A box of its own here rather
              than the row's `contents`, because it is what grows. */}
          <span data-decision="" className="grow basis-24">
            <Dropdown
              size="sm"
              fill
              label={`Finish of ${label}`}
              value={row.finish}
              onChange={(v) => onFinish(v as ScannerTrayFinish)}
              options={finishOptions(row)}
              // The row's rule: an unknown finish wears the accent, so it is found in a wall of tiles too.
              active={!isKnownFinish(row.finish)}
            />
          </span>
          <QuantityStepper
            size="sm"
            min={1}
            value={row.quantity}
            onChange={onQuantity}
            label={`Quantity of ${label}`}
          />
        </div>

        {/* The name, then the printing and its price on one line, the price at the right end where
            a column of tiles lines its figures up. A tile with neither — a printing the corpus has
            no number for, its price not read yet — draws no empty second line. */}
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-border px-2 pb-2 pt-1.5">
          <span
            {...tip(row.name, { whenClipped: true })}
            className="min-w-0 truncate text-[13px] leading-5"
          >
            {row.name}
          </span>
          {(printing !== "" || price !== undefined) && (
            <span className="flex min-w-0 items-baseline gap-1.5">
              {printing !== "" && (
                <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-dim">
                  {printing}
                </span>
              )}
              <TrayPrice price={price} money={money} className="ml-auto text-xs leading-4" />
            </span>
          )}
        </div>

        {/* Over the whole card, the chin with it: it is the card that landed. */}
        {flash && <TrayFlash stamp={row.addedAt} className="rounded-lg" />}
      </div>
    </li>
  );
}

/**
 * A card still waiting on a pick, **in its place in scan order**, as a question as wide as it has
 * answers.
 *
 * **Its candidates are the tile**, each at the size of the cards around it, because what tells two
 * printings of one card apart is the frame — the set symbol, the border, the treatment — and that
 * is exactly what the list's 64px candidates reduce to a smudge. **It spans one column per
 * candidate and one more for *More printings…*, and never more columns than the grid has**
 * (`columns`, read off the grid by `useGridColumns`): more candidates than that wrap onto a second
 * line inside the tile. No CSS can cap a `span` at an `auto-fill` grid's count — a span past the
 * last track makes implicit ones and pushes the grid sideways — so until the grid has been measured
 * it spans the whole width, the one span that is always safe. The name, *Pick a printing* and the
 * remove head the box, the remove in its top-right corner where a resolved tile's is. The dashed
 * gold edge marks the tray's open question, one of the things the header's *N need you* counts.
 *
 * ***More printings…* is the last cell**, a dashed outline the size of a card: the answer is not
 * always among the candidates, and the all-printings dialog's pick settles the row the way a
 * candidate's does (`setPrinting` clears the choices). Not drawn, and the span one less, for a card
 * with no oracle id — there is no list of printings to open.
 *
 * **No finish, no stepper** — the row's rule: neither means anything until the reader has said
 * which printing this is. What stays is the way out: remove.
 */
function WaitingTile({
  row,
  columns,
  flash,
  onPick,
  onRemove,
  onMorePrintings,
}: {
  row: ScannerTrayRow;
  /** The grid's column count, or `0` before it has been measured. */
  columns: number;
  flash: boolean;
  onPick: (cardId: string) => void;
  onRemove: () => void;
  onMorePrintings: () => void;
}) {
  const label = rowLabel(row);
  const more = row.oracleId !== null;
  const cells = row.choices.length + (more ? 1 : 0);
  const span = columns > 0 ? Math.min(cells, columns) : null;
  return (
    <li
      data-tray-row={row.key}
      className="relative flex min-w-0 flex-col rounded-lg border border-dashed border-accent/60 px-2.5 pt-1.5 pb-2.5"
      style={{ gridColumn: span === null ? "1 / -1" : `span ${span}` }}
    >
      {flash && <TrayFlash stamp={row.addedAt} className="rounded-lg" />}
      <TileName name={row.name} label={label} onRemove={onRemove}>
        <span className="shrink-0 text-xs font-medium text-accent">Pick a printing</span>
      </TileName>
      <div
        role="group"
        aria-label={`Printings of ${row.name}`}
        data-decision=""
        className="grid gap-3"
        style={{
          gridTemplateColumns: span === null ? TILE_COLUMNS : `repeat(${span}, minmax(0, 1fr))`,
        }}
      >
        {row.choices.map((choice) => (
          <ChoiceCard key={choice.cardId} choice={choice} onPick={() => onPick(choice.cardId)} />
        ))}
        {more && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`More printings of ${label}`}
            onClick={onMorePrintings}
            className={cn(
              "grid w-full place-items-center rounded-lg border border-dashed border-border px-2.5 text-center text-[13px] text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard hover:border-accent hover:text-accent motion-reduce:transition-none",
              FOCUS,
            )}
            style={{ aspectRatio: CARD_ASPECT }}
          >
            More printings…
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * One candidate in a waiting tile: a whole card to press, named `<name> — <SET> <number>`, with
 * the printing set over its foot.
 *
 * **Through `CardArt` rather than a bare `CardImage` in a box**, where the list's 64px candidate
 * draws its own: at this size the frame's no-picture state — the card's name and why there is no
 * picture — can be read, and a candidate that never loads is still a card a reader can choose.
 * The printing is printed on the card as well as in its name, because the set symbol is small even
 * here and a reader choosing between three Lightning Bolts needs to read which three.
 */
function ChoiceCard({ choice, onPick }: { choice: ScannerTrayChoice; onPick: () => void }) {
  const printing = printingOf(choice);
  return (
    <button
      type="button"
      aria-label={choiceLabel(choice)}
      onClick={onPick}
      className={cn("relative block w-full overflow-hidden rounded-lg", LIFT, FOCUS)}
    >
      <CardArt cardId={choice.cardId} name={choice.name} variant={TILE_VARIANT} loading="lazy" />
      {printing !== "" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-bg/90 px-1.5 py-px font-mono text-[11px] leading-4 text-text"
        >
          {printing}
        </span>
      )}
    </button>
  );
}

/**
 * A waiting tile's name line, at the top of the tile: the card's name, cut short with the whole of
 * it on hover, anything the tile adds after it, and the remove press at its right end — the tile's
 * top-right corner, where a resolved tile's remove is too (issue #1004). 24px, a size down from the
 * row's, because it shares a line with 13px type rather than with a stepper.
 */
function TileName({
  name,
  label,
  onRemove,
  children,
}: {
  name: string;
  label: string;
  onRemove: () => void;
  children?: ReactNode;
}) {
  const tip = useTooltip();
  return (
    <div className="relative mb-1.5 flex min-w-0 items-center gap-2">
      <span
        {...tip(name, { whenClipped: true })}
        className="min-w-0 flex-1 truncate text-[13px] leading-5"
      >
        {name}
      </span>
      {children}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md text-dim hover:text-text",
          PRESS,
          FOCUS,
        )}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Where the tray files, behind a button naming the destination, captioned *File into*.
 *
 * **The caption is beside the button, not in its name.** The button is named `Folder: <name>` —
 * the folder is what it says and what a press changes — and the caption is the footer's sentence
 * around it, read as text: *File into* · the folder · *Condition* · the grade · *Add*.
 *
 * **The reader's own folders and nothing else.** A deck's group and `Recently removed` are folder
 * kinds the cabinet draws but nothing may be filed into by hand — since schema v25 a live deck owns
 * exactly what its own group holds — so they are left out of the tree before it is built, which
 * is `CollectionPage`'s and the card menu's arrangement. Out of the tree rather than drawn greyed:
 * no destination in this list is a place the tray could ever land.
 *
 * **`AddToCollection`'s shape one surface over**: `AnchoredPopup` for the layer, `MoveToFolder`
 * drawn `inline` inside it so the popup stays the one dialog in the tree. **It opens upward**, pinned
 * by its bottom-left corner and grown from it: the footer is the bottom edge of the tray, so a
 * panel opening downward would land off the window.
 *
 * **Picking writes nothing but the choice.** The commit is the Add button's; so the list is never
 * pending, and `AddToCollection`'s argument for `pending={false}` holds here word for word.
 *
 * **`New folder…` under the list** (issue #1357) swaps the list for a name field in the same
 * popup, and Create makes the folder at the top level and picks it (`useTrayNewFolder`). The write
 * is held here rather than in the popup's contents, so a popup closed while it is in flight still
 * picks the folder it made.
 */
function FolderPicker({
  folderId,
  onFolder,
}: {
  folderId: number | null;
  onFolder: (id: number | null) => void;
}) {
  const { query, folders } = useCollectionFolderList();
  const mine = useMemo(() => folders.filter((folder) => folder.kind === "user"), [folders]);
  const nodes = useMemo(() => buildFolderTree(mine, []), [mine]);
  const newFolder = useTrayNewFolder(onFolder);

  // A folder another surface deleted reads as the top level, which is where `buildFolderTree`
  // puts a child whose parent is gone. While the list is still loading a named folder has no name
  // yet, and the collection's word would be a wrong answer rather than a pending one.
  const name =
    folderId === null
      ? ROOT_LABEL
      : query.isPending
        ? "…"
        : (mine.find((folder) => folder.id === folderId)?.name ?? ROOT_LABEL);

  return (
    // The pair grows to a cap: in a wide tray a picker that took every pixel left would put the
    // Add button a hand's width from the destination it files into.
    <div className="flex min-w-0 max-w-80 flex-1 basis-48 items-center gap-2">
      <span className="shrink-0 text-xs text-dim">File into</span>
      <AnchoredPopup
        label={`Folder: ${name}`}
        panelLabel="Choose a folder"
        align="start"
        className="min-w-0 flex-1"
        triggerClassName={cn(
          "inline-flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border px-2.5",
          "text-sm text-dim hover:text-text",
          PRESS,
        )}
        triggerContent={
          <>
            <Folder className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left text-text">{name}</span>
            <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
          </>
        }
        // Over the trigger rather than under it, and grown from the corner it is pinned by. `p-1`
        // because `MoveToFolder`'s inline list carries its own inset for its rows' hover.
        panelClassName="bottom-full top-auto mb-1 w-64 origin-bottom-left p-1"
      >
        {(close) => (
          <FolderChoices
            nodes={nodes}
            folderId={folderId}
            onFolder={onFolder}
            newFolder={newFolder}
            close={close}
          />
        )}
      </AnchoredPopup>
    </div>
  );
}

const NEW_FOLDER_CAPTION = "block text-[0.6875rem] text-dim";

const NEW_FOLDER_FIELD = cn(
  "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-text",
  "focus:border-accent focus:outline-none",
);

const NEW_FOLDER_BUTTON = cn(
  "inline-flex h-7 items-center rounded-md border px-2.5 text-xs",
  PRESS,
  "aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:active:scale-100",
  FOCUS,
);

/**
 * The popup's body: the folders and `New folder…`, or the new folder's name — one or the other,
 * the wishlist destination's panel's shape with its parent list left out (the folder goes at the
 * top level). A component of its own so its state mounts and unmounts with the popup: a
 * half-typed name is a fact about one opening.
 *
 * **One box for both, and it takes the caret between them.** `New folder…` and Cancel each
 * unmount the press the caret is on, and a focused element that leaves the tree drops the caret to
 * `<body>` — which is focus leaving the popup's root, and the popup would close under a reader who
 * only asked for the other half. So the box takes the caret first, then the half that mounts takes
 * it from there (the name field, or the list).
 */
function FolderChoices({
  nodes,
  folderId,
  onFolder,
  newFolder,
  close,
}: {
  nodes: readonly FolderNode[];
  folderId: number | null;
  onFolder: (id: number | null) => void;
  newFolder: TrayNewFolder;
  close: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  return (
    // A landing pad, not a control: no outline (`packages/ui/lib/focus.ts`).
    <div ref={boxRef} tabIndex={-1} className="outline-none">
      {naming ? (
        <NewFolderForm
          newFolder={newFolder}
          onCreated={close}
          onCancel={() => {
            boxRef.current?.focus();
            setNaming(false);
          }}
        />
      ) : (
        <>
          <MoveToFolder
            label="Folder for scanned cards"
            nodes={nodes}
            currentId={folderId}
            rootLabel={ROOT_LABEL}
            // Drawn into the popup rather than as a second layer of its own — the role goes with
            // the box, so the popup stays the one dialog in the tree.
            inline
            pending={false}
            onPick={(id) => {
              onFolder(id);
              close();
            }}
            // Deliberately nothing: the popup closes itself when focus leaves its root. Wired here
            // it would fire the moment the popup opened — the list focuses itself as it mounts and
            // the popup's panel then takes the caret from it, which is focus leaving the list.
            onClose={() => {}}
          />
          {/* Under the list and apart from it: a destination is a place the cards go, and this is
              a press that makes one. `MoveToFolder`'s row shape, so the two read as one popup. */}
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => {
                newFolder.reset();
                boxRef.current?.focus();
                setNaming(true);
              }}
              className={cn(
                "flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-xs text-text",
                "transition-colors duration-150 hover:bg-surface motion-reduce:transition-none",
                FOCUS,
              )}
            >
              <FolderPlus className="size-3.5 flex-none" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{NEW_FOLDER_LABEL}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The new folder's name, its Create and its Cancel. **Create is `aria-disabled`, never
 * `disabled`**: a press that disables itself is blurred by the browser with no `relatedTarget`,
 * and that is focus leaving the popup — it would close under the write, and a refusal would have
 * nowhere to be said. The refusal is said here, under the name, where the reader is looking.
 */
function NewFolderForm({
  newFolder,
  onCreated,
  onCancel,
}: {
  newFolder: TrayNewFolder;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const trimmed = name.trim();
  const held = trimmed === "" || newFolder.pending;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  return (
    <form
      aria-label="New folder"
      className="space-y-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (held) return;
        void newFolder.create(trimmed).then((made) => {
          if (made) onCreated();
        });
      }}
    >
      <div className="space-y-1">
        <label htmlFor={nameId} className={NEW_FOLDER_CAPTION}>
          Name
        </label>
        <input
          ref={nameRef}
          id={nameId}
          type="text"
          value={name}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          className={NEW_FOLDER_FIELD}
        />
      </div>
      {/* Mounted for as long as the form is, and filled: a live region that appears together with
          its words announces nothing. */}
      <p role="alert" className="text-[0.7rem] leading-relaxed text-destructive empty:hidden">
        {newFolder.error === null ? null : newFolderRefusal(newFolder.error)}
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(NEW_FOLDER_BUTTON, "border-border text-dim hover:text-text")}
        >
          Cancel
        </button>
        <button
          type="submit"
          aria-disabled={held || undefined}
          aria-busy={newFolder.pending || undefined}
          className={cn(NEW_FOLDER_BUTTON, "border-accent text-accent")}
        >
          {newFolder.pending ? "Creating…" : "Create folder"}
        </button>
      </div>
    </form>
  );
}
