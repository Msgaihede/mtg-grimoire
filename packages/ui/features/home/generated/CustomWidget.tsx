/**
 * **A placed custom widget** — the `custom` kind's body: one `custom_widgets` row, named by the
 * placed copy's `config.widgetId`, drawn from its two declarative halves.
 *
 * 1. The **query** runs through `useGraphQL`, so it stays fresh by the cache roots its answer names,
 *    exactly as any widget over the graph would — asked with the variables its settings fill
 *    (`queryVariables.ts`: each declared variable from the setting of its name), and asked again,
 *    over the previous answer, when the reader changes one.
 * 2. The **spec** is checked against the catalogue (`checkSpec`) and drawn by `SpecView`, inside
 *    the card's `WidgetFit` (`CatalogFitContext`), over the state `widgetState.ts` makes of the
 *    answer: the answer's `data` at the root, `/ui` from the spec's seeds, `/settings` from the
 *    seeds under what the reader saved.
 *
 * **A refreshed answer moves the data and nothing else** (`SpecView`'s `live`): a reader who
 * filtered the rows keeps the filter when the collection changes under it. The reader's settings
 * move the same way — `live` carries `/settings` from the placed copy's config, so a change made
 * in the settings popover redraws the card at once.
 *
 * **The settings face is drawn in the card's settings popover** ({@link CustomWidgetSettings}),
 * the spec's `settingsRoot`: the same elements, the same answer and the same `/settings`, and
 * every change kept in the placed copy's `config.settings` as it is made — the way every other
 * kind's settings are, so two copies of one definition can be set differently. `refresh` is the
 * one action the widget answers for itself: it asks the document again.
 *
 * What it says instead of drawing, each a `WidgetMessage`: the definition is gone (deleted, or a
 * config that names none), the spec does not pass the catalogue, the document was refused, or the
 * graph is not on this host. A partial answer — some fields refused — is drawn, with one dim line
 * saying so.
 */
import { useCallback, useMemo, useRef, type ReactElement } from "react";
import type { StateModel } from "@json-render/core";
import { useGraphQL } from "@/lib/graphql/useGraphQL";
import { ipcError } from "@/lib/ipc";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { WidgetMessage } from "../WidgetParts";
import { CatalogFitContext } from "./registry";
import { SpecView, type SpecHost } from "./SpecView";
import { queryVariables } from "./queryVariables";
import { useCustomWidgets } from "./useCustomWidgets";
import {
  answerState,
  checkSpec,
  customConfig,
  settingsFace,
  settingsState,
  SETTINGS_KEY,
  widgetState,
} from "./widgetState";

export const CUSTOM_WIDGET_GONE = "This custom widget was deleted. Remove it from the page.";
export const CUSTOM_WIDGET_LOADING = "Loading…";
export const CUSTOM_WIDGET_PARTIAL = "Part of this widget's data could not be read.";

export function CustomWidget({ widget, fit }: WidgetBodyProps): ReactElement {
  const { widgets, ready, error } = useCustomWidgets();
  const config = customConfig(widget.config);
  const definition = widgets.find((each) => each.id === config.widgetId);

  if (error !== null) return <WidgetMessage tone="destructive">{ipcError(error)}</WidgetMessage>;
  if (!ready) return <WidgetMessage>{CUSTOM_WIDGET_LOADING}</WidgetMessage>;
  if (definition === undefined) return <WidgetMessage>{CUSTOM_WIDGET_GONE}</WidgetMessage>;
  return (
    <CatalogFitContext.Provider value={fit}>
      <Drawn
        // A changed definition is a new widget: its state starts again from its own seeds.
        key={`${definition.id}:${definition.updatedAt}`}
        query={definition.query}
        storedSpec={definition.spec}
        saved={config.settings}
      />
    </CatalogFitContext.Provider>
  );
}

/**
 * The query's variables: each one the document declares, from the setting of its name
 * (`queryVariables.ts`) — so a setting changed in the popover asks the document again. Keyed on the
 * settings' text, so a config write that changed no setting asks nothing.
 */
function useVariables(
  checked: ReturnType<typeof checkSpec>,
  query: string,
  saved: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const settings = checked.ok ? settingsState(checked.spec, saved) : {};
  const text = JSON.stringify(settings);
  return useMemo(
    () => queryVariables(query, JSON.parse(text) as Record<string, unknown>),
    [query, text],
  );
}

