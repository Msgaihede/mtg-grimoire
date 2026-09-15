/**
 * The home page's feed: what has been added, moved and removed, in day sections.
 *
 * **It is `DeckHistoryDialog` one scope wider, and every sentence in it belongs to somebody
 * else.** The grouping is `activityText.ts`'s {@link activityDays}, the wording is that file's
 * {@link ActivityLine} — which hands a `deck`-scoped row straight to the deck history's own
 * builder, so a deck line reads here character for character as it reads in that dialog. What
 * this file adds is the *shape*: a day heading with the day's roll-up, a line, the cut to whole
 * lines against the box the card was given, and the four sentences the list has when it is not a
 * list.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the tray and the settings popover — and
 * the popover's two rows, `Changes to show` and `Show times`, are this kind's registry picks and
 * toggles in `widgets.ts`, so nothing here draws a control.
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
 * `LAYER` — `fit.ts`'s module doc has the first argument in full.
 */
import { useEffect, useMemo, type ReactElement, type ReactNode } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count, plural } from "@/lib/counts";
import { ipc, ipcError, type ActivityEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { activityDays, type ActivityDay, type ActivityLine } from "../activityText";
import type { WidgetFit } from "../fit";
import { activityKey } from "../keys";
import type { WidgetBodyProps } from "../widgetProps";
import { DOWN_FILL, UP_FILL, WidgetMessage } from "../WidgetParts";
import { pickOf, toggleOn } from "../widgetSettings";

/**
 * The limit an entry with no usable stored one reads — the registry's own `dflt` for this kind's
 * `limit` pick, which {@link pickOf} already answers. Restated only for the one case `pickOf`
 * cannot type: a kind whose pick is not a number, which no entry of `widgets.ts` writes.
 *
 * Fifty is a few days of ordinary use. It is deliberately not the backend's ceiling of 500: this
 * is a card on a dashboard rather than a log to audit, and the deck history dialog is where a
 * reader goes to read one deck's whole story.
 */
const DEFAULT_LIMIT = 50;

/**
 * The height of one line of the feed, and of one day heading, in pixels — the unit the body is
 * cut in. The design's figure: a line of 14px text on a 19px leading, with 4px above and below.
 * **The classes on {@link Heading} and {@link Line} spell this out and must stay in step with it**;
 * a row taller than the arithmetic thinks is a card whose last line is clipped.
 */
const LINE_PX = 27;

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

/** 24-hour, because a stamp in a feed is data. `hourCycle` rather than `hour12: false`, which
 *  renders midnight as `24:00` under some ICU builds — `DeckHistoryDialog`'s note. */
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Keep this feed as fresh as the writes that fill it, without any of them knowing it exists.
 *
 * The whole argument is in the module doc. Two pieces: markers that guarantee each write root
 * always has something to invalidate, and one subscription that turns an invalidation of any of
 * them into an invalidation of this feed.
 *
 * **Off on a still body** (`enabled: false`), which is a catalogue preview: it publishes nothing,
 * and a second subscriber doubling every invalidation of the feed while the dialog is open is work
 * for a picture. The live card beside it — when there is one — is still bridging.
 */
function useWriteRootBridge(enabled: boolean): void {
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
      enabled,
    })),
  });

  useEffect(() => {
    if (!enabled) return;
    return client.getQueryCache().subscribe((event) => {
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
    });
  }, [client, enabled]);
}

/**
 * The days the box has room for, cut to whole lines — the design's `body()` for this kind.
 *
 * **A day heading costs a line**, so each day takes at most one fewer line than is left and
 * spends its heading from what remains; a day with no line left to draw is dropped rather than
 * drawn as a heading over nothing, which would read as a day on which nothing happened. The
 * budget is also capped at the limit, so a tall card never promises more than was asked for.
 *
 * The roll-up a day carries is still the whole day's as read — `+7 / −6` over every row of that
 * day the query answered — because a day heading is a statement about the day, and one that
 * shrank as the card was resized would be a figure a reader cannot check.
 *
 * Exported for its own test: it is arithmetic, and the cases worth pinning are easier to state
 * over a list than through a render.
 */
