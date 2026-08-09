import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { PRICES_AS_OF } from "@/lib/prices";
import { applySort, type SortSpec } from "@/lib/sort";
import { SortableHeader } from "./SortableHeader";

/**
 * A row of headers, which is the only place this component is ever drawn.
 *
 * `VirtualTable` puts it inside `role="row"` inside `role="table"` (`VirtualTable.tsx:188-229`),
 * and `row` is `columnheader`'s **required parent** in WAI-ARIA — so a bare header in a story
 * canvas would be a structure error belonging to the story rather than to the component, and the
 * a11y addon would have no way to say which. Every story here therefore wears the ancestry, and
 * the two roles are copied from that block. (Whether axe flags the bare form is Task 17's to
 * confirm; this file does not wait to find out.)
 *
 * The track sizing is **not** copied: the real one joins each column's own `width` into a
 * `gridTemplateColumns` string, and these stories draw one header at a time (three in
 * {@link Live}). `grid-flow-col auto-cols-fr` is the story's own way of giving whatever is
 * inside it equal, non-zero width — which {@link RightAligned} needs, since a header packed to
 * its end looks identical to one packed to its start in a track that fits the label exactly.
 */
const HeaderRow: Meta<typeof SortableHeader>["decorators"] = [
  (Story) => (
    <div role="table" aria-label="Stand-in table">
      <div
        role="row"
        aria-rowindex={1}
        className="grid w-[28rem] grid-flow-col auto-cols-fr items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-dim"
      >
        <Story />
      </div>
    </div>
  ),
];

const meta = {
  title: "Table/SortableHeader",
  component: SortableHeader,
  tags: ["autodocs"],
  decorators: HeaderRow,
  args: { label: "Name", sortKey: "name", spec: [], onSort: fn() },
  parameters: {
    docs: {
      description: {
        component:
          'One column\'s header, when the column can be sorted on. The `role="columnheader"` ' +
          "element carries `aria-sort` and the `<button>` inside it carries the press — a " +
          "header is not a control, and a control is not a header. It is **pure props**: the " +
          "spec comes in and one press goes out, so every state below is mountable directly " +
          "and the sort state itself lives in the page's own hook.\n\n" +
          "Two gestures, one handler. A plain press replaces the sort; **Shift** adds this " +
          "column to it. Chromium reports `shiftKey` on the click it synthesises from " +
          "Shift+Enter, so the keyboard needs no second path — which is why the hint is a " +
          "`title` and not a caption: the reader who needs it is already pointing at a header, " +
          "and a permanent line under the table would cost 20px of every list to say it.",
      },
    },
  },
} satisfies Meta<typeof SortableHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A sortable column the sort does not mention.
 *
 * `aria-sort="none"` rather than no attribute at all, which is the difference between "this
 * column can be sorted and currently is not" and "this column is not sortable" — the second is
 * what `VirtualTable` renders for a plain `<span>` header, and `VirtualTable.test.tsx:92` pins
 * that half.
 *
 * The button carries no `aria-label`: a name identical to the visible text is a name the
 * browser already computes, and overriding it with the same string is one more thing to keep in
 * step.
 */
export const Unsorted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("columnheader")).toHaveAttribute("aria-sort", "none");
    await expect(canvas.getByRole("button", { name: "Name" })).not.toHaveAttribute("aria-label");
    // No arrow either. `term` is undefined, so neither `<Arrow>` nor the rank badge is drawn,
    // and the label is the whole of the header's contents.
    await expect(canvasElement.querySelector("svg")).toBeNull();
  },
};

