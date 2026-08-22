import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { UpdateStatus } from "@/lib/ipc";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";
import { nextAction, type Update } from "@/lib/useUpdate";
import { pickAsset } from "../../../.storybook/fake/db";
import {
  CURRENT_VERSION,
  NEXT_VERSION,
  release,
  releaseHistory,
} from "../../../.storybook/fake/fixtures";
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

/**
 * What `useReleaseHistory` hands the panel.
 *
 * The releases are `.storybook/fake/fixtures`' — the same builder `db.ts` seeds a world's
 * cached page from, so a prop-driven story here and a world-driven one in `Chrome/AppShell`
 * cannot disagree about what a release body looks like. That is `release()`'s own argument,
 * applied to the list.
 */
function history(over: Partial<ReleaseHistory> = {}): ReleaseHistory {
  return { releases: releaseHistory(), loading: false, error: null, ...over };
}

const meta = {
  title: "Settings/UpdatePanel",
  component: UpdatePanel,
  tags: ["autodocs"],
  args: { update: update(), history: history() },
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
          "— the gold on it is the primary button, the focus ring and the mark beside the " +
          "version, which is what gold already means everywhere else in this window plus one " +
          "thing that is not an affordance at all.\n\n" +
          "**The mark is drawn in every state below, because it is a fact about the panel " +
          "rather than about the update.** It is 36px — the height of the two lines it " +
          "stands beside, `text-sm` over `text-xs` — and that is comfortably over the 24px " +
          "`GrimoireMark` needs before it draws the full artwork rather than the simplified " +
          "one, so the casting circle, the runes and the clasp rivets are all here. A settings " +
          "page is where that detail is affordable. It is `aria-hidden`: the sentence beside " +
          "it already sets *MTG Grimoire* in type, and a named mark would announce the " +
          "product name twice in a row.\n\n" +
          "**Two states below are not failures and read like them.** `unavailable` is the " +
          "honest answer for an MSI install or a Linux build, where a release exists and " +
          "nothing in this window can install it; and “Checking for updates…” is what an " +
          "install that has never asked says, because `available: null` means *both* “up to " +
          "date” and “never looked” and only `lastCheckAt` tells them apart.\n\n" +
          "**The version history under it is one page of `/releases`, cached.** The same " +
          "single request that decides whether an update exists carries the whole page, so " +
          "`update_history` reads a row and never the network — expanding a release costs " +
          "nothing out of GitHub's 60 requests an hour. Every row starts closed: a reader " +
          "opens Settings to check their version, and thirty unrolled bodies would bury the " +
          "line that answers them.",
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/latest version/)).toBeInTheDocument();

    // **The mark is asserted in this play and in no other, and that is a decision rather than
    // an omission.** It is drawn unconditionally, so every story on this page shows it; a copy
    // of this check in each would be one claim written N times, and N places to edit the day
    // the mark moves. This is the story to hold it because this is the state the panel is in
    // almost every time it is opened — a mark, a version, and nothing to do.
    //
    // Found by the gradient rather than by the `viewBox` that names the artwork, and the query
    // is `UpdatePanel.test.tsx`'s in one shape on purpose: jsdom's selector engine lowercases an
    // attribute name whatever namespace the element is in, so `svg[viewBox='0 0 64 64']` matches
    // here and matches nothing there — two queries for one mark is how the two ends of a claim
    // drift. The gradient is the better subject anyway. It is in the `<defs>` of the full
    // variant alone, so finding one is the proof that 36 cleared the component's 24px detail
    // floor and this is the casting circle rather than the simplified mark.
    const mark = canvasElement.querySelector("linearGradient")?.closest("svg");
    await expect(mark).toHaveAttribute("width", "36");
    // Hidden, because the words beside it are what carry the name.
    await expect(mark).toHaveAttribute("aria-hidden", "true");
    await expect(canvas.getByText(/MTG Grimoire/)).toBeInTheDocument();
  },
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
 *
 * **The history is empty here for the same reason and not by coincidence**: the page it lists
 * is written by the check, so an install that has never checked has nothing cached to show.
 * The sentence says that rather than drawing an app with no past, and the way out of it is the
 * button at the top of the panel.
 */
