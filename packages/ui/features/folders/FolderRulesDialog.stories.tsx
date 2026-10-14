import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import type { FolderRule } from "@/lib/ipc";
import type { InheritedRules } from "@/lib/folderRules";
import { FolderRulesDialog } from "./FolderRulesDialog";

/**
 * Where a folder's rules are written (issue #980) — `Folder options → Rules…` on a collection or
 * wishlist folder. Each own rule is a row with a kind-specific editor; inherited rules are listed
 * read-only under the folder they come from. Save writes the whole list.
 */
const meta = {
  title: "Folders/FolderRulesDialog",
  component: FolderRulesDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    scope: "collection",
    folderName: "Trade binder",
    // Cast so the stories below may hand other lists — `StoryObj<typeof meta>` takes each arg's
    // type from the value written here.
    rules: [] as readonly FolderRule[],
    inherited: [] as readonly InheritedRules[],
    pending: false,
    error: null as string | null,
    onSave: fn(),
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0`; a padded canvas would only frame a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A folder's own rules, one row each — range boxes, the filter bar's chips, the " +
          "search's set picker or two date boxes — with `Add rule` below and the ancestors' " +
          "rules listed read-only under “From …”.\n\n" +
          "**Rules never stop a card being filed**; they mark the cards that do not match. " +
          "Save greys (`aria-disabled`, keeping its tab stop) with the backend tidy's own " +
          "sentence while a rule is incomplete, and the backend's refusal is drawn as an alert.",
      },
    },
  },
} satisfies Meta<typeof FolderRulesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A folder with nothing of its own and nothing above it. Save is on: an empty list clears. */
export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/No rules of its own/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Save rules" })).not.toHaveAttribute(
      "aria-disabled",
    );
  },
};

/** One of every editor shape, under a parent that carries a rule of its own. */
export const WithRules: Story = {
  args: {
    folderName: "Cheap blue",
    rules: [
      { kind: "price", min: null, max: 1 },
      { kind: "colors", values: ["U"] },
      { kind: "sets", values: ["lea", "arn"] },
      { kind: "finishes", values: ["foil"] },
      { kind: "released", from: "2001", to: "2005" },
    ],
    inherited: [
      {
        folderId: 1,
        folderName: "Trade binder",
        rules: [{ kind: "conditions", values: ["NM", "LP"] }],
      },
    ],
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("group", { name: "Rule 1: Price" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "From “Trade binder”" })).toHaveTextContent(
      "Condition: Near mint or Lightly played",
    );
  },
};

/** A rule just added and not yet filled in: Save greys with the reason beside it. */
export const Incomplete: Story = {
  args: { rules: [{ kind: "borders", values: [] }] },
  play: async ({ canvas }) => {
    const save = await canvas.findByRole("button", { name: "Save rules" });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(save).toHaveAccessibleDescription("Pick at least one value for each rule.");
  },
};

/** The backend refused the write; its sentence is drawn as an alert above the footer. */
export const Refused: Story = {
  args: {
    rules: [{ kind: "manaValue", min: 2, max: 4 }],
    error: "That folder is not there any more.",
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That folder is not there any more.",
    );
  },
};

/** A wishlist folder: the same dialog, with no condition rule on offer — a wish has none. */
export const Wishlist: Story = {
  args: {
    scope: "wishlist",
    folderName: "Wants",
    rules: [{ kind: "rarities", values: ["mythic"] }],
  },
};
