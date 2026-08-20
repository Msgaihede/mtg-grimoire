import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MutedTag } from "@/lib/ipc";
import { HiddenTagsPanel } from "./HiddenTagsPanel";
import type { HiddenTags } from "./useHiddenTags";

const muted = (slug: string, namespace: MutedTag["namespace"], tagId = `${namespace}-${slug}`) =>
  ({ namespace, tagId, slug, mutedAt: 1_787_252_107 }) satisfies MutedTag;

function hidden(over: Partial<HiddenTags> = {}): HiddenTags {
  return { tags: [], show: fn(), pending: null, error: null, ...over };
}

const meta = {
  title: "Settings/HiddenTagsPanel",
  component: HiddenTagsPanel,
  tags: ["autodocs"],
  args: { hidden: hidden() },
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
          "The only way back from hiding a tag.\n\n" +
          "Hiding one from its row on the Tags page raises a live line reading *“Hidden tags, " +
          "and anything filed under them, come back from Settings.”* Driving the shipped " +
          "window on 2026-08-20 found that sentence pointing at nothing: `tags_muted` and " +
          "`tag_unmute` were wired through Rust and `ipc.ts` and no component rendered them, " +
          "so hiding a tag was a one-way door and the app said otherwise.\n\n" +
          "**A muted category leaves with its whole subtree**, because the children are not " +
          "roots — one row here can be a great deal more than one tag, which is why the button " +
          "says *Show again* rather than anything that sounds like a single undo.\n\n" +
          "**The name is the slug as it read when the tag was hidden.** `tags::muted::list` " +
          "deliberately does not join the live taxonomy: a mute is keyed on Scryfall's uuid so " +
          "that a rename cannot lose it, and a tag Tagger has since renamed or deleted must " +
          "still be listed and still be removable. The sentence above the list is what keeps " +
          "the stored word from reading as a stale render.",
      },
    },
  },
} satisfies Meta<typeof HiddenTagsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing hidden — and the panel still says how hiding happens, because this is precisely where
 * a reader who hid something and cannot find it arrives.
 */
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/You have not hidden any tags/)).toBeInTheDocument();
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};

/**
 * The same slug hidden in both taxonomies, which is the case the row's mark exists for: `dog` is
 * in each of them and they mean different things by it, so two rows reading `dog` with nothing
 * else on them would be two buttons a reader cannot choose between.
 */
export const OneSlugInBothTaxonomies: Story = {
  args: { hidden: hidden({ tags: [muted("dog", "art"), muted("dog", "oracle")] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(2);

    await userEvent.click(canvas.getByRole("button", { name: /dog, oracle tag/ }));
    await expect(args.hidden.show).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "oracle", slug: "dog" }),
    );
  },
};

/**
 * A write in flight. Every button is held, not just the pressed one — a second `tag_unmute`
 * fired at a list that is about to be replaced under it is a press aimed at a row that has
 * moved — and only the pressed row is `aria-busy`.
 */
export const GivingOneBack: Story = {
  args: {
    hidden: hidden({ tags: [muted("cloud", "art"), muted("sky", "art")], pending: "art-cloud" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const b of canvas.getAllByRole("button")) await expect(b).toBeDisabled();
    await expect(canvas.getByRole("button", { name: /cloud/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  },
};

/**
 * A refusal, in the destructive red. The row is still on the list — nothing moved — so the
 * sentence is the only thing distinguishing a refused press from one that has not landed yet.
 */
export const Refused: Story = {
  args: {
    hidden: hidden({ tags: [muted("cloud", "art")], error: "the database is locked" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("the database is locked");
  },
};
