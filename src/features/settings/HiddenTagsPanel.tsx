import type { JSX } from "react";
import { Eye } from "lucide-react";
import { TAG_NAMESPACE_LABEL } from "@/features/tags/namespaces";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import type { HiddenTags } from "./useHiddenTags";

/**
 * The tags the reader has switched off, and the only way back.
 *
 * **This panel exists because the rail promises it in as many words.** Hiding a tag from its row
 * on the Tags page raises a live line reading *"Hidden tags, and anything filed under them, come
 * back from Settings."* — and driving the shipped window on 2026-08-20 found that sentence
 * pointing at a page with no such list: `tags_muted` and `tag_unmute` were wired all the way
 * through Rust and `ipc.ts` and nothing rendered them, so hiding a tag was a one-way door and
 * the app said otherwise. Of the two ways to make that sentence true, deleting it is the worse
 * one: muting is Scryfall's own ask of downstream apps (Tagger is crowdsourced), a reader will
 * use it, and a filter you cannot lift is not a filter.
 *
 * **A muted category takes its whole subtree with it**, because the children are not roots — so
 * one row here can be a great deal more than one tag, which is why the prose says so and why the
 * button is `Show again` rather than `Delete`.
 *
 * **The name is the slug as it read when the tag was hidden, and is deliberately not looked up
 * again.** `tags::muted::list` does not join the live taxonomy: a mute is keyed on Scryfall's
 * uuid precisely so that a rename cannot lose it, and a tag Tagger has since renamed or deleted
 * must still be listed and must still be removable. So the stored word is the honest one to
 * print, and the sentence above the list is what stops it reading as a stale render.
 */
export function HiddenTagsPanel({ hidden }: { hidden: HiddenTags }): JSX.Element {
  const { tags, show, pending, error } = hidden;

  return (
    <SettingsSection id="hidden-tags" title="Hidden tags">
      <p className="text-sm text-dim">
        {/* One sentence for the state and one for the mechanism, and the mechanism is said even
            when the list is empty: this panel is where a reader arrives *looking* for a tag they
            hid, and "nothing here" with no explanation is where they stop. */}
        {tags !== null && tags.length === 0
          ? "You have not hidden any tags. Right-click a tag on the Tags page to hide it and everything filed under it."
          : "These tags are not offered on the Tags page — nor is anything filed under them. Names are as they read when you hid them, so a tag Scryfall has since renamed keeps its old word here."}
      </p>

      {tags !== null && tags.length > 0 && (
        <ul className="space-y-2">
          {tags.map((tag) => (
            <li
              // The two taxonomies are separate id spaces that share plenty of slugs, so one
              // uuid appearing in both is two rows and neither half alone is a key.
              key={`${tag.namespace}:${tag.tagId}`}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2 first:border-t-0 first:pt-0"
            >
              <p className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="truncate text-text">{tag.slug}</span>
                {/* Not `TagNamespaceMark`: that one is `aria-hidden` because every rail row
                    composes the namespace into its own accessible name, and here the row has no
                    composed name to fold it into — the word is the only thing saying which of
                    two taxonomies a shared slug came from. */}
                <span className="flex-none text-[0.625rem] uppercase tracking-wide text-dim">
                  {TAG_NAMESPACE_LABEL[tag.namespace]}
                </span>
              </p>
              <button
                type="button"
                onClick={() => show(tag)}
                disabled={pending !== null}
                aria-busy={pending === tag.tagId || undefined}
                // Named for the tag rather than for the action: a column of buttons all called
                // "Show again" is a column a screen reader cannot tell apart, and the visible
                // word still leads the name (WCAG 2.5.3).
                aria-label={`Show again — ${tag.slug}, ${TAG_NAMESPACE_LABEL[
                  tag.namespace
                ].toLowerCase()} tag`}
                className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
              >
                <Eye className="size-4" aria-hidden="true" />
                Show again
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* `problem`, unlike the cache panel's: a press that did not happen left a tag hidden that
          the reader asked to have back, and the list above still shows it — so the red is the
          only thing distinguishing "refused" from "nothing happened yet". */}
      <PanelAlert tone="problem">{error}</PanelAlert>
    </SettingsSection>
  );
}
