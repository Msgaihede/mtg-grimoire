import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Drive a `Dropdown` from a test, the way `test-drag.ts` drives a drag.
 *
 * **Why a helper and not 72 hand-written pairs of clicks.** These replaced 72
 * `userEvent.selectOptions` calls across 25 files when the app's native `<select>`s became one
 * component. Written out at each site, the component's internals would be pinned in 72 places and
 * the next change to them would be a 25-file sweep; here it is one edit.
 *
 * **A dropdown's trigger is a `button`, not a `combobox`.** The combobox is the search box the
 * trigger reveals, and only a `searchable` one has it. `getByRole("combobox")` therefore finds
 * nothing on most of these, which is the first thing a reader converting an old test trips over.
 */

/** Open a dropdown by its accessible name and return its trigger. */
export async function openDropdown(user: UserEvent, name: string | RegExp): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name });
  await user.click(trigger);
  // The listbox is mounted inside an AnimatePresence, so it exists on the same tick the click
  // flushes — getByRole works synchronously and is more efficient than waiting with findByRole.
  screen.getByRole("listbox");
  return trigger;
}

/**
 * Open a dropdown and pick one row.
 *
 * The direct replacement for `userEvent.selectOptions(select, "value")` — but note the second
 * argument is what the reader **sees**, not the underlying value. A test that pinned a value now
 * pins a label, which is the honest thing for a control whose rows are text.
 *
 * **A greyed row's accessible name is still its own text**, so a `getByRole("option", { name })`
 * finds a disabled row and the click is simply refused. Assert on `aria-disabled` when that is
 * what the test is about.
 */
export async function pickOption(
  user: UserEvent,
  name: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  await openDropdown(user, name);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Open a searchable dropdown and type into its search box. */
export async function searchDropdown(
  user: UserEvent,
  name: string | RegExp,
  text: string,
): Promise<void> {
  await openDropdown(user, name);
  await user.type(screen.getByRole("combobox"), text);
}
