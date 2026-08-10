import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { UpdateStatus } from "@/lib/ipc";
import { nextAction, type Update } from "@/lib/useUpdate";
import { pickAsset } from "../../../.storybook/fake/db";
import { CURRENT_VERSION, NEXT_VERSION, release } from "../../../.storybook/fake/fixtures";
import { UpdatePanel } from "./UpdatePanel";

/**
 * When the check the panel reports happened.
 *
 * **Two hours before whenever this is read**, not a fixed instant, and that is forced rather
 * than chosen: `formatChecked` is relative for the first week and becomes a date after it
 * (`useUpdate.ts:42`), so a constant would render "Checked 2 hours ago" on the day it was
 * written and "Checked on 2026-08-09" for every day after — a story whose subject silently
 * changes. Two hours is far enough from the minute boundaries to round to exactly one thing.
 *
 * The fake world's own `lastCheckAt` is the opposite choice (`db.ts`'s `CLOCK_BASE`, a fixed
 * instant) because a *world* has to be deterministic across every other number it answers.
 * Neither file may assert this line's wording; `useUpdate.test.ts` is where that is pinned.
 */
const TWO_HOURS_AGO = String(Math.round(Date.now() / 1000) - 2 * 3600);

/**
 * One `update_status` answer, of the shape `update::status` returns.
 *
 * **`asset` is picked, never named.** `update::pick_asset` matches the tail of an asset name
 * against this install kind's suffix, and the fake re-implements exactly that
 * (`.storybook/fake/db.ts`'s `pickAsset`) — so a story that wrote `assets[0]` would be
 * asserting the order of an array GitHub decides, and `CannotUpdateItself` would have had to
 * hand-null the field that the *rule* is about.
 *
 * The release itself is `.storybook/fake/fixtures`' one, which is also what a seeded world
 * serves. Two copies would let this page and `Chrome/AppShell` disagree about what a release
 * looks like, which is the exact drift this panel is here to render.
 */
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  const available = release(NEXT_VERSION);
  const installKind = over.installKind ?? "portable";
  return {
    currentVersion: CURRENT_VERSION,
    installKind,
    available,
    asset: pickAsset(available.assets, installKind),
    lastCheckAt: TWO_HOURS_AGO,
    busy: false,
    staged: false,
    ...over,
  };
}

/** An install with nothing to offer: checked, and the newest release is what is running. */
function nothingNew(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return status({ available: null, asset: null, ...over });
}

/**
 * What `useUpdate` hands the panel, with **`action` derived rather than declared**.
 *
 * `nextAction` is the app's own function and it is the whole state machine: no release is
 * `none`, a staged build is `install`, a release with an asset is `download`, and a release
 * without one is `unavailable`. A story that typed the action beside the status could stage a
 * pair the hook cannot produce — a "Restart to finish" button over a status nothing has been
 * downloaded for — and the panel would render it, faithfully, forever.
 *
 * Overridable all the same, because one story is *about* a combination `nextAction` has no
 * opinion on: {@link Downloading}, where the action is still `download` and `busy` is what
 * changed.
 */
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
  title: "Settings/UpdatePanel",
  component: UpdatePanel,
  tags: ["autodocs"],
  args: { update: update() },
  decorators: [
    // The column `SettingsPage` puts it in: `mx-auto max-w-2xl` is 42rem, and the panel is a
    // block inside it. Narrower and the header's `flex-wrap` would fold, which is a state of
    // the container rather than of the update.
    (Story) => (
      <div className="w-[42rem] p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Everything about the app's own version, in the one place a reader goes looking " +
          "for it.\n\n" +
          "**Every state here is an argument, not a world.** The panel subscribes to nothing " +
          "and polls nothing: `App.tsx` calls `useUpdate` once and hands the answer to both " +
          "the ribbon and this page, because two calls would be two `update:progress` " +
          "listeners racing to describe one download. So a story here chooses an " +
          "`UpdateStatus` and the hook's derived `action`, and `Chrome/AppShell` is where a " +
          "seeded world drives the same thing end to end.\n\n" +
          "**The button label *is* the state machine**, and that is the whole of the design " +
          "the two-step flow settled on. `Download 6.5 MB` produces a bar; only once the " +
          "bytes are on disk and verified against the release's checksum does it become " +
          "`Restart to finish`. Nothing restarts the app until that second, deliberate " +
          "press.\n\n" +
          "The panel is deliberately quiet. The visual direction spends its boldness budget " +
          "on the mana line, so this is `bg-surface` and border grey like every other panel " +
          "— the only gold on it is the primary button and the focus ring, which is what " +
          "gold already means everywhere else in this window.\n\n" +
          "**Two states below are not failures and read like them.** `unavailable` is the " +
          "honest answer for an MSI install or a Linux build, where a release exists and " +
          "nothing in this window can install it; and “Checking for updates…” is what an " +
          "install that has never asked says, because `available: null` means *both* “up to " +
          "date” and “never looked” and only `lastCheckAt` tells them apart.",
      },
    },
  },
} satisfies Meta<typeof UpdatePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The answer almost every reader gets: a version, when it was last checked, and a way to
 * check again.
 *
 * `available: null` here is a *derived* answer rather than an absent row. `update::check`
 * caches whatever GitHub returned whether or not it is newer, and `update::status`
 * re-compares it against the running build on every read — which is what makes the notice
 * clear itself after an update lands, with no bookkeeping step to forget.
 */
export const UpToDate: Story = {
  args: { update: update({ status: nothingNew() }) },
};

