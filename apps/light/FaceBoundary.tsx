import { Component, type ErrorInfo, type ReactNode } from "react";
import { GrimoireMark } from "@/components/GrimoireMark";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { ReloadLink } from "./ReloadLink";
import { useHostUpdate } from "./useHostUpdate";

/**
 * What stands between a face that threw and a blank page.
 *
 * A throw during render unwinds React to nothing, and here there are two ordinary ways to get one
 * that are nobody's bug: **a face's chunk that never arrives** — each is fetched lazily, so a
 * reader who goes offline fails the import the first time a resize crosses the floor — and a page
 * meeting a row it did not expect. Without this the reader gets an empty window with nothing to
 * report, which is `apps/share/SharePage.tsx`'s `ShareBoundary` and its reason, one entry over.
 *
 * **A deploy that renamed the chunks is no longer one of those ways, on a host that keeps the
 * build it served** (phase 5, step 5.3). There the page's own build is held whole, under its own
 * name, for as long as the page is open, however many newer ones have arrived behind it — so a
 * face's chunk is found by the name this page knows. What is left is a host that lost what it
 * kept while the page lived, and then a reload asks the same host for the same missing file.
 * **So when the host says a newer build is waiting, the way out is that build**, in the host's
 * words (`useHostUpdate`), and the reload is for a host that says nothing.
 *
 * **`LightApp` keys it by the face**, so a failure in one face does not follow the reader across
 * the floor into the other.
 *
 * **The reload is a link to where the reader already is** — `ReloadLink`, which says why it is
 * not a button.
 */
export class FaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <FaceFailure />;
  }
}

/** What a failed face draws. A function, because the way out is asked of the host by a hook. */
function FaceFailure() {
  const { update, applying, apply } = useHostUpdate();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-text">
      <GrimoireMark size={48} className="text-accent" />
      <p role="alert" className="max-w-prose text-center text-sm text-destructive">
        This page could not be drawn.
      </p>
      {update ? (
        <>
          <p className="max-w-prose text-center text-sm text-dim">{update.title}</p>
          <button
            type="button"
            aria-disabled={applying || undefined}
            onClick={applying ? undefined : apply}
            className={cn(
              "flex h-11 items-center rounded-md border border-accent px-4 text-sm text-accent",
              "aria-disabled:opacity-40 aria-disabled:active:scale-100",
              PRESS,
              FOCUS,
            )}
          >
            {update.action}
          </button>
        </>
      ) : (
        <ReloadLink />
      )}
    </div>
  );
}
