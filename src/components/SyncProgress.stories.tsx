import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";
import { PHASE_LABEL } from "@/lib/useSyncProgress";
import { SyncProgress } from "./SyncProgress";

/**
 * One `sync:progress` payload.
 *
 * `done`/`total` default to a phase that has no denominator, because five of the eight phases
 * are like that and `percent()` answers `null` for them — the pulse rather than a bar.
 */
function event(phase: SyncPhase, over: Partial<SyncProgressEvent> = {}): SyncProgressEvent {
  return { phase, done: 0, total: 0, message: null, ...over };
}

const meta = {
  title: "Chrome/SyncProgress",
  component: SyncProgress,
  tags: ["autodocs"],
  args: {
    // `0` and only `0` is what puts this component on screen at all, so it is the meta's default
    // and the two stories about *not* rendering are the ones that override it.
    cardCount: 0,
    progress: null,
    error: null,
    busy: true,
    onRetry: fn(),
  },
  decorators: [
    // The overlay is `fixed inset-0`, so on the docs page nine of them would stack over the
    // whole article. A **transformed** ancestor is the containing block for `position: fixed`
    // descendants (CSS Transforms), so `transform-gpu` boxes each story into its own frame
    // without touching a class on the component. Nothing else about the overlay changes: it
    // still fills its window edge to edge, the window is simply this box.
    (Story) => (
      <div className="relative h-[24rem] w-full transform-gpu">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The first run, and nothing else. 77 MB to download and ~117 k rows to import with " +
          "nothing usable behind them — taking the whole screen is honest about that, and the " +
          "alternative is an empty app that looks broken. It is also the first thing anyone ever " +
          "sees of this app, which is why it opens with the name in full and then says, in one " +
          "sentence, what the wait buys.\n\n" +
          "**The progress element is the mana line itself**, not a bar of this component's own. " +
          "That is not a repetition of the app's one signature — this surface covers the ribbon, " +
          "so while it is up there is exactly one mana line on screen, and the reader who has " +
          "just watched it fill finds it under the ribbon a second later. The sentence and the " +
          "count come from `syncActivity`, the same fold that drives the ribbon's line, so the " +
          "two surfaces cannot drift apart on the wording of a phase or the unit it counts.\n\n" +
          "`cardCount === 0` — and only `0` — means an empty database. `null` means the poll " +
          "could not read the count, which is the normal state during every sync, and treating " +
          "it as empty would black out a working 116 k-card app once a day.\n\n" +
          "**Every state here is an argument, and that is the component's own design rather " +
          "than a convenience.** It takes the latest event as a prop because `AppShell` already " +
          "listens for the ribbon's mana line, and a second `useSyncProgress()` would be a " +
          "second `listen` registration on the same event for the life of the app. So a story " +
          "that emitted a fake `sync:progress` at this component would be emitting at something " +
          "that is not subscribed; `Chrome/AppShell` is where an emitted event has a listener.\n\n" +
          "**Three of the stories below are about a run that says nothing at all.** A sync " +
          "throttled by the 24 h check window emits no events, a startup failure happens before " +
          "the webview has registered its listener and Tauri drops the event, and both leave an " +
          "empty database with a modal over it. `busy` — not the presence of an event — is what " +
          "separates “working on it” from “stopped”.",
      },
    },
  },
} satisfies Meta<typeof SyncProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A forced run that has started and not yet said anything.
 *
 * The gap this covers is real twice over: the run is a moment old, *or* its opening events were
 * emitted before the webview registered its listener and Tauri dropped them. Either way `busy`
 * is true and there is nothing to report, so the line sweeps rather than fills and the sentence
 * is the generic "Syncing card data" rather than a phase nobody has announced. Both come from
 * `syncActivity`, the same fold that drives the ribbon's line, which is why the wording here is
 * the wording there.
 *
 * A line at full strength with nothing moving would read as finished; the sweep is what says the
 * length is unknown. Under `prefers-reduced-motion` the sweep is dropped and the dimmed line
 * alone is left to say it.
 *
 * **Retry is not on screen.** `sync_run` refuses a second concurrent run, so while one is in
 * flight the button could not do anything — it comes back in the three states that need it,
 * which are exactly the three where nothing is running.
 */
