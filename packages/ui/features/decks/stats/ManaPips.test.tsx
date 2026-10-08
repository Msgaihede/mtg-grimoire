import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { deckStats } from "../DeckStats";
import { card } from "../validation/fixtures";
import { HIDE_COLORLESS_LABEL, ManaPips } from "./ManaPips";

/** One colour's census tile, found by the `sr-only` word that names it. */
const tile = (colour: string) => screen.getByText(colour).closest("li") as HTMLElement;

/** Where a tile figure's percentage was drawn, and what it says — `[place, text]` per figure. */
const shares = (colour: string) =>
  [...tile(colour).querySelectorAll("[data-share]")].map((el) => [
    el.getAttribute("data-share"),
    el.textContent,
  ]);

const pips = (hideColorless = false, onHideColorlessChange = vi.fn()) =>
  render(
    <ManaPips
      stats={deckStats([
        card({ name: "Bolt", manaCost: "{R}", colors: "R", quantity: 9, producedMana: "" }),
        card({ name: "Swords", manaCost: "{W}", colors: "W", quantity: 1, producedMana: "" }),
        card({
          name: "Mountain",
          typeLine: "Basic Land — Mountain",
          manaCost: null,
          cmc: 0,
          colors: null,
          producedMana: "R",
          quantity: 4,
        }),
      ])}
      hideColorless={hideColorless}
      onHideColorlessChange={onHideColorlessChange}
    />,
  );

describe("ManaPips' tile tracks", () => {
  /**
   * The three placements are three states of a share, and each is asserted where it can fail: a
   * big share on its fill, a share under a fifth just past it, and no share at all as a dash in
   * the empty track — never `0%`.
   */
  it("prints a share on its fill, past a thin fill, and a dash where there is none", () => {
    pips();

    expect(shares("Red")).toEqual([
      ["inside", "90%"],
      ["inside", "100%"],
    ]);
    expect(shares("White")).toEqual([
      ["beside", "10%"],
      ["none", "—"],
    ]);
    expect(shares("Blue")).toEqual([
      ["none", "—"],
      ["none", "—"],
    ]);
  });

  /** The number sits on the Sources fill now, so the fill is thinned by colour and never by
   *  `opacity`, which would take the number down with it. */
  it("thins the Sources fill with color-mix rather than opacity", () => {
    pips();

    const [cost, sources] = [...tile("Red").querySelectorAll<HTMLElement>("[data-share-fill]")];
    expect(cost.style.background).toBe("var(--color-mana-r)");
    expect(sources.style.background).toBe("color-mix(in srgb, var(--color-mana-r) 55%, transparent)");
    expect(sources.style.opacity).toBe("");
  });

  it("heads each figure with the colour's symbol and its word, and keeps the captions", () => {
    pips();

    const red = within(tile("Red"));
    expect(red.getByText("Cost")).toBeInTheDocument();
    expect(red.getByText("Sources")).toBeInTheDocument();
    expect(tile("Red")).toHaveTextContent("9 pips · 9 cards");
    expect(tile("Red")).toHaveTextContent("4 sources");
  });
});

describe("ManaPips' colourless toggle", () => {
  /** Controlled: the press asks for the other state and changes nothing itself, so a card
   *  remounted by the band's layout switch keeps whatever `DeckStats` holds. */
  it("asks for the other state and draws what it is handed", async () => {
    const onChange = vi.fn();
    const { rerender } = pips(false, onChange);
    const toggle = screen.getByRole("button", { name: HIDE_COLORLESS_LABEL });

    await userEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    rerender(
      <ManaPips
        stats={deckStats([card({ name: "Bolt", manaCost: "{R}", colors: "R" })])}
        hideColorless
        onHideColorlessChange={onChange}
      />,
    );
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
