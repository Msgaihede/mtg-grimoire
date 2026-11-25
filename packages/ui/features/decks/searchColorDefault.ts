import type { ColorKey } from "@/features/search/useCardSearch";
import type { FormatSpec } from "@/lib/ipc";
import { MANA_KEYS } from "@/lib/mana";
import { commanderIdentity } from "./validation/commanders";
import type { CardFacts } from "./validation/types";

/**
 * What the docked search's **colour row** opens on for this deck (issue #1725) — the command
 * zone's colour identity, or `null` for no colours.
 *
 * **The validator's identity, not a second one.** `commanderIdentity` is what
 * `colorIdentityIssues` judges the deck against — the union across the active command zone
 * (partners, a Background), the planeswalkers alone under Oathbreaker — so the wall the panel
 * opens on is exactly the cards that rule would not mark. Only **active** `commander` piles
 * count, which is `validation/engine.ts`'s reading: a commander parked in a switched-off pile is
 * an alternative, not the one being built around.
 *
 * `null` when the format has no commander rule (the colour row is nobody's business there) and
 * when the zone has no definer yet — an absent commander has no identity, which is not the same
 * statement as a colourless one. A colourless commander answers `["C"]`, the row's
 * colourless-only chip, since the backend reads an empty identity as no filter at all.
 *
 * The letters are in WUBRG order, so two calls over the same zone answer the same string and the
 * editor can memoise on it.
 */
export function searchColorDefault(
  cards: readonly CardFacts[],
  spec: FormatSpec | null,
): readonly ColorKey[] | null {
  if (spec === null || spec.commanderRule === null) return null;
  const zone = cards.filter((card) => card.categoryActive && card.categoryKind === "commander");
  const identity = commanderIdentity(zone, spec);
  if (identity === null) return null;
  if (identity.size === 0) return ["C"];
  return MANA_KEYS.filter((key) => key !== "C" && identity.has(key));
}