/** The live half of a widget's state: the answer's data, and the settings the copy keeps. */
function useLive(
  checked: ReturnType<typeof checkSpec>,
  data: unknown,
  saved: Record<string, unknown> | null,
): Record<string, unknown> {
  return useMemo(
    () => ({
      ...answerState(data),
      ...(checked.ok ? { [SETTINGS_KEY]: settingsState(checked.spec, saved) } : {}),
    }),
    [checked, data, saved],
  );
}

function Drawn({
  query,
  storedSpec,
  saved,
}: {
  query: string;
  storedSpec: unknown;
  saved: Record<string, unknown> | null;
}): ReactElement {
  const checked = useMemo(() => checkSpec(storedSpec), [storedSpec]);
  const variables = useVariables(checked, query, saved);
  const answer = useGraphQL(query, { enabled: checked.ok, variables, keepPrevious: true });
  const { refetch } = answer;

  const refresh = useCallback(() => void refetch(), [refetch]);
  const host = useMemo<SpecHost>(() => ({ refresh }), [refresh]);

  const data = answer.data?.data;
  const live = useLive(checked, data, saved);

  if (!checked.ok) {
    return (
      <WidgetMessage tone="destructive">
        {`This widget's picture could not be drawn: ${checked.problem}`}
      </WidgetMessage>
    );
  }
  if (answer.isError) {
    return <WidgetMessage tone="destructive">{ipcError(answer.error)}</WidgetMessage>;
  }
  if (answer.data === undefined) return <WidgetMessage>{CUSTOM_WIDGET_LOADING}</WidgetMessage>;

  const partial = (answer.data.errors?.length ?? 0) > 0;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <SpecView
          spec={checked.spec}
          state={widgetState(checked.spec, data, saved)}
          live={live}
          host={host}
        />
      </div>
      {partial && <p className="m-0 truncate text-xs text-dim">{CUSTOM_WIDGET_PARTIAL}</p>}
    </div>
  );
}

/**
 * **A custom widget's settings, in the card's settings popover** — drawn after the rows every kind
 * has (size, density), as any kind's own settings are. Nothing when the spec has no `settingsRoot`,
 * or the definition is gone (the card says so).
 *
 * The face is the spec's `settingsRoot` subtree over the same state the card reads: the answer
 * (asked once — the card's `useGraphQL` and this one share the cached document), `/ui` and
 * `/settings`. **Every change to `/settings` is kept as it is made**, a patch of the copy's
 * `config.settings` — and only a real change: the store also notifies when the kept settings come
 * back through `live`, and that write is the one the face just made.
 */
export function CustomWidgetSettings({
  widget,
  onConfig,
}: WidgetSettingsProps): ReactElement | null {
  const { widgets } = useCustomWidgets();
  const config = customConfig(widget.config);
  const definition = widgets.find((each) => each.id === config.widgetId);
  if (definition === undefined) return null;
  return (
    <SettingsFace
      key={`${definition.id}:${definition.updatedAt}`}
      query={definition.query}
      storedSpec={definition.spec}
      saved={config.settings}
      onKeep={(settings) => onConfig({ [SETTINGS_KEY]: settings })}
    />
  );
}

function SettingsFace({
  query,
  storedSpec,
  saved,
  onKeep,
}: {
  query: string;
  storedSpec: unknown;
  saved: Record<string, unknown> | null;
  onKeep: (settings: unknown) => void;
}): ReactElement | null {
  const checked = useMemo(() => checkSpec(storedSpec), [storedSpec]);
  const hasFace = checked.ok && checked.settingsRoot !== null;
  // The card's own variables, so the face reads the card's cached answer rather than a second one.
  const variables = useVariables(checked, query, saved);
  const answer = useGraphQL(query, { enabled: hasFace, variables, keepPrevious: true });
  const data = answer.data?.data;
  const live = useLive(checked, data, saved);

  // What was last kept, as text — so the store's echo of a kept change writes nothing.
  const kept = useRef<string | null>(null);
  const onState = useCallback(
    (state: StateModel) => {
      const next = JSON.stringify(state[SETTINGS_KEY] ?? {});
      if (kept.current === null) kept.current = JSON.stringify(live[SETTINGS_KEY] ?? {});
      if (next === kept.current) return;
      kept.current = next;
      onKeep(state[SETTINGS_KEY]);
    },
    [live, onKeep],
  );

  if (!checked.ok || checked.settingsRoot === null) return null;
  return (
    <div className="flex flex-col gap-3">
      <SpecView
        spec={settingsFace(checked.spec, checked.settingsRoot)}
        state={widgetState(checked.spec, data, saved)}
        live={live}
        onState={onState}
      />
    </div>
  );
}
