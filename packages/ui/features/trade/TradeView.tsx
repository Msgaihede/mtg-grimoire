import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeftRight,
  Check,
  Copy,
  Lock,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { PageBar } from "@/components/PageBar";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { exportFileName } from "@/features/decks/deckExport";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { tradeDestination } from "@/features/transfer/import/destinations/TradePreview";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { fromTradeLine } from "@/features/transfer/TransferCard";
import { FOCUS } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import type { Trade, TradeSide, TradeSummary } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { notify } from "@/lib/notifications";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FinishTradeDialog } from "./FinishTradeDialog";
import { isOpen, isSettled, linesOf, tradeMoney } from "./trade";
import { TradeBalance } from "./TradeBalance";
import {
  REFUSAL,
  TRADE_BARE_BUTTON,
  TRADE_BUTTON,
  TRADE_BUTTON_ACCENT,
  TRADE_ICON_BUTTON,
} from "./tradeControls";
import { TradeScanDialog } from "./TradeScanDialog";
import { TradeSidePanel } from "./TradeSidePanel";
import { closedBanner, headerLine, sideHeading, sideWords, tradeCurrency } from "./tradeWords";
import { TRADE_LIST_KEY, tradeKey, useTradeWrites } from "./useTrades";

/**
 * One trade, whole: its name and what can be done to it, the two sides, and the balance.
 *
 * ## Open and closed are one component
 *
 * A trade that is finished or archived is the same three bands with the controls taken out — no
 * rename, no add rows, no steppers, a banner saying why — rather than a second page. That is what
 * keeps *Finish trade* from being a navigation: the reader presses it, and the page they are
 * already looking at stops being editable.
 *
 * ## Every write says where it failed
 *
 * The header's own writes — rename, duplicate, archive, reopen, delete — report under the name.
 * Duplicate, archive and delete also say a landing as a toast (finish says its own, from its
 * dialog): the menu that offered two of them has closed, and a delete takes this page with it.
 * Rename, reopen and the swap do not — each is drawn in place the moment its read lands.
 * A line's report on the line and a side's add row reports under its field, in their own files.
 * Each is the backend's sentence after a dash, because the backend is the one that knows whether
 * the trade was archived in another window or the name was taken.
 *
 * ## The caret after a write that removes its own button
 *
 * Archive, Reopen and Finish each replace the header they were pressed in: the button the reader
 * pressed is gone a read later. A caret on an element that unmounts falls to `<body>`, and the
 * next Tab starts from the top of the app — so those three put it on this section instead, which
 * is here whatever the trade's status. It is a landing pad (`tabIndex={-1}`) and carries no ring.
 *
 * **A trade that was just made lands the same way, from the other end** (`land`): the press that
 * made it — Create trade in a dialog that has closed, Duplicate on a trade that is no longer the
 * one drawn — has nothing left to hand the caret back to, so the new trade takes it as it mounts.
 *
 * ## The divider swaps the sides
 *
 * On an open trade the arrows between the two panels are a button (issue #936): every line goes
 * to the other side in one write, and the percentages stay with the sides they were set on. Its
 * refusal is a header write's, under the name. A closed trade keeps the arrows as a drawing.
 *
 * ## A side in and out of a file
 *
 * Each side's Import and Export (issue #903) open the app's own two dialogs, mounted here for the
 * scanner's reason. Export reads the side straight off the trade it was handed — a trade is one
 * read, so there is nothing to sweep — and answers on every status, a finished or archived trade
 * included. Import is the open trade's alone, onto the one side it was pressed on, and every way
 * out of either hands the caret back to the button that opened it.
 */
