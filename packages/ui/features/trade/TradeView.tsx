import { useEffect, useRef, useState, type JSX } from "react";
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
import { useTooltip } from "@/components/tooltip/useTooltip";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { ipcError } from "@/lib/ipc";
import type { Trade, TradeSide, TradeSummary } from "@/lib/ipc";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FinishTradeDialog } from "./FinishTradeDialog";
import { isOpen, isSettled, tradeMoney } from "./trade";
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
import { closedBanner, headerLine, sideHeading, tradeCurrency } from "./tradeWords";
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
 */
export function TradeView({
  trade,
  land: landOnMount = false,
  onLanded,
  onSelect,
  onDeleted,
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

  const [renaming, setRenaming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  /** Kept apart from `scanOpen` so the dialog's fade-out still knows which side it was on. */
  const [scanSide, setScanSide] = useState<TradeSide>("mine");
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
  const land = () => sectionRef.current?.focus({ preventScroll: true });

  // Once, as the trade is first drawn. The debt is the page's and is read only here: the view is
  // keyed by its trade, so "on mount" is "when this trade took the place of whatever was shown".
  const landing = useRef({ owed: landOnMount, onLanded });
  useEffect(() => {
    if (!landing.current.owed) return;
    sectionRef.current?.focus({ preventScroll: true });
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

  const duplicate = () =>
    run("duplicate the trade", () => writes.duplicate(trade.id).then(onSelect));

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

  return (
    <section
      ref={sectionRef}
      aria-label={trade.name}
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 outline-none"
    >
      <header className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField
              initial={trade.name}
              onSubmit={rename}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <h3
                className="min-w-0 truncate font-heading text-2xl leading-tight font-semibold"
                {...tip(trade.name, { whenClipped: true, describes: false })}
              >
                {trade.name}
              </h3>
              {editable && (
                <button
                  ref={renameRef}
                  type="button"
                  aria-label="Rename trade"
                  onClick={() => setRenaming(true)}
                  className={TRADE_BARE_BUTTON}
                  {...tip("Rename", { describes: false })}
                >
                  <Pencil className="size-[0.9375rem]" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <p className="text-[0.8125rem] text-dim">{headerLine(trade)}</p>
          {failure !== null && (
            <p role="alert" className={cn(REFUSAL, "mt-1")}>
              {failure}
            </p>
          )}
        </div>

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
        {/* `aria-haspopup` and no `aria-expanded`: the open state is `ContextMenuProvider`'s, and
            a static `false` here would be wrong for exactly as long as the menu is up. */}
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
            onClick={() => run("archive the trade", () => writes.archive(trade.id).then(land))}
            className={TRADE_BUTTON}
          >
            <Archive className="size-4" aria-hidden="true" />
            Archive
          </button>
        )}
      </header>

      {!editable && (
        <p className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[0.8125rem] text-dim">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{closedBanner(trade)}</span>
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
        <TradeSidePanel trade={trade} side="mine" onScan={openScan} />
        <div aria-hidden="true" className="relative grid place-items-center">
          <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
          <span className="relative grid size-6 place-items-center rounded-full border border-border bg-bg text-dim">
            <ArrowLeftRight className="size-3" />
          </span>
        </div>
        <TradeSidePanel trade={trade} side="theirs" onScan={openScan} />
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
        </>
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete this trade?"
        confirmLabel="Delete trade"
        // Nothing here is the reader's only copy of a card: a trade is a list about cards, and
        // deleting it moves none of them. A typed word would be ceremony.
        typeToConfirm={false}
        pending={busy}
        onConfirm={() => run("delete the trade", () => writes.remove(trade.id).then(onDeleted))}
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
          "font-heading text-2xl leading-tight font-semibold text-text outline-none",
        )}
      />
    </form>
  );
}
