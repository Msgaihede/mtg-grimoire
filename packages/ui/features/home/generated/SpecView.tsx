/**
 * **A json-render spec drawn from the catalogue** — the one place the providers, the registry, the
 * action handlers and the `$computed` functions meet, so a custom widget's body, a story and a
 * test all draw a spec the same way.
 *
 * `state` is the spec's first state: the widget's GraphQL answer, plus whatever its inputs write
 * (`widgetState.ts`). It is read once. **`live` is what moves afterwards**: each time it is a new
 * object its top-level keys are written into the store — a fresh answer replaces the data and
 * leaves `/ui` and `/settings`, the reader's filters and settings, where they stand.
 *
 * **`host` answers the action that is the custom widget's rather than the app's**: `refresh`, ask
 * its document again. Without one — a story, a test, a preview — it does nothing.
 *
 * **`onState` hears every write to the store** — what a widget's settings face uses to keep the
 * reader's `/settings` as they change them (`CustomWidgetSettings`).
 */
import { JSONUIProvider, Renderer, type SetState } from "@json-render/react";
import { createStateStore, type Spec, type StateModel } from "@json-render/core";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { handlers, registry, useCatalogFunctions } from "./registry";

const IGNORED: SetState = () => {};

/** What the widget drawing a spec does for it. */
export interface SpecHost {
  /** Ask the widget's data again. */
  refresh?: () => void;
}

export interface SpecViewProps {
  spec: Spec;
  /** The spec's state model — `/`-rooted paths in the spec read it. */
  state?: Record<string, unknown>;
  /** Top-level keys written into the store whenever this object changes — a refreshed answer. */
  live?: Record<string, unknown>;
  host?: SpecHost;
  /** Called with the whole state after every write to it — an input's, or `live`'s. */
  onState?: (state: StateModel) => void;
}

export function SpecView({ spec, state, live, host, onState }: SpecViewProps): ReactElement {
  const functions = useCatalogFunctions();
  // The view's own store, so the actions can read it: a `$item` in an action's params arrives as
  // a state path (`registry.tsx`'s `valueOf`). Made once; `live` moves it afterwards.
  const [store] = useState(() => createStateStore(state ?? spec.state ?? {}));
  useEffect(() => {
    if (live === undefined) return;
    // One notification for all of them. A GraphQL field name cannot hold `/` or `~`, so a key is
    // its own JSON Pointer segment.
    store.update(
      Object.fromEntries(Object.entries(live).map(([key, value]) => [`/${key}`, value])),
    );
  }, [live, store]);
  useEffect(() => {
    if (onState === undefined) return;
    return store.subscribe(() => onState(store.getSnapshot()));
  }, [onState, store]);
  // The catalogue's actions navigate through the app store and never write the spec's state. A
  // setter is still handed over — json-render skips an action it has none for — but never called.
  const actions = useMemo(
    () => ({
      ...handlers(
        () => IGNORED,
        () => store.getSnapshot(),
      ),
      refresh: async () => host?.refresh?.(),
    }),
    [store, host],
  );
  return (
    <JSONUIProvider registry={registry} store={store} handlers={actions} functions={functions}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
