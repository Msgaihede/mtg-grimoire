import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { BackupPanel } from "./BackupPanel";

const meta = {
  title: "Settings/BackupPanel",
  component: BackupPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // layout risk here is a path. A path is one unbreakable word to a browser, and this is the
    // width at which `break-all` either saves the row or does not.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The plain-text mirror: a write-only copy of your decks, collection and wishlist " +
          "on disk, in all seven export formats, for the day the app will not start.\n\n" +
          "**This panel reaches the backend itself**, where its five neighbours take their " +
          "state as a prop. Nothing else in the window reads `mirror_status` — the mirror is a " +
          "background thread with no ribbon button and no view of its own — so threading it " +
          "down from `SettingsPage` would buy a prop and nothing else. Every story here is " +
          "therefore a **seeded world** rather than an argument: pressing the switch really " +
          "writes the fake's `app_meta` row, and Rebuild now really runs a pass over its rows.\n\n" +
          "**The workbench has no filesystem and does not pretend to.** `mirror_rebuild` counts " +
          "the files a pass would write — seven formats per deck, per collection folder, per " +
          "wishlist folder, plus `README.txt` — and stamps the time. Press it twice and the " +
          "answer changes from *written* to *unchanged*, which is the hash-comparison the whole " +
          "design rests on: a mirror that is already correct costs reads and no writes.\n\n" +
          "**A pass that could not write is news, not an alarm.** No database write ever waits " +
          "on a mirror write, so an unplugged stick costs a folder of text files and costs the " +
          "collection nothing. The sentence lives here, the next pass tries again on its own, " +
          "and nothing is ever raised as a dialog.",
      },
    },
  },
} satisfies Meta<typeof BackupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A fresh install: on, writing beside the database, with no pass behind it.
 *
 * **"Not run yet" is the assertion worth having on the opening story.** `lastReport` is `null`
 * here, and a panel that drew its zeroes instead would say *0 files written* — which is
 * indistinguishable, on the face of it, from a mirror that is already complete. So it says what
 * it knows and says what to press.
 *
 * The workbench is in this state for a reason of its own: the real mirror runs a full pass at
 * startup, so a reader opening Settings has always missed one. There is no thread here, which
 * makes the never-run state the honest opening and Rebuild now the way out of it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/Not run yet/)).toBeInTheDocument();
    await expect(canvas.queryByText(/0 files written/)).not.toBeInTheDocument();
    await expect(canvas.getByRole("switch", { name: /back up/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(canvas.getByText(/data[\\/]export$/)).toBeInTheDocument();
  },
};

/**
 * The switch, thrown — the one press on this panel that changes what the app *does*.
 *
 * **Nothing is confirmed, and that is the decision worth seeing.** Switching the mirror off
 * destroys nothing: the files already written stay exactly where they are and the setting only
 * stops the thread writing more. A dialog here would be a fence around a choice that costs
 * nothing to reverse — which is what makes the three dialogs at the foot of this page mean
 * something.
 *
 * It goes all the way down: the press calls `mirror_set_enabled`, the fake writes its row, and
 * the panel re-reads it. What comes back on screen is the stored setting rather than optimism.
 */
export const SwitchedOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const control = await canvas.findByRole("switch", { name: /back up/i });
    await expect(control).toHaveAttribute("aria-checked", "true");

    await userEvent.click(control);

    await waitFor(async () => {
      await expect(canvas.getByRole("switch", { name: /back up/i })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });
    // The word beside the mark, because the mark alone is not what a sighted reader reads.
    await expect(canvas.getByRole("switch", { name: /back up/i })).toHaveTextContent("Off");
    // No confirmation of any kind — not a dialog, and not a second press.
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    // The folder is unchanged: switching off is not moving out.
    await expect(canvas.getByRole("button", { name: /Change folder/ })).toBeInTheDocument();
  },
};

