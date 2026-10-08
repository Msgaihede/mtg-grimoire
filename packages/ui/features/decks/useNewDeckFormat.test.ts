import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { FormatSpec } from "@/lib/ipc";
import type { FormatOption } from "./useFormatSpecs";

const formatSpecs = vi.hoisted(() => vi.fn());
const deckLastFormat = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { formatSpecs, deckLastFormat },
}));

import { FIRST_DECK_FORMAT, newDeckFormat, useNewDeckFormat } from "./useNewDeckFormat";

/** A picker as `pickerFormats` builds one: keys and the words they are offered by, nothing else. */
const PICKER: FormatOption[] = [
  { key: "commander", name: "Commander" },
  { key: "modern", name: "Modern" },
  { key: "pauper", name: "Pauper" },
];

/**
 * The whole rule, tested where it lives.
 *
 * Every arm here is a state the app can really be in — a key the seed dropped, a table that has
 * not answered yet — rather than a hypothetical bad argument, which is why they are worth the
 * lines.
 */
describe("newDeckFormat", () => {
  it("offers the format the last deck was made in", () => {
    expect(newDeckFormat(PICKER, "modern")).toBe("modern");
  });

  /**
   * **A remembered key this build no longer offers falls back rather than being shown.**
   * `decks.format_key` is not a foreign key and `format_specs` is re-seeded by migrations, so
   * `deck_last_format` can honestly answer a key that is not on the picker — and a `<select>`
   * set to a value none of its options carries draws the first option while the state says
   * otherwise.
   */
  it("falls back to Commander for a remembered key the picker no longer holds", () => {
    expect(newDeckFormat(PICKER, "premodern")).toBe(FIRST_DECK_FORMAT);
  });

  /** No deck has ever been made on this install — `null` from the row, `undefined` while the
   *  read is pending or after it was refused. Both are the same sentence. */
  it("falls back to Commander when nothing is remembered", () => {
    expect(newDeckFormat(PICKER, null)).toBe(FIRST_DECK_FORMAT);
    expect(newDeckFormat(PICKER, undefined)).toBe(FIRST_DECK_FORMAT);
    // An empty string is a row that says nothing, and is not a format either.
    expect(newDeckFormat(PICKER, "")).toBe(FIRST_DECK_FORMAT);
  });

  /**
   * **The one launch where `format_specs` has not answered yet**, and the arm that looks
   * removable. Both dialogs already render a single `Casual` option for an empty picker; this is
   * what makes the *value* agree with what is on screen, with or without something remembered.
   */
  it("answers casual while the picker is empty, remembered format or not", () => {
    expect(newDeckFormat([], "modern")).toBe("casual");
    expect(newDeckFormat([], null)).toBe("casual");
  });

  /** Commander is checked against the picker like any other key rather than assumed onto it:
   *  `enabled_in_picker` is a cell of the seed, and a seed can change. */
  it("answers casual when the picker somehow does not offer Commander", () => {
    const noCommander = PICKER.filter((f) => f.key !== FIRST_DECK_FORMAT);
    expect(newDeckFormat(noCommander, null)).toBe("casual");
  });
});

const SPECS: FormatSpec[] = PICKER.map((f, i) => ({
  games: ["paper"],
  key: f.key,
  displayName: f.name,
  enabledInPicker: true,
  deckMin: 60,
  deckMax: null,
  maxCopies: 4,
  sideboardMax: 15,
  singleton: false,
  requiresCommander: false,
  commanderRule: null,
  life: 20,
  restrictedSemantic: "max_one",
  hasLegalityData: true,
  maxManaValue: null,
  allowsCompanion: true,
  sortOrder: i,
}));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  formatSpecs.mockReset().mockResolvedValue(SPECS);
  deckLastFormat.mockReset().mockResolvedValue("modern");
});

describe("useNewDeckFormat", () => {
  /** The remembered answer, cached under the `["decks"]` root — which is the whole mechanism
   *  that makes creating a deck refresh it without any call site asking. */
  it("reads the remembered format and caches it under the decks root", async () => {
    const { result } = renderHook(() => useNewDeckFormat(), { wrapper });

    await waitFor(() => expect(result.current).toBe("modern"));
    expect(deckLastFormat).toHaveBeenCalledWith();
    expect(client.getQueryData(["decks", "lastFormat"])).toBe("modern");
  });

  /** A refused read is the same answer as "no deck has been made": a preference that cannot be
   *  read falls back on its default and never fails the dialog it is for. */
  it("falls back to Commander when the read is refused", async () => {
    deckLastFormat.mockRejectedValue("database is busy");

    const { result } = renderHook(() => useNewDeckFormat(), { wrapper });

    await waitFor(() => expect(client.getQueryData(["formatSpecs"])).toBeDefined());
    await waitFor(() =>
      expect(client.getQueryState(["decks", "lastFormat"])?.status).toBe("error"),
    );
    expect(result.current).toBe(FIRST_DECK_FORMAT);
  });
});
