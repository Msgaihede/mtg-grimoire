/**
 * One history entry per open sheet, so Back closes the sheet on top — the phone face's half of
 * `DialogHost.claimBack` (`@grimoire/ui/lib/dialogHost`).
 *
 * **Why an entry, and not a listener for the gesture.** Android's back gesture reaches the page as
 * the WebView's `goBack()` (`MainActivity.kt`), and a mobile browser's button as a traversal; both
 * walk history and nothing else, and no API on every host this face ships on lets a page refuse
 * one. A sheet that is not an entry is skipped: until 2026-10-11 Back with the filters sheet up
 * moved the page beneath it, or put the app away. So a sheet that opens pushes an entry at the
 * address the reader is already on, and a traversal off that entry closes the sheet.
 *
 * **An entry's state is `{ sheet, beneath }`**: the claim's id, and the state of the entry it was
 * pushed over — which is what the entry becomes again if it outlives its sheet (a reload, a
 * Forward), and what `router.ts` reads beneath it.
 *
 * **Closing a sheet by any other road takes its entry back out**, or the next Back would close
 * nothing. That is a traversal, which a browser makes a task later — and a write in the meantime
 * would land *above* the entry the traversal is about to leave. Three rules keep that ordered:
 *
 * 1. **The pop waits for the end of the tick** (a microtask). A sheet that opens in the same
 *    commit as another closes — a row that opens a sheet of its own — takes the closing one's
 *    entry over by a replace, and nothing is popped at all.
 * 2. **A claim made while a pop is in flight waits for it to land** before it pushes.
 * 3. **The router asks first** ({@link uncover}): a navigation made from inside a sheet waits for
 *    the sheet's entries to be popped, so the page it pushes lands where the sheet's entry was.
 *
 * A pop the browser never makes (one browser drops history calls past a rate) is waited for
 * {@link POP_WAIT_MS} and then given up on: what was waiting runs anyway, and an entry left
 * behind is the stale kind a traversal tidies ({@link onTraversal}). History is then one dead
 * step longer than it should be, which is the whole of the cost.
 */

/** How long a pop this module asked for may take to land — `router.ts`'s `BACK_WAIT_MS`, for its
 *  reason: a traversal lands a task or two later, and this bounds the one that never does. */
export const POP_WAIT_MS = 500;

interface SheetState {
  sheet: number;
  beneath: unknown;
}

export function isSheetEntry(state: unknown): state is SheetState {
  return (
    typeof state === "object" &&
    state !== null &&
    "sheet" in state &&
    typeof (state as { sheet: unknown }).sheet === "number"
  );
}

/** What an entry says beneath any sheets stacked on it — the state `router.ts` reasons about. */
export function pageState(state: unknown): unknown {
  let at = state;
  while (isSheetEntry(at)) at = at.beneath;
  return at;
}

interface Claim {
  id: number;
  onBack: () => void;
  /** Still open. A released claim whose entry is still in history is waiting to be popped. */
  live: boolean;
}

/** Every claim whose entry this module believes is in history, bottom first. */
let entries: Claim[] = [];
/** Open claims with no entry yet (or none at all — a push the browser refused). */
let unentered: Claim[] = [];
let nextId = 1;

/** Traversals this module asked for and the browser has not delivered. */
let inFlight = 0;
let inFlightTimer: ReturnType<typeof setTimeout> | undefined;
/** What runs once the pops in flight have landed. */
let afterPop: (() => void)[] = [];
/** Whether a pop of the released entries on top is already queued for the end of this tick. */
let popQueued = false;

const current = (): unknown => window.history.state;
const here = (): string => window.location.pathname + window.location.search + window.location.hash;

/** The id on the entry the browser is on, or `null` where it is not a sheet's. */
function currentSheet(): number | null {
  const state = current();
  return isSheetEntry(state) ? state.sheet : null;
}

/** How many entries on top of history belong to released claims, if the top is ours at all. */
function releasedOnTop(): number {
  const top = entries[entries.length - 1] as Claim | undefined;
  if (top === undefined || currentSheet() !== top.id) return 0;
  let count = 0;
  for (let i = entries.length - 1; i >= 0 && !entries[i].live; i--) count++;
  return count;
}

function push(claim: Claim): void {
  try {
    window.history.pushState({ sheet: claim.id, beneath: current() }, "", here());
  } catch {
    // Refused out loud — the sheet is open without its step, as one refused in silence is.
  }
  if (currentSheet() === claim.id) entries.push(claim);
  else unentered.push(claim);
}

function settled(): void {
  inFlight = 0;
  clearTimeout(inFlightTimer);
  const waiting = afterPop;
  afterPop = [];
  for (const run of waiting) run();
  // A sheet released while the pop was in flight had its own pop refused; it is owed one now.
  queuePop();
}

/** Rule 1's pop, once per tick however many sheets are released in it. */
function queuePop(): void {
  if (popQueued) return;
  popQueued = true;
  queueMicrotask(popReleased);
}

/** Go back `count` entries, then run `then` — through {@link afterPop}, in the listener below. */
function pop(count: number, then?: () => void): void {
  if (then !== undefined) afterPop.push(then);
  // The entries leave the model now: whatever lands, they are not where the reader is going.
  entries = entries.slice(0, entries.length - count);
  inFlight++;
  clearTimeout(inFlightTimer);
  inFlightTimer = setTimeout(settled, POP_WAIT_MS);
  try {
    window.history.go(-count);
  } catch {
    settled();
  }
}