export const NeverChecked: Story = {
  args: {
    update: update({ status: nothingNew({ lastCheckAt: null }) }),
    history: history({ releases: [] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Checking for updates…")).toBeInTheDocument();
    await expect(canvas.queryByText(/latest version/)).toBeNull();
    await expect(canvas.getByText("Not checked yet")).toBeInTheDocument();
    await expect(canvas.getByText(/No releases have been read yet/)).toBeInTheDocument();
  },
};

/**
 * A newer release, its notes, and one sized button.
 *
 * The size is on the label rather than beside it, because "Download" and "6.5 MB" are one
 * decision: a reader on a metered connection is answering *that* question, not two.
 *
 * **The notes are drawn, and the old claim here was the opposite one.** This panel used to
 * print a release body verbatim in a `<pre>` on the argument that half-rendered markdown reads
 * worse than none — true while there was no reader for it. `src/lib/releaseNotes.ts` is one,
 * and it answers that argument rather than abandoning it: a line it has no rule for becomes a
 * paragraph and is drawn as written, so the worst case is exactly what the `<pre>` gave.
 *
 * Three display decisions are visible in this one body, and each was asked for. The **version
 * heading** the body opens with is dropped, because the line above already says `0.4.0` and the
 * date. The **commit trailer** is stripped — a reader of a desktop changelog can do nothing with
 * a SHA. And the **repeated bullet** collapses: the fixture carries the same message twice under
 * two SHAs, which is what release-please writes when one commit lands on two branches, and it is
 * the thing the bug report was actually about.
 *
 * Still a capped scroller, because a release body has no length limit and this panel does.
 */
export const Available: Story = {
  args: { update: update() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Download 6.5 MB" })).toBeEnabled();

    // Rendered, not printed — the inverse of what this story used to assert.
    await expect(canvas.queryByText(/### Features/)).toBeNull();
    await expect(canvas.getByText("Features")).toBeInTheDocument();
    // The fixture's two identical Features bullets are one row, and no SHA survives.
    await expect(canvas.getByText(/the update panel you are reading/)).toBeInTheDocument();
    await expect(canvas.queryByText(/23d15d5/)).toBeNull();
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
/**
 * The version history, with one release opened.
 *
 * **Every row starts closed**, which is what the panel is for: a reader opens Settings to
 * check which version they are on, and thirty release bodies unrolled underneath that would
 * bury the line that answers them. So the list is versions and dates — the whole history
 * legible at a glance — and a body appears only where one is asked for.
 *
 * The list reaches **past the running build in both directions**, and that is faithful rather
 * than convenient: `update::check` caches the whole page it fetched and concludes nothing
 * about which entries the reader has already passed, so `0.4.0` is here as well as the
 * versions behind. The one marked `installed` is the running build, matched on
 * `status.currentVersion`.
 *
 * The oldest fixture release publishes an **empty body**, which is a real thing a release can
 * do — `ReleaseNotes` has a sentence of its own for it rather than an empty box that reads as
 * a failure to load.
 */
export const HistoryOpened: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const row = canvas.getByRole("button", { name: new RegExp(CURRENT_VERSION) });
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getByText("installed")).toBeInTheDocument();

    await userEvent.click(row);
    await expect(row).toHaveAttribute("aria-expanded", "true");
    // Scoped to this row's own `<li>`, and not because the query was ambiguous by accident:
    // the release on offer above draws the *same* fixture body, so a canvas-wide query for a
    // bullet would pass whether or not the row ever opened.
    //
    // **Presence, not visibility, and the difference cost a CI run.** `statusLine`'s `initial`
    // is `{ height: 0, opacity: 0 }`, and `toBeVisible()` reads that opacity — so an assertion
    // made before `motion` has painted its second frame fails on an element that is in the
    // document and about to be seen. `findBy*` waits for the node to *exist*, which is not the
    // same wait, so it does not close the gap: this passed twice locally and failed on CI's
    // slower box with `Received element is not visible: <span />`. What the story claims is
    // that opening this row drew this row's own notes, and presence inside its `<li>` is
    // exactly that claim — an in-flight animation's opacity is not the subject.
    const entry = within(row.closest("li") as HTMLElement);
    await expect(
      await entry.findByText(/count a foil wish against foils only/),
    ).toBeInTheDocument();
  },
};

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
