/**
 * The home page's feed: what has been added, moved and removed, in day sections.
 *
 * **It is `DeckHistoryDialog` one scope wider, and every sentence in it belongs to somebody
 * else.** The grouping is `activityText.ts`'s {@link activityDays}, the wording is that file's
 * {@link ActivityLine} — which hands a `deck`-scoped row straight to the deck history's own
 * builder, so a deck line reads here character for character as it reads in that dialog. What
 * this file adds is the *shape*: a scroller, a sticky day header with the day's roll-up, a row,
 * and the four sentences the list has when it is not a list.
 *
 * **Nothing here guards `activityLine` and nothing here re-words it.** That function is total
 * over every payload — a kind this build has never heard of, a truncated row, a `null` card —
 * and degrades to its shortest honest form rather than throwing. A `try`/`catch` around it would
 * hide exactly the degradation it already does, and a fallback sentence written here would be a
 * second spelling of history to keep in step with the first.
 *
 * ## The one thing this widget owns: staying fresh
 *
 * Every write in this app records a row into this feed, and **no mutation anywhere has ever
 * heard of an `["activity"]` key**. `invalidateQueries` matches by key *prefix*, so the
 * invalidations that already follow a write — `["collection"]`, `["wishlist"]`, `["decks"]` —
 * cannot reach a key under a fourth root, however it is spelled. Every other widget on this page
 * reads a root a write already invalidates; this one cannot, because its data is the union of
 * all three.
 *
 * Teaching the write sites a fourth key was the alternative and it is the worse one: it is ~40
 * call sites, it is a rule a new mutation has to remember, and the failure when one forgets is a
 * feed that is merely a little out of date — which looks exactly like a feed that is up to date.
 * So the bridge lives here, where the requirement is, and it is two pieces:
 *
 * * **{@link useWriteRootBridge} subscribes to the query cache** and invalidates this feed
 *   whenever a query under one of those three roots is invalidated. That is the app's existing
 *   signal for "a write happened", read rather than re-sent.
 * * **A marker query under each root** is what makes that signal reliable. `invalidateQueries`
 *   dispatches nothing at all when it matches no cached query, so a page holding this widget
 *   alone would hear nothing; a marker guarantees each root always has one query to match. It
 *   fetches a constant, never re-renders (`notifyOnChangeProps: []`) and is never read.
 *
 * The residual gap is a *narrower* invalidation — `["collection", "summary"]` — landing while
 * nothing under that exact key is cached. It is worth naming and not worth more machinery: the
 * feed is also refetched on mount and on focus like every other query in this app.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `WidgetCard`'s own doc has both arguments in full.
 */
import { useEffect, useId, useMemo, type ReactElement } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { count, plural } from "@/lib/counts";
import { ipc, ipcError, type ActivityEntry } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { activityDays, type ActivityDay, type ActivityLine } from "../activityText";
import { activityKey } from "../keys";
import { widgetConfig, widgetSpan } from "../layout";
import { WidgetCard } from "../WidgetCard";
import type { WidgetProps } from "../widgetProps";

/** What this widget stores. One number, and the reader picks it in the settings popover. */
export interface ActivityConfig {
  /** How many rows to ask the backend for. See {@link feedLimit} for what a stored one is
   *  allowed to be. */
  limit: number;
}

/**
 * The default, and — through `widgetConfig` — the schema a stored config is read against.
 *
 * Fifty is a few days of ordinary use and about two screens of scrolling. It is deliberately not
 * the backend's ceiling: this is a card on a dashboard rather than a log to audit, and the deck
 * history dialog is where a reader goes to read one deck's whole story.
 */
export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = { limit: 50 };

/** The backend clamps a limit into `1..=500` — `activity_recent`'s own rule, which is what stops
 *  a `0` meaning *no limit at all*, since that is how SQLite reads a negative `LIMIT`. */
const MAX_LIMIT = 500;

