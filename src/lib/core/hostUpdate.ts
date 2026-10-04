/**
 * **What a host answers about a newer build of the app it is holding back** — the commands, the
 * event, and the shape of the answer (the light-app spec §6: "A new build installs as the waiting
 * worker; a non-modal bar says a new version is ready; only that press calls `skipWaiting`").
 *
 * `hostStorage.ts`'s arrangement, for its reason. A browser fetches a new build behind an open
 * page and holds it until the reader says so; a desktop and a phone are updated by something this
 * app does not drive. So the web host answers these **on the page, without the engine**, and no
 * other host answers them at all — the desktop's IPC and the engine's command table refuse a name
 * they do not have. A component asks, and draws only if a host answered: `mobile/UpdateNotice.tsx`
 * and the face's boundary both do, and neither knows what kind of host it is drawn on.
 *
 * **Not the desktop's `update_status`**, which is its own updater's (the portable swap) and
 * answers a different shape; these names are deliberately not near it.
 */

/** Asks whether a newer build is waiting. Answers {@link HostUpdate}, or `null` for none. */
export const HOST_UPDATE = "host_update";

/**
 * Says the reader chose the newer build. Takes nothing and answers `null`; the host then starts
 * the app again on that build by itself, which for the web host is one reload of the page.
 * **Refused, in a sentence, when no build is waiting** — so a control that greyed itself on the
 * press knows to come back.
 */
export const HOST_UPDATE_APPLY = "host_update_apply";

/** Emitted when the answer to {@link HOST_UPDATE} changes; the payload is the new answer. */
export const HOST_UPDATE_CHANGED = "host-update:changed";

/**
 * A newer build, waiting — **in the host's own words**, as a storage notice is
 * (`hostStorage.ts`): what taking it does differs by host, so the host that holds it says so.
 */
export interface HostUpdate {
  /** One line: that there is one. */
  title: string;
  /** The label of the control that takes it, which says what the press does. */
  action: string;
}
