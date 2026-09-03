import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsNav } from "./SettingsNav";

type Props = ComponentProps<typeof SettingsNav>;

/**
 * The rail with nothing to say: standing on the first group, an empty box, both badges at zero.
 *
 * The spies come back so a test can assert on the one it is about **and** on the one it is not.
 * Half of what this component promises `SettingsPage` is negative — a press reports a group and
 * does not clear the query, because clearing it is the page's job — and a negative promise needs
 * the other spy in hand to check.
 */
function setup(over: Partial<Props> = {}) {
  const props: Props = {
    group: "updates",
    onGroup: vi.fn(),
    query: "",
    onQuery: vi.fn(),
    badges: { review: 0, errors: 0 },
    ...over,
  };
  render(<SettingsNav {...props} />);
  return props;
}

const entries = () => screen.getAllByRole("button");
const box = () => screen.getByRole("searchbox", { name: "Search settings" });

describe("SettingsNav", () => {
  /**
   * The six entries, in the order `nav.ts` declares them.
   *
   * **The expected labels are written out rather than derived from `GROUP_ORDER`**, which is the
   * whole of what makes this test able to fail: an assertion that maps the same constant the
   * component maps passes over a rail rendered backwards, sorted alphabetically, or drawn from a
   * different module entirely. Six literals in a fixed order cannot agree with a bug.
   */
  it("draws the six groups in the rail's own order", () => {
    setup();

    expect(entries().map((entry) => entry.textContent)).toEqual([
      "Updates",
      "Card data",
      "Sync",
      "Tags",
      "Storage and data",
      "Errors",
    ]);
  });

  /** The current group, and only it. */
  it("marks the group it was given as the current one", () => {
    setup({ group: "storage" });

    expect(screen.getByRole("button", { current: "page" })).toHaveTextContent("Storage and data");
    expect(screen.queryAllByRole("button", { current: "page" })).toHaveLength(1);
  });

  /**
   * **A query outranks the group**, which is `visiblePanels`' one stated rule seen from the
   * rail's side: while the box has words in it the pane is drawing panels from every group at
   * once, so an entry marked current would be pointing at a group whose panels are not
   * necessarily the ones on screen. The group itself is unchanged underneath — the page hands it
   * straight back the moment the box is empty again — so this is a fact about the *mark* and not
   * about the state.
   */
  it("marks no entry current while the box has words in it", () => {
    setup({ group: "storage", query: "dropbox" });

    expect(screen.queryAllByRole("button", { current: "page" })).toHaveLength(0);
  });

  /**
   * A box holding only spaces is an empty box — `searching`'s rule, and the reason this test
   * exists beside the one above rather than inside it: a guard written as `query !== ""` passes
   * that one and fails this.
   */
  it("still marks the current entry when the box holds only whitespace", () => {
    setup({ group: "storage", query: "   " });

    expect(screen.getByRole("button", { current: "page" })).toHaveTextContent("Storage and data");
  });

  /**
   * The count, on the entry whose group names that badge — and **on no other**, which is the
   * half a single assertion would miss.
   *
   * **The name and the text content are asserted separately on purpose**: they come from two
   * different places. The visible figure is `aria-hidden`, and the name is one written string —
   * because a label and a number in two sibling elements compute to `Sync2`, the gap that
   * separates them on screen being a layout property while a name is computed from trimmed text.
   * A test reading only the name would pass on a rail that drew no badge at all.
   */
  it("draws a badge on the group that names it, with the figure in the name too", () => {
    setup({ badges: { review: 2, errors: 41 } });

    expect(screen.getByRole("button", { name: "Sync (2)" })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Errors (41)" })).toHaveTextContent("41");
    // A group with no badge of its own is untouched by either count.
    expect(screen.getByRole("button", { name: "Tags" })).toBeInTheDocument();
  });

  /**
   * Zero draws nothing at all, rather than a `0`.
   *
   * A rail whose entries each carry a nought is a page that always looks like it is asking for
   * something, and the badge stops being the thing the eye goes to.
   */
  it("draws no badge for a count of zero", () => {
    setup({ badges: { review: 0, errors: 0 } });

    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Errors" })).toBeInTheDocument();
  });

  /**
   * A press reports the group it was on and **does nothing else**.
   *
   * The second assertion is the contract with `SettingsPage`: the page clears the query when it
   * takes a group, so a rail that also cleared it would either double the work or — if the two
   * ever disagreed about when — clear a query the page had just decided to keep.
   */
  it("reports the group that was pressed, and clears nothing itself", async () => {
    const user = userEvent.setup();
    const props = setup({ query: "dropbox" });

    await user.click(screen.getByRole("button", { name: "Storage and data" }));

    expect(props.onGroup).toHaveBeenCalledExactlyOnceWith("storage");
    expect(props.onQuery).not.toHaveBeenCalled();
  });

  /** Typing reports the box's new contents. The box is controlled; nothing is held here. */
  it("reports what is typed into the box", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.type(box(), "d");

    expect(props.onQuery).toHaveBeenCalledExactlyOnceWith("d");
    expect(props.onGroup).not.toHaveBeenCalled();
  });

  /**
   * Escape empties the box while there is something in it to empty, and falls through when there
   * is not — the one press a filter box owns anywhere in this app.
   *
   * **jsdom is the only witness to this half.** Chromium clears an `<input type="search">` by
   * itself and leaves `defaultPrevented` false, so in the shipped window the box would empty
   * either way and the press would *also* reach whatever Escape means to the view behind it;
   * jsdom implements no native clear at all, so what is asserted here is the handler that makes
   * the press deterministic rather than the emptying a browser would do anyway.
   */
  it("empties the box on Escape while it has something in it", async () => {
    const user = userEvent.setup();
    const props = setup({ query: "dropbox" });

    await user.type(box(), "{Escape}");

    expect(props.onQuery).toHaveBeenCalledExactlyOnceWith("");
  });

  /**
   * The other half of the same rule, and the half that makes the guard worth having: an empty
   * box has nothing to undo, so the press falls through to whatever the view behind it does with
   * Escape rather than being swallowed by a field that did nothing with it.
   */
  it("leaves an already-empty box alone on Escape", async () => {
    const user = userEvent.setup();
    const props = setup({ query: "" });

    await user.type(box(), "{Escape}");

    expect(props.onQuery).not.toHaveBeenCalled();
  });

  /**
   * **The rail's two shapes cannot be tested here, and pinning the classes is what is left.**
   *
   * jsdom applies no stylesheet and evaluates no container query, so every render in this file
   * is the base arrangement: the column of full-width rows. Whether the strip of chips actually
   * appears at 260px, whether the accent really moves from the left border to the bottom one,
   * and whether the pane is beside the rail or above it are all questions only a browser can
   * answer — the stories are where that is looked at.
   *
   * So this asserts the one thing source text can be honest about: that both spellings reached
   * the elements, and that the container they bind to is on the `<nav>` itself. `classList`
   * rather than `className.includes`, because `includes` matches the base name inside every
   * variant that contains it and would pass on a rail with no container query at all.
   */
  it("carries both shapes' classes, with the container on the nav", () => {
    setup();
    const rail = screen.getByRole("navigation", { name: "Settings" });
    const list = screen.getByRole("list");
    const [first] = entries();

    // The container is named, and it is this element — never the settings root, whose `fixed`
    // dialogs would then size to the page box instead of the window.
    expect(rail.classList.contains("@container/rail")).toBe(true);

    // Column beside the pane, scrolling strip above it.
    expect(list.classList.contains("flex-col")).toBe(true);
    expect(list.classList.contains("@min-[260px]/rail:flex-row")).toBe(true);
    expect(list.classList.contains("@min-[260px]/rail:overflow-x-auto")).toBe(true);

    // The accent mark's two sides, and the width that is moved between them.
    expect(first.classList.contains("border-l-2")).toBe(true);
    expect(first.classList.contains("@min-[260px]/rail:border-l-0")).toBe(true);
    expect(first.classList.contains("@min-[260px]/rail:border-b-2")).toBe(true);
  });

  /**
   * What the page still does not have, with no heading over it.
   *
   * The heading is the assertion: in a rail a heading *is* an entry and an entry is a
   * destination, so a seventh one with no panels behind it would be a place a reader can be sent
   * to that draws nothing. `Not here yet` was the heading it lost on the way here.
   */
  it("names what is still missing without giving it a heading", () => {
    setup();

    expect(screen.getByText("Import. Coming in a later plan.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
