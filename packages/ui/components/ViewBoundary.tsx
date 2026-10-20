import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * What stands between a view that threw and a window with nothing in it (issue #1181).
 *
 * A throw during render unwinds React 19 to the nearest boundary, and with none it takes the
 * whole tree — on the desktop that includes `TitleBar`, which is the window's only caption
 * (`decorations: false`), so the reader was left with an empty window they could close only with
 * Alt+F4. Two ordinary ways to get one: **a lazy view whose chunk never arrives** (Scanner,
 * Settings, Trade, Playtesting, the goldfish, Shared — `App.tsx`) and a view meeting a row it did
 * not expect.
 *
 * **Around the view and inside `AppShell`**, beside the `Suspense` the lazy views already sit
 * under, so the caption, the rail and every dialog mounted beside the shell outlive the failure:
 * the reader can go to another view, or put the window down. `App.tsx` keys it by the place the
 * reader is standing, so moving through the rail is a fresh view rather than the failure
 * following them; *Try again* is the same reset for a reader who stays.
 *
 * **A retry is not always enough, which is why a reload sits beside it.** `React.lazy` keeps a
 * rejected import, so a view whose chunk failed throws the same error however often it is
 * re-rendered; a reload is a fresh document that asks again.
 *
 * The light app's desktop face draws `App` too, so it gets this as well; its `FaceBoundary` is the
 * one outside it, for a throw above the shell.
 */
export class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return <ViewFailure message={error.message} onRetry={() => this.setState({ error: null })} />;
  }
}

/** The two buttons' shared look: `FaceBoundary`'s outlined chip, at the shell's scale. */
const ACTION = cn("flex h-9 items-center rounded-md border px-3 text-sm", PRESS, FOCUS);

/** What a failed view draws, in the view's own box. */
function ViewFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-4 text-center">
      <TriangleAlert className="size-8 text-destructive" aria-hidden="true" />
      <div role="alert" className="flex max-w-prose flex-col gap-1">
        <p className="text-base text-destructive">This view could not be drawn.</p>
        {message && <p className="text-sm break-words text-dim">{message}</p>}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onRetry} className={cn(ACTION, "border-accent text-accent")}>
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={cn(ACTION, "border-border text-text")}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