/**
 * An install that has never asked — and does **not** claim to be up to date.
 *
 * "You're on the latest version" is a claim, and before the first check has answered the app
 * has not earned it. `available` is `null` in both states and `lastCheckAt` is the only thing
 * that tells them apart, which makes this the one story on the page whose subject is an
 * absence: the sentence that is *not* there.
 *
 * Reachable from a seeded world too — `.storybook/fake/seeds.ts`'s `empty` is a first run, and
 * a window that has synced nothing has checked nothing either.
 */
export const NeverChecked: Story = {
  args: { update: update({ status: nothingNew({ lastCheckAt: null }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Checking for updates…")).toBeInTheDocument();
    await expect(canvas.queryByText(/latest version/)).toBeNull();
    await expect(canvas.getByText("Not checked yet")).toBeInTheDocument();
  },
};

/**
 * A newer release, its notes, and one sized button.
 *
 * The size is on the label rather than beside it, because "Download" and "6.5 MB" are one
 * decision: a reader on a metered connection is answering *that* question, not two.
 *
 * **The notes are shown as written and never interpreted.** This app has no markdown
 * renderer, and half-rendered markdown reads worse than none — so the release body's `###`
 * stays a `###`, in a capped scroller because a release body has no length limit and this
 * panel does. That is a claim about what is *absent* from the DOM, so it is asserted.
 */
export const Available: Story = {
  args: { update: update() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Download 6.5 MB" })).toBeEnabled();
    await expect(canvas.getByText(/### Features/)).toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "Features" })).toBeNull();
  },
};

/**
 * Bytes arriving, in the same idiom a sync uses.
 *
 * An `h-1` `bg-surface` track with a gold fill — deliberately `SyncProgress`' bar rather than
 * a second progress language for a second kind of download. A reader who has watched a sync
 * should not have to learn this one.
 *
 * `action` is still `download`; what changed is `busy`, which is why this is the one story
 * that sets the two independently. The button says so twice, and only one of the two is
 * visible: it is disabled *and* `aria-busy`, which is the half a screen reader gets.
 *
 * **Not reachable from a seeded world**, and that is `.storybook/fake/db.ts`'s
 * `update_download` saying so in its own doc: every handler there is synchronous, so
 * `update_status` answers `busy: false` always and the promise settles before a frame can be
 * painted. This is where the bar lives.
 */
export const Downloading: Story = {
  args: {
    update: update({ busy: true, progress: { done: 3_226_956, total: 6_453_913 } }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole("progressbar", { name: "Downloading the update" });
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    const button = canvas.getByRole("button", { name: "Downloading…" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
  },
};

/**
 * The same download with no size to measure it against.
 *
 * A chunked response makes no `Content-Length` claim, and `aria-valuenow="0"` would be this
 * panel claiming no progress had been made. The attribute is **omitted** instead and the fill
 * pulses at full width — which respects `prefers-reduced-motion`, because an indeterminate bar
 * is decoration and the direction's motion budget is spent elsewhere.
 *
 * The subject is an attribute that is not there, so the assertion is the story.
 */
export const SizeUnknown: Story = {
  args: { update: update({ busy: true, progress: { done: 1_200_000, total: 0 } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    // The bytes that *are* known are still counted, which is why the line under the bar is
    // two figures rather than a percentage.
    await expect(canvas.getByText("1.2 MB of 0.0 MB")).toBeInTheDocument();
  },
};

/**
 * Verified, on disk, and one restart away.
 *
 * The second half of the two-step flow: downloading changed nothing about the running app —
 * it resolved with the window still open and one more file beside the exe — and this is the
 * separate, deliberate press that swaps it in.
 *
 * The sentence under the button is what that press costs, said *before* it rather than after.
 * "Nothing in your collection is touched" is the question a reader actually has, and it is
 * true for the reason the portable build exists: `data/` sits beside the exe and the swap is
 * two renames of the exe alone.
 */
export const Staged: Story = {
  args: { update: update({ status: status({ staged: true }) }) },
};

/**
 * An MSI install, or any Linux build — a release it can see and cannot install.
 *
 * `pick_asset` matches on the tail of an asset name and answers nothing at all for
 * `installKind: "other"`, which is what makes the action `unavailable`. Not an error: the
 * news is still delivered, because a reader should know a new version exists, and the
 * sentence says what to do and what happens to their collection.
 *
 * **Two controls collapse into one here**, which is the claim worth asserting because it is
 * an absence twice over: there is no Download, and the secondary "View on GitHub" is gone as
 * well — the primary button *is* the release page, and two buttons to the same URL would be
 * the interface hedging.
 */
export const CannotUpdateItself: Story = {
  args: { update: update({ status: status({ installKind: "other" }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/is available/)).toHaveTextContent("0.4.0 is available");
    await expect(canvas.queryByRole("button", { name: /^Download/ })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "View on GitHub" })).toBeNull();
    await expect(
      canvas.getAllByRole("button", { name: "Open the release page" }),
    ).toHaveLength(1);
  },
};

/**
 * This session's failure, said where it happened.
 *
 * The sentence is `update::check`'s 403/429 branch verbatim — the failure a reader is most
 * likely to meet, because unauthenticated `api.github.com` allows 60 requests an hour per IP
 * and shares that budget with everything else on the machine. `update.error` carries whichever
 * of the four actions failed, so this one alert is also where a refused download or a rolled
 * back install lands.
 *
 * A `role="alert"` **inside the panel** rather than the shell's error banner: that banner is
 * the sync's, and one live region owned by two features is one sentence overwriting another.
 * The controls beside it stay usable, because a failure here is a thing to try again — and
 * `useUpdate` clears the error on the next action that gets anywhere rather than on a timer.
 */
export const Failed: Story = {
  args: {
    update: update({
      error: "GitHub is rate limiting update checks right now. Try again later.",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(/rate limiting update checks/);
    await expect(canvas.getByRole("button", { name: /^Download/ })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Check now" })).toBeEnabled();
  },
};
