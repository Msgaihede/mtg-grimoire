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

/**
 * Press a rail entry, which is how every story below reaches a panel outside `Updates`.
 *
 * **Matched as a prefix of the accessible name rather than the whole of it**, because two of the
 * six entries carry a badge and `SettingsNav` writes that count into the name as ` (3)`. A story
 * that named an entry exactly would pass on a seeded world with nothing waiting and fail on one
 * with something waiting, which is the wrong thing for a badge to be able to break.
 */
async function pickGroup(canvas: ReturnType<typeof within>, label: string) {
  await userEvent.click(canvas.getByRole("button", { name: new RegExp(`^${label}`) }));
}

const meta = {
  title: "Settings/Page",
  component: SettingsPage,
  tags: ["autodocs"],
  args: { update: update({ status: status({ available: null, asset: null }) }) },
  decorators: [
    // The content column at the 1280×800 window `tauri.conf.json:16-17` opens: 1280 less the
    // sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px), from
    // `AppShell.tsx:93` and `AppShell.tsx:148`. The page's own `max-w-4xl` is narrower than
    // that, which is the thing worth seeing — and it is wide enough at 1032 for the rail and
    // the pane to share a line, which is the shape the rail's container query calls "beside the
    // pane". A narrower box here would story the wrapped strip instead.
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
          // Deliberately no count of the sections: this line said six while the page drew
          // seven, and a prose-only edit routes to neither CI job — so nothing went red. The
          // headings are a fact about the tree, which `Default`'s play reads off the tree.
          "Settings: a rail of groups, a pane that draws one of them, and a box that searches " +
          "all of them.\n\n" +
          "**The page was one scroll of every panel until 2026-09-03**, ordered by what a press " +
          "costs. That rule is still the rule — but *inside a group* now, because an ordering " +
          "only helps a reader who already knows what they are scrolling towards. `nav.ts` owns " +
          "which panels a group holds and which a query matches; this page owns the two pieces " +
          "of state that decision is taken over, and every hook the panels are fed from.\n\n" +
          "**A query outranks the group**, which is the one rule worth watching here: typing " +
          "`dropbox` while standing on `Updates` draws `Backup`, from a group nobody selected, " +
          "and no entry is marked current for as long as the box has words in it. Picking an " +
          "entry is what clears the query — see `Searching` below, and `Settings/Nav` for the " +
          "rail on its own.\n\n" +
          "**`update` is a prop, and that is the design rather than a convenience.** " +
          "`App.tsx` calls `useUpdate` once and hands the answer to both `AppShell` — for the " +
          "ribbon's gold button — and to this page, for the panel. Two calls would be two " +
          "`update:progress` listeners racing to describe one download, so the hook is owned " +
          "one level up and this page never reaches the backend at all.\n\n" +
          "That makes every story here an argument, exactly as `Chrome/Ribbon`'s are. " +
          "`Chrome/AppShell`'s `Settings` and `UpdateAvailable` are the same page driven by a " +
          "**seeded world** instead, through the real hook — which is where the ribbon button " +
          "and this panel are shown agreeing with each other.\n\n" +
          "The other panels are the opposite and reach the fake. Three hooks are held *here*: " +
          "the error log, because nothing else in the window reads it; the marketplace, because " +
          "half the window does — every price surface asks `useMarketplace()` for its currency, " +
          "and one TanStack Query entry with `staleTime: Infinity` means they are all reading " +
          "the same cached answer rather than opening a second channel; and the review queue, " +
          "which is the marketplace's argument plus one of its own — the rail's `Sync` badge " +
          "has to count while `ReviewPanel` is unmounted, which is every group but its own. So " +
          "all three reach the fake, and `SwitchingMarketplace` below is a real write to the " +
          "fake's `app_meta` row.\n\n" +
          "**Backup and Combos take no props at all** and hold their own hooks, which is the " +
          "same argument from one step further along: threading either down would buy a prop " +
          "and nothing else. Combos shares the `Card data` entry with Prices because it is the " +
          "same kind of thing — an optional bulk feed from a third party that the app works " +
          "entirely without. See `Settings/CombosPanel` for the four states it draws.\n\n" +
          "**Sync is two halves in one panel** and the second one is new: pairing says who is " +
          "in the group, and the relay under it says how their changes reach each other — an " +
          "address the reader runs themselves, what is waiting to go, and one press that makes " +
          "a round trip. `Needs review` shares its entry, because the rows it lists are what a " +
          "sync asks of a person.\n\n" +
          "What is genuinely still missing — import — says so at the foot of the rail, under " +
          "the six real destinations rather than as a seventh that draws nothing.",
      },
    },
  },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The page as a reader arrives at it: six ways in, and the one group that opens by itself.
 *
 * `Updates` is the landing group because it is the one thing that sends somebody to this page
 * without their having chosen to come — the ribbon's gold button says there is a new version and
 * this is where it lands.
 *
 * **The play's second half is the half that is new.** It reads the rail's six entries off the
 * tree, and then asserts that three panels which used to be on this page *are not* — which is
 * the whole of what the regrouping did, and the one claim a screenshot of this story cannot
 * make. Before 2026-09-03 the same play asserted seven headings were present at once.
 *
 * The pane is `max-w-4xl` less the rail, centred inside a 1032px view: ~632px, within 40px of
 * the 42rem column every one of these panels was written for. Settings is prose and controls,
 * and prose set to the full width of this window would be roughly twice a comfortable measure.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The rail, by its own landmark rather than by position — six destinations, in `nav.ts`'s
    // declaration order, which is the only place that order is written.
    const rail = within(canvas.getByRole("navigation", { name: "Settings" }));
    for (const label of ["Updates", "Card data", "Sync", "Tags", "Storage and data", "Errors"]) {
      await expect(rail.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    // The group that opens by itself, marked as current — and its panel, drawn as a labelled
    // region named by its own heading, which is what makes it something a screen reader can
    // jump to rather than a `div`.
    await expect(rail.getByRole("button", { name: "Updates" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByRole("heading", { name: "Updates", level: 2 })).toBeInTheDocument();
    await expect(canvas.getByText(/You’re on the latest version\./)).toBeInTheDocument();

    // One panel from each of three other groups, absent — the pane draws one group, not twelve
    // panels with a rail beside them.
    await expect(canvas.queryByRole("heading", { name: "Prices", level: 2 })).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("heading", { name: "Hidden tags", level: 2 }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("heading", { name: "Clear data", level: 2 }),
    ).not.toBeInTheDocument();

    // What is still genuinely missing, at the foot of the rail rather than as a seventh entry:
    // a heading in a rail is a destination, and a destination with no panels behind it is a
    // place a reader can be sent to that draws nothing.
    await expect(rail.getByText("Import. Coming in a later plan.")).toBeInTheDocument();
  },
};

/**
 * A word instead of a category.
 *
 * `dropbox` is one of `Backup`'s keywords in `nav.ts` and appears in no other panel's, so this
 * is the rule the whole search exists for, driven end to end: a reader standing on `Updates`
 * types a word, and the panel that answers it is drawn from a group nobody selected. **No entry
 * is current while the box has words in it**, because the page is answering rather than the
 * group — and pressing an entry is what clears the box, which is why the two states can never
 * both apply.
 *
 * Keywords are the half of `nav.ts` a reader never sees, so this story is where they are visible
 * at all: the word typed here is in no heading on the page.
 */
export const Searching: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = within(canvas.getByRole("navigation", { name: "Settings" }));

    await userEvent.type(canvas.getByRole("searchbox", { name: "Search settings" }), "dropbox");

    await expect(
      await canvas.findByRole("heading", { name: "Backup", level: 2 }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "Updates", level: 2 })).not.toBeInTheDocument();
    await expect(rail.getByRole("button", { name: "Updates" })).not.toHaveAttribute("aria-current");

    // And back: the press clears the box, so the group answers again.
    await pickGroup(rail, "Updates");
    await expect(canvas.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    await expect(canvas.getByRole("heading", { name: "Updates", level: 2 })).toBeInTheDocument();
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
 *
 * `Prices` shares the `Card data` entry with `Combos`, so the play opens that group first —
 * both are optional bulk feeds from a third party that the app works entirely without, which is
 * the same argument that used to put them next to each other on the scroll.
 */
export const SwitchingMarketplace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await pickGroup(canvas, "Card data");

    // The setting an install starts on, read through the real hook rather than passed in. It
    // used to be `Default`'s last assertion, and it moved here with the panel.
    await expect(await canvas.findByRole("button", { name: "TCGplayer USD" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

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
 * Nothing else on the page moves, which is the point of storying it beside {@link Default} — and
 * it needs no press, because `Updates` is the group this page opens on.
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
 * **It is also the one place the rail's second badge is worth looking at.** The count on the
 * `Errors` entry is `log.entries.length` — the same hook the panel reads, held on the page for
 * exactly this reason, and drawn while the group is unselected. So the entry is pressed *after*
 * the badge is read, which is the order a reader meets them in.
 *
 * `Settings/ErrorLogPanel` stories the same three rows as arguments; this is the page they
 * arrive on, in the group they arrive in, under an entry that says how many there are.
 */
export const SomethingFailed: Story = {
  parameters: { fake: { fault: "errorLog" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = within(canvas.getByRole("navigation", { name: "Settings" }));

    // The badge, before the group is opened — which is the whole reason the hook is on the page
    // rather than inside the panel.
    const entry = await rail.findByRole("button", { name: /^Errors/ });
    await waitFor(async () => {
      await expect(entry).toHaveAccessibleName(/Errors \(\d/);
    });

    await pickGroup(rail, "Errors");
    await expect(await canvas.findByText("×617")).toBeInTheDocument();
    // The panel's own heading — the section named by its own heading rather than by the entry
    // that led here.
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
 * `Clear data` has **no rail entry of its own** and sits at the foot of `Storage and data`, so
 * the play opens that group: the three clears empty the part of the app the data folder holds,
 * and an entry naming them would have put "delete my collection" one press from every visit to
 * Settings. The distance stays inside the pane, where it has always been.
 *
 * The dialog is a modal over the whole window rather than a child of the story's box, so it is
 * reached through `document.body`.
 */
export const ClearingTheCollection: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await pickGroup(canvas, "Storage and data");

    await userEvent.click(await canvas.findByRole("button", { name: "Clear collection" }));
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
 *
 * Same group as the three clears, and that is the ordering rule surviving the regrouping: within
 * `Storage and data` the cache sits above them, because it throws away bytes the app fetches
 * again and they throw away what a reader owns.
 */
export const ClearingTheCache: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await pickGroup(canvas, "Storage and data");

    await userEvent.click(await canvas.findByRole("button", { name: "Clear cache" }));
    const dialog = await page.findByRole("dialog");

    await expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear cache" }));

    await waitFor(async () => {
      await expect(canvas.getByText(/^Freed /)).toBeInTheDocument();
    });
  },
};
