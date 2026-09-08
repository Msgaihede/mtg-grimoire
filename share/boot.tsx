import type { ReactNode } from "react";
import { parseSnapshot } from "@/lib/shareSnapshot";
import {
  SharePage,
  ShareNotice,
  snapshotHref,
  SNAPSHOT_OFFLINE,
  SNAPSHOT_PENDING,
} from "./SharePage";

/**
 * **The three-way branch that decides what a stranger sees**, in a module a test can call.
 *
 * It is not in `main.tsx` because that file is a *side effect*: it installs a stylesheet, takes
 * the shell's own out, creates a React root and calls this once. Importing it to test the branch
 * would run all of that against a jsdom document that is not a share shell — so the entry point
 * keeps the side effects and this keeps the decision.
 *
 * Everything it touches is injected for the same reason: `doc` because the snapshot's URL is read
 * out of the shell's own `<link>`, `fetch` because the assertion that matters most about it is
 * *how it is called*, and `render` because who owns the React root is `main.tsx`'s business.
 */
export interface BootDeps {
  /** Where the `<link id="snapshot">` is read from. */
  doc: Document;
  /** How the blob is fetched. See the call below for why it is called with no options. */
  fetch: typeof globalThis.fetch;
  /** Draw this. Called at least once and at most twice — the waiting state, then the answer. */
  render: (view: ReactNode) => void;
}

/**
 * What is drawn while the blob is in flight.
 *
 * A sentence rather than a spinner: on a warm cache this is one frame, and on a cold one the
 * reader wants to know the link worked before they want to know how far along it is.
 */
export const OPENING = "Opening the collection…";

/** Under {@link SNAPSHOT_PENDING} — the publish resolves in seconds, so the advice is "reload". */
export const PENDING_DETAIL = "The collection is still uploading. Reload this page in a moment.";

/** Under whatever went wrong. The one thing a stranger can actually do about any of it. */
export const FAILED_DETAIL =
  "If the link came from a chat, ask for it again — a collection can be republished.";

/** A thrown sentence, or the generic one. `parseSnapshot` throws four a page can print. */
function sentence(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : SNAPSHOT_OFFLINE;
}

export async function boot({ doc, fetch, render }: BootDeps): Promise<void> {
  const href = snapshotHref(doc);
  if (href === null) {
    // Not an error: the row exists and its blob has not committed yet (spec §4.1). It resolves
    // within seconds, and the shell answers `no-store` so a reload really does re-ask.
    render(<ShareNotice sentence={SNAPSHOT_PENDING} detail={PENDING_DETAIL} />);
    return;
  }

  render(<ShareNotice sentence={OPENING} />);

  try {
    // ⚠️ **No `credentials` option, and that is what makes the shell's preload count.** The
    // `<link rel="preload" as="fetch" crossorigin>` requests the blob in credentials mode
    // `same-origin`, which is `fetch`'s own default; passing `"omit"` here made the modes
    // disagree and Chromium dropped the warmed response on the floor — *"a preload for … is
    // found, but is not used because the request credentials mode does not match"*, measured in
    // the running page 2026-09-08. The blob was then fetched **twice** on every cold view, which
    // is the whole of what inlining that link was for. `boot.test.tsx` pins the call shape.
    const response = await fetch(href);
    if (!response.ok) throw new Error(SNAPSHOT_OFFLINE);
    render(<SharePage snapshot={parseSnapshot(await response.text())} />);
  } catch (error) {
    console.error(error);
    render(<ShareNotice sentence={sentence(error)} detail={FAILED_DETAIL} />);
  }
}
