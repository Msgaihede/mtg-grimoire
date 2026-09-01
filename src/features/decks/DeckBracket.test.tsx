import { useRef, useState, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_BRACKET, type ComboStatus, type DeckCard, type DeckCombo } from "@/lib/ipc";
import { commander, gameChanger, islands } from "./validation/fixtures";
import type { BracketEstimate } from "./validation/bracket";
import { bracketWarning, estimateBracket } from "./validation/bracket";
import { DeckBracket } from "./DeckBracket";

const combosForCards = vi.hoisted(() => vi.fn());
const combosStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { combosForCards, combosStatus },
}));

/**
 * **The estimator is a double here, and the boundary is deliberate.**
 *
 * `validation/bracket.ts` has a suite of its own that feeds it real printings and checks the
 * arithmetic; what *this* file is about is which of three faces the button wears for a given
 * reading and what the panel says about it. Re-deriving the reading from a fixture deck would
 * test those rules twice and — worse — would put the fixture between the test and its subject:
 * the states this control exists to draw are "a bracket set below the floor" and "a Ruthless
 * combo in the list", and building either out of real cards makes the *corpus* the thing that
 * decides whether the test can exist at all.
 *
 * **What keeps the double honest is the type and not this comment.** {@link estimate} is
 * annotated `BracketEstimate`, imported from the module it is standing in for, so a field the
 * estimator renames or drops is a red `tsc` rather than a green suite asserting about a shape
 * nothing produces any more. The real numbers are covered where they belong: the estimator's own
 * tests, and `DeckBracket.stories.tsx`, whose decks are real printings read by the real
 * estimator through the workbench's fake.
 */
vi.mock("./validation/bracket", () => ({
  estimateBracket: vi.fn(),
  bracketWarning: vi.fn(),
}));

/** A reading, with whatever this test needs changed about it. `floor` and never `bracket`: what
 *  the cards can honestly say is the bottom of a range, which is what a bracket restriction has
 *  always been ("not allowed below bracket N").
 *
 *  **The default is `BASE_FLOOR`, 2, and was `1` until 2026-09-01** — a fixture must not encode a
 *  reading the estimator cannot produce, or a state this control will never be handed becomes the
 *  one most of these tests are written against. */
function estimate(over: Partial<BracketEstimate> = {}): BracketEstimate {
  return {
    floor: 2,
    gameChangers: 0,
    gameChangerNames: [],
    massLandDenial: [],
    extraTurns: [],
    combos: [],
    possibleCombos: [],
    reasons: [],
    ...over,
  };
}

/** Thassa's Oracle + Demonic Consultation, which is the combo everyone means when they say
 *  "two-card combo" — Ruthless in Spellbook's own classification, and `templateCount: 0`, so it
 *  is one the deck definitely has. */
function combo(over: Partial<DeckCombo> = {}): DeckCombo {
  return {
    id: "1957-4050-7918--204",
    bracketTag: "R",
    cards: ["Thassa's Oracle", "Demonic Consultation"],
    templateCount: 0,
    produces: "Win the game",
    popularity: 12_000,
    ...over,
  };
}

/** A combo list that has been downloaded. `fetchedAt` is the whole of what separates this from
 *  a database that has never ingested one, and it is the field this panel branches on. */
const INGESTED: ComboStatus = {
  combos: 34_000,
  cards: 21_000,
  stamp: "2026-08-27T03:12:44Z",
  fetchedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  stale: false,
};

/**
 * The editor's own wiring, in the smallest thing that can hold it: the open flag, the deck's own
 * `bracket`, and the two ways out kept apart (Escape hands the caret back, a click away does
 * not).
 *
 * The bracket is **state** rather than a prop, because the picker's whole subject is the round
 * trip — a press writes, the deck comes back with the new number, and the button re-labels off
 * it. A harness that held it fixed would draw a control whose presses changed nothing.
 */
