import { ipcError } from "@grimoire/ui/lib/ipc";
import { notify } from "@grimoire/ui/lib/notifications";

/**
 * Say one write as a toast — `done` once it lands, `failed` with the backend's sentence once it is
 * refused — and **hand the same write back**, so the press that made it can also give it to its
 * receipt line (`useReceipt`, `useListReceipt`), which keeps that write's `Undo`.
 *
 * **Called at the press, never inside a hook** (the owner's rule, `packages/ui/CLAUDE.md`): the
 * phone's receipt hooks are fed by steppers too, and a stepper says nothing. Each call is one
 * press and one toast; a press over several writes says them once with the desktop's own
 * `reportPresses` instead.
 *
 * The refusal is caught here, so a rejected write is never an unhandled rejection on this branch;
 * the receipt's own branch catches its copy.
 */
export function toasted<T>(
  write: Promise<T>,
  say: { done: string | ((answer: T) => string | null); failed: string },
): Promise<T> {
  write.then(
    (answer) => {
      const title = typeof say.done === "string" ? say.done : say.done(answer);
      if (title !== null) notify.success(title);
    },
    (error: unknown) => notify.error(say.failed, { body: ipcError(error) }),
  );
  return write;
}
