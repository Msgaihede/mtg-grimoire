/**
 * Settings → Local cache → Clear, on the web target.
 *
 * **The page half of a command that has no backend arm and never will.** On the desktop
 * `cache_clear` drops the `image_cache` rows, sweeps `data/images/` and `data/tmp/`, and tells
 * the fetcher to forget what it had pending. A browser has no `data/` at all: the picture bytes
 * are in the service worker's `IMAGE_CACHE`, which is reachable from a `fetch` handler and from
 * nowhere a SQLite connection can see. So `web::route::COMMANDS` does not grow an arm — it is
 * synchronous and takes the connection — and `src/lib/core/browser.ts` diverts the command name
 * here instead, which is `feedRefreshFor`'s shape and its argument: the branch lives in the core
 * once, and `CachePanel` never learns which target it is drawn on.
 *
 * **The page does not delete anything itself, and that is the whole reason this is a message.**
 * `WebStoragePanel`'s cap picker already says it for the other direction — *"the page has no
 * business deleting entries out from under a `fetch` handler that is reading the ledger"* — and
 * a page-side `caches.delete(IMAGE_CACHE)` is the exact shape of the failure
 * [pwa-shell.md](../../docs/reference/pwa-shell.md) records: 45 pictures cached and no ledger at
 * all, because the worker went on writing to a cache handle the page had thrown away. The
 * worker owns those bytes; this asks it.
 */
import type { CacheCleared } from "@/lib/ipc";
import type { ImageClearReport } from "@/pwa/imageLedger";

/**
 * The verb `sw.ts`'s message handler answers.
 *
 * Spelled as a literal on both sides, like `SKIP_WAITING` and `SET_IMAGE_CAP` before it. A
 * shared constant would be worse than it looks: the worker that receives this is whichever
 * build is *active*, which is not necessarily the build that shipped this file, so a constant
 * would promise an agreement it cannot enforce. What actually keeps the two ends together is
 * that a mismatch is silent — see {@link REPLY_TIMEOUT_MS}.
 */
const CLEAR_IMAGE_CACHE = "CLEAR_IMAGE_CACHE";

/**
 * How long to wait for the worker's answer before giving up on it.
 *
 * **A worker that does not know the verb says nothing at all.** `sw.ts`'s message handler is a
 * chain of `if`s with no `else`: an older build simply falls off the end, the port never
 * receives anything, and without this the mutation stays `isPending` for the life of the page —
 * a Clear button that spins for ever with nothing on screen saying why. That state is reachable
 * because a waiting worker is not an installed one: a reader who never presses the update bar
 * keeps the build they started the session with, by design (spec §5.4).
 *
 * Thirty seconds rather than three: the work is one `keys()` and a `delete` per entry over a
 * cache that can hold ~3 900 pictures, and a slow answer is not a wrong one.
 */
const REPLY_TIMEOUT_MS = 30_000;

/**
 * What a browser with no service worker freed, which is nothing, truthfully.
 *
 * **`npm run web:dev` registers no service worker at all** — measured, and recorded in
 * [pwa-shell.md](../../docs/reference/pwa-shell.md) — and a reader in a private window may have
 * none either. In both cases nothing has ever written to `IMAGE_CACHE`, because the only writer
 * is the worker: every picture on the wall came from the network and went into the browser's
 * own HTTP cache, which is not this app's to empty. So "nothing was cached" is the fact rather
 * than a shrug, and `cacheOutcome` already has the sentence for it — *"There was nothing cached
 * to clear."* — which is what a `files` of 0 prints.
 *
 * A rejection was the alternative and is worse: it paints the danger-zone red for a button that
 * did exactly what it should have.
 */
const NOTHING_CACHED: CacheCleared = { files: 0, bytes: 0, rows: 0, failed: 0 };

/**
 * Ask the worker to empty the picture cache, and answer in the DTO the panel already reads.
 *
 * `timeoutMs` is injectable for the reason `useServiceWorker`'s `reload` is: the default is the
 * thing being tested nowhere near as often as the path through it.
 */
export async function clearImageCache({
  timeoutMs = REPLY_TIMEOUT_MS,
}: { timeoutMs?: number } = {}): Promise<CacheCleared> {
  const worker = await activeWorker();
  if (!worker) return { ...NOTHING_CACHED };

  const report = await ask(worker, timeoutMs);
  return {
    files: report.files,
    bytes: report.bytes,
    // **Always 0, and this is the one number that is asserted rather than counted.** `rows` is
    // `image_cache`'s, and on this target `images.rs` is gated out of the crate entirely
    // (`lib.rs`), so nothing on the web build ever inserts one — the table is empty on every
    // browser that has ever run this app. Reporting the truth costs a literal; asking the
    // backend would cost a round trip to learn a constant. `cacheOutcome` prints it either
    // way, which is to say it does not print it at all.
    rows: 0,
    failed: report.failed,
  };
}

/**
 * The worker to ask, or `null` if there is none.
 *
 * **`controller` first, and the registration only as a fallback.** `controller` is the worker
 * serving *this* document, which is the one whose cache the pictures on screen came from. It is
 * `null` in three situations that are not the same: no service worker support at all, a first
 * load where `clients.claim()` has not run yet, and a document loaded around the worker (a
 * shift-reload, or devtools' bypass) while a perfectly good worker is active with a full cache.
 * Only the last one has anything to clear, and `getRegistration()` is what finds it — a reader
 * who presses Clear there would otherwise be told there was nothing cached over 256 MB of card
 * art.
 *
 * **`navigator.serviceWorker.ready` is not used and must not be**, however much it looks like
 * the right call: it never resolves when there is no registration, so a browser with none would
 * hang here rather than answering. `PwaShell`'s comment records that being measured.
 */
async function activeWorker(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  const container = navigator.serviceWorker;
  if (container.controller) return container.controller;
  const registration = await container.getRegistration();
  return registration?.active ?? null;
}

/**
 * One question, one answer, over a channel that exists for the length of it.
 *
 * A `MessageChannel` rather than a listener on `navigator.serviceWorker`, for `VERSION`'s
 * reason read from the other end: a worker replying to its clients would answer every open tab,
 * and a page listening for that would resolve on an answer to somebody else's press.
 */
function ask(worker: ServiceWorker, timeoutMs: number): Promise<ImageClearReport> {
  return new Promise<ImageClearReport>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(
        new Error(
          "The app's background worker did not answer, so the picture cache was left alone.",
        ),
      );
    }, timeoutMs);
    // Assigning `onmessage` starts the port; `addEventListener` would need an explicit
    // `start()` and is the version of this that silently receives nothing.
    channel.port1.onmessage = (event: MessageEvent<ImageClearReport>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage({ type: CLEAR_IMAGE_CACHE }, [channel.port2]);
  });
}
