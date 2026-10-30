/**
 * The reader's custom widgets, read once for the page: the Custom widgets dialog lists them, the
 * header shows its button while there is one, and each placed copy finds its definition here.
 *
 * One key, `crossWindow.ts`' `custom_widgets` entry — so a definition the MCP server stores
 * (it announces `db:changed` naming the table) appears in an open window without a reload.
 */
import { useQuery } from "@tanstack/react-query";
import { ipc, type CustomWidget } from "@/lib/ipc";

export const CUSTOM_WIDGETS_KEY = ["customWidgets"] as const;

const NONE: readonly CustomWidget[] = [];

export function useCustomWidgets(): {
  widgets: readonly CustomWidget[];
  ready: boolean;
  /** The read's refusal, or `null` — a placed copy says it rather than loading for ever. */
  error: unknown;
} {
  const query = useQuery({ queryKey: CUSTOM_WIDGETS_KEY, queryFn: () => ipc.customWidgets() });
  return { widgets: query.data ?? NONE, ready: query.isSuccess, error: query.error };
}
