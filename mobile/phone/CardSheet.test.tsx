import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { CARDS } from "../../.storybook/fake/cards";
import type { FakeParams } from "../../.storybook/fake/world";
import { COMBO_CARD_NAMES, ORACLE_TAGGED_NAMES } from "../../.storybook/fake/db";
import { COMBOS_NEVER_FETCHED, COMBOS_NONE } from "@/features/card/combos";
import { ORACLE_TAGS_NEVER_FETCHED, ORACLE_TAGS_UNTAGGED } from "@/features/card/oracleTags";
import { ipc } from "@/lib/ipc";
import { placeHref } from "../routes";
import { CardSheet } from "./CardSheet";
import { usePlace } from "./router";
import { installLayout, renderPhone } from "./testing";

beforeAll(installLayout);
afterEach(() => vi.restoreAllMocks());

/** The sheet as `PhoneFace` mounts it: whatever card the URL names. */
function Host() {
  return <CardSheet cardId={usePlace().cardId} />;
}

const printingOf = (name: string, setCode: string) => {
  const card = CARDS.find((c) => c.name === name && c.setCode === setCode);
  if (card === undefined) throw new Error(`the fake corpus has no ${name} in ${setCode}`);
  return card;
};

/** Four printings, five oracle tags and a place in the fake's combos — every section has rows. */
const ALPHA_BOLT = printingOf("Lightning Bolt", "lea");
const STA_BOLT = printingOf("Lightning Bolt", "sta");

/** A card neither taxonomy nor Spellbook says anything about, found rather than named, so a
 *  regenerated corpus that tagged it moves this pick rather than quietly emptying the test. */
const QUIET = (() => {
  const card = CARDS.find(
    (c) =>
      c.oracleId !== null &&
      !ORACLE_TAGGED_NAMES.includes(c.name) &&
      !COMBO_CARD_NAMES.includes(c.name),
  );
  if (card === undefined) throw new Error("every card in the fake corpus is tagged or in a combo");
  return card;
})();

/** The sheet over Search, opened the way a tile opens it: a push this router marks as its own. */
function openOn(cardId: string, fake?: FakeParams) {
  const path = placeHref({ view: "search", deckId: null, cardId });
  const result = renderPhone(<Host />, { path, fake });
  window.history.replaceState({ pushed: true }, "", path);
  return result;
}

const section = (name: string) => screen.getByRole("region", { name });

describe("the card sheet", () => {
  it("lists the card's printings, and marks the one on screen", async () => {
    openOn(ALPHA_BOLT.id);
    const printings = await screen.findByRole("region", { name: "Printings" });
    await within(printings).findByText("4 printings · 4 release dates");

    // The three others are links to themselves; the one on screen is not a link at all.
    expect(within(printings).getAllByRole("link")).toHaveLength(3);
    const current = within(printings).getByText("Limited Edition Alpha").closest("[aria-current]");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(
      within(printings).getByRole("link", { name: /Strixhaven Mystical Archive/ }),
    ).toHaveAttribute("href", placeHref({ view: "search", deckId: null, cardId: STA_BOLT.id }));
  });

  it("swaps the card for another printing without growing history", async () => {
    openOn(ALPHA_BOLT.id);
    const printings = await screen.findByRole("region", { name: "Printings" });
    const link = await within(printings).findByRole("link", {
      name: /Strixhaven Mystical Archive/,
    });
    const before = window.history.length;

    await userEvent.click(link);

    expect(window.location.search).toBe(`?card=${STA_BOLT.id}`);
    expect(window.history.length).toBe(before);
    // The entry keeps the mark, so the ✕ still leaves by a real Back rather than a rename.
    expect(window.history.state).toEqual({ pushed: true });
    await waitFor(() =>
      expect(
        within(section("Printings"))
          .getByText("Strixhaven Mystical Archive")
          .closest("[aria-current]"),
      ).toHaveAttribute("aria-current", "true"),
    );
    expect(
      within(section("Printings")).getByRole("link", { name: /Limited Edition Alpha/ }),
    ).toBeInTheDocument();
  });

  it("draws the card's oracle tags and the combos that name it", async () => {
    openOn(ALPHA_BOLT.id);
    const tags = await screen.findByRole("list", { name: "Oracle tags" });
    expect(within(tags).getByText("burn")).toBeInTheDocument();

    const combos = await screen.findByRole("list", { name: "Combos" });
    const first = within(combos).getAllByRole("button")[0];
    expect(first).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(first as HTMLElement);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(within(combos).getByRole("list", { name: "Pieces" })).toBeInTheDocument();
  });

  it("states the legality grid's answer folded, and every format unfolded", async () => {
    openOn(ALPHA_BOLT.id);
    const legality = await screen.findByRole("region", { name: "Legality" });
    expect(within(legality).getByText(/^Legal in \d+ of \d+ formats/)).toBeInTheDocument();
    expect(within(legality).queryByRole("list", { name: "Format legality" })).toBeNull();

    await userEvent.click(within(legality).getByRole("button", { name: /Show all/ }));

    const grid = within(legality).getByRole("list", { name: "Format legality" });
    expect(within(grid).getByText("Commander")).toBeInTheDocument();
  });
});

/**
 * Each block's empty says which empty it is. "This card has none" and "the list was never
 * downloaded" are facts about two different things — the card and the reader's database — and a
 * shared sentence would tell a reader on their first launch something false about their card.
 */
describe("the sheet's empty states", () => {
  it("says the tag file was never fetched, rather than that the card is untagged", async () => {
    openOn(ALPHA_BOLT.id, { seed: "starter", fault: "oracleTagsMissing" });
    const tags = await screen.findByRole("region", { name: "Oracle tags" });
    expect(await within(tags).findByText(ORACLE_TAGS_NEVER_FETCHED)).toBeInTheDocument();
    expect(within(tags).queryByText(ORACLE_TAGS_UNTAGGED)).toBeNull();
  });

  it("says a card is untagged once the tag file is here", async () => {
    openOn(QUIET.id);
    const tags = await screen.findByRole("region", { name: "Oracle tags" });
    expect(await within(tags).findByText(ORACLE_TAGS_UNTAGGED)).toBeInTheDocument();
  });

  it("says the combo list was never downloaded, rather than that the card is in none", async () => {
    openOn(ALPHA_BOLT.id, { seed: "combosMissing" });
    const combos = await screen.findByRole("region", { name: "Combos" });
    expect(await within(combos).findByText(COMBOS_NEVER_FETCHED)).toBeInTheDocument();
    expect(within(combos).queryByText(COMBOS_NONE)).toBeNull();
  });

  it("says Spellbook names the card in no combo once the list is here", async () => {
    openOn(QUIET.id);
    const combos = await screen.findByRole("region", { name: "Combos" });
    expect(await within(combos).findByText(COMBOS_NONE)).toBeInTheDocument();
  });

  it("says the combos are being read while they are", async () => {
    vi.spyOn(ipc, "combosForCard").mockReturnValue(new Promise(() => undefined));
    openOn(ALPHA_BOLT.id);
    const combos = await screen.findByRole("region", { name: "Combos" });
    expect(within(combos).getByText("Loading combos…")).toBeInTheDocument();
  });

  it("says a refused combo read was refused, in the backend's words", async () => {
    vi.spyOn(ipc, "combosForCard").mockRejectedValue("the database is locked");
    openOn(ALPHA_BOLT.id);
    const combos = await screen.findByRole("region", { name: "Combos" });
    expect(
      await within(combos).findByText("Couldn't read the combos — the database is locked."),
    ).toBeInTheDocument();
  });
});
