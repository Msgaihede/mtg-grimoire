/**
 * The home page's layout document, read and rearranged — every function here is pure and
 * answers a new object.
 *
 * **Nothing in this file throws**, which is `features/decks/auditText.ts`'s rule inherited one
 * table over and for the same reason: what arrives is a document a *different build* may have
 * written. `home.rs` stores it as one `app_meta` row and validates the shape it writes rather
 * than the shape it reads — `stored` hands back whatever `serde_json` parses, version included —
 * so this page can be handed a newer document, an older one, or a row somebody edited by hand.
 * A layout that cannot be understood costs the reader their arrangement; it may never cost them
 * the page.
 *
 * Four rules follow from that, and each is a way to get this wrong:
 *
 * * **A widget kind this build has never heard of is kept, not dropped.** That is the whole
 *   reason `HomeWidget.kind` is a `string` and not a `WidgetKind`, and `home.rs` pins the same
 *   rule with a Rust test. `isWidgetKind` is how a *renderer* decides what to draw;
 *   {@link parseLayout} is not a renderer.
 * * **A newer document's `version` is kept, and so are its widgets.** `home.rs`'s `stored`
 *   deliberately does not check the version on read, on the stated grounds that defaulting over
 *   a newer document would lose the reader's widgets on any older build. This mirrors it.
 *   (Writing is answered the other way: `home::store` refuses a version it does not write,
 *   rather than rewriting a document by rules that do not apply to it.)
 * * **An empty widget list is a layout, not a missing document.** A reader who removed every
 *   widget has made a choice, and handing the six defaults back on the next launch would undo it
 *   silently, every time, for ever. Only a value that is not a layout *at all* becomes
 *   {@link DEFAULT_LAYOUT}.
 * * **An entry that is not a widget is dropped; the document is not.** One unreadable row in a
 *   list of six is five widgets, not a reset.
 */

import type { HomeLayout, HomeWidget } from "@/lib/ipc";

import { DEFAULT_LAYOUT, WIDGETS, type WidgetKind } from "./widgets";

/** The narrowest a widget may be, in grid columns. `home::MIN_SPAN`. */
const MIN_SPAN = 1;

/** The widest a widget may be. Two is the whole grid — `home::MAX_SPAN`. */
const MAX_SPAN = 2;

/**
 * A value read as a plain object, or `null`.
 *
 * `auditText.ts`'s `facts()` verbatim, and for its reason one table over: `home_layout` is a
 * `TEXT` row and `JSON.parse` of one admits `[]` and `"a string"` as readily as `{}`, both of
 * which are `typeof === "object"`.
 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A field read as a non-blank name, or `null`. `"  "` is a blank, not a name — `home::store`
 *  refuses both on the write side, so a widget carrying one could never be saved back. */
function name(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A stored width, brought inside the grid.
 *
 * **Clamped rather than refused**, which is where this parts from `home::store`: a write is a
 * document the reader is looking at and can be told about, where a read has nobody to tell and a
 * widget dropped for being one column too wide is a widget that vanished. Anything that is not a
 * number at all reads as the narrowest, which is the width that always has a column.
 */
function span(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MIN_SPAN;
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.round(value)));
}

/** One entry read as a widget, or `null` when it is not one. */
function parseWidget(value: unknown): HomeWidget | null {
  const entry = record(value);
  if (entry === null) return null;
  const id = name(entry.id);
  const kind = name(entry.kind);
  if (id === null || kind === null) return null;
  // `kind` is *not* checked against `isWidgetKind` — see the module doc. `config` is opaque and
  // is carried through exactly as stored, including a shape this build has no reader for.
  return { id, kind, span: span(entry.span), config: entry.config ?? null };
}

/** A structural copy, so no caller can reach into {@link DEFAULT_LAYOUT} or into the layout it
 *  was handed. `config` is deliberately shared by reference: it is opaque, nothing here reads
 *  into it, and {@link setConfig} replaces rather than mutates. */
