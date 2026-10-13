/**
 * Say a refused open, where a press was meant to leave the app — `Open on Scryfall`, a link in a
 * note, a combo's page.
 *
 * Every one of those rows used to be `void openExternal(…)`: the press does nothing visible on
 * success (the browser comes forward), so a refusal — no default browser, a sandbox that will not
 * hand the URL over — was a button that silently did nothing, and an unhandled rejection besides.
 * A toast is the one place to say it (`@/lib/notifications`): the answer arrives after the press,
 * and on a menu or a rail row there is nothing left on screen that is about it. Success says
 * nothing — the page opening *is* the answer. The card menu's `Open on` rows say the same words
 * through its own `run`.
 */
import { ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";

export function refusedOpen(work: Promise<unknown>, where: string): void {
  work.catch((failure: unknown) => {
    notify.error(`Couldn't open ${where}`, { body: ipcError(failure) });
  });
}
