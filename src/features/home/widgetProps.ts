/**
 * The one prop shape every widget on the home page takes.
 *
 * **It is its own file, and that is the point rather than tidiness.** Six widgets and the page
 * that renders them are written independently, and each of them needs this contract — so it lives
 * somewhere none of them owns. A shape declared inside `HomePage.tsx` would make the page a
 * dependency of every widget, and one declared inside `widgets.ts` would put a React concern in
 * the file that is deliberately free of them (that one is a registry of *labels and defaults*,
 * readable by a test that never renders anything).
 *
 * The split between the two interfaces below is the split between **what a widget is about** and
 * **what the page is doing to it**. A widget reads its own `widget.config` and writes it back
 * through `onConfig`; everything in {@link WidgetChrome} is the page's business, is identical for
 * all six, and is passed straight through to `WidgetCard` without a widget interpreting any of it.
 * That is why a widget's body can be written — and tested — without knowing that edit mode, drag
 * handles or spans exist.
 */
import type { HomeWidget } from "@/lib/ipc";

/**
 * What the page is doing to a widget, handed through to `WidgetCard` untouched.
 *
 * Every field here is the page's: the widget neither reads nor decides any of it. `span` is
 * deliberately **not** in this interface even though `WidgetCard` needs one — it is a property of
 * the stored document, so it is read off {@link WidgetProps.widget} and the two cannot drift.
 */
export interface WidgetChrome {
  /** Whether the reader has pressed **Customize**. A widget passes this to `WidgetCard` and,
   *  with one exception, changes nothing else about itself: the tray is the card's business.
   *  The exception is a widget that would otherwise swallow a drag — see `DecksWidget`. */
  editing: boolean;
  /** Drop this widget from the layout. */
  onRemove: () => void;
  /** One column or the whole line. */
  onSpan: (span: 1 | 2) => void;
  /** The grip. `WidgetCard` hands the element back so the page can make it draggable — and hands
   *  back `null` when the tray goes away, which is what unregisters it. */
  dragHandleRef: (el: HTMLElement | null) => void;
  /** The grip's arrow keys. `dndManager` ships no `KeyboardSensor`, so without this a reorder is
   *  a gesture only a mouse can make. */
  onNudge: (delta: -1 | 1) => void;
}

/** A widget: the stored entry it draws, its own way of writing that entry back, and the chrome
 *  the page wraps it in. */
export interface WidgetProps extends WidgetChrome {
  /** The stored entry. `widget.span` is what the card is drawn at and `widget.config` is this
   *  widget's own settings — read it through `widgetConfig(widget, fallback)` from `./layout`,
   *  never by hand, so a config written by a different build cannot reach the render. */
  widget: HomeWidget;
  /**
   * Write this widget's settings back.
   *
   * The page merges and persists; a widget hands over the whole config object it wants stored.
   * **Spread the current config rather than replacing it** — `widgetConfig` carries through keys
   * it does not know about, and that is what stops this build deleting a newer one's settings.
   */
  onConfig: (config: unknown) => void;
}