/** The end-of-tick pop of rule 1: whatever released entries are still on top go. */
function popReleased(): void {
  popQueued = false;
  if (inFlight > 0) return;
  const count = releasedOnTop();
  if (count > 0) pop(count);
}

/**
 * `DialogHost.claimBack` for the phone face: give an opening sheet an entry, and hand back its
 * release.
 */
export function claimBack(onBack: () => void): () => void {
  const claim: Claim = { id: nextId++, onBack, live: true };
  const top = entries[entries.length - 1] as Claim | undefined;
  if (inFlight > 0) {
    // Rule 2: pushed now, it would sit above an entry the browser is about to leave.
    unentered.push(claim);
    afterPop.push(() => {
      if (!claim.live) return;
      unentered = unentered.filter((c) => c !== claim);
      push(claim);
    });
  } else if (top !== undefined && !top.live && currentSheet() === top.id) {
    // Rule 1: the sheet that closed this tick hands its entry over. A replace, so Back from the
    // new sheet lands where Back from the old one would have.
    const state = current() as SheetState;
    try {
      window.history.replaceState({ sheet: claim.id, beneath: state.beneath }, "", here());
    } catch {
      // Refused: the old entry stays, and the end-of-tick pop below takes it.
    }
    if (currentSheet() === claim.id) entries[entries.length - 1] = claim;
    else push(claim);
  } else {
    push(claim);
  }
  return () => release(claim);
}

function release(claim: Claim): void {
  if (!claim.live) return;
  claim.live = false;
  unentered = unentered.filter((c) => c !== claim);
  if (entries.includes(claim)) queuePop();
}

/**
 * Take every sheet's entry off the top of history, then run `then` — what the router asks before
 * any write of its own (rule 3). `false`, and `then` is not run, where there is nothing to take
 * off: the router goes ahead as it always did.
 *
 * A sheet still open when its entry goes is closed, as a Back would close it: the reader has
 * navigated away from the page it was drawn over.
 */
export function uncover(then: () => void): boolean {
  if (inFlight > 0) {
    afterPop.push(then);
    return true;
  }
  const top = entries[entries.length - 1] as Claim | undefined;
  if (top === undefined || currentSheet() !== top.id) return false;
  const leaving = [...unentered, ...[...entries].reverse()];
  unentered = [];
  pop(entries.length, () => {
    for (const claim of leaving) close(claim);
    then();
  });
  return true;
}

function close(claim: Claim): void {
  if (!claim.live) return;
  claim.live = false;
  claim.onBack();
}

/**
 * A traversal this module did not ask for: the reader's Back, Forward, or a jump.
 *
 * Every open sheet whose entry is not at or beneath where the browser landed is closed, top first
 * — and so is every open sheet that never had an entry, which was drawn over a page the reader
 * has now left. An entry of ours whose sheet is gone (a Forward onto a closed sheet, history
 * surviving a reload) is renamed to the page it was pushed over: one dead step, rather than a
 * step that would claim a sheet nothing draws.
 */
function onTraversal(): void {
  const landed = currentSheet();
  const at = landed === null ? -1 : entries.findIndex((c) => c.id === landed);
  const closing = [...unentered, ...entries.slice(at + 1).reverse()];
  entries = entries.slice(0, at + 1);
  unentered = [];
  for (const claim of closing) close(claim);
  if (landed !== null && at === -1) {
    try {
      window.history.replaceState(pageState(current()), "", here());
    } catch {
      // Left as it is: the next traversal off it asks again.
    }
  }
  // Landed on the entry of a sheet that closed while another stood over it: that entry is
  // owed its pop too, or the next Back closes nothing.
  queuePop();
}

// Registered when the module is first read — which is before `router.ts`'s own listener, since
// the router imports this, and before any subscriber a page mounts. So a pop's continuation (a
// router write) has run by the time anything re-reads the address.
window.addEventListener("popstate", () => {
  if (inFlight > 0) {
    inFlight--;
    if (inFlight === 0) settled();
    return;
  }
  onTraversal();
});

/**
 * Tidy an entry left over from before this page was loaded — a reload with a sheet up keeps the
 * sheet's entry and loses the sheet. Called as the face mounts, ahead of the router's own first
 * read of the entry's state.
 */
export function adoptStaleSheet(): void {
  if (!isSheetEntry(current()) || entries.some((c) => c.id === currentSheet())) return;
  try {
    window.history.replaceState(pageState(current()), "", here());
  } catch {
    // Left as it is.
  }
}

/**
 * The suite's: resolves once no pop is queued or in flight — so a sheet a test left open, whose
 * entry its unmount took back out, has landed its traversal before the next test writes history.
 */
export async function sheetHistoryIdle(): Promise<void> {
  const deadline = Date.now() + POP_WAIT_MS * 2;
  while ((popQueued || inFlight > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The suite's: forget every claim and every pop, between tests. */
export function resetSheetHistory(): void {
  entries = [];
  unentered = [];
  afterPop = [];
  inFlight = 0;
  popQueued = false;
  clearTimeout(inFlightTimer);
}
