import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TagInUse } from "@/features/decks/deckTags";
import { EntryTagsField } from "./EntryTagsField";

const IN_USE: TagInUse[] = [
  { tag: "Cube", count: 3 },
  { tag: "Trade bait", count: 1 },
];

describe("EntryTagsField", () => {
  it("speaks of stacks rather than decks, and offers the entry tags in use", async () => {
    const onChange = vi.fn();
    render(<EntryTagsField tags={["Cube"]} inUse={IN_USE} onChange={onChange} id="t" />);
    expect(screen.getByRole("list", { name: "Tags on this stack" })).toBeInTheDocument();
    expect(screen.getByText(/Every copy in this stack shares its tags/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Tags" }));
    const list = screen.getByRole("listbox", { name: "Tags on your other cards" });
    // `Cube` is already on the stack, so only the other one is offered — counted in stacks.
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Trade bait1 stack"]);
    await userEvent.click(within(list).getByRole("option"));
    expect(onChange).toHaveBeenCalledWith(["Cube", "Trade bait"]);
  });

  it("draws the tags and takes no edit while disabled", async () => {
    const onChange = vi.fn();
    render(
      <EntryTagsField
        tags={["Cube", "Trade bait"]}
        inUse={IN_USE}
        onChange={onChange}
        id="t"
        disabled
        disabledHint="Press Edit to change this stack's tags."
      />,
    );
    const box = screen.getByRole("combobox", { name: "Tags" });
    expect(box).toBeDisabled();
    expect(screen.getByText("Cube")).toBeInTheDocument();
    expect(screen.getByText("Trade bait")).toBeInTheDocument();
    // No ✕ and no reorder grip on a chip, no suggestions, and the host's sentence under the box.
    expect(screen.queryByRole("button", { name: /Remove the/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Press Edit to change this stack's tags.")).toBeInTheDocument();

    await userEvent.click(box);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says there are none when a disabled stack wears no tags", () => {
    render(<EntryTagsField tags={[]} inUse={IN_USE} onChange={vi.fn()} id="t" disabled />);
    expect(screen.getByPlaceholderText("No tags")).toBeDisabled();
  });
});
