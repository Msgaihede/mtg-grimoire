import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { STARTUP_LOADING_LABEL, StartupScreen } from "./StartupScreen";

/**
 * What the desktop and Android window draws while the native side opens the data folder, and
 * what it draws if that never happens. Pure — `DesktopBoot` owns the asking — so no fake backend
 * is involved; the caption reaches only the workbench's fake window.
 */
const meta = {
  title: "Chrome/StartupScreen",
  component: StartupScreen,
  tags: ["autodocs"],
  args: { status: { state: "loading" } },
  decorators: [
    // The screen is `h-dvh`, because it is the window. Boxed here so a docs page shows two
    // windows rather than two viewports, and 1280px wide for `TitleBar.stories`' reason: that is
    // the window's own default width, which the caption buttons' edge is measured against.
    (Story) => (
      <div className="h-[32rem] w-[1280px] max-w-full overflow-hidden [&>div]:h-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The window before the app. Opening and migrating the two databases runs on a " +
          "background thread so the window can paint and the taskbar can draw its icon, and " +
          "`App` is not mounted until `startup_status` says the folder is open — its queries " +
          "would otherwise fail against state that does not exist yet.\n\n" +
          "**It draws the caption** because the window is `decorations: false`: without " +
          "`TitleBar` a reader could not move or close a window that is migrating a database.\n\n" +
          "**Loading says nothing for its first 400 ms** (`ACTIVITY_DELAY_MS`, the ribbon's own " +
          "threshold for putting a sentence on screen), because a warm start is usually over " +
          "inside it. The status region is mounted from the first frame and filled when the " +
          "delay ends, so it announces exactly what a sighted reader sees. The mana line sweeps " +
          "under the sentence because a cold start is long and a still window reads as hung.\n\n" +
          "**A failure shows at once**, with the native side's own sentence verbatim and its line " +
          "breaks kept.",
      },
    },
  },
} satisfies Meta<typeof StartupScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Still opening. The canvas is empty ground under the caption for the first 400 ms — the state
 * most launches end in — and then the mark, the sweep and the sentence arrive together.
 */
export const Loading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Present from the first frame, so the words arriving later are an announcement.
    const region = canvas.getByRole("status");
    await expect(await canvas.findByText(STARTUP_LOADING_LABEL)).toBe(region);
    await expect(
      canvas.getByRole("progressbar", { name: STARTUP_LOADING_LABEL }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Close" })).toBeInTheDocument();
  },
};

/**
 * The data folder would not open. The sentence is illustrative of the shape `init_state` writes —
 * a first line naming the path and the error, a second saying what to do — and the long path is
 * on purpose: it is one unbreakable word to a browser, and it has to wrap rather than widen the
 * column.
 */
export const Failed: Story = {
  args: {
    status: {
      state: "failed",
      message:
        "MTG Grimoire could not prepare its database at C:\\Users\\Reader\\AppData\\Roaming\\com.mtg-grimoire.app\\data\\user.db: file is not a database\n" +
        "The file may be from a newer version of the app, or damaged. Moving it aside will let the app rebuild it from Scryfall.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "The data folder would not open" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("alert").textContent).toContain("\nThe file may be from");
    // Nothing is starting, so nothing claims to be.
    await expect(canvas.queryByRole("progressbar")).toBeNull();
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};
