import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { UpdateStatus } from "@/lib/ipc";
import { nextAction, type Update } from "@/lib/useUpdate";
import { pickAsset } from "../../../.storybook/fake/db";
import { CURRENT_VERSION, NEXT_VERSION, release } from "../../../.storybook/fake/fixtures";
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
          "Settings, which is one real section and an honest note about the rest.\n\n" +
          "**`update` is a prop, and that is the design rather than a convenience.** " +
          "`App.tsx` calls `useUpdate` once and hands the answer to both `AppShell` — for the " +
          "ribbon's gold button — and to this page, for the panel. Two calls would be two " +
          "`update:progress` listeners racing to describe one download, so the hook is owned " +
          "one level up and this page never reaches the backend at all.\n\n" +
          "That makes every story here an argument, exactly as `Chrome/Ribbon`'s are. " +
          "`Chrome/AppShell`'s `Settings` and `UpdateAvailable` are the same page driven by a " +
          "**seeded world** instead, through the real hook — which is where the ribbon button " +
          "and this panel are shown agreeing with each other.\n\n" +
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
    // Two labelled sections, each named by its own heading through `aria-labelledby` — which
    // is what makes them regions a screen reader can jump between rather than two `div`s.
    await expect(canvas.getByRole("heading", { name: "Updates", level: 2 })).toBeInTheDocument();
    await expect(
      canvas.getByRole("heading", { name: "Not here yet", level: 2 }),
    ).toBeInTheDocument();
    await expect(canvas.getByText(/You’re on the latest version\./)).toBeInTheDocument();
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
