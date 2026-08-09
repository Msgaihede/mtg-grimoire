import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { QuantityStepper } from "./QuantityStepper";

/**
 * The stepper is controlled, so a story has to own the state it controls.
 *
 * Rendered against a fixed `value` prop the buttons would move nothing and the box would snap
 * back on every keystroke — a story of a control that visibly does not work. The `value` arg
 * therefore seeds this and does not drive it, and `onChange` still reaches the arg so the
 * Actions panel shows what the component *reports*, which is the half a call site has to get
 * right.
 */
function Stateful({ value: initial, onChange, ...rest }: ComponentProps<typeof QuantityStepper>) {
  const [value, setValue] = useState(initial);
  return (
    <QuantityStepper
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const meta = {
  title: "Primitives/QuantityStepper",
  component: QuantityStepper,
  tags: ["autodocs"],
  // Keyed on the seed so the Controls panel still works: Storybook re-renders a story when an
  // arg changes rather than remounting it, and `useState`'s initial value is read once — so
  // without this, dragging `value` in Controls would move the label and nothing else.
  render: (args) => <Stateful key={args.value} {...args} />,
  args: { label: "Quantity of Lightning Bolt", value: 1, onChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "A quantity, and the two buttons that change it. The number is an " +
          '`<input type="number">` rather than a label because typing `12` is one action ' +
          "and pressing `+` eleven times is eleven, and a collection is full of twelves. It " +
          "is `font-mono tabular-nums` because a quantity is data — the direction reserves " +
          "colour for mana and art, so this control is grey and its only emphasis is the " +
          "focus outline.",
      },
    },
  },
} satisfies Meta<typeof QuantityStepper>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default size — a 36px control (`size-9`), and **the app renders it nowhere**.
 *
 * All four call sites pass `size="sm"`: the collection table, the wishlist table, the deck
 * editor's zone rows and the add-to-collection popup (grepped 2026-08-09, four of four). So
 * this story is the only place the default is drawn, which is reason enough to keep it — a
 * default nobody looks at is a default that rots — but it documents the component, not the
 * product.
 */
export const Medium: Story = { args: { size: "md", value: 3 } };

/** 28px (`size-7`), and what every surface in the app actually uses. The tightest is the deck
 *  editor's zone row, where the stepper shares a grid cell with the art thumbnail and a 221px
 *  column still has to hold both. */
export const Small: Story = { args: { size: "sm", value: 1 } };

/**
 * At the floor, where the decrease button disables itself rather than reporting a negative.
 *
 * Worth driving by hand: select the box and press Backspace. The box goes **empty** and stays
 * empty, and no `0` reaches the caller — that is the draft state, and it is the whole reason
 * the component holds a `draft` string beside the value. React reverts the DOM value of a
 * controlled input whose `onChange` did not move the state, so the obvious version of this
 * component makes Backspace do nothing at all and turns replacing "1" with "12" into "112".
 */
export const AtMinimum: Story = { args: { value: 0, min: 0 } };

/** At the ceiling. Typing past it is shown *clamped* rather than left as typed — a box
 *  reading 99 over a max of 9999 would be a promise the control has already broken. */
export const AtMaximum: Story = { args: { value: 9999 } };

/**
 * Both buttons are named after the thing being counted, never after the control: a screen
 * reader walking a list of forty printings otherwise hears "Increase" forty times with no way
 * to tell which card it belongs to. Asmoranomardicadaistinaculdacar is the longest card name
 * with no space in it — 31 characters, measured over the 116,694-row corpus — so it is the
 * worst case for a name the layout cannot wrap, and here it is in three accessible names at
 * once. (The longest name outright is 141 characters and has spaces, so it wraps.)
 */
export const LongLabel: Story = {
  args: { label: "Quantity of Asmoranomardicadaistinaculdacar" },
};
