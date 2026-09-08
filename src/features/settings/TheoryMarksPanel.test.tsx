/**
 * The panel a reader recolours the three theory marks from.
 *
 * **No computed colour is asserted anywhere here, and that is not a shortcut.** jsdom resolves no
 * stylesheet, so `getComputedStyle` would answer the literal `var(…)` back — and even in a
 * browser the right answer is whatever the reader last chose. What is pinned instead is the pair
 * of things this panel is actually responsible for: the **custom-property name** it writes the
 * preview in, and the **value it hands to `set_mark_color`**. That is `CardMarks.test.tsx`'s rule
 * one folder over, arrived at from the writing end rather than the drawing end.
 *
 * `sent` records the command as the boundary sees it — the name and the argument object — rather
 * than the `ipc.ts` wrapper's two positional arguments, because what a reset must not do is send
 * a *colour*, and a tuple that spells `color: null` is the shape that says so.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { markColors, setMarkColor, sent } = vi.hoisted(() => {
  const sent: [string, { mark: string; color: string | null }][] = [];
  return {
    sent,
    markColors: vi.fn(),
    setMarkColor: vi.fn((mark: string, color: string | null) => {
      sent.push(["set_mark_color", { mark, color }]);
      return Promise.resolve();
    }),
  };
});
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { markColors, setMarkColor },
}));

import { MARK_COLOR_DEFAULTS } from "@/lib/useMarkColors";
import { TheoryMarksPanel } from "./TheoryMarksPanel";

/** What `mark_colors` answers this test — the row as the reader left it, keys and all. */
function stored(row: Record<string, string>) {
  markColors.mockResolvedValue(row);
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<TheoryMarksPanel />, { wrapper: Wrapper });
}

/** The row for one mark — a named group, so the two never have to be told apart by position. */
const row = (name: string) => screen.getByRole("group", { name });

beforeEach(() => {
  sent.length = 0;
  markColors.mockReset().mockResolvedValue({});
  setMarkColor.mockReset().mockImplementation((mark: string, color: string | null) => {
    sent.push(["set_mark_color", { mark, color }]);
    return Promise.resolve();
  });
});

