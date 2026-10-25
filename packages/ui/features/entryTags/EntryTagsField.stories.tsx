import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { TagInUse } from "@/features/decks/deckTags";
import { EntryTagsField } from "./EntryTagsField";

/** What a collection and a wishlist might wear, as `entryTagsInUse` answers it — alphabetical. */
const IN_USE: TagInUse[] = [
  { tag: "Cube", count: 12 },
  { tag: "For Atraxa", count: 3 },
  { tag: "Trade bait", count: 5 },
];

type Args = Parameters<typeof EntryTagsField>[0];

/** A host holding the list, as the card modal's editor and the Tags dialog do. */
function Host({ tags: initial, onChange, ...rest }: Args) {
  const [tags, setTags] = useState(initial);
  return (
    <div className="w-[26rem] max-w-full bg-bg p-4 pb-56">
      <EntryTagsField
        {...rest}
        tags={tags}
        onChange={(next) => {
          onChange(next);
          setTags(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: "Entry tags/Tags field",
  component: EntryTagsField,
  tags: ["autodocs"],
  args: { tags: ["Cube"], inUse: IN_USE, onChange: fn(), id: "story" },
  render: (args) => <Host {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "A stack's own tags (issue #1398) — one collection row or one wish, every copy in it " +
          "sharing them. The deck tag field's chips, keyboard and reorder, in a stack's words, " +
          "suggesting the tags the collection and the wishlist wear and never the deck tags.\n\n" +
          "**Disabled** is the card modal outside the collection's Edit: the tags are drawn, " +
          "with no box to type in, no ✕ and no suggestions, and the line under the box says how " +
          "to get to a place that edits.",
      },
    },
  },
} satisfies Meta<typeof EntryTagsField>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A stack wearing one tag, open for edits. */
export const Editable: Story = {};

/** The card modal before Edit: shown, not editable. */
export const Disabled: Story = {
  args: {
    tags: ["Cube", "Trade bait"],
    disabled: true,
    disabledHint: "Press Edit to change this stack's tags.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("combobox", { name: "Tags" })).toBeDisabled();
    await expect(canvas.queryByRole("button", { name: /Remove the/ })).toBeNull();
  },
};
