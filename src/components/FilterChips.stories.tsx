import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import type { SearchView } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  FILTER_FIELD,
  FILTER_FOCUS,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "./FilterChips";

/**
 * Every control here is controlled, so a story has to own the state it controls.
 *
 * Rendered against a fixed `pressed`/`selected`/`view` a chip would report its click and then
 * visibly not move — a story of a control that does not work. The args therefore *seed* these
 * wrappers rather than driving them, and the callback still reaches the arg so the Actions
 * panel shows what each control reports, which is the half a call site has to get right. The
 * same shape `QuantityStepper.stories.tsx` settled on, for the same reason.
 */
function StatefulToggle({ pressed: seed, onClick, ...rest }: ComponentProps<typeof ToggleChip>) {
  const [pressed, setPressed] = useState(seed);
  return (
    <ToggleChip
      {...rest}
      pressed={pressed}
      onClick={() => {
        setPressed((on) => !on);
        onClick();
      }}
    />
  );
}

/**
 * The colour row: one `ManaChip` per key, in the group the callers wrap them in.
 *
 * The `role="group"`/`aria-label="Color identity"`/`gap-1.5` wrapper is **the caller's markup,
 * not the component's** — `ManaChip` is one chip and knows nothing about the row. It is copied
 * here verbatim from `FilterBar` and `CollectionFilterBar`, which carry it identically, because
 * a story of six loose chips would be a row this app never draws.
 */
function ColourRow({ initial }: { initial: readonly ManaKey[] }) {
  const [on, setOn] = useState<readonly ManaKey[]>(initial);
  return (
    <div role="group" aria-label="Color identity" className="flex gap-1.5">
      {MANA_KEYS.map((key) => (
        <ManaChip
          key={key}
          symbol={key}
          pressed={on.includes(key)}
          onClick={() =>
            setOn((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]))
          }
        />
      ))}
    </div>
  );
}

/**
 * `ManaValueChips` owns its own group, so this wrapper is state and nothing else — two pieces
 * of it, because the row has two axes. X is not a mana value: `cmc` counts `{X}` as zero, so
 * `{X}{B}{B}{B}` sits in the `3` bucket *and* answers the X chip, and the two are OR'd exactly
 * as the numerals are OR'd with each other. Both can be on, which is why they are two states
 * here rather than a tenth entry in one list.
 */
function ManaValueRow({ initial, x = false }: { initial: readonly number[]; x?: boolean }) {
  const [on, setOn] = useState<readonly number[]>(initial);
  const [onX, setOnX] = useState(x);
  return (
    <ManaValueChips
      selected={on}
      onToggle={(value) =>
        setOn((vs) => (vs.includes(value) ? vs.filter((v) => v !== value) : [...vs, value]))
      }
      xSelected={onX}
      onToggleX={() => setOnX((was) => !was)}
    />
  );
}

function LayoutPair({ initial }: { initial: SearchView }) {
  const [view, setView] = useState<SearchView>(initial);
  // The component carries `ml-auto`, which means nothing outside a flex row — so the wrapper is
  // what puts the pair where the filter row puts it: at the far end, clear of the filters.
  return (
    <div className="flex w-full max-w-md">
      <LayoutToggle view={view} onChange={setView} />
    </div>
  );
}

/** Resetting takes the count to zero, which greys the control where it stands rather than
 *  removing it — the rule this control exists to hold, and the one thing about it worth
 *  watching happen: the button does not move, and nothing beside it does either. */
function ResettableAll({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  return <ResetAll count={count} onReset={() => setCount(0)} />;
}

/**
 * A required callback whose call the story has nothing to say about.
 *
 * Module-level rather than an inline `fn()`, because a render body runs on every render and an
 * inline one would mint a fresh spy each time — the Actions panel would still work and the mock
 * registry would grow for nothing. The stories that *are* about the report use the meta's own
 * `onClick` arg instead.
 */
const noop = fn();

const meta = {
  title: "Primitives/FilterChips",
  // `FilterChips.tsx` is a family rather than a component: five controls, plus the three class
  // recipes that keep them one family — and Storybook takes one `component` per file.
  // `ToggleChip` is the plain member and the one with props worth a Controls panel; the other
  // four ride as subcomponents, which is what gives each of them a props table on this page.
  // (The build carries react-docgen metadata for all four — grepped in `storybook-static` —
  // but no eye has seen the page it feeds; that is Task 17's.)
  component: ToggleChip,
  subcomponents: { ManaChip, ManaValueChips, LayoutToggle, ResetAll },
  tags: ["autodocs"],
  // Keyed on the seed, like `QuantityStepper.stories.tsx`: Storybook re-renders a story when an
  // arg changes rather than remounting it, and `useState`'s initial value is read once — so
  // without this, toggling `pressed` in Controls would move nothing at all.
  render: (args) => <StatefulToggle key={String(args.pressed)} {...args} />,
  args: { label: "Owned", pressed: false, onClick: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The controls a filter row is built from, so that the collection's row is the " +
          "*same* row as the search's rather than a lookalike. Gold says both “focus” and " +
          "“on”, so the two are told apart by **shape**: focus is always an outline standing " +
          "off the control's edge, on is always the control's own border or a ring hugging " +
          "it — and a chip that is both shows both. The colour chips are the app's one " +
          "deliberate splash of colour, which is why everything else on the row is grey.",
      },
    },
  },
} satisfies Meta<typeof ToggleChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Off: a hairline border and dim text, brightening on hover so the row answers a mouse. */
export const Toggle: Story = { args: { label: "Owned", pressed: false } };

