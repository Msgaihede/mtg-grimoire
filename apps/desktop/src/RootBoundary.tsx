import { Component, type ErrorInfo, type ReactNode } from "react";
import { GrimoireMark } from "@grimoire/ui/components/GrimoireMark";
import { TitleBar } from "@grimoire/ui/components/TitleBar";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The last thing between a throw and an empty window (issue #1181).
 *
 * A failing *view* is caught inside the shell by `ViewBoundary`, and the caption stays. This is for
 * everything above it — the shell, a provider, the boot gate — where nothing of the app is left to
 * draw. **So the fallback draws the caption itself**, for `StartupScreen`'s reason: the window is
 * `decorations: false`, and without `TitleBar` a reader cannot move, minimise or close it except
 * with Alt+F4. A caption that is itself what threw throws again here and reaches the root's
 * `onUncaughtError` (`main.tsx`), which is still a record of it.
 *
 * **The way out is a reload**: a fresh document runs the boot gate again, and the data folder is
 * already open, so it lands back on the app.
 */
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
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
      <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
        <TitleBar />
        <main className="flex min-h-0 flex-1 overflow-y-auto px-8 py-10">
          <div className="m-auto flex flex-col items-center gap-4 text-center">
            <GrimoireMark size={48} className="text-dim" />
            <p role="alert" className="max-w-prose text-sm text-destructive">
              MTG Grimoire could not be drawn.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={cn(
                "flex h-9 items-center rounded-md border border-border px-3 text-sm text-text",
                PRESS,
                FOCUS,
              )}
            >
              Reload
            </button>
          </div>
        </main>
      </div>
    );
  }
}
