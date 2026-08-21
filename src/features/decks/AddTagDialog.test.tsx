import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalTag } from "@/lib/ipc";
import { AddTagDialog } from "./AddTagDialog";

/**
 * Every tag the reader owns that this deck's list is **not** already wearing — the editor's
 * subtraction, done there because it is the only place holding both halves. Most-used first,
 * which is the backend's order and the one this dialog must not re-sort.
 */
const CHOICES: GlobalTag[] = [
  { id: 1, name: "Cut candidate", color: "#d3202a", cardCount: 12, deckCount: 4 },
  { id: 2, name: "Budget swap", color: "#00733e", cardCount: 5, deckCount: 2 },
  { id: 3, name: "Combo piece", color: "#d9b95c", cardCount: 0, deckCount: 0 },
];

function mount(props: Partial<Parameters<typeof AddTagDialog>[0]> = {}) {
  const onPick = vi.fn();
  const onCreate = vi.fn();
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <AddTagDialog
      open
      cardName="Lightning Bolt"
      choices={CHOICES}
      pending={false}
      onPick={onPick}
      onCreate={onCreate}
      onDismiss={onDismiss}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...view, onPick, onCreate, onDismiss, onClose };
}

describe("AddTagDialog", () => {
  it("draws nothing at all when it is closed", () => {
    const { container } = mount({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("names the card the label is going on", async () => {
    mount();
    const dialog = await screen.findByRole("dialog", { name: "Add tag" });
    expect(within(dialog).getByText(/Put a label on “Lightning Bolt”/)).toBeInTheDocument();
  });

  /**
   * **The backend's order is kept.** The list is most-used first, which is what makes reading it
   * top-down worth more than typing for the common case — and re-sorting it here would throw
   * away a fact the backend went and counted.
   */
  it("offers every other tag, most-used first, and says how far each reaches", async () => {
    mount();
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((li) => li.textContent)).toEqual([
      "Cut candidate12",
      "Budget swap5",
      // A tag nothing wears prints no number: "0" would be arithmetic about a label that has
      // simply never been used.
      "Combo piece",
    ]);
  });

  it("puts an existing tag on the card in one press, without creating anything", async () => {
    const { onPick, onCreate } = mount();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Budget swap/ }));

    expect(onPick).toHaveBeenCalledWith(2);
    expect(onCreate).not.toHaveBeenCalled();
  });

  /**
   * **One field, two jobs**, and they are the same question: a reader who types "cut" and sees
   * the tag they meant wanted that tag; one who types "cut" and sees nothing wanted a new one.
   * Narrowed on `tagNameKey`, so a substring matches whatever capitals or accent form either
   * side was typed in.
   */
  it("narrows the list as the reader types, ignoring case", async () => {
    mount();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Find or name a tag"), "CANDID");

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Cut candidate");
  });

  it("offers to create what was typed when nothing matches", async () => {
    const { onCreate } = mount();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Find or name a tag"), "Sac outlet");
    expect(screen.getByText(/No other tag matches “Sac outlet”/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Moss" }));
    await user.click(screen.getByRole("button", { name: "Create “Sac outlet”" }));

    expect(onCreate).toHaveBeenCalledWith("Sac outlet", "#00733e");
  });

  /**
   * **The duplicate guard, and the reason it is a courtesy rather than the fence.** The backend
   * refuses the name and is the authority — one row per name is a table property. But the tag is
   * on screen, so pressing Create and waiting for a refusal would be the app knowing the answer
   * and declining to say so.
   */
  it("refuses to create a name one of the choices already holds, and points at the row", async () => {
    const { onCreate } = mount();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Find or name a tag"), "  budget SWAP ");

    expect(screen.getByRole("status")).toHaveTextContent(
      "“Budget swap” already exists — pick it from the list above",
    );
    const create = screen.getByRole("button", { name: "Create “budget SWAP”" });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });

  /** Nothing to offer is its own sentence: "no other tag matches" would be about a filter the
   *  reader has not typed. */
  it("says so when every tag the reader has is already in this list", async () => {
    mount({ choices: [] });
    expect(
      await screen.findByText(/Every tag you have is already in this list/),
    ).toBeInTheDocument();
  });

  it("creates nothing from an empty field", async () => {
    const { onCreate } = mount();
    const user = userEvent.setup();
    const create = await screen.findByRole("button", { name: "Create tag" });

    expect(create).toBeDisabled();
    await user.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
