import { useCallback, useMemo, useState } from "react";
import { ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DeckAuditEntry } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { auditSentence, type AuditDay } from "./auditText";
import { Dialog } from "@/components/Dialog";
import { useDeckAudit } from "./useDeckAudit";

/**
 * Everything that has happened to one deck, as a centred dialog over the editor.
 *
 * **It renders history and derives none of it.** The grouping is `auditDays`' and the sentence
 * is `auditSentence`'s, both from `auditText.ts`, because there is exactly one of each in this
 * app: a second copy of the wording would be a second thing to keep in step with the payloads
 * Rust writes, and a second day-grouping would be a second chance to file a 23:30 edit under
 * tomorrow. What this file adds is the *shape* — day sections, a filter, and the roll-up a
 * sticky header prints.
 *
 * **Nothing here may take the dialog down.** The audit contract is still growing and a database
 * outlives the app that wrote it, so a row's `kind` may be one this build has never heard of.
 * `auditText.ts` is already total over that; this file stays total over it too — see
 * {@link auditBand}, and the "Other" chip that appears the moment one of those rows exists.
 */

/**
 * The five bands the filter chips offer, plus the one that catches everything else.
 *
 * A band is **not** a kind. Nine kinds map onto five chips a reader would name, and `quantity`
 * is the join that makes that worth doing: a copy count going up is an add and one going down
 * is a removal, so it is routed by its own `delta` rather than given a sixth chip nobody would
 * think to press.
 */
export type AuditBand = "adds" | "removals" | "moves" | "swaps" | "structure" | "other";

/**
 * Which band a row belongs to.
 *
 * **The `default` arm is the load-bearing one.** `DeckAuditKind` is a closed union to the
 * compiler and an open one on disk — a newer build writes kinds this one has never seen — so an
 * unrecognised row lands in `"other"`, gets a chip of its own the moment one exists, and is
 * listed rather than dropped. A filter that silently swallowed it would be a history with a
 * hole in it, which is the one thing a log may not have.
 */
export function auditBand(entry: DeckAuditEntry): AuditBand {
  switch (entry.kind) {
    case "add":
      return "adds";
    case "remove":
      return "removals";
    // Routed by the delta and not by the kind: "Changed Sol Ring from 2 to 1" is a removal to
    // everyone except the schema. A change that moved no copies at all reads as an add, which
    // is the harmless direction — it is listed under a chip that is on by default.
    case "quantity":
      return entry.delta < 0 ? "removals" : "adds";
    case "move":
      return "moves";
    case "swap":
      return "swaps";
    // The deck's shape rather than its contents: a category, a tag, a folder, a deck field.
    case "tag":
    case "category":
    case "folder":
    case "deck":
      return "structure";
    default:
      return "other";
  }
}

/**
 * What each band is called, what it is drawn with, and what colour its rail takes.
 *
 * **The glyph carries the meaning and the rail carries only emphasis**, which is a deliberate
 * departure from the visual direction's coloured glyphs. `--color-pie-g` on `--color-bg`
 * measures **3.26:1** — fine for a 3px bar, which WCAG 1.4.11 asks 3:1 of, and a fail for a
 * 12px character, which 1.4.3 asks 4.5:1 of. Colouring the `+` and leaving the `−` (7.4:1) as
 * the one legible sign would have been the worst of both. So every glyph is drawn in text
 * colour, the rail keeps the hue, and no reader depends on the hue for anything.
 */
const BANDS = [
  { id: "adds", label: "Adds", glyph: "+", rail: "bg-pie-g", hint: undefined },
  { id: "removals", label: "Removals", glyph: "−", rail: "bg-destructive", hint: undefined },
  { id: "moves", label: "Moves", glyph: "→", rail: "bg-accent", hint: undefined },
  { id: "swaps", label: "Swaps", glyph: "⇄", rail: "bg-accent", hint: undefined },
  { id: "structure", label: "Structure", glyph: "✎", rail: "bg-border", hint: undefined },
  {
    id: "other",
    label: "Other",
    glyph: "·",
    rail: "bg-border",
    hint: "changes this version of the app has no name for",
  },
] as const satisfies readonly {
  id: AuditBand;
  label: string;
  glyph: string;
  rail: string;
  hint: string | undefined;
}[];

/** The five that are always offered. "Other" joins them only when a row needs it. */
const NAMED_BANDS = BANDS.filter((band) => band.id !== "other");

