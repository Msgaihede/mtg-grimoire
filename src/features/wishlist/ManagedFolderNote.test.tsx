import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ManagedFolderNote } from "./ManagedFolderNote";

describe("ManagedFolderNote", () => {
  it("says whose list this is, and opens the deck from a button", async () => {
    const onOpenDeck = vi.fn();
    render(<ManagedFolderNote deckName="Rhystic Testbed" onOpenDeck={onOpenDeck} />);
    expect(screen.getByText(/Managed by the deck “Rhystic Testbed”/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open deck" }));

    expect(onOpenDeck).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws the way to the deck as a link when it is given one", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <ManagedFolderNote deckName="Rhystic Testbed" deckLink={{ href: "/decks/4", onClick }} />,
    );
    expect(screen.getByRole("link", { name: "Open deck" })).toHaveAttribute("href", "/decks/4");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
