/**
 * The graph's half of `lib/ipc/entryTags.ts`: every entry tag in use — the reader's free-text tags
 * on collection entries and wishes, counted across both.
 *
 * An entry tag is not a Scryfall tag (`./tags.ts`), a deck label or a deck tag
 * (`docs/agent/DOMAIN_VOCABULARY.md`). A row's own entry tags are its `entryTags` field, in
 * `./collection.ts` and `./wishlist.ts`.
 */
import { entryTagsInUse } from "@/features/entryTags/entryTags";
import type { EntryTagUse } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { builder, invalidatedBy } from "../builder";

export const EntryTagUseRef = builder.objectRef<EntryTagUse>("EntryTagUse").implement({
  description: "One entry tag and how many collection entries and wishes wear it.",
  fields: (t) => ({
    tag: t.exposeString("tag"),
    count: t.exposeInt("count", { description: "Collection entries and wishes, summed." }),
  }),
});

builder.queryFields((t) => ({
  entryTagsInUse: t.field({
    // Its own root, and the two lists' too: removing a stack or a wish moves a count.
    ...invalidatedBy("entryTags", "collection", "wishlist"),
    description:
      "Every entry tag the reader has put on a collection entry or a wish, with how many wear it — alphabetical. Not Scryfall tags, deck labels or deck tags.",
    type: [EntryTagUseRef],
    args: {
      exactSpelling: t.arg.boolean({
        required: false,
        description:
          "`true`: one row per exact spelling (`Cube` and `cube` apart), sorted by byte order. Default `false`: spellings differing only in capitals folded into one row, named by the spelling more stacks use — what the app's tag field suggests.",
      }),
    },
    resolve: async (_root, args) => {
      const rows = await ipc.entryTagsInUse();
      return args.exactSpelling ? rows : entryTagsInUse(rows);
    },
  }),
}));