/** What the settings popover offers. Every one of them is inside the backend's clamp, so the
 *  narrowing below can only ever fire on a config no press of this control produced. */
export const ACTIVITY_LIMITS = [25, 50, 100, 200] as const;

const LIMIT_OPTIONS: readonly DropdownOption[] = ACTIVITY_LIMITS.map((limit) => ({
  value: String(limit),
  label: `${limit} changes`,
}));

/** The bare root, for the invalidation the bridge below sends. A write can only ever have
 *  changed all of this at once. `activityKey` — the feed's own key, carrying the limit — is in
 *  `../keys` with the rest of the page's, and is the one there that no write invalidates: this
 *  root and the bridge below are why it stays fresh anyway. */
const ACTIVITY_ROOT: QueryKey = ["activity"];

/** The three roots every write in this app already invalidates. See the module doc. */
const WRITE_ROOTS = ["collection", "wishlist", "decks"] as const;

/** The marker's own segment — one word no other reader of those roots uses, so nothing that
 *  matches by prefix (`setQueriesData(["collection", "list"])`, `removeQueries`) can reach it. */
const FEED_MARKER = "homeActivityFeed";

/** Stable identity for "nothing read yet", so {@link activityDays} is not re-run over a fresh
 *  empty array on every render of a card that is still waiting. */
const NONE: readonly ActivityEntry[] = [];

/**
 * The card's title.
 *
 * Spelled out rather than read off `WIDGET_META.activity.label`, which is the source of truth
 * for the Add-widget menu row: this file sits in `home/widgets/` and that record is in
 * `home/widgets.ts`, so an import of `"../widgets"` reads as this directory and resolves to the
 * file beside it. Two words are not worth a path that has to be explained. Keep them the same.
 */
const HEADING = "Activity";

/** 24-hour, because a stamp in a feed is data. `hourCycle` rather than `hour12: false`, which
 *  renders midnight as `24:00` under some ICU builds — `DeckHistoryDialog`'s note. */
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * A stored limit, narrowed to something the backend can answer.
 *
 * **`widgetConfig` checks the shape and never the range**, which its own doc states outright, so
 * everything below is reachable from a hand-edited row or a build that offered a different set:
 * `NaN` is a `number` and passes the shape check, and a `NaN` in a query key hashes to `null`
 * while reaching Rust as a limit no row can be read under. The clamp is the backend's own, said
 * once on this side so the request is answerable before it is sent.
 */
function feedLimit(stored: number): number {
  if (!Number.isFinite(stored)) return DEFAULT_ACTIVITY_CONFIG.limit;
  return Math.min(Math.max(Math.round(stored), 1), MAX_LIMIT);
}

/**
 * Keep this feed as fresh as the writes that fill it, without any of them knowing it exists.
 *
 * The whole argument is in the module doc. Two pieces: markers that guarantee each write root
 * always has something to invalidate, and one subscription that turns an invalidation of any of
 * them into an invalidation of this feed.
 */
function useWriteRootBridge(): void {
  const client = useQueryClient();

  // Never read, and deliberately: this is a *presence* in the cache rather than a source of
  // data. `staleTime: Infinity` so nothing refetches it on its own, `notifyOnChangeProps: []`
  // so its refetch after an invalidation notifies no observer and re-renders nothing.
  useQueries({
    queries: WRITE_ROOTS.map((root) => ({
      queryKey: [root, FEED_MARKER],
      queryFn: () => true,
      staleTime: Infinity,
      notifyOnChangeProps: [],
    })),
  });

  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        // The *action* rather than the event: a query under these roots emits `fetch` and
        // `success` on every ordinary read, and refetching this feed for a page that merely
        // listed some decks would be a read per keystroke of somebody else's search box.
        if (event.type !== "updated" || event.action.type !== "invalidate") return;
        const root = event.query.queryKey[0];
        if (typeof root !== "string") return;
        if (!(WRITE_ROOTS as readonly string[]).includes(root)) return;
        // No loop: this dispatches `invalidate` on the feed's own key, whose root is not one of
        // the three above.
        void client.invalidateQueries({ queryKey: ACTIVITY_ROOT });
      }),
    [client],
  );
}

