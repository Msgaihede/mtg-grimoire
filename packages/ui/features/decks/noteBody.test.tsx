import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteBody } from "./noteBody";

/** The body a deck note is drawn from, split out of `NoteCard` so a surface without the opener
 *  plugin can draw it. What changed is the link and the empty sentence, so that is what this
 *  pins; the dialect itself is `noteMarkdown.test.ts`'s and the card's `NoteCard.test.tsx`'s. */
describe("NoteBody", () => {
  const body = "Read [the primer](https://example.com/primer) first.";

  it("hands a link's press to the caller that asked for it", () => {
    const onLink = vi.fn();
    render(<NoteBody body={body} empty="Empty." onLink={onLink} />);
    fireEvent.click(screen.getByRole("button", { name: "the primer" }));
    expect(onLink).toHaveBeenCalledWith("https://example.com/primer");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws a real anchor into a new tab where no caller handles the press", () => {
    render(<NoteBody body={body} empty="Empty." />);
    const link = screen.getByRole("link", { name: "the primer" });
    expect(link).toHaveAttribute("href", "https://example.com/primer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says the caller's sentence for a body with nothing in it", () => {
    render(<NoteBody body="" empty="No content yet." />);
    expect(screen.getByText("No content yet.")).toBeInTheDocument();
  });
});
