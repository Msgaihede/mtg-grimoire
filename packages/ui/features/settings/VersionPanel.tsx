import { APP_RELEASED, APP_VERSION } from "@/lib/appVersion";
import { useBundledHistory } from "@/lib/useReleaseHistory";
import { AppVersion } from "./AppVersion";
import { SettingsSection } from "./panelChrome";
import { VersionHistory } from "./VersionHistory";

/**
 * The light edition's Updates panel: the version running and what every release up to it
 * changed — `UpdatePanel` without the updater.
 *
 * **Nothing here checks, downloads or restarts.** A light install is updated by its store or by a
 * deploy, neither of which this app drives, and a newer build that the host is holding is the
 * host's own notice to draw (`apps/light/UpdateNotice.tsx`). What a reader can still ask on a
 * phone or in a browser is which version this is and what changed, and both answers ship with
 * the build: the version from the root manifest, the notes from `changelog/` (`appVersion.ts`,
 * `bundledReleases.ts`). So the panel asks no host anything, and draws the same on every one.
 *
 * Both faces draw it — the desktop face's `SettingsPage` where its edition has no updater, and the
 * phone's under its `Updates` row.
 */
export function VersionPanel() {
  const history = useBundledHistory();

  return (
    <SettingsSection id="updates" title="Updates">
      <AppVersion
        version={APP_VERSION}
        detail={APP_RELEASED === null ? "Not yet released" : `Released ${APP_RELEASED}`}
      />
      <VersionHistory history={history} currentVersion={APP_VERSION} />
    </SettingsSection>
  );
}
