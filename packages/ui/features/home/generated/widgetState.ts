/**
 * **A custom widget's state, from its GraphQL answer** — the one place the read graph's answer,
 * the spec's own seeds and the reader's saved settings become the state a json-render spec reads.
 *
 * The state has three parts, and `CATALOG_RULES` tells the model writing the spec the same thing:
 *
 * - **The answer's `data` is the state root.** A document asking for `decks { name }` is read by
 *   `{ "$state": "/decks/0/name" }`, so a spec's paths are its query's field paths and nothing
 *   translates between them.
 * - **`/ui` is the widget's own inputs** — a filter, a sort, a switch — seeded from the spec's
 *   `state.ui` and never stored: a widget opens on its defaults each time it is drawn.
 * - **`/settings` is what the reader configures and keeps**: the spec's `state.settings` seeds it,
 *   and what `saveSettings` stored in the placed copy's `config.settings` is laid over the seeds,
 *   key by key, so a setting a newer spec added still has its default.
 *
 * **`ui` and `settings` are the widget's, whatever the answer says**: a document that names a root
 * field (or an alias) `ui` or `settings` is shadowed by them. Any other key the spec seeds in
 * `state` is sample data a model was told not to write, and the answer replaces it.
 */
import type { Spec } from "@json-render/core";
import { catalog } from "./catalog";

/** The widget's own inputs — never stored. */
export const UI_KEY = "ui";

/** What the reader configures and keeps with `saveSettings`. */
export const SETTINGS_KEY = "settings";

/** The two keys the widget owns at the state root. */
const OWN_KEYS: ReadonlySet<string> = new Set([UI_KEY, SETTINGS_KEY]);

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a placed copy's `config` holds: which definition it draws, and the settings it kept.
 * Read defensively — the layout document is the reader's, and an older or newer build may have
 * written a config this one does not expect.
 */
export interface CustomConfig {
  widgetId: number | null;
  settings: Plain | null;
}

export function customConfig(config: unknown): CustomConfig {
  if (!isPlain(config)) return { widgetId: null, settings: null };
  const id = config.widgetId;
  return {
    widgetId: typeof id === "number" && Number.isInteger(id) ? id : null,
    settings: isPlain(config.settings) ? config.settings : null,
  };
}

/** The answer's data, less the two keys the widget owns. */
export function answerState(data: unknown): Plain {
  if (!isPlain(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([key]) => !OWN_KEYS.has(key)));
}

/**
 * The state a spec is first drawn with: the answer at the root, `/ui` from the spec's seeds,
 * `/settings` from the seeds with the saved settings laid over them.
 */
export function widgetState(spec: Spec, data: unknown, saved: Plain | null): Plain {
  const seeds = isPlain(spec.state) ? spec.state : {};
  return {
    ...answerState(data),
    [UI_KEY]: isPlain(seeds[UI_KEY]) ? structuredClone(seeds[UI_KEY]) : {},
    [SETTINGS_KEY]: {
      ...(isPlain(seeds[SETTINGS_KEY]) ? structuredClone(seeds[SETTINGS_KEY]) : {}),
      ...(saved ?? {}),
    },
  };
}

/** A stored spec, checked against the catalogue — or the first thing wrong with it, in words. */
export type CheckedSpec = { ok: true; spec: Spec } | { ok: false; problem: string };

export function checkSpec(value: unknown): CheckedSpec {
  const result = catalog.validate(value);
  // The stored value itself rather than zod's parse of it, which may drop keys json-render reads.
  if (result.success) return { ok: true, spec: value as Spec };
  const issue = result.error?.issues[0];
  if (issue === undefined) return { ok: false, problem: "The spec is not one this app can draw." };
  const where = issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
  return { ok: false, problem: `${issue.message}${where}` };
}
