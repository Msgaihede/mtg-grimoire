import { useId, useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import type { SearchView } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  ColorExactChip,
  CountPill,
  FILTER_FIELD,
  FILTER_FOCUS,
  FILTER_LABEL,
  filterChipState,
  FiltersButton,
  JoinedChoices,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  STACK_PRINTINGS,
  StackPrintingsToggle,
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
 * here verbatim from `FilterBar`, which is the one row every card view draws, because
 * a story of six loose chips would be a row this app never draws.
 */
function ColourRow({
  initial,
  strict: strictSeed = false,
}: {
  initial: readonly ManaKey[];
  strict?: boolean;
}) {
  const [on, setOn] = useState<readonly ManaKey[]>(initial);
  const [strict, setStrict] = useState(strictSeed);
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
      <ColorExactChip pressed={strict} onClick={() => setStrict((s) => !s)} />
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
 * One reading of the disclosure, captioned, over the tray it actually opens.
 *
 * The stub panel is not decoration: the open button's fill **is** `FilterBar`'s tray fill, and
 * that only reads as one object when the two are drawn touching. The `count` is the search's and
 * therefore seeded rather than owned — this wrapper holds the half the button owns, which is
 * whether the tray is up, so a reader can press each case and watch the fill arrive and go.
 */
function Disclosure({
  caption,
  count,
  initialOpen = false,
}: {
  caption: string;
  count: number;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const trayId = useId();
  return (
    <div className="flex w-44 flex-col items-start gap-2">
      {/* `FILTER_LABEL`, the tray's own caption recipe, rather than four utilities copied
          out of it — this row of cases is a tray of unlike things too. */}
      <span className={FILTER_LABEL}>{caption}</span>
      <FiltersButton
        open={open}
        count={count}
        controls={trayId}
        onToggle={() => setOpen((was) => !was)}
      />
      {/* `FilterBar`'s tray, cut down to the one thing this story is about — its fill. Kept in
          the tree while shut rather than unmounted, so `aria-controls` above points at something
          real the way it does on the real row. */}
      <div
        id={trayId}
        hidden={!open}
        className="w-full rounded-lg border border-border bg-surface px-4 py-3.5 text-sm text-dim"
      >
        The tray.
      </div>
    </div>
  );
}

/**
 * A two-way partition as one joined control — the Universe cell's shape: the two answers split the
 * printings, so pressing the one that is on turns the filter off rather than pressing the other.
 */
function PartitionPair() {
  const [on, setOn] = useState<"beyond" | "within" | undefined>(undefined);
  const press = (value: "beyond" | "within") => setOn((was) => (was === value ? undefined : value));
  return (
    <div className="w-72">
      <JoinedChoices
        label="Universe"
        choices={[
          {
            value: "beyond",
            label: "Beyond",
            hint: "Universes Beyond",
            pressed: on === "beyond",
            onClick: () => press("beyond"),
          },
          {
            value: "within",
            label: "Within",
            hint: "Universes Within",
            pressed: on === "within",
            onClick: () => press("within"),
          },
        ]}
      />
    </div>
  );
}

/**
 * Three ORed choices joined — the Finish cell's shape, one segment greyed by its count: the
 * choices do not partition, so each segment presses on its own, and a greyed one stays a tab stop.
 */
function OrTriple() {
  const [on, setOn] = useState<readonly string[]>(["foil"]);
  const toggle = (v: string) =>
    setOn((vs) => (vs.includes(v) ? vs.filter((x) => x !== v) : [...vs, v]));
  const rows = [
    { value: "nonfoil", label: "Nonfoil" },
    { value: "foil", label: "Foil" },
    { value: "etched", label: "Etched", disabled: true, title: "Etched — nothing in this search" },
  ];
  return (
    <div className="w-80">
      <JoinedChoices
        label="Finish"
        choices={rows.map((r) => ({
          ...r,
          pressed: on.includes(r.value),
          onClick: () => toggle(r.value),
        }))}
      />
    </div>
  );
}

/** The switch over its own state, pressed — stacked — to start with, as every wall opens. */
function StackSwitch({ labelClass }: { labelClass?: string }) {
  const [stacked, setStacked] = useState(true);
  return (
    <StackPrintingsToggle
      stacked={stacked}
      onToggle={() => setStacked((was) => !was)}
      labelClass={labelClass}
    />
  );
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
  // `FilterChips.tsx` is a family rather than a component: a row's worth of controls, plus the
  // class recipes that keep them one family — and Storybook takes one `component` per file.
  // `ToggleChip` is the plain member and the one with props worth a Controls panel; the rest
  // ride as subcomponents, which is what gives each of them a props table on this page. The
  // build carries react-docgen metadata for each of them — grepped in `storybook-static` — but
  // no eye has seen the page it feeds; that is Task 17's.
  //
  // No count of them is written here any more: `grep '^export function' FilterChips.tsx`
  // answers it, and the number that used to sit in this comment had been wrong since the
  // module last grew.
  component: ToggleChip,
  subcomponents: {
    ManaChip,
    ManaValueChips,
    LayoutToggle,
    ResetAll,
    FiltersButton,
    CountPill,
    JoinedChoices,
    StackPrintingsToggle,
  },
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
 * The hint is lower-cased by the caller, not by the component: `FilterBar`'s Condition cell passes
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
 * `hint` where the word fits and the *meaning* does not — the deck history's `Other` chip.
 *
 * "Other" is a whole word and it still needs a sentence, because it names a residue rather than
 * a thing: the band an audit row falls into when this version of the app has no name for its
 * kind. A reader can guess what "Adds" filters and nobody can guess this one — and the chip is
 * drawn at all only when the history actually holds such a row. Same mechanism as `WithHint`
 * and a different job for it, which is why the prop is `hint` rather than `abbreviationOf`.
 *
 * The third call site does a third job again: `CategoriesDialog` passes the category's own name
 * beside a chip reading "Active", so eight of them are eight addressable controls rather than
 * one control repeated eight times.
 */
export const WithHintExplaining: Story = {
  args: {
    label: "Other",
    pressed: true,
    hint: "changes this version of the app has no name for",
  },
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
 * The colour row at rest: `MANA_KEYS` is WUBRG **plus colourless**, six chips — and the round
 * `Exact` chip closing the group, which is the reading the six get rather than a seventh colour.
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
 * `ColorExactChip` pressed, closing the row: the colour chips' circle, press and gold ring on the
 * app's own surface, with lucide's `squares-intersect` (AND) that turns to `squares-unite` (OR)
 * when it is pressed off. Not a pastel fill, because in this row
 * a filled circle *is* a colour, and a pale one reads as White or Colourless.
 */
export const ColoursExact: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <ColourRow initial={["W", "U"]} strict />,
  play: async ({ canvasElement }) => {
    const exact = within(canvasElement).getByRole("button", { name: /^(Exact|Within)\b/ });
    await expect(exact).toHaveAttribute("aria-pressed", "true");
    // The glyph is the reading, so it has to move with the press — AND on, OR off.
    await expect(exact.querySelector("svg.lucide-squares-intersect")).not.toBeNull();
    await userEvent.click(exact);
    await expect(exact).toHaveAttribute("aria-pressed", "false");
    await expect(exact.querySelector("svg.lucide-squares-unite")).not.toBeNull();
    await expect(exact.querySelector("svg.lucide-squares-intersect")).toBeNull();
    await expect(exact).toHaveAccessibleName(
      "Within — cards whose color identity fits within these colors",
    );
  },
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

/** Clear every filter at once, with the number of them on it: a reset glyph, the word `Reset`
 *  and the count pill, borderless — a quiet action at the end of the bar (the Filter bar board,
 *  2026-11). Press it and watch the pill go grey — that is the story. */
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
 * order; the count is spoken rather than read off the pill, because an inline `<span>` joins
 * the accessible name with no separator before it.
 *
 * **The pill is drawn at 0**, grey ({@link CountPills}): a button that grew a badge with its first
 * filter would move the bar on that very press.
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
    // The word is `Reset` and the pill reads `0` — the name is the longer sentence.
    await expect(within(reset).getByText("Reset")).toBeInTheDocument();
    await expect(reset.querySelector("[data-count-pill]")).toHaveTextContent("0");

    // Still a tab stop: `aria-disabled` says "cannot be pressed" without taking the control
    // out from under a keyboard reader mid-row. That the press is refused is
    // `FilterChips.test.tsx`'s to assert — the shared `noop` here is called by other stories.
    reset.focus();
    await expect(reset).toHaveFocus();
  },
};

/**
 * The way into every filter that is not on the bar, in the four readings it has — and the point
 * of the picture is that the two treatments are **independent**.
 *
 * **Gold is a count or an open popup; the fill is the popup.** The pair is
 * `filterChipState(count > 0 || open)` itself rather than a copy — a hairline and a dim word with
 * nothing on and the popup shut, brightening under the mouse, exactly like the `ToggleChip` two
 * stories up; gold border and gold word with a filter on **or the popup open** (the Filter bar
 * board, 2026-11: the button that opened the overlay reads as pressed while it is up). An open
 * popup adds its own `bg-surface` too, which is why each case here is drawn over the panel it
 * opens. The count pill is drawn in every case — grey at 0, gold at N.
 *
 * **It was gold-bordered at rest until 2026-08-26**, on the argument that a disclosure has to say
 * "there is more in here" before anything has been pressed. What that cost was the row's one
 * consistent sentence: this was the only control in it drawn in the on-treatment while off, so a
 * reader sweeping for what was switched on found it every single time and had to read the badge
 * to learn it was not. The pill is now the only thing that says how much is on.
 *
 * **The first fix overshot and went borderless**, for one commit. Dropping the gold at rest was
 * right; dropping the hairline with it left the only control on the row with no edge at all, so
 * it read as a label rather than as something to press. The bar is that it looks like the other
 * buttons, and the other buttons have a border.
 */
export const Disclosures: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-wrap items-start gap-6">
      <Disclosure caption="Quiet" count={0} />
      <Disclosure caption="2 on" count={2} />
      <Disclosure caption="Open" count={0} initialOpen />
      <Disclosure caption="Open, 2 on" count={2} initialOpen />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [quiet, active, open, both] = canvas.getAllByRole("button", { name: /filters/i });

    // The row's own recipe, asked for rather than typed out — the claim is that this control
    // wears `filterChipState` and not a lookalike. `toHaveClass` reads `classList`, so these are
    // real tokens rather than a substring of `className`, which is what makes the negatives mean
    // anything.
    const off = filterChipState(false).split(" ");
    const on = filterChipState(true).split(" ");

    await expect(quiet).toHaveClass(...off);
    await expect(quiet).not.toHaveClass("border-accent", "text-accent", "bg-surface");

    await expect(active).toHaveClass(...on);
    await expect(active).not.toHaveClass("bg-surface");

    // Open reads as pressed whether or not anything is on, over the popup's own fill.
    await expect(open).toHaveClass("bg-surface", ...on);
    await expect(both).toHaveClass("bg-surface", ...on);

    // The pill is always there, and only its colour says whether anything is on.
    await expect(quiet.querySelector("[data-count-pill]")).toHaveTextContent("0");
    await expect(quiet.querySelector("[data-count-pill]")).toHaveClass("bg-border");
    await expect(active.querySelector("[data-count-pill]")).toHaveTextContent("2");
    await expect(active.querySelector("[data-count-pill]")).toHaveClass("bg-accent");

    // Pressing the quiet one opens its panel and lights the button without inventing a count.
    await userEvent.click(quiet);
    await expect(quiet).toHaveClass("bg-surface", ...on);
    await expect(quiet).toHaveAccessibleName("Hide filters — 0 active");
    await expect(quiet.querySelector("[data-count-pill]")).toHaveTextContent("0");
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
 * `FilterBar`'s own containers, not on anything this module exports, so how a full
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

/**
 * **`CountPill` — the count on Filters and on Reset, always drawn.**
 *
 * One fixed width (22px, two digits in the mono face), grey in the border's colour at 0 and gold
 * at N — the Filter bar board's rule (2026-11) that a button never changes width when it is used:
 * a badge that appeared with the first filter moved everything beside it on that very press.
 * `aria-hidden`, because each button spells its count into its own name.
 */
export const CountPills: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-3">
      <CountPill count={0} />
      <CountPill count={3} />
      <CountPill count={12} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pills = [...canvasElement.querySelectorAll("[data-count-pill]")];
    await expect(pills.map((p) => p.textContent)).toEqual(["0", "3", "12"]);
    for (const p of pills) {
      await expect(p).toHaveAttribute("aria-hidden", "true");
      // The same box at every count — the width is the class, never the digits.
      await expect(p).toHaveClass("w-[22px]");
    }
    await expect(pills[0]).toHaveClass("bg-border", "text-dim");
    await expect(pills[1]).toHaveClass("bg-accent", "text-accent-foreground");
    await expect(pills[2]).toHaveClass("bg-accent");
  },
};

/**
 * **`JoinedChoices` as a partition — the Universe cell.**
 *
 * Two answers that split the printings, drawn as one framed control rather than two loose chips
 * (the Filter bar board, 2026-11: separate chips read as that many unrelated switches). Each
 * segment is its own `aria-pressed` button; the caller decides what a press means, and here
 * pressing the one that is on turns the filter off, so the third state is one press away.
 */
export const JoinedPartition: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <PartitionPair />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole("group", { name: "Universe" });
    const beyond = within(group).getByRole("button", { name: "Beyond, Universes Beyond" });
    const within_ = within(group).getByRole("button", { name: "Within, Universes Within" });
    await expect(beyond).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(beyond);
    await expect(beyond).toHaveAttribute("aria-pressed", "true");
    await expect(within_).toHaveAttribute("aria-pressed", "false");

    // The other answer replaces it rather than joining it…
    await userEvent.click(within_);
    await expect(beyond).toHaveAttribute("aria-pressed", "false");
    await expect(within_).toHaveAttribute("aria-pressed", "true");

    // …and pressing the one that is on is the way off.
    await userEvent.click(within_);
    await expect(within_).toHaveAttribute("aria-pressed", "false");
  },
};

