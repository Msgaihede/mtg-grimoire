/**
 * **A placed custom widget** — the `custom` kind's body: one `custom_widgets` row, named by the
 * placed copy's `config.widgetId`, drawn from its two declarative halves.
 *
 * 1. The **query** runs through `useGraphQL`, so it stays fresh by the cache roots its answer names,
 *    exactly as any widget over the graph would.
 * 2. The **spec** is checked against the catalogue (`checkSpec`) and drawn by `SpecView`, inside
 *    the card's `WidgetFit` (`CatalogFitContext`), over the state `widgetState.ts` makes of the
 *    answer: the answer's `data` at the root, `/ui` from the spec's seeds, `/settings` from the
 *    seeds under what the reader saved.
 *
 * **A refreshed answer moves the data and nothing else** (`SpecView`'s `live`): a reader who
 * filtered the rows keeps the filter when the collection changes under it.
 *
 * **The host's two actions are this widget's**: `refresh` asks the document again, and
 * `saveSettings` keeps the settings in the placed copy's `config.settings` — so two copies of one
 * definition can be set differently, as two copies of any kind can.
 *
 * What it says instead of drawing, each a `WidgetMessage`: the definition is gone (deleted, or a
 * config that names none), the spec does not pass the catalogue, the document was refused, or the
 * graph is not on this host. A partial answer — some fields refused — is drawn, with one dim line
 * saying so.
 */
import { useCallback, useMemo, type ReactElement } from "react";
import { useGraphQL } from "@/lib/graphql/useGraphQL";
import { ipcError } from "@/lib/ipc";
import type { WidgetBodyProps } from "../widgetProps";
import { WidgetMessage } from "../WidgetParts";
import { CatalogFitContext } from "./registry";
import { SpecView, type SpecHost } from "./SpecView";
import { useCustomWidgets } from "./useCustomWidgets";
import { answerState, checkSpec, customConfig, SETTINGS_KEY, widgetState } from "./widgetState";

export const CUSTOM_WIDGET_GONE = "This custom widget was deleted. Remove it from the page.";
export const CUSTOM_WIDGET_LOADING = "Loading…";
export const CUSTOM_WIDGET_PARTIAL = "Part of this widget's data could not be read.";

export function CustomWidget({ widget, fit, onConfig }: WidgetBodyProps): ReactElement {
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
        onSave={(settings) => onConfig({ [SETTINGS_KEY]: settings })}
      />
    </CatalogFitContext.Provider>
  );
}

function Drawn({
  query,
  storedSpec,
  saved,
  onSave,
}: {
  query: string;
  storedSpec: unknown;
  saved: Record<string, unknown> | null;
  onSave: (settings: unknown) => void;
}): ReactElement {
  const checked = useMemo(() => checkSpec(storedSpec), [storedSpec]);
  const answer = useGraphQL(query, { enabled: checked.ok });
  const { refetch } = answer;

  const refresh = useCallback(() => void refetch(), [refetch]);
  const host = useMemo<SpecHost>(() => ({ refresh, saveSettings: onSave }), [refresh, onSave]);

  const data = answer.data?.data;
  const live = useMemo(() => answerState(data), [data]);

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
