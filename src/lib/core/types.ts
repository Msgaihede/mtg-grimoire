/**
 * The one interface between this frontend and whatever is answering its commands.
 *
 * Two methods, because that is all `src/lib/ipc.ts` has ever needed: a request/response
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
   * the names that matter.
   */
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;

  /**
   * Subscribe to a backend event. The handler receives the **payload**, not an envelope.
   *
   * Returns a synchronous unsubscribe. Synchronous because a React effect's cleanup cannot
   * await, and a component can unmount before the subscription has finished being set up —
   * so the returned function has to be callable immediately and still take effect later.
   */
  listen<T>(event: string, handler: (payload: T) => void): () => void;
}
