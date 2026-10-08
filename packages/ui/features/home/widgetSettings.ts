/**
 * The settings every widget has, read off its stored `config` — **the one reader of the keys the
 * registry declares**, so a widget, the card chrome and the settings panel cannot come to disagree
 * about what a stored word means.
 *
 * Every function here answers something for any config at all: `null` (never configured), a
 * config a newer build wrote, a hand-edited row. A word no option carries reads as the default,
 * which is the vocabulary check `widgetConfig` in `layout.ts` cannot make.
 *
 * **Three keys belong to every kind** and are not rows in `widgets.ts`, because the panel draws
 * them for every card: `title` (the reader's own name for the card; absent is the kind's label),
 * `density` (`"compact"` or absent), and the footprint, which is not config at all.
 */

import type { HomeWidget } from "@/lib/ipc";

import { record } from "./layout";
import { isWidgetKind, widgetMeta, type WidgetPick } from "./widgets";

/** How tightly a card packs its body. */
export type Density = "comfortable" | "compact";

/** The stored config as a plain object, or an empty one. */
function stored(widget: HomeWidget): Record<string, unknown> {
  return record(widget.config) ?? {};
}

/** The default a pick reads when nothing usable is stored. */
export function pickDefault(pick: WidgetPick): string | number {
  return pick.dflt ?? pick.options[0].id;
}

/**
 * A pick's current value — the stored one when an option carries it, the default otherwise.
 *
 * Compared with `===`, so `"50"` stored where the option is `50` reads as the default: a config
 * this build wrote always carries the option's own type.
 */
export function pickValue(widget: HomeWidget, pick: WidgetPick): string | number {
  const value = stored(widget)[pick.key];
  return pick.options.some((option) => option.id === value)
    ? (value as string | number)
    : pickDefault(pick);
}

/** A pick's current value by key, for a kind this build knows. `undefined` for a key the kind
 *  declares no pick for — a programming error the type of the call site cannot catch. */
export function pickOf(widget: HomeWidget, key: string): string | number | undefined {
  if (!isWidgetKind(widget.kind)) return undefined;
  const pick = widgetMeta(widget.kind).picks.find((entry) => entry.key === key);
  return pick === undefined ? undefined : pickValue(widget, pick);
}

/**
 * Is this switch on?
 *
 * **Only a stored boolean is an answer**; anything else — absent, a hand-edited word, a value a
 * newer build wrote — is `dflt`. The rule this states is *the default stores nothing*, of which
 * the old `!== false` was the one instance where the default was on.
 *
 * The caller passes the default because this function cannot see the registry. Bodies should call
 * {@link toggleOnOf}, which looks it up; this signature is for a caller holding the row already.
 */
export function toggleOn(widget: HomeWidget, key: string, dflt = true): boolean {
  const value = stored(widget)[key];
  return typeof value === "boolean" ? value : dflt;
}

/** A switch's value by key, with the kind's own default applied — {@link pickOf}'s shape for
 *  toggles, so a body never writes down a default the registry already carries. A key the kind
 *  declares no toggle for is on, which is what a body with a stale key saw before `dflt` existed. */
export function toggleOnOf(widget: HomeWidget, key: string): boolean {
  if (!isWidgetKind(widget.kind)) return toggleOn(widget, key);
  const toggle = widgetMeta(widget.kind).toggles.find((entry) => entry.key === key);
  return toggleOn(widget, key, toggle?.dflt);
}

/** The density the reader picked. Anything but `"compact"` is comfortable. */
export function widgetDensity(widget: HomeWidget): Density {
  return stored(widget).density === "compact" ? "compact" : "comfortable";
}

/** The reader's own name for the card, or `null` when they have not given one. A blank is not a
 *  name. */
export function customTitle(widget: HomeWidget): string | null {
  const title = stored(widget).title;
  return typeof title === "string" && title.trim().length > 0 ? title : null;
}

/** What the kind is called when nobody renamed it. A kind this build cannot draw says so. */
export function defaultTitle(widget: HomeWidget): string {
  return isWidgetKind(widget.kind)
    ? widgetMeta(widget.kind).label
    : `Unknown widget (${widget.kind})`;
}

/** The card's title — the reader's name, or the kind's. It is also the card's accessible name. */
export function widgetTitle(widget: HomeWidget): string {
  return customTitle(widget) ?? defaultTitle(widget);
}

/**
 * The small word drawn beside a wide card's title — the label of the pick the kind names as its
 * chip — or `""` for a kind with none.
 */
export function chipLabel(widget: HomeWidget): string {
  if (!isWidgetKind(widget.kind)) return "";
  const meta = widgetMeta(widget.kind);
  const pick = meta.picks.find((entry) => entry.key === meta.chip);
  if (pick === undefined) return "";
  const value = pickValue(widget, pick);
  return pick.options.find((option) => option.id === value)?.label ?? "";
}
