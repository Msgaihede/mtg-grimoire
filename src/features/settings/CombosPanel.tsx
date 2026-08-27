import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { count } from "@/lib/counts";
import { ipc, ipcError, type ComboPhase, type ComboProgress, type ComboStatus } from "@/lib/ipc";
import { COMBOS_KEY, COMBOS_STATUS_KEY } from "@/lib/query";
import { ago } from "@/lib/relativeTime";
import { nowSeconds } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * The combo database's whole state, under one root — re-exported from `@/lib/query`, which is
 * where the literals live.
 *
 * Two levels because there are two kinds of read under it: this panel's `combos_status`, and the
 * deck editor's `combos_for_cards`. A refresh replaces every row in both tables, so the
 * invalidation after one is aimed at the **root** — a deck's combo list was answered from rows
 * that no longer exist, and its key did not move.
 *
 * **The keys are not declared here**, because this panel is only one of the two readers and the
 * other is in `features/decks`: two features spelling one prefix is how the refresh→advisory link
 * comes to break silently. `@/lib/query` owns them for `OWNED_WRITE_KEYS`' reason exactly.
 */
export { COMBOS_KEY, COMBOS_STATUS_KEY };

/**
 * `1 combo` / `105,478 combos`, with the thousands separator a five-figure count needs.
 *
 * Not `plural` from `@/lib/counts`: that one writes the number plainly and says why — every one
 * of its callers counts cards or piles in a deck and none reaches four figures. Spellbook's
 * published file does, on both of the numbers here, which is exactly the case its comment
 * points at `count` for. `BackupPanel`'s `files` is the same helper for the same reason.
 */
const combosText = (n: number): string => `${count(n)} ${n === 1 ? "combo" : "combos"}`;

/**
 * The other half of the figures line.
 *
 * **`ComboStatus.cards` is `count(DISTINCT oracle_id)` over `combo_cards`** — a card in three
 * combos is one card — so "naming 7,310 cards between them" is a true sentence about the
 * corpus rather than a slot count dressed up as one.
 *
 * The wording still says *between them* on purpose. The figure's whole job is to give the combo
 * count a sense of scale, and a reader who met "7,310 cards" on its own would take it for
 * something about their collection.
 */
const cardsText = (n: number): string => `${count(n)} ${n === 1 ? "card" : "cards"}`;

/**
 * What each phase is called on screen — the whole of what the progress line says.
 *
 * Five, mirroring `ComboPhase`, which mirrors the crate's own list. A phase Rust emits that is
 * missing here has no label, so the line renders `undefined` while the refresh runs perfectly:
 * `useSyncProgress`'s `PHASE_LABEL` carries the same hazard and `CombosPanel.test.tsx` pins the
 * census the same way.
 *
 * **`checking` is a sentence about Spellbook rather than about bytes**, because that phase is
 * the ETag round trip: the common outcome is a 304 and no download at all, and a line reading
 * "Downloading…" through it would promise a transfer that never happens.
 */
export const COMBO_PHASE_LABEL: Record<ComboPhase, string> = {
  checking: "Checking whether Spellbook's list has changed",
  downloading: "Downloading the combo list",
  ingesting: "Importing combos",
  done: "Combos are up to date",
  error: "The combo refresh failed",
};

/** The three phases that mean work is still in flight. `done` and `error` are terminal, and a
 *  panel that treated either as running would spin its button forever. */
const RUNNING: ReadonlySet<ComboPhase> = new Set<ComboPhase>([
  "checking",
  "downloading",
  "ingesting",
]);