/**
 * Rebuild now, pressed twice — the two answers a pass can give.
 *
 * The first press writes every file; the second finds them all unchanged and writes nothing.
 * That is the hash-comparison the whole feature rests on, and it is the reason the summary
 * always says both numbers: *N written* on its own cannot tell a mirror that was already
 * correct from one that could not be written at all.
 *
 * **The outcome line and the status line are two different sentences.** The alert says what
 * *this press* did; the line above it says what the mirror last recorded.
 *
 * **The alert is not sticky, and the ranking is by clock.** A TanStack mutation stays
 * `isSuccess` for the life of the component, so a rebuild's note ranked above the backend's own
 * state would hide every later failure until the reader navigated away — the panel reporting
 * "Rebuilt — 350 files written" while the mirror had quietly stopped working. `errorOutranks`
 * compares `MirrorStatus.lastRunAt` against the moment this rebuild finished: a pass that
 * failed *after* it wins, and a failure it has already answered does not. See
 * {@link RootUnwritable} for the other end of that.
 */
export const Rebuilt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Rebuild now/ }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(/^Rebuilt — \d+ files written, 0 unchanged\.$/);
    await expect(await canvas.findByText(/Last written just now/)).toBeInTheDocument();

    // Again, over a mirror that is now correct: nothing to write, everything unchanged.
    await userEvent.click(canvas.getByRole("button", { name: /Rebuild now/ }));
    await waitFor(async () => {
      await expect(canvas.getByRole("alert")).toHaveTextContent(
        /^Rebuilt — 0 files written, \d+ unchanged\.$/,
      );
    });
  },
};

/**
 * The stick that was unplugged.
 *
 * **The panel says so and the app carries on.** A revoked permission, an uninstalled sync
 * folder, a drive that is not there: the pass records the reason, no database write ever waits
 * on it, and the next pass tries again — a root that comes back gets a full rebuild rather than
 * a partial one, because the dirty mask cannot describe what was missed while it was gone.
 *
 * Pressing Rebuild now in this state **refuses**, which is the half that makes this a fault
 * rather than a fixture: a button that cleared the error by succeeding into a folder that is
 * not there would be showing a state the app cannot be in.
 *
 * What a *successful* rebuild would do here is the precedence {@link Rebuilt} describes: a pass
 * that finished after the recorded failure has answered it, and the panel says so rather than
 * telling a reader who has just plugged the stick back in that their repair did not take.
 */
export const RootUnwritable: Story = {
  parameters: { fake: { fault: "mirrorRootUnwritable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /The last backup could not be written\..*is not there/,
    );
    // The folder is named, because "somewhere could not be written" helps nobody.
    await expect(canvas.getByText("E:\\Backups\\MTG")).toBeInTheDocument();
    // The switch is untouched: a failed pass is not a setting that turned itself off.
    await expect(canvas.getByRole("switch", { name: /back up/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.click(canvas.getByRole("button", { name: /Rebuild now/ }));

    await waitFor(async () => {
      await expect(canvas.getByRole("alert")).toHaveTextContent(/is not there/);
    });
  },
};

/**
 * Change folder…, pressed — and the one control on this panel that cannot work in a browser.
 *
 * The picker is the operating system's: `open()` from `@tauri-apps/plugin-dialog` reaches
 * Tauri's `invoke`, and outside the app window there is nothing behind it. So the press ends in
 * the refusal line rather than in a folder dialog, which is exactly what the panel does when a
 * picker cannot be opened. (`DeckCoverPicker` carried a `PickerUnavailable` story making the
 * same point until 2026-08-31; it went with custom deck covers, so this is now the only place
 * the workbench shows that gap.)
 *
 * The two answers a *working* picker gives — a chosen folder and a cancel — are unit-tested
 * instead, because only the OS can produce either.
 */
export const PickerUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Change folder/ }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /Could not open the folder picker/,
    );
    // The setting is untouched, which is the property that matters: a picker that would not
    // open must not move a mirror.
    await expect(canvas.getByText(/data[\\/]export$/)).toBeInTheDocument();
  },
};
