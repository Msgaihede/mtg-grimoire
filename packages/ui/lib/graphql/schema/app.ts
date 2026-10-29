/**
 * The graph's half of `lib/ipc/app.ts`: the app's own release notes, which the Change notes
 * widget draws.
 *
 * Read from the notes bundled into this build (`@/lib/bundledReleases`, as `useBundledHistory`
 * reads them) rather than from `update_history`, which asks GitHub — a widget on the home page
 * should not need the network to say what changed.
 */
import type { ReleaseNote } from "@/lib/ipc";
import { builder, invalidatedBy } from "../builder";

const ReleaseNoteRef = builder.objectRef<ReleaseNote>("ReleaseNote").implement({
  description: "One release of MTG Grimoire and what it changed.",
  fields: (t) => ({
    version: t.exposeString("version"),
    tag: t.exposeString("tag"),
    notes: t.exposeString("notes", { description: "The release's notes, as Markdown." }),
    publishedAt: t.exposeString("publishedAt", {
      nullable: true,
      description: "When it was published, as an ISO 8601 date.",
    }),
    htmlUrl: t.exposeString("htmlUrl"),
  }),
});

builder.queryFields((t) => ({
  releaseNotes: t.field({
    // The bundled notes are fixed for the life of the page; this root is never invalidated.
    ...invalidatedBy("bundledReleaseHistory"),
    description: "Every release of the app up to this build, newest first.",
    type: [ReleaseNoteRef],
    args: {
      limit: t.arg.int({ required: false, description: "At most this many releases." }),
    },
    resolve: async (_root, { limit }) => {
      const { BUNDLED_RELEASES } = await import("@/lib/bundledReleases");
      return limit == null ? [...BUNDLED_RELEASES] : BUNDLED_RELEASES.slice(0, Math.max(0, limit));
    },
  }),
}));