/**
 * What this panel is describing, in the six words it has.
 *
 * `feedState`'s shape one feed over, and the ordering is the whole content:
 *
 * * **`refreshing` first** — it is happening now, and a fetch over a week-old list is not
 *   "stale".
 * * **`failed` before `never`** — "we tried and it did not work" is a different sentence from
 *   "nobody has tried", and only one of them is worth a retry.
 * * **`failed` before `stale`/`fresh`** — the combos still on screen are the *previous*
 *   ingest's, which is exactly what a reader has to be told before a bracket estimate is read
 *   off them.
 *
 * `unknown` is the read still in flight (or refused), and it is a state of its own rather than
 * a `never` in disguise: drawing "nothing downloaded yet" over an unanswered read would tell a
 * reader with 105 478 combos on disk that they have none.
 *
 * **`never` is read off `fetchedAt` and not off `combos`**, because the two are different
 * questions — a file that ingested and matched nothing is not a file nobody has fetched — and
 * `stale` is the backend's own boolean rather than arithmetic done here, for the reason
 * `useMarketplace` gives: the interval is one number and two behaviours already turn on it.
 */
export type ComboState = "unknown" | "never" | "refreshing" | "failed" | "stale" | "fresh";

export function comboState(
  status: ComboStatus | null,
  refreshing: boolean,
  failed: boolean,
): ComboState {
  if (refreshing) return "refreshing";
  if (failed) return "failed";
  if (status === null) return "unknown";
  if (status.fetchedAt === null) return "never";
  return status.stale ? "stale" : "fresh";
}

/**
 * The one sentence beside the button, per state.
 *
 * Six states and one sentence each rather than one sentence with a date in it, because the
 * states are not degrees of the same thing — `MarketplacePanel`'s `feedNote` arriving at the
 * same shape one feed over. Two of the six say nothing at all and that is deliberate: a read in
 * flight has the body's own line, and a refresh in flight has the progress line, so a second
 * sentence under either would be the panel talking over itself.
 *
 * **The failed arm branches on whether there is anything to keep.** A refresh that failed over
 * an ingested database leaves every row exactly where it was — that is the ingest's whole
 * contract, staged tables swapped in one transaction — so the sentence has to say the combos
 * are still counted rather than let the reader assume the estimate has gone quiet.
 *
 * Both failed arms point at `Errors`, which is the next panel but one down this page. This one
 * knows *that* a refresh failed and often not *why*: a failure nobody in this window started
 * arrives as a bare `error` phase with no message on it, and inventing a reason would be worse
 * than the state alone.
 *
 * @param now unix **seconds**, passed rather than read so the panel and its stories agree about
 * the clock. {@link ago} takes milliseconds, which is what the conversion below is.
 */
export function comboNote(
  state: ComboState,
  status: ComboStatus | null,
  now: number,
): string | null {
  const at = status?.fetchedAt ?? null;
  const when = at === null ? null : ago(at, now * 1000);
  switch (state) {
    case "unknown":
    case "refreshing":
      return null;
    case "never":
      return (
        "Nothing downloaded yet. Until it is, a Commander deck's bracket estimate reads the " +
        "other three signals — which is a supported state rather than a fault."
      );
    case "failed":
      return when === null
        ? "The download failed, so there are still no combos. Errors, further down this page, has the details."
        : `The last refresh failed. The combos from ${when} are still here and still counted. ` +
            "Errors, further down this page, has the details.";
    case "stale":
      return `Downloaded ${when}. A refresh is due.`;
    default:
      return `Downloaded ${when}.`;
  }
}

/**
 * Spellbook's own stamp for the list on disk, in the app's date shape.
 *
 * **This is the "what we hold" half of the pair the panel exists to make legible**, and it is
 * not the same fact as `checkedAt`: the file rotates continuously, so the stamp answers *which*
 * list this is, where `checkedAt` only answers when we last asked about one.
 *
 * The rewrite is fenced on the exact shape the feed publishes — `2026-08-27T03:12:44Z`,
 * measured — and the `Z` is load-bearing rather than decoration: it is the only thing that makes
 * `UTC` true, and a stamp carrying an offset instead would be relabelled into a lie. Anything
 * that does not match is printed exactly as it arrived, which is the settings module's own rule:
 * a value this build cannot read is a fact about storage rather than a number to reformat.
 */