function copy(layout: HomeLayout): HomeLayout {
  return { ...layout, widgets: layout.widgets.map((entry) => ({ ...entry })) };
}

/**
 * The stored document, read defensively — **never throws, and never the default for a document
 * it merely disagrees with**.
 *
 * The default is answered for a value that is not a layout at all: `null`, `undefined`, a
 * number, a string, an array, `{}`, a `widgets` that is not an array, a document with no
 * `widgets` key. Everything else is a layout, including one holding no widgets and one at a
 * version this build does not write.
 *
 * A document whose `version` is missing or unreadable is read at this build's own version rather
 * than dropped — the widgets are the part worth keeping, and a version is what a *write* has to
 * be honest about.
 */
export function parseLayout(value: unknown): HomeLayout {
  const document = record(value);
  if (document === null || !Array.isArray(document.widgets)) return copy(DEFAULT_LAYOUT);
  const version =
    typeof document.version === "number" && Number.isFinite(document.version)
      ? document.version
      : DEFAULT_LAYOUT.version;
  const widgets: HomeWidget[] = [];
  for (const entry of document.widgets) {
    const parsed = parseWidget(entry);
    if (parsed !== null) widgets.push(parsed);
  }
  return { version, widgets };
}

/**
 * The same layout with one more widget of this kind at the end.
 *
 * The id is minted rather than taken from the kind, because a reader may pin two sets of decks
 * in two `decks` widgets — see {@link newWidgetId}. The width is the kind's own default and the
 * config is `null`, which is what "this widget has not been configured" is spelled as
 * everywhere: `home.rs` seeds `serde_json::Value::Null` and {@link widgetConfig} reads it as
 * "use the fallback".
 */
export function addWidget(layout: HomeLayout, kind: WidgetKind): HomeLayout {
  const meta = WIDGETS.find((entry) => entry.kind === kind);
  const added: HomeWidget = {
    id: newWidgetId(kind, layout),
    kind,
    span: meta?.defaultSpan ?? MIN_SPAN,
    config: null,
  };
  return { ...layout, widgets: [...layout.widgets.map((entry) => ({ ...entry })), added] };
}

/**
 * The same layout without the widget carrying this id.
 *
 * An id nothing carries removes nothing and is not an error — the press that would send one is a
 * card that has already gone, which is a race rather than a mistake.
 */
export function removeWidget(layout: HomeLayout, id: string): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.filter((entry) => entry.id !== id).map((entry) => ({ ...entry })),
  };
}

/**
 * The same layout with one widget moved to one side of another.
 *
 * **The arguments are exactly what the drop target reports** — the widget being dragged, the
 * widget it was dropped on, and which edge of it — so the page maps a drag onto this with no
 * arithmetic of its own. That is the whole point of the signature: an index computed at the call
 * site would be computed against the list *before* the dragged widget was lifted out of it, and
 * be one too high for every forward move.
 *
 * **Moving a widget onto itself is a no-op rather than a loss.** A drag that ends where it began
 * is the commonest drag there is, and the naive remove-then-insert answers an empty target.
 */
export function moveWidget(
  layout: HomeLayout,
  id: string,
  targetId: string,
  edge: "before" | "after",
): HomeLayout {
  if (id === targetId) return copy(layout);
  const moving = layout.widgets.find((entry) => entry.id === id);
  if (moving === undefined || !layout.widgets.some((entry) => entry.id === targetId)) {
    return copy(layout);
  }
  const rest = layout.widgets.filter((entry) => entry.id !== id).map((entry) => ({ ...entry }));
  // Found *after* the lift, so the index is against the list the widget is being put back into.
  const at = rest.findIndex((entry) => entry.id === targetId);
  rest.splice(edge === "before" ? at : at + 1, 0, { ...moving });
  return { ...layout, widgets: rest };
}

