import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import type { EffectiveRules } from "@/lib/folderRules";
import { FolderRulesBadge } from "./FolderRulesBadge";

/**
 * The mark a folder with rules wears beside its name (issue #980): a `ListChecks` glyph, and the
 * sub-tree's conflicting cards counted in red beside it. Hover or focus it for the rules in words.
 */
const meta = {
  title: "Folders/FolderRulesBadge",
  component: FolderRulesBadge,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      // A folder name beside it, at the folder card's `text-sm`, so the glyph is judged at the
      // size it is drawn at.
      <div className="flex items-center gap-1.5 bg-surface p-6 text-sm">
        <span>Cheap blue</span>
        <Story />
      </div>
    ),
  ],
  args: {
    effective: {
      own: [{ kind: "price", min: null, max: 1 }],
      inherited: [],
    } as EffectiveRules,
    conflicts: 0,
  },
  parameters: {
    docs: {
      description: {
        component:
          "Drawn for a folder's **effective** rules — its own and every ancestor's — and nothing " +
          "at all for a folder with none. The count is the folder's sub-tree " +
          "(`subtreeConflicts`), in `text-destructive`, and only when it is above zero. The " +
          "accessible name says the rules and the count in one sentence.",
      },
    },
  },
} satisfies Meta<typeof FolderRulesBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rules of its own and every card matching them: the glyph alone. */
export const Matching: Story = {
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("img", { name: "This folder's rules: Price up to $1.00." }),
    ).toBeInTheDocument();
  },
};

/** Rules inherited from a parent as well, and three cards breaking them. */
export const Conflicts: Story = {
  args: {
    effective: {
      own: [{ kind: "price", min: null, max: 1 }],
      inherited: [{ folderId: 1, folderName: "Blue", rules: [{ kind: "colors", values: ["U"] }] }],
    },
    conflicts: 3,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("img")).toHaveTextContent("3");
  },
};

/** Only an ancestor's rules: a subfolder adopts them and wears the mark too. */
export const InheritedOnly: Story = {
  args: {
    effective: {
      own: [],
      inherited: [
        {
          folderId: 1,
          folderName: "Old frames",
          rules: [{ kind: "released", from: null, to: "2003" }],
        },
      ],
    },
    conflicts: 1,
  },
};

/** No rules anywhere up the tree: nothing is drawn. */
export const NoRules: Story = {
  args: { effective: { own: [], inherited: [] }, conflicts: 0 },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("img")).not.toBeInTheDocument();
  },
};
