import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveFilterChip,
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  FiltersButton,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  RarityChip,
  ResetAll,
  ToggleChip,
} from "./FilterChips";

describe("ToggleChip", () => {
  it("says what it is and whether it is on", async () => {
    const onClick = vi.fn();
    render(<ToggleChip label="Owned" pressed={false} onClick={onClick} />);

    const chip = screen.getByRole("button", { name: "Owned" });
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    expect(onClick).toHaveBeenCalled();
  });

  it("shows its on state without relying on colour alone", () => {
    render(<ToggleChip label="Foil" pressed onClick={vi.fn()} />);

    // The border moves to gold *and* `aria-pressed` says so — the gold alone would be a
    // state only a sighted reader with a good monitor can read.
    const chip = screen.getByRole("button", { name: "Foil" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveClass("border-accent");
  });

  /**
   * An option that would leave nothing is greyed and **kept**, per `features/search/facets.ts`:
   * an option that vanishes reads as a control that broke, where a greyed one reads as a fact
   * about the card in front of you.
   *
   * Both halves are asserted because either alone is a control that lies. `aria-disabled` says
   * so — and unlike `disabled` it does not stop the browser firing the click, so a chip that
   * only wore the attribute would still be pressable by every pointer in the app.
   */
  it("says it is out of reach and refuses the press", async () => {
    const onClick = vi.fn();
    render(<ToggleChip label="Showcase" pressed={false} disabled onClick={onClick} />);

    const chip = screen.getByRole("button", { name: "Showcase" });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).toHaveClass("opacity-45");

    await userEvent.click(chip);

    expect(onClick).not.toHaveBeenCalled();
  });

  /**
   * **It keeps its tab stop.** `aria-disabled` rather than `disabled` is the whole reason —
   * a reader sweeping the filter row still reaches the option and still hears its count, which
   * is where the "0 printings" the greying stands for is actually said.
   */
  it("stays reachable by the caret", () => {
    render(<ToggleChip label="Showcase" pressed={false} disabled onClick={vi.fn()} />);

    const chip = screen.getByRole("button", { name: "Showcase" });
    expect(chip).not.toHaveAttribute("disabled");
    chip.focus();
    expect(chip).toHaveFocus();
  });

  /** Nothing is said when there is nothing to say — the common case, on every other chip. */
  it("says nothing about reach when it is reachable", () => {
    render(<ToggleChip label="Foil" pressed={false} onClick={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Foil" })).not.toHaveAttribute("aria-disabled");
  });
});

/**
 * The reason these live in one module rather than in `FilterBar`: the collection view gets
 * *the same filter row*, not a lookalike. Every control in it is 36px tall and takes the
 * same gold focus outline, and the two shared strings are what makes that true by
 * construction instead of by three people copying a class list.
 */
describe("the shared filter row", () => {
  /**
   * The bordered chips only. `ManaChip` is deliberately outside this: it is a 36px circle
   * carrying a printed symbol on its own fill, and its focus outline stands 5px off rather
   * than 2 so that a chip which is both focused and pressed shows the outline clear of the
   * ring. One exemption, for a reason, rather than a rule with no exceptions and no chips.
   */
  it("gives the bordered chips one height and one focus outline", () => {
    render(
      <>
        <ToggleChip label="Owned" pressed={false} onClick={vi.fn()} />
        {/* X wired, so the sweep below covers the tenth chip too: it is drawn by the same
            component as its neighbours and has to stay indistinguishable from them. */}
        <ManaValueChips selected={[]} onToggle={vi.fn()} xSelected={false} onToggleX={vi.fn()} />
        <ResetAll count={1} onReset={vi.fn()} />
      </>,
    );

    // `h-9` or `size-9`: the square chips set both dimensions at once, and `cn`'s
    // tailwind-merge drops the `h-9` that `FILTER_CONTROL` contributed as the redundant
    // half of that pair. Both are 36px, which is the thing that has to be true.
    expect(FILTER_CONTROL).toContain("h-9");
    const outline = FILTER_FOCUS.split(" ");
    for (const control of screen.getAllByRole("button")) {
      expect(control.className, control.textContent ?? "").toMatch(/\b(h-9|size-9)\b/);
      expect(control, control.textContent ?? "").toHaveClass(...outline);
    }
  });

  /**
   * **The mana-value row wraps, and the narrowest surface that draws it is what says so.**
   *
   * Ten `size-9` chips with `gap-1` between them is `10 × 36 + 9 × 4` = **396px**. The widest
   * place this row appears is not a filter bar across the window — it is the deck editor's
   * **docked search panel, 384px**, whose content box is about 371. Unwrapped, the group is a
   * flex item that cannot shrink below its own min-content, so it hung **25px** out of the
   * panel; the editor is `overflow-y-auto`, which computes `overflow-x` to `auto`, and those
   * 25px were a horizontal scrollbar across the whole deck builder at *every* window width —
   * measured in the shipped window 2026-08-14 as `scrollWidth` 1042 against `clientWidth` 1017
   * at 1280×800 and 2322 against 2297 at 2560×1400, and 0 against both after `flex-wrap`.
   *
   * **The X chip is what tipped it**: nine numerals came to 356 and fitted, so this row was
   * correct right up until it grew a tenth chip, and nothing went red.
   *
   * jsdom lays nothing out, so the arithmetic is asserted as arithmetic and the wrap as the
   * class that permits it — which is the pair a test here can honestly hold. The width is read
   * off the chips actually rendered rather than typed, so a chip added or resized moves it.
   */
  it("lets the mana-value row wrap, because ten chips are wider than the docked panel", () => {
    render(
      <ManaValueChips selected={[]} onToggle={vi.fn()} xSelected={false} onToggleX={vi.fn()} />,
    );

    const group = screen.getByRole("group", { name: "Mana value" });
    expect(group).toHaveClass("flex-wrap");

    // `size-9` is 36px and `gap-1` is 4px — both read off the classes the chips carry, so this
    // fails if either changes rather than pinning numbers nothing else knows.
    const chipCount = within(group).getAllByRole("button").length;
    const CHIP = 36;
    const GAP = 4;
    const PANEL_CONTENT = 371; // `PANEL_WIDTH_PX` 384 less the panel's own padding.
    expect(group.className).toContain("gap-1");
    expect(chipCount * CHIP + (chipCount - 1) * GAP).toBeGreaterThan(PANEL_CONTENT);
  });
});

/**
 * X, which is not a mana value and rides the mana-value group anyway.
 *
 * It is the last chip of that group because it answers the question the group asks — "what
 * does this cost" — and `cmc` counts `{X}` as zero, so the two axes overlap rather than
 * compete: `{X}{B}{B}{B}` is a 3 *and* an X, and both chips find it.
 */
describe("the X chip", () => {
  const chips = (over: Partial<Parameters<typeof ManaValueChips>[0]> = {}) => (
    <ManaValueChips
      selected={[]}
      onToggle={vi.fn()}
      xSelected={false}
      onToggleX={vi.fn()}
      {...over}
    />
  );

  /**
   * The letter is drawn and the sentence is spoken. A chip reading `X` next to one reading
   * `8+` is a puzzle to anyone who cannot see the group heading — and the visible text is
   * inside the spoken name (WCAG 2.5.3), so the chip is still addressable by what is on it.
   */
  it("draws one letter and says the whole thing", async () => {
    const onToggleX = vi.fn();
    render(chips({ onToggleX }));

    const chip = screen.getByRole("button", { name: "Cards with X in their mana cost" });
    expect(chip).toHaveTextContent("X");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    expect(onToggleX).toHaveBeenCalled();
  });

  /** Last, and inside the group — a stray control beside it would read as a different
   *  question, which is exactly what it is not. */
  it("rides at the end of the mana-value group", () => {
    render(chips());

    const group = screen.getByRole("group", { name: "Mana value" });
    const names = within(group)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));

    expect(names).toHaveLength(10);
    expect(names[8]).toBe("Mana value 8 or more");
    expect(names[9]).toBe("Cards with X in their mana cost");
  });

  /**
   * Both axes at once, which is the whole point of the chip being additive: a reader who
   * wants "three-drops, and anything with an X" presses both and the row says so.
   */
  it("is on independently of the numerals", () => {
    render(chips({ selected: [3], xSelected: true }));

    expect(screen.getByRole("button", { name: "Mana value 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Cards with X in their mana cost" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * `aria-disabled` and never the attribute — a `disabled` button leaves the tab order, and
   * the filter row greys as the reader types. The caller's sentence replaces the plain label
   * outright rather than joining it, so a greyed chip explains itself in the one voice the
   * rest of the row uses.
   */
  it("greys without leaving the tab order, and says why", async () => {
    const onToggleX = vi.fn();
    render(
      chips({
        onToggleX,
        xDisabled: true,
        xTitle: (label) => `${label} — nothing in this search`,
      }),
    );

    const chip = screen.getByRole("button", {
      name: "Cards with X in their mana cost — nothing in this search",
    });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toBeDisabled();

    await userEvent.click(chip);

    expect(onToggleX).not.toHaveBeenCalled();
  });

  /** No toggle, no chip. A chip that reports nothing is worse than a filter the row does not
   *  offer, so the two cannot come apart — which is what lets the numeric row be drawn alone. */
  it("is absent when nothing is listening for it", () => {
    render(<ManaValueChips selected={[]} onToggle={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Cards with X/ })).not.toBeInTheDocument();
  });
});

describe("ResetAll", () => {
  /**
   * It holds its place with nothing to clear, because the alternative moves the row: both
   * filter bars put a `flex-1` search box left of the chips, so a button that appeared on the
   * first press would take its width out of that box and slide every chip to its right left,
   * under the finger that just pressed one.
   */
  it("holds its place, greyed, when there is nothing to reset", () => {
    const { rerender } = render(<ResetAll count={0} onReset={vi.fn()} />);
    const reset = screen.getByRole("button", { name: /^Reset all/ });
    expect(reset).toHaveAttribute("aria-disabled", "true");

    rerender(<ResetAll count={2} onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Reset all/ })).not.toHaveAttribute("aria-disabled");
  });

  /** `aria-disabled`, never the attribute — the button is still focusable, and still ignores
   *  the press. */
  it("stays reachable and does nothing when it is greyed", async () => {
    const onReset = vi.fn();
    render(<ResetAll count={0} onReset={onReset} />);

    const reset = screen.getByRole("button", { name: /^Reset all/ });
    reset.focus();
    expect(reset).toHaveFocus();

    await userEvent.click(reset);

    expect(onReset).not.toHaveBeenCalled();
  });

  it("counts kinds of filter, not values, and clears them", async () => {
    const onReset = vi.fn();
    render(<ResetAll count={3} onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: /reset all/i }));

    expect(onReset).toHaveBeenCalled();
  });

  /**
   * The badge is drawn and not spoken: left in the accessible name it arrives with no
   * separator before it — `"Reset all6"`, measured 2026-08-09 — which drawn-always would be
   * `"Reset all0"` on every quiet row in the app. The count is said in words instead, after
   * the visible label (WCAG 2.5.3).
   */
  it("says the count in words and draws it as a badge", () => {
    const { rerender } = render(<ResetAll count={0} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 0 filters active");
    expect(screen.getByRole("button")).toHaveTextContent("0");

    rerender(<ResetAll count={1} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 1 filter active");

    rerender(<ResetAll count={2} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 2 filters active");
    expect(screen.getByRole("button")).toHaveTextContent("2");
  });
});

describe("FiltersButton", () => {
  const button = () => screen.getByRole("button", { name: /filters/i });

  /**
   * **The border and the word are the count; the fill is the tray** — and the two are
   * independent, which is the whole of what this control was changed to say (2026-08-26). It used
   * to wear the gold border whether or not anything was on, so it was the one control on the row
   * drawn in the on-treatment while off; a reader sweeping the row for what is switched on found
   * it every time and had to read the badge to learn it was not.
   *
   * **The off pair is asserted against `filterChipState` rather than typed out**, because that is
   * the claim: this control wears the row's own recipe, not a lookalike. Typing `border-border`
   * here would keep passing if the component grew a hand-copied pair of its own and the recipe
   * then moved.
   *
   * `toHaveClass` reads `classList`, so these are real tokens rather than a substring of the
   * `className` string — a `hover:` variant would pass either way and is deliberately not
   * asserted here (it is a state jsdom cannot enter).
   */
  it("takes its border and word from the count, and its fill from the tray", () => {
    const off = filterChipState(false).split(" ");
    const on = filterChipState(true).split(" ");

    const { rerender } = render(
      <FiltersButton open={false} count={0} onToggle={vi.fn()} controls="tray" />,
    );

    // Nothing on: the row's own off treatment — a hairline and a dim word, like every other
    // bordered control here — and no fill.
    expect(button()).toHaveClass(...off);
    expect(button()).not.toHaveClass("border-accent", "text-accent", "bg-surface");

    rerender(<FiltersButton open={false} count={2} onToggle={vi.fn()} controls="tray" />);
    expect(button()).toHaveClass(...on);
    expect(button()).not.toHaveClass("bg-surface");

    // Open with nothing on: the tray's own grey, and still no gold — gold on this row means "a
    // filter is on", which is the border's sentence rather than the fill's.
    rerender(<FiltersButton open count={0} onToggle={vi.fn()} controls="tray" />);
    expect(button()).toHaveClass("bg-surface", ...off);
    expect(button()).not.toHaveClass("border-accent", "text-accent");

    // **The word stays gold with the tray up**, which is the one thing opening must not undo:
    // the count is still on, and a reader who opened the tray to change it has not changed it
    // yet. Both readings are drawn at once, which is `filterChipState`'s rule too.
    rerender(<FiltersButton open count={2} onToggle={vi.fn()} controls="tray" />);
    expect(button()).toHaveClass("bg-surface", ...on);
  });

  /** The badge is drawn only when there is something to say — a `0` on every quiet row teaches
   *  the eye to skip the control it is attached to. The digit is spelled into the name, because
   *  left to the accname algorithm this announces as `"Filters2"`. */
  it("draws no badge at zero, and spells the count into its name", () => {
    const { rerender } = render(
      <FiltersButton open={false} count={0} onToggle={vi.fn()} controls="tray" />,
    );
    expect(button()).toHaveAccessibleName("Show filters — 0 active");
    expect(button()).not.toHaveTextContent("0");

    rerender(<FiltersButton open count={2} onToggle={vi.fn()} controls="tray" />);
    expect(button()).toHaveAccessibleName("Hide filters — 2 active");
    expect(button()).toHaveTextContent("2");
  });
});

/**
 * **Controls a finger can hit** — the first consumer of the `coarse:` variant and
 * `--target-min`, which shipped in PR #274 declared and deliberately unapplied so this decision
 * could take them.
 *
 * **Every assertion here is a class pin and none of them is a pixel.** jsdom applies no media
 * query and loads no stylesheet, so nothing about a rendered *size* can go red in this file —
 * and worse, a `coarse:` utility Tailwind does not accept emits **nothing at all**, silently,
 * with `tsc` and this suite both green. The sufficient check is a `grep` of `dist/assets/*.css`
 * after a production build, recorded with its output in `docs/reference/frontend-design.md`;
 * this suite's job is to hold the classes still once that grep has said they compile.
 *
 * `classList.contains` and never `className.includes`: a substring test over a class list passes
 * on a prefix of some other class and reads as a rule that is present when it is not.
 */
const FLOOR_H = "coarse:min-h-[var(--target-min)]";
const FLOOR_W = "coarse:min-w-[var(--target-min)]";

/** The filter bar's own narrow-column spelling, quoted from `FilterBar.tsx:1021`. */
const BAR_CHIP_CLASS = "size-8 @min-[640px]/fb:size-9";

describe("the filter row grows for a finger", () => {
  /**
   * The floor is on `FILTER_SHAPE`, so every control built out of the family carries it rather
   * than each one remembering to — which is the same argument that put the 36px there.
   *
   * **A minimum, not a size, and that is the load-bearing half.** 9a's finding was that
   * stacking `coarse:` onto a container variant has no specificity answer: two classes, each
   * one class deep, each inside one at-rule, so source order in the emitted sheet decides and a
   * conditional spelling is a coin toss. `min-height` is not in that contest — it beats `height`
   * in the cascade whatever order the two are emitted in — so the floor holds against
   * `FILTER_CONTROL`'s `h-9` and against the `size-8` the bar hands the mana-value group without
   * either of them knowing it exists.
   */
  it("puts the 44px floor on every control in the family", () => {
    render(
      <>
        <ToggleChip label="Owned" pressed={false} onClick={vi.fn()} />
        <RarityChip rarity="mythic" pressed={false} onClick={vi.fn()} />
        <ManaChip symbol="W" pressed={false} onClick={vi.fn()} />
        <ManaValueChips
          selected={[]}
          onToggle={vi.fn()}
          onToggleX={vi.fn()}
          chipClass={BAR_CHIP_CLASS}
        />
        <LayoutToggle view="grid" onChange={vi.fn()} />
        <ResetAll count={1} onReset={vi.fn()} />
        <FiltersButton open={false} count={0} onToggle={vi.fn()} controls="tray" />
      </>,
    );

    const controls = screen.getAllByRole("button");
    // A sweep over nothing is a green test over an unswept row — the seven elements above draw
    // 1 + 1 + 1 + 10 + 2 + 1 + 1 buttons.
    expect(controls).toHaveLength(17);
    for (const control of controls) {
      expect(control.classList.contains(FLOOR_H), control.getAttribute("aria-label") ?? "").toBe(
        true,
      );
    }
  });

  /**
   * A square chip needs the other axis said too: a height alone leaves a 36px-wide button 44
   * tall, which is a target that clears WCAG 2.5.5 on one side and fails it on the other.
   *
   * **The mana-value chip is the one that could have lost it silently.** Its caller merges
   * `chipClass` last, deliberately, so a size clash resolves the caller's way — and the bar's
   * spelling is `size-8 @min-[640px]/fb:size-9`. This renders with that exact string to prove
   * tailwind-merge does not treat the caller's `size-*` as conflicting with a `min-w-*` and drop
   * the floor on the way through.
   */
  it("says both axes on the chips that are squares", () => {
    render(
      <>
        <ManaChip symbol="U" pressed={false} onClick={vi.fn()} />
        <ManaValueChips
          selected={[]}
          onToggle={vi.fn()}
          onToggleX={vi.fn()}
          chipClass={BAR_CHIP_CLASS}
        />
        <LayoutToggle view="grid" onChange={vi.fn()} />
      </>,
    );

    const squares = screen.getAllByRole("button");
    expect(squares).toHaveLength(13);
    for (const square of squares) {
      expect(square.classList.contains(FLOOR_W), square.getAttribute("aria-label") ?? "").toBe(
        true,
      );
    }

    // The caller's own size survives beside it — the floor is added to that argument, not
    // instead of it, so the chip is still 32px where there is a pointer.
    const mana = screen.getByRole("button", { name: "Mana value 3" });
    expect(mana.classList.contains("size-8")).toBe(true);
  });

  /**
   * **Raising the mana-value group costs it no extra line**, which is why it can be raised at
   * all. Arithmetic, not a measurement: jsdom lays nothing out. In a 350px content box — a 390px
   * window less `main`'s `p-5` — ten chips at `gap-1` wrap to two rows either way. At the bar's
   * narrow 32 the first row holds nine (9 × 32 + 8 × 4 = 320, and ten would be 356); at 44 it
   * holds seven (7 × 44 + 6 × 4 = 332, and eight would be 380).
   */
  it("costs the mana-value group no extra line", () => {
    render(
      <ManaValueChips
        selected={[]}
        onToggle={vi.fn()}
        onToggleX={vi.fn()}
        chipClass={BAR_CHIP_CLASS}
      />,
    );

    const group = screen.getByRole("group", { name: "Mana value" });
    expect(group).toHaveClass("flex-wrap");

    const chips = within(group).getAllByRole("button").length;
    const GAP = 4;
    const WALL = 350;
    const rows = (chip: number) => {
      const perRow = Math.max(1, Math.floor((WALL + GAP) / (chip + GAP)));
      return Math.ceil(chips / perRow);
    };
    expect(rows(32)).toBe(2);
    expect(rows(44)).toBe(rows(32));
  });

  /**
   * **The one place the floor and the stated design conflict, and the target grows rather than
   * the chip.** 26px is the whole argument for this band existing — it is what tells "a filter
   * you are narrowed by" from "a control that sets one" — so the pill stays 26 and a transparent
   * `::before` centred on it carries the 44. WCAG 2.5.5 measures the target, not the ink.
   *
   * `content-['']` is pinned with the rest: a pseudo-element with no `content` is not generated,
   * and the failure would be a chip that is quietly still 26px with nothing on screen or in this
   * file saying so.
   */
  it("grows the stated-filter chip's target without growing the chip", () => {
    render(<ActiveFilterChip label="Colour: Blue, Red" onRemove={vi.fn()} />);

    const chip = screen.getByRole("button", { name: "Remove filter — Colour: Blue, Red" });

    // The drawn pill is untouched — 26px, and not the family's 36 or the finger's 44.
    expect(chip.classList.contains("h-[1.625rem]")).toBe(true);
    expect(chip.classList.contains(FLOOR_H)).toBe(false);

    // The target is the pseudo-element, and it needs every one of these to exist at all.
    for (const cls of [
      "relative",
      "coarse:before:absolute",
      "coarse:before:h-[var(--target-min)]",
      "coarse:before:min-w-[var(--target-min)]",
      "coarse:before:content-['']",
    ]) {
      expect(chip.classList.contains(cls), cls).toBe(true);
    }
  });
});
