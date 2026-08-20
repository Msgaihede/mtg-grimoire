import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { UpdateStatus } from "@/lib/ipc";
import { nextAction, type Update } from "@/lib/useUpdate";
import { pickAsset } from "../../../.storybook/fake/db";
import { CURRENT_VERSION, NEXT_VERSION, release } from "../../../.storybook/fake/fixtures";
import { CONFIRM_WORD } from "./ConfirmDialog";
import { SettingsPage } from "./SettingsPage";

/**
 * What `useUpdate` would have answered, built the way `Settings/UpdatePanel`'s stories build
 * it — one status, and the hook's own `nextAction` deriving the action from it.
 *
 * **Two small copies rather than an import, and the constraint is CSF.** Every non-default
 * export of a `.stories.tsx` file is indexed as a *story*, so the panel's file cannot lend
 * these two helpers out: exporting them would put `status` and `update` in the sidebar as
 * stories that fail to render. `.storybook/fake/fixtures.ts` is where a fixture more than one
 * file needs goes, and the `release` and the version pair below **do** come from there — what
 * stays here is the two-line assembly, which is the part that differs per page anyway.
 */
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  const available = release(NEXT_VERSION);
  const installKind = over.installKind ?? "portable";
  return {
    currentVersion: CURRENT_VERSION,
    installKind,
    available,
    // Picked by the rule, never named: `update::pick_asset` matches the tail of an asset name
    // against this install kind's suffix, and the fake re-implements exactly that.
    asset: pickAsset(available.assets, installKind),
    // Two hours before whenever this page is read. `formatChecked` turns relative into a date
    // after a week, so a fixed instant would render one sentence today and another next month.
    lastCheckAt: String(Math.round(Date.now() / 1000) - 2 * 3600),
    busy: false,
    staged: false,
    ...over,
  };
}

function update(over: Partial<Update> = {}): Update {
  const next = "status" in over ? (over.status ?? null) : status();
  return {
    status: next,
    progress: null,
    busy: false,
    action: nextAction(next),
    error: null,
    check: fn(),
    download: fn(),
    install: fn(),
    openReleasePage: fn(),
    ...over,
  };
}

