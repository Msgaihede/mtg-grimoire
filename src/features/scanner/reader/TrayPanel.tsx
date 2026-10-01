import { useId, useMemo } from "react";
import { motion } from "motion/react";
import {
  ChevronUp,
  Folder,
  LayoutGrid,
  List as ListIcon,
  LoaderCircle,
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
import { plural } from "@/lib/counts";
import { FINISHES } from "@/lib/finish";
import { buildFolderTree } from "@/lib/folderTree";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardImageUrl, type ImageVariant } from "@/lib/images";
import type {
  ScannerTrayChoice,
  ScannerTrayFinish,
  ScannerTrayLayout,
  ScannerTrayRow,
} from "@/lib/ipc";
import { DURATION, PRESS, TRANSITION, seconds } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  NO_FINISHED_ROWS,
  needsFinishCount,
  pickChoice,
  readyRows,
  removeRow,
  setFinish,
  setQuantity,
  totalCopies,
  unresolvedCount,
} from "./tray";
import { isKnownFinish, TRAY_FINISH_LABEL, UNKNOWN_FINISH } from "./trayFinish";

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
  onCommit: () => void;
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
   * of this column (`src/CLAUDE.md`, the `@container` rule). `opener` is the button, for the caret
   * to come back to.
   */
  onClearAll: (opener: HTMLElement) => void;
}

/** The collection's own word for its top level — `AddToCollection`'s `rootLabel`, one tree over. */
const ROOT_LABEL = "Collection";

/** Why the add is out of reach, in the order a reader can do something about each. */
const EMPTY_REASON = "Nothing scanned yet";
const UNPICKED_REASON = "Pick a printing for every card first";

/**
 * **Deliberately not through `sortOptions` — the order is the information.** A printing's finishes
 * read plain before the premium treatments everywhere in this app, and `Unknown` comes last because
 * it is not a finish: it is the answer "not yet", which a reader can also give on purpose to hold a
 * card out of the next Add without removing it.
 */
const FINISH_OPTIONS: readonly DropdownOption[] = [...FINISHES, UNKNOWN_FINISH].map((f) => ({
  value: f,
  label: TRAY_FINISH_LABEL[f],
}));

/**
 * The Add button's words: the copies it files, and — while there are any — the copies it leaves
 * behind for want of a finish. **One string, never a second element**: the name is computed from
 * the button's content and a span beside the count would fuse into `collection· 2` (`src/CLAUDE.md`,
 * the `Missing2` rule).
 */
