import { Component, type ErrorInfo, type ReactNode } from "react";
import { GrimoireMark } from "@/components/GrimoireMark";
import { ReloadLink } from "./ReloadLink";

/**
 * What stands between a face that threw and a blank page.
 *
 * A throw during render unwinds React to nothing, and here there are two ordinary ways to get one
 * that are nobody's bug: **a face's chunk that never arrives** — each is fetched lazily, so a
 * reader who goes offline, or a deploy that renamed the chunks, fails the import the first time a
 * resize crosses the floor — and a page meeting a row it did not expect. Without this the reader
 * gets an empty window with nothing to report, which is `share/SharePage.tsx`'s `ShareBoundary`
 * and its reason, one entry over.
 *
 * **`LightApp` keys it by the face**, so a failure in one face does not follow the reader across
 * the floor into the other.
 *
 * **The way out is a link to where the reader already is** — `ReloadLink`, which says why it
 * is not a button.
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
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-text">
        <GrimoireMark size={48} className="text-accent" />
        <p role="alert" className="max-w-prose text-center text-sm text-destructive">
          This page could not be drawn.
        </p>
        <ReloadLink />
      </div>
    );
  }
}
