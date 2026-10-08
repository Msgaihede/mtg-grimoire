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

  it("lays a finger's press area round each box under `touch`, and a press anywhere in it ticks", () => {
    const onTick = vi.fn();
    render(<TodoBody blocks={parseTodoBody(body)} body={body} onTick={onTick} touch />);
    const box = screen.getByRole("checkbox", { name: 'Mark "Sleeve the deck" not done' });
    // The area is a label round the same box, so nothing new reaches the accessibility tree and a
    // press on the label is the box's own.
    const area = box.closest("label");
    expect(area).not.toBeNull();
    expect(area).toHaveClass("size-11");
    fireEvent.click(area as HTMLElement);
    expect(onTick).toHaveBeenCalledWith(1);
  });

  it("lays no press area round a box without `touch`", () => {
    render(<TodoBody blocks={parseTodoBody(body)} body={body} onTick={vi.fn()} />);
    expect(screen.getAllByRole("checkbox")[0].closest("label")).toBeNull();
  });
});
