import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DeckTagsField, type DeckTagsFieldProps } from "./DeckTagsField";
import type { TagInUse } from "./deckTags";

/** What a gallery of a dozen decks might wear, as `tagsInUse` answers it — alphabetical. */
const IN_USE: TagInUse[] = [
  { tag: "Budget", count: 4 },
  { tag: "Gimmick", count: 1 },
  { tag: "Meme", count: 2 },
  { tag: "No Gamechangers", count: 3 },
  { tag: "Only removal", count: 1 },
];

/**
 * A host holding the list, which is what the settings dialog is.
 *
 * The field is controlled and writes nothing, so against a frozen `tags` a story could show one
 * act and never a second — and "the tag just picked leaves the suggestions" is the second act.
 * The column is the settings form's own right-hand one, which is what decides when a row of
 * chips wraps.
 */
function Host({ tags: initial, onChange, ...rest }: DeckTagsFieldProps) {
  const [tags, setTags] = useState(initial);
  return (
    <div className="w-[28rem] max-w-full bg-bg p-4 pb-56">
      <DeckTagsField
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
  title: "Decks/Tags field",
  component: DeckTagsField,
  tags: ["autodocs"],
  args: { tags: [], inUse: IN_USE, onChange: fn(), id: "story" },
  render: (args) => <Host {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "A deck's own tags (issue #834): a row of chips, a box for the next one, and under it " +
          "the tags other decks already wear.\n\n" +
          "**A deck tag is free text about a whole deck** — *Budget*, *No Gamechangers*, *Meme*. " +
          "It is not one of Scryfall's Tagger tags, which describe a card, and not a deck " +
          "**label**, which is the coloured mark on one card inside a deck.\n\n" +
          "**The suggestions are the feature.** There is no list of tags anywhere but on the " +
          "decks, so what makes *Budget* on one deck and *Budget* on the next the same tag is " +
          "spelling it the same way twice — and the list makes that a press. It opens as soon as " +
          "the box takes the caret, each row saying how many decks wear it.\n\n" +
          "**Nothing is highlighted until an arrow is pressed**, so Enter always adds the word " +
          "that was typed. ↓ and ↑ walk the list without moving the caret; Backspace in an empty " +
          "box takes the last chip off; Escape closes the list, then clears the box, and only " +
          "then belongs to the dialog around it. Looking away adds a half-typed tag rather than " +
          "dropping it — the settings dialog's rule for every text field it holds.\n\n" +
          "The field is controlled and reports the **whole new list** on each act, never a " +
          "no-op: a blank and a repeat report nothing.",
      },
    },
  },
} satisfies Meta<typeof DeckTagsField>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **A deck with no tags yet, and other decks that have some.** The box says what it is for, and
 * putting the caret in it opens every tag in use — before a key is pressed, because the commonest
 * thing done here is giving a second deck a word already used on a first.
 */
export const Empty: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole("combobox", { name: "Tags" });
    await expect(box).toHaveAttribute("placeholder", "Add a tag…");
    await expect(box).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(box);
    const list = await canvas.findByRole("listbox", { name: "Tags on other decks" });
    await expect(within(list).getAllByRole("option")).toHaveLength(IN_USE.length);
    await expect(
      within(list).getByRole("option", { name: /Budget\s*4 decks/ }),
    ).toBeInTheDocument();

    // A press on a row is the whole gesture: the tag is on the deck, the box is empty, the caret
    // has not moved, and the row is gone from the list.
    await userEvent.click(within(list).getByRole("option", { name: /Budget/ }));
    await expect(args.onChange).toHaveBeenCalledWith(["Budget"]);
    await expect(canvas.getByRole("button", { name: "Remove the Budget tag" })).toBeInTheDocument();
    await expect(box).toHaveFocus();
    await expect(canvas.queryByRole("option", { name: /Budget/ })).toBeNull();
  },
};

/**
 * **Typing narrows the list, and Enter adds what was typed.** `no` leaves one suggestion standing
 * — *No Gamechangers* — and Enter still adds `no`, because nothing is highlighted until an arrow
 * is pressed. ↓ then Enter is how the suggestion is taken from the keyboard.
 */
export const Typing: Story = {
  args: { tags: ["Budget"] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole("combobox", { name: "Tags" });

    await userEvent.type(box, "no");
    const rows = within(
      await canvas.findByRole("listbox", { name: "Tags on other decks" }),
    ).getAllByRole("option");
    await expect(rows).toHaveLength(1);
    await expect(box).not.toHaveAttribute("aria-activedescendant");

    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect(args.onChange).toHaveBeenLastCalledWith(["Budget", "No Gamechangers"]);
    await expect(box).toHaveValue("");
  },
};

/**
 * **More tags than one line holds.** The chips wrap inside the box and the input drops to a line
 * of its own once the row is used up, so there is always room to read the word being typed. The
 * suggestion list hangs off the box's bottom edge, so it moves down with it.
 *
 * Every chip carries its own control, named for the tag it removes.
 */
export const Many: Story = {
  args: {
    tags: ["Budget", "No Gamechangers", "Only removal", "Gimmick", "Precon upgrade", "Pauper cube"],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chips = within(canvas.getByRole("list", { name: "Tags on this deck" }));
    await expect(chips.getAllByRole("listitem")).toHaveLength(6);

    await userEvent.click(canvas.getByRole("button", { name: "Remove the Gimmick tag" }));
    await expect(args.onChange).toHaveBeenCalledWith([
      "Budget",
      "No Gamechangers",
      "Only removal",
      "Precon upgrade",
      "Pauper cube",
    ]);
    // The chip's own button is gone, so the caret goes to the one control that survives.
    await expect(canvas.getByRole("combobox", { name: "Tags" })).toHaveFocus();
  },
};

/**
 * **A reader's first tag, with nothing to suggest.** No list opens and the box says so
 * (`aria-expanded="false"`) rather than opening an empty panel; the field is otherwise the same.
 */
export const NothingToSuggest: Story = {
  args: { inUse: [] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole("combobox", { name: "Tags" });

    await userEvent.type(box, "First{Enter}");
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await expect(args.onChange).toHaveBeenCalledWith(["First"]);
  },
};
