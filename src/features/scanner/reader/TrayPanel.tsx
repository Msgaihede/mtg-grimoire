import { useCallback, useId, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronDown, Folder, LoaderCircle, X } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { plural } from "@/lib/counts";
import { FINISH_LABEL, FINISHES, type Finish } from "@/lib/finish";
import { buildFolderTree } from "@/lib/folderTree";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
import type { ScannerTrayChoice, ScannerTrayRow } from "@/lib/ipc";
import { DURATION, PRESS, TRANSITION, seconds } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import {
  pickChoice,
  removeRow,
  setFinish,
  setQuantity,
  totalCopies,
  unresolvedCount,
} from "./tray";

export interface TrayPanelProps {
  rows: readonly ScannerTrayRow[];
  onRows: (rows: ScannerTrayRow[]) => void;
  folderId: number | null;
  onFolder: (id: number | null) => void;
  onCommit: () => void;
  committing: boolean;
  commitError: string | null;
  onMorePrintings: (row: ScannerTrayRow) => void;
  /** The row just added or bumped, for the flash. */
  flashKey: string | null;
}

/** The collection's own word for its top level — `AddToCollection`'s `rootLabel`, one tree over. */
const ROOT_LABEL = "Collection";

/** Why the add is out of reach, in the order a reader can do something about each. */
const EMPTY_REASON = "Nothing scanned yet";
const UNPICKED_REASON = "Pick a printing for every card first";

/**
 * **Deliberately not through `sortOptions` — the order is the information.** A printing's finishes
 * read plain before the premium treatments everywhere in this app.
 */
const FINISH_OPTIONS: readonly DropdownOption[] = FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f] }));

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

