/**
 * The graph's half of `lib/ipc/tags.ts`: Scryfall's two Tagger datasets — **Oracle Tags** (what a
 * card does: `removal`, `ramp`) and **Art Tags** (what an illustration shows: `dragon`, `forest`)
 * — their tree, their search, each dataset's freshness, and the tags the reader has muted.
 *
 * A "tag" in this file is only ever one of those two datasets: never an entry tag on a collection
 * or wishlist row, a deck tag, a deck label or a keyword ability (`docs/agent/DOMAIN_VOCABULARY.md`).
 *
 * Left out on purpose: `tagResolve`, which `../filters.ts` already runs for every `otag:`/`atag:` a
 * search query names; the progress listeners, which are events rather than reads; and
 * `tagMute`/`tagUnmute`, which write.
 */
import {
  ipc,
  type CardTags,
  type MutedTag,
  type PrintingTags,
  type TagHit,
  type TagRef,
  type TagStatus,
} from "@/lib/ipc";
import { builder, invalidatedBy } from "../builder";
import { TagNamespaceEnum } from "./enums";

const SLUGS_DESCRIPTION =
  "Oracle tag slugs (`removal`, `ramp`), sorted, with every ancestor tag included. Empty for an untagged card, an unknown id, and a database that has never downloaded the Oracle tags — check `oracleTagsStatus` to tell them apart.";

const NAMESPACE_ARG_DESCRIPTION =
  "Which dataset: `oracle` (what a card does) or `art` (what an illustration shows). Absent asks both, Art Tags ranked first.";

export const TagRefRef = builder.objectRef<TagRef>("TagRef").implement({
  description:
    "A Scryfall tag named from somewhere else — enough to show it and ask about it again.",
  fields: (t) => ({
    slug: t.exposeString("slug", {
      description:
        "The tag's slug, e.g. `spot-removal` — what `otag:`/`atag:` take in a search query.",
    }),
    label: t.exposeString("label", { description: "The tag's name for display." }),
    namespace: t.expose("namespace", { type: TagNamespaceEnum }),
  }),
});

export const TagHitRef = builder.objectRef<TagHit>("TagHit").implement({
  description:
    "One Scryfall tag (an Oracle Tag or an Art Tag) with its reach and its place in the tag tree. Muted tags never appear.",
  fields: (t) => ({
    slug: t.exposeString("slug", {
      description:
        "The tag's slug — what `otag:` (Oracle) or `atag:` (Art) take in a search query.",
    }),
    id: t.exposeString("id", {
      description:
        "Scryfall's stable id for the tag. May be empty on a database not refreshed lately.",
    }),
    label: t.exposeString("label", { description: "The tag's name for display." }),
    namespace: t.expose("namespace", { type: TagNamespaceEnum }),
    description: t.exposeString("description", {
      nullable: true,
      description: "Scryfall's own description of the tag.",
    }),
    cardCount: t.exposeInt("cardCount", {
      description:
        "How many subjects the tag reaches, its descendants included: oracle cards for an Oracle Tag, illustrations for an Art Tag. Not a count of printings.",
    }),
    childCount: t.exposeInt("childCount", {
      description: "How many direct child tags it has (muted ones not counted).",
    }),
    parents: t.expose("parents", {
      type: [TagRefRef],
      description: "Every parent tag — a tag can sit under several.",
    }),
  }),
});

export const TagStatusRef = builder.objectRef<TagStatus>("TagStatus").implement({
  description:
    "How fresh one of Scryfall's tag datasets is on this machine. Every nullable field is null when the dataset has never been downloaded.",
  fields: (t) => ({
    updatedAt: t.exposeString("updatedAt", {
      nullable: true,
      description: "Scryfall's own timestamp for the file these tags came from.",
    }),
    ingestedAt: t.exposeFloat("ingestedAt", {
      nullable: true,
      description: "When the dataset was last loaded, in Unix seconds. Null: never downloaded.",
    }),
    checkedAt: t.exposeFloat("checkedAt", {
      nullable: true,
      description: "When Scryfall was last asked whether a newer file exists, in Unix seconds.",
    }),
    tagCount: t.exposeInt("tagCount", { nullable: true, description: "Tags in the dataset." }),
    taggingCount: t.exposeInt("taggingCount", {
      nullable: true,
      description: "Tag-to-subject assignments in the dataset.",
    }),
    stale: t.exposeBoolean("stale", { description: "A refresh is due." }),
    refreshing: t.exposeBoolean("refreshing", { description: "A refresh is running right now." }),
  }),
});

