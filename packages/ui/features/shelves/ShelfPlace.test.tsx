import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShelfPlace, shelfColumn, shelfPlaceName } from "./ShelfPlace";

const STAPLES = { kind: "folder" as const, name: "Staples", path: ["Binder", "Staples"] };

describe("ShelfPlace", () => {
  /** The drawer's own name is drawn; its whole path is the tooltip a test and a reader find. */
  it("names the shelf, then what follows it on the line", () => {
    const { container } = render(<ShelfPlace shelf={STAPLES}>LEA · 161</ShelfPlace>);

    expect(screen.getByText("Staples")).toBeInTheDocument();
    expect(screen.getByText("LEA · 161")).toBeInTheDocument();
    // Read as a place rather than a second title.
    expect(container).toHaveTextContent("In Staples·LEA · 161");
    // The shelf's glyph is a picture of the words beside it.
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws no separator when nothing follows", () => {
    const { container } = render(<ShelfPlace shelf={STAPLES} />);
    expect(container).toHaveTextContent(/^In Staples$/);
  });

  it("says the whole path from the root", () => {
    expect(shelfPlaceName(STAPLES)).toBe("Binder › Staples");
    expect(shelfPlaceName({ path: ["Not sorted"] })).toBe("Not sorted");
  });
});

describe("shelfColumn", () => {
  /** A table column that cannot be sorted, and an em dash for a row the census does not know. */
  it("is an unsortable Folder column that names the row's shelf", () => {
    const column = shelfColumn((row: { folder: number }) =>
      row.folder === 1 ? STAPLES : undefined,
    );
    expect(column.header).toBe("Folder");
    expect(column.sortable).toBeUndefined();

    render(<>{column.cell({ folder: 1 })}</>);
    expect(screen.getByText("Staples")).toBeInTheDocument();
    expect(column.cell({ folder: 2 })).toBe("—");
  });
});
