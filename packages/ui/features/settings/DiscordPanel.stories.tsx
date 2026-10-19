import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DISCORD_GATE_SENTENCE, DISCORD_UNREACHABLE } from "@grimoire/fake/db";
import { ADDED_FROM_DISCORD, DISCORD_COMMANDS, DiscordPanel } from "./DiscordPanel";

const meta = {
  title: "Settings/DiscordPanel",
  component: DiscordPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width, `BackupPanel`'s decorator and its reason: the command
    // list's lines are the longest text this panel draws.
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
          "Settings → Integrations → Discord (issue #1096): a switch that signs the reader in " +
          "with Discord in their browser, then one press that adds the operator's bot to their " +
          "sync group as an **`add` device**, so `/collection search`, `/wishlist search`, " +
          "`/card-search` and `/deck` answer in any server or chat with no bot invited anywhere, " +
          "and `/collection add` and `/wishlist add` add a card once the reader presses Confirm " +
          "in Discord — never changing or removing anything." +
          "\n\n" +
          "**Every story here is a seeded world**, `BackupPanel`'s arrangement: the panel reaches " +
          "the backend itself. The workbench has no Discord front and no browser, so the fake " +
          "approves a sign-in on its **second** claim and an enrolled bot never fetches. The " +
          "`discordLinking`, `discordLinked`, `discordGate`, `discordEnrolled` and " +
          "`discordUnreachable` faults are the states a press cannot reach.\n\n" +
          "**Both consequential presses ask first**: adding the bot says plainly what it may " +
          "add and where (*Added from Discord*, which the switch-on makes), and that the " +
          "operator's servers then hold a copy they can decrypt, and switching off says where " +
          "the app is removed from the reader's Discord account, which this panel cannot do.",
      },
    },
  },
} satisfies Meta<typeof DiscordPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const theSwitch = (canvas: ReturnType<typeof within>) =>
  canvas.findByRole("switch", { name: /enable discord integration/i });

/** Not switched on — every install until somebody does. No account and no commands. */
export const NotLinked: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await theSwitch(canvas)).toHaveAttribute("aria-checked", "false");
    await expect(canvas.getByText(/supporter feature/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/signed in as/i)).not.toBeInTheDocument();
  },
};

/**
 * The sign-in, pressed: the switch asks for a link request and opens Discord's page in the
 * browser (the workbench's opener is a no-op), the panel waits, and the fake's second claim —
 * two seconds in — finds the reader approved.
 */
export const SigningIn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await theSwitch(canvas));

    await expect(await canvas.findByText(/waiting for discord/i)).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: /open the sign-in page/i }),
    ).toBeInTheDocument();
    await waitFor(
      async () => {
        await expect(canvas.getByText(/signed in as/i)).toHaveTextContent("giradeli");
      },
      { timeout: 5_000 },
    );
    await expect(canvas.queryByText(/waiting for discord/i)).not.toBeInTheDocument();
  },
};

/**
 * A sign-in standing open — the reader is in their browser. The fake's claim never comes back
 * approved under this fault, so the panel stays here: the switch on, a wait, and Cancel.
 */
export const Linking: Story = {
  parameters: { fake: { fault: "discordLinking" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/waiting for discord/i)).toBeInTheDocument();
    await expect(await theSwitch(canvas)).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // This window did not begin the request, so it never had the page's address to reopen.
    await expect(
      canvas.queryByRole("button", { name: /open the sign-in page/i }),
    ).not.toBeInTheDocument();
  },
};

/**
 * Linked, and the gate refuses — a member of the group on a build that does not sign its changes.
 * The engine's sentence is drawn as it is and the next step is closed.
 */
export const LinkedGateRefuses: Story = {
  parameters: { fake: { fault: "discordGate" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/signed in as/i)).toHaveTextContent("giradeli");
    await expect(canvas.getByText(DISCORD_GATE_SENTENCE)).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: /add the bot to your sync group/i }),
    ).toBeDisabled();
  },
};

/**
 * Linked and ready, pressed through: the question says what adding the bot hands the operator,
 * and confirming enrols it.
 */
export const LinkedReady: Story = {
  parameters: { fake: { fault: "discordLinked" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const add = await canvas.findByRole("button", { name: /add the bot to your sync group/i });
    await expect(add).toBeEnabled();

    await userEvent.click(add);
    // The dialog is portalled out of the canvas, so it is found on the document.
    const dialog = within(await within(document.body).findByRole("dialog"));
    await expect(dialog.getByText(/can decrypt/i)).toBeInTheDocument();
    await expect(dialog.getByText(/only after you press Confirm in Discord/i)).toBeInTheDocument();
    await expect(dialog.getByText(ADDED_FROM_DISCORD)).toBeInTheDocument();
    await expect(dialog.getByText(/five device slots/i)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Add the bot" }));

    await expect(await canvas.findByText(/is in your sync group as/i)).toBeInTheDocument();
    await expect(canvas.getByText(/hasn't fetched your cards yet/i)).toBeInTheDocument();
  },
};

/** The bot in the group, two hours since it last fetched — and the commands it answers. */
export const Enrolled: Story = {
  parameters: { fake: { fault: "discordEnrolled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/last fetched your changes 2 hours ago/i)).toBeVisible();
    for (const { command } of DISCORD_COMMANDS) {
      await expect(canvas.getByText(command)).toBeInTheDocument();
    }
    await expect(canvas.getByText(/an add waits for you to press confirm/i)).toBeInTheDocument();
    await expect(await theSwitch(canvas)).toHaveAttribute("aria-checked", "true");
  },
};

/** The Discord front not answering: the switch's press is refused, in the panel's red line. */
export const Unreachable: Story = {
  parameters: { fake: { fault: "discordUnreachable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await theSwitch(canvas));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(DISCORD_UNREACHABLE);
    await expect(await theSwitch(canvas)).toHaveAttribute("aria-checked", "false");
  },
};
