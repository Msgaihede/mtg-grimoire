import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { SyncStatus } from "@/lib/ipc";
import { statusLine } from "@/lib/useSync";
import { Ribbon } from "./Ribbon";

/**
 * One `sync_status` answer, of the shape `sync::status` returns.
 *
 * Here so the stories below can run it through the app's **own** `statusLine` rather than typing
 * its output. That line drops what it does not have — a count it could not read, a bulk file
 * that has never been dated — and a hand-written `"116,590 cards · data from 2026-08-08"` in a
 * story arg would be a claim about a formatter that nothing checks.
 */
function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    // The corpus as CLAUDE.md last recorded it (measured 2026-08-06); the exact figure is not
    // load-bearing here, only that it is six digits and gets a thousands separator.
    cardCount: 116_590,
    lastCheckAt: "1786266000",
    bulkUpdatedAt: "2026-08-08T21:16:00.000Z",
    lastError: null,
    lastIngestSkipped: 0,
    dataDir: "D:\\MTG Grimoire\\data",
    syncing: false,
    imageStoreFailures: 0,
    ...over,
  };
}

/** The idle line, computed once so a story's arg and a story's assertion cannot disagree. */
const IDLE_LINE = statusLine(status()) ?? "";

const meta = {
  title: "Chrome/Ribbon",
  component: Ribbon,
  tags: ["autodocs"],
  args: {
    title: "Search",
    statusLine: IDLE_LINE,
    dataDir: status().dataDir,
    busy: false,
    upToDate: false,
    hasError: false,
    onRefresh: fn(),
    sync: null,
  },
  decorators: [
    // The ribbon is `shrink-0` inside a flex column and stretches to whatever it is given, so a
    // story needs a width to be a row rather than a stack. 1072px is the window's 1280 less the
    // `w-52` sidebar it sits beside (`AppShell.tsx:92`) — this one is *not* inside `main`, so
    // unlike the filter rows it keeps the `p-5` those lose.
    (Story) => (
      <div className="w-[1072px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The global ribbon: one 48px row owning every action that is not about the view " +
          "below it. Refresh and the sync status used to live in a per-view header, which made " +
          "them look like properties of whatever was on screen; they are properties of the " +
          "*app*, so they live in one place that never changes.\n\n" +
          "**Every state here is an argument, not a world.** This component subscribes to " +
          "nothing and polls nothing — `AppShell` owns the one `sync_status` poll and the one " +
          "`sync:progress` listener and hands the answers down — so a story that emitted a " +
          "sync event at it would be emitting into a component that is not listening. What a " +
          "seeded backend *can* drive is `AppShell`, and `Chrome/AppShell` is where that is " +
          "shown.\n\n" +
          "The mana line below the row is `ManaLine`, and its own states — determinate fill, " +
          "indeterminate sweep, reduced motion — are storied at `Primitives/ManaLine`. What " +
          "these stories add is how the row and the line agree: the icon never spins, because " +
          "the direction's whole motion budget for a sync is spent on that 2px rule.",
      },
    },
  },
} satisfies Meta<typeof Ribbon>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing running: a wordmark, the view's name, what is in the database, and Refresh.
 *
 * `MTG` is the mark rather than the product name — the window title bar already says that in
 * full, and 48px of vertical space is not where a five-word name earns its keep. It is dim
 * rather than gold, because gold means "you can act on this, or this is where you are", and a
 * wordmark is neither.
 *
 * The status line is the real `statusLine` over a real `SyncStatus`, so the separator, the
 * thousands comma and the date's truncation to `YYYY-MM-DD` are the app's and not this file's.
 */
export const Idle: Story = {};

/**
 * A sync in flight, reported three ways and animated once.
 *
 * The icon does **not** spin: the mana line two pixels below is the app's one sync animation.
 * The button says it instead by going disabled, and by `aria-busy` — which is the half of that
 * pair no screenshot shows, and the half a screen reader gets.
 *
 * `value: 0.5` with the label "Importing cards" is the ingest at half way, which is the phase a
 * sync spends most of its ~93 s in (CLAUDE.md, measured 2026-08-06).
 */
