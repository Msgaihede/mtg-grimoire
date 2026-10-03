import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseTodoBody } from "./todoMarkdown";
import { TodoBody } from "./todoBody";

/** A to-do list's body, split out of `TodoListCard`. The tickable list is the card's and is
 *  pinned in `DeckTodosPanel.test.tsx`; what is new here is the read-only list a surface that
 *  cannot write draws, and the link's press handed in. */
describe("TodoBody", () => {
  const body = ["- [ ] Revise tokens", "- [x] Sleeve the deck"].join("\n");

  it("draws each box as a picture and says its state, with nothing to press, when it cannot tick", () => {
    render(<TodoBody blocks={parseTodoBody(body)} body={body} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Revise tokens").parentElement).toHaveTextContent(
      /^To do: Revise tokens$/,
    );
    expect(screen.getByText("Sleeve the deck").parentElement).toHaveTextContent(
      /^Done: Sleeve the deck$/,
    );
  });

  it("draws real checkboxes that hand their line up when it can", () => {
    const onTick = vi.fn();
    render(<TodoBody blocks={parseTodoBody(body)} body={body} ticking={false} onTick={onTick} />);
    fireEvent.click(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' }));
    expect(onTick).toHaveBeenCalledWith(0);
  });
});
