import { describe, expect, it } from "vitest";
import type { CollectionFolder } from "@/lib/ipc";
import { countEditableIn, quantityRefusal } from "./entryFences";

const folder = (id: number, kind: string, name: string): CollectionFolder =>
  ({ id, kind, name, parentId: null, deckId: kind === "deck" ? 9 : null, sortOrder: 0 }) as CollectionFolder;

const CABINET = [
  folder(1, "user", "Binder"),
  folder(4, "deck", "Modern Goodstuff"),
  folder(8, "removed", "Recently removed"),
  folder(9, "someday", "A kind nobody has thought about"),
];

describe("countEditableIn", () => {
  it("lets the root, a drawer the reader made and Recently removed be stepped", () => {
    expect(countEditableIn(CABINET, null)).toBe(true);
    expect(countEditableIn(CABINET, 1)).toBe(true);
    expect(countEditableIn(CABINET, 8)).toBe(true);
  });

  it("fences a deck's group, a kind it does not know, and a drawer the census has not answered for", () => {
    expect(countEditableIn(CABINET, 4)).toBe(false);
    expect(countEditableIn(CABINET, 9)).toBe(false);
    // Fail closed: the folder list starts empty.
    expect(countEditableIn([], 1)).toBe(false);
    expect(countEditableIn([], null)).toBe(true);
  });
});

describe("quantityRefusal", () => {
  it("names the deck and the way out for a deck's copies", () => {
    expect(quantityRefusal(CABINET, { folderId: 4, folderName: "Modern Goodstuff" })).toBe(
      "In Modern Goodstuff. Remove it from the deck to change the quantity.",
    );
  });

  it("names no mechanism for anything else that is not the reader's own filing", () => {
    expect(quantityRefusal(CABINET, { folderId: 9, folderName: null })).toBe(
      "In a folder you did not make. Move it into one of your folders to change the quantity.",
    );
  });

  it("refuses nothing the reader may step", () => {
    expect(quantityRefusal(CABINET, { folderId: null, folderName: null })).toBeNull();
    expect(quantityRefusal(CABINET, { folderId: 8, folderName: "Recently removed" })).toBeNull();
  });
});