export const Syncing: Story = {
  args: { busy: true, sync: { value: 0.5, label: "Importing cards" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const refresh = canvas.getByRole("button", { name: "Refresh data" });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    // The line is named after the phase — an unnamed progress bar is announced as an anonymous
    // percentage, and the phase is the only thing that says what is being measured.
    await expect(canvas.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  },
};

/**
 * The answer most Refreshes get, and the one case where saying nothing would look like failing.
 *
 * A run inside the 24 h window, or one whose ETag comes back 304, downloads nothing and ingests
 * nothing — so without a word the button simply spins and stops. It is a `role="status"` so the
 * sentence is announced, and it is transient: `useSync` takes it down after `UP_TO_DATE_MS`,
 * because it is an answer to one click and not a state of the app.
 */
export const AlreadyUpToDate: Story = {
  args: { upToDate: true },
};

/**
 * The same Refresh, with an error banner showing underneath — and the cheerful line gone.
 *
 * **This is the whole of what `hasError` does.** The ribbon draws no banner of its own; the
 * banner is `AppShell`'s `role="alert"` (`AppShell.tsx:134-142`) and this prop only tells the
 * row to stay out of its way. Both flags are on here, which is the combination that would
 * otherwise put "Already up to date" beside a red sentence saying the opposite.
 *
 * The claim is an absence, so it is asserted rather than looked at.
 */
export const ErrorShowingBelow: Story = {
  args: { upToDate: true, hasError: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Already up to date")).toBeNull();
    // Still perfectly usable: the error is somebody else's to draw, and Refresh is how the
    // reader answers it.
    await expect(canvas.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  },
};

/**
 * First launch, before any sync has finished: the ribbon behind the first-run overlay.
 *
 * `statusLine` answers `"No card data yet"` for a `cardCount` of exactly `0` and never a bare
 * zero, which would read as "your collection is empty" in a row that is talking about the card
 * *database*. `bulkUpdatedAt` is null too — nothing has been ingested to be dated — and the line
 * drops it rather than printing half a sentence.
 *
 * In the app this is mostly hidden: `SyncProgress` covers the whole window while `cardCount` is
 * 0, Refresh button and all, which is why that overlay carries a Retry of its own.
 */
export const FirstRun: Story = {
  args: {
    statusLine: statusLine(status({ cardCount: 0, bulkUpdatedAt: null })),
    title: "Search",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("No card data yet")).toBeInTheDocument();
  },
};

/**
 * A newer version of the app, and the only control on this row that is not about the card
 * database.
 *
 * It sits **before** the status line and Refresh because it is the rarer and more
 * consequential thing on the row, and it is gold where every other control is border grey —
 * the app's existing word for "you can act on this" rather than a colour invented for one
 * button. The boldness budget is spent on the mana line two pixels below; this borrows a token
 * that line already has.
 *
 * Pressing it updates nothing. `onOpenUpdate` opens Settings, where the release notes and the
 * actual controls are, and the label is what that promises: an install that can replace
 * itself is offered the verb. `Settings/UpdatePanel` is the panel it opens, and
 * `Chrome/AppShell` is the same button driven by a seeded world, where the press really does
 * change the view.
 *
 * The handler is a `fn()` and the press is the claim, which is a thing no screenshot shows.
 */
export const UpdateAvailable: Story = {
  args: { updateVersion: "0.4.0", updateInstallable: true, onOpenUpdate: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Update to 0.4.0" }));
    await expect(args.onOpenUpdate).toHaveBeenCalledOnce();
    // Refresh is untouched beside it: two independent things the app can be doing, and a new
    // release says nothing about the card data.
    await expect(canvas.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  },
};

/**
 * The same news to an install that cannot act on it — an MSI, or any Linux build.
 *
 * **Two labels, because they are two different promises.** `update::pick_asset` answers
 * nothing for `InstallKind::Other`, so there is no in-app path from here to a new version; a
 * button reading "Update to 0.4.0" on one of those would be the interface promising something
 * it cannot keep. It still says a version is out, because a reader should know.
 *
 * The absence of the other label is the claim, so it is asserted.
 */
export const UpdateNotInstallable: Story = {
  args: { updateVersion: "0.4.0", updateInstallable: false, onOpenUpdate: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "0.4.0 available" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Update to/ })).toBeNull();
  },
};

/**
 * Images that could not be cached — the one consumer of `images::Cache::store_failures`, said
 * in a tooltip and nowhere else.
 *
 * Not a banner, deliberately: every affected image still *displays*, because the bytes were in
 * hand when the write failed, so nothing on screen is broken and interrupting the reader would
 * overstate it. What is wrong is invisible without this — the cache never fills and every
 * revisit re-downloads — so it rides the tooltip that already names the folder it is about.
 *
 * A `title` is a thing no screenshot shows and no reader hovers by accident, so the assertion is
 * the story. The singular/plural is asserted in `Ribbon.test.tsx`; what is here is the join —
 * two sentences about one folder, in that order, separated by a newline.
 */
export const ImagesNotCached: Story = {
  args: { imageStoreFailures: 12 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(IDLE_LINE)).toHaveAttribute(
      "title",
      "D:\\MTG Grimoire\\data\n12 card images could not be saved to the cache — the data folder may be read-only or full.",
    );
  },
};
