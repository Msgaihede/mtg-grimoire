import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtWeightFloor, TagNamespace } from "@/lib/ipc";
import {
  EMPTY_SELECTION,
  removeChip,
  toggleChipMode,
  type TagChip,
  type TagSelection,
} from "./tagFilters";
import { HIDE_BACKGROUND_LABEL, TagChips } from "./TagChips";

/** The fake's own motifs, so nothing here reads as a tag that exists only in a test. */
function chip(
  slug: string,
  namespace: TagNamespace = "art",
  mode: TagChip["mode"] = "include",
): TagChip {
  return { slug, label: slug[0].toUpperCase() + slug.slice(1), namespace, mode };
}

function selection(chips: TagChip[], floor: ArtWeightFloor = "any"): TagSelection {
  return { ...EMPTY_SELECTION, chips, floor };
}

function draw(sel: TagSelection, withFloor = true) {
  const onRemove = vi.fn();
  const onToggleMode = vi.fn();
  const onFloorChange = vi.fn();
  render(
    <TagChips
      selection={sel}
      onRemove={onRemove}
      onToggleMode={onToggleMode}
      onFloorChange={withFloor ? onFloorChange : undefined}
    />,
  );
  return { onRemove, onToggleMode, onFloorChange };
}

/** The row wired to the reducers, for the two behaviours that only exist across a re-render. */
function LiveChips({ initial }: { initial: TagSelection }) {
  const [sel, setSel] = useState(initial);
  return (
    <TagChips
      selection={sel}
      onRemove={(slug, ns) => setSel((s) => removeChip(s, slug, ns))}
      onToggleMode={(slug, ns) => setSel((s) => toggleChipMode(s, slug, ns))}
    />
  );
}

describe("TagChips", () => {
  it("removes a chip from its × and flips it to exclude from its toggle", async () => {
    const user = userEvent.setup();
    const { onRemove, onToggleMode } = draw(selection([chip("forest"), chip("water")]));

    await user.click(screen.getByRole("button", { name: "Remove Forest, art tag" }));
    expect(onRemove).toHaveBeenCalledWith("forest", "art");

    await user.click(screen.getByRole("button", { name: /^Water, art tag, included/ }));
    expect(onToggleMode).toHaveBeenCalledWith("water", "art");
  });

  /**
   * An excluded chip says **`not Forest`** in words rather than only changing colour: the row
   * has to read at a glance to somebody who cannot tell gold from dim, and "included" and
   * "excluded" are opposite claims about the same query.
   */
  it("says an excluded tag is excluded, in words", async () => {
    const user = userEvent.setup();
    render(<LiveChips initial={selection([chip("forest")])} />);

    await user.click(screen.getByRole("button", { name: /^Forest, art tag, included/ }));

    expect(screen.getByText("not Forest")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^not Forest, art tag, excluded/ }),
    ).toBeInTheDocument();
  });

  /**
   * **Two taxonomies, two id spaces, plenty of shared slugs.** The Storybook fake's art and
   * oracle slug sets are deliberately disjoint, so this store is built here — the precedent is
   * `.storybook/fake/db.test.ts`, which does the same rather than editing the shared seed.
   *
   * A row that named both chips "Forest" would be two controls a reader cannot tell apart, and
   * `removeChip` is keyed on the pair for exactly this reason.
   */
  it("tells apart two chips that share a slug across the taxonomies", async () => {
    const user = userEvent.setup();
    const { onRemove } = draw(selection([chip("forest", "art"), chip("forest", "oracle")]));

    expect(screen.getAllByText(/^Forest$/)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove Forest, oracle tag" }));

    expect(onRemove).toHaveBeenCalledWith("forest", "oracle");
    expect(onRemove).not.toHaveBeenCalledWith("forest", "art");
  });

  /**
   * The caret must survive the button it was standing on. A removed chip unmounts its own ×, so
   * without this the reader is dropped on `<body>` and the next Tab restarts at the top of the
   * app — the same failure a menu opener with no `tabIndex` has.
   *
   * Driven with `user.keyboard` rather than `user.type`: `type` focuses whatever it is handed,
   * so an assertion about focus after it passes over a component that never moved the caret.
   */
  it("hands the caret to the next chip when one is removed", async () => {
    const user = userEvent.setup();
    render(<LiveChips initial={selection([chip("forest"), chip("water"), chip("flower")])} />);

    await user.click(screen.getByRole("button", { name: "Remove Water, art tag" }));
    await user.keyboard("{Enter}");

    // The caret landed on Flower's ×, and Enter there removed it rather than doing nothing.
    expect(screen.queryByText("Water")).not.toBeInTheDocument();
    expect(screen.queryByText("Flower")).not.toBeInTheDocument();
    expect(screen.getByText("Forest")).toBeInTheDocument();
  });

  /** Removing the last chip in the row falls back to the one before it. */
  it("hands the caret backwards when the last chip is removed", async () => {
    const user = userEvent.setup();
    render(<LiveChips initial={selection([chip("forest"), chip("water")])} />);

    await user.click(screen.getByRole("button", { name: "Remove Water, art tag" }));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove Forest, art tag" }),
    );
  });

  it("invites a first pick rather than drawing an empty row", () => {
    draw(EMPTY_SELECTION);
    expect(screen.getByText(/pick one from the list/i)).toBeInTheDocument();
  });

  /**
   * **The label must not promise "strong matches only".** The predicate behind it is
   * `weight <> 'weak'`, which admits `median` — 462 008 of 475 163 art taggings — so the control
   * excludes background detail and narrows to nothing stronger than that.
   */
  it("labels the weight floor for what it actually drops", () => {
    draw(selection([chip("forest")]));

    const control = screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    expect(control).toBeInTheDocument();
    expect(control).toHaveAccessibleName(/background element/i);
    expect(screen.queryByText(/strong matches only/i)).not.toBeInTheDocument();
  });

  it("turns the weight floor on and off", async () => {
    const user = userEvent.setup();
    const { onFloorChange } = draw(selection([chip("forest")]));

    await user.click(screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }));
    expect(onFloorChange).toHaveBeenCalledWith("strong");
  });

  it("turns the weight floor back off when it is already on", async () => {
    const user = userEvent.setup();
    const { onFloorChange } = draw(selection([chip("forest")], "strong"));

    await user.click(screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }));
    expect(onFloorChange).toHaveBeenCalledWith("any");
  });

  /**
   * The floor applies to the art side's **include** half alone — `oracle_tag_cards` carries no
   * weight column, and a floor on an exclude would let weak forests back into a result the
   * reader asked to have none in. With nothing for it to narrow it is greyed rather than
   * dropped, so the row does not reflow under the reader as they pick.
   */
  it("greys the weight floor while there is no art tag to narrow", async () => {
    const user = userEvent.setup();
    const { onFloorChange } = draw(
      selection([chip("removal", "oracle"), chip("forest", "art", "exclude")]),
    );

    const control = screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleName(/until an art tag is picked/i);
    await user.click(control);
    expect(onFloorChange).not.toHaveBeenCalled();
  });

  /** A page that does not offer the floor gets exactly the chips — there is no state where the
   *  control is drawn and dead. */
  it("draws no weight floor when the page does not offer one", () => {
    draw(selection([chip("forest")]), false);
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }),
    ).not.toBeInTheDocument();
  });
});