export function fitDays(days: readonly ActivityDay[], fit: WidgetFit, limit: number): ActivityDay[] {
  let left = Math.min(fit.linesFit(LINE_PX), limit);
  const out: ActivityDay[] = [];
  for (const day of days) {
    const lines = day.lines.slice(0, Math.max(0, left - 1));
    left -= lines.length + 1;
    if (lines.length > 0) out.push({ ...day, lines });
  }
  return out;
}

export function ActivityWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const picked = pickOf(widget, "limit");
  // The pick only ever answers one of its own options (25, 50, 100) or its default, so a stored
  // `NaN`, `9999` or `"50"` reads as fifty here and never reaches the backend's clamp — the
  // narrowing this file once did by hand is `widgetSettings.ts`'s vocabulary check now.
  const limit = typeof picked === "number" ? picked : DEFAULT_LIMIT;
  const times = toggleOn(widget, "times");

  useWriteRootBridge(!still);

  const query = useQuery({
    queryKey: activityKey(limit),
    queryFn: () => ipc.activityRecent(limit),
  });

  const entries = query.data ?? NONE;
  const days = useMemo(() => activityDays(entries), [entries]);

  if (days.length > 0) {
    return (
      <div className="flex flex-col" style={{ gap: fit.rowGap }}>
        {fitDays(days, fit, limit).map((day) => (
          <Section key={day.key} day={day} times={times} fit={fit} still={still} />
        ))}
      </div>
    );
  }

  // **The refusal is read before the emptiness**, which is `DeckHistoryDialog`'s rule and its
  // reason: a failed read has no rows either, and calling it "nothing has happened yet" tells a
  // reader with nine thousand cards that their history is gone.
  if (query.isError) {
    return (
      <Notice title="Recent activity could not be read." tone="destructive">
        {ipcError(query.error)} The next change you make asks again.
      </Notice>
    );
  }
  if (query.isPending) return <Notice title="Reading recent activity…" />;
  return (
    <Notice title="Nothing has happened yet.">
      Add a card, file one into a folder or edit a deck, and the first line lands here. The
      collection and wishlist lines are this device&rsquo;s own; deck changes arrive from every
      device paired with it.
    </Notice>
  );
}

/** One of the four sentences, with its quieter half under it. The title is its own element so a
 *  reader — and a test — can address it without the explanation. */
function Notice({
  title,
  tone = "dim",
  children,
}: {
  title: string;
  tone?: "dim" | "destructive";
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <WidgetMessage tone={tone}>{title}</WidgetMessage>
      {children !== undefined && (
        <p className="m-0 max-w-prose text-xs leading-relaxed text-dim">{children}</p>
      )}
    </div>
  );
}

/**
 * One day: its heading and roll-up, and the day's lines under it.
 *
 * **Not sticky, where the scrolling feed's header was.** The lines are cut to what the card has
 * room for, so nothing ordinarily scrolls under a heading — and a sticky one needs a background of
 * its own, which would paint a band across Customize's tinted card.
 */