/** One press: the column decides the order, and stops being dim (`term && "text-text"`). */
export const Ascending: Story = {
  args: { spec: [{ key: "name", dir: "asc" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("columnheader")).toHaveAttribute("aria-sort", "ascending");
    // **No rank**, and that is the whole of `showRank`: `spec.length` is 1, so "1 of 1" would
    // be a number that says nothing in a 36px row. The accessible name is therefore the bare
    // label, exactly as in `Unsorted`.
    await expect(canvas.getByRole("button", { name: "Name" })).toBeInTheDocument();
  },
};

/** The second press. The arrow is `ArrowDown` here and `ArrowUp` above — the one thing on
 *  screen that separates the two, and the reason `aria-sort` carries the same fact in words. */
export const Descending: Story = {
  args: { spec: [{ key: "name", dir: "desc" }] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("columnheader")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  },
};

/**
 * The same column, second in a two-key sort — the state the rank badge exists for.
 *
 * The badge is `aria-hidden` and the number is in the button's accessible name instead, because
 * a screen reader landing on the caret should hear "sort priority 2" rather than a bare digit
 * after the column title. WCAG 2.5.3 is what decides the order of that sentence: an accessible
 * name that overrides the visible one has to *begin* with it, or the column stops being
 * addressable by the word written on it.
 *
 * The header and the button say different things on purpose. `aria-sort` goes on the header —
 * where a screen reader walking the table by column meets it — and the priority goes on the
 * button, where the caret lands.
 */
export const SecondOfTwoKeys: Story = {
  args: {
    spec: [
      { key: "rarity", dir: "asc" },
      { key: "name", dir: "desc" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Name, sort priority 2" })).toBeInTheDocument();
    // The visible badge is not part of any accessible name — the query above would have failed
    // if it were, since the computed name would end in a stray "2".
    await expect(canvas.getByText("2")).toHaveAttribute("aria-hidden", "true");
  },
};

/**
 * The collection's Value column, verbatim — the one header in the app that carries a sentence
 * of its own.
 *
 * Every prop here is copied from `CollectionTable.tsx:163-165`. Spec §5 says a price is never
 * shown without saying how old it is, and a 36px header row has nowhere to write it, so
 * `PRICES_AS_OF` rides in two places: the `title`, which the sort hint is **appended** to
 * rather than replacing, and `headerLabel`, which becomes the header's `aria-label`.
 *
 * The label is on the *header* and not on the button, and that was measured: name-from-content
 * does not reach into a descendant's `aria-label`, so a column whose whole description lived on
 * the button read as the bare word "Price".
 *
 * `text-right` in the class name is what packs the label and its arrow to the column's end —
 * a string test rather than a prop, so a right-aligned column needs one class and not two.
 */
export const RightAligned: Story = {
  args: {
    label: "Value",
    sortKey: "value",
    spec: [{ key: "value", dir: "desc" }],
    title: PRICES_AS_OF,
    ariaLabel: `Value. ${PRICES_AS_OF}`,
    className: "text-right",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Appended, never replaced — both sentences are on the one tooltip, in that order.
    await expect(canvas.getByRole("button")).toHaveAttribute(
      "title",
      `${PRICES_AS_OF}\nSort by Value — Shift-click to add to the sort`,
    );
    await expect(canvas.getByRole("columnheader")).toHaveAttribute(
      "aria-label",
      `Value. ${PRICES_AS_OF}`,
    );
    // The alignment is a class rather than anything a name or a role can carry, and in a track
    // the width of its own label it looks identical either way — which is why the decorator
    // gives these headers a full third of 28rem each.
    await expect(canvas.getByRole("button")).toHaveClass("justify-end");
  },
};

/**
 * Three headers wired to `applySort`, so the two gestures can actually be tried.
 *
 * `applySort` is the whole of what a press means and it lives in `@/lib/sort`, not here: this
 * component reports `(key, additive)` and reads back whatever spec the page hands it. So this
 * story is the pair working together, which is the only way to see the cycle — **`firstDir`,
 * the opposite, then gone** — and the fact that a plain press on a column already in a
 * multi-key sort *narrows to it* rather than flipping it in place.
 *
 * Value opens descending because "highest first" is what pressing a money column means; the
 * other two open ascending. That table is the page hook's in the real app, and it is restated
 * here because a story cannot borrow one.
 */
function LiveHeaders({ onSort }: { onSort: (key: string, additive: boolean) => void }) {
  const [spec, setSpec] = useState<SortSpec>([]);
  const firstDirs: Record<string, "asc" | "desc"> = { name: "asc", set: "asc", value: "desc" };
  const press = (key: string, additive: boolean) => {
    setSpec((current) => applySort(current, key, { additive, firstDir: firstDirs[key] }));
    onSort(key, additive);
  };
  return (
    <>
      <SortableHeader label="Name" sortKey="name" spec={spec} onSort={press} />
      <SortableHeader label="Set" sortKey="set" spec={spec} onSort={press} />
      <SortableHeader
        label="Value"
        sortKey="value"
        spec={spec}
        onSort={press}
        className="text-right"
      />
    </>
  );
}

/**
 * The live version of the other five stories: press the headers and watch the arrows, the ranks
 * and the accessible names move together.
 *
 * Try it by hand — plain-press **Name** twice and a third time to clear it; Shift-press **Set**
 * to add a second key; then plain-press **Set**, which narrows the sort to that one column
 * rather than flipping it.
 *
 * The `play` below pins the half a `SortableHeader` is actually responsible for: what it
 * *reports*. A plain press is `(key, false)` and a shifted one is `(key, true)`, from one
 * `onClick` handler — Chromium puts `shiftKey` on the click it synthesises from Shift+Enter, so
 * there is no second code path for the keyboard and none to test.
 */
export const Live: Story = {
  // Inert: `StoryObj<typeof meta>` requires the component's own props, and this story's
  // `render` builds three headers of its own. Controls are switched off rather than left
  // offering knobs that move nothing.
  args: { label: "", sortKey: "", spec: [] },
  parameters: { controls: { disable: true } },
  render: (args) => <LiveHeaders onSort={args.onSort} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // **`setup()`, not the bare `userEvent`.** Shift is held across two calls below, and the
    // top-level API builds a fresh session per call — so the click would land with the modifier
    // already released. Measured 2026-08-09: without this the shifted press reported
    // `("value", false)` and the assertion below failed on the boolean. One session is also the
    // shape `VirtualTable.test.tsx:114-123` uses, for the same reason.
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Name" }));
    await expect(args.onSort).toHaveBeenLastCalledWith("name", false);
    await expect(canvas.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    // Held down around the click rather than passed as an option: `user.click` has no modifier
    // argument, and the keyboard state of the session is what the synthesised event reads.
    await user.keyboard("{Shift>}");
    await user.click(canvas.getByRole("button", { name: "Value" }));
    await user.keyboard("{/Shift}");
    await expect(args.onSort).toHaveBeenLastCalledWith("value", true);

    // Two keys, so both columns now say where they sit — and Value opened **descending**,
    // which is `firstDir` doing its one job.
    await expect(canvas.getByRole("button", { name: "Name, sort priority 1" })).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Value, sort priority 2" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("columnheader", { name: /^Value/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  },
};
