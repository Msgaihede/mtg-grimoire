import { useCallback, useEffect, useState } from "react";
import { core } from "@/lib/core";
import {
  HOST_UPDATE,
  HOST_UPDATE_APPLY,
  HOST_UPDATE_CHANGED,
  type HostUpdate,
} from "@/lib/core/hostUpdate";

/** What a component draws a waiting build from. */
export interface HostUpdateState {
  /** The host's own words for a newer build it is holding, or `null` while there is none. */
  update: HostUpdate | null;
  /** The reader pressed, and the host has not yet started the app again. */
  applying: boolean;
  /** Tell the host the reader chose it. The host does the rest. */
  apply: () => void;
}

/** An answer this can draw, or `null`. A host that answers the name with something else says nothing. */
function readable(answer: unknown): HostUpdate | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { title, action } = answer as Partial<HostUpdate>;
  return typeof title === "string" && typeof action === "string" ? { title, action } : null;
}

/**
 * **Whether the host is holding a newer build of the app, asked of the host** — the light-app
 * spec §6: a new build waits, the reader is told, and only their press takes it.
 *
 * `StorageNotice`'s arrangement, for its reason. Some hosts fetch a new build behind an open app
 * and keep it back until the reader says so; this asks `host_update` once and listens for
 * `host-update:changed`, and answers only what a host said. A host with no such command — one
 * that is updated by something this app does not drive, the Storybook fake — refuses, which is
 * `null` here and nothing to draw. So neither caller asks where it runs (`phone/fence.test.ts`),
 * and the words are the host's.
 *
 * **Two callers, and each mounts its own**: `UpdateNotice`, above both faces, and the face's
 * boundary, whose way out is the update whenever one is waiting.
 */
export function useHostUpdate(): HostUpdateState {
  const [update, setUpdate] = useState<HostUpdate | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let live = true;
    const hear = (answer: unknown): void => {
      if (live) setUpdate(readable(answer));
    };
    // The event first, so a build that starts waiting between the ask and its answer is heard.
    const off = core.listen<unknown>(HOST_UPDATE_CHANGED, hear);
    core.call<unknown>(HOST_UPDATE).then(
      hear,
      // A host without the command: nothing to say.
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, []);

  const apply = useCallback(() => {
    setApplying(true);
    // A host that refuses the press has not started anything: the control comes back.
    core.call(HOST_UPDATE_APPLY).catch(() => setApplying(false));
  }, []);

  return { update, applying, apply };
}
