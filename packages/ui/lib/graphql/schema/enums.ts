/**
 * The closed words more than one domain file of the graph speaks. Each is built from the
 * constant or union the app already spells, so a word added there is a value here.
 *
 * An enum only one domain uses lives in that domain's file instead.
 */
import { CONDITIONS } from "@/lib/conditions";
import { FINISHES } from "@/lib/finish";
import type { DeckVariant, TagNamespace } from "@/lib/ipc";
import { builder } from "../builder";

export const FinishEnum = builder.enumType("Finish", {
  description: "A printing's finish.",
  values: FINISHES,
});

export const ConditionEnum = builder.enumType("Condition", {
  description: "A copy's condition. `NONE` is a copy nobody graded.",
  values: CONDITIONS,
});

const DECK_VARIANTS = ["live", "theory"] as const satisfies readonly DeckVariant[];

export const DeckVariantEnum = builder.enumType("DeckVariant", {
  description:
    "Which list of a deck: `live` is the deck as built, `theory` the version being planned.",
  values: DECK_VARIANTS,
});

const TAG_NAMESPACES = ["art", "oracle"] as const satisfies readonly TagNamespace[];

export const TagNamespaceEnum = builder.enumType("TagNamespace", {
  description:
    "One of Scryfall's two Tagger datasets: `oracle` tags say what a card does, `art` tags what its illustration shows.",
  values: TAG_NAMESPACES,
});