/** On: gold border and gold text, never a gold fill — a row of filled chips would out-shout
 *  the mana chips and the card art the direction reserves colour for. */
export const TogglePressed: Story = { args: { label: "Foil", pressed: true } };

/**
 * `hint` where the word will not fit: the five condition grades.
 *
 * `NM`/`LP`/`MP`/`HP`/`DMG` are printed on every marketplace listing the cards came from, and
 * five spelled-out grades are 400px of chrome above the table they filter. So the abbreviation
 * is drawn and the grade is spoken — and the accessible name **begins** with the visible text
 * (WCAG 2.5.3), so the chip is still addressable by what is written on it.
 *
 * The hint is lower-cased by the caller, not by the component: `CollectionFilterBar` passes
 * `CONDITION_LABEL[c].toLowerCase()`, so `Damaged` reaches the chip as `damaged`.
 *
 * What the `play` reads is an `aria-label` and a tooltip, and a screenshot shows neither: one
 * is only ever spoken, the other only ever hovered. The tooltip binds `describes: false` — its
 * words are already inside the aria-label above, so the panel carries no `role="tooltip"` and
 * is found by its stable id instead.
 */
export const WithHint: Story = {
  args: { label: "DMG", pressed: false, hint: "damaged" },
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByRole("button", { name: "DMG, damaged" });
    await expect(chip).toHaveTextContent("DMG");
    await userEvent.hover(chip);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("damaged");
  },
};

/**
 * `hint` where the word fits and the *consequence* does not — the deck editor's Built toggle,
 * the second and only other call site that passes one.
 *
 * "Built" is a whole word and it still needs a sentence, because this is the one switch in the
 * editor with an effect outside its own deck: a built deck's claims come off what every other
 * deck can reach. Same mechanism as `WithHint` and a different job for it, which is why the
 * prop is `hint` rather than `abbreviationOf`.
 */
export const WithHintExplaining: Story = {
  args: { label: "Built", pressed: true, hint: "Reserves your copies for this deck" },
};

/**
 * Three states in one chip — and the chip is still a two-state control.
 *
 * `ToggleChip` has exactly one boolean. The third state lives in the **label** the caller
 * passes: the search's owned filter cycles "off → owned → missing → off" (`useCardSearch`'s
 * `toggleOwned`, whose comment says exactly that), and the collection's flag filter does the
 * same with "Needs review"/"Not flagged". So an unpressed `Owned` cannot be mistaken for a
 * pressed `Missing`, because they are not the same word.
 *
 * Drawn as three snapshots rather than as a live cycle: the cycle is `useCardSearch`'s and
 * re-implementing it here would be a second copy of it that could quietly disagree.
 */
export const ThreeStatesInOneChip: Story = {
  // Inert, and required: `StoryObj<typeof meta>` demands the component's required props even
  // from a story whose `render` names its own children.
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <ToggleChip label="Owned" pressed={false} onClick={noop} />
      <ToggleChip label="Owned" pressed onClick={noop} />
      <ToggleChip label="Missing" pressed onClick={noop} />
    </div>
  ),
};

/**
 * The colour row at rest: `MANA_KEYS` is WUBRG **plus colourless**, six chips.
 *
 * Unpressed is the same chip dimmed to 60% rather than a different chip, so the row reads as
 * one control with some of it switched on — and a colourblind reader still has the symbol's
 * *shape*, which is what Wizards designed it to carry. 60% and not 40: below about half the
 * fills stop being cream/sky/bone/salmon/sage and become six shades of the same brown.
 */
export const Colours: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ColourRow initial={[]} />,
};

/** Two on, four off, so both chip states are in one screenshot. Pressed is the printed fill at
 *  full strength with a gold ring standing 2px off it — a ring, because gold means "on" as a
 *  ring and "focus" as an outline everywhere in this app. */
export const ColoursSelected: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ColourRow initial={["W", "U"]} />,
};

/**
 * Mana values, 0 through 8-or-more — and then X.
 *
 * `MANA_VALUES` is `0…8` and the last of those chips is open-ended: past Emrakul the tail is a
 * handful of cards nobody filters by exact cost, and the backend reads the chip the same way.
 *
 * **X is not one of them.** It is a second axis over the same question, drawn as the last chip
 * of the same group because it answers that question too: `cmc` counts `{X}` as zero, so a
 * `{X}{B}{B}{B}` is a 3 *and* an X, and a reader who presses both chips finds it once.
 */
