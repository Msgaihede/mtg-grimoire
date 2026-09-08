import { useSyncExternalStore } from "react";
import { PHONE_PX } from "@/lib/viewports";

/**
 * The query itself, built from `PHONE_PX` rather than typed — so the branch moves if that
 * constant does, and there is no second place for the number to live.
 */
const QUERY = `(max-width: ${PHONE_PX}px)`;

/**
 * Whether the window is too narrow to stand a navigation rail beside the content.
 *
 * **This is the one viewport branch in this app, and `src/lib/viewports.ts` demands a reason at
 * the site of any such branch.** That module says its constants are "widths to look at, not
 * breakpoints to branch on", and it is right about every other fold here: `FilterBar` is the
 * search page's 1500px bar *and* the deck editor's 206px docked panel, `DeckEditor` measures its
 * desk with a `ResizeObserver`, and `CardGrid` measures its own wall — because a component drawn
 * in more than one box cannot learn anything about the box it is in by asking the window.
 *
 * **`AppShell` is the exception that proves that rule, because the shell _is_ the window.** It is
 * drawn in exactly one box, that box is the viewport, and the question being asked — is there
 * room for a 208px rail beside the content — is a question about the window and nothing else. A
 * container query here would be a query about the shell's own root, which is the window measured
 * the long way round; a `ResizeObserver` would be the same answer with a frame of lag and an
 * observer to keep. So this is the site where the window is genuinely the subject, and it is a
 * hook with its own test rather than a call inside a component so that there is one of it.
 *
 * **A reviewer meeting this branch is right to challenge it**; the paragraph above is the answer,
 * and the test to apply to a *second* one is the same: name the box the question is about, and if
 * it is not the window, this is not the mechanism.
 *
 * **`ScannerPage` reads it, and reads it as _this_ branch rather than as a second one.** A phone
 * stacks the camera above the verdict where a desk stands them side by side, and the answer it
 * wants is the shell's own — am I in the phone shape — rather than a measurement of its own box.
 * That is `CollectionPage`'s sentence and it is the shape every consumer here takes: the reason
 * a *branch* needs is the one the paragraph above sets, and consuming an answer the shell has
 * already decided needs no new one. **This names the reader rather than counting them**, because
 * a count in a doc comment is a fact about a tree that every branch has a different version of;
 * `grep -n "useNarrowWindow()" src/` is the census, and it answers with more than one.
 *
 * **The first `matchMedia` in shipped code.** `useSyncExternalStore` rather than an effect that
 * sets state — `src/CLAUDE.md`'s rule against `setState` inside an effect makes that alternative
 * a lint failure at `npm run verify` rather than at edit time, and React's own subscription
 * primitive reads the store during render instead of one paint later.
 *
 * **The platform is asked at read time and no `MediaQueryList` is kept.** A module-level one
 * would be built against whatever `matchMedia` was when this file was first imported, which under
 * jsdom is before any test has stated a width; `matchMedia` is a cheap lookup and the honest
 * spelling is to make it.
 */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow);
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(QUERY).matches;
}
