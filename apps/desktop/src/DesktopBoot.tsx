import App from "@/App";
import { StartupScreen } from "./StartupScreen";
import { useStartup } from "@/boot/useStartup";

// Re-exported: `DesktopBoot.test.tsx` imports it from here.
export { STARTUP_POLL_MS } from "@/boot/useStartup";

/**
 * The app's root: nothing that queries is mounted until the native side says the data folder is
 * open. The gate itself is `useStartup`, which the light app's entry shares.
 */
export function DesktopBoot() {
  const status = useStartup();
  if (status.state === "ready") return <App />;
  return <StartupScreen status={status} />;
}
