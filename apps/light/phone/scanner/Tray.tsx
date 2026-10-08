import { useEffect, useId, useRef, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowDown, ChevronRight, Minus, Plus, X } from "lucide-react";
import { CardArt } from "@grimoire/ui/components/CardArt";
import { CardImage } from "@grimoire/ui/components/CardImage";
import { cardPrintingsKey } from "@grimoire/ui/features/card/cardKeys";
import {
  needsDecision,
  NEXT_DECISION_LABEL,
  nextDecisionKey,
  pickChoice,
  removeRow,
  setFinish,
  setPrinting,
  setQuantity,
  totalCopies,
  unresolvedCount,
} from "@grimoire/ui/features/scanner/reader/tray";
import {
  isKnownFinish,
  TRAY_FINISH_LABEL,
  UNKNOWN_FINISH,
} from "@grimoire/ui/features/scanner/reader/trayFinish";
import { useTrayPrices } from "@grimoire/ui/features/scanner/reader/useTrayPrices";
import { plural } from "@grimoire/ui/lib/counts";
import { FINISHES, parseFinishes } from "@grimoire/ui/lib/finish";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { CARD_ASPECT, cardImageUrl } from "@grimoire/ui/lib/images";
import {
  ipc,
  ipcError,
  type ScannerTrayChoice,
  type ScannerTrayFinish,
  type ScannerTrayRow,
} from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { DURATION, PRESS, seconds, TRANSITION } from "@grimoire/ui/lib/motion";
import { formatPrice } from "@grimoire/ui/lib/prices";
import { useMarketplace } from "@grimoire/ui/lib/useMarketplace";
import { cn } from "@grimoire/ui/lib/utils";
import { PRINTING_ROW, PrintingFace, printingCode } from "../card/Printings";
import { ActionSheet, SheetChoice } from "../deck/sheet";

/** `MH2 259`, or `""` for a row with no printing to name — the tray's own spelling. */
function printingOf(p: { setCode: string; collectorNumber: string }): string {
  return [p.setCode.toUpperCase(), p.collectorNumber].filter((part) => part !== "").join(" ");
}

/**
 * What a row is called, and it has to be more than the card's name: two Forests from two sets are
 * the ordinary case in a tray, so the printing rides along wherever there is one — the desktop
 * tray's `rowLabel`, so a control has the same name on both faces.
 */
function rowLabel(row: ScannerTrayRow): string {
  const printing = row.choices.length > 0 ? "" : printingOf(row);
  return printing === "" ? row.name : `${row.name} — ${printing}`;
}

/** What a candidate is called — `<name> — <SET> <number>`, the desktop tray's. */
function choiceLabel(choice: ScannerTrayChoice): string {
  const printing = printingOf(choice);
  return printing === "" ? choice.name : `${choice.name} — ${printing}`;
}

/** A tray finish's choices, plain before the premium treatments and `Unknown` last — it is not a
 *  finish but the answer "not yet", which a reader can also give on purpose. */
const TRAY_FINISHES: readonly ScannerTrayFinish[] = [...FINISHES, UNKNOWN_FINISH];

/** A 44px square press on a row: the stepper's two and the remove. */
const SQUARE = cn(
  "flex size-11 shrink-0 items-center justify-center rounded-md border border-border",
  PRESS,
  FOCUS,
);

/**
 * A worded 44px press on a row: the printing and the finish, each opening a list.
 *
 * **8px of side padding, not the bar's 12**: at 360px the row's three controls share 312px, and
 * with the finish reading `Unknown` a wider pad cut the printing beside it to `STA 1…` — the
 * collector number gone (seen in the 360px pass, step 7.6).
 */
const WORDED = cn(
  "inline-flex h-11 min-w-0 items-center gap-1 rounded-md border border-border px-2 text-sm",
  PRESS,
  FOCUS,
);

/** Which list a row's sheet is open on. */
type Asking = { key: string; page: "finish" | "printing" } | null;

/**
 * How long after a sheet closes the caret is still put back if it has fallen out of the page.
 * Long enough for the write the sheet made to be drawn — a tick, through the tray's cache — and
 * short enough that a card scanned later never moves a caret the reader has since put down.
 */
const HAND_BACK_MS = 400;

