/**
 * The collection step's ManaBox question (issue #873): sort this file into folders and decks by
 * its binders, or land it all at the root as any other file would.
 *
 * **A box, and ticked by default.** A file that names its binders is a file whose reader filed
 * every card once already, and sorting it is what they almost certainly want — but the plain
 * import is still one press away, because a reader restoring into a collection they have since
 * reorganised may want the rows and not ManaBox's drawers. Unticking it gives back the
 * collection step exactly as it was, mode radios included.
 *
 * **Every group is listed before the press**, with what it becomes and how many copies land in
 * it, because the press makes folders and decks the reader did not make themselves — the one
 * import that changes their filing tree rather than only what is in it.
 */
import type { JSX } from "react";
import { count, plural } from "@/lib/counts";
import type { BinderGroup, BinderPlan } from "./binders";

/** The format word the hint names, as the picker spells it — a deck made here opens wearing it. */
const UNSPECIFIED_LABEL = "Unspecified";

export function BinderSort({
  plan,
  checked,
  onChange,
  id,
}: {
  plan: BinderPlan;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id: string;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="flex items-baseline gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            aria-describedby={`${id}-hint`}
            className="accent-accent"
          />
          Sort into folders and decks by binder
        </label>
        <p id={`${id}-hint`} className="text-[0.6875rem] text-dim">
          This file names the binder each card is in. {headline(plan)} A binder goes into the folder
          with its name, which is made if you don&apos;t have one; a deck becomes a new deck in the{" "}
          {UNSPECIFIED_LABEL} format, with its cards added to your collection.
        </p>
      </div>
      {checked && (
        <ul aria-label="Where each binder goes" className="space-y-0.5 text-xs">
          {plan.groups.map((group) => (
            <li key={`${group.target}:${group.name ?? ""}`} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{group.name ?? "No binder"}</span>
              <span className="shrink-0 text-dim">
                {where(group)} · {cards(group.totalCards)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `2 folders and 3 decks.` — only the parts that are there. */
function headline(plan: BinderPlan): string {
  const parts = [
    plan.folders > 0 ? `${count(plan.folders)} ${plan.folders === 1 ? "folder" : "folders"}` : null,
    plan.decks > 0 ? `${count(plan.decks)} ${plan.decks === 1 ? "deck" : "decks"}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : `It has ${parts.join(" and ")}.`;
}

function where(group: BinderGroup): string {
  if (group.target === "deck") return "new deck";
  return group.name === null ? "collection" : "folder";
}

/**
 * What `onDone` reports after a sorted import — what was made, then how many copies landed.
 * Only the parts that are not zero are named.
 */
export function binderDoneMessage(result: {
  folders: number;
  foldersCreated: number;
  decks: readonly unknown[];
  copies: number;
}): string {
  const made = [
    result.folders > 0
      ? plural(result.folders, "folder") +
        (result.foldersCreated > 0 ? ` (${count(result.foldersCreated)} new)` : "")
      : null,
    result.decks.length > 0 ? plural(result.decks.length, "new deck") : null,
  ].filter((part) => part !== null);
  const into = made.length === 0 ? "" : ` into ${made.join(" and ")}`;
  return `${cards(result.copies)} imported${into}.`;
}

/** `1 card`, `3,000 cards` — the collection step's own `cards`, with the thousands separator a
 *  whole ManaBox collection reaches and `plural` does not draw. */
function cards(n: number): string {
  return `${count(n)} ${n === 1 ? "card" : "cards"}`;
}