export function addLabel(ready: number, needsFinish: number): string {
  const add = `Add ${ready} to collection`;
  if (needsFinish === 0) return add;
  return `${add} · ${needsFinish} ${needsFinish === 1 ? "needs" : "need"} a finish`;
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
 * because a waiting tile spans two columns, and in a grid that fits only one, a two-column span
 * adds an implicit second track sized to its content and the tile hangs out of the tray. The
 * `min()` keeps two columns at any width, and it is exactly 9rem wherever two 9rem columns fit —
 * which is every width the page draws the tray at. The half gap is `gap-x-3`'s, so the two have
 * to move together.
 */
const TILE_COLUMNS = "repeat(auto-fill, minmax(min(9rem, calc(50% - 0.375rem)), 1fr))";

/**
 * A card that is a button rises a little under the pointer or the caret, with a shadow under it —
 * what says "this card opens something" on a surface where the card is also a picture.
 *
 * `translate` is its own longhand in Tailwind v4, as `scale` is (see `PRESS_STILL`), so the list
 * names it rather than `transform`. Reduced motion keeps the shadow and drops the travel, the way
 * `CardArt`'s hover zoom drops its scale. On the card's own box and never on the tile around it:
 * a transformed ancestor is the containing block for a `fixed` descendant, and the finish picker
 * under the card opens its panel from a `fixed` frame.
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
 * **The rows scroll and the footer does not.** A reader with forty cards scanned still has the
 * folder and the Add button in view, because those are what the tray is *for*.
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
  onCommit,
  committing,
  commitError,
  onMorePrintings,
  flashKey,
  layout,
  onLayout,
  onClearAll,
}: TrayPanelProps) {
  const titleId = useId();
  const tip = useTooltip();
  const copies = totalCopies(rows);
  const waiting = unresolvedCount(rows);
  const ready = totalCopies(readyRows(rows));
  const needsFinish = needsFinishCount(rows);
  // The order `commitPlan` refuses in, so the drawing and the press agree.
  const refusal =
    rows.length === 0
      ? EMPTY_REASON
      : waiting > 0
        ? UNPICKED_REASON
        : ready === 0
          ? NO_FINISHED_ROWS
          : null;
  const refused = refusal !== null || committing;
  // Nothing to clear, or a commit about to file these very rows — the Add button's two states that
  // are not about printings or finishes, since a card waiting on either can still be thrown away.
  const clearRefused = rows.length === 0 || committing;

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
      {/* `flex-wrap` for a narrow tray: the title, a pending pick and the toggle can be wider than
          it together, and the right-hand pair then wraps as one — still at the right end — rather
          than pushing the toggle out of the tray. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        {/* **The name is spelled, not computed.** The title and its count are two elements with a
            gap between them, which the name algorithm fuses into `Scanned cards3`; the label says
            the whole phrase with the unit a bare digit leaves the reader to guess. */}
        <h3
          aria-label={`Scanned cards, ${plural(copies, "copy", "copies")}`}
          className="flex items-baseline gap-2 font-heading text-lg leading-none"
        >
          <span id={titleId}>Scanned cards</span>
          <span aria-hidden="true" className="font-mono text-sm tabular-nums text-dim">
            {copies}
          </span>
        </h3>
        <div className="ml-auto flex items-center gap-3">
          {waiting > 0 && <span className="text-xs text-accent">{plural(waiting, "card")} to pick</span>}
          {/* **Drawn greyed rather than hidden on an empty tray**: a confirmed clear empties the
              tray, and the caret the dialog hands back has to land on a control that is still
              there — a hidden button would be a detached node and a silent `focus()`. */}
          <button
            type="button"
            aria-disabled={clearRefused || undefined}
            onClick={(e) => {
              if (clearRefused) return;
              onClearAll(e.currentTarget);
            }}
            {...tip(committing ? null : rows.length === 0 ? EMPTY_REASON : null)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-dim",
              "hover:text-destructive",
              PRESS,
              "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:text-dim",
              "aria-disabled:active:scale-100",
              FOCUS,
            )}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Clear all…
          </button>
          <LayoutToggle layout={layout} onLayout={onLayout} />
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-sm text-dim">
          Cards you scan appear here.
        </p>
      ) : layout === "grid" ? (
        // The list's scroller with a grid inside it: `relative` for the same reason, and `p-3.5`
        // rather than `p-1.5` because a tile's card rises out of its box under the pointer and
        // its shadow falls wider still — the top row's lift and the outer columns' focus outline
        // both need room inside the clip. `content-start` so a short tray's rows stay at the top
        // instead of being stretched down the column.
        <ul
          className="relative grid min-h-0 flex-1 content-start gap-x-3 gap-y-[18px] overflow-y-auto p-3.5"
          style={{ gridTemplateColumns: TILE_COLUMNS }}
        >
          {rows.map((row) => {
            const on = handlers(row);
            return row.choices.length > 0 ? (
              <WaitingTile
                key={row.key}
                row={row}
                flash={row.key === flashKey}
                onPick={on.onPick}
                onRemove={on.onRemove}
              />
            ) : (
              <TrayTile
                key={row.key}
                row={row}
                flash={row.key === flashKey}
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
        <ul className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <TrayRow key={row.key} row={row} flash={row.key === flashKey} {...handlers(row)} />
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

      {/* The picker grows to a cap and the Add button is pushed to the far end: in a tray a third of
          a wide window, a picker that took every pixel left would put the button a hand's width
          from the destination it files into. Below the cap the row is what it always was — the
          picker fills, and wraps above the button when the two no longer fit side by side. */}
      <footer className="flex flex-wrap items-end gap-2 border-t border-border p-3">
        <FolderPicker folderId={folderId} onFolder={onFolder} />
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
          {...tip(committing ? null : refusal)}
          className={cn(
            "ml-auto inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-accent px-4 text-sm text-accent",
            "hover:bg-accent hover:text-accent-fg",
            PRESS,
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent",
            "aria-disabled:hover:text-accent aria-disabled:active:scale-100",
            FOCUS,
          )}
        >
          {committing && (
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          {/* One label in both states: the name a reader pressed is the name the pending control
              keeps, and `aria-busy` is what says the write is under way. */}
          {addLabel(ready, needsFinish)}
        </button>
      </footer>
    </section>
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
  onQuantity,
  onFinish,
  onPick,
  onRemove,
  onMorePrintings,
}: {
  row: ScannerTrayRow;
  flash: boolean;
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
  // reader could read the credit off — `src/CLAUDE.md`'s art-credit rule, met by its second arm.
  // `thumb` is the smallest variant that is a whole card.
  const card = cardImageUrl(row.cardId, 0, "thumb");

  return (
    <li className="relative rounded-md px-2 py-2">
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
          </div>

          {waiting ? (
            <Choices row={row} onPick={onPick} />
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {/* **An unknown finish wears the accent**, the colour this tray already asks its other
                  question in (`Pick a printing`, `1 card to pick`) — a question for the reader,
                  never the destructive red, which would say something had gone wrong. The trigger
                  reads `Unknown` and the Add button counts it out; the border is what finds it in a
                  long list. */}
              <Dropdown
                size="sm"
                label={`Finish of ${label}`}
                value={row.finish}
                onChange={(v) => onFinish(v as ScannerTrayFinish)}
                options={FINISH_OPTIONS}
                active={!isKnownFinish(row.finish)}
              />
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
      <div role="group" aria-label={`Printings of ${row.name}`} className="flex flex-wrap gap-1.5">
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
 * One resolved card in the grid: the card itself, and the list row's controls under it.
 *
 * **The card is the *More printings…* press**, where the row spends a text link on it: a tile has a
 * picture big enough to aim at, and the one thing a reader does with a card they have just scanned
 * is check it is the right printing. It says so twice — in the button's name, and in a chip over
 * the card's foot while the pointer or the caret is on it — because a card that opens something
 * looks exactly like one that does not. **For a card with no oracle id it is not a button at all**,
 * for the row's reason: the all-printings dialog walks a card's printings by that id, so there is
 * no list to open, and a card that rises under the pointer and then does nothing is a control that
 * lies.
 *
 * **The marks are the walls' own.** `CardArt`'s chip in the top-right says a foil or etched copy,
 * and a count laid on the top-left says more than one — `CountTag`, the bare number every surface
 * lays *on* a card. It is `aria-hidden` and its `title` is what a pointer gets; the words are the
 * stepper's, which says the same number to a screen reader in the same tile and is where it is
 * changed. The button's own name stays the row's `More printings of …` rather than growing a
 * count, so the name of the press does not change under a reader each time they step it.
 *
 * **Everything under the card keeps the row's names** — `Finish of …`, `Quantity of …`, `Remove …`
 * — so a reader, a screen reader and a test find the same control in either layout. The finish and
 * the stepper sit side by side on a wide tile and wrap onto two lines on a narrow one, each at its
 * own width. By the two controls' own classes the pair needs roughly 196px — reckoned, not measured
 * — which is wider than a tile in the page's 25rem column, so there it wraps; a wrapped pair
 * left-aligned under the name reads as the card's facts in a column rather than as an overflow.
 */
function TrayTile({
  row,
  flash,
  onQuantity,
  onFinish,
  onRemove,
  onMorePrintings,
}: {
  row: ScannerTrayRow;
  flash: boolean;
  onQuantity: (q: number) => void;
  onFinish: (f: ScannerTrayFinish) => void;
  onRemove: () => void;
  onMorePrintings: () => void;
}) {
  const label = rowLabel(row);
  const printing = printingOf(row);
  // The card and what is laid on it, drawn the same whether the box around it is a button or not.
  // The count is flush with the card's left edge and inset from its top by the finish chip's own
  // 4px, so the two marks start on one line; the box clips it to the card's rounded corner, which
  // is how the deck's card face cuts the same banner.
  const face = (
    <>
      <CardArt
        cardId={row.cardId}
        name={row.name}
        variant={TILE_VARIANT}
        finish={isKnownFinish(row.finish) ? row.finish : null}
        loading="lazy"
      />
      {row.quantity > 1 && (
        <CountTag
          count={row.quantity}
          title={plural(row.quantity, "copy", "copies")}
          className="absolute left-0 top-1"
        />
      )}
      {flash && <TrayFlash stamp={row.addedAt} className="rounded-lg" />}
    </>
  );

  return (
    <li className="flex min-w-0 flex-col">
      {row.oracleId !== null ? (
        // `overflow-hidden` clips what is laid on the card to its corners, and costs the lift
        // nothing: an element's own shadow and focus outline are outside what its overflow clips.
        <button
          type="button"
          aria-label={`More printings of ${label}`}
          onClick={onMorePrintings}
          className={cn("group relative block w-full overflow-hidden rounded-lg", LIFT, FOCUS)}
        >
          {face}
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-2 bottom-2 rounded-md border border-border bg-bg/90 py-1.5",
              "text-center text-xs text-text",
              // Opacity alone, so there is no travel to take away — the opt-out is the sweep's
              // rule for every tween rather than a change in what a reduced-motion reader sees.
              "opacity-0 transition-opacity duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            More printings…
          </span>
        </button>
      ) : (
        // Decoration beside the name set in type under it, as the row's thumbnail is.
        <div aria-hidden="true" className="relative overflow-hidden rounded-lg">
          {face}
        </div>
      )}

      <TileName name={row.name} label={label} onRemove={onRemove} />
      {printing !== "" && <span className="truncate font-mono text-[11px] leading-4 text-dim">{printing}</span>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Dropdown
          size="sm"
          label={`Finish of ${label}`}
          value={row.finish}
          onChange={(v) => onFinish(v as ScannerTrayFinish)}
          options={FINISH_OPTIONS}
          // The row's rule: an unknown finish wears the accent, so it is found in a wall of tiles too.
          active={!isKnownFinish(row.finish)}
        />
        <QuantityStepper
          size="sm"
          min={1}
          value={row.quantity}
          onChange={onQuantity}
          label={`Quantity of ${label}`}
        />
      </div>
    </li>
  );
}

/**
 * A card still waiting on a pick, as a question two columns wide.
 *
 * **Its candidates are the tile**, laid out at the size of the cards around them, because what
 * tells two printings of one card apart is the frame — the set symbol, the border, the treatment
 * — and that is exactly what the list's 64px candidates reduce to a smudge. Two to a line, so each
 * is drawn as large as a resolved tile's card; a third or fourth adds a line rather than shrinking
 * the first two. The dashed gold edge marks the tray's open question, the thing the header's
 * *N cards to pick* is counting.
 *
 * **No finish, no stepper, no card to open** — the row's rule: none of them means anything until
 * the reader has said which printing this is. What stays is the way out: remove.
 */
function WaitingTile({
  row,
  flash,
  onPick,
  onRemove,
}: {
  row: ScannerTrayRow;
  flash: boolean;
  onPick: (cardId: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="col-span-2 flex min-w-0 flex-col">
      <div className="relative">
        <div
          role="group"
          aria-label={`Printings of ${row.name}`}
          className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-accent/60 p-2"
        >
          {row.choices.map((choice) => (
            <ChoiceCard key={choice.cardId} choice={choice} onPick={() => onPick(choice.cardId)} />
          ))}
        </div>
        {flash && <TrayFlash stamp={row.addedAt} className="rounded-lg" />}
      </div>
      <TileName name={row.name} label={rowLabel(row)} onRemove={onRemove} />
      <p className="text-xs font-medium text-accent">Pick a printing</p>
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
 * A tile's name line: the card's name, cut short with the whole of it on hover, and the remove
 * press at its right end — 24px, a size down from the row's, because it shares a line with 13px
 * type rather than with a stepper.
 */
function TileName({ name, label, onRemove }: { name: string; label: string; onRemove: () => void }) {
  const tip = useTooltip();
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1">
      <span {...tip(name, { whenClipped: true })} className="min-w-0 flex-1 truncate text-[13px] leading-5">
        {name}
      </span>
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
 * Where the tray files, behind a button naming the destination.
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
    <AnchoredPopup
      label={`Folder: ${name}`}
      panelLabel="Choose a folder"
      align="start"
      className="min-w-0 max-w-72 flex-1 basis-40"
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
        <MoveToFolder
          label="Folder for scanned cards"
          nodes={nodes}
          currentId={folderId}
          rootLabel={ROOT_LABEL}
          // Drawn into the popup rather than as a second layer of its own — the role goes with the
          // box, so the popup stays the one dialog in the tree.
          inline
          pending={false}
          onPick={(id) => {
            onFolder(id);
            close();
          }}
          // Deliberately nothing: the popup closes itself when focus leaves its root. Wired here it
          // would fire the moment the popup opened — the list focuses itself as it mounts and the
          // popup's panel then takes the caret from it, which is focus leaving the list.
          onClose={() => {}}
        />
      )}
    </AnchoredPopup>
  );
}