/** The same layout with one widget's width changed. An id nothing carries changes nothing. */
export function setSpan(layout: HomeLayout, id: string, width: 1 | 2): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((entry) =>
      entry.id === id ? { ...entry, span: width } : { ...entry },
    ),
  };
}

/**
 * The same layout with one widget's settings replaced.
 *
 * **Replaced and not merged**, because the caller is the widget itself and it holds the whole of
 * its own config — a merge here would make an unset field impossible to spell. What survives an
 * older build is bought at the *read* end instead: see {@link widgetConfig}.
 */
export function setConfig(layout: HomeLayout, id: string, config: unknown): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((entry) => (entry.id === id ? { ...entry, config } : { ...entry })),
  };
}

/**
 * Does this stored value have the shape the fallback names?
 *
 * Shallow by design, and the depth is stated rather than discovered: a primitive must match by
 * `typeof`, an array must be an array whose elements match the fallback's *first* element when
 * it names one, a nested object must be some plain object, and a `null` or `undefined` fallback
 * names no shape at all and accepts anything. **It cannot check a vocabulary** — a stored
 * `dimension: "bogus"` is a string and passes — so a widget whose config carries a closed set of
 * words still narrows that word itself.
 */
function shapeMatches(value: unknown, shape: unknown): boolean {
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return false;
    const element: unknown = shape[0];
    if (element === undefined) return true;
    return value.every((item) => shapeMatches(item, element));
  }
  if (shape === null || shape === undefined) return true;
  if (typeof shape === "object") return record(value) !== null;
  return typeof value === typeof shape;
}

/**
 * One widget's settings, read as the shape the caller wants — **so a widget never has to guard**.
 *
 * `config` is opaque to Rust and to the layout functions above, which is what lets a newer
 * build's settings survive a round trip through an older one. The price is that the value
 * reaching a widget is genuinely `unknown`: it may be `null` (never configured), a shape this
 * build wrote a version ago, or whatever a hand-edited row holds. This is the one reader of it.
 *
 * The fallback is both the default *and* the schema. For an object fallback the answer is the
 * fallback with the stored fields laid over it one at a time, and a field is only taken when it
 * matches the shape the fallback names — so a missing field is filled and a wrong-typed one is
 * ignored, rather than either taking the whole config down to its default. **A stored key the
 * fallback does not name is carried through untouched**, which is what lets a widget spread the
 * result back into {@link setConfig} without an older build silently deleting a newer one's
 * settings. For any other fallback — a number, a string, an array — the stored value is answered
 * whole when it matches and the fallback when it does not.
 */
export function widgetConfig<T>(widget: HomeWidget, fallback: T): T {
  const stored: unknown = widget.config;
  const shape = record(fallback);
  if (shape === null) return shapeMatches(stored, fallback) ? (stored as T) : fallback;
  const config = record(stored);
  if (config === null) return fallback;
  const merged: Record<string, unknown> = { ...shape };
  for (const [key, value] of Object.entries(config)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      merged[key] = value;
      continue;
    }
    if (shapeMatches(value, shape[key])) merged[key] = value;
  }
  return merged as T;
}

/**
 * An id for a new widget of this kind that no widget already placed is using.
 *
 * The kind itself is the first choice, which is what makes a default layout's ids read as the
 * kinds — `home.rs`'s seed table says the same. A second widget of a kind takes `-2`, a third
 * `-3`, and so on: the id is what identifies a widget, so two `decks` widgets pinning two sets
 * of decks is a layout to build rather than a case to refuse.
 *
 * The loop terminates because the set of taken ids is finite and each turn tries a new one.
 */
export function newWidgetId(kind: WidgetKind, layout: HomeLayout): string {
  const taken = new Set(layout.widgets.map((entry) => entry.id));
  if (!taken.has(kind)) return kind;
  let n = 2;
  let id = `${kind}-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `${kind}-${n}`;
  }
  return id;
}
