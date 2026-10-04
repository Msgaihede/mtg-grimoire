import { readSource, type ImageSource } from "./pictures";

/**
 * **How the service worker asks the engine where a picture is** — through the page.
 *
 * The engine is a WASM module in a *dedicated* Worker, which only the page that made it can
 * reach; a service worker cannot post to it. So the worker asks the page that asked for the
 * picture, the page asks its `Core`, and the answer comes back on a channel made for that one
 * question. Hand-written like `protocol.ts` and for its reason, and read by both ends: the
 * worker's half is checked under the `WebWorker` lib and the page's under `DOM`.
 */

/** Worker → page, with one port: *where is the picture at this protocol path?* */
export const ASK_SOURCE = "grimoire:picture-source";

/** Page → the waiting worker: the reader pressed the update. The only thing that activates it. */
export const SKIP_WAITING = "grimoire:skip-waiting";

/**
 * Page → the *active* worker: this page is one nothing controls — take it. A page loaded by a
 * hard reload goes round the worker for the life of the document, so its pictures are asked of
 * the network, where there are none; the worker claims its pages when it activates, and this is
 * the same claim asked for by a page that arrived after that.
 */
export const CLAIM = "grimoire:claim";

/**
 * Worker → every window of the app: **this worker's install failed, and why.**
 *
 * A worker that cannot install says so nowhere a page can hear by itself: the browser drops it,
 * the page runs on with no worker — no card picture, no offline shell — and nothing is written
 * anywhere a reader or a bug report would look. Its own `console` is the worker's, not the
 * page's. So the reason is posted to the pages before the install is let fail, and the page
 * says it once (`../update.ts`).
 */
export const INSTALL_FAILED = "grimoire:install-failed";

export interface InstallFailed {
  kind: typeof INSTALL_FAILED;
  /** The error as one line: its name and its message. */
  reason: string;
}

/** The reason an {@link INSTALL_FAILED} message carries, or `null` for any other message. */
export function installFailure(data: unknown): string | null {
  if (!isKind(data, INSTALL_FAILED)) return null;
  const { reason } = data as Partial<InstallFailed>;
  return typeof reason === "string" ? reason : "";
}

/** An error as the one line {@link InstallFailed} carries. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const isKind = (data: unknown, kind: string): boolean =>
  typeof data === "object" && data !== null && "kind" in data && data.kind === kind;

/** Whether a message to the worker is {@link SKIP_WAITING}. */
export function isSkipWaiting(data: unknown): boolean {
  return isKind(data, SKIP_WAITING);
}

/** Whether a message to the worker is {@link CLAIM}. */
export function isClaim(data: unknown): boolean {
  return isKind(data, CLAIM);
}

export interface SourceAsk {
  kind: typeof ASK_SOURCE;
  /** `/<variant>/<card id>/<face>`. */
  path: string;
}

/** Page → worker, on the ask's port. */
export type SourceReply =
  | { kind: "source"; source: ImageSource }
  /** The page's `Core` refused: a second tab, an engine that stopped, an engine without the command. */
  | { kind: "refused"; message: string };

/**
 * What the worker ends up with. `silent` is a page that never answered — one from before this
 * protocol, one being torn down, one whose engine is still opening or is deep in an ingest —
 * and `nobody` is no page to ask at all.
 */
export type Asked = SourceReply | { kind: "silent" } | { kind: "nobody" };

/**
 * How long a page is given to answer: **20 s.**
 *
 * Longer than it looks like it should be, on purpose. The engine has one connection, and a call
 * made during an ingest's tail waits for it — 26 s was the longest single wait measured on a
 * first run when this bound was chosen (light-app.md §9.2), and 4.8 s once the feeds' finishes
 * took turns (§9.3); no picture has yet been seen to wait it out. A short bound would turn every picture asked for in that window
 * into a refusal, and `useImageRetry` comes back only twice; a long one costs nothing, because
 * the frame's own stall watchdog (`CardImage`, 5 s) asks again and **joins the ask already in
 * flight** (`serve.ts` keeps one per picture), so the picture is fetched and stored the moment
 * the engine answers, whether or not the frame that first asked is still waiting.
 */