/**
 * **`JoinedChoices` over ORed choices — the Finish cell, one segment greyed.**
 *
 * The same control when the choices do not partition (Finish and Border: a printing published
 * in two finishes answers both), so each segment presses on its own. A segment whose count says
 * it would return nothing is `aria-disabled`, refuses the press and **stays in the tab order**,
 * the row's rule for every out-of-reach control.
 */
export const JoinedOr: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => <OrTriple />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole("group", { name: "Finish" });
    await expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Nonfoil", "Foil", "Etched"]);

    const nonfoil = within(group).getByRole("button", { name: "Nonfoil" });
    const foil = within(group).getByRole("button", { name: "Foil" });
    await userEvent.click(nonfoil);
    // Both on at once: an OR, not a partition.
    await expect(nonfoil).toHaveAttribute("aria-pressed", "true");
    await expect(foil).toHaveAttribute("aria-pressed", "true");

    const etched = within(group).getByRole("button", { name: "Etched — nothing in this search" });
    await expect(etched).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(etched);
    await expect(etched).toHaveAttribute("aria-pressed", "false");
    etched.focus();
    await expect(etched).toHaveFocus();
  },
};

/**
 * **`StackPrintingsToggle` — pressed is one tile per card, the default.**
 *
 * It was `Show all printings` until the Filter bar board (2026-11), with the opposite meaning: a
 * switch that is on for the ordinary wall reads more plainly than one that has to be turned on to
 * leave it. The hooks keep `allPrintings` and the bar inverts it here. On every bar at every width;
 * below the widest band the word goes (`labelClass`) and the name stays, so the icon is the same
 * button to a screen reader and to a test — the second one here is that narrow reading.
 */
export const StackPrintings: Story = {
  args: { label: "Owned", pressed: false },
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-3">
      <StackSwitch />
      <StackSwitch labelClass="hidden" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [wide, narrow] = canvas.getAllByRole("button", { name: STACK_PRINTINGS });
    await expect(wide).toHaveAttribute("aria-pressed", "true");
    await expect(within(wide).getByText(STACK_PRINTINGS)).not.toHaveClass("hidden");
    // The narrow one draws the glyph alone and keeps the whole name.
    await expect(within(narrow).getByText(STACK_PRINTINGS)).toHaveClass("hidden");
    await expect(narrow).toHaveAccessibleName(STACK_PRINTINGS);

    await userEvent.click(wide);
    await expect(wide).toHaveAttribute("aria-pressed", "false");
    // On is the row's gold; off is the hairline.
    await expect(wide).toHaveClass(...filterChipState(false).split(" "));
    await expect(narrow).toHaveClass(...filterChipState(true).split(" "));
  },
};
