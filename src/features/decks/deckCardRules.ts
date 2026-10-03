/**
 * The rules a deck card's own rows are greyed by — which pile it is already in, whether it may
 * be the deck's commander or companion, and which finishes it can be played in.
 *
 * **A leaf, split out of `deckCardMenu.tsx` on 2026-10-03**, because two surfaces ask these
 * questions now: the desktop's right-click menu, and the light app's phone face, whose deck page
 * offers the same writes from an action sheet. The menu reaches the app store through the shared
 * card menu (`cardMenu.tsx` → `useDeck`), which the phone face's fence refuses, so the rules came
 * out rather than a second spelling of each going in. What stays in the menu is how it *draws* an
 * answer — its icons, and its silence on a greyed zone row; a phone sheet has the room to say the
 * refusal in words, and does.
 */
import { parseFinishes } from "@/lib/finish";
import type { DeckCard, DeckCategory, DeckFinish, FormatSpec } from "@/lib/ipc";
import { commanderIneligibility } from "./validation/commanders";
import { companionIssues } from "./validation/companions";

/**
 * What a row says when the card is already in the pile it names.
 *
 * Two rows are greyed by it — the card's own category under `Category`, and a zone row on the
 * card that fills it — and both are the same statement, so it is one string. Only the first
 * **draws** it on the desktop's menu, since 2026-08-17: a zone row greys wordlessly there, for the
 * reason on `deckCardMenu.tsx`'s `zoneItem`. Not a *refusal* in `validation/`'s sense: nothing is
 * wrong with the card, there is simply nothing for the press to write.
 */
export const ALREADY_HERE = "already here";

/**
 * What the app calls a nonfoil copy **in the deck editor**, and it is deliberately not
 * `FINISH_LABEL.nonfoil`.
 *
 * "Set as nonfoil" is not a thing anybody says. The collection's picker is choosing between
 * three named finishes and `Nonfoil` is the right word there; here the reader is toggling one
 * card back off foil, and the opposite of foil is a regular card.
 */
export const REGULAR = "Regular";

/**
 * The finishes this printing can be **played** in, as a deck row's values.
 *
 * `nonfoil` becomes `null`, which is the one spelling of the regular copy that reaches
 * `deck_cards.finish` — see `DeckFinish`. A printing whose `finishes` column is empty or
 * unreadable answers `[null]`, so the row greys: unknown is not a choice to offer.
 */
export function finishChoices(finishes: string | null): DeckFinish[] {
  const listed = parseFinishes(finishes);
  if (listed.length === 0) return [null];
  return listed.map((f) => (f === "nonfoil" ? null : f));
}

/**
 * Why this card cannot be the deck's companion, in the validation panel's own words, or `null`.
 *
 * **Judged as one copy, and against the deck with this row taken out** — which is the deck the
 * reader would have if they pressed the row. The row's removal matters because a companion is
 * not part of the starting deck its own condition is checked against. The copy count matters
 * because `companionIssues` also counts the zone: a four-of judged as itself would be refused
 * with "you have 4 companions", which is a reason the *deck* is wrong rather than a reason this
 * card cannot be a companion, and greying the row on it would tell the reader that Lutri is not
 * a companion.
 *
 * **The consequence is that a 4-of gets a live row whose press makes a deck the panel refuses**,
 * with `companion-count`, the moment the four copies land in the zone. That is the right place
 * for it — a row answers "may this card be your companion" and the panel answers "is this deck
 * legal", and the second question is not one a row can ask before it is pressed. It is also a
 * state a reader reaches by every other route: dragging a 4-of onto the Companion pile does
 * exactly the same thing.
 *
 * Inactive categories are filtered out for `engine.ts`' reason: a switched-off pile counts
 * toward nothing, so a condition judged against one would be judged against cards that are not
 * in the deck.
 */
export function companionRefusal(
  card: DeckCard,
  cards: readonly DeckCard[],
  spec: FormatSpec | null,
): string | null {
  if (spec === null) return null;
  const deck = cards.filter((row) => row.id !== card.id && row.categoryActive);
  const issues = companionIssues([{ ...card, quantity: 1 }], deck, spec);
  return issues.find((issue) => issue.severity === "error")?.message ?? null;
}

/** One claim a card can make about itself in this deck — "this is the commander". */
export interface ZoneClaim {
  zone: "commander" | "companion";
  /** `Set as commander` / `Set as companion` — the press's words on every surface. */
  label: string;
  /** The pile the press moves the card into. */
  categoryId: number;
  /** Why the press is refused — {@link ALREADY_HERE}, or `validation/`'s own sentence — or
   *  `null` where it may be pressed. */
  refusal: string | null;
}

/**
 * **Set as commander** and **Set as companion** — present only where the format has the zone,
 * refused where the card cannot fill it.
 *
 * The presence test is the format's (`requiresCommander` / `allowsCompanion`), so neither ever
 * appears in Standard or Modern; the eligibility test is `validation/`'s, so a card this offers is
 * a card the validation panel will accept. A looser rule here would offer a card the panel then
 * refuses, which is the one thing the deck surface must never do — the importer's commander step
 * is fenced by the same function for the same reason.
 *
 * A zone the deck has no category for is **absent** rather than refused: the write is a move into
 * that category, so with no category there is nothing to move into, and an item that exists only
 * to be refused is worse than one that is not there (`categoryMenu.tsx` drops its two rows on the
 * same argument).
 *
 * A card that is **already in** the zone is refused too, for the reason its own pile is greyed
 * under `Category`: the write would be a move from a category to itself. It is the one refusal
 * here that is not `validation/`'s, because it is not a question about the card — the reigning
 * commander is by definition an eligible one.
 *
 * **These are claims, and filing is not**: moving a card into the Commander pile by its category
 * is live for a card this refuses, because it is the same gesture as a drag onto that pile's
 * heading. `deckCardMenu.tsx`'s header carries that asymmetry and why both halves are right.
 */
export function zoneClaims(
  card: DeckCard,
  categories: readonly DeckCategory[],
  cards: readonly DeckCard[],
  spec: FormatSpec | null,
): ZoneClaim[] {
  if (spec === null) return [];
  const claims: ZoneClaim[] = [];

  const commander = categories.find((c) => c.kind === "commander");
  if (spec.requiresCommander && spec.commanderRule !== null && commander !== undefined) {
    claims.push({
      zone: "commander",
      label: "Set as commander",
      categoryId: commander.id,
      refusal:
        card.categoryId === commander.id
          ? ALREADY_HERE
          : commanderIneligibility(card, spec.commanderRule, spec),
    });
  }

  const companion = categories.find((c) => c.kind === "companion");
  if (spec.allowsCompanion && companion !== undefined) {
    claims.push({
      zone: "companion",
      label: "Set as companion",
      categoryId: companion.id,
      refusal:
        card.categoryId === companion.id ? ALREADY_HERE : companionRefusal(card, cards, spec),
    });
  }
  return claims;
}
