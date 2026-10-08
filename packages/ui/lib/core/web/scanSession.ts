import type * as ScanModule from "./grimoire_scan";
import { once } from "./engine";
import { readable } from "./protocol";
import { isUnsupported, scanAnswerOf, type FromScanner, type ToScanner } from "./scanProtocol";

/**
 * **Everything the scanner's Worker decides**, with the Worker itself left out — `engine.ts`'s
 * arrangement, for its reason: what loads the module and what posts a message are handed in, so
 * the suite drives this file with neither a Worker nor a wasm module (`scanSession.test.ts`).
 * `scanWorker.ts` is the two handed in.
 */

/** The module's five calls — its exports, less the initialiser. */
export type ScanGlue = Pick<
  typeof ScanModule,
  "load" | "frame" | "reset" | "set_filters" | "memory_bytes"
>;

export interface ScanSession {
  /** Answer one message from the page. Never rejects: every outcome is a message back. */
  handle(message: ToScanner): Promise<void>;
}

/** What a call after a trap is told, whatever it was. The page has ended this Worker by then. */
export const AFTER_A_TRAP = "The card scanner stopped earlier and cannot answer.";

/**
 * The scanner Worker's session: the module loaded once, and each message answered by its id.
 *
 * **The module is instantiated once per Worker**, for the reason `engine.ts` gives at length:
 * wasm-bindgen's own guard does not hold two loads that overlap. A load that failed is
 * remembered as failed — this Worker never tries again, and the page makes a new one.
 *
 * **A module that would not load is `unloaded`, and says which kind** — a browser that will
 * not compile it, or files that did not arrive (`scanProtocol.ts`).
 *
 * **An export that throws is a trap, and after one nothing is asked of the module again.**
 * Every export is synchronous, so the throw arrives here, in the call's own `try`: the message
 * that was being answered is told `trapped`, and so is every message after it. The module would
 * answer those in words (`scanner::PANICKED`) — but its memory is whatever the panic left, and
 * a verdict read out of it is not one to file a card by.
 */
export function createScanSession(
  load: () => Promise<ScanGlue>,
  post: (message: FromScanner) => void,
): ScanSession {
  const loaded = once(() =>
    load().then(
      (glue) => ({ glue }),
      (error: unknown) => ({ unsupported: isUnsupported(error), message: readable(error) }),
    ),
  );
  let trapped = false;

  /** The module's string for one message. A throw out of here is a trap. */
  function ask(glue: ScanGlue, message: ToScanner): string {
    switch (message.kind) {
      case "load":
        // Ahead of the load, so the module owes them to it. What became of them is the load's
        // to say (`unapplied_filters`), so this answer is not read.
        if (message.filters !== null) glue.set_filters(message.filters);
        return glue.load(message.bundle, message.labels, message.detection, message.recognition);
      case "frame":
        return glue.frame(message.jpeg, message.detail, message.options);
      case "reset":
        return glue.reset();
      case "filters":
        return glue.set_filters(message.filters);
      case "memory":
        return JSON.stringify({ ok: glue.memory_bytes() });
    }
  }

  return {
    async handle(message: ToScanner): Promise<void> {
      const { id } = message;
      const module = await loaded();
      if (!("glue" in module)) {
        return post({ kind: "unloaded", id, unsupported: module.unsupported, message: module.message });
      }
      if (trapped) return post({ kind: "trapped", id, message: AFTER_A_TRAP });
      let text: string;
      try {
        text = ask(module.glue, message);
      } catch (error) {
        trapped = true;
        return post({ kind: "trapped", id, message: readable(error) });
      }
      post(scanAnswerOf(id, text));
    },
  };
}