export const Starting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The line carries no `aria-valuenow` — omitted rather than zeroed, because `0` would be a
    // claim that no progress has been made rather than that none is measurable. Invisible.
    const bar = canvas.getByRole("progressbar", { name: "Syncing card data" });
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(canvas.queryByRole("button", { name: "Retry download" })).toBeNull();
  },
};

/**
 * `checking` — asking Scryfall whether the bulk file has moved.
 *
 * Under a second in the app (CLAUDE.md, measured 2026-08-05), and the only phase a run inside
 * the 24 h window would ever reach if it emitted anything at all. No denominator: there is one
 * HTTP request and it either answers or it does not.
 */
export const Checking: Story = {
  args: { progress: event("checking") },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("progressbar", { name: PHASE_LABEL.checking }),
    ).toBeInTheDocument();
  },
};

/**
 * `downloading` — the one phase whose numbers are bytes, and the only one that says so.
 *
 * 77 MB is the bulk file's real size (CLAUDE.md, measured 2026-08-05) and ~2.5 s of the run.
 * `detail()` divides by 1 000 000 and rounds to whole megabytes, so the line reflows its own
 * width every couple of hundred milliseconds — which is exactly what the direction's third type
 * role, mono for data, is for.
 */
export const Downloading: Story = {
  args: { progress: event("downloading", { done: 38_000_000, total: 77_000_000 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("38 / 77 MB")).toBeInTheDocument();
    await expect(
      canvas.getByRole("progressbar", { name: PHASE_LABEL.downloading }),
    ).toHaveAttribute("aria-valuenow", "49");
  },
};

/**
 * `ingesting` — ~81 s of a ~93 s sync, and where a first run spends nearly all of its time
 * (CLAUDE.md, measured 2026-08-05 and re-measured 2026-08-06).
 *
 * The count is rows, formatted `en-US` so the separator does not follow the machine's locale
 * while the rest of the app's numbers do not. 116,590 is the corpus as CLAUDE.md last recorded
 * it; halfway through it is the moment the reader is most likely to be looking at this screen.
 */
export const Ingesting: Story = {
  args: { progress: event("ingesting", { done: 58_500, total: 116_590 }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("58,500 cards")).toBeInTheDocument();
  },
};

/**
 * `reclaiming` — handing the pages the swap just freed back to the filesystem.
 *
 * Alone among the phases it reports a **true** fraction: the freelist is counted before the work
 * starts and only ever falls. So it is the one phase whose detail is a bare percentage —
 * `syncActivity` prints bytes for the download and rows for the ingest, and neither unit means
 * anything about freed database pages.
 *
 * A first run does not reach this phase — there is no old copy of the card table to free — and
 * the story is here because the component takes the phase as an argument and would draw it if it
 * ever arrived.
 */
export const Reclaiming: Story = {
  args: { progress: event("reclaiming", { done: 3, total: 4 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("progressbar", { name: PHASE_LABEL.reclaiming })).toHaveAttribute(
      "aria-valuenow",
      "75",
    );
    await expect(canvas.getByText("75%")).toBeInTheDocument();
  },
};

/** `sets` — the last ~5 s of a sync, rewriting the ~1 050-row set list the filters read. */
export const Sets: Story = {
  args: { progress: event("sets") },
};

/**
 * `compacting` — once per database, ever.
 *
 * The one-time conversion to incremental auto-vacuum, for databases created before schema
 * v3's `auto_vacuum` pragma could take. It has no denominator because `VACUUM` reports no
 * progress of any kind, and claiming a fraction would be an invention. It is also the one phase
 * whose label ends in an ellipsis, because it is the one a reader may sit through wondering
 * whether anything is happening.
 */
export const Compacting: Story = {
  args: { progress: event("compacting") },
};

/**
 * A failure that arrived as an event, while the status poll still thinks a run is in flight.
 *
 * `busy` is still true here, and the error **outranks** it: the poll is up to a second behind
 * the event, and a failure must not sit hidden behind a progress bar for that second. So the bar
 * goes, the message takes its place, and Retry comes back to life.
 *
 * The sentence is plain text, not a `role="alert"` — `AppShell`'s banner is the app's one alert
 * and it announces the same string. Two live regions saying one thing is one thing said twice.
 */
export const Error: Story = {
  args: { busy: true, progress: event("error", { message: "no internet connection" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("no internet connection")).toBeInTheDocument();
    await expect(canvas.queryByRole("progressbar")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Retry download" })).toBeEnabled();
  },
};

/**
 * A failure that never produced an event at all — the startup sync dying before the webview
 * registered its listener, which Tauri answers by dropping the event.
 *
 * This is the case `sync_status.lastError` is persisted for, and the reason this component takes
 * an `error` prop rather than trusting the event stream. Nothing is running, nothing was ever
 * said, and the database is empty; without the sentence the reader would be looking at a modal
 * over an app that never fills itself.
 */
export const FailedBeforeAnyEvent: Story = {
  args: { busy: false, error: "rate limited by Scryfall; retry after 30s" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("rate limited by Scryfall; retry after 30s")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Retry download" })).toBeEnabled();
  },
};

/**
 * The state with nothing to report and nothing wrong: a run **throttled** by the 24 h check
 * window, which emits not one event and writes no error.
 *
 * The app makes no network call at all inside that window — the throttle returns before the ETag
 * check — so on a first launch that somehow got a throttled run, this screen is all there is.
 * The fallback sentence is deliberately not an error and not a promise: it says what is true,
 * that nothing is downloading and there is no card data, and puts an enabled Retry under it.
 *
 * It is the reason `busy` decides this screen rather than the presence of an event. A component
 * waiting for a `sync:progress` would wait forever here.
 */
export const Throttled: Story = {
  args: { busy: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("No download is running, and there is no card data yet."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("progressbar")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Retry download" })).toBeEnabled();
  },
};

/**
 * {@link Error}, one press later — the same story with its Retry clicked.
 *
 * **A failure event is the last thing this window heard and stays the last thing** until a new
 * run says something: Tauri is not going to send a retraction. So the press is remembered, and
 * with the failure out of the way `busy` is enough to say a run is on — which is why the answer
 * to the press arrives in the same frame the button was let go, sweeping, with no sentence
 * invented for the occasion. `useSync.refresh` sets `refreshing` synchronously, so in the app
 * this is what the reader sees rather than a screen that sits still.
 *
 * What is remembered is the **event**, not a "retrying" flag. A second failure is a second
 * object, so it is never the dismissed one and the screen reports it; a flag would have to
 * guess when to lower itself, and would swallow that failure for as long as it stood.
 */
export const Retrying: Story = {
  args: { busy: true, progress: event("error", { message: "no internet connection" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Retry download" }));

    await expect(canvas.queryByText("no internet connection")).toBeNull();
    await expect(
      canvas.getByRole("progressbar", { name: "Syncing card data" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Retry download" })).toBeNull();
  },
};

/**
 * `done` — and the component renders **nothing at all**.
 *
 * `cardCount` is still `0` here, because the status poll is up to a second behind the event; the
 * phase is what gets the overlay out of the way immediately. A run that reports it is finished
 * means the database is filling, and holding a modal over it until the next poll would be a
 * second of blank screen for no reason.
 *
 * A story that renders empty is indistinguishable from a story that failed to render, so the
 * emptiness is asserted.
 */
export const Done: Story = {
  args: { busy: false, progress: event("done", { done: 116_590, total: 116_590 }) },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.firstElementChild).toBeEmptyDOMElement();
  },
};

/**
 * Every sync after the first — also nothing at all, for the other of the two reasons.
 *
 * A full database and an ingest running: `cardCount` is not `0`, so this component is not that
 * screen's business. The ribbon's mana line reports the run instead, which is the whole of why
 * there is no slim second bar in here.
 *
 * The same emptiness as {@link Done} and worth its own story, because it is the *other* branch:
 * one is decided by the phase, one by the count, and a change that broke either would leave the
 * other passing.
 */
export const EverySyncButTheFirst: Story = {
  args: {
    cardCount: 116_590,
    progress: event("ingesting", { done: 58_500, total: 116_590 }),
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.firstElementChild).toBeEmptyDOMElement();
  },
};