const bandOf = (id: AuditBand) => BANDS.find((band) => band.id === id) ?? BANDS[BANDS.length - 1];

/** 24-hour, because a stamp in a log is data. `hourCycle` rather than `hour12: false`, which
 *  renders midnight as `24:00` under some ICU builds. */
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** "August 6" — the month and day, for the filter bar's "since" and a day heading that reads
 *  "Today". Same locale as `auditText`'s own day labels, so the two never disagree. */
const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" });
/** The whole stamp, on a row's tooltip, for the reader who wants the date a time belongs to. */
const STAMP = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const at = (entry: DeckAuditEntry) => new Date(entry.at * 1000);

/** One day, after the chips have had their say. */
interface ShownDay {
  day: AuditDay;
  entries: DeckAuditEntry[];
  /** Copies that came in and copies that went out — the `+7 / −6` the header prints. Kept
   *  apart rather than netted, because a day that added seven and cut six is not a quiet day,
   *  and `AuditDay.delta`'s single number says it was. */
  gained: number;
  lost: number;
}

function split(entries: readonly DeckAuditEntry[]): { gained: number; lost: number } {
  let gained = 0;
  let lost = 0;
  for (const entry of entries) {
    if (entry.delta > 0) gained += entry.delta;
    else if (entry.delta < 0) lost -= entry.delta;
  }
  return { gained, lost };
}