export function stampText(stamp: string | null): string | null {
  const trimmed = stamp?.trim() ?? "";
  if (trimmed === "") return null;
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/.exec(trimmed);
  return iso === null ? trimmed : `${iso[1]} ${iso[2]} UTC`;
}

/**
 * The refresh, phase by phase.
 *
 * Deliberately `UpdatePanel`'s `Bar` idiom — an `h-1` track with a gold fill — rather than a
 * second progress language for a third kind of download. Two things are its own:
 *
 * **The track is `bg-bg` and not `bg-surface`**, because this bar is drawn *inside* a
 * `SettingsSection` box, which is already `bg-surface`. A track the colour of the box it sits on
 * has no groove, so the empty part of the bar would simply not be there.
 *
 * **The fraction is a percentage and never a unit.** `done`/`total` count bytes while the file
 * is coming down and variants while it is being read in, and one line that printed "12.4 MB of
 * 26.3 MB" through both would be wrong for half of a refresh. A percentage is true of either.
 * A phase with no denominator gets a pulsing full-width bar and no `aria-valuenow`, because
 * `aria-valuenow="0"` is a claim that no progress has been made.
 */
function Progress({ progress }: { progress: ComboProgress }): JSX.Element {
  const label = COMBO_PHASE_LABEL[progress.phase];
  const value =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(value === null ? {} : { "aria-valuenow": value })}
        className="h-1 overflow-hidden rounded-full bg-bg"
      >
        <div
          className={cn(
            "h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none",
            value === null && "animate-pulse motion-reduce:animate-none",
          )}
          style={{ width: value === null ? "100%" : `${value}%` }}
        />
      </div>
      {/* A caption on the bar rather than a sentence: the phase at the line's left end and the
          count at its right, which is `SyncProgress`' arrangement for the same two facts. The
          percentage is data, and data is Geist Mono — the role prices, versions and collector
          numbers already carry in this window. **The split is the layout rather than a phrase
          broken in half**, which matters to whatever queries it: testing-library reads an
          element's own text nodes, so a `<span>` inside a sentence makes that sentence
          unfindable — here the two ends are two facts and each is findable on its own. */}
      <div className="flex items-baseline justify-between gap-2 text-xs text-dim">
        <span>{label}</span>
        {value !== null && <span className="font-mono tabular-nums">{`${value}%`}</span>}
      </div>
    </div>
  );
}

/**
 * Commander Spellbook's combo list: what is ingested, how old it is, and the one press that
 * fetches it.
 *
 * **The fourth signal, and the only one that is not in a card's own text.** A Commander deck's
 * bracket estimate reads Game Changers, mass land denial and extra turns straight off the cards
 * it holds; a two-card infinite is a fact about an *interaction*, so no amount of reading either
 * card finds it. That is the whole argument for a fourth bulk download, and it is what the
 * panel's opening paragraph says rather than "combo data" as a feature name.
 *
 * **A database that has never fetched it is a supported state and must not read as an error.**
 * It is what every install is on its first launch and what a machine with no route to
 * `json.commanderspellbook.com` stays in — the estimate reads three signals instead of four and
 * says so where it is drawn. This is the tagger datasets' rule one feed over, and the panel
 * honours it by making the never-fetched copy an explanation of what happens meanwhile rather
 * than a fault to clear.
 *
 * **This panel reaches the backend itself**, where four of its neighbours take their state as a
 * prop. `BackupPanel`'s argument with one clause changed: the deck editor's bracket advisory
 * reads `combos_status` too, and that is precisely why a second call here is free — it is one
 * TanStack Query entry, so both surfaces read the same cached answer rather than opening two
 * channels. What there is no second caller for is the **write**, and the progress event has
 * exactly one subscriber in the app because this is the only surface that draws it.
 *
 * **Three dates, because they answer three questions**, and a panel that collapsed them would
 * lose the one thing a reader comes here to settle. `stamp` is *which* list this is — Spellbook
 * rebuilds the file continuously. `fetchedAt` is when the rows here last changed. `checkedAt` is
 * when we last asked, which a 304 moves and the other two do not. The gap between the first and
 * the last is the design working: this app's refresh interval is a week, so a list seven days
 * behind Spellbook's is current rather than stale, and the panel says so in as many words.
 */
