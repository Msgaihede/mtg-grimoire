import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { registerCommands } from "@grimoire/fake/core";
import { INTEGRATIONS_ROUND_FAILED } from "@grimoire/fake/db";
import { activeScope } from "@grimoire/fake/scope";
import type { IntegrationsStatus } from "@/lib/ipc";
import {
  IntegrationsPanel,
  NOT_AVAILABLE,
  NOT_ENTITLED,
  PRIVACY_SENTENCE,
  SENDING,
  STRANDED,
} from "./IntegrationsPanel";

const meta = {
  title: "Settings/IntegrationsPanel",
  component: IntegrationsPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  // `shared` is a world whose device connected Patreon, so the switch can be pressed; the stories
  // about what stops it say so with a seed or a fault of their own.
  parameters: {
    fake: { seed: "shared" },
    docs: {
      description: {
        component:
          "The group's switch for a copy of the collection held on a server, so integrations " +
          "can answer while the reader's devices are off (issue #1396). Nothing reads the copy " +
          "yet: Discord and a remote MCP server come later.\n\n" +
          "**The switch and the five boxes are the group's, not the device's** — two devices " +
          "sending under two choices would flap the server's copy between them. While on, the " +
          "boxes draw the group's choice and a change sends the whole set: the server drops " +
          "every table at once and the devices send their copies again. While off, they are a " +
          "draft that only the switch sends. **Turning off asks first**, because it deletes the " +
          "copy for every device in the group.\n\n" +
          "**A press publishes nothing.** It asks for a publish round, and the panel asks again " +
          "every few seconds until the round has run — *Sending this device's copy…*, then " +
          "*Last sent*, or the round's failure. (The fake runs the round by the next ask.)\n\n" +
          "**Every box is off until ticked**, and four columns are not boxes at all: purchase " +
          "price, purchase currency, acquired date and acquisition source are absent from the " +
          "format. The switch refuses a press, with the reason beside it, in a build with no " +
          "store address — every real build until the Worker is deployed — and on a device with " +
          "no membership; it stays focusable (`aria-disabled`), so the reason is read with it. " +
          "Desktop only: the light app's Settings leaves the panel out.",
      },
    },
  },
} satisfies Meta<typeof IntegrationsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The switch, once the status has answered. */
const theSwitch = (canvas: ReturnType<typeof within>) =>
  canvas.findByRole("switch", { name: /^Keep a copy for integrations/ });

/** A connected reader who has never switched it on: off, five clear boxes, all pressable. */
export const Off: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).not.toHaveAttribute("aria-disabled");
    await expect(canvas.getByText(PRIVACY_SENTENCE)).toBeInTheDocument();
    for (const name of ["Condition", "Language", "Market value", "Entry tags", "Entry notes"]) {
      await expect(canvas.getByRole("checkbox", { name })).not.toBeChecked();
    }
  },
};

/**
 * Switched on with two columns: condition and the entry's notes. **The press publishes nothing**
 * — it asks for a round, and the line says the copy is on its way. The panel asks again while
 * that is so; the fake has run the round by then, and *Last sent* answers.
 */
export const OnWithSomeFields: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await userEvent.click(canvas.getByRole("checkbox", { name: "Condition" }));
    await userEvent.click(canvas.getByRole("checkbox", { name: "Entry notes" }));
    await userEvent.click(toggle);

    await waitFor(async () => {
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    });
    await expect(canvas.getByText(SENDING)).toBeInTheDocument();
    await expect(canvas.getByRole("checkbox", { name: "Condition" })).toBeChecked();
    await expect(canvas.getByRole("checkbox", { name: "Entry notes" })).toBeChecked();
    await expect(canvas.getByRole("checkbox", { name: "Market value" })).not.toBeChecked();
    // The play stops here rather than waiting a poll out: the move to *Last sent* is the unit
    // suite's, on a faked clock (`IntegrationsPanel.test.tsx`). Left open, the story makes it.
  },
};

/** On, then off — through the question, which says the copy goes for every device, and hands the
 *  caret back to the switch that asked it. */
