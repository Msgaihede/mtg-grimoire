import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { DeckRow, DraftDeckRef } from "@/lib/ipc";
import { DRAFT_DECKS_KEY, isDraftDeckIn, rememberDraftDeck } from "./useDraftDecks";

/**
 * Issue #1467: deck ids are reused after a delete, so the unsaved list names a draft deck by its
 * id **and** its uid, and a deck is a draft deck only when both match.
 */
describe("isDraftDeckIn", () => {
  const list: DraftDeckRef[] = [{ id: 4, syncUid: "draft-uid" }];

  it("matches a deck by its id and uid both", () => {
    expect(isDraftDeckIn(list, { id: 4, syncUid: "draft-uid" })).toBe(true);
  });

  it("never matches an ordinary deck that took a deleted draft deck's id", () => {
    expect(isDraftDeckIn(list, { id: 4, syncUid: "my-own-uid" })).toBe(false);
  });

  it("never matches a deck with no uid, nor another id under the same uid", () => {
    expect(isDraftDeckIn(list, { id: 4, syncUid: null })).toBe(false);
    expect(isDraftDeckIn(list, { id: 5, syncUid: "draft-uid" })).toBe(false);
    expect(isDraftDeckIn([], { id: 4, syncUid: "draft-uid" })).toBe(false);
  });
});

describe("rememberDraftDeck", () => {
  const row = (id: number, syncUid: string | null) => ({ id, syncUid }) as DeckRow;

  it("puts the new deck on the cached list, replacing a stale entry under its id", () => {
    const client = new QueryClient();
    client.setQueryData<DraftDeckRef[]>(
      [...DRAFT_DECKS_KEY],
      [
        { id: 2, syncUid: "kept" },
        { id: 4, syncUid: "deleted-draft" },
      ],
    );
    rememberDraftDeck(client, row(4, "fresh"));
    expect(client.getQueryData([...DRAFT_DECKS_KEY])).toEqual([
      { id: 2, syncUid: "kept" },
      { id: 4, syncUid: "fresh" },
    ]);
  });

  it("puts nothing on the list for a row without a uid", () => {
    const client = new QueryClient();
    rememberDraftDeck(client, row(4, null));
    expect(client.getQueryData([...DRAFT_DECKS_KEY])).toBeUndefined();
  });

  it("is under the decks root, so every deck write's invalidation asks it again", () => {
    expect(DRAFT_DECKS_KEY[0]).toBe("decks");
  });
});
