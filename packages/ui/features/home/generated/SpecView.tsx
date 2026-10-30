/**
 * **A json-render spec drawn from the catalogue** — the one place the providers, the registry, the
 * action handlers and the `$computed` functions meet, so a custom widget's body, a story and a
 * test all draw a spec the same way.
 *
 * `state` is the spec's data: the widget's GraphQL answer, plus whatever its inputs write. It is
 * read once: a new answer is a new `key` on this view, not a changed prop.
 *
 * **`host` answers the two actions that are the custom widget's rather than the app's**: `refresh`
 * (ask its document again) and `saveSettings` (keep a state subtree in its stored config). Without
 * one — a story, a test, a preview — both do nothing.
 */
import { JSONUIProvider, Renderer, type SetState } from "@json-render/react";
import { createStateStore, getByPath, type Spec } from "@json-render/core";
import { useMemo, useState, type ReactElement } from "react";
import { handlers, registry, useCatalogFunctions } from "./registry";

const IGNORED: SetState = () => {};

/** What the widget drawing a spec does for it. */
export interface SpecHost {
  /** Ask the widget's data again. */
  refresh?: () => void;
  /** Keep `settings` — the state under the path the spec named — in the widget's config. */
  saveSettings?: (settings: unknown) => void;
}

export interface SpecViewProps {
  spec: Spec;
  /** The spec's state model — `/`-rooted paths in the spec read it. */
  state?: Record<string, unknown>;
  host?: SpecHost;
}

export function SpecView({ spec, state, host }: SpecViewProps): ReactElement {
  const functions = useCatalogFunctions();
  // The view's own store, so the actions can read it: a `$item` in an action's params arrives as
  // a state path (`registry.tsx`'s `valueOf`). Made once — a new answer is a new `key`.
  const [store] = useState(() => createStateStore(state ?? spec.state ?? {}));
  // The catalogue's actions navigate through the app store and never write the spec's state. A
  // setter is still handed over — json-render skips an action it has none for — but never called.
  const actions = useMemo(
    () => ({
      ...handlers(
        () => IGNORED,
        () => store.getSnapshot(),
      ),
      refresh: async () => host?.refresh?.(),
      saveSettings: async (params: Record<string, unknown>) => {
        if (typeof params.path !== "string") return;
        host?.saveSettings?.(getByPath(store.getSnapshot(), params.path));
      },
    }),
    [store, host],
  );
  return (
    <JSONUIProvider registry={registry} store={store} handlers={actions} functions={functions}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
