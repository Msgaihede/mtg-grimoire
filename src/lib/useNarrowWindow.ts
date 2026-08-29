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