export const ASK_TIMEOUT_MS = 20_000;

/** As much of a `Client` (or, on the page, a `ServiceWorker`) as a message needs. */
export interface Postable {
  postMessage(message: unknown, transfer: MessagePort[]): void;
}

/**
 * Ask one page, and settle exactly once: on its reply, or as `silent` after `timeoutMs`.
 *
 * **A `MessageChannel` and not a broadcast**: a reply posted to the worker would arrive with no
 * way to tell whose question it answers. A post that throws — the client went away between
 * being found and being asked — is `silent` at once rather than after the wait.
 */
export function askPage(
  client: Postable,
  path: string,
  timeoutMs: number = ASK_TIMEOUT_MS,
): Promise<SourceReply | { kind: "silent" }> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let done = false;
    const settle = (answer: SourceReply | { kind: "silent" }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Closed, or the port keeps the worker alive waiting on a page that has nothing to add.
      channel.port1.close();
      resolve(answer);
    };
    const timer = setTimeout(() => settle({ kind: "silent" }), timeoutMs);
    // Assigning `onmessage` starts the port; a listener added the other way never hears.
    channel.port1.onmessage = (event: MessageEvent<unknown>) => settle(readReply(event.data));
    try {
      client.postMessage({ kind: ASK_SOURCE, path } satisfies SourceAsk, [channel.port2]);
    } catch {
      settle({ kind: "silent" });
    }
  });
}

/** A reply as it arrived, or `refused` for anything that is not one. */
export function readReply(data: unknown): SourceReply {
  if (typeof data === "object" && data !== null && "kind" in data) {
    if (data.kind === "source" && "source" in data) {
      const source = readSource(data.source);
      if (source) return { kind: "source", source };
    }
    if (data.kind === "refused" && "message" in data) {
      return { kind: "refused", message: String(data.message) };
    }
  }
  return { kind: "refused", message: "The page answered something unreadable." };
}

/**
 * Ask the pages in turn until one names a source.
 *
 * **In turn, not at once**: the list is the page that asked, or — for a request no page is known
 * to have made — every window of the app. Only one tab of an origin holds the database, so a
 * second tab's page refuses at once and the next is asked; a page that is silent ends the walk,
 * because another full wait behind it would outlast every frame that could still draw the answer.
 */
export async function askPages(
  clients: readonly Postable[],
  path: string,
  timeoutMs: number = ASK_TIMEOUT_MS,
): Promise<Asked> {
  let last: Asked = { kind: "nobody" };
  for (const client of clients) {
    last = await askPage(client, path, timeoutMs);
    if (last.kind !== "refused") return last;
  }
  return last;
}

/** What the page's half is handed: one message from the worker and the port to answer on. */
export interface Heard {
  data: unknown;
  ports: readonly { postMessage(message: unknown): void }[];
}

/**
 * The page's half: answer one message, if it is an ask. `lookup` is the page's
 * `core.call("card_image_source", { path })`.
 *
 * **Every ask is answered, a refusal included** — the worker would otherwise wait out its whole
 * bound for a page that already knows the answer is no. Whether it was an ask at all is the
 * return value, so the caller's listener can leave anything else to whoever else is listening.
 */
export function answerAsk(heard: Heard, lookup: (path: string) => Promise<unknown>): boolean {
  const { data } = heard;
  if (typeof data !== "object" || data === null || !("kind" in data)) return false;
  if (data.kind !== ASK_SOURCE || !("path" in data) || typeof data.path !== "string") return false;
  const port = heard.ports[0];
  if (!port) return true;
  const reply = (answer: SourceReply): void => {
    try {
      port.postMessage(answer);
    } catch {
      // The worker stopped waiting and closed its end; there is nobody to tell.
    }
  };
  lookup(data.path).then(
    (value) => {
      const source = readSource(value);
      reply(
        source
          ? { kind: "source", source }
          : { kind: "refused", message: "The card engine answered something unreadable." },
      );
    },
    // A `Core` refuses with a bare string (`web/index.ts`); anything else is said as it is.
    (error: unknown) =>
      reply({ kind: "refused", message: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}
