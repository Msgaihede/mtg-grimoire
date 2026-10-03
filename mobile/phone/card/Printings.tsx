import { useId, useMemo, useState } from "react";
import { FinishMark } from "@/components/FinishMark";
import { RarityGem } from "@/components/RarityGem";
import { buildPrintingGroups, PRINTING_GROUP_BY_OPTIONS } from "@/features/card/printings";
import { usePrintingGroupBy } from "@/features/card/usePrintingGroupBy";
import { plural } from "@/lib/counts";
import { parseFinishes } from "@/lib/finish";
import { FOCUS_INSET } from "@/lib/focus";
import type { Printing } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { languageName } from "@/lib/languages";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { finishTreatments } from "@/lib/treatment";
import { cn } from "@/lib/utils";
import type { Place } from "../../routes";
import { linkTo } from "../router";
import { Note, SheetSection, ShowMore } from "./parts";

/**
 * How many printings the folded list draws. Five is a screen's worth of rows under the picture
 * and the words, and it is most cards' whole list — a reader looking at a Lightning Bolt sees all
 * four and no press at all.
 */
export const PRINTINGS_FOLDED = 5;

/**
 * Every printing of the open card, as a column a reader compares **down** — the desktop modal's
 * middle column (`CardModalPrintings`) drawn again for a finger, over the same data.
 *
 * **A drawing of its own rather than that component, and the reasons are all about the finger.**
 * The desktop list is a column of 20px rows with a hover-dwell picture beside each, tooltips for
 * the set's name, and a `Group printings by` dropdown — three things a pointer has and a thumb
 * does not. What it shares is everything that could drift: the read (the modal's own key, so a
 * card open on one face is warm on the other), `buildPrintingGroups` for what a group is and what
 * order everything comes in, and `usePrintingGroupBy` for which grouping — the same `app_meta`
 * row, so a reader who grouped by set on the desktop finds this list grouped by set too. The
 * phone draws the reader's choice and does not offer the control: nothing on this face writes yet.
 *
 * **A press on another printing replaces the sheet's card rather than stacking one**, so it is a
 * link with `replace` — see {@link PrintingRow}.
 */