/**
 * The activity widget.
 *
 * `chrome` is every prop the page is doing *to* this widget and is handed to `WidgetCard`
 * untouched — the widget interprets none of it. `span` comes off the stored document rather than
 * out of that bundle, which is what stops the card being drawn at a width the layout does not
 * hold.
 */
export function ActivityWidget({ widget, onConfig, ...chrome }: WidgetProps): ReactElement {
  const span = widgetSpan(widget);
  const config = widgetConfig(widget, DEFAULT_ACTIVITY_CONFIG);
  const limit = feedLimit(config.limit);
  const labelId = useId();
  const fieldId = useId();

  useWriteRootBridge();

  const query = useQuery({
    queryKey: activityKey(limit),
    queryFn: () => ipc.activityRecent(limit),
  });

  const entries = query.data ?? NONE;
  const days = useMemo(() => activityDays(entries), [entries]);

  return (
    <WidgetCard
      heading={HEADING}
      span={span}
      settings={
        <div className="flex flex-col gap-1.5">
          {/* `id` **and** `labelledBy`, which is what `Dropdown` asks of a caller with a visible
              label: the first keeps the pointer behaviour a `<label for>` gives, the second
              states the accessible name outright rather than leaving it to an association a
              later edit could quietly break. */}
          <label id={labelId} htmlFor={fieldId} className="text-xs text-dim">
            Changes to show
          </label>
          <Dropdown
            id={fieldId}
            labelledBy={labelId}
            value={String(limit)}
            // **Spread, never replace.** `setConfig` stores whatever it is handed and
            // `widgetConfig` carries keys this build has never heard of straight through, so a
            // write of `{ limit }` alone would delete a newer build's settings on the first
            // press of this control.
            onChange={(value) => onConfig({ ...config, limit: Number(value) })}
            options={LIMIT_OPTIONS}
            size="sm"
            fill
          />
        </div>
      }
      {...chrome}
    >
      <Body days={days} pending={query.isPending} error={query.isError ? query.error : null} />
    </WidgetCard>
  );
}

/**
 * What the feed is when it is not a feed — and they are four different sentences.
 *
 * **The refusal is read before the emptiness**, which is `DeckHistoryDialog`'s rule and its
 * reason: a failed read has no rows either, and calling it "nothing has happened yet" tells a
 * reader with nine thousand cards that their history is gone.
 */
function Body({
  days,
  pending,
  error,
}: {
  days: readonly ActivityDay[];
  pending: boolean;
  error: unknown;
}): ReactElement {
  if (days.length > 0) {
    return (
      // The scroller the day headers stick to. A widget is a card on a page rather than a page,
      // so the feed keeps its own height and the row of cards beside it keeps its shape;
      // `min-h-0` because this is a flex child and a flex item's default `min-height: auto`
      // would let the list push the card taller than the cap.
      <div className="max-h-80 min-h-0 overflow-y-auto pr-1">
        {days.map((day) => (
          <Section key={day.key} day={day} />
        ))}
      </div>
    );
  }

  if (error !== null) {
    return (
      <Notice title="Recent activity could not be read.">
        {ipcError(error)} The next change you make asks again.
      </Notice>
    );
  }
  if (pending) return <Notice title="Reading recent activity…" />;
  return (
    <Notice title="Nothing has happened yet.">
      Add a card, file one into a folder or edit a deck, and the first line lands here. The
      collection and wishlist lines are this device&rsquo;s own; deck changes arrive from every
      device paired with it.
    </Notice>
  );
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }): ReactElement {
  return (
    <div className="py-1">
      <p className="text-sm">{title}</p>
      {children !== undefined && (
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-dim">{children}</p>
      )}
    </div>
  );
}

