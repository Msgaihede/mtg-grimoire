import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { StartViewPanel } from "./StartViewPanel";

const meta = {
  title: "Settings/StartViewPanel",
  component: StartViewPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // layout question here is a picker sized to its widest word sitting under two lines of prose,
    // and a control that filled the pane would read as a text field rather than as a choice
    // between ten short labels.
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
          "Which view the app opens on.\n\n" +
          "Home is the page built to be landed on and is what a database nobody has touched " +
          "answers, but it is a poor *rule*: a reader who opens this app to look a card up " +
          "opens it on Search every time, and one who is mid-build opens it on their deck. What " +
          "the setting is worth is exactly the press it saves, repeated every launch.\n\n" +
          "**Every destination the rail always draws, and no others.** `Shared` is somebody " +
          "else's binder and its row appears only once a link has been opened, so offering it " +
          "here would let a reader set the app to open on a page with no row pointing at it — " +
          "the same fact that costs that view its `Ctrl+…` chord, met from a second surface.\n\n" +
          "**Alphabetical by the word on screen, with nothing pinned.** The rail's own order is " +
          "an argument about a column being read downward; a picker is searched for a word. Home " +
          "is the default and sits at C-D-**H** like any other label, because the closed trigger " +
          "already says which row is current.\n\n" +
          "**It moves nobody.** `useStartViewHydration` — mounted once, in `AppShell` — is what " +
          "reads this row at launch, and it drops its answer outright if the reader has already " +
          "pressed something. A change made here is a statement about the *next* launch, which " +
          "is why nothing on this panel navigates and why the press has nothing to confirm.\n\n" +
          "**This panel reaches the backend itself**, so the story below is a seeded world " +
          "rather than an argument — and it deliberately makes no press. Drawn alone, this panel " +
          "is the *first* reader of the `startView` cache entry and starts the launch read " +
          "itself; in the app `AppShell` filled that entry before the reader could reach " +
          "Settings, so a press here would race a read the shipped window never races. The " +
          "optimistic write is pinned in `StartViewPanel.test.tsx`, where the read can be " +
          "settled before the press.",
      },
    },
  },
} satisfies Meta<typeof StartViewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A database nobody has expressed a preference in: the app opens on Home, and the picker says so.
 *
 * The list is what this story is for looking at — ten destinations in the alphabet's order rather
 * than the rail's, each wearing the same glyph it wears in the column on the left, and `Shared`
 * absent from it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Named by the control rather than by the word it happens to be showing: the trigger's own
    // content is the value, so `Dropdown` states the field's name outright.
    const picker = canvas.getByRole("button", { name: "Opening view" });
    await waitFor(async () => {
      await expect(picker).toHaveTextContent("Home");
    });

    await userEvent.click(picker);
    await expect(canvas.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection",
      "Decks",
      "Home",
      "Playtesting",
      "Scanner",
      "Search",
      "Settings",
      "Tagger",
      "Trade",
      "Wishlist",
    ]);
    // The row that is not always on the rail, and therefore not offerable here.
    await expect(canvas.queryByRole("option", { name: "Shared" })).not.toBeInTheDocument();
  },
};