/**
 * The review tray: every card the scanner has taken, newest first, and the one press that files
 * them all.
 *
 * **It draws `rows` in the order it is handed them.** The reducer in `tray.ts` is what keeps the
 * tray newest first, and a second ordering here would be a second answer to one question — the
 * first time they disagreed, a bumped row would jump.
 *
 * **Every write goes back as a whole array through `onRows`**, built by that reducer. The panel
 * holds no copy of the rows, so the page is the one owner, and the page is what persists the tray:
 * a crash mid-session loses nothing a reader pressed.
 *
 * **The list scrolls and the footer does not.** A reader with forty cards scanned still has the
 * folder and the Add button in view, because those are what the tray is *for*.
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
}: TrayPanelProps) {
  const titleId = useId();
  const tip = useTooltip();
  const copies = totalCopies(rows);
  const waiting = unresolvedCount(rows);
  const refusal = rows.length === 0 ? EMPTY_REASON : waiting > 0 ? UNPICKED_REASON : null;
  const refused = refusal !== null || committing;

  return (
    // Labelled by the title alone and never by the whole heading: the count beside it is a figure
    // that moves on every scan, and a region whose name changed each time a card landed would be
    // re-announced by name to a reader who never left it.
    <section
      aria-labelledby={titleId}
      className="flex min-h-0 flex-col rounded-lg border border-border bg-surface"
    >
      <header className="flex items-baseline gap-3 border-b border-border px-3 py-2.5">
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
        {waiting > 0 && (
          <span className="ml-auto text-xs text-accent">{plural(waiting, "card")} to pick</span>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-sm text-dim">
          Cards you scan appear here.
        </p>
      ) : (
        // `relative` because a scroll container has to be the containing block for its own
        // absolutely positioned content — each row's flash overlay among it — or that content is
        // laid out against something further up and clipped by nothing. `p-1.5` is the room the
        // focus outline of a control flush against the scroller's edge needs to be seen at all.
        <ul className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <TrayRow
              key={row.key}
              row={row}
              flash={row.key === flashKey}
              onQuantity={(q) => onRows(setQuantity(rows, row.key, q))}
              onFinish={(f) => onRows(setFinish(rows, row.key, f))}
              onPick={(cardId) => onRows(pickChoice(rows, row.key, cardId))}
              onRemove={() => onRows(removeRow(rows, row.key))}
              onMorePrintings={() => onMorePrintings(row)}
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
            "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-accent px-4 text-sm text-accent",
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
          Add {copies} to collection
        </button>
      </footer>
    </section>
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
  onFinish: (f: Finish) => void;
  onPick: (cardId: string) => void;
  onRemove: () => void;
  onMorePrintings: () => void;
}) {
  const waiting = row.choices.length > 0;
  const label = rowLabel(row);
  const printing = printingOf(row);
  // The frame `PullFromCollectionDialog`'s rows draw: the protocol URL on desktop, and `null` on
  // the web build — a tray row carries no Scryfall URL, so a browser draws the empty frame below.
  const art = cardArtSrc(cardImageUrl(row.cardId, 0, "art"));

  return (
    <li className="relative rounded-md px-2 py-2">
      {flash && (
        // The row just landed or just counted a second copy: a wash of accent that holds for one
        // tier and fades over the next, so the eye can find the row in a moving list without the
        // list itself moving. Keyed on the row's stamp, which `addDecision` refreshes on a bump —
        // so the second copy flashes again even though the flashed key did not change.
        // Opacity rather than anything positional, so there is no travel for reduced motion to
        // take away; the colour arriving and leaving is the whole of it.
        <motion.span
          key={row.addedAt}
          aria-hidden="true"
          data-tray-flash=""
          className="pointer-events-none absolute inset-0 rounded-md bg-accent/15"
          initial={{ opacity: 1 }}
          animate={{
            opacity: 0,
            transition: { ...TRANSITION.slow, delay: seconds(DURATION.slow) },
          }}
        />
      )}
      <div className="relative flex items-start gap-2.5">
        {/* The `art` crop as decoration beside the name — `aria-hidden`, empty alt and
            `draggable={false}`, `PullFromCollectionDialog`'s arrangement. Through `CardImage`,
            never a bare `<img>`: this is a slot, and a pick changes the card in it. */}
        <span aria-hidden="true" className="mt-0.5 h-8 w-11 shrink-0 overflow-hidden rounded bg-bg">
          {art !== null && (
            <CardImage
              src={art}
              alt=""
              draggable={false}
              // A plain scroller, so a long tray really is every row mounted.
              loading="lazy"
              className="size-full object-cover"
            />
          )}
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
              <Dropdown
                size="sm"
                label={`Finish of ${label}`}
                value={row.finish}
                onChange={(v) => onFinish(v as Finish)}
                options={FINISH_OPTIONS}
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
  const src = cardArtSrc(cardImageUrl(choice.cardId, 0, "thumb"));
  return (
    <button
      type="button"
      aria-label={printing === "" ? choice.name : `${choice.name} — ${printing}`}
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
        {src !== null && (
          <CardImage src={src} alt="" draggable={false} loading="lazy" className="size-full object-cover" />
        )}
      </span>
      <span aria-hidden="true" className="truncate text-center font-mono text-[0.625rem] text-dim">
        {printing}
      </span>
    </button>
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
 * **Drawn inline, above its button, rather than as a popup of its own.** The footer is the bottom
 * edge of the panel, so a popup here would open downward off the window; inline, the list pushes
 * the rows' scroller up by its own height and the button stays where the reader's pointer is.
 * `MoveToFolder`'s `inline` mode is that shape, role and all.
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A folder another surface deleted reads as the top level, which is where `buildFolderTree`
  // puts a child whose parent is gone. While the list is still loading a named folder has no name
  // yet, and the collection's word would be a wrong answer rather than a pending one.
  const name =
    folderId === null
      ? ROOT_LABEL
      : query.isPending
        ? "…"
        : (mine.find((folder) => folder.id === folderId)?.name ?? ROOT_LABEL);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useDismissOnEscape({ layer: "inner", onDismiss: close, enabled: open });

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5"
      // Focus leaving the picker closes it, and the boundary is the button *and* the list: a press
      // on the button while the list is open blurs the list first, and closing there would race
      // the toggle and reopen what the press meant to shut.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {open && (
        <div className="rounded-md border border-border bg-bg">
          <MoveToFolder
            label="File the scanned cards in a folder"
            nodes={nodes}
            currentId={folderId}
            rootLabel={ROOT_LABEL}
            inline
            pending={false}
            onPick={(id) => {
              onFolder(id);
              close();
            }}
            // Deliberately nothing: the root above owns "focus left", for the race it describes.
            onClose={() => {}}
          />
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-label={`Folder: ${name}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 min-w-0 items-center gap-2 rounded-md border border-border px-2.5 text-sm text-dim hover:text-text",
          PRESS,
          FOCUS,
        )}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left text-text">{name}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
