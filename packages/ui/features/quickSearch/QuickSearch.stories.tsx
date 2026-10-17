import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QUICK_SEARCH_LABEL, QuickSearch } from "./QuickSearch";

/** The group headings on screen, top to bottom — what the issue's order is asserted against. */
function headingsIn(canvasElement: HTMLElement): (string | null)[] {
  const listbox = within(canvasElement).getByRole("listbox");
  return Array.from(listbox.querySelectorAll('[role="group"]'), (group) => {
    const heading = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    return heading?.textContent ?? null;
  });
}

const meta = {
  title: "Chrome/QuickSearch",
  component: QuickSearch,
  tags: ["autodocs"],
  decorators: [
    // A caption-height bar with the field centred in it, as `TitleBar` draws it, and room below
    // for the panel, which is wider than the field and drops under it.
    (Story) => (
      <div className="h-[34rem] w-[56rem]">
        <div className="flex h-[34px] items-center justify-center bg-surface">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The header's quick search (issue #1098): a field centred in the title bar, reached " +
          "with a click or `Ctrl+K` from anywhere. Opened empty it lists what the reader touched " +
          "last — the decks most recently edited, the collection's and wishlist's newest copies, " +
          "the cards opened last. Typing filters it into groups that are **always in one order** " +
          "— Decks, Collection, Wishlist, All cards, Settings — so a card the reader owns or " +
          "wants is never drawn under the same card found in the whole corpus, and the corpus " +
          "group waits for both lists to answer before it is drawn at all.\n\n" +
          "A row opens what it names: a deck, a folder in any of the three cabinets (the " +
          "managed ones included), a card **revealed** in the folder it is filed in, the Search " +
          "page filtered to a card, or the Settings panel a word finds.",
      },
    },
  },
} satisfies Meta<typeof QuickSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opened with nothing typed: the recent things, newest first in each group. */
export const Recent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox", { name: QUICK_SEARCH_LABEL }));
    await waitFor(() => expect(canvas.getAllByRole("option").length).toBeGreaterThan(0));
    await waitFor(() => expect(headingsIn(canvasElement)[0]).toBe("Decks"));
  },
};

/** Typed: the seeded Lightning Bolt in the collection, above every corpus row for it. */
export const Grouped: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole("combobox", { name: QUICK_SEARCH_LABEL }),
      "lightning bolt",
    );
    await canvas.findByRole("option", { name: /Search all cards for “lightning bolt”/ });
    await waitFor(() => {
      const order = headingsIn(canvasElement);
      expect(order).toContain("Collection");
      expect(order.indexOf("Collection")).toBeLessThan(order.indexOf("All cards"));
    });
  },
};

/** A Settings panel found by the words its own page searches. */
export const FindsSettings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: QUICK_SEARCH_LABEL }), "currency");
    await canvas.findByRole("option", { name: /Prices/ });
  },
};
