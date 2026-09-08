import type { JSX } from "react";

/**
 * A destination that is in the rail before it is a page.
 *
 * **One component rather than one per placeholder**, which is the same argument `nav.ts` makes
 * about the label: two views drawing one sentence two ways is a drift nothing goes red for, and
 * the sentence is the whole of what either of them says today. What each caller supplies is its
 * own word, because that word is the heading a screen reader lands on.
 *
 * **The `<h2>` is `sr-only`, exactly as every real page's is.** The ribbon draws the view's name
 * as the window's `<h1>` from `NAV`, so a visible second copy of it here would be the name twice
 * on one screen — and a page with no heading at all leaves the region unnamed for anyone reading
 * by landmark. Both halves are what `SearchPage`, `CollectionPage` and the rest already do.
 *
 * **It says what is true and promises nothing.** "Work in progress" is a statement about the
 * page; a sentence naming a plan or a release would be a claim this component cannot keep, and
 * the app's first placeholder (`App.tsx`'s deleted `BLURB` map) is the precedent for how long
 * such a promise outlives the thing it described.
 */
export function WorkInProgress({ view }: { view: string }): JSX.Element {
  return (
    <section className="grid h-full place-items-center">
      <h2 className="sr-only">{view}</h2>
      <p className="text-dim">Work in progress</p>
    </section>
  );
}