export const MutedTagRef = builder.objectRef<MutedTag>("MutedTag").implement({
  description:
    "A Scryfall tag the reader has hidden from the tag search and the tag tree. Muting hides the tag, never a card.",
  fields: (t) => ({
    namespace: t.expose("namespace", { type: TagNamespaceEnum }),
    tagId: t.exposeString("tagId", { description: "Scryfall's stable id for the tag." }),
    slug: t.exposeString("slug", {
      description: "The slug as it read when the tag was muted. May be out of date.",
    }),
    mutedAt: t.exposeFloat("mutedAt", { description: "When it was muted, in Unix seconds." }),
  }),
});

export const CardTagsRef = builder.objectRef<CardTags>("CardOracleTags").implement({
  description: "One card's Oracle Tags, keyed by its oracle id.",
  fields: (t) => ({
    oracleId: t.exposeString("oracleId"),
    slugs: t.exposeStringList("slugs", { description: SLUGS_DESCRIPTION }),
  }),
});

export const PrintingTagsRef = builder.objectRef<PrintingTags>("PrintingOracleTags").implement({
  description:
    "One printing's Oracle Tags (the card's, since every printing shares them), keyed by the printing id.",
  fields: (t) => ({
    cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
    slugs: t.exposeStringList("slugs", { description: SLUGS_DESCRIPTION }),
  }),
});

builder.queryFields((t) => ({
  tagSearch: t.field({
    ...invalidatedBy("tag-search"),
    description:
      "Find Scryfall tags (Oracle Tags and Art Tags) by name: the exact match first, then names starting with the text, then names containing it. Empty text lists the tags with the widest reach. Muted tags are left out.",
    type: [TagHitRef],
    args: {
      text: t.arg.string({
        required: false,
        defaultValue: "",
        description: "Part of a tag's name, e.g. `remov` or `dragon`.",
      }),
      namespace: t.arg({
        type: TagNamespaceEnum,
        required: false,
        description: NAMESPACE_ARG_DESCRIPTION,
      }),
      limit: t.arg.int({
        required: false,
        defaultValue: 50,
        description: "At most this many tags.",
      }),
    },
    resolve: (_root, args) =>
      ipc.tagSearch(args.text ?? "", args.namespace ?? "both", args.limit ?? 50),
  }),

  tagChildren: t.field({
    ...invalidatedBy("tag-children"),
    description:
      "One level of the Scryfall tag tree: the direct children of a tag, or the top-level tags when no parent is named. Every child is listed, unlimited. Muted tags (and so their subtrees) are left out.",
    type: [TagHitRef],
    args: {
      namespace: t.arg({
        type: TagNamespaceEnum,
        required: false,
        description: NAMESPACE_ARG_DESCRIPTION,
      }),
      parent: t.arg.string({
        required: false,
        description: "The parent tag's slug. Absent: the top-level tags.",
      }),
    },
    resolve: (_root, args) => ipc.tagChildren(args.namespace ?? "both", args.parent ?? null),
  }),

  mutedTags: t.field({
    ...invalidatedBy("tags-muted"),
    description:
      "The Scryfall tags the reader has muted, by dataset and then by slug. A muted tag is hidden from tag search and the tag tree; its cards are not hidden.",
    type: [MutedTagRef],
    resolve: () => ipc.tagsMuted(),
  }),

  oracleTagsForCards: t.field({
    ...invalidatedBy("tags", "oracleTags"),
    description:
      "The Oracle Tags (what a card does) of a set of cards, by oracle id. One entry per distinct id — match rows by `oracleId`, never by position. A single card's are also on `CardSummary.oracleTags` and `CardDetail.oracleTags`.",
    type: [CardTagsRef],
    args: {
      oracleIds: t.arg.stringList({ required: true, description: "Oracle ids." }),
    },
    resolve: (_root, args) => ipc.oracleTagsForCards(args.oracleIds),
  }),

  oracleTagsForPrintings: t.field({
    ...invalidatedBy("tags", "oracleTags"),
    description:
      "The Oracle Tags (what a card does) of a set of printings, by printing id. One entry per distinct id — match rows by `cardId`, never by position.",
    type: [PrintingTagsRef],
    args: {
      cardIds: t.arg.stringList({ required: true, description: "Printing ids." }),
    },
    resolve: (_root, args) => ipc.oracleTagsForPrintings(args.cardIds),
  }),

  oracleTagsStatus: t.field({
    ...invalidatedBy("tags", "oracleTags"),
    description:
      "How fresh the Oracle Tags dataset (what a card does) is on this machine. Never fails — a dataset never downloaded answers nulls with `stale: true`.",
    type: TagStatusRef,
    resolve: () => ipc.oracleTagsStatus(),
  }),

  artTagsStatus: t.field({
    ...invalidatedBy("artTags"),
    description:
      "How fresh the Art Tags dataset (what an illustration shows) is on this machine. Never fails — a dataset never downloaded answers nulls with `stale: true`.",
    type: TagStatusRef,
    resolve: () => ipc.artTagsStatus(),
  }),
}));
