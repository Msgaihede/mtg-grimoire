import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckVariant } from "@/lib/ipc";
import { ClearDeck } from "./ClearDeck";

/**
 * The question as a host draws it, with the two numbers the whole of what a case has to say.
 *
 * `cardCount` is the list being emptied and `otherCount` is the list being left alone, and the
 * defaults are deliberately **different numbers**: a fixture where the two agree would pass every
 * assertion below with the props swapped, which is the one defect this component exists to
 * prevent.
 */
function clear(props: Partial<Parameters<typeof ClearDeck>[0]> = {}) {
  const onCleared = vi.fn();
  const onCancel = vi.fn();
  render(
    <ClearDeck
      variant="live"
      cardCount={12}
      otherCount={3}
      pending={false}
      onCancel={onCancel}
      onCleared={onCleared}
      {...props}
    />,
  );
  return { onCleared, onCancel };
}

/** The destructive line — the one a reader's eye is on while they decide. It is one paragraph
 *  carrying two sentences, so it is read whole rather than in halves. */
// Both verb forms, because the sentence says "leaves" at a count of one — a matcher pinned to
// the plural would simply not find the singular frame and read as the paragraph being absent.
const outcome = () => screen.getByText(/leaves? the deck and the piles stay/);

describe("ClearDeck", () => {
  /**
   * **The list is named rather than implied.** "Clear the deck?" over a deck with a plan and a
   * actual list is exactly the ambiguity this question exists to close, so the word appears in the
   * sentence *and* in the name the group is addressed by — the second being what a screen reader
   * hears when the caret lands in the box.
   */
  it.each<[DeckVariant, string]>([
    ["live", "actual list"],
    ["theory", "theory list"],
  ])("asks about the %s list by name", (variant, list) => {
    clear({ variant });

    expect(screen.getByText(`Clear the ${list}?`)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: `Clear the ${list}` })).toBeInTheDocument();
  });

  /**
   * Since schema v25 a Live row is backed by a collection row in the deck's group, so the copies
   * are filed rather than destroyed — and saying where they land is the reassuring half of a
   * destructive sentence.
   */
  it("promises the actual list's copies to Recently removed", () => {
    clear({ variant: "live" });

    expect(outcome()).toHaveTextContent(
      "The 12 cards in it leave the deck and the piles stay. " +
        "Any copies you own go back to Recently removed.",
    );
  });

  /**
   * A theory list is a plan and holds no copies, so the same sentence must **not** promise a
   * folder nothing will arrive in. The absence is asserted as well as the presence: a ternary
   * stuck on its live arm draws a true-sounding sentence about cardboard that was never there.
   */
  it("promises nothing moves for a theory list, and never names Recently removed", () => {
    clear({ variant: "theory" });

    expect(outcome()).toHaveTextContent(
      "The 12 cards in it leave the deck and the piles stay. " +
        "A theory list holds no copies, so nothing else moves.",
    );
    expect(screen.queryByText(/Recently removed/)).not.toBeInTheDocument();
  });

  /**
   * **The button quotes the list on screen**, which is the number the press actually takes away.
   * Both counts are asserted because `plural` is passed its singular rather than deriving one, so
   * "1 cards" is a spelling this app can print and has to be pinned against.
   */
  it.each([
    [1, "Remove 1 card"],
    [2, "Remove 2 cards"],
  ])("counts %i in the destructive button", (cardCount, label) => {
    clear({ cardCount, otherCount: 0 });

    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  /**
   * **The reassurance quotes the other list and the button quotes this one**, and the two numbers
   * are checked in one render because the failure worth catching is them being the wrong way
   * round rather than either being absent. Swapped, this press offers to remove three cards and
   * takes away twelve — a confirmation understating a destructive act, which is the one direction
   * it must never be wrong in.
   */
  it("quotes the other list in the reassurance and the emptied list in the button", () => {
    clear({ cardCount: 12, otherCount: 3 });

    expect(screen.getByText("The 3 cards in the other list are untouched.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 12 cards" })).toBeInTheDocument();
    expect(outcome()).toHaveTextContent("The 12 cards in it leave the deck");
  });

  /**
   * **Both verbs agree at a count of one, and one is the only count that can tell.**
   * `plural` gets a caller as far as `1 card` and no further — the sentence built around it read
   * "The 1 card in it **leave** the deck" and "The 1 card in the other list **are** untouched"
   * until both went through `verb`. One card left in a list is exactly the state somebody clears
   * from, so it is the sentence most likely to be read, not a corner.
   *
   * The whole string on each side rather than a match up to the verb: `/1 card in it leave/`
   * passes against the disagreeing text as readily as against the fixed one, which is an
   * assertion that cannot fail for the thing it names.
   */
  it("agrees its verbs with a count of one on both sides", () => {
    clear({ cardCount: 1, otherCount: 1 });

    expect(outcome()).toHaveTextContent(
      "The 1 card in it leaves the deck and the piles stay. " +
        "Any copies you own go back to Recently removed.",
    );
    expect(screen.getByText("The 1 card in the other list is untouched.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 1 card" })).toBeInTheDocument();
  });

  /** A deck with theory switched off has one list, so there is no other list to reassure anybody
   *  about — and "The 0 cards in the other list are untouched" is a sentence about a list the
   *  deck has not got. */
  it("draws no reassurance when the other list is empty", () => {
    clear({ cardCount: 12, otherCount: 0 });

    expect(screen.queryByText(/in the other list are untouched/)).not.toBeInTheDocument();
  });

  /**
   * The write is the host's, so the greying is too — and only the destructive half greys.
   * `CONFIRM_CANCEL` carries no `disabled:` clause on purpose: declining is not a thing a busy
   * database can refuse, so the way out of a confirmation is never taken away mid-write.
   */
  it("greys the destructive button while the write is in flight, and never the way out", () => {
    clear({ pending: true });

    expect(screen.getByRole("button", { name: "Remove 12 cards" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep them" })).toBeEnabled();
  });

  it("runs the write from the destructive button alone", async () => {
    const { onCleared, onCancel } = clear();

    await userEvent.click(screen.getByRole("button", { name: "Remove 12 cards" }));

    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the cards from the way out alone", async () => {
    const { onCleared, onCancel } = clear();

    await userEvent.click(screen.getByRole("button", { name: "Keep them" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCleared).not.toHaveBeenCalled();
  });

  /**
   * The caret lands in the **question**, not on a button in it: the reader has not decided yet
   * and a stray Enter must not decide for them — which here would empty a whole list. It is
   * `useConfirmFocus`'s spread that does it, and `focus()` on a node with no `tabIndex` is a
   * silent no-op, so this asserts the caret rather than the attribute.
   */
  it("puts the caret on the question rather than on either answer", () => {
    clear();

    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Clear the actual list" }));
  });
});