export function PrintingsSection({
  cardId,
  place,
  items,
  total,
  loading,
  error,
  currency,
}: {
  /** The printing the sheet is drawing — the row that is not a link. */
  cardId: string;
  /** Where the reader is, so each row can name the same place with another card open. */
  place: Place;
  items: readonly Printing[];
  /** How many printings the card has, which is **not** `items.length` — the read is paged. */
  total: number;
  loading: boolean;
  error: string | null;
  currency: Currency;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const { mode } = usePrintingGroupBy();
  // Memoised on exactly the two things it reads; `items` keeps its identity across a refetch that
  // changed nothing, so this is not work repeated per render.
  const groups = useMemo(() => buildPrintingGroups(items, mode), [items, mode]);

  // What the groups *are*, in this mode's own word — `null` in `price`, which makes none. The
  // desktop's count line, verbatim, so the two faces describe one list in one sentence.
  const noun = PRINTING_GROUP_BY_OPTIONS.find((option) => option.value === mode)?.noun ?? null;
  const figure =
    items.length === 0
      ? null
      : `${items.length < total ? `${items.length} of ${plural(total, "printing")}` : plural(total, "printing")}${
          noun !== null ? ` · ${groups.length} ${groups.length === 1 ? noun.one : noun.many}` : ""
        }`;

  /**
   * The groups cut at {@link PRINTINGS_FOLDED} rows, counted across groups and in the order they
   * are drawn — so folding keeps the first rows of the reader's own ordering rather than the first
   * row of every group. A group the cut leaves empty is not drawn at all, heading included: a
   * heading with nothing under it reads as a group that failed to load.
   */
  const shown = useMemo(() => {
    if (expanded) return groups;
    let left = PRINTINGS_FOLDED;
    const cut = [];
    for (const group of groups) {
      if (left <= 0) break;
      const printings = group.printings.slice(0, left);
      left -= printings.length;
      cut.push({ ...group, printings });
    }
    return cut;
  }, [groups, expanded]);

  return (
    <SheetSection title="Printings" figure={figure}>
      {loading && <Note>Loading printings…</Note>}
      {error !== null && <Note tone="alert">{`Couldn't load the printings — ${error}`}</Note>}
      {/* Drawn rather than left out: a reader who asked which printings a card has is owed the
          answer "none", in words — the desktop list's own empty state. */}
      {!loading && error === null && items.length === 0 && (
        <Note>This card has no paper printings.</Note>
      )}
      {items.length > 0 && (
        <div id={listId} className="flex flex-col gap-2">
          {shown.map((group) => (
            <div key={group.key} className="flex flex-col">
              {/* No heading at all where the mode makes none — a blank line above a flat list
                  would read as a group whose name failed to load. */}
              {group.heading !== null && (
                <p className="flex items-baseline gap-1.5 pb-1 text-[0.7rem] text-dim">
                  <span className="min-w-0 truncate">{group.heading}</span>
                  <span className="font-mono tabular-nums">· {group.printings.length}</span>
                </p>
              )}
              <ul className="flex flex-col">
                {group.printings.map((printing) => (
                  <PrintingRow
                    key={printing.id}
                    printing={printing}
                    current={printing.id === cardId}
                    place={place}
                    currency={currency}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {items.length > PRINTINGS_FOLDED && (
        <ShowMore
          expanded={expanded}
          controls={listId}
          onToggle={() => setExpanded((open) => !open)}
          more={`Show all ${plural(items.length, "printing")}`}
        />
      )}
    </SheetSection>
  );
}

/**
 * One printing: its set's glyph and name, its code, number and year, and a price per finish.
 *
 * **A link, and pressed it _replaces_.** A press opens the same place with this printing as the
 * card — a URL change, so a real `<a>` whose `href` a reader can copy or open in a tab — but the
 * sheet is one place however many printings the reader steps through, so the router renames the
 * entry rather than pushing one. Pushed, the back gesture that should close the sheet would walk
 * back through every printing first.
 *
 * **The row on screen is not a link**, because there is nowhere for it to go; `aria-current` says
 * which it is to a reader who cannot see the gold hairline, which is the only other thing saying
 * it.
 *
 * **Two lines and a price column, at least 44px tall**, because a finger aims at the whole row:
 * the set's name is what a reader picks a printing *by*, so it gets the first line to itself and
 * truncates last, and the code line under it carries the facts a collector reads off the card.
 */
function PrintingRow({
  printing,
  current,
  place,
  currency,
}: {
  printing: Printing;
  current: boolean;
  place: Place;
  currency: Currency;
}) {
  const code = `${printing.setCode.toUpperCase()} · ${printing.collectorNumber}${
    printing.releasedAt ? ` · ${printing.releasedAt.slice(0, 4)}` : ""
  }`;
  const body = (
    <>
      {/* keyrune's own `.ss` rule draws a generic symbol for a set it has no glyph for, and the
          code beside it says which set either way — so the glyph is decoration to a reader who
          cannot see it. */}
      <i
        aria-hidden="true"
        className={cn(setGlyphClass(printing.setCode), "w-5 shrink-0 text-center text-base")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {printing.setName ?? printing.setCode.toUpperCase()}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.7rem] text-dim">
          <RarityGem rarity={printing.rarity} className="shrink-0" />
          <span className="truncate">{code}</span>
          {/* Only where it is not English: a list where every row says `EN` says nothing. The
              word rides beside the code for a screen reader, since `JA` is unreadable to anyone
              who has not learnt Scryfall's two letters. */}
          {printing.lang !== "en" && (
            <span className="shrink-0 rounded border border-border px-1 uppercase leading-4">
              <span className="sr-only">{`Printed in ${languageName(printing.lang)}: `}</span>
              {printing.lang}
            </span>
          )}
        </span>
      </span>
      {/* Per finish, priced at the marketplace the list was read at — never one number standing
          for both, and never another marketplace's. `formatPrice` draws an em dash for a finish
          the feed has not answered for and never invents a zero. Stacked, so a printing sold in
          three finishes grows a line rather than pushing the set's name out of the row. */}
      <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-xs tabular-nums">
        {parseFinishes(printing.finishes).map((finish) => (
          <span key={finish} className="flex items-center gap-1">
            <FinishMark
              finish={finish}
              treatments={finishTreatments(printing.promoTypes, finish)}
            />
            {formatPrice(printing.finishPrices[finish], currency)}
          </span>
        ))}
      </span>
    </>
  );

  const row = "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <li>
      {current ? (
        <div
          aria-current="true"
          className={cn(row, "border-l-2 border-accent bg-surface pl-1.5 text-text")}
        >
          {body}
        </div>
      ) : (
        <a
          {...linkTo({ ...place, cardId: printing.id }, { replace: true })}
          // The name says what the press does and which printing it is about, in one text node —
          // the visible set name and code are both in it, verbatim.
          aria-label={`Show ${printing.setName ?? printing.setCode.toUpperCase()}, ${code}`}
          className={cn(row, "text-text active:bg-surface", FOCUS_INSET)}
        >
          {body}
        </a>
      )}
    </li>
  );
}
