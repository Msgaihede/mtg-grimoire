import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ArchiveBackupPanel } from "./BackupPanel";

const meta = {
  title: "Settings/BackupArchivePanel",
  component: ArchiveBackupPanel,
  tags: ["autodocs"],
  decorators: [
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
          "The Backup panel as **web and Android** get it: one archive you ask for, rather " +
          "than a folder kept up to date in the background.\n\n" +
          "**It is drawn here because it can be drawn nowhere else.** `BackupPanel` chooses " +
          "between this and the folder from `isWebTarget()` and `isAndroid()` — a build-time " +
          "constant and a user-agent read — and the workbench is neither, so the panel a " +
          "reviewer would otherwise never see is exported and mounted directly. Everything " +
          "below the dispatch is the shipped component.\n\n" +
          "**Why a snapshot and not a folder.** The mirror writes ~350 files so that *other " +
          "programs* can read them — a text editor, `grep`, a sync client. OPFS is invisible " +
          "to every program but this one, and an Android app's private directory is the same " +
          "in practice: `tauri-plugin-dialog`'s manifest records Android as having no folder " +
          "picker at all, so the root could not even be chosen. A folder nothing else can open " +
          "would be the feature's name without the feature.\n\n" +
          "**Two doors behind one button.** In a browser the archive comes back as base64 and " +
          "the page starts a download; on Android the reader names the destination first — a " +
          "`content://` row `ACTION_CREATE_DOCUMENT` has already made, not a path — and Rust " +
          "writes into it, so a megabyte of archive never crosses the webview. The workbench " +
          "runs a desktop browser, so it always shows the first.\n\n" +
          "**The fake has no zip and does not pretend to.** `mirror_backup_zip` counts the " +
          "files a pass would write and hands back a real, *empty* archive — pressing the " +
          "button here really does save a file, and that file really does open, holding " +
          "nothing.",
      },
    },
  },
} satisfies Meta<typeof ArchiveBackupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Before the press: what the panel says when no archive has been made this session.
 *
 * **The three absences are the story.** There is no switch, because there is nothing running to
 * switch off; no folder, because there is none to name; and no "last written" line, because
 * `mirror_status` describes a thread that does not exist here and is not even routed on the web
 * target. What is left is one sentence about what this is and one button.
 *
 * The play deliberately does **not** press it. A click here would reach `URL.createObjectURL`,
 * which jsdom does not implement — so the assertion the suite can make honestly is about what is
 * on screen, and the download itself is a thing to try in a real browser.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await expect(panel.getByRole("button", { name: /Download backup/ })).toBeEnabled();
    // The folder's three controls, absent — this is the whole of the platform decision, and it
    // is the kind of thing that reads as fine until somebody restores one of them.
    expect(panel.queryByRole("button", { name: /Change folder/ })).toBeNull();
    expect(panel.queryByRole("button", { name: /Rebuild now/ })).toBeNull();
    expect(panel.queryByRole("switch")).toBeNull();
    await expect(panel.getByText(/one archive you ask for/)).toBeInTheDocument();
  },
};