/**
 * The review tray on the phone: every card the scanner has taken, newest first, as rows a thumb
 * can work.
 *
 * **The rows are the real tray** — `useTray`'s, the one `app_meta` row both faces of an install
 * read — and every press goes back through `onRows` as **a reducer call waiting for its rows**,
 * the desktop tray's rule: the pump writes the newest card between two renders, and an edit built
 * from the `rows` prop would write the tray back without it. The reducers are `reader/tray.ts`'s,
 * the same ones the desktop's panel calls.
 *
 * **A drawing of its own rather than `TrayPanel`, and the reasons are all about the finger.** The
 * desktop panel's finish is a 28px dropdown, its stepper 28px, its *More printings…* a chip that
 * appears under the pointer, its clipped name a tooltip and its refusals tooltips too. Here:
 *
 * - the **name wraps** rather than truncating, so there is nothing to hover for;
 * - **the printing is a press** that says what it is (`MH2 259 ›`) and opens the printings as a
 *   sheet — the phone has no all-printings wall — where a press hands the printing back through
 *   `setPrinting`;
 * - **the finish is a press** that says what it is and opens its four answers as a sheet, gold
 *   while the answer is `Unknown`, the colour this tray asks its questions in;
 * - **the stepper is 44px a side**, and stops at one — the row's own `×` is the removal;
 * - **a row waiting on a pick is its candidates**, as whole cards three to a line (what tells two
 *   printings apart is the frame, not the art), each named `<name> — <SET> <number>`, with
 *   *More printings…* under them for a card that is none of the three.
 *
 * **One layout.** The desktop tray's grid of tiles wants a finish and a stepper under each card,
 * which at 44px a control does not fit under a 156px tile; so the phone draws the list and leaves
 * the stored `trayLayout` — the desktop's, in the same row of prefs — unread and unwritten.
 *
 * **It scrolls with the page**, not in a box of its own: the page's footer is what stays put.
 */
