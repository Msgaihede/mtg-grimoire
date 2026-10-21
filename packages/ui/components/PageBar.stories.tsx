import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { BUTTON } from "@/features/settings/controls";
import { Figure, InlineFigureRow } from "./Figure";
import { PAGE_META, PageBar, SECTION_LINK, SECTION_RULE, SECTION_TITLE } from "./PageBar";

/** Two quiet actions, as most pages carry. Real buttons in the shared recipe, so the row's
 *  height is the height a page's own actions make. */
const ACTIONS = (
  <>
    <button type="button" className={BUTTON}>
      Import
    </button>
    <button type="button" className={BUTTON}>
      Export
    </button>
  </>
);

const meta = {
  title: "Primitives/PageBar",
  component: PageBar,
  tags: ["autodocs"],
  args: { title: "Collection" },
  parameters: {
    docs: {
      description: {
        component:
          "Every page's top row, and its heading (\"Page & Section Headings\" canvas, option " +
          "A · Quiet row, approved 2026-10-21). Not a block above the page: the Cinzel title " +
          "takes the left end of the row the page's figures and actions already stood in, and " +
          "a gold hairline fading to the right sits under it — no extra height. Left to right: " +
          "the trail (sub-pages only), the title, inline figures (`998 cards · 735 unique`) or " +
          "mono meta, the page's own actions. **Sub-pages are one rule:** the page on screen " +
          "is the title, everything above it a dim crumb with a chevron after it. Three or " +
          "more crumbs collapse their middle to `…`.",
      },
    },
  },
} satisfies Meta<typeof PageBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collection and Wishlist: one line of figures on the title's baseline, the money in gold. */
export const WithFigures: Story = {
  args: {
    figures: (
      <InlineFigureRow>
        <Figure inline label="cards" value="998" />
        <Figure inline label="unique" value="735" />
        <Figure inline accent label="value" value="$6,247.11" note="4 unpriced" />
      </InlineFigureRow>
    ),
    actions: ACTIONS,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The title is the page's own `<h2>` by default — the heading each page carried `sr-only`
    // while there was no visible header.
    await expect(canvas.getByRole("heading", { level: 2, name: "Collection" })).toBeInTheDocument();
    await expect(canvas.queryByRole("navigation", { name: "Page trail" })).toBeNull();
    // Each word still names its own number: the pair is a `dt`/`dd` in one wrapper, whatever
    // order the row draws them in.
    await expect(canvas.getByText("unique").closest("div")).toHaveTextContent("735");
  },
};

/** Decks and Trade: counts as mono meta rather than figures. */
export const WithMeta: Story = {
  args: { title: "All decks", meta: "4 folders · 23 decks", actions: ACTIONS },
};

/** A sub-page: the parent is a crumb, the page is the title. The crumb is the way back. */
export const SubPage: Story = {
  args: {
    title: "My Decks",
    meta: "10 decks",
    trail: [{ label: "Decks", name: "Back to all decks", onOpen: fn() }],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Back to all decks" }));
    await expect(args.trail?.[0].onOpen).toHaveBeenCalledTimes(1);
  },
};

/** A deep trail keeps its root and its immediate parent; the middle is `…`. */
export const DeepTrail: Story = {
  args: {
    title: "Adorable Otters & Warcrimes",
    trail: [
      { label: "Decks", onOpen: fn() },
      { label: "Commander", onOpen: fn() },
      { label: "Otters", onOpen: fn() },
    ],
  },
  play: async ({ canvasElement }) => {
    const trail = within(within(canvasElement).getByRole("navigation", { name: "Page trail" }));
    await expect(trail.getByRole("button", { name: "Decks" })).toBeInTheDocument();
    await expect(trail.getByRole("button", { name: "Otters" })).toBeInTheDocument();
    await expect(trail.queryByRole("button", { name: "Commander" })).toBeNull();
  },
};

/** A parent that is not a page of its own — Settings' — is words, not a button. */
export const StaticCrumb: Story = {
  args: { title: "Collection", titleAs: "div", trail: [{ label: "Settings" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Settings")).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Settings" })).toBeNull();
  },
};

/**
 * The section heading inside a page — a group, a folder wall, a settings or scanner panel —
 * drawn from the module's recipes: Cinzel 18, mono meta, a grey rule to the row's end and an
 * optional gold link. Grey, because the gold rule is the page bar's alone.
 */
export const SectionHeading: Story = {
  render: () => (
    <div className="flex items-baseline gap-3">
      <h3 className={SECTION_TITLE}>Not sorted</h3>
      <span className={PAGE_META}>4 cards · $26.27</span>
      <span aria-hidden="true" className={SECTION_RULE} />
      <a href="#show-all" className={SECTION_LINK}>
        Show all
      </a>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 3, name: "Not sorted" })).toBeInTheDocument();
  },
};