export function CombosPanel(): JSX.Element {
  const client = useQueryClient();
  /** The latest `combos:progress` event, or `null` if none has arrived — `useSyncProgress`'s
   *  shape. Never a complete account of a refresh: Tauri drops events emitted before this
   *  panel mounted its listener, so `combos_status` is the reliable half of the pair. */
  const [progress, setProgress] = useState<ComboProgress | null>(null);

  const read = useQuery({ queryKey: COMBOS_STATUS_KEY, queryFn: () => ipc.combosStatus() });
  const status = read.data ?? null;

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onCombosProgress((event) => {
        setProgress(event);
        // **Both terminal phases, not just `done`.** A failed refresh leaves the previous rows
        // exactly where they were, so there is nothing new to *count* — but `checkedAt` moved,
        // and a reader looking at this panel is owed the state it is actually in.
        if (event.phase === "done" || event.phase === "error") {
          void client.invalidateQueries({ queryKey: COMBOS_KEY });
        }
      })
      .then((unlisten) => {
        // `listen` resolves a tick later than the unmount can happen, so the handle has to be
        // dropped here too — otherwise it outlives the panel for the app's lifetime.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // Registering a listener fails outside a Tauri window (a plain `vite dev`, a story with
      // no fake). Losing the fast path is not worth taking the page down for: the status read
      // still answers, and a refresh still finishes.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client]);

  /**
   * **`force: true`, and it is a decision rather than the default.**
   *
   * The interval is a week. A Refresh that honoured it would do nothing at all for six of those
   * seven days — no download, no new rows, no line moving — which is indistinguishable from a
   * dead button, and a reader who presses it is asking for *now* rather than for the schedule.
   * It costs almost nothing to allow: `force` skips the throttle and **not** the ETag, so a
   * forced refresh of an unchanged file is one request, a 304 and no ingest. That is the tag
   * family's own wording for the same flag, and `MarketplacePanel`'s refresh button already
   * behaves this way by construction.
   */
  const refresh = useMutation({
    mutationFn: () => ipc.combosRefresh(true),
    // Every row in both combo tables has just been replaced and no key moved — including the
    // deck editor's, which answered a bracket advisory off the rows that are now gone.
    onSuccess: () => void client.invalidateQueries({ queryKey: COMBOS_KEY }),
    // A failure changed no rows, so only the freshness line can have moved.
    onError: () => void client.invalidateQueries({ queryKey: COMBOS_STATUS_KEY }),
  });

  const phase = progress?.phase ?? null;
  // Two sources and neither is redundant: the mutation is pending from the moment a press
  // lands, before any event has arrived, and the event is what carries a refresh **this window
  // did not start** — a startup pass, or the deck editor's advisory triggering one.
  const refreshing = refresh.isPending || (phase !== null && RUNNING.has(phase));
  // A later attempt supersedes an earlier verdict, which is what `isError` already is: a second
  // press moves the mutation back through `pending`, so a retry that worked clears the failure
  // rather than reporting it forever.
  const failed = refresh.isError || phase === "error";
  const state = comboState(status, refreshing, failed);
  // One clock for the whole render, so the two relative lines cannot disagree about what "2
  // hours ago" means. **A render-time read and deliberately not state**, which is the whole of
  // what `nowSeconds` is for and why it is imported rather than written out again: a settings
  // panel that repainted on a timer to keep a relative date current would be motion without
  // information, and `react-hooks/purity` refuses a bare `Date.now()` in a render body.
  const now = nowSeconds();
  const stamp = stampText(status?.stamp ?? null);
  const note = comboNote(state, status, now);
  const ingested = status !== null && status.fetchedAt !== null;

  return (
    <SettingsSection id="combos" title="Combos">
      <p className="text-sm text-dim">
        Commander Spellbook&rsquo;s list of card combos, and how strong its editors rate each one.
        It is the fourth thing a Commander deck&rsquo;s bracket estimate reads: Game Changers,
        mass land denial and extra turns are all written on the cards themselves, and a two-card
        infinite is not &mdash; it is a fact about an interaction, so no amount of reading either
        card finds it. The list is 27.5 MB compressed, and nothing is downloaded until you ask.
      </p>

      {/* **A read still in flight draws no figures and no absence.** Three states rather than
          two: "nothing downloaded yet" over an unanswered read would tell a reader with 105 478
          combos on disk that they have none, and it would do it on every launch. */}
      {status === null && (
        <p className="text-sm text-dim">
          {read.isError ? "The combo database could not be read." : "Reading the combo database…"}
        </p>
      )}

      {ingested && status !== null && (
        <div className="space-y-1">
          {/* A count is data, and data is Geist Mono — the third type role, alongside prices,
              versions and collector numbers. Drawn whatever the state is: a refresh in flight
              and a refresh that failed are both looking at these very rows. */}
          <p className="font-mono text-sm tabular-nums">
            {`${combosText(status.combos)}, naming ${cardsText(status.cards)} between them`}
          </p>
          {/* **What we hold**, which is not the same fact as when we asked. Spellbook's own
              stamp for the file these rows came from; absent where the feed published none,
              rather than derived from `fetchedAt`. */}
          {stamp !== null && (
            <p className="text-xs text-dim">{`Spellbook stamped this list ${stamp}.`}</p>
          )}
          {/* **When we last asked**, which a 304 moves and the two lines above do not. */}
          {status.checkedAt !== null && (
            <p className="text-xs text-dim">{`Last checked ${ago(status.checkedAt, now * 1000)}.`}</p>
          )}
        </div>
      )}

      {ingested && (
        <p className="text-xs text-dim">
          Spellbook rebuilds this file continuously and this app asks at most once a week, so a
          list up to seven days behind Spellbook&rsquo;s is the schedule working rather than a
          stale download. Refresh asks now.
        </p>
      )}

      {refreshing && progress !== null && <Progress progress={progress} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* `min-w-0` so the sentence gives way rather than the button: a flex item cannot
            shrink below its own min-content unless it is told it may, and this row is the one
            place on the panel where a long sentence meets a fixed control. */}
        <p className="min-w-0 flex-1 text-sm text-dim">{note}</p>
        {/* **`disabled` and not `aria-disabled`, which is the app's usual rule reversed and is
            this file's family.** `controls.ts`'s `BUTTON` argues it for `Retry`, `Install`,
            `Check now` and `Rebuild now`: a refresh that is already running has genuinely
            nothing for a second press to do, and `disabled:active:scale-100` holds the box at
            full size so a greyed control cannot answer a press with a dip. */}
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          {/* The label is the state, `UpdatePanel`'s `PrimaryAction` one panel over: there is
              nothing here to *re*-fresh until something has been fetched, and a button offering
              to refresh an empty table is a button a reader has no reason to press. What the
              press costs is said once, in the paragraph at the top, rather than inside a
              control's accessible name. */}
          {ingested ? (
            <>
              <RefreshCw aria-hidden="true" className={cn("size-4", refreshing && "animate-spin")} />
              Refresh combos
            </>
          ) : (
            <>
              <Download aria-hidden="true" className={cn("size-4", refreshing && "animate-pulse")} />
              Download combos
            </>
          )}
        </button>
      </div>

      {/* The refusal itself, in the app's destructive red — `null` for a failure this window
          did not cause, where there is no message to print and the note above already says
          where to look. */}
      <PanelAlert tone="problem">{refresh.error ? ipcError(refresh.error) : null}</PanelAlert>
    </SettingsSection>
  );
}
