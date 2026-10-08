/**
 * What a call can carry. Almost every command is matched **by name**, so `Record<string,
 * unknown>` is the ordinary shape — but the scanner sends a camera frame, and a frame is bytes
 * with no fields to name, so the union's other arm is the raw `Uint8Array` Tauri forwards to a
 * command's own binary argument.
 */
export type CallArgs = Record<string, unknown> | Uint8Array;

/**
 * Out-of-band metadata for a call, carried as HTTP-shaped headers because that is the vocabulary
 * Tauri's own IPC already forwards a raw invoke's headers in. The scanner uses this to send the
 * detector options a byte payload has no field of its own to hold.
 */
export interface CallOptions {
  headers?: Record<string, string>;
}

/**
 * The one interface between this frontend and whatever is answering its commands.
 *
 * Two methods, because that is all `packages/ui/lib/ipc.ts` has ever needed: a request/response
 * call and a subscription. Everything else about a platform — file pickers, the clipboard,
 * the window frame — is a *service* rather than the command boundary and is abstracted
 * separately, if at all.
 */
export interface Core {
  /**
   * Invoke a backend command by name.
   *
   * `args` is matched **by name** against the Rust command's parameters, so a misspelled
   * key is a runtime deserialization error with no type error anywhere. `ipc.test.ts` pins
   * the names that matter. A `Uint8Array` is the one exception — there is no name to match,
   * it forwards as the command's own binary argument — and `options.headers` rides beside it
   * for whatever the bytes alone cannot say.
   */
  call<T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T>;

  /**
   * Subscribe to a backend event. The handler receives the **payload**, not an envelope.
   *
   * Returns a synchronous unsubscribe. Synchronous because a React effect's cleanup cannot
   * await, and a component can unmount before the subscription has finished being set up —
   * so the returned function has to be callable immediately and still take effect later.
   */
  listen<T>(event: string, handler: (payload: T) => void): () => void;
}

/**
 * The two things a face asks of its host that are not commands: put text on the clipboard, and
 * open a page somewhere that is not this app (the light-app spec §3.5's third row).
 *
 * A second interface rather than two more methods on {@link Core}, because a `Core` is the
 * command boundary — it can be deferred, refused or wrapped as a whole — and neither of these
 * ever reaches a backend: each is answered by the window the page is in. `host.ts` has the
 * implementations and `index.ts` chooses one, where it chooses the `Core`.
 */
export interface Host {
  /**
   * Put `text` on the clipboard. **Rejects rather than pretending**: a caller draws `Copied.`
   * only once this resolves, and frames a rejection as its own failure.
   */
  copyText(text: string): Promise<void>;

  /**
   * Open `url` outside the app — the system browser, or a new tab. **Rejects when nothing
   * opened**, where the host can tell: a press that did nothing has to be reportable.
   */
  openUrl(url: string): Promise<void>;
}