export const TurningOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await userEvent.click(canvas.getByRole("checkbox", { name: "Language" }));
    await userEvent.click(toggle);
    await waitFor(async () => {
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    await userEvent.click(toggle);
    // The dialog is portalled out of the canvas, so it is found on the document.
    const dialog = within(document.body).getByRole("dialog", { name: "Turn off integrations" });
    await expect(dialog).toHaveTextContent(/for every device in your sync group/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete the copy" }));

    await waitFor(async () => {
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    });
    await expect(toggle).toHaveFocus();
  },
};

/** Every real build until the Worker is deployed: the store has no address, so no press goes
 *  out, and the panel says so beside the switch. */
export const NotAvailable: Story = {
  parameters: { fake: { seed: "shared", fault: "integrationsNotDeployed" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await theSwitch(canvas)).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText(NOT_AVAILABLE)).toBeInTheDocument();
    await expect(canvas.getByRole("checkbox", { name: "Condition" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/** A reader who has connected nothing — the `starter` world. The store authenticates with a relay
 *  token, and the relay mints one only for a group with a membership. */
export const NotEntitled: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText(NOT_ENTITLED)).toBeInTheDocument();
    // Off: nothing of this group's is on the server to be left there.
    await expect(canvas.queryByText(STRANDED)).not.toBeInTheDocument();
  },
};

/**
 * On, on a device that has lost its membership since: deleting the store takes a relay token too,
 * so this device cannot switch it off, and the panel says where the copy stays and until when.
 *
 * **Not a state the fake reaches by itself** — it would take another device's switch-on heard by a
 * device whose membership then ended — so this host wraps the world's own `integrations_status`
 * and turns its answer on, `LegalityDialog`'s way rather than a hand-built status: a field added
 * to the mirror reaches this story through the fake.
 */
function StrandedHost() {
  useState(() => {
    const answer = activeScope().commands.integrations_status as () => IntegrationsStatus;
    registerCommands({
      integrations_status: () => ({
        ...answer(),
        enabled: true,
        fields: { condition: true, lang: false, value: true, tags: false, notes: false },
      }),
    });
  });
  return <IntegrationsPanel />;
}

export const OnWithoutMembership: Story = {
  render: () => <StrandedHost />,
  parameters: {
    fake: { seed: "starter" },
    // Its own frame on the docs page, where every story mounts at once and a handler registered
    // during render would otherwise land in whichever story's world was pointed at last.
    docs: { story: { inline: false, height: "700px" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText(STRANDED)).toBeInTheDocument();
  },
};

/** The last publish round failed — a Worker that timed out — and the status carries its sentence,
 *  drawn under the switch. **An On state**: the engine forgets a round's failure whenever it hears
 *  the store is off. The switch can still be pressed: a failed round is not a refusal. */
export const RoundFailed: Story = {
  parameters: { fake: { seed: "shared", fault: "integrationsError" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).not.toHaveAttribute("aria-disabled");
    await expect(await canvas.findByRole("alert")).toHaveTextContent(INTEGRATIONS_ROUND_FAILED);
  },
};

/**
 * A press the service has not answered yet: the switch and every box refuse another until it
 * does — and the switch keeps the caret, because it refuses through `aria-disabled` rather than
 * the attribute that would drop it.
 *
 * **The press never settles here** — the one state the fake cannot stand still in, since its
 * answers are immediate — so this story's host replaces `integrations_enable` with a promise that
 * never resolves. In a lazy `useState` initializer rather than an effect, `LegalityDialog`'s
 * answer: it must be in place before the first press, and the scope the decorator activated for
 * this story is the one active during its first render.
 */
function PendingHost() {
  useState(() => {
    registerCommands({ integrations_enable: () => new Promise(() => {}) });
  });
  return <IntegrationsPanel />;
}

export const Pending: Story = {
  render: () => <PendingHost />,
  parameters: {
    docs: { story: { inline: false, height: "620px" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await theSwitch(canvas);
    await userEvent.click(toggle);

    await waitFor(async () => {
      await expect(toggle).toHaveAttribute("aria-disabled", "true");
    });
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    await expect(toggle).toHaveFocus();
    await expect(canvas.getByRole("checkbox", { name: "Condition" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};
