import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { NotificationsDialog } from "@/components/NotificationsDialog";
import { notify, resetNotifications, type NotifyOptions } from "@/lib/notifications";
import { CLOSE_TOAST, Toaster } from "./Toaster";

/**
 * The toast stack with notices already raised, written **during render** — `UndoNotice`'s lever
 * and its reason: an effect runs after the first paint, so the story would open empty and slide
 * its toasts in on the way to the state it is about.
 *
 * **The store is emptied on unmount**, because it is module state the workbench does not reset
 * between stories, and a toast left up here would sit in the corner of the next one.
 */
function Raised({ notices, inbox = false }: { notices: NotifyOptions[]; inbox?: boolean }) {
  useState(() => {
    resetNotifications();
    for (const n of notices) notify(n);
  });
  useEffect(() => resetNotifications, []);
  const [open, setOpen] = useState(inbox);
  return (
    <div className="flex h-[28rem] items-start gap-2 bg-bg p-4">
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1.5 text-sm"
        onClick={() => notify.success("Added “Sol Ring” to “Atraxa”")}
      >
        Raise a toast
      </button>
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1.5 text-sm"
        onClick={() => setOpen(true)}
      >
        Open the inbox
      </button>
      <Toaster />
      <NotificationsDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

const meta = {
  title: "Chrome/Toaster",
  component: Raised,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The app's one way to say what just happened: `notify({ title, body?, tone?, " +
          "duration? })` from anywhere — a component, a mutation callback, a plain module — " +
          "raises a toast in the window's bottom-right corner **and** files it in the rail's " +
          "Notifications inbox, newest first.\n\n" +
          "The stay is the sender's (`duration`, in ms; `null` keeps it until its ✕ is pressed; " +
          "absent, a default per tone). The clock pauses while the pointer or the caret is on the " +
          "toast. At most four are up at once; the oldest closes first and stays in the inbox.",
      },
    },
  },
  args: { notices: [] },
} satisfies Meta<typeof Raised>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One of each tone, held open so the four can be compared. */
export const Tones: Story = {
  args: {
    notices: [
      { title: "Prices refreshed", tone: "info", duration: null },
      { title: "Added “Sol Ring” to “Atraxa”", tone: "success", duration: null },
      {
        title: "3 cards were not found",
        body: "They are listed in the import's report.",
        tone: "warning",
        duration: null,
      },
      {
        title: "Couldn't copy the card name",
        body: "The clipboard is not available here.",
        tone: "error",
        duration: null,
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getAllByRole("button", { name: CLOSE_TOAST })).toHaveLength(4);
    await userEvent.click(canvas.getAllByRole("button", { name: CLOSE_TOAST })[0]);
    await expect(canvas.queryByText("Prices refreshed")).not.toBeInTheDocument();
  },
};

/** The inbox open over the same notices, newest first. */
export const Inbox: Story = {
  args: {
    inbox: true,
    notices: [
      { title: "Export saved", body: "Atraxa.txt", tone: "success", toast: false },
      { title: "Couldn't open Scryfall", tone: "error", toast: false },
      { title: "Copied “Lightning Bolt”", tone: "success", toast: false },
    ],
  },
};
