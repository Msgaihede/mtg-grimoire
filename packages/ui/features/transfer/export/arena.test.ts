/**
 * The Arena filter's rule (issue #192).
 *
 * **Every blob below is a real one**, copied out of the live 116,712-printing corpus on
 * 2026-08-22 and trimmed to the keys under test — which matters most for the two cases that
 * decide the key list: `A-Prosperous Thief`, an Alchemy card Arena has and Timeless does not
 * admit, and `Grand Coliseum`, a paper-only card Scryfall marks Gladiator-legal. A hand-written
 * blob would have let either be argued either way.
 */
import { describe, expect, it } from "vitest";
import { transferCard } from "../fixtures";
import { ARENA_LEGALITY_KEYS, isInArena, notInArenaCopies } from "./arena";

const card = (legalities: string | null, quantity = 1) =>
  transferCard({ legalities, quantity });

describe("isInArena", () => {
  it("keeps a card playable in an Arena format", () => {
    // Llanowar Elves (m12 182), playable everywhere Arena runs.
    expect(isInArena(card('{"standard":"legal","historic":"legal","timeless":"legal"}'))).toBe(
      true,
    );
  });

  /**
   * The reason the test is "playable in **an** Arena format" rather than "legal in Arena":
   * Lightning Bolt is banned in Historic and legal in Timeless, and Arena plainly has the card.
   * A rule that read one key would throw it out of an Arena export.
   */
  it("keeps a card banned in one Arena format and legal in another", () => {
    expect(
      isInArena(card('{"historic":"banned","timeless":"legal","standard":"not_legal"}')),
    ).toBe(true);
  });

  /**
   * The Alchemy rebalanced cards — 216 of them — are the whole reason the key list is not just
   * `timeless`. Timeless deliberately excludes rebalanced cards while Arena is the only place
   * they exist at all, so `timeless: "not_legal"` here is Arena saying yes, not no.
   */
  it("keeps an Alchemy rebalanced card that Timeless does not admit", () => {
    // A-Prosperous Thief (neo), `games: ["arena"]`.
    expect(
      isInArena(
        card(
          '{"alchemy":"not_legal","brawl":"legal","competitivebrawl":"legal",' +
            '"historic":"legal","timeless":"not_legal"}',
        ),
      ),
    ).toBe(true);
  });

  it("drops a card legal only in paper formats", () => {
    // Sol Ring (ecc 57): commander, predh, vintage — and nothing Arena runs.
    expect(
      isInArena(card('{"commander":"legal","predh":"legal","vintage":"legal"}')),
    ).toBe(false);
  });

  /**
   * **The measured exception, and the one most likely to be helpfully undone.** Gladiator is a
   * real Arena format and `format_specs` seeds its `games` cell as `arena`, so reading the key
   * list off that seed would include it — but Scryfall's `gladiator` legality is not computed
   * from Arena's card pool. On the corpus of 2026-08-22 it alone accounted for all 37 cards a
   * nine-key list would have kept that have no Arena printing at all.
   */
  it("drops a paper-only card Scryfall marks Gladiator-legal", () => {
    // Grand Coliseum (c16), `games: ["paper"]`.
    expect(
      isInArena(
        card(
          '{"commander":"legal","gladiator":"legal","legacy":"legal",' +
            '"premodern":"legal","vintage":"legal"}',
        ),
      ),
    ).toBe(false);
  });

  /** `restricted` is playable — it is a copy count, not a statement that Arena lacks the card. */
  it("counts a restricted card as playable", () => {
    expect(isInArena(card('{"timeless":"restricted"}'))).toBe(true);
  });

  /**
   * A card Scryfall records as playable nowhere — Alchemy Horizons: Baldur's Gate's own
   * Arena-exclusives read this way, and so does every printing of an unreleased set. Dropped,
   * which is the issue's "not legal" arm: a decklist should not name a card no Arena format
   * will admit.
   */
  it("drops a card with no playable key at all", () => {
    expect(isInArena(card('{"historic":"not_legal","timeless":"not_legal"}'))).toBe(false);
    expect(isInArena(card("{}"))).toBe(false);
  });

  /** An orphan — the printing has left `cards`. Not a card this can say Arena has. */
  it("drops a row with no legalities", () => {
    expect(isInArena(card(null))).toBe(false);
  });

  it("drops a blob it cannot read rather than throwing", () => {
    expect(isInArena(card("not json"))).toBe(false);
    expect(isInArena(card("null"))).toBe(false);
    expect(isInArena(card("[]"))).toBe(false);
    expect(isInArena(card('{"timeless":7}'))).toBe(false);
  });
});

describe("notInArenaCopies", () => {
  /** Copies rather than rows, for `omittedCount`'s reason: four copies of one card on one row
   *  are four cards missing from the file. */
  it("counts copies, not rows", () => {
    const cards = [
      card('{"timeless":"legal"}', 4),
      card('{"commander":"legal"}', 4),
      card(null, 2),
    ];
    expect(notInArenaCopies(cards)).toBe(6);
  });

  it("is 0 when Arena has every card", () => {
    expect(notInArenaCopies([card('{"timeless":"legal"}', 4)])).toBe(0);
  });

  it("is 0 for an empty list", () => {
    expect(notInArenaCopies([])).toBe(0);
  });
});

/**
 * The key list is a *decision* rather than a fact a build answers, so it is pinned: it is
 * `format_specs`' arena-games rows minus `gladiator`, and both halves of that are arguments made
 * in `arena.ts` rather than anything a test can re-derive from the seed, which lives in Rust.
 * A new Arena format is a deliberate edit here as well as there.
 */
describe("ARENA_LEGALITY_KEYS", () => {
  it("is the Arena formats Scryfall's legality data can be trusted for", () => {
    expect([...ARENA_LEGALITY_KEYS]).toEqual([
      "alchemy",
      "brawl",
      "competitivebrawl",
      "future",
      "historic",
      "standard",
      "standardbrawl",
      "timeless",
    ]);
  });

  it("does not include gladiator", () => {
    expect(ARENA_LEGALITY_KEYS).not.toContain("gladiator");
  });
});