export interface DeckHistoryDialogProps {
  deckId: number;
  open: boolean;
  /** Escape, and the dialog's own ✕: hand focus back to whatever opened it, then close. Both,
   *  because the ✕ is *inside* the layer that is about to unmount — a press that did not hand
   *  the caret back would drop it on `<body>` and restart the next Tab from the top of the app.
   *  Stable, please: {@link Dialog} passes it to `useDismissOnEscape` as a dependency. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The deck history dialog.
 *
 * **The chrome is {@link Dialog}'s and none of it is written here.** The scrim, the centred
 * panel, `aria-modal`, the Tab trap, the titled header with its ✕, and the `"inner"` Escape rung
 * registered on the *flag* rather than on the panel's mount — all of that is the shell's, once,
 * for every dialog the deck builder opens. What is left in this file is a history: the query, the
 * bands, the day sections and the roll-up.
 *
 * It was a right-hand drawer until 2026-08-14. A drawer is a column subtracted from the desk for
 * as long as it is up, and this surface is *consulted* rather than worked out of — nothing is
 * dragged out of a log — so it gave the deck nothing in exchange for the width. `w-[48rem]`
 * rather than the 40rem it docked at: a centred dialog is not full-height, so the day sections
 * have less vertical room and want a little more horizontal.
 *
 * **The filter chips' state lives out here, above the shell, and that is deliberate**: `children`
 * render only while the dialog is open, so state held in the body would be forgotten on every
 * close. The filter is the reader's, and a history they filtered, closed and reopened should not
 * have forgotten it. The *query* stays one floor down for the opposite reason — see
 * {@link History}.
 */
export function DeckHistoryDialog({ deckId, open, onDismiss, onClose }: DeckHistoryDialogProps) {
  const [hidden, setHidden] = useState<readonly AuditBand[]>([]);

  const toggle = useCallback(
    (band: AuditBand) =>
      setHidden((was) => (was.includes(band) ? was.filter((b) => b !== band) : [...was, band])),
    [],
  );
  const showEverything = useCallback(() => setHidden([]), []);

  return (
    <Dialog
      open={open}
      title="History"
      closeLabel="Close history"
      size="w-[48rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <History
        deckId={deckId}
        hidden={hidden}
        onToggle={toggle}
        onShowEverything={showEverything}
      />
    </Dialog>
  );
}

/**
 * The history proper — rendered only while the dialog is up, plus the length of its exit.
 *
 * **Gated by being mounted, not by a flag.** The read is the whole of what a closed dialog would
 * otherwise cost, and unmounting says "do not ask" more plainly than `enabled` does — it is also
 * what keeps the list on screen while the panel fades out, where a query switched off at the flag
 * would answer `isPending` again and print "Reading this deck's history…" over a fading panel.
 */
function History({
  deckId,
  hidden,
  onToggle,
  onShowEverything,
}: {
  deckId: number;
  hidden: readonly AuditBand[];
  onToggle: (band: AuditBand) => void;
  onShowEverything: () => void;
}) {
  const { query, days } = useDeckAudit(deckId);

  const shown = useMemo<ShownDay[]>(
    () =>
      days.flatMap((day) => {
        const entries = day.entries.filter((entry) => !hidden.includes(auditBand(entry)));
        return entries.length === 0 ? [] : [{ day, entries, ...split(entries) }];
      }),
    [days, hidden],
  );

  const total = useMemo(() => days.reduce((n, day) => n + day.entries.length, 0), [days]);
  const oldest = useMemo(
    () =>
      days
        .flatMap((day) => day.entries)
        .reduce<number | null>(
          (min, entry) => (min === null || entry.at < min ? entry.at : min),
          null,
        ),
    [days],
  );
  // The chip exists only when a row needs it, so a reader never sees a filter for a thing this
  // app has never met — and always sees one the moment it has.
  const hasOther = useMemo(
    () => days.some((day) => day.entries.some((entry) => auditBand(entry) === "other")),
    [days],
  );
  const chips = hasOther ? BANDS : NAMED_BANDS;
  const listed = shown.reduce((n, day) => n + day.entries.length, 0);

  return (
    <>
      {/* The chips ride above the list rather than inside it, so a filter that empties the list
          is still on screen to be undone.

          The reach of the history rides here too, and it used to sit beside the title: the
          shell's header takes a title and nothing else, on purpose — four dialogs with four
          differently furnished headers is the resemblance `Dialog` was made to end. This is
          the honest home for it anyway. The count is the **whole** history and the date is its
          oldest row, so the line says how far back this dialog can see, which is a caption for
          the filter beside it rather than for the deck's name. Both are read off the rows rather
          than told to the dialog, because a count the backend sent separately is a count that
          can disagree with the list under it. */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <div role="group" aria-label="Filter the history by kind" className="flex flex-wrap gap-2">
          {chips.map((band) => (
            <ToggleChip
              key={band.id}
              label={band.label}
              hint={band.hint}
              pressed={!hidden.includes(band.id)}
              onClick={() => onToggle(band.id)}
            />
          ))}
        </div>
        {hidden.length > 0 && total > 0 && (
          <p aria-live="polite" className="font-mono text-[0.7rem] text-dim">
            {listed} of {total} shown
          </p>
        )}
        {total > 0 && oldest !== null && (
          <p className="ml-auto min-w-0 truncate font-mono text-[0.7rem] text-dim">
            {plural(total, "change", "changes")} since {DAY.format(new Date(oldest * 1000))}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <Body
          days={shown}
          pending={query.isPending}
          error={query.isError ? query.error : null}
          empty={total === 0}
          onShowEverything={onShowEverything}
        />
      </div>
    </>
  );
}

/**
 * What the list is when it is not a list.
 *
 * Four states, and each says which one it is in words: a read in flight, a read that failed,
 * a deck nothing has happened to yet, and a filter that has hidden everything. The last two
 * look identical on screen if both are drawn as a blank column, and they need opposite things
 * from the reader.
 */
function Body({
  days,
  pending,
  error,
  empty,
  onShowEverything,
}: {
  days: readonly ShownDay[];
  pending: boolean;
  error: unknown;
  empty: boolean;
  onShowEverything: () => void;
}) {
  if (days.length > 0) {
    return (
      <>
        {days.map((day) => (
          <Section key={day.day.date} shown={day} />
        ))}
      </>
    );
  }

  // Errors before emptiness: a failed read has no entries either, and reporting it as "no
  // changes recorded yet" would tell the reader their history is gone.
  if (error !== null) {
    return (
      <Notice title="This deck's history could not be read.">
        {error instanceof Error && error.message
          ? error.message
          : "The app could not reach its own database."}{" "}
        Close the dialog and open it again to try once more.
      </Notice>
    );
  }
  if (pending) return <Notice title="Reading this deck's history…" />;
  if (empty) {
    return (
      <Notice title="No changes recorded yet.">
        Every edit lists here — a card added, a category renamed, a printing swapped, the format
        changed. Make one and it becomes the first line.
      </Notice>
    );
  }
  return (
    <Notice title="Nothing matches these filters.">
      This deck has history; none of it is the kind you are looking at.{" "}
      <button
        type="button"
        onClick={onShowEverything}
        className={cn("rounded-sm text-accent hover:underline", FOCUS)}
      >
        Show everything
      </button>
      .
    </Notice>
  );
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="pt-8">
      <p className="text-sm">{title}</p>
      {children !== undefined && (
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-dim">{children}</p>
      )}
    </div>
  );
}

/** One day: a sticky heading with its roll-up, and the day's rows under it. */
function Section({ shown }: { shown: ShownDay }) {
  const { day, entries, gained, lost } = shown;
  // "Today" and "Yesterday" say nothing about which date they are; the written day is added
  // beside them. Tested by containment rather than against the two literals, so a label that
  // already spells the date out ("Saturday, August 9") does not say it twice.
  const written = DAY.format(at(entries[0]));
  const dated = day.label.includes(written) ? null : written;

  return (
    <section className="pt-5">
      <div
        className={cn(
          "sticky top-0 flex items-baseline gap-2.5 bg-bg py-1.5",
          // The heading sits over the rows scrolling under it. `sticky` answers to the nearest
          // scrolling ancestor, which is the body's own scroller either way — the panel being a
          // centred dialog rather than a full-height drawer changes how tall that scroller is
          // and nothing about how this behaves. The rung is scoped to the dialog's own stacking
          // context, which the shell's scrim opens.
          LAYER.header,
        )}
      >
        <h3 className="font-heading text-lg leading-none">{day.label}</h3>
        <p className="font-mono text-[0.7rem] text-dim">
          {dated && <span>{dated} · </span>}
          {plural(entries.length, "change", "changes")}
        </p>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <Delta gained={gained} lost={lost} />
      </div>

      <ul className="flex flex-col gap-0.5 pt-2">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} others={entries} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The day's copies, in and out.
 *
 * Drawn as `+7 / −6` and spoken as a sentence: read literally, that string is "plus seven slash
 * minus six", and this is the one figure in this dialog that no row's sentence already carries.
 */
function Delta({ gained, lost }: { gained: number; lost: number }) {
  const quiet = gained === 0 && lost === 0;
  const drawn = quiet
    ? "no copies"
    : [gained > 0 ? `+${gained}` : null, lost > 0 ? `−${lost}` : null]
        .filter((part) => part !== null)
        .join(" / ");
  const spoken = quiet
    ? "no copies changed"
    : [
        gained > 0 ? `${plural(gained, "copy", "copies")} added` : null,
        lost > 0 ? `${plural(lost, "copy", "copies")} removed` : null,
      ]
        .filter((part) => part !== null)
        .join(", ");

  return (
    <p className={cn("font-mono text-[0.7rem] tabular-nums", quiet ? "text-dim" : "text-text")}>
      <span aria-hidden="true">{drawn}</span>
      <span className="sr-only">{spoken}</span>
    </p>
  );
}

/**
 * One line of history.
 *
 * The sentence and the detail are `auditSentence`'s, verbatim — this file writes no wording at
 * all. Everything visual is `aria-hidden`: the glyph and the rail are two spellings of the band
 * the sentence already names, and a screen reader that read them would hear "right arrow" in
 * front of "Moved Avacyn".
 *
 * **`others` is the day's own entries**, and it is passed for exactly one pair of rows: an undo
 * and a redo name the change they reversed rather than describing one of their own, so the
 * renderer needs the row that id points at to write "Undid: Removed 2 × Lightning Bolt". The
 * day rather than the whole history because a reversal is written the moment the reader presses
 * the button, so the two are always in the same section — and the fallback for a row out of
 * reach is a true short sentence rather than a hole.
 */
function Row({ entry, others }: { entry: DeckAuditEntry; others: readonly DeckAuditEntry[] }) {
  const tip = useTooltip();
  const band = bandOf(auditBand(entry));
  const { text, detail } = auditSentence(entry, others);
  const when = at(entry);

  return (
    <li className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface">
      <span
        aria-hidden="true"
        className="w-4 flex-shrink-0 text-center font-mono text-xs leading-5"
      >
        {band.glyph}
      </span>
      <span
        aria-hidden="true"
        className={cn("w-[3px] flex-shrink-0 self-stretch rounded-full opacity-70", band.rail)}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{text}</p>
        {detail !== null && <p className="mt-0.5 text-xs leading-snug text-dim">{detail}</p>}
      </div>
      <time
        dateTime={when.toISOString()}
        {...tip(STAMP.format(when))}
        className="flex-shrink-0 font-mono text-[0.7rem] leading-5 text-dim"
      >
        {TIME.format(when)}
      </time>
    </li>
  );
}