export function Tray({
  rows,
  onRows,
  flashKey,
}: {
  rows: readonly ScannerTrayRow[];
  /** An edit, as a function of the rows — never the rows this render drew. */
  onRows: (update: (rows: ScannerTrayRow[]) => ScannerTrayRow[]) => void;
  /** The row just added or bumped, for the wash. */
  flashKey: string | null;
}) {
  const titleId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const copies = totalCopies(rows);
  const waiting = unresolvedCount(rows);
  const deciding = rows.some(needsDecision);
  const { priceOf, currency, marketplaceLabel } = useTrayPrices(rows);

  const [asking, setAsking] = useState<Asking>(null);
  // Looked up in the rows on screen, so a row a commit took — or the reader removed — while its
  // sheet was open closes the sheet rather than leaving it open on a card that has gone.
  const asked = asking === null ? null : (rows.find((row) => row.key === asking.key) ?? null);

  /**
   * **The caret goes back to the press that opened the sheet** — after a choice, and after Escape
   * or the ✕; a press on the scrim leaves it where the reader put it (`Dialog`'s two ways out).
   *
   * **Found again after the render, never remembered as an element**, and found a second time if
   * it has fallen out of the page. A choice in a sheet is a write, and the write is drawn a tick
   * after the sheet closes (it goes through the tray's cache): the press that opened the printings
   * of a row still waiting on a pick is *More printings…*, which is on screen when the sheet
   * closes and gone a tick later, when the row draws as settled — a target that is connected and
   * doomed. So the row is looked up by its key and the control by what it opens, on the close
   * and again on the rows that follow it, for {@link HAND_BACK_MS}; and only while the caret is
   * nowhere (on `body`, or still inside the sheet that is leaving), so it is never taken from
   * where the reader has since put it.
   */
  const handBack = useRef<Asking>(null);
  const handBackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forget = () => {
    if (handBackTimer.current !== null) clearTimeout(handBackTimer.current);
    handBackTimer.current = null;
    handBack.current = null;
  };
  const open = (key: string, page: "finish" | "printing") => {
    forget();
    setAsking({ key, page });
  };
  const close = (restore: boolean) => {
    forget();
    if (restore && asking !== null) {
      handBack.current = asking;
      handBackTimer.current = setTimeout(forget, HAND_BACK_MS);
    }
    setAsking(null);
  };
  useEffect(() => forget, []);
  useEffect(() => {
    const to = handBack.current;
    if (asking !== null || to === null) return;
    const active = document.activeElement;
    const adrift =
      active === null || active === document.body || active.closest('[role="dialog"]') !== null;
    if (!adrift) return;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-tray-row]") ?? [],
    ).find((el) => el.dataset.trayRow === to.key);
    const target =
      row?.querySelector<HTMLElement>(`[data-opens="${to.page}"]`) ??
      row?.querySelector<HTMLElement>("[data-opens]");
    target?.focus({ preventScroll: true });
  }, [asking, rows]);

  // The walk's cursor: the row the last press landed on, by key — `nextDecisionKey` says why a key.
  const [cursor, setCursor] = useState<string | null>(null);
  const nextDecision = () => {
    const key = nextDecisionKey(rows, cursor);
    const list = listRef.current;
    if (key === null || list === null) return;
    setCursor(key);
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-tray-row]")).find(
      (el) => el.dataset.trayRow === key,
    );
    if (row === undefined) return;
    // The page is the one scroller here, so the row is brought to the middle of it. jsdom has no
    // `scrollIntoView`, hence the optional call.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    row.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    // The caret goes to the question itself, so the answer is one press away.
    row.querySelector<HTMLElement>("[data-decision]")?.focus({ preventScroll: true });
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col">
      <header className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1">
        {/* The name is spelled, not computed: the title and its count are two elements a gap
            apart, which the name algorithm fuses into `Scanned cards3`. */}
        <h2
          aria-label={`Scanned cards, ${plural(copies, "copy", "copies")}`}
          className="flex items-baseline gap-2 font-heading text-lg leading-none"
        >
          <span id={titleId}>Scanned cards</span>
          <span aria-hidden="true" className="font-mono text-sm tabular-nums text-dim">
            {copies}
          </span>
        </h2>
        {waiting > 0 && (
          <span className="text-xs text-accent">{plural(waiting, "card")} to pick</span>
        )}
        {/* Hidden rather than greyed when nothing is waiting: a control that can do nothing is
            one a reader keeps trying. Gold, because it walks the questions gold already marks. */}
        {deciding && (
          <button
            type="button"
            onClick={nextDecision}
            className={cn(
              "ml-auto inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 px-3",
              "text-xs text-accent",
              PRESS,
              FOCUS,
            )}
          >
            <ArrowDown aria-hidden className="size-3.5" />
            {NEXT_DECISION_LABEL}
          </button>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-dim">Cards you scan appear here.</p>
      ) : (
        <ul ref={listRef} className="flex flex-col">
          {rows.map((row) => (
            <TrayRow
              key={row.key}
              row={row}
              flash={row.key === flashKey}
              price={priceOf(row)}
              currency={currency}
              marketplaceLabel={marketplaceLabel}
              onQuantity={(q) => onRows((latest) => setQuantity(latest, row.key, q))}
              onPick={(cardId) => onRows((latest) => pickChoice(latest, row.key, cardId))}
              onRemove={() => onRows((latest) => removeRow(latest, row.key))}
              onAsk={(page) => open(row.key, page)}
            />
          ))}
        </ul>
      )}

      <ActionSheet
        open={asked !== null && asking?.page === "finish"}
        title={asked?.name ?? "Finish"}
        subtitle="Finish"
        closeLabel="Close finishes"
        onClose={() => close(false)}
        onDismiss={() => close(true)}
      >
        {asked !== null && (
          <ul aria-label="Finishes">
            {TRAY_FINISHES.map((finish) => (
              <SheetChoice
                key={finish}
                label={TRAY_FINISH_LABEL[finish]}
                note={
                  finish === UNKNOWN_FINISH
                    ? "Stays in the tray when you add the rest."
                    : undefined
                }
                current={finish === asked.finish}
                onPick={() => {
                  onRows((latest) => setFinish(latest, asked.key, finish));
                  close(true);
                }}
              />
            ))}
          </ul>
        )}
      </ActionSheet>

      <ActionSheet
        open={asked !== null && asking?.page === "printing"}
        title={asked?.name ?? "Printings"}
        subtitle="Which printing is it?"
        closeLabel="Close printings"
        onClose={() => close(false)}
        onDismiss={() => close(true)}
      >
        {asked !== null && (
          <PrintingsPage
            row={asked}
            onPick={(choice) => {
              // The hand-back builds on the tray as it is now: the camera keeps running behind
              // the sheet, and a card scanned meanwhile must not be written away by it.
              onRows((latest) => setPrinting(latest, asked.key, choice));
              close(true);
            }}
          />
        )}
      </ActionSheet>
    </section>
  );
}