export const ManaValues: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ManaValueRow initial={[]} />,
};

/**
 * Four on, including the open-ended one and X.
 *
 * The `play` reads what the chips are *called* rather than what is written on them: the
 * open-ended one is drawn `8+` and named "Mana value 8 or more", so the sign is drawn and the
 * meaning is spoken. Every other numeral is named after the exact cost it matches. X is the one
 * whose name is a whole sentence — a chip reading `X` beside one reading `8+` is a puzzle to
 * anyone who cannot see the group heading, and the letter stays inside the sentence so the chip
 * is still addressable by what is written on it (WCAG 2.5.3). An accessible name is not
 * something a screenshot can be read for.
 */
export const ManaValuesSelected: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ManaValueRow initial={[1, 2, 8]} x />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const open = canvas.getByRole("button", { name: "Mana value 8 or more" });
    await expect(open).toHaveTextContent("8+");
    await expect(open).toHaveAttribute("aria-pressed", "true");

    // Every other chip is named after the exact cost it matches, and says so plainly.
    await expect(canvas.getByRole("button", { name: "Mana value 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Mana value 0" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // One letter drawn, one sentence spoken — and on at the same time as three numerals,
    // which is the state an exclusive tenth chip could not reach.
    const x = canvas.getByRole("button", { name: "Cards with X in their mana cost" });
    await expect(x).toHaveTextContent("X");
    await expect(x).toHaveAttribute("aria-pressed", "true");
  },
};

/**
 * The one control on the row where exactly one of the pair is always on.
 *
 * Not a filter, and it rides the filter row anyway: it is the only other control that governs
 * the list below, and a second row holding one pair of buttons would be a whole band of chrome
 * above the art. Icon-only, because two 36px squares carry "grid or rows" at a glance in a way
 * two words on a busy row do not — so each carries its own `aria-label` and `title`.
 */
export const Layout: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <LayoutPair initial="grid" />,
};

/** Clear every filter at once, with the number of them on it. Press it and watch it go — that
 *  is the story. */
export const Reset: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ResettableAll initial={3} />,
};

/**
 * Greyed, and still there, when there is nothing to clear.
 *
 * Dimmed rather than absent, which is the trade this control is the wrong way round on until
 * you see it in a row: a button that spends most of its life greyed does teach the reader to
 * stop looking at it, and a button that *appears* on the first press takes its width out of the
 * `flex-1` search box beside it and slides every chip to its right left — under the finger that
 * just pressed one. The row must not move while it is being used. `aria-disabled` and not
 * `disabled`, like every other out-of-reach control here, so it keeps its place in the tab
 * order; the count is spoken rather than read off the badge, because an inline `<span>` joins
 * the accessible name with no separator before it.
 */
export const NothingToReset: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ResetAll count={0} onReset={noop} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reset = canvas.getByRole("button", { name: /^Reset all/ });
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(reset).toHaveAccessibleName("Reset all — 0 filters active");

    // Still a tab stop: `aria-disabled` says "cannot be pressed" without taking the control
    // out from under a keyboard reader mid-row. That the press is refused is
    // `FilterChips.test.tsx`'s to assert — the shared `noop` here is called by other stories.
    reset.focus();
    await expect(reset).toHaveFocus();
  },
};

/**
 * The exported class recipes, which have no component of their own.
 *
 * `FILTER_CONTROL` is the 36px height and the shared border/radius/transition, plus the press
 * dip; `FILTER_FIELD` is the same control **without** the dip, for the box the reader types
 * into; `FILTER_FOCUS` is the focus outline; `filterChipState` is the on/off pair. They are
 * exported because the controls that ride the filter row without being chips — the search box,
 * the format and sort `<select>`s, the layout pair, the deck editor's group-by buttons — must
 * sit on the same line as the chips, and a control that invents its own height sits 2px off it.
 * This is the only story that draws them together, so it is the only place that mismatch would
 * show.
 *
 * **The search box here is drawn with `FILTER_FIELD`, and that is the point of the pair.** A
 * chip is pressed and a field is typed into: the 3% dip that reads as a button going down
 * slides the field's own native ✕ out from under the pointer clearing it, which is issue #179.
 * The two recipes differ by that one utility and by nothing else, so the row still lines up.
 *
 * **The row's wrapping is not here.** `flex-wrap` lives on `FilterBar`'s and
 * `CollectionFilterBar`'s own containers, not on anything this module exports, so how a full
 * row breaks across lines is **Task 12's** story to tell.
 */
export const OneFamily: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-x-3 gap-y-2">
      <input
        type="search"
        aria-label="Search cards"
        placeholder="Search cards…"
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "min-w-56 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />
      <ManaValueRow initial={[2]} />
      <ToggleChip label="Owned" pressed onClick={noop} />
      <ResetAll count={2} onReset={noop} />
    </div>
  ),
};
