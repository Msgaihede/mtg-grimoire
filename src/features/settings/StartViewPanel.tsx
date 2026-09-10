import type { JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { NAV } from "@/components/nav";
import { sortOptions } from "@/lib/options";
import type { ViewId } from "@/lib/store";
import { useStartView } from "@/lib/useStartView";
import { SettingsSection } from "./panelChrome";

/**
 * The trigger's id, and the stem every other id on this panel is built from — one control, so
 * there is no `useId()` to be had and nothing to collide with: `SettingsSection`'s own heading is
 * `start-view-heading`, and this is deliberately not that.
 */
const PICKER_ID = "start-view-picker";

/**
 * The destinations this row offers — `NAV` minus the one row that is not always drawn.
 *
 * **`shared` is left out for the reason it has no chord**, which is the same fact read from a
 * second surface. Somebody else's binder appears on the rail only once a link has been opened
 * (`AppShell`'s `entries` filter, spec decision 6), so offering it here would let a reader choose
 * a destination the shell may then decline to draw — an app that opens on a page with no row
 * pointing at it, for a reason nothing on screen explains. Every other entry is on the rail for
 * every reader on every launch, which is the whole of what makes it offerable.
 *
 * **Derived from `NAV` rather than written out**, `CHORD_NAV`'s argument one file over: a
 * destination added to the rail joins this list by construction, and only a deliberate second
 * exclusion could ever be a decision again. It also means the label here and the label in the
 * rail are one string — a reader picks the word they have been reading down the left-hand side.
 *
 * **`sortOptions` and no pin, which is a decision rather than an omission.** The app's rule is
 * that an option list is alphabetical by its display label unless its *order is the information*
 * or the *reader arranged it* (`src/CLAUDE.md`), and neither holds: this is ten peers, and the
 * rail's own top-to-bottom order — two ways into the database, then the lists, then the things a
 * reader does with them — is an argument about a column being read downward, not about a picker
 * being searched for a word. Home is the default and is deliberately *not* pinned to the top for
 * it: the trigger already says which row is current, so pinning would buy nothing that the closed
 * control does not already show, and `Stacks`' pin one folder over earns itself on a list whose
 * other rows are the *alternates to* it. These ten are alternates to nothing.
 *
 * The glyph is the rail's own, so a row is recognised by the picture beside the word before it is
 * read — `DropdownOption.icon` draws it in the list *and* on the closed trigger.
 */
const OPTIONS: readonly DropdownOption[] = sortOptions(
  NAV.filter((entry) => entry.id !== "shared"),
  (entry) => entry.label,
).map((entry) => ({
  value: entry.id,
  label: entry.label,
  icon: <entry.Icon className="size-4 shrink-0" aria-hidden="true" />,
}));

/**
 * Which view the app opens on.
 *
 * ## Why this is a setting and not a fixed page
 *
 * Home is the page built to be landed on — `home.rs` seeds a layout for a reader who has never
 * customised anything, and every other view answers a question they have not asked yet. That is
 * the right *default* and it is a poor rule: a reader who opens this app to look a card up opens
 * it on Search, every time, and one who is mid-build opens it on their deck. The rail is one
 * press away either way, so what this setting is worth is exactly that press — repeated every
 * launch, for the life of the installation.
 *
 * ## What it does not do
 *
 * It does not move the reader anywhere. `useStartViewHydration` — mounted once, in `AppShell` —
 * is what reads this row at launch, and it drops its answer outright if the reader has already
 * pressed something (`store.ts`'s `viewPulse`). So a change made here is a statement about the
 * *next* launch, which is why nothing on this panel navigates and why the press has nothing to
 * confirm.
 *
 * ## The stored word may be one this list does not hold
 *
 * `useStartView` narrows a word this build has never heard of down to Home before it ever reaches
 * here, so the only value that can arrive unmatched is `shared` — a real view, deliberately not
 * offered above. The trigger names it anyway, through `placeholder`: what the app will actually
 * do on the next launch is the one thing this row exists to say, and drawing an em dash over a
 * setting that is in force would be the control lying about itself. Picking any row replaces it,
 * and there is no way back to it from here — which is the intent rather than a gap.
 *
 * **A native `<select>` could not have done that**, and the trap is worth naming because it is
 * silent: a controlled `<select>` whose `value` matches no `<option>` draws its **first row**
 * while still reporting the old value, so this panel would have said `Collection` — the first
 * label alphabetically — to a reader whose app opens on somebody else's binder. `Dropdown` is the
 * app's one option control for that reason among others; `StartViewPanel.test.tsx` pins the
 * behaviour rather than trusting it.
 *
 * It reaches the backend itself, which is `BackupPanel`'s rule and `TheoryMarksPanel`'s reason
 * beside it: `useStartView` reads the same `["startView"]` cache entry `AppShell` already filled
 * at launch, so a hook here is a second reader of one cached answer rather than a second channel,
 * and threading it down from `SettingsPage` would buy a prop.
 */
export function StartViewPanel(): JSX.Element {
  const { view, setView } = useStartView();

  return (
    <SettingsSection id="start-view" title="Opening view">
      <p className="text-sm text-dim">
        Which view the app opens on when you launch it. Home is built to be landed on — it is
        where the app opens until you say otherwise — but if you always start in the same place,
        start there.
      </p>

      {/* No visible `<label>`: the section's heading is already the only name this control could
          be given, and a second copy of it directly above the trigger would be the same two words
          twice in 40px. The name is stated outright with `label` instead, which is what
          `Dropdown` takes when there is no `<label htmlFor>` to point at.

          `fill` deliberately **not** passed — the trigger sizes to its widest row here rather
          than to the pane, because a full-width control over a 632px pane reads as a text field
          rather than as a picker with ten short words in it. */}
      <Dropdown
        id={PICKER_ID}
        label="Opening view"
        value={view}
        // `ViewId` and `StartView` are the same union since Task 24 landed `"home"` in the
        // former, so this is a narrowing rather than a claim: every value that can reach the
        // handler is written out of `NAV` above, and `NAV` is typed by `ViewId`.
        onChange={(next) => setView(next as ViewId)}
        options={OPTIONS}
        // The unmatched case, argued in this component's own doc. `NAV` answers for every
        // `ViewId`, so the fallback below is unreachable by construction and is written anyway
        // rather than asserted away — `Dropdown`'s own em dash is what an option control says
        // when it has nothing to say.
        placeholder={NAV.find((entry) => entry.id === view)?.label}
      />

      {/* `TheoryMarksPanel`'s closing sentence and the same fact: this is an `app_meta` row, and
          `app_meta` is not among the tables sync carries. Two devices really do land in two
          different places, and here that is closer to a feature than to a shortfall — the desk
          and the phone are not opened for the same reason. Said out loud regardless, because a
          reader who has just paired two machines has every right to expect otherwise. */}
      <p className="text-sm text-dim">
        This is kept only on this device — each of your devices can open somewhere different.
      </p>
    </SettingsSection>
  );
}
