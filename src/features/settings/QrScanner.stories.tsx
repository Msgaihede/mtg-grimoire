import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { QrScanner } from "./QrScanner";

const meta = {
  title: "Settings/QrScanner",
  component: QrScanner,
  tags: ["autodocs"],
  args: { onCode: fn(), onCancel: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-sm p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Camera to decoded string: `getUserMedia` → `<video>` → a `requestAnimationFrame` " +
          "loop over an offscreen `<canvas>` → `jsQR`. `onCode` gets exactly what `jsQR` " +
          "decodes, untouched — this component does not look at whether it is a bare pairing " +
          "code or the `https://…/pair#<code>` URL form; that split is `Invite::decode`'s, in " +
          "Rust.\n\n" +
          "**No vitest for the camera loop.** jsdom has neither `getUserMedia` nor real canvas " +
          "pixels, and this workbench cannot fake either honestly. What it *can* reach is the " +
          "one path jsdom actually takes: `navigator.mediaDevices` does not exist here, so " +
          "`getUserMedia` throws synchronously and this component lands on the same fallback " +
          "branch a live `NotSupportedError` does today (see the component's own doc comment — " +
          "that error is a known, unpatched WebView2 gap, not a bug in this file). The story " +
          "below drives the manual textarea that fallback offers, which is the real `onCode` " +
          "wiring a reader falls back to either way. **The frame loop and the decode itself are " +
          "the live CDP pass's to prove.**",
      },
    },
  },
} satisfies Meta<typeof QrScanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * What every run of this story is, in this workbench: `getUserMedia` is not a function jsdom
 * has, so the component falls onto its own error branch immediately, exactly as a real
 * `NotSupportedError` does against today's unpatched WebView2. What is worth proving from here
 * is not the sentence — it is that the fallback the sentence points at actually reaches `onCode`.
 */
export const CameraUnavailableFallsBackToTyping: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(/camera error/i);
    await expect(alert).toHaveTextContent(/type the code instead/i);

    const box = canvas.getByLabelText(/or type the code/i);
    const submit = canvas.getByRole("button", { name: /use this code/i });

    // Greyed until there is something to send — `aria-disabled`, not `disabled`, because this
    // is a control that changes on every keystroke and must stay in the tab order while it does.
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await expect(args.onCode).not.toHaveBeenCalled();

    await userEvent.type(box, "https://mtg-grimoire.example/pair#0123456789ABCDEFGH");
    await expect(submit).toHaveAttribute("aria-disabled", "false");

    await userEvent.click(submit);
    // Exactly what was typed, untouched — this component does not parse the pairing code, and
    // the URL form above is proof it does not even try to notice the difference.
    await expect(args.onCode).toHaveBeenCalledWith(
      "https://mtg-grimoire.example/pair#0123456789ABCDEFGH",
    );
    await expect(args.onCode).toHaveBeenCalledTimes(1);
  },
};

/**
 * Whitespace around a paste is trimmed before it reaches `onCode`, `SyncPanel`'s own `Paste`
 * boxes' rule — a stray newline at the end of a pasted blob is not part of the code.
 */
export const TrimsWhitespaceBeforeSending: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByLabelText(/or type the code/i);

    await userEvent.type(box, "  0123456789ABCDEFGH  ");
    await userEvent.click(canvas.getByRole("button", { name: /use this code/i }));

    await expect(args.onCode).toHaveBeenCalledWith("0123456789ABCDEFGH");
  },
};

/**
 * The way out, at every step. `onCancel` is a prop this component calls and nothing more — the
 * dialog that owns the actual close lives in the sibling task that mounts this component, so
 * there is nothing else here for a play to observe.
 */
export const CancelIsAlwaysThere: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};
