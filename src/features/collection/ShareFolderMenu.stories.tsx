import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ShareFolderMenu, type ShareTarget } from "./ShareFolderMenu";

/**
 * The Share control from the collection's figures band — publish this level, or open somebody
 * else's binder.
 *
 * ## What the fake can and cannot answer, and why that is the story rather than a limitation
 *
 * **`sync_supporter_status` is faked and answers *not connected* by default**, which is the whole
 * of the first story below: a reader who has connected nothing gets no Share control at all
 * (sharing spec §9), and the entry point beside it stays, because viewing somebody else's binder
 * needs no membership, no account and no token. The membership is switched on with the
 * `patreonGroupEntitled` **fault** rather than a press — a device covered by *another* device's
 * pledge is decided at the far end of `/token` and there is no relay in this workbench, which is
 * `SyncPanel.stories.tsx`' own argument for the same fault.
 *
 * **`share_list` has no fake handler yet**, so the query rejects and `useShares()` reads as an
 * empty list. That is not a gap these stories work around — it *is* the state every reader is in
 * before their first publish, and it is the menu with one row in it. The published states
 * (*Copy link*, *Update now*, *Stale*, *Paused*, *Withdrawn*) are driven in
 * `ShareFolderMenu.test.tsx`, where the command is mocked directly; they arrive here when the
 * fake grows the command.
 *
 * The dialogs behind the two buttons are not opened by these plays: publishing reaches
 * `share_create`, which the fake does not answer either, and the paste box belongs to
 * `features/share`.
 */
const meta = {
  title: "Collection/Share control",
  component: ShareFolderMenu,
  tags: ["autodocs"],
  // The right-hand end of the figures band, which is where this sits and how wide it gets to be.
  decorators: [
    (Story: () => React.ReactElement) => (
      <div className="flex justify-end p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShareFolderMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole collection — `share_create`'s `null` `folderUid`, a destination rather than an
 *  omission. */
const COLLECTION: ShareTarget = { kind: "collection", title: "Collection" };
/** One drawer, named by the `sync_uid` a share is addressed by — never a row id, which means
 *  nothing on another device. */
const BINDER: ShareTarget = { kind: "folder", uid: "uid-binder", title: "Trade binder", locked: false };

/**
 * **A reader who has connected nothing: no Share control, and no nag either.**
 *
 * Hidden rather than greyed is spec §9 and `PinnedFolders`' rule underneath it — a control whose
 * only outcome is a sentence explaining that it does not work teaches a reader nothing its
 * absence would not have, and the Settings sync panel is where the connection story already
 * lives. What stays is the other half, because opening somebody else's binder is open to
 * everyone.
 */
export const NothingConnected: Story = {
  args: { target: COLLECTION },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: "Open a shared collection" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument();
  },
};

/**
 * **The root of the cabinet, on a device the group's membership covers.**
 *
 * The menu has one row because nothing is published yet, and that row names *what* it would
 * publish — the whole collection here, one drawer in the story below — because those are two very
 * different presses and the button they come from says only *Share*.
 */
export const ShareTheWholeCollection: Story = {
  args: { target: COLLECTION },
  parameters: { fake: { fault: "patreonGroupEntitled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Share your collection" }));
    // The menu is drawn at the app root rather than inside this canvas, so it is found on the
    // document rather than through `within`.
    await expect(
      await within(document.body).findByRole("menuitem", { name: /Share your collection/ }),
    ).toBeInTheDocument();
  },
};

/** One drawer, named — the case the whole `sync_uid` field exists for. */
export const ShareOneDrawer: Story = {
  args: { target: BINDER },
  parameters: { fake: { fault: "patreonGroupEntitled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Share Trade binder" }));
    await expect(
      await within(document.body).findByRole("menuitem", { name: /Share this folder/ }),
    ).toBeInTheDocument();
  },
};

/**
 * **A drawer the reader has set aside.** The row greys with its reason in the row's own
 * accessible name — the grammar the cabinet's `Delete…` already uses — because publishing a
 * locked drawer is the one thing a lock is for, and `share::snapshot` refuses it before it reads
 * rather than uploading an empty binder that reads to a stranger as *this person owns nothing*.
 *
 * The phrase and not the crate's whole sentence, because a menu row is as wide as its widest
 * content: one long reason sets the width of the entire panel.
 */
export const LockedDrawer: Story = {
  args: { target: { ...BINDER, locked: true } },
  parameters: { fake: { fault: "patreonGroupEntitled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Share Trade binder" }));
    const row = await within(document.body).findByRole("menuitem", { name: /Share this folder/ });
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).toHaveAccessibleName(/unlock it first/);
  },
};

/**
 * **A level with nothing to publish** — a deck group, `Recently removed`, or a drawer the folder
 * list named no `sync_uid` for. `shareTargetFor` answers `null` for all three and the Share half
 * simply is not there, exactly as no other folder write is offered on the app's own folders.
 */
export const NothingToShare: Story = {
  args: { target: null },
  parameters: { fake: { fault: "patreonGroupEntitled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: "Open a shared collection" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument();
  },
};
