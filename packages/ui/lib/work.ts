/**
 * The app is busy with something the reader asked for — the one way to say so.
 *
 * A long write (three hundred cards into a deck, an import), a `Ctrl+A` that has to read twenty
 * pages: work the reader started and is now waiting on, with nothing on screen saying the app
 * heard them. `notify` is the receipt *after*; this is the "working on it" *during*. It raises
 * one indicator, drawn in two places from this store — the window header's activity line
 * (`AppShell` registers it as a job, `@/lib/activity`'s `workActivity`) and a pill where the receipt toast will land
 * (`Toaster`) — and puts a `progress` cursor on the window (`data-busy` on `<html>`, one rule in
 * `index.css`). It never blocks a press.
 *
 * **Callable from anywhere, no hook**, `notify`'s arrangement and for its reason: the work is
 * started in mutation callbacks and module functions as often as in components.
 *
 * ```ts
 * const done = beginWork("Adding 300 cards to “Burn”…");
 * try { await ipc.addMany(...) } finally { done(); }
 * // or
 * await trackWork("Selecting all cards…", selectAll());
 * ```
 */
import { create } from "zustand";

/**
 * How long a job must run before anything puts a sentence on screen — the header's activity line
 * (`ChromeStatus`, re-exported by `@/lib/activity`) and the busy pill alike.
 *
 * **Defined here, at the leaf, rather than in `@/lib/activity`**, because this module is imported
 * by `test-setup.ts` (for {@link resetWork}) and so loads before any test file's `vi.mock`:
 * `@/lib/activity` pulls in the sync, tag and combo progress hooks and through them `@/lib/ipc`,
 * and a setup file that loaded those would hand every suite the real IPC instead of its mock.
 * This module imports nothing of the app's at runtime, and must keep it that way.
 */
export const ACTIVITY_DELAY_MS = 400;

/**
 * How long the indicator stays once it has appeared, however soon the work ends.
 *
 * Work that ends 30 ms after the pill appears would draw a blink — a shape that is there and
 * gone before the eye has resolved what it was, which reads as a glitch rather than as "that
 * took a moment". 700 ms is about what it takes to fixate a short phrase and register it (two or
 * three words at ~250 ms each), and with {@link ACTIVITY_DELAY_MS} in front of it the shortest
 * life the indicator can have is 400 ms of nothing then 700 ms of pill — never a flash. Longer
 * would start to hold the pill over the receipt toast that replaces it, and claim work that has
 * already finished.
 */
export const WORK_MIN_SHOWN_MS = 700;

/** One live piece of work. */
export interface Work {
  id: number;
  /** The caller's sentence — short, present progressive: `Selecting all cards…`. */
  label: string;
  /** `Date.now()` when it began. */
  since: number;
}

/** What every surface draws: the oldest shown piece's sentence and how many more are shown. */
export interface Busy {
  label: string;
  /** Other pieces of work past the delay, beside the one named. */
  more: number;
}

interface WorkState {
  /** Live pieces, in start order. */
  live: Work[];
  /**
   * What the indicator says, or `null` when it is down. **Derived in one place**
   * ({@link settle}), so the header, the pill and the cursor can never disagree.
   */
  busy: Busy | null;
}

export const useWorkStore = create<WorkState>(() => ({ live: [], busy: null }));

let nextId = 1;
/** Each live piece's timer to the moment it becomes old enough to show. */
const ripeTimers = new Map<number, number>();
/** When the indicator last went up — what its minimum stay is counted from. */
let shownAt: number | null = null;
let holdTimer: number | null = null;

function sameBusy(a: Busy | null, b: Busy | null): boolean {
  return a === b || (a !== null && b !== null && a.label === b.label && a.more === b.more);
}

/**
 * Work out what the indicator says now, and arrange to ask again when that can next change.
 *
 * A piece is *ripe* once it has been live for {@link ACTIVITY_DELAY_MS}; the indicator is up
 * while any piece is ripe, and for {@link WORK_MIN_SHOWN_MS} after it went up whatever happens.
 * During that hold, with nothing ripe left, it keeps the last sentence it said — the work is
 * over, but swapping the words for the last 200 ms would be noise.
 */
function settle(): void {
  const now = Date.now();
  const { live, busy } = useWorkStore.getState();
  const ripe = live.filter((w) => now - w.since >= ACTIVITY_DELAY_MS);

  let next: Busy | null;
  if (ripe.length > 0) {
    next = { label: ripe[0].label, more: ripe.length - 1 };
    shownAt ??= now;
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  } else if (shownAt !== null && now - shownAt < WORK_MIN_SHOWN_MS) {
    next = busy && { label: busy.label, more: 0 };
    holdTimer ??= window.setTimeout(
      () => {
        holdTimer = null;
        settle();
      },
      WORK_MIN_SHOWN_MS - (now - shownAt),
    );
  } else {
    next = null;
    shownAt = null;
  }

  if (!sameBusy(busy, next)) useWorkStore.setState({ busy: next });
  markRoot(next !== null);
}

/** The `progress` cursor: `html[data-busy]` in `index.css`. Never `wait` — every press works. */
function markRoot(on: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (on) root.setAttribute("data-busy", "");
  else root.removeAttribute("data-busy");
}

/** Raise the busy indicator for a piece of work; call the returned function when it ends (idempotent). */
export function beginWork(label: string): () => void {
  const id = nextId++;
  useWorkStore.setState((s) => ({ live: [...s.live, { id, label, since: Date.now() }] }));
  ripeTimers.set(
    id,
    window.setTimeout(() => {
      ripeTimers.delete(id);
      settle();
    }, ACTIVITY_DELAY_MS),
  );
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const timer = ripeTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    ripeTimers.delete(id);
    useWorkStore.setState((s) => ({ live: s.live.filter((w) => w.id !== id) }));
    settle();
  };
}

/** Raise it for as long as `work` is pending; resolves/rejects exactly as `work` does. */
export function trackWork<T>(label: string, work: Promise<T>): Promise<T> {
  const done = beginWork(label);
  // `finally` passes the outcome through untouched, rejection included.
  return work.finally(done);
}

/** The live pieces of work, in start order — shown or not yet. */
export function useWork(): Work[] {
  return useWorkStore((s) => s.live);
}

/** What the indicator says, or `null` while it is down. Every surface draws from this. */
export function useBusy(): Busy | null {
  return useWorkStore((s) => s.busy);
}

/** `Adding 300 cards…`, or `Adding 300 cards… and 2 more` — one sentence, never a stack. */
export function busySentence(busy: Busy): string {
  return busy.more > 0 ? `${busy.label} and ${busy.more} more` : busy.label;
}

/** Forget every piece of work and every timer. For tests and stories. */
export function resetWork(): void {
  for (const timer of ripeTimers.values()) window.clearTimeout(timer);
  ripeTimers.clear();
  if (holdTimer !== null) window.clearTimeout(holdTimer);
  holdTimer = null;
  shownAt = null;
  useWorkStore.setState({ live: [], busy: null });
  markRoot(false);
}
