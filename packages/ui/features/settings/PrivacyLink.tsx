import type { JSX, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { PRIVACY_URL, openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { TOUCH_FLOOR } from "./controls";

/**
 * The privacy policy's link, at the foot of Settings on both faces.
 *
 * **An anchor with the address on it, and a press the host carries out.** The `href` is what a
 * screen reader announces and what a long press copies. The press itself goes through
 * `openExternal`, the app's one call that leaves it: a desktop webview does not follow
 * `target="_blank"`, the Android host hands the address to the system browser, and a browser
 * opens a tab — so the anchor's own navigation is stopped, or a browser would open two.
 *
 * It asks nothing about where it runs. The policy is one page for every host.
 */
export function PrivacyLink(): JSX.Element {
  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternal(PRIVACY_URL);
  };
  return (
    <a
      href={PRIVACY_URL}
      target="_blank"
      rel="noreferrer"
      onClick={leave}
      className={cn(
        "inline-flex items-center text-sm text-dim underline underline-offset-2 hover:text-text",
        TOUCH_FLOOR,
        FOCUS,
      )}
    >
      Privacy policy
    </a>
  );
}
