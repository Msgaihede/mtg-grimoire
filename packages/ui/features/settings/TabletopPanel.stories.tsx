import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TabletopPanel } from "./TabletopPanel";

const meta = {
  title: "Settings/TabletopPanel",
  component: TabletopPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's width, `BackupPanel.stories.tsx`' reason: the layout risk is a path.
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
          "The Tabletop Simulator integration (issue #1038), the one panel under Settings → " +
          "Integrations, desktop only. Every deck is written as a Tabletop Simulator save into " +
          "an `MTG Grimoire` folder in TTS's `Saves`, a few seconds after each change — the " +
          "plain-text mirror's background thread, one program over, and drawn in the Backup " +
          "panel's shape.\n\n" +
          "**Off by default**: it writes into another program's folder. Switching it off keeps " +
          "every save already written.\n\n" +
          "**The workbench has no filesystem.** `tabletop_rebuild` counts the saves a pass would " +
          "write — one per deck, two for a deck with a theory list — and stamps the time; press it " +
          "twice and the answer turns from *written* to *unchanged*. Change folder… refuses as " +
          "the picker, because there is none in Storybook.",
      },
    },
  },
} satisfies Meta<typeof TabletopPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh install: off, Tabletop Simulator's folder where it makes it, and no pass claimed. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const toggle = await canvas.findByRole("switch", { name: /tabletop simulator/i });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(canvas.getByText("Not run yet.")).toBeInTheDocument();
    await expect(canvas.getByText(/MTG Grimoire$/)).toBeInTheDocument();
  },
};

/** The switch, thrown on — it goes all the way down to the fake's `app_meta` row and back. */
export const SwitchedOn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("switch", { name: /tabletop simulator/i }));

    await waitFor(async () => {
      await expect(canvas.getByRole("switch", { name: /tabletop simulator/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
  },
};

/**
 * Store card images on this computer: disabled while the integration is off, and usable once it
 * is on — both presses go down to the fake's `app_meta` rows.
 */
export const LocalImages: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const images = () => canvas.getByRole("switch", { name: /store card images/i });

    await canvas.findByRole("switch", { name: /store card images/i });
    await expect(images()).toBeDisabled();

    await userEvent.click(canvas.getByRole("switch", { name: /tabletop simulator/i }));
    await waitFor(async () => {
      await expect(images()).toBeEnabled();
    });

    await userEvent.click(images());
    await waitFor(async () => {
      await expect(images()).toHaveAttribute("aria-checked", "true");
    });
  },
};

/** Rebuild now, pressed twice — written, then unchanged. */
export const Rebuilt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Rebuild now/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /^Rebuilt — \d+ files? written, 0 unchanged\.$/,
    );
    await expect(await canvas.findByText(/Last updated just now/)).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /Rebuild now/ }));
    await waitFor(async () => {
      await expect(canvas.getByRole("alert")).toHaveTextContent(
        /^Rebuilt — 0 files written, \d+ unchanged\.$/,
      );
    });
  },
};

/**
 * Tabletop Simulator not installed, or its saves kept elsewhere — the `tabletopSavesMissing`
 * fault. Not an alarm: a plain note that names the folder looked in and points at Change folder…,
 * and Rebuild now refuses in the pass's own words, because a pass never makes TTS's own folder.
 */
export const SavesNotFound: Story = {
  parameters: { fake: { fault: "tabletopSavesMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/saves folder wasn't found at/)).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /Rebuild now/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /saves folder was not found at/,
    );
  },
};

/** Change folder…, pressed — the one control a browser cannot work. */
export const PickerUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Change folder/ }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /The folder picker could not be opened/,
    );
    await expect(canvas.getByText(/MTG Grimoire$/)).toBeInTheDocument();
  },
};
