import { useRef, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCard, FormatSpec } from "@/lib/ipc";
import { card, commander, gameChanger, islands, LEGAL, spec } from "./validation/fixtures";
import { messageParts, ValidationPanel } from "./ValidationPanel";
import { estimateBracket } from "./validation/bracket";

/** The real estimate, watched: the only thing worth asserting about it here is *when* it is
 *  asked, so it delegates rather than pretending. */
vi.mock("./validation/bracket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./validation/bracket")>();
  return { ...actual, estimateBracket: vi.fn(actual.estimateBracket) };
});

/** The editor's own wiring, in the smallest thing that can hold it: one piece of state, a
 *  ref for the hand-back, and the two ways out kept apart (Escape hands the caret back, a
 *  click away does not). */
function Harness({
  cards,
  format,
  onSelectCard = vi.fn(),
}: {
  cards: DeckCard[];
  format: FormatSpec;
  onSelectCard?: (cardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button">Elsewhere</button>
      <ValidationPanel
        cards={cards}
        spec={format}
        open={open}
        buttonRef={chip}
        onOpen={() => setOpen(true)}
        onDismiss={() => {
          chip.current?.focus();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        onSelectCard={onSelectCard}
      />
    </>
  );
}

/** A printing the format's own list says something about. */
function listed(name: string, status: string, overrides: Partial<DeckCard> = {}): DeckCard {
  return card({
    name,
    legalities: JSON.stringify({ modern: status, vintage: status }),
    ...overrides,
  });
}

/** 60 cards, three of them wrong in three different ways. */
function threeIssues(): DeckCard[] {
  return [
    card({ name: "Lightning Bolt", quantity: 5 }),
    listed("Blightsteel Colossus", "banned"),
    listed("Black Lotus", "not_legal"),
    islands(53),
  ];
}

/** More findings than the bubble has room for: a hundred and one cards on the ban list. */
function overAHundredIssues(): DeckCard[] {
  return Array.from({ length: 101 }, (_, at) => listed(`Banned ${at}`, "banned"));
}

async function open(ui: Parameters<typeof render>[0]) {
  render(ui);
  await userEvent.click(screen.getByRole("button", { name: /issue|No issues/ }));
  return screen.getByRole("dialog");
}

/**
 * Every finding on screen, as a reader hears it — the severity, then the engine's sentence.
 *
 * Read off the whole line rather than with `getByText`, because a card's name inside a
 * sentence is a *button*: the text matcher only ever sees an element's own text nodes, so the
 * one assertion that matters here — that the sentence arrives verbatim — is the one it cannot
 * make.
 */
function findings(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");
}

describe("ValidationPanel", () => {
  /** The chip is the whole readout when there is nothing to say: the format it was judged
   *  against, and the fact that it passed. */
  it("says the deck is clean, and which rules it was judged by", () => {
    render(<Harness cards={[islands(60)]} format={spec("modern")} />);

    expect(screen.getByRole("button", { name: "No issues · Modern" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("counts what is wrong", () => {
    render(<Harness cards={threeIssues()} format={spec("modern")} />);

    expect(screen.getByRole("button", { name: "3 issues · Modern" })).toBeInTheDocument();
  });

  it("counts one issue in the singular", () => {
    render(<Harness cards={[islands(59)]} format={spec("modern")} />);

    expect(screen.getByRole("button", { name: "1 issue · Modern" })).toBeInTheDocument();
  });

  /**
   * **The whole reason this control is a glyph, and the one half of it jsdom can be asked
   * about.** Live and Theory hold different cards and so fail different rules, which put the
   * two states of this readout one switch apart — and while it was words, flipping that switch
   * changed its width and slid every control to its right along with it. There is no layout
   * engine here, so the claim is made about the class list rather than about a rect: one
   * recipe, one fixed width, whatever the deck is doing.
   */
  it("draws the same box whether or not anything is wrong", () => {
    const clean = render(<Harness cards={[islands(60)]} format={spec("modern")} />).container;
    const broken = render(<Harness cards={threeIssues()} format={spec("modern")} />).container;
    const box = (root: HTMLElement) => root.querySelector<HTMLElement>("[aria-haspopup=dialog]")!;

    expect(box(clean).className).toBe(box(broken).className);
    expect(box(clean).className).toContain("w-9");
  });

  /** Red for a break, green for none — and the glyph is the only thing either colour touches,
   *  because a tinted surface would make a deck somebody is still building look broken. */
  it("colours the glyph rather than the control", () => {
    const clean = render(<Harness cards={[islands(60)]} format={spec("modern")} />).container;
    const broken = render(<Harness cards={threeIssues()} format={spec("modern")} />).container;
    const glyph = (root: HTMLElement) => root.querySelector("[aria-haspopup=dialog] svg")!;

    expect(glyph(clean).getAttribute("class")).toContain("text-ok");
    expect(glyph(broken).getAttribute("class")).toContain("text-destructive");
  });

  /** The count is a bubble hung off the corner: out of the box's flow, so it cannot widen it,
   *  and out of the accessible name, which already says the number once. */
  it("prints the count in a bubble that is out of flow and out of the name", () => {
    render(<Harness cards={threeIssues()} format={spec("modern")} />);
    const bubble = within(screen.getByRole("button", { name: "3 issues · Modern" })).getByText("3");

    expect(bubble).toHaveAttribute("aria-hidden", "true");
    expect(bubble.className).toContain("absolute");
  });

  /** Sixty findings is a real state and three digits are not — the name still says how many. */
  it("caps the bubble at two digits, and the name never is", () => {
    render(<Harness cards={overAHundredIssues()} format={spec("modern")} />);
    const chip = screen.getByRole("button", { name: /^101 issues · Modern$/ });

    expect(within(chip).getByText("99+")).toBeInTheDocument();
  });

  /** The engine writes the sentences; the panel prints them. A panel that paraphrased would
   *  be a second place for a rule to be stated, and the two would drift. */
  it("lists every finding in the engine's own words, grouped by what it is about", async () => {
    const panel = await open(<Harness cards={threeIssues()} format={spec("modern")} />);

    expect(findings(panel)).toEqual([
      "Error: Modern decks allow up to 4 copies of Lightning Bolt; you have 5.",
      "Error: Blightsteel Colossus is banned in Modern.",
      "Error: Black Lotus is not legal in Modern.",
    ]);
    expect(within(panel).getByText("Copy limits")).toBeInTheDocument();
    expect(within(panel).getByText("Banned cards")).toBeInTheDocument();
    expect(within(panel).getByText("Outside the format")).toBeInTheDocument();
  });

  /** TRAP A, read from the seeded cell rather than from a format name: `restricted` means
   *  max one copy in Vintage, and the sentence says exactly that. */
  it("reads a restricted card the way the format means it", async () => {
    const deck = [listed("Ancestral Recall", "restricted", { quantity: 2 }), islands(58)];
    const panel = await open(<Harness cards={deck} format={spec("vintage")} />);

    expect(findings(panel)).toEqual([
      "Error: Ancestral Recall is restricted in Vintage: max 1 copy; you have 2.",
    ]);
  });

  /** The panel is a way *into* the deck: a sentence about a card puts that card on screen. */
  it("selects the card whose name is pressed", async () => {
    const onSelectCard = vi.fn();
    const panel = await open(
      <Harness cards={threeIssues()} format={spec("modern")} onSelectCard={onSelectCard} />,
    );

    await userEvent.click(within(panel).getByRole("button", { name: "Blightsteel Colossus" }));

    expect(onSelectCard).toHaveBeenCalledWith("c-Blightsteel Colossus");
  });

  /** An issue about the deck rather than about a card names no card, and offers no way in:
   *  sixty rows highlighted says nothing the sentence did not. */
  it("offers no card to press for an issue about the deck itself", async () => {
    const panel = await open(<Harness cards={[islands(4)]} format={spec("modern")} />);

    expect(
      within(panel).getByText("Modern decks need at least 60 cards; you have 4."),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Island" })).not.toBeInTheDocument();
  });

  it("reports a clean deck in words when it is opened anyway", async () => {
    const panel = await open(<Harness cards={[islands(60)]} format={spec("modern")} />);

    expect(within(panel).getByText(/nothing to fix/i)).toBeInTheDocument();
  });

  /**
   * The `"inner"` rung of the Escape stack: the press is consumed here — so the card pane
   * behind the editor keeps its own — and the caret goes back to the chip that opened this.
   */
  it("closes on Escape, consuming the press, and hands the caret back to its chip", async () => {
    render(<Harness cards={threeIssues()} format={spec("modern")} />);
    const chip = screen.getByRole("button", { name: "3 issues · Modern" });
    await userEvent.click(chip);
    await screen.findByRole("dialog");

    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen, false);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen, false);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
    expect(heard).toEqual([true]);
  });

  /** Clicking or tabbing away closes it and hands nothing back — the reader is already
   *  somewhere else. */
  it("closes when the caret leaves it, and leaves the caret where it went", async () => {
    render(<Harness cards={threeIssues()} format={spec("modern")} />);
    await userEvent.click(screen.getByRole("button", { name: "3 issues · Modern" }));
    const panel = await screen.findByRole("dialog");
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });

    fireEvent.focusOut(panel, { relatedTarget: elsewhere });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 issues · Modern" })).not.toHaveFocus();
  });

  /** A trigger with `aria-expanded` has to be able to close what it opened — the press
   *  blurs the panel first, so a blur-away that did not know the chip would close and
   *  reopen it forever. */
  it("closes from the chip that opened it", async () => {
    render(<Harness cards={threeIssues()} format={spec("modern")} />);
    const chip = screen.getByRole("button", { name: "3 issues · Modern" });

    await userEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(chip);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * The bracket is an advisory: it emits no issue, it never makes a deck illegal, and the
   * copy says so in the word the research doc uses.
   */
  it("estimates a bracket for a commander deck and names what it read", async () => {
    const deck = [
      commander(),
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      islands(97),
    ];
    const panel = await open(<Harness cards={deck} format={spec("commander")} />);

    expect(within(panel).getByText("Bracket ~3 · 2 game changers")).toBeInTheDocument();
    expect(within(panel).getByText(/estimate/i)).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: /what this read/i }));

    expect(within(panel).getByText(/Rhystic Study/)).toBeInTheDocument();
    expect(within(panel).getByText(/Cyclonic Rift/)).toBeInTheDocument();
  });

  /** No commander zone, no bracket: it is a Commander conversation and nothing else. */
  it("says nothing about brackets in a format that has no commander", async () => {
    const panel = await open(<Harness cards={threeIssues()} format={spec("modern")} />);

    expect(within(panel).queryByText(/bracket/i)).not.toBeInTheDocument();
  });

  /**
   * The issues are computed on every render because the chip prints their count; the bracket is
   * not, because nothing outside the open panel draws it and it greps every face of every card
   * for four phrases.
   */
  it("does not read a bracket until the panel is opened", async () => {
    vi.mocked(estimateBracket).mockClear();
    render(<Harness cards={[commander(), islands(99)]} format={spec("commander")} />);

    expect(estimateBracket).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /No issues/ }));

    expect(estimateBracket).toHaveBeenCalled();
  });

  /** The one card fact that decides the number is a column a sync fills, so a deck with
   *  none of them reads as the bottom of the scale rather than as nothing at all. */
  it("estimates the lowest bracket for a deck with nothing in it to see", async () => {
    const deck = [commander(), islands(99)];
    const panel = await open(<Harness cards={deck} format={spec("commander")} />);

    expect(within(panel).getByText("Bracket ~1 · 0 game changers")).toBeInTheDocument();
  });
});

describe("messageParts", () => {
  /** The card's name inside the sentence is the handle, so the sentence stays the engine's
   *  verbatim words and is still a way into the deck. */
  it("makes each named card in a sentence its own part", () => {
    const parts = messageParts("Lightning Bolt is banned in Modern.", [
      { cardId: "c-1", name: "Lightning Bolt" },
    ]);

    expect(parts).toEqual([
      { text: "Lightning Bolt", cardId: "c-1" },
      { text: " is banned in Modern.", cardId: null },
    ]);
  });

  it("finds a name in the middle of a sentence", () => {
    const parts = messageParts(
      "Commander decks are singleton: max 1 copy of Sol Ring; you have 2.",
      [{ cardId: "c-2", name: "Sol Ring" }],
    );

    expect(parts.map((p) => p.cardId)).toEqual([null, "c-2", null]);
  });

  /** The longer name wins where one contains the other, or "Ancient Tomb" would be split
   *  into prose plus a button reading "Tomb". */
  it("prefers the longest name where two overlap", () => {
    const parts = messageParts("Ancient Tomb is banned.", [
      { cardId: "c-3", name: "Tomb" },
      { cardId: "c-4", name: "Ancient Tomb" },
    ]);

    expect(parts[0]).toEqual({ text: "Ancient Tomb", cardId: "c-4" });
  });

  /** A sentence about the deck names no card, and gains no buttons. */
  it("leaves a sentence about the deck alone", () => {
    const parts = messageParts("Modern decks need at least 60 cards; you have 4.", []);

    expect(parts).toEqual([
      { text: "Modern decks need at least 60 cards; you have 4.", cardId: null },
    ]);
  });

  /** An orphaned row's sentence is the reconciler's, and it still starts with the name the
   *  row carries — which is the only name that row has. */
  it("still finds the name of a card that has left the database", () => {
    const parts = messageParts("Ghost Card: its printing left the card database.", [
      { cardId: "c-5", name: "Ghost Card" },
    ]);

    expect(parts[0].cardId).toBe("c-5");
  });
});

/** The fixtures' shared legality blob is what makes a "clean" deck clean; if it stopped
 *  covering Modern every test above would be about something else. */
it("judges the fixtures against a format their blob actually names", () => {
  expect(JSON.parse(LEGAL)).toHaveProperty("modern", "legal");
});