export function TradeView({
  trade,
  land: landOnMount = false,
  onLanded,
  onSelect,
  onDeleted,
  barSlot,
  landOn,
}: {
  trade: Trade;
  /** Take the caret on mount: this trade is the answer to a press whose own control is gone. */
  land?: boolean;
  /** The caret was taken. The page forgets the debt, so a later visit here does not repeat it. */
  onLanded?: () => void;
  /** Show another trade — the copy a Duplicate has just made. */
  onSelect: (id: number) => void;
  /** This trade is gone. The page picks what to show instead. */
  onDeleted: () => void;
  /**
   * Where the trade's page bar is drawn: the desktop page's slot above the trade list and this
   * view together (the owner's note, 2026-10-21 — the heading spans the page), `null` while
   * that slot has not mounted yet, and absent where there is no slot — the phone's trade page —
   * and the bar is then this section's first row. A portal, so the bar stays this view's: its
   * rename field, pencil and actions keep their state, refs and handlers here.
   */
  barSlot?: HTMLElement | null;
  /**
   * What takes the caret when this view lands — the trade's region. The desktop page's section
   * when it draws the bar (`barSlot`), since that section is the region named for the trade;
   * absent, this view's own section.
   */
  landOn?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const tip = useTooltip();
  const client = useQueryClient();
  const writes = useTradeWrites();
  const { menuClick } = useContextMenu();

  const sectionRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const finishRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  /** The camera button the scanner was opened from: there are two, one a side. */
  const scanOpener = useRef<HTMLElement | null>(null);
  /** The Import or Export button a transfer dialog was opened from — four of them, two a side. */
  const transferOpener = useRef<HTMLElement | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  /** Kept apart from `scanOpen` so the dialog's fade-out still knows which side it was on. */
  const [scanSide, setScanSide] = useState<TradeSide>("mine");
  /** Which transfer dialog is up. The side is kept apart for `scanSide`'s reason: the dialog's
   *  fade-out still has to say which side it was about. */
  const [transfer, setTransfer] = useState<"import" | "export" | null>(null);
  const [transferSide, setTransferSide] = useState<TradeSide>("mine");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const editable = isOpen(trade.status);
  const settled = isSettled(trade.status);
  const currency = tradeCurrency(trade);
  const money = tradeMoney(trade);

  /** One header write at a time, and its refusal under the name. */
  const run = (what: string, write: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    write()
      .catch((e: unknown) => setFailure(`Couldn't ${what} — ${ipcError(e)}`))
      .finally(() => setBusy(false));
  };

  /** See the component's note: the pressed button is about to leave the page. */
  const land = () => (landOn?.current ?? sectionRef.current)?.focus({ preventScroll: true });

  // Once, as the trade is first drawn. The debt is the page's and is read only here: the view is
  // keyed by its trade, so "on mount" is "when this trade took the place of whatever was shown".
  const landing = useRef({ owed: landOnMount, onLanded, target: landOn });
  useEffect(() => {
    if (!landing.current.owed) return;
    (landing.current.target?.current ?? sectionRef.current)?.focus({ preventScroll: true });
    landing.current.onLanded?.();
  }, []);

  const rename = (name: string) => {
    setRenaming(false);
    // Checked before the cache is touched: a patch with no write behind it would be a name the
    // page shows and the database does not hold.
    if (busy || name === trade.name) return;
    // The name is drawn in two places the write does not patch, and a rename that showed the old
    // name for the length of a read would look refused. Written here, replaced by the truth when
    // the write settles — on a failure that is the old name, back.
    client.setQueryData<Trade | null>(tradeKey(trade.id), (now) => (now ? { ...now, name } : now));
    client.setQueryData<TradeSummary[]>(TRADE_LIST_KEY, (list) =>
      list?.map((row) => (row.id === trade.id ? { ...row, name } : row)),
    );
    run("rename the trade", () => writes.rename(trade.id, name));
  };

  // The pencil is not drawn while the field is, so the caret is handed back to it only once it
  // exists again — on the render after the field closes, which is what this effect sees.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) renameRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  /** Every line onto the other side. A trade with no lines has nothing to move, so the press
   *  writes nothing; the percentages stay with their sides. */
  const swap = () => {
    if (trade.lines.length === 0) return;
    run("swap the sides", () => writes.swapSides(trade.id));
  };

  // A receipt, because the press is often the More menu's and the menu has closed; the page then
  // moves to the copy, which is a different trade under the same name until the reader renames it.
  const duplicate = () =>
    run("duplicate the trade", () =>
      writes.duplicate(trade.id).then((copy) => {
        notify.success(`Duplicated “${trade.name}”`);
        onSelect(copy);
      }),
    );

  const openTransfer = (kind: "import" | "export", side: TradeSide, opener: HTMLElement) => {
    transferOpener.current = opener;
    setTransferSide(side);
    setTransfer(kind);
  };
  const closeTransfer = () => setTransfer(null);
  const dismissTransfer = () => {
    setTransfer(null);
    transferOpener.current?.focus();
  };
  // Identity only — `tradeDestination`'s rule: a new destination remounts the step under the
  // reader, so it changes with the trade and the side and with nothing a read can move.
  const importInto = useMemo(
    () => [tradeDestination({ tradeId: trade.id, side: transferSide })],
    [trade.id, transferSide],
  );
  const exported = useMemo(
    () => linesOf(trade.lines, transferSide).map(fromTradeLine),
    [trade.lines, transferSide],
  );

  const openScan = (side: TradeSide, opener: HTMLElement) => {
    scanOpener.current = opener;
    setScanSide(side);
    setScanOpen(true);
  };

  /**
   * What More opens. A closed trade has Duplicate and Reopen as buttons of their own, so its menu
   * is the one thing that is left — and the ellipsis on Delete is the app's mark for a row that
   * asks a question before it does anything.
   */
  const menu = (): MenuItem[] => {
    const remove: MenuItem = {
      kind: "action",
      id: "delete",
      label: "Delete…",
      Icon: Trash2,
      onSelect: () => setDeleting(true),
    };
    if (!editable) return [remove];
    return [
      {
        kind: "action",
        id: "rename",
        label: "Rename",
        Icon: Pencil,
        onSelect: () => setRenaming(true),
      },
      { kind: "action", id: "duplicate", label: "Duplicate", Icon: Copy, onSelect: duplicate },
      remove,
    ];
  };

  /* **The page bar** ("Page & Section Headings", option A, 2026-10-21): a trade is a sub-page
     of the Trade view, so the trail is `Trade ›` and the trade's own name is the title — an
     `<h3>` under the view's `sr-only` `<h2>`, the level it always had. **The crumb is words,
     not a button**: the trades are `TradesPane`, the column under the bar beside this view,
     not a page to go back to — a `Trade` button here would go nowhere the reader is not
     already looking.

     The rename field takes the title's place (`titleAs="div"`, `titleGrows`: the field is a
     control, it carries its own name, and it takes the row's spare width). The pencil and the
     header line ride in the slot after the title; the actions take the right end.

     Built here and drawn through {@link barSlot}, so on the desktop it spans the page — above
     the trade list as well as this view — while staying this view's own. */
  const bar = (
    <PageBar
      trail={[{ label: "Trade" }]}
      titleAs={renaming ? "div" : "h3"}
      titleGrows={renaming}
      title={
        renaming ? (
          <RenameField
            initial={trade.name}
            onSubmit={rename}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="block min-w-0 truncate"
            {...tip(trade.name, { whenClipped: true, describes: false })}
          >
            {trade.name}
          </span>
        )
      }
      figures={
        editable && !renaming ? (
          <button
            ref={renameRef}
            type="button"
            aria-label="Rename trade"
            onClick={() => setRenaming(true)}
            // Pulled in against the name it renames, to the 8px it stood at before the bar:
            // the bar's `gap-x-5` is the space between a title and its meta, and a pencil that
            // far out reads as a control of the row.
            className={cn(TRADE_BARE_BUTTON, "-ml-3 self-center")}
            {...tip("Rename", { describes: false })}
          >
            <Pencil className="size-[0.9375rem]" aria-hidden="true" />
          </button>
        ) : undefined
      }
      // The header line is a sentence, not a count, and in the pane beside the trade list it is
      // wider than the room left — so it gives way (the meta box truncates) and says the rest on
      // hover. The tooltip is on a box of its own that clips itself: `whenClipped` asks the
      // element it is bound to, and the bar's own span is not ours to bind.
      meta={
        <span
          className="block truncate"
          {...tip(headerLine(trade), { whenClipped: true, describes: false })}
        >
          {headerLine(trade)}
        </span>
      }
      actions={
        <>
          {!editable && (
            <>
              <button
                type="button"
                aria-disabled={busy || undefined}
                onClick={duplicate}
                className={TRADE_BUTTON}
              >
                <Copy className="size-4" aria-hidden="true" />
                Duplicate
              </button>
              <button
                type="button"
                aria-disabled={busy || undefined}
                onClick={() => run("reopen the trade", () => writes.reopen(trade.id).then(land))}
                className={TRADE_BUTTON}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reopen
              </button>
            </>
          )}
          {/* `aria-haspopup` and no `aria-expanded`: the open state is `ContextMenuProvider`'s,
              and a static `false` here would be wrong for exactly as long as the menu is up. */}
          <button
            ref={moreRef}
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            onClick={menuClick(menu)}
            className={TRADE_ICON_BUTTON}
            {...tip("More actions", { describes: false })}
          >
            <MoreHorizontal className="size-[1.125rem]" aria-hidden="true" />
          </button>
          {editable && (
            <button
              type="button"
              aria-disabled={busy || undefined}
              onClick={() =>
                // Archiving puts the trade away — a receipt, as every archive in the app has.
                run("archive the trade", () =>
                  writes.archive(trade.id).then(() => {
                    notify.success(`Archived “${trade.name}”`);
                    land();
                  }),
                )
              }
              className={TRADE_BUTTON}
            >
              <Archive className="size-4" aria-hidden="true" />
              Archive
            </button>
          )}
        </>
      }
    />
  );

  return (
    <section
      ref={sectionRef}
      // The trade's region where this view draws its own bar (the phone); on the desktop the
      // page's section is, because the bar it names is drawn there (`barSlot`).
      aria-label={barSlot === undefined ? trade.name : undefined}
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 outline-none"
    >
      {barSlot === undefined ? bar : barSlot !== null && createPortal(bar, barSlot)}
      {/* Under the bar rather than in it: a refusal is a sentence the reader has to be able to read
          whole, and the bar's row truncates. */}
      {failure !== null && (
        <p role="alert" className={REFUSAL}>
          {failure}
        </p>
      )}

      {!editable && (
        <p className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[0.8125rem] text-dim">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{closedBanner(trade)}</span>
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
        <TradeSidePanel
          trade={trade}
          side="mine"
          onScan={openScan}
          onImport={(at, opener) => openTransfer("import", at, opener)}
          onExport={(at, opener) => openTransfer("export", at, opener)}
        />
        <div className="relative grid place-items-center">
          <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-border" />
          {editable ? (
            <button
              type="button"
              aria-label="Swap sides"
              aria-disabled={busy || trade.lines.length === 0 || undefined}
              onClick={swap}
              className={cn(
                "relative grid size-6 place-items-center rounded-full border border-border bg-bg text-dim",
                "hover:border-accent hover:text-accent",
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
                "aria-disabled:hover:border-border aria-disabled:hover:text-dim",
                "aria-disabled:active:scale-100",
                PRESS,
                FOCUS,
              )}
              {...tip("Swap sides", { describes: false })}
            >
              <ArrowLeftRight className="size-3" aria-hidden="true" />
            </button>
          ) : (
            <span
              aria-hidden="true"
              className="relative grid size-6 place-items-center rounded-full border border-border bg-bg text-dim"
            >
              <ArrowLeftRight className="size-3" />
            </span>
          )}
        </div>
        <TradeSidePanel
          trade={trade}
          side="theirs"
          onScan={openScan}
          onImport={(at, opener) => openTransfer("import", at, opener)}
          onExport={(at, opener) => openTransfer("export", at, opener)}
        />
      </div>

      <TradeBalance
        money={money}
        currency={currency}
        // Only a finished trade's balance is a record. One archived unfinished still owes.
        past={settled}
        labels={{
          mine: sideHeading("mine", trade.status),
          theirs: sideHeading("theirs", trade.status),
        }}
      >
        {editable && (
          <button
            ref={finishRef}
            type="button"
            onClick={() => setFinishing(true)}
            className={cn(TRADE_BUTTON_ACCENT, "mt-2.5 px-5")}
          >
            <Check className="size-4" aria-hidden="true" />
            Finish trade
          </button>
        )}
      </TradeBalance>

      {editable && (
        <>
          <FinishTradeDialog
            open={finishing}
            trade={trade}
            onFinished={() => {
              setFinishing(false);
              land();
            }}
            onDismiss={() => {
              setFinishing(false);
              finishRef.current?.focus();
            }}
            onClose={() => setFinishing(false)}
          />
          <TradeScanDialog
            open={scanOpen}
            trade={trade}
            side={scanSide}
            onSide={setScanSide}
            // Every way out of the scanner is this one call, so the caret goes back on all of
            // them. The side's camera is still there whatever was added.
            onClose={() => {
              setScanOpen(false);
              scanOpener.current?.focus();
            }}
          />
          {/* One destination, so no radios: the side the reader pressed Import on. The message
              is discarded, the wishlist's precedent — the cards are on the side behind it, and the
              dialog's own toast (`report`) says how many went there. */}
          <ImportDialog
            destinations={importInto}
            subtitle={`Onto ${sideWords(transferSide)} of “${trade.name}”`}
            open={transfer === "import"}
            onDismiss={dismissTransfer}
            onClose={closeTransfer}
            onDone={dismissTransfer}
          />
        </>
      )}

      <ExportDialog
        open={transfer === "export"}
        subject={`${trade.name} — ${sideHeading(transferSide, trade.status)}`}
        surface="trade"
        cards={exported}
        suggestedFileName={exportFileName(trade.name, sideHeading(transferSide, trade.status))}
        onDismiss={dismissTransfer}
        onClose={closeTransfer}
      />

      <ConfirmDialog
        open={deleting}
        title="Delete this trade?"
        confirmLabel="Delete trade"
        // Nothing here is the reader's only copy of a card: a trade is a list about cards, and
        // deleting it moves none of them. A typed word would be ceremony.
        typeToConfirm={false}
        pending={busy}
        // A delete is the one header write whose page goes with it — this view unmounts on the
        // answer — so its receipt is a toast, the only place left to say it.
        onConfirm={() =>
          run("delete the trade", () =>
            writes.remove(trade.id).then(() => {
              notify.success(`Deleted “${trade.name}”`);
              onDeleted();
            }),
          )
        }
        onDismiss={() => {
          setDeleting(false);
          moreRef.current?.focus();
        }}
        onClose={() => setDeleting(false)}
      >
        “{trade.name}” and the cards listed on both of its sides will be deleted.{" "}
        {settled
          ? "What finishing it did to your collection and your wishlist stays done."
          : "Your collection and your wishlist are not touched."}
      </ConfirmDialog>
    </section>
  );
}

/**
 * The trade's name, being changed.
 *
 * Drawn where the heading was and in its type, so the name does not jump while it is edited.
 * **Enter writes, Escape and leaving the field give up** — the app's rule for a rename in place
 * (`FolderNameField`), because a rename committed by clicking elsewhere is a rename the reader did
 * not finish typing. A name left blank or unchanged is a cancel: the backend would refuse the one
 * and the other is nothing to write.
 *
 * The Escape rung is `"inner"`: with the field up, the press is this field's, and must not reach
 * whatever is listening behind the page.
 */
function RenameField({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useDismissOnEscape({ layer: "inner", onDismiss: onCancel, enabled: true });

  return (
    <form
      // The page bar's title slot grows for a field (`titleGrows`); the form is its flex item.
      className="min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed) onSubmit(trimmed);
        else onCancel();
      }}
    >
      <input
        ref={inputRef}
        aria-label="Trade name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={onCancel}
        autoComplete="off"
        className={cn(
          "w-full max-w-md rounded-md border border-accent bg-bg px-2",
          // `PAGE_TITLE`'s face, size and tracking, so the name does not jump while it is edited.
          "font-heading text-xl leading-tight font-semibold tracking-[0.02em] text-text outline-none",
        )}
      />
    </form>
  );
}