/**
 * One scanned card.
 *
 * **Resolved, it is a line of controls; waiting, it is a question** — the desktop row's rule: a
 * row with candidates draws no finish and no stepper, because none of them means anything until
 * the reader has said which printing this is. What stays in both is the way out: remove.
 */
function TrayRow({
  row,
  flash,
  price,
  currency,
  marketplaceLabel,
  onQuantity,
  onPick,
  onRemove,
  onAsk,
}: {
  row: ScannerTrayRow;
  flash: boolean;
  price: number | null | undefined;
  currency: Currency;
  marketplaceLabel: string;
  onQuantity: (quantity: number) => void;
  onPick: (cardId: string) => void;
  onRemove: () => void;
  onAsk: (page: "finish" | "printing") => void;
}) {
  const waiting = row.choices.length > 0;
  const label = rowLabel(row);
  const printing = printingOf(row);
  const unknown = !isKnownFinish(row.finish);

  return (
    <li
      data-tray-row={row.key}
      className="relative flex flex-col gap-2 border-t border-border py-2.5"
    >
      {/* The card that just landed, or just counted a second copy: the desktop tray's wash — it
          holds for one tier and fades over the next, keyed on the row's stamp so a second copy
          flashes again. Opacity alone, so there is no travel for reduced motion to take away. */}
      {flash && (
        <motion.span
          key={row.addedAt}
          aria-hidden="true"
          data-tray-flash=""
          className="pointer-events-none absolute inset-x-0 inset-y-px rounded-md bg-accent/15"
          initial={{ opacity: 1 }}
          animate={{
            opacity: 0,
            transition: { ...TRANSITION.slow, delay: seconds(DURATION.slow) },
          }}
        />
      )}
      <div className="relative flex items-start gap-3">
        {/* The whole card, never the art crop: the printed credit is on the card and nowhere else
            on this page. A 5:7 slot beside the name, decoration to a reader who cannot see it. */}
        <span
          aria-hidden="true"
          className="w-11 shrink-0 overflow-hidden rounded-[3px] bg-bg"
          style={{ aspectRatio: CARD_ASPECT }}
        >
          <CardImage
            src={cardImageUrl(row.cardId, 0, "thumb")}
            alt=""
            draggable={false}
            loading="lazy"
            className="size-full object-contain"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          {/* Wrapped, not cut short: a finger has no hover to read the rest of a name by. */}
          <span className="text-sm leading-snug break-words">{row.name}</span>
          {waiting ? (
            <span className="text-xs font-medium text-accent">Pick a printing</span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-2 text-xs text-dim">
              {/* The printing is the press below where there is a list to open; a card with no
                  oracle id has none, and says its printing here instead. */}
              {row.oracleId === null && printing !== "" && (
                <span className="font-mono">{printing}</span>
              )}
              <UnitPrice price={price} currency={currency} marketplaceLabel={marketplaceLabel} />
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className={cn(SQUARE, "border-transparent text-dim")}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {waiting ? (
        // Keyed apart from the settled arm below: the two are the same element type in the same
        // place, and unkeyed React keeps the nodes — this arm's *More printings…* became the settled
        // row's finish press, with the caret still on it.
        <div key="waiting" className="relative flex flex-col gap-2">
          <div
            role="group"
            aria-label={`Printings of ${row.name}`}
            className="grid grid-cols-3 gap-2"
          >
            {row.choices.map((choice, i) => (
              <button
                key={choice.cardId}
                type="button"
                aria-label={choiceLabel(choice)}
                // The walk's landing place: the first candidate.
                data-decision={i === 0 ? "" : undefined}
                onClick={() => onPick(choice.cardId)}
                className={cn(
                  "flex min-w-0 flex-col gap-1 rounded-lg border border-dashed border-accent/60 p-1",
                  PRESS,
                  FOCUS,
                )}
              >
                <CardArt cardId={choice.cardId} name={choice.name} variant="grid" loading="lazy" />
                <span aria-hidden="true" className="truncate text-center font-mono text-[0.6875rem] text-dim">
                  {printingOf(choice)}
                </span>
              </button>
            ))}
          </div>
          {row.oracleId !== null && (
            <button
              type="button"
              aria-label={`More printings of ${label}`}
              aria-haspopup="dialog"
              data-opens="printing"
              onClick={() => onAsk("printing")}
              className={cn(WORDED, "self-start text-dim")}
            >
              More printings…
            </button>
          )}
        </div>
      ) : (
        <div key="settled" className="relative flex items-center gap-2">
          {row.oracleId !== null ? (
            <button
              type="button"
              aria-label={`More printings of ${label}`}
              aria-haspopup="dialog"
              data-opens="printing"
              onClick={() => onAsk("printing")}
              className={cn(WORDED, "flex-1")}
            >
              <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
                {printing === "" ? "Printing" : printing}
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <button
            type="button"
            // Named outright: the visible word is the finish alone, and two rows of one finish
            // would be two controls a screen reader cannot tell apart.
            aria-label={`Finish of ${label}: ${TRAY_FINISH_LABEL[row.finish]}`}
            aria-haspopup="dialog"
            data-opens="finish"
            // The walk lands here on a row whose finish is the question.
            data-decision={unknown ? "" : undefined}
            onClick={() => onAsk("finish")}
            className={cn(WORDED, "shrink-0", unknown && "border-accent text-accent")}
          >
            {TRAY_FINISH_LABEL[row.finish]}
            <ChevronRight aria-hidden className="size-4 shrink-0 opacity-70" />
          </button>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label={`One fewer ${label}`}
              // `aria-disabled`, never `disabled`: the caret stays on it at one copy.
              aria-disabled={row.quantity <= 1 || undefined}
              onClick={() => {
                if (row.quantity > 1) onQuantity(row.quantity - 1);
              }}
              className={cn(SQUARE, "aria-disabled:text-dim aria-disabled:opacity-45")}
            >
              <Minus aria-hidden className="size-4" />
            </button>
            <output
              aria-label={`Quantity of ${label}`}
              className="w-6 text-center font-mono text-base tabular-nums"
            >
              {row.quantity}
            </output>
            <button
              type="button"
              aria-label={`One more ${label}`}
              onClick={() => onQuantity(row.quantity + 1)}
              className={SQUARE}
            >
              <Plus aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * One copy's price, at the marketplace the reader picked — the desktop tray's three states:
 * nothing while the read is unanswered, the figure, or an em dash with its words for a printing
 * the marketplace does not quote in this finish. A unit price, never the row's total.
 */
function UnitPrice({
  price,
  currency,
  marketplaceLabel,
}: {
  price: number | null | undefined;
  currency: Currency;
  marketplaceLabel: string;
}) {
  if (price === undefined) return null;
  return (
    <span className={cn("font-mono tabular-nums", price !== null && "text-text")}>
      {price === null ? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">Not priced at {marketplaceLabel}</span>
        </>
      ) : (
        formatPrice(price, currency)
      )}
    </span>
  );
}

/**
 * Every printing of the row's card, as the card sheet lists them — the same read under the same
 * key, so a card opened elsewhere answers from the cache — each a press that hands the printing
 * back to the tray. The desktop does this through its all-printings wall, which the phone has not
 * got.
 *
 * **The choice carries the printing's finishes**, so a row still waiting on a finish is settled by
 * a printing that exists in one (`tray.ts`'s `adopt`).
 */
function PrintingsPage({
  row,
  onPick,
}: {
  row: ScannerTrayRow;
  onPick: (choice: ScannerTrayChoice) => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const oracleId = row.oracleId;
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, marketplace.id),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, marketplace.id) : skipToken,
  });
  const items = printings.data?.items ?? [];

  if (printings.isPending) return <p className="px-4 py-3 text-sm text-dim">Loading printings…</p>;
  if (printings.isError) {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {`Couldn't load the printings — ${ipcError(printings.error)}`}
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="px-4 py-3 text-sm text-dim">This card has no paper printings.</p>;
  }
  return (
    <ul aria-label="Printings" className="px-2">
      {items.map((printing) => {
        // A row still waiting on a pick wears its first candidate provisionally: nothing is
        // "current" until the reader has said which.
        const current = row.choices.length === 0 && printing.id === row.cardId;
        return (
          <SheetChoice
            key={printing.id}
            label={`${current ? "" : "Use "}${printing.setName ?? printing.setCode.toUpperCase()}, ${printingCode(printing)}`}
            current={current}
            onPick={() =>
              onPick({
                cardId: printing.id,
                oracleId,
                name: row.name,
                setCode: printing.setCode,
                collectorNumber: printing.collectorNumber,
                finishes: parseFinishes(printing.finishes),
              })
            }
          >
            <span className={cn(PRINTING_ROW, "min-w-0 flex-1 px-0")}>
              <PrintingFace printing={printing} currency={currency} />
            </span>
          </SheetChoice>
        );
      })}
    </ul>
  );
}