const meta = {
  title: "Settings/Page",
  component: SettingsPage,
  tags: ["autodocs"],
  args: { update: update({ status: status({ available: null, asset: null }) }) },
  decorators: [
    // The content column at the 1280×800 window `tauri.conf.json:16-17` opens: 1280 less the
    // sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px), from
    // `AppShell.tsx:93` and `AppShell.tsx:148`. The page's own `max-w-2xl` is narrower than
    // that, which is the thing worth seeing — a settings column that ran the full width would
    // be a 1032px line of prose.
    (Story) => (
      <div className="w-[1032px] p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Settings, which is five real sections and an honest note about the rest.\n\n" +
          "**Ordered by what a press costs.** Updates, prices and errors first; then the "  +
          "local cache, which throws away bytes the app fetches again; then the three "  +
          "clears that cannot be taken back, alone at the foot in a region of their own. "  +
          "That distance is the first fence and the typed word inside each dialog is the "  +
          "second — see `Settings/DangerZonePanel`.\n\n" +
          "**`update` is a prop, and that is the design rather than a convenience.** " +
          "`App.tsx` calls `useUpdate` once and hands the answer to both `AppShell` — for the " +
          "ribbon's gold button — and to this page, for the panel. Two calls would be two " +
          "`update:progress` listeners racing to describe one download, so the hook is owned " +
          "one level up and this page never reaches the backend at all.\n\n" +
          "That makes every story here an argument, exactly as `Chrome/Ribbon`'s are. " +
          "`Chrome/AppShell`'s `Settings` and `UpdateAvailable` are the same page driven by a " +
          "**seeded world** instead, through the real hook — which is where the ribbon button " +
          "and this panel are shown agreeing with each other.\n\n" +
          "The other two panels are the opposite and are hooked up *here*. The error log is, " +
          "because nothing else in the window reads it; the marketplace is, because half the " +
          "window does — every price surface asks `useMarketplace()` for its currency, and one " +
          "TanStack Query entry with `staleTime: Infinity` means they are all reading the same " +
          "cached answer rather than opening a second channel. So both reach the fake, and " +
          "`SwitchingMarketplace` below is a real write to the fake's `app_meta` row.\n\n" +
          "The blurb this view used to be is now a section of it. What is genuinely still " +
          "missing — the data folder, sync behaviour, import and export — says so under its " +
          "own dim heading rather than standing in for a panel that exists.",
      },
    },
  },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The page most days: a version, a check, and the one thing that is not here yet.
 *
 * Two `h2`s and they are deliberately not equal. The panel's is plain, in Cinzel at 18px —
 * the display face's one job in the content, and the direction's floor for it. "Not here yet"
 * is the same size in `text-dim`, because a heading over an absence should not compete with a
 * heading over something a reader can act on.
 *
 * The column is `max-w-2xl` and centred inside a 1032px view. Settings is prose and controls,
 * and prose set to the full width of this window would be 1032px of measure — roughly twice
 * what is comfortable to read.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Labelled sections, each named by its own heading through `aria-labelledby` — which is
    // what makes them regions a screen reader can jump between rather than three `div`s.
    await expect(canvas.getByRole("heading", { name: "Updates", level: 2 })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Prices", level: 2 })).toBeInTheDocument();
    await expect(
      canvas.getByRole("heading", { name: "Not here yet", level: 2 }),
    ).toBeInTheDocument();
    // The two new ones, and their order on the page: the reversible sweep above the blurb,
    // the irreversible clears below it.
    await expect(canvas.getByRole("heading", { name: "Local cache", level: 2 })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Clear data", level: 2 })).toBeInTheDocument();
    await expect(canvas.getByText(/You’re on the latest version\./)).toBeInTheDocument();
    // The setting an install starts on, read through the real hook rather than passed in.
    await expect(await canvas.findByRole("button", { name: "TCGplayer USD" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * The one story on this page that *writes* the setting.
 *
 * `useMarketplace` is hooked up here rather than passed in, so this goes all the way down:
 * the press calls `set_marketplace`, the fake validates the id and writes its `app_meta` row,
 * and the mutation puts the answer straight into the cache — no refetch, because the command
 * has already committed it and a refetch would only ask the database to repeat itself.
 *
 * The mark moves and **nothing else on the page does**, which is the point of watching it
 * here rather than on the panel alone: every price surface in the real window re-renders off
 * the cache it already has, with no sync, no spinner and no gap.
 */
export const SwitchingMarketplace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Cardmarket EUR" }));

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Cardmarket EUR" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    await expect(canvas.getByRole("button", { name: "TCGplayer USD" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The three with no feed are still offered, still in the tab order, and still refuse.
    await expect(canvas.getByRole("button", { name: "Mana Pool USD" })).not.toBeDisabled();
  },
};

/**
 * The same page with something to say.
 *
 * The panel grows a bordered block under the version line rather than replacing anything: the
 * current version, the last check and "Check now" stay exactly where they were, so the reader
 * who came here to look something up is not made to re-find it because a release happened.
 *
 * Nothing else on the page moves, which is the point of storying it beside {@link Default}.
 */
export const UpdateAvailable: Story = {
  args: { update: update() },
};

/**
 * A build that has been downloaded and verified — the page one press away from restarting.
 *
 * Worth a story of its own here rather than only on the panel, because this is the state a
 * reader *arrives* at: they pressed Download on this page, watched the bar, and this is what
 * it left behind. The sentence under the button is what the press costs, said before it.
 */
export const ReadyToRestart: Story = {
  args: { update: update({ status: status({ staged: true }) }) },
};

/**
 * The page with something to answer for — and the one story here that reaches the backend.
 *
 * `update` is a prop, but the error log is not: nothing else in the window reads it, so
 * `SettingsPage` owns that hook itself and this story drives it through a **seeded world**
 * (`fault: "errorLog"`). Which makes it the only place the Clear button is real: the fake's
 * `error_log_clear` writes to the table, so pressing it here actually empties the panel.
 *
 * `Settings/ErrorLogPanel` stories the same three rows as arguments; this is the page they
 * arrive on, in the column they arrive in, under a panel about something else entirely.
 */
export const SomethingFailed: Story = {
  parameters: { fake: { fault: "errorLog" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("×617")).toBeInTheDocument();
    // The panel's own heading, beside the update panel's — each section named by its own
    // heading rather than by its position on the page.
    await expect(canvas.getByRole("heading", { name: "Errors", level: 2 })).toBeInTheDocument();
  },
};

/**
 * The typed word, driven all the way to the fake.
 *
 * `useDangerZone` is hooked up in the page for the error log's reason — nothing else in the
 * window writes to those tables — so this story is the only place the gate is *real*: the
 * press opens the dialog, the word arms the button, the fake's `collection_clear` empties its
 * table and derives the deck reservations that went with it, and the sentence that lands under
 * the buttons is `clearOutcome`'s over the fake's own numbers.
 *
 * The seed is `starter`, which owns cards and holds decks — without both, the second clause of
 * that sentence would never be exercised, and that clause is the consequence the reader did not
 * ask for.
 *
 * The dialog is a modal over the whole window rather than a child of the story's box, so it is
 * reached through `document.body`.
 */
export const ClearingTheCollection: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);

    await userEvent.click(canvas.getByRole("button", { name: "Clear collection" }));
    const dialog = await page.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear collection" });

    // The gate: open, warned, and still not pressable.
    await expect(dialog).toHaveTextContent("This cannot be undone.");
    await expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByRole("textbox"), CONFIRM_WORD);
    await expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    // The dialog closes itself before the command runs, so the sentence lands on a page the
    // reader can see rather than under a modal.
    await waitFor(async () => {
      await expect(page.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(async () => {
      await expect(canvas.getByRole("alert")).toHaveTextContent(/Cleared|already empty/);
    });
  },
};

/**
 * The reversible one, for the contrast: same page, same shape of question, **no typed word**.
 *
 * A word typed on every dialog is a word nobody reads — which is what would make it useless on
 * the three below. So the cache asks once and takes the answer, and the sentence it leaves says
 * what came back rather than what went.
 */
export const ClearingTheCache: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);

    await userEvent.click(canvas.getByRole("button", { name: "Clear cache" }));
    const dialog = await page.findByRole("dialog");

    await expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear cache" }));

    await waitFor(async () => {
      await expect(canvas.getByText(/^Freed /)).toBeInTheDocument();
    });
  },
};
