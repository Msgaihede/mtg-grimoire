import App from "@grimoire/ui/App";
import { StartupScreen } from "./StartupScreen";
import { useStartup } from "@grimoire/ui/boot/useStartup";
import { useSearchHandoffs } from "@grimoire/ui/features/search/useSearchHandoffs";

// Re-exported: `DesktopBoot.test.tsx` imports it from here.
export { STARTUP_POLL_MS } from "@grimoire/ui/boot/useStartup";

/**
 * The app's root: nothing that queries is mounted until the native side says the data folder is
 * open. The gate itself is `useStartup`, which the light app's entry shares.
 */
export function DesktopBoot() {
  const status = useStartup();
  // Before the ready check, since a hook cannot be conditional. The light app has no MCP server and never calls it.
  useSearchHandoffs();
  if (status.state === "ready") return <App />;
  return <StartupScreen status={status} />;
}