/** One day: a sticky heading with its roll-up, and the day's lines under it. */
function Section({ day }: { day: ActivityDay }): ReactElement {
  return (
    <section className="pt-3 first:pt-0">
      <div
        className={cn(
          // `bg-bg` and not `bg-surface`: `StatsCard` draws a border and no background of its
          // own, so a widget's body sits on the page's colour and a header in any other one
          // would read as a band across the card.
          "sticky top-0 flex items-baseline gap-2 bg-bg py-1",
          // The rung every sticky header in this app takes. It competes only inside this card's
          // own stacking context, which is all it needs to: the rows scrolling under it are its
          // siblings.
          LAYER.header,
        )}
      >
        {/* `h4` under `StatsCard`'s own `h3`, so the card's heading and its day sections are one
            outline rather than two. The heading holds the label and nothing else — a count
            folded in beside it would compute into the accessible name, and a `gap` between two
            children joins them with no space at all ("Today3 changes"). */}
        <h4 className="font-heading text-sm leading-none">{day.label}</h4>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <Roll added={day.added} removed={day.removed} />
      </div>

      <ul className="flex flex-col gap-0.5 pt-1">
        {day.lines.map(({ entry, line }) => (
          // **`id` is unique within its own table and not across the feed** — `activity_recent`
          // is a `UNION ALL` over two of them, so the bare number collides and two rows would
          // become one with nothing said about it. The scope is what tells the tables apart.
          <Row key={`${entry.scope === "deck" ? "d" : "a"}${entry.id}`} entry={entry} line={line} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The day's copies, in and out.
 *
 * Drawn as `+7 / −6` and spoken as a sentence: read literally that string is "plus seven slash
 * minus six". Two counters rather than one signed sum, because a day that gained seven and lost
 * six is not a quiet day and `+1` says it was.
 *
 * `count` rather than a bare number, unlike the deck history's own roll-up: that one sums one
 * deck's edits and this one sums the whole app's, where an import of 1,196 cards is an ordinary
 * afternoon.
 */
function Roll({ added, removed }: { added: number; removed: number }): ReactElement {
  const quiet = added === 0 && removed === 0;
  const drawn = quiet
    ? "no copies"
    : [added > 0 ? `+${count(added)}` : null, removed > 0 ? `−${count(removed)}` : null]
        .filter((part) => part !== null)
        .join(" / ");
  const spoken = quiet
    ? "no copies changed"
    : [
        added > 0 ? `${plural(added, "copy", "copies")} added` : null,
        removed > 0 ? `${plural(removed, "copy", "copies")} removed` : null,
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

/** Which way a row moved copies. The rail carries emphasis only — the sentence beside it is what
 *  says what happened, and nothing here depends on the hue. */
function rail(delta: number): string {
  if (delta > 0) return "bg-pie-g";
  if (delta < 0) return "bg-destructive";
  return "bg-border";
}

/**
 * One line of the feed.
 *
 * The sentence and its quieter half are `activityLine`'s, verbatim — **this file writes no
 * wording at all**, and that is what makes a deck row here the same sentence the deck history
 * dialog draws for it. The scope is not drawn as a chip for the same reason: naming the cabinet
 * is the sentence's job, and a chip beside it would be a second opinion that could disagree.
 */
function Row({ entry, line }: { entry: ActivityEntry; line: ActivityLine }): ReactElement {
  const when = new Date(entry.at * 1000);

  return (
    <li className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface">
      <span
        aria-hidden="true"
        className={cn("w-[3px] flex-shrink-0 self-stretch rounded-full opacity-70", rail(entry.delta))}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{line.text}</p>
        {line.detail !== null && (
          <p className="mt-0.5 text-xs leading-snug text-dim">{line.detail}</p>
        )}
      </div>
      <time
        dateTime={when.toISOString()}
        className="flex-shrink-0 font-mono text-[0.7rem] leading-5 text-dim"
      >
        {TIME.format(when)}
      </time>
    </li>
  );
}