describe("TheoryMarksPanel", () => {
  /**
   * Both states of the two marks that have two, and the one state of the mark that has one.
   *
   * The tick and the signed number are the same box in the same fill — the number *replaces* the
   * tick on a card the plan asks a different number of — so a preview that drew only the tick
   * would be showing half of what the colour reaches. The tier is read off `THEORY_MATCH_ATTR`,
   * which is the one handle that tells the marks apart without reading a colour.
   *
   * **The unplanned row is one preview and the count is the assertion** (2026-09-08). That tier
   * has no order to be short of, so it has no second state: a `+2` beside its X would be a
   * preview of something the app cannot draw, and a duplicate X would be a preview of the same
   * thing twice. `2` and `1` written as literals rather than as `MARKS.length`-shaped arithmetic,
   * because the point of the case is exactly that the three rows do not agree.
   */
  it("previews both states of the two counted marks and one state of the third", async () => {
    stored({});
    const { container } = draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    expect(container.querySelectorAll('[data-theory-match="exact"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-theory-match="name"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-theory-match="unplanned"]')).toHaveLength(1);
    // The number state, once per counted mark: a tick and a `+2` are the two things those fills
    // have to work for, and a preview of one of them is a preview of half the decision. Two and
    // not three, which is the other half of the row above.
    expect(screen.getAllByText("+2")).toHaveLength(2);
  });

  /**
   * The picker opens on what the mark is drawn in **now** — which for a reader who has never
   * chosen is the stylesheet's own colour rather than an empty field, and is the whole reason
   * `MARK_COLOR_DEFAULTS` is spelled beside `index.css` at all.
   *
   * And nothing is written until Done. `input[type=color]` fires all the way down a drag through
   * the OS dialog, so a control that wrote on every change would send one `set_mark_color` per
   * pixel of travel; the assertion on an empty `sent` *before* the press is what says the draft
   * is a draft.
   */
  it("opens on the stylesheet's default and writes the reader's choice on Done", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    await userEvent.click(
      screen.getByRole("button", { name: /change the matching-printing mark/i }),
    );

    const hex = screen.getByRole("textbox", { name: "Matching printing colour hex" });
    expect(hex).toHaveValue(MARK_COLOR_DEFAULTS.theoryExact.slice(1).toUpperCase());

    await userEvent.clear(hex);
    await userEvent.type(hex, "ff0000");
    expect(sent).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(sent).toEqual([["set_mark_color", { mark: "theoryExact", color: "#ff0000" }]]);
  });

  /**
   * The draft is drawn on the mark itself before it is committed, which is what makes the picker
   * judgeable: a colour chosen against a swatch and seen on the mark afterwards is a colour
   * chosen twice.
   *
   * **The property name is the assertion**, for the reason at the top of this file — it is the
   * same name `useMarkColors` writes on `:root` and the same one `CardMarks.tsx` reads.
   */
  it("draws the draft on the preview before anything is written", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    await userEvent.click(
      screen.getByRole("button", { name: /change the matching-printing mark/i }),
    );
    const hex = () => screen.getByRole("textbox", { name: "Matching printing colour hex" });
    await userEvent.clear(hex());
    await userEvent.type(hex(), "ff0000");

    expect(row("Matching printing").style.getPropertyValue("--color-theory-exact")).toBe("#ff0000");
    // The other mark is untouched — one picker is open, and it is about one mark.
    expect(row("Different printing").style.getPropertyValue("--color-theory-name")).toBe(
      MARK_COLOR_DEFAULTS.theoryName,
    );
    expect(sent).toEqual([]);
  });

  /**
   * Reset clears rather than storing today's default — see `useMarkColors`.
   *
   * A reader who has never chosen and a reader who has reset have to end in the same state, and
   * they only do if the row is **deleted**: today's hex written back is an entry that pins this
   * palette against every future one, which is the one thing an absent entry is protecting.
   */
  it("offers a reset that clears the stored colour", async () => {
    stored({ theoryExact: "#123456" });
    draw();

    const reset = await screen.findByRole("button", {
      name: /reset the matching-printing mark/i,
    });
    await waitFor(() => expect(reset).not.toHaveAttribute("aria-disabled", "true"));

    await userEvent.click(reset);

    expect(sent).toContainEqual(["set_mark_color", { mark: "theoryExact", color: null }]);
    expect(sent).not.toContainEqual([
      "set_mark_color",
      { mark: "theoryExact", color: MARK_COLOR_DEFAULTS.theoryExact },
    ]);
  });

  /**
   * The third row end to end — pick, then put back — on the key it is actually wired to.
   *
   * **`theoryUnplanned` is the assertion and not the press**, which is what makes this more than
   * a third copy of the two cases above: a row whose `MarkRow.key` had been left on one of the
   * other two would draw, name and preview itself perfectly and recolour the wrong mark, and
   * every other case in this file would still pass. `sent` is read for the key rather than the
   * screen, because the screen is where that mistake is invisible.
   *
   * The reset is asserted after the set for the same reason `useMarkColors`' own case is: today's
   * hex written back is an entry that pins this palette, so a reader who has reset and one who
   * never chose must both end with no row at all.
   */
  it("sets and resets the unplanned mark's own colour", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /change the unplanned-card mark/i }));

    const hex = screen.getByRole("textbox", { name: "Not in the theory list colour hex" });
    expect(hex).toHaveValue(MARK_COLOR_DEFAULTS.theoryUnplanned.slice(1).toUpperCase());
    await userEvent.clear(hex);
    await userEvent.type(hex, "00733e");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(sent).toEqual([["set_mark_color", { mark: "theoryUnplanned", color: "#00733e" }]]);

    const reset = screen.getByRole("button", { name: /reset the unplanned-card mark/i });
    await waitFor(() => expect(reset).not.toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(reset);

    expect(sent).toContainEqual(["set_mark_color", { mark: "theoryUnplanned", color: null }]);
    // And nothing was written to either of the other two marks along the way.
    for (const [, args] of sent) expect(args.mark).toBe("theoryUnplanned");
  });

  /**
   * There is nothing to reset a mark to that is already at the stylesheet's colour, and saying so
   * is the only thing on this panel that tells a reader whether they have customised anything at
   * all. `aria-disabled` rather than the attribute, which is the app's rule: a `disabled` button
   * leaves the tab order.
   */
  it("greys the reset for a mark nobody has chosen, and presses nothing", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    const reset = screen.getByRole("button", { name: /reset the matching-printing mark/i });
    expect(reset).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(reset);

    expect(sent).toEqual([]);
  });

  /**
   * The reader is watching a swatch, so a refused write says so here — unlike the rail and the
   * list layout, which swallow theirs.
   */
  it("says so when the write is refused", async () => {
    stored({ theoryExact: "#123456" });
    setMarkColor.mockRejectedValueOnce("The database is busy with a sync — try again in a moment.");
    draw();

    const reset = await screen.findByRole("button", {
      name: /reset the matching-printing mark/i,
    });
    await waitFor(() => expect(reset).not.toHaveAttribute("aria-disabled", "true"));

    await userEvent.click(reset);

    expect(await screen.findByRole("alert")).toHaveTextContent(/busy/);
  });

  /**
   * `app_meta` is not synced and the per-deck switches and the labels are, so a reader with two
   * devices has to be told which of the three this screen is about.
   */
  it("says the colours are this device's", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    expect(screen.getByText(/only on this device/i)).toBeInTheDocument();
  });

  /**
   * **The open picker is named for the mark it colours, and the two names are different.**
   *
   * `LabelColorRow` defaults its subject to `"Label colour"` — right for the deck dialog it was
   * written for, and wrong twice over here: a *label* is not a *mark* (this repo's vocabulary
   * rule, which the root `CLAUDE.md` states as never letting the words trade places), and left at
   * the default both pickers would announce themselves identically, so a screen-reader user
   * recolouring the green tick could not tell which one they had opened.
   *
   * The names are collected by opening each picker in turn — only one is ever open, which is the
   * panel's own single-tenant state — and asserted as a **set of two** rather than one at a time,
   * because the failure this guards is *sameness* and a pair of separate assertions can both pass
   * against two identical strings.
   */
  it("names each mark's picker for that mark, and never for a label", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    const names: string[] = [];
    for (const noun of ["matching-printing", "different-printing", "unplanned-card"]) {
      const open = screen.getByRole("button", {
        name: new RegExp(`change the ${noun} mark`, "i"),
      });
      await userEvent.click(open);
      const group = screen.getByRole("group", { name: /colour$/ });
      const name = group.getAttribute("aria-label") ?? "";
      names.push(name);
      // The hex field belongs to the same thing the group around it does, which is what
      // `subjectNames` composing all three from one string is for.
      expect(within(group).getByRole("textbox", { name: `${name} hex` })).toBeInTheDocument();
      // Close it again, so the next iteration is not reading a group that outlived its row.
      await userEvent.click(open);
    }

    expect(names).toEqual([
      "Matching printing colour",
      "Different printing colour",
      "Not in the theory list colour",
    ]);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.toLowerCase()).not.toContain("label");
  });

  /** Each mark's controls are addressed by that mark's own words, so no swatch and no reset can
   *  be found by position or reached on the wrong row. */
  it("names every mark's controls apart", async () => {
    stored({});
    draw();
    await waitFor(() => expect(markColors).toHaveBeenCalled());

    for (const [name, noun] of [
      ["Matching printing", "matching-printing"],
      ["Different printing", "different-printing"],
      // The third row is named for the mark's own sentence rather than for a distinction it does
      // not draw — `CardMarks.tsx`'s `THEORY_UNPLANNED_LABEL`, which is what the mark says on the
      // card and what `deckCardName` says in words.
      ["Not in the theory list", "unplanned-card"],
    ]) {
      const group = row(name);
      expect(
        within(group).getByRole("button", { name: new RegExp(`change the ${noun} mark`, "i") }),
      ).toBeInTheDocument();
      expect(
        within(group).getByRole("button", { name: new RegExp(`reset the ${noun} mark`, "i") }),
      ).toBeInTheDocument();
    }
  });
});