function Section({
  day,
  times,
  fit,
  still,
}: {
  day: ActivityDay;
  times: boolean;
  fit: WidgetFit;
  still: boolean;
}): ReactElement {
  return (
    <section className="flex flex-col" style={{ gap: fit.rowGap }}>
      <Heading day={day} />
      <ul className="m-0 flex list-none flex-col p-0" style={{ gap: fit.rowGap }}>
        {day.lines.map(({ entry, line }) => (
          // **`id` is unique within its own table and not across the feed** — `activity_recent`
          // is a `UNION ALL` over two of them, so the bare number collides and two rows would
          // become one with nothing said about it. The scope is what tells the tables apart.
          <Line
            key={`${entry.scope === "deck" ? "d" : "a"}${entry.id}`}
            entry={entry}
            line={line}
            time={times}
            still={still}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * A day's heading — its label in the accent, a rule, and the copies in and out.
 *
 * `h4` under the card's own heading, so the card and its day sections are one outline. The heading
 * holds the label and nothing else — a count folded in beside it would compute into the accessible
 * name, and a `gap` between two children joins them with no space at all ("Today3 changes").
 */
function Heading({ day }: { day: ActivityDay }): ReactElement {
  return (
    <div className="flex h-[27px] shrink-0 items-center gap-2">
      <h4 className="m-0 font-heading text-sm leading-none text-accent">{day.label}</h4>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <Roll added={day.added} removed={day.removed} />
    </div>
  );
}

/**
 * The day's copies, in and out.
 *
 * Drawn as two tinted chips — `+7` on the gain's fill and `−6` on the loss's — and spoken as a
 * sentence: read literally the pair is "plus seven minus six". Two counters rather than one signed
 * sum, because a day that gained seven and lost six is not a quiet day and `+1` says it was.
 * **The colour is the fill and the numbers are body ink**, `WidgetParts.tsx`'s rule: the green at
 * this size on this ground reads under the contrast floor as text.
 *
 * `count` rather than a bare number, unlike the deck history's own roll-up: that one sums one
 * deck's edits and this one sums the whole app's, where an import of 1,196 cards is an ordinary
 * afternoon.
 */
function Roll({ added, removed }: { added: number; removed: number }): ReactElement {
  const quiet = added === 0 && removed === 0;
  const spoken = quiet
    ? "no copies changed"
    : [
        added > 0 ? `${plural(added, "copy", "copies")} added` : null,
        removed > 0 ? `${plural(removed, "copy", "copies")} removed` : null,
      ]
        .filter((part) => part !== null)
        .join(", ");

  return (
    // `aria-hidden` on each drawn piece rather than on one `contents` wrapper around them:
    // Chromium has dropped `aria-hidden` on a `display: contents` box before, which would read the
    // chips *and* the sentence.
    <p className="m-0 flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
      {quiet && (
        <span aria-hidden="true" className="text-dim">
          no copies
        </span>
      )}
      {added > 0 && (
        <span
          aria-hidden="true"
          className="rounded px-1 text-text"
          style={{ background: tint(UP_FILL) }}
        >
          +{count(added)}
        </span>
      )}
      {removed > 0 && (
        <span
          aria-hidden="true"
          className="rounded px-1 text-text"
          style={{ background: tint(DOWN_FILL) }}
        >
          −{count(removed)}
        </span>
      )}
      <span className="sr-only">{spoken}</span>
    </p>
  );
}

/** A fill at the design's 24% — an inline style, because a colour interpolated into a class name
 *  emits no rule. */
function tint(fill: string): string {
  return `color-mix(in oklab, ${fill} 24%, transparent)`;
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
 *
 * **One line of type, with the detail after the sentence in dim** rather than on a second line:
 * the body is cut in {@link LINE_PX} rows, and a line that grew a second row would push the card's
 * last line out of the box. Where the pair is too long for the card it truncates, and the whole of
 * it is a hint on the text — `whenClipped`, so a line that fits says nothing twice.
 */
function Line({
  entry,
  line,
  time,
  still,
}: {
  entry: ActivityEntry;
  line: ActivityLine;
  time: boolean;
  still: boolean;
}): ReactElement {
  const tip = useTooltip();
  const when = new Date(entry.at * 1000);
  const whole = line.detail === null ? line.text : `${line.text} · ${line.detail}`;

  return (
    <li className="flex h-[27px] items-stretch gap-2 py-1">
      <span
        aria-hidden="true"
        className={cn("w-[3px] shrink-0 rounded-full opacity-70", rail(entry.delta))}
      />
      <p
        {...(still ? {} : tip(whole, { whenClipped: true }))}
        className="m-0 min-w-0 flex-1 truncate text-sm leading-[19px]"
      >
        {line.text}
        {line.detail !== null && <span className="text-dim"> · {line.detail}</span>}
      </p>
      {time && (
        <time
          dateTime={when.toISOString()}
          className="shrink-0 font-mono text-xs leading-[19px] text-dim"
        >
          {TIME.format(when)}
        </time>
      )}
    </li>
  );
}
