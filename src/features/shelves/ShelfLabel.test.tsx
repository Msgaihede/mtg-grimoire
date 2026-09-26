import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShelfLabel } from "./ShelfLabel";

describe("ShelfLabel", () => {
  /** `h3`, as `PinnedFolders`' Decks heading was: the page's own sr-only heading is the `h2`, and
   *  the app-owned shelves under it are `h4` (`headingLevel`). */
  it("heads the collection's deck groups", () => {
    render(<ShelfLabel group="decks" />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveAccessibleName("Decks");
  });

  it("heads the wishlist's managed folders", () => {
    render(<ShelfLabel group="managed" />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveAccessibleName("Managed by decks");
  });
});
