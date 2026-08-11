import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ErrorEntry } from "@/lib/ipc";
import type { ErrorLog } from "@/lib/useErrorLog";
import { ErrorLogPanel } from "./ErrorLogPanel";

/**
 * Stamps are relative to *now*, not to a fixed instant.
 *
 * `formatWhen` answers in words — "2 minutes ago", "3 days ago" — so a constant would render
 * one sentence on the day it was written and a different one every day after: a story whose
 * subject silently changes. The offsets below are far from the rounding boundaries, so each
 * one reads as exactly one thing.
 */
const NOW = Math.floor(Date.now() / 1000);

function entry(over: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    id: 1,
    firstAt: NOW - 900,
    lastAt: NOW - 120,
    source: "scryfall_image",
    operation: "image_fetch",
    kind: "timeout",
    message: "timed out after 10s",
    detail: "https://cards.scryfall.io/art/front/0/0/a1b2.webp?1699999999",
    count: 1,
    ...over,
  };
}

function log(over: Partial<ErrorLog> = {}): ErrorLog {
  return {
    entries: [],
    loading: false,
    error: null,
    clear: fn(),
    clearing: false,
    ...over,
  };
}

const meta = {
  title: "Settings/ErrorLogPanel",
  component: ErrorLogPanel,
  tags: ["autodocs"],
  args: { log: log() },
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because this
    // panel's one layout risk is a Scryfall image URL, which has no spaces to wrap at.
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
          "Everything the app could not do, in the one place a reader goes looking for it.\n\n" +
          "**Repeats fold, and the count is the whole reason.** `error_log`'s grain is " +
          "`(source, operation, kind, message)`, so a host that is unreachable writes one row " +
          "that counts up rather than one row per tile — the path-MTU incident this repo has " +
          "already met produced ~600 in a single pass. `detail` sits outside that grain (it is " +
          "the per-occurrence URL, which would defeat the folding) and the newest one wins.\n\n" +
          "**Nothing here is red.** The only colour is the fold count, in the gold that " +
          "already means 'the number worth looking at' everywhere else in this window. A " +
          "failed image fetch is not an alarm, and a panel that shouted is one nobody opens " +
          "twice.\n\n" +
          "The panel takes its state as a prop, so every story here is an argument. " +
          "`Settings/Page`'s `SomethingFailed` is the same panel driven by a **seeded world** " +
          "through the real `useErrorLog`, which is where the Clear button actually writes.",
      },
    },
  },
} satisfies Meta<typeof ErrorLogPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel most days, and the state it is designed to be found in.
 *
 * An empty log states the good news and stops. "No errors found" would read as a search that
 * came back empty rather than an app that is working — and the Clear button is disabled,
 * because there is nothing to clear and a live control over an empty list is a small lie.
 */
export const NothingHasFailed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Nothing has failed.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Clear" })).toBeDisabled();
  },
};

/**
 * A bad afternoon: an unreachable image host, a rate limit, and a full disk.
 *
 * The three rows are the three shapes the panel has to draw. The first is the folded one —
 * 617 failed fetches as a single fault — and it is the row the table's grain exists for. The
 * second is `rate_limited`, the one kind that is *this app's* behaviour to fix rather than
 * someone else's server having a bad day. The third carries a path instead of a URL and shows
 * that "Image cache" is a different thing from "Card images": the bytes arrived and the disk
 * refused them.
 */
export const ABadAfternoon: Story = {
  args: {
    log: log({
      entries: [
        entry({ count: 617 }),
        entry({
          id: 2,
          source: "scryfall_api",
          operation: "migrations",
          kind: "rate_limited",
          message: "rate limited by Scryfall; retry after 30s",
          detail: null,
          count: 2,
          firstAt: NOW - 7_200,
          lastAt: NOW - 3_600,
        }),
        entry({
          id: 3,
          source: "image_store",
          operation: "image_store",
          kind: "io",
          message: "could not use the image cache: The disk is full.",
          detail: "D:\\MTG Grimoire\\data\\images\\grid\\a1\\a1b2-0.webp",
          count: 1,
          firstAt: NOW - 300_000,
          lastAt: NOW - 300_000,
        }),
      ],
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The fold count, which is what makes 617 failures readable.
    await expect(canvas.getByText("×617")).toBeInTheDocument();
    // Named for what the reader has, never for the column it came out of.
    await expect(canvas.getByText(/Card images/)).toBeInTheDocument();
    await expect(canvas.getByText(/Image cache/)).toBeInTheDocument();
    // A fault that happened once carries no count at all.
    await expect(canvas.queryByText("×1")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Clear" }));
    await expect(args.log.clear).toHaveBeenCalled();
  },
};

/**
 * The log itself refusing to answer — which is its own small irony, and still has to be
 * sayable rather than leaving the panel silently empty.
 *
 * `role="alert"` because this one arrives *after* the reader is looking at the panel, unlike
 * every row below it, which was already there when they opened it.
 */
export const TheLogItselfRefused: Story = {
  args: { log: log({ error: "The database is busy. Try again." }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("The database is busy. Try again.");
  },
};
