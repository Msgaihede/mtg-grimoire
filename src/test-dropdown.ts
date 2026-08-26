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
  // The listbox is a plain conditional render ({open && ...}), so it commits synchronously to
  // the DOM with the click — nothing is deferred or awaited. This means `getByRole` finds it
  // immediately, which is faster and more importantly **fail-fast**: if the panel never mounts,
  // the query throws now rather than masking the error behind a 1000ms timeout. Note that
  // `getByRole` gates only on `hidden`, `aria-hidden` and `display: none` (per `isSubtreeInaccessible`
  // in `src/test-setup.ts`), not on `opacity` the way `toBeVisible` does — so the query works
  // even mid-animation. Never reach for `toBeVisible` to assert presence here; it would fail on
  // an element that is correctly mounted but still transitioning in.
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
