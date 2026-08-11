import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ToggleChip } from "@/components/FilterChips";
import type { DeckAuditEntry } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { auditSentence, type AuditDay } from "./auditText";
import { FOCUS } from "./cardControl";
import { useDeckAudit } from "./useDeckAudit";

/**
 * Everything that has happened to one deck, as a drawer over the editor.
 *
 * **It renders history and derives none of it.** The grouping is `auditDays`' and the sentence
 * is `auditSentence`'s, both from `auditText.ts`, because there is exactly one of each in this
 * app: a second copy of the wording would be a second thing to keep in step with the payloads
 * Rust writes, and a second day-grouping would be a second chance to file a 23:30 edit under
 * tomorrow. What this file adds is the *shape* — day sections, a filter, and the roll-up a
 * sticky header prints.
 *
 * **Nothing here may take the drawer down.** The audit contract is still growing and a database
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
/** "August 6" — the month and day, for the header's "since" and a day heading that reads
 *  "Today". Same locale as `auditText`'s own day labels, so the two never disagree. */
const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" });
/** The whole stamp, on a row's `title`, for the reader who wants the date a time belongs to. */
const STAMP = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const at = (entry: DeckAuditEntry) => new Date(entry.at * 1000);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

export interface AuditDrawerProps {
  deckId: number;
  open: boolean;
  /** Escape, and the drawer's own ✕: hand focus back to whatever opened the drawer, then
   *  close. Both, because the ✕ is *inside* the layer that is about to unmount — a press that
   *  did not hand the caret back would drop it on `<body>` and restart the next Tab from the
   *  top of the app. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The deck history drawer.
 *
 * An `"inner"` Escape rung — capture phase, `preventDefault()` — so one press closes the drawer
 * and leaves the card pane behind the view holding its own. Nothing else on this screen may be
 * an `"inner"` peer at the same time; `useDismissOnEscape`'s own doc has why.
 */
export function AuditDrawer({ deckId, open, onDismiss, onClose }: AuditDrawerProps) {
  // **Gated on `open`, not on the deck.** The editor keeps this mounted alongside everything
  // else it draws, and a closed drawer that read anyway would spend a query on every deck the
  // reader opens to look at. Re-opening is free: the answer is cached under the deck's own key.
  const { query, days } = useDeckAudit(open ? deckId : null);
  const [hidden, setHidden] = useState<readonly AuditBand[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  // The caret moves into the layer, as it does for every other one in the app: the drawer's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

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
    () => days.flatMap((day) => day.entries).reduce<number | null>(
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

  if (!open) return null;

  const toggle = (band: AuditBand) =>
    setHidden((was) => (was.includes(band) ? was.filter((b) => b !== band) : [...was, band]));

  return (
    // The scrim is the outside click, and the whole window is outside: a drawer that dimmed
    // only the view it opened over would leave the ribbon and the sidebar looking pressable
    // while a modal layer sat beside them. `fixed` rather than the direction's `absolute`
    // because this component is mounted by the editor and cannot know that anything above it
    // is positioned — an `absolute` inset with no positioned ancestor lands somewhere nobody
    // chose.
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // `LAYER.gate` is the scale's top rung, and an open drawer is the top of the screen.
      // Not `dragTray`: nothing is being dragged, and the tray only exists during a drag this
      // layer makes impossible. A `drawer` rung of its own belongs in `LAYER` once the three
      // overlay surfaces of this rebuild have landed — one of them adding it is three agents
      // editing one file.
      className={cn("fixed inset-0 flex justify-end bg-black/60", LAYER.gate)}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        // Not `aria-modal`, for `ValidationPanel`'s reason one floor down: the editor behind
        // this stays live and reachable, and a reader who spots a mistake in the history should
        // be able to go and fix it without dismissing what told them about it.
        className={cn(
          "flex h-full w-[40rem] max-w-full flex-col border-l border-border bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <h2 id={titleId} className="font-heading text-xl leading-none">
            Deck history
          </h2>
          {total > 0 && oldest !== null && (
            <p className="min-w-0 truncate font-mono text-[0.7rem] text-dim">
              {plural(total, "change", "changes")} since {DAY.format(new Date(oldest * 1000))}
            </p>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close the history"
            className={cn(
              "ml-auto rounded-md p-1 text-dim transition-colors duration-150",
              "hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* The chips ride above the list rather than inside it, so a filter that empties the
            list is still on screen to be undone. */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div role="group" aria-label="Filter the history by kind" className="flex flex-wrap gap-2">
            {chips.map((band) => (
              <ToggleChip
                key={band.id}
                label={band.label}
                hint={band.hint}
                pressed={!hidden.includes(band.id)}
                onClick={() => toggle(band.id)}
              />
            ))}
          </div>
          {hidden.length > 0 && total > 0 && (
            <p aria-live="polite" className="font-mono text-[0.7rem] text-dim">
              {listed} of {total} shown
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <Body
            days={shown}
            pending={query.isPending}
            error={query.isError ? query.error : null}
            empty={total === 0}
            onShowEverything={() => setHidden([])}
          />
        </div>
      </div>
    </div>
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
        Close the drawer and open it again to try once more.
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
          // The heading sits over the rows scrolling under it — inside this drawer's own
          // stacking context, which the scrim's layer opens.
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
          <Row key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The day's copies, in and out.
 *
 * Drawn as `+7 / −6` and spoken as a sentence: read literally, that string is "plus seven slash
 * minus six", and this is the one figure in the drawer that no row's sentence already carries.
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
 */
function Row({ entry }: { entry: DeckAuditEntry }) {
  const band = bandOf(auditBand(entry));
  const { text, detail } = auditSentence(entry);
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
        title={STAMP.format(when)}
        className="flex-shrink-0 font-mono text-[0.7rem] leading-5 text-dim"
      >
        {TIME.format(when)}
      </time>
    </li>
  );
}