function Harness({
  cards,
  bracket: initial = AUTO_BRACKET,
  onBracket,
}: {
  cards: DeckCard[];
  bracket?: number;
  onBracket?: (bracket: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [bracket, setBracket] = useState(initial);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button">Elsewhere</button>
      <DeckBracket
        cards={cards}
        bracket={bracket}
        onBracket={(next) => {
          setBracket(next);
          onBracket?.(next);
        }}
        open={open}
        buttonRef={button}
        onOpen={() => setOpen(true)}
        onDismiss={() => {
          button.current?.focus();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * One `QueryClient` for the whole of a test, **including its rerenders**.
 *
 * The two tests below that rerender are about a cache key moving, so a fresh client per render
 * would be the thing under test answering yes for the wrong reason: a new cache misses every key,
 * including the one that did not change.
 */
function wrap(ui: ReactElement) {
  // No retries: a test that mocks a refusal should see it on the first answer, not after three.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...view,
    rerender: (next: ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}

const DECK = [commander(), islands(99)];

const trigger = () => screen.getByRole("button", { name: /^Bracket \d/ });

/** The panel, once the combo read behind it has answered — the region below the picker is four
 *  states deep and three of them are transient, so a helper that returned on the dialog alone
 *  would hand half these tests a frame reading "Reading combos…". */
async function panel() {
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).queryByText("Reading combos…")).toBeNull());
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(estimateBracket).mockReturnValue(estimate());
  vi.mocked(bracketWarning).mockReturnValue(null);
  combosForCards.mockResolvedValue([]);
  combosStatus.mockResolvedValue(INGESTED);
});

describe("DeckBracket", () => {
  /**
   * **The number is on the button, which is the whole of what moved on 2026-08-24.** It rode
   * inside the format check's panel before that, so a reader who wanted to know what bracket their
   * deck read as had to open a list of *findings* and scroll past them.
   */
  it("prints the estimate on its own readout", () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 3, gameChangers: 1 }));
    wrap(<Harness cards={DECK} />);

    expect(trigger()).toHaveTextContent("Bracket ~3");
  });

  /**
   * The `~` is drawn and is not spoken — a screen reader says "tilde two" or nothing at all — and
   * the word the glyph stands for is in the name instead. Advisory in the copy as well as in the
   * code: Wizards' scale is explicitly "advisory only, not hard validation".
   */
  it("says the estimate is one, in the name the glyph cannot carry", () => {
    wrap(<Harness cards={DECK} />);

    expect(trigger()).toHaveAccessibleName("Bracket 2, an estimate");
  });

  /**
   * **A reading and an answer are different things, and the tilde is the whole of the visible
   * difference.** A reader who has had the conversation their table needed should not have it
   * re-derived from their card list every time they open the deck — so a set bracket is printed
   * plainly, and the name says whose number it is, because "Bracket 3" alone cannot tell the
   * reader's own answer from the app's guess.
   */
  it("prints a set bracket plainly, with no tilde", () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 2 }));
    wrap(<Harness cards={DECK} bracket={3} />);

    expect(trigger()).toHaveTextContent("Bracket 3");
    expect(trigger()).not.toHaveTextContent("~");
    expect(trigger()).toHaveAccessibleName("Bracket 3, set for this deck");
  });

  /**
   * **A bracket set below the floor is a mismatch and not a break**, which is why this state
   * wears neither of the check chip's two colours: nothing here is illegal, and nothing here is
   * clean either. Two answers about one deck that do not agree, so the control shows both of
   * them — and says so in words for the reader the fill and the second number cannot reach.
   */
  it("shows both numbers, and names the mismatch, when the set bracket is below the floor", () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 4 }));
    vi.mocked(bracketWarning).mockReturnValue("This deck is set to bracket 2, but its cards read.");
    wrap(<Harness cards={DECK} bracket={2} />);

    expect(trigger()).toHaveTextContent("Bracket 2 · ~4");
    expect(trigger()).toHaveAccessibleName(
      "Bracket 2, set for this deck — the cards read as bracket 4 or higher",
    );
  });

  /**
   * **The fill, and it is deliberately neither of the check chip's two colours.** A bracket 2
   * deck holding a bracket 4 combo is not broken and is not clean, so `--destructive` and
   * `--color-ok` are both out; what is left is the accent the control already wears, stated
   * louder. `classList.contains` and not `className.includes`, because the string also holds a
   * `hover:` variant of the same utility and a substring test would pass before anything
   * changed.
   */
  it("fills the readout only where the two numbers disagree", () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 4 }));
    vi.mocked(bracketWarning).mockReturnValue("Set to 2, but a Ruthless combo reads as 4.");
    const view = wrap(<Harness cards={DECK} bracket={2} />);
    expect(trigger().classList.contains("bg-accent/15")).toBe(true);
    // The gold edge is the control's own and survives the state: this is one readout wearing a
    // second thing to say, not a second control.
    expect(trigger().classList.contains("border-accent")).toBe(true);
    expect(trigger().classList.contains("text-destructive")).toBe(false);
    expect(trigger().classList.contains("text-ok")).toBe(false);
    view.unmount();

    vi.mocked(bracketWarning).mockReturnValue(null);
    wrap(<Harness cards={DECK} bracket={4} />);

    expect(trigger().classList.contains("bg-accent/15")).toBe(false);
  });

  /** The mismatch is **one** condition: the button's treatment and the panel's sentence are both
   *  `bracketWarning` returning something, so the two cannot end up disagreeing about whether
   *  there is one. A set bracket at or above the floor is simply the reader's answer. */
  it("draws no mismatch when the set bracket clears the floor", () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 2 }));
    wrap(<Harness cards={DECK} bracket={4} />);

    expect(trigger()).toHaveTextContent("Bracket 4");
    expect(trigger()).not.toHaveTextContent("~");
    expect(bracketWarning).toHaveBeenCalledWith(4, expect.objectContaining({ floor: 2 }));
  });

  /** Auto asks the rules nothing about a mismatch — there is no set number to be below the
   *  floor, so the question does not arise. */
  it("asks for no warning at all while the deck is on Auto", () => {
    wrap(<Harness cards={DECK} />);

    expect(bracketWarning).not.toHaveBeenCalled();
  });

  /** The one card fact that decides the number is a column a sync fills, so a deck with none of
   *  them reads as the bottom of the scale rather than as nothing at all — and since 2026-09-01
   *  that bottom is **2 Core**, not 1: bracket 1 is an intent no card list shows. */
  it("estimates the lowest bracket for a deck with nothing in it to see", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());

    expect(within(await panel()).getByText("Bracket ~2 · 0 game changers")).toBeInTheDocument();
  });

  /** The disclosure names every card the number was read from — a reader who disagrees with a
   *  heuristic can see which card caused it, which is what makes a guess worth showing. */
  it("names what it read, behind a disclosure", async () => {
    vi.mocked(estimateBracket).mockReturnValue(
      estimate({
        floor: 3,
        gameChangers: 2,
        gameChangerNames: ["Rhystic Study", "Cyclonic Rift"],
      }),
    );
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    expect(within(dialog).getByText("Bracket ~3 · 2 game changers")).toBeInTheDocument();
    expect(within(dialog).getByText(/estimate/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /what this read/i }));

    expect(within(dialog).getByText(/Rhystic Study/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Cyclonic Rift/)).toBeInTheDocument();
  });

  /** Nothing to disclose for a deck the estimate read nothing off — an empty "What this read"
   *  is a control promising an answer it has not got. */
  it("offers no disclosure when it read nothing", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());

    expect(
      within(await panel()).queryByRole("button", { name: /what this read/i }),
    ).not.toBeInTheDocument();
  });

  /** The sentence the reader could not get off the button: *what* makes the two numbers
   *  disagree. It leads the panel, above the reading it is about. */
  it("leads the panel with the mismatch sentence", async () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 4 }));
    vi.mocked(bracketWarning).mockReturnValue("Set to 2, but a Ruthless combo reads as 4.");
    wrap(<Harness cards={DECK} bracket={2} />);
    await userEvent.click(trigger());

    // The panel's **first** child, which is what "leads" means: above the reading it is about.
    expect((await panel()).firstElementChild).toHaveTextContent(
      "Set to 2, but a Ruthless combo reads as 4.",
    );
  });

  /** And never when there is nothing to say. A panel that led with a sentence about agreement
   *  would spend its first line on the state every deck is in. */
  it("says nothing about a mismatch when there is none", async () => {
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 2 }));
    wrap(<Harness cards={DECK} bracket={3} />);
    await userEvent.click(trigger());

    expect((await panel()).firstElementChild).toHaveTextContent("Bracket ~2 · 0 game changers");
  });

  /**
   * **The picker is what the whole feature is for.** Brackets 4 and 5 have identical deck
   * restrictions and what separates them is an intent no card list shows, so 5 is a number only
   * a reader can write down — and the estimate never returns it.
   */
  it("writes the bracket the reader picked", async () => {
    const onBracket = vi.fn();
    wrap(<Harness cards={DECK} onBracket={onBracket} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    await userEvent.click(within(dialog).getByRole("radio", { name: "5 cEDH" }));

    expect(onBracket).toHaveBeenCalledWith(5);
    expect(trigger()).toHaveTextContent("Bracket 5");
  });

  /**
   * **And back to Auto, which is the half a nullable column could not have expressed.**
   * `DeckPatch`'s rule is that an absent field means "leave it", so `AUTO_BRACKET` is a real
   * value in the patch — `0`, mirroring `AUTO_CATEGORY` — rather than the absence of one.
   */
  it("writes AUTO_BRACKET back when the reader picks Auto", async () => {
    const onBracket = vi.fn();
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 3 }));
    wrap(<Harness cards={DECK} bracket={4} onBracket={onBracket} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    await userEvent.click(within(dialog).getByRole("radio", { name: "Auto" }));

    expect(onBracket).toHaveBeenCalledWith(AUTO_BRACKET);
    expect(trigger()).toHaveTextContent("Bracket ~3");
  });

  /** One of six is chosen and exactly one is true at a time, so `aria-checked` is the only thing
   *  that says which to a reader who cannot see which one is gold. The names matter to a reader
   *  who does not know the scale by number, and a digit is not a name. */
  it("offers Auto and 1–5 as a named radio group", async () => {
    wrap(<Harness cards={DECK} bracket={2} />);
    await userEvent.click(trigger());
    const group = within(await panel()).getByRole("radiogroup", { name: "Bracket for this deck" });

    expect(within(group).getAllByRole("radio").map((el) => el.getAttribute("aria-label"))).toEqual([
      "Auto",
      "1 Exhibition",
      "2 Core",
      "3 Upgraded",
      "4 Optimized",
      "5 cEDH",
    ]);
    expect(within(group).getByRole("radio", { name: "2 Core" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Auto" })).not.toBeChecked();
  });

  /** Each radio is its own tab stop rather than a roving caret, which is `TagSearchBox`'s rule
   *  for the app's other two groups: two radio groups that answered the arrow keys differently
   *  would be worse than ones that answer them nowhere. Driven with the keyboard, because a
   *  `focus()` in a test is a caret no reader can produce. */
  it("reaches the picker with the keyboard from the panel", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    await panel();

    await userEvent.keyboard("{Tab}");

    expect(screen.getByRole("radio", { name: "Auto" })).toHaveFocus();
  });

  /**
   * **A combo cannot be read out of a card's own text at all** — it is a fact about an
   * interaction — so the list is what says the deck has one, and the letter is a judgement
   * Spellbook's editors made per combo rather than one this app derived. Its own words are what
   * is drawn.
   */
  it("names each combo found and what its letter means", async () => {
    combosForCards.mockResolvedValue([combo()]);
    vi.mocked(estimateBracket).mockReturnValue(estimate({ floor: 4, combos: [combo()] }));
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    expect(
      within(dialog).getByText("Thassa's Oracle + Demonic Consultation"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Ruthless — for competitive decks at brackets 4+"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Win the game")).toBeInTheDocument();
  });

  /**
   * **A possible combo must never read as a confirmed one.** Every card it names is in the deck,
   * but each also needs a `requires[]` template — "a creature with flying" — which is not a card
   * id and cannot be resolved against a decklist at all. So they raise no floor, and the sentence
   * above them says what is missing rather than leaving a reader to infer it from a heading.
   */
  it("keeps the possible combos on their own line, marked as unchecked", async () => {
    const maybe = combo({
      id: "3-4-5--6",
      bracketTag: "P",
      cards: ["Kenrith, the Returned King", "Sol Ring"],
      templateCount: 1,
      produces: "Infinite mana",
    });
    combosForCards.mockResolvedValue([combo(), maybe]);
    vi.mocked(estimateBracket).mockReturnValue(
      estimate({ floor: 4, combos: [combo()], possibleCombos: [maybe] }),
    );
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    expect(within(dialog).getByText(/Possible, and not counted/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing here has been confirmed/)).toBeInTheDocument();
    expect(
      within(dialog).getByText("Kenrith, the Returned King + Sol Ring"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Powerful — for strong decks in bracket 3+"),
    ).toBeInTheDocument();
  });

  /**
   * **The one sentence this panel must never write.** "No combos matched" is a claim about a
   * list that was consulted; a database that has never fetched the feed has consulted nothing,
   * and drawing silence there would have the panel implying the deck has none.
   */
  it("says the combo list has never been downloaded, and where to get it", async () => {
    combosStatus.mockResolvedValue({ ...INGESTED, fetchedAt: null, combos: 0, cards: 0 });
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await screen.findByRole("dialog");

    expect(
      await within(dialog).findByText(/No combo list has been downloaded/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Settings/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/No two-card combo in the list matches/)).toBeNull();
  });

  /**
   * **A read still in flight is a third way to have looked at nothing**, and it is the one an
   * immediately-resolving mock hides: every other test here opens the panel on an answer that has
   * already arrived. A promise that never settles is what holds the panel in that frame long
   * enough to assert about it — and what it must not say there is the sentence it says when a
   * list has genuinely answered with nothing.
   */
  it("says it is still reading rather than that the deck has no combos", async () => {
    combosForCards.mockReturnValue(new Promise(() => {}));
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText("Reading combos…")).toBeInTheDocument();
    expect(within(dialog).queryByText(/No two-card combo in the list matches/)).toBeNull();
  });

  /** And the positive claim only where it can be made honestly: a list that answered, with
   *  nothing in it for this deck. */
  it("says no combo matched only once a list has actually answered", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());

    expect(
      within(await panel()).getByText("No two-card combo in the list matches this deck."),
    ).toBeInTheDocument();
  });

  /** A read that failed is not a deck with no combos either. Nothing was refused to the reader,
   *  so this is a sentence in the panel rather than the editor's banner — but it has to be a
   *  sentence. */
  it("says so when the combo read failed", async () => {
    combosForCards.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText(/could not be read/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/No two-card combo in the list matches/)).toBeNull();
  });

  /**
   * **The query is keyed on the deck's card ids, and that is the whole of how an edit produces a
   * fresh answer.** `query.ts` caches 30 s, so a key that did not move would go on answering what
   * it answered before the edit for half a minute — and a mounted observer refetches only when
   * its query is actually invalidated, so a stable key with nothing invalidating it would never
   * refetch at all while the editor stayed open.
   */
  it("asks again when the deck's cards change", async () => {
    const view = wrap(<Harness cards={DECK} />);
    await waitFor(() => expect(combosForCards).toHaveBeenCalledTimes(1));

    // The same cards again is the same question: nothing refetches, which is the half a key
    // built out of the rows' own identities could not have promised.
    view.rerender(<Harness cards={[...DECK]} />);
    expect(combosForCards).toHaveBeenCalledTimes(1);

    view.rerender(<Harness cards={[...DECK, gameChanger("Rhystic Study")]} />);

    await waitFor(() => expect(combosForCards).toHaveBeenCalledTimes(2));
    expect(combosForCards).toHaveBeenLastCalledWith(
      expect.arrayContaining(["c-Rhystic Study", "c-Island"]),
    );
  });

  /**
   * **Sorted, and that is not tidiness.** The deck's rows come back in whatever order the read
   * gave them, and a group-by or a re-file reorders them without changing which cards are in the
   * deck — so a key built from the list as it arrived would be a different key for the same
   * question, and every regroup would be a refetch.
   */
  it("asks the same question when the same cards arrive in a different order", async () => {
    const view = wrap(<Harness cards={DECK} />);
    await waitFor(() => expect(combosForCards).toHaveBeenCalledTimes(1));

    view.rerender(<Harness cards={[...DECK].reverse()} />);

    await waitFor(() => expect(estimateBracket).toHaveBeenCalled());
    expect(combosForCards).toHaveBeenCalledTimes(1);
  });

  /** A switched-off pile is not the deck, so the combo half and the oracle half are read off one
   *  list — the same one `estimateBracket` drops an inactive category from. */
  it("leaves a switched-off pile out of the ids it asks about", async () => {
    const parked = { ...gameChanger("Rhystic Study"), categoryActive: false };
    wrap(<Harness cards={[...DECK, parked]} />);

    await waitFor(() => expect(combosForCards).toHaveBeenCalledTimes(1));
    expect(combosForCards).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["c-Rhystic Study"]),
    );
  });

  /** A trigger with `aria-expanded` has to be able to close what it opened — the press blurs the
   *  panel first, so a blur-away that did not know the button would close and reopen it for
   *  ever. */
  it("closes from the button that opened it", async () => {
    wrap(<Harness cards={DECK} />);

    await userEvent.click(trigger());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(trigger());

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  /** Escape is the keyboard way out and hands the caret back; the rung is the app's `"inner"`
   *  one, registered on the flag rather than on the panel's mount. **Still true after the panel
   *  grew a radio group**, which is the thing worth re-checking: the press is made from inside
   *  the picker, where a control that swallowed it would leave the reader in a layer with no way
   *  out. */
  it("closes on Escape from inside the picker, and hands the caret back", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    await panel();
    await userEvent.keyboard("{Tab}");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  /** Focus leaving the control closes it and hands nothing back — the reader who tabbed away is
   *  already somewhere else. */
  it("closes when the caret leaves it, and leaves the caret where it went", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await screen.findByRole("dialog");
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });

    fireEvent.focusOut(dialog, { relatedTarget: elsewhere });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).not.toHaveFocus();
  });

  /** A press inside the panel is not focus leaving it: the picker writes and the panel stays. */
  it("stays open when the picker is pressed", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    const dialog = await panel();

    await userEvent.click(within(dialog).getByRole("radio", { name: "3 Upgraded" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  /** The caret moves into the layer, as it does for every other one in this editor: the picker
   *  is then the next thing Tab reaches, and Escape has something to hand back. */
  it("takes the caret into the panel", async () => {
    wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());

    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  /**
   * **The estimate runs on every edit now, and the memo is what keeps that affordable.** It used
   * to be gated on the panel being open, which stopped being possible the day the button printed
   * the number — `estimateBracket` greps every face of every card for four phrases, so one pass
   * per *change to the deck* is the cost, and one per render is not. The combo list is a
   * dependency too and is a stable empty array until it answers, so a query that has not landed
   * does not re-run the pass on every render either.
   */
  it("re-reads the deck only when the deck changes", async () => {
    const view = wrap(<Harness cards={DECK} />);
    // Twice: once on the first render with no combos in hand, once when the read lands. Both
    // are a change to what the estimate is *of*, and neither is a render.
    await waitFor(() => expect(estimateBracket).toHaveBeenCalledTimes(2));
    vi.mocked(estimateBracket).mockClear();

    view.rerender(<Harness cards={DECK} />);
    expect(estimateBracket).not.toHaveBeenCalled();

    view.rerender(<Harness cards={[...DECK, gameChanger("Rhystic Study")]} />);
    expect(estimateBracket).toHaveBeenCalledTimes(1);
  });

  /**
   * **The empty combo list is one object, and that is what keeps the pass off every render while
   * the read is in flight.** `useQuery` answers `undefined` until it has something, so a `?? []`
   * would hand the memo a fresh array each time it ran — the number would still be right and the
   * whole grep would run again for nothing, which is exactly the cost the memo exists to avoid
   * and exactly the kind of thing nothing on screen would show. Driven against a promise that
   * never settles, because a mock that resolves is past this state before a rerender can reach
   * it.
   */
  it("makes one pass while the combo read is in flight, however often it renders", async () => {
    combosForCards.mockReturnValue(new Promise(() => {}));
    const view = wrap(<Harness cards={DECK} />);
    await userEvent.click(trigger());
    await screen.findByText("Reading combos…");
    vi.mocked(estimateBracket).mockClear();

    view.rerender(<Harness cards={DECK} />);
    view.rerender(<Harness cards={DECK} />);

    expect(estimateBracket).not.toHaveBeenCalled();
  });

  /** A trigger that is not pressed costs no panel at all: closed means unmounted, not hidden. */
  it("draws no panel until it is pressed", () => {
    wrap(<Harness cards={DECK} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("does not open itself when the caller says it is closed", () => {
    wrap(
      <DeckBracket
        cards={DECK}
        bracket={AUTO_BRACKET}
        onBracket={vi.fn()}
        open={false}
        buttonRef={{ current: null }}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
