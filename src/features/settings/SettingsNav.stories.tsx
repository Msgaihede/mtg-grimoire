import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { SettingsNav } from "./SettingsNav";

/**
 * The page's row, as `SettingsPage` lays it out, with a stand-in for the pane.
 *
 * **The row is what makes the rail's two shapes reachable at all**, so it is here rather than
 * imported: the switch is a container query on the rail's own inline size, and that size is
 * decided entirely by these two `flex` values. The rail is `flex-[1_1_232px]` and the pane
 * `flex-[999_1_480px]`, so while both fit on one line the pane takes all but a thousandth of the
 * free space and the rail sits at 232 — under the 260px threshold, a column. Below 712px of row
 * the two cannot share a line, the rail wraps onto one of its own at the full width, and the
 * same rail draws itself as a scrolling strip of chips.
 *
 * The `width` each story passes is therefore the whole of what it is arguing about.
 */
function Row({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-4 p-2" style={{ width }}>
      {children}
      <div className="flex-[999_1_480px] space-y-4">
        <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
          <h2 className="font-heading text-lg leading-none">A panel</h2>
          <p className="text-sm text-dim">
            The pane the rail sits beside. Only its `flex` value matters here — it is what decides
            whether the rail has a line to itself.
          </p>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Settings/SettingsNav",
  component: SettingsNav,
  tags: ["autodocs"],
  args: {
    group: "updates",
    onGroup: fn(),
    query: "",
    onQuery: fn(),
    badges: { review: 0, errors: 0 },
  },
  parameters: {
    docs: {
      description: {
        component:
          "The way through Settings: six groups, and a box that searches every panel in all " +
          "of them at once.\n\n" +
          "**Six entries and not twelve.** A rail as long as the page it indexes is a second " +
          "scroll rather than a way through the first, so panels that answer one question " +
          "share an entry — `Prices` and `Combos` are both optional bulk feeds of card facts, " +
          "and `Needs review` is what sync asks of a reader. `nav.ts` carries that grouping " +
          "and this component decides none of it.\n\n" +
          "**A query outranks the group.** While the box has words in it no entry is marked " +
          "current, because a reader who types `dropbox` while standing on `Updates` is asking " +
          "the page a question rather than asking the `Updates` group one. Picking a group is " +
          "what clears the query — and that is the *page's* press to make, not this " +
          "component's, so the two states can never both apply.\n\n" +
          "**It changes shape by its own width, through a container query, and the stories " +
          "below are the only place that can be seen.** jsdom applies no stylesheet and " +
          "evaluates no container query, so every assertion in `SettingsNav.test.tsx` is about " +
          "the column. Compare `BesideThePane` with `AboveThePane`: same component, same " +
          "props, a different row width.",
      },
    },
  },
} satisfies Meta<typeof SettingsNav>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The rail as a desktop reader finds it: a 232px column beside the pane, with the group they are
 * standing on marked by a 2px accent rule down its leading edge.
 *
 * The unpicked entries are `text-dim` and carry a transparent border of the same width, which is
 * what stops the rows sliding 2px sideways as the selection moves.
 */
export const BesideThePane: Story = {
  // Its own spies rather than the meta's, because this play makes a **negative** claim about
  // one of them — and a shared mock that another story had already called would make that
  // assertion depend on the order the file happens to run in.
  args: { onGroup: fn(), onQuery: fn() },
  decorators: [
    (Story) => (
      <Row width={860}>
        <Story />
      </Row>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Updates" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(canvas.getByRole("button", { name: "Storage and data" }));
    await expect(args.onGroup).toHaveBeenCalledWith("storage");
    // The rail reports the press and clears nothing: the page owns the query.
    await expect(args.onQuery).not.toHaveBeenCalled();
  },
};

/**
 * Both counts lit — twelve conflicts waiting and a bad afternoon in the error log.
 *
 * The figure is gold, which is what "the number worth looking at" is spelled in everywhere else
 * in this window, and `tabular-nums` so a count changing under the reader's eye does not shift
 * the entry's width. A group whose count is **zero draws no badge at all** rather than a nought:
 * six entries each carrying one is a page that always looks like it is asking for something.
 *
 * The figure is `aria-hidden` and the button's name carries its own copy — `Sync (12)`. That is
 * not belt and braces: a label and a number in two sibling elements compute to `Sync12`, because
 * the gap between them is a layout property and a name is built from trimmed text.
 */
export const BadgesLit: Story = {
  args: { group: "sync", badges: { review: 12, errors: 41 } },
  decorators: [
    (Story) => (
      <Row width={860}>
        <Story />
      </Row>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Sync (12)" })).toHaveTextContent("12");
    await expect(canvas.getByRole("button", { name: "Errors (41)" })).toBeInTheDocument();
    // Nothing is drawn for a count of zero, and four of the six groups have no badge at all.
    await expect(canvas.queryByText("0")).not.toBeInTheDocument();
  },
};

/**
 * Typing, and the state the rail is in for as long as there are words in the box: **no entry is
 * current**.
 *
 * The pane beside it is drawing whatever matched, wherever it lives, so a mark pointing at one
 * group would be pointing at a set of panels that is not the set on screen. The group underneath
 * is untouched — the page hands it straight back the moment the box is empty.
 */
export const Searching: Story = {
  args: { group: "storage", query: "dropbox" },
  decorators: [
    (Story) => (
      <Row width={860}>
        <Story />
      </Row>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const entry of canvas.getAllByRole("button")) {
      await expect(entry).not.toHaveAttribute("aria-current");
    }
  },
};

/**
 * The rail with no pane beside it — a phone, or a window narrow enough that 232 and 480 cannot
 * share a line.
 *
 * **This is the story the container query exists for, and a browser is the only place it can be
 * seen**: the row is 420px, the two items wrap, the rail becomes the full width of the page, and
 * at 260px or more it draws itself as a horizontally scrolling strip of chips with the accent
 * moved from each entry's left border to its bottom one. The search box stays above the strip at
 * full width, because it is the one control here whose usefulness scales with its width.
 *
 * The 2px of padding inside the strip is a focus indicator rather than taste: `overflow-x-auto`
 * computes `overflow-y` to `auto` as well, both clip at the scroller's padding box, and an
 * entry's ring is painted 2px outside its border box.
 *
 * Under Vitest this story renders the column like every other — jsdom has no layout engine and
 * evaluates no container query — so its `play` deliberately asserts nothing about the shape.
 */
export const AboveThePane: Story = {
  args: { group: "carddata", badges: { review: 3, errors: 0 }, onGroup: fn() },
  decorators: [
    (Story) => (
      <Row width={420}>
        <Story />
      </Row>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Every entry is still reachable when they are chips in a scroller, which is the half of
    // this story that survives having no stylesheet.
    await userEvent.click(canvas.getByRole("button", { name: "Errors" }));
    await expect(args.onGroup).toHaveBeenCalledWith("errors");
  },
};

/**
 * The box on its own, driven — the rail reports each keystroke and holds nothing.
 *
 * It is an `<input type="search">` like every filter box in this app, which buys it the one
 * Escape rule they all share: the press empties the box while there is something in it to empty
 * and falls through when there is not.
 */
export const TypingInTheBox: Story = {
  /** Its own spies, for `BesideThePane`'s reason: the second assertion is a negative one. */
  args: { onGroup: fn(), onQuery: fn() },
  decorators: [
    (Story) => (
      <Row width={860}>
        <Story />
      </Row>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole("searchbox", { name: "Search settings" });

    await userEvent.type(box, "d");
    await expect(args.onQuery).toHaveBeenCalledWith("d");
    await expect(args.onGroup).not.toHaveBeenCalled();
  },
};
