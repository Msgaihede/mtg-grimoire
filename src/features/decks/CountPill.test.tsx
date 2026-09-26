import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CountPill, cardCountWords, tokenCountWords } from "./CountPill";

it("spells the phrase once, for a screen reader, and shows the bare number", () => {
  const { container } = render(<CountPill count={3} words={cardCountWords(3)} />);
  expect(container.firstElementChild).toHaveTextContent("3");
  expect(screen.getByText("3 cards")).toHaveClass("sr-only");
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^3$/);
});

/**
 * The whole phrase, asserted as the name a control containing the pill computes — never the two
 * halves separately, which is exactly what a broken name still passes (`src/CLAUDE.md`'s
 * `Missing2` rule). A pill whose digits leaked out of `aria-hidden` would read `33 cards` here, and
 * one built from two siblings would read `3cards`.
 */
it("contributes exactly its words to the name of whatever it is drawn inside", () => {
  render(
    <button type="button">
      <CountPill count={12} words={tokenCountWords(12)} />
    </button>,
  );
  expect(screen.getByRole("button")).toHaveAccessibleName("12 tokens and emblems");
});

it.each([
  [1, "1 card", "1 token or emblem"],
  [2, "2 cards", "2 tokens and emblems"],
  [0, "0 cards", "0 tokens and emblems"],
])("words %i", (n, cards, tokens) => {
  expect(cardCountWords(n)).toBe(cards);
  expect(tokenCountWords(n)).toBe(tokens);
});
