/**
 * Everything the export dialog **decides**, with nothing drawn and nothing remembered: which
 * fields the format and the surface share, which rows the two filters hold back, the text, and
 * what each count line says.
 *
 * **Split out of `ExportDialog`'s body so a second shell can draw the same answers.** The desktop
 * dialog keeps its format and fields in `useAppStore`'s `exportPrefs` and writes through the
 * clipboard plugin and a Rust save dialog; the light app's phone sheet keeps them in a store of its
 * own and writes through the browser. Neither may differ about the file: so the prefs come in as
 * an argument, and every rule that turns a pile into text — the field intersection, the Arena and
 * inactive-pile filters and the order they run in, `formatExport`, the omission counts — is here
 * once, with the reading of each beside it.
 *
 * Store-free and plugin-free.
 */
import { useCallback, useMemo } from "react";
import { ALWAYS, availableFields, defaultFields, SURFACE_HAS_PILES } from "../fields";
import type { TransferFieldId, TransferSurface } from "../fields";
import type { ExportPrefs } from "../prefs";
import type { TransferCard } from "../TransferCard";
import { isInArena, notInArenaCopies } from "./arena";
import {
  dropsInactive,
  formatExport,
  inactiveCopies,
  isActivePile,
  omittedCount,
  type ExportFormat,
} from "./format";

export interface ExportModelInput {
  surface: TransferSurface;
  cards: readonly TransferCard[];
  /** This surface's remembered format, fields and the two filters. */
  prefs: ExportPrefs;
  /** Remember a new answer for this surface. */
  setPrefs: (surface: TransferSurface, prefs: ExportPrefs) => void;
  /**
   * Called on every change a reader makes to what the text says — the format, a field, either
   * filter. The dialog clears its `Copied.` line here: the preview redraws on each of them and
   * the clipboard does not, so the claim would be about text no longer on screen.
   */
  onChange?: () => void;
}

export function useExportModel({ surface, cards, prefs, setPrefs, onChange }: ExportModelInput) {
  const { format, fields, arenaOnly, includeInactive } = prefs;
  /** The fields this format and this surface share — the whole of what decides which checkboxes
   *  draw, `ALWAYS` excluded: a line with no count and no name is not a card, and a checkbox
   *  that can never move is furniture. */
  const available = useMemo(
    () => availableFields(format, surface).filter((id) => !ALWAYS.includes(id)),
    [format, surface],
  );

  /** Switching format re-derives the field set from that format's defaults rather than carrying
   *  the old selection across: a set chosen for CSV means nothing to Arena, and the intersection
   *  would silently drop most of it anyway. */
  const chooseFormat = useCallback(
    (next: ExportFormat) => {
      setPrefs(surface, { ...prefs, format: next, fields: defaultFields(next, surface) });
      onChange?.();
    },
    [onChange, prefs, setPrefs, surface],
  );

  const toggleField = useCallback(
    (id: TransferFieldId) => {
      const on = fields.includes(id);
      setPrefs(surface, {
        ...prefs,
        fields: on ? fields.filter((f) => f !== id) : [...fields, id],
      });
      onChange?.();
    },
    [fields, onChange, prefs, setPrefs, surface],
  );

  const toggleArenaOnly = useCallback(() => {
    setPrefs(surface, { ...prefs, arenaOnly: !prefs.arenaOnly });
    onChange?.();
  }, [onChange, prefs, setPrefs, surface]);

  const toggleIncludeInactive = useCallback(() => {
    setPrefs(surface, { ...prefs, includeInactive: !prefs.includeInactive });
    onChange?.();
  }, [onChange, prefs, setPrefs, surface]);

  /**
   * Whether `Include inactive categories` is a question this dialog can ask — issue #390.
   *
   * **Two fences and each closes a different hole.** `SURFACE_HAS_PILES` is the surface's: a
   * collection row and a wishlist row carry `categoryActive: null`, so the box there would be a
   * control over nothing. `dropsInactive` is the format's: Arena and MTGO leave a switched-off
   * pile out whatever anybody asks, because a maybeboard in an Arena file is an illegal import
   * at the other end — a box there could never move a byte, which is the furniture `src/CLAUDE.md`
   * forbids, and `omittedCount`'s line under those two already says what it cost.
   *
   * It gates the **filter** as well as the checkbox, which is the Arena row filter's rule read
   * across: a preference the reader cannot see must not be silently narrowing the file, and on
   * these two formats the honest sentence is the format's own rather than the reader's.
   */
  const offersInactive = SURFACE_HAS_PILES[surface] && !dropsInactive(format);
  const excludesInactive = offersInactive && !includeInactive;

  /**
   * The two row filters, applied **before** the writer rather than inside it.
   *
   * `formatExport` stays `(cards, format, fields) => string` — `export/`'s whole boundary, and
   * the reason `decklists.test.ts` can drive it — so which cards go in is the dialog's question
   * and never a fourth argument to the writer. It is also what keeps `omittedCount` honest: it
   * counts what *this format* leaves out of the list it is given, and giving it the filtered
   * list is what stops a card that is both outside Arena and in a switched-off pile being
   * reported by both lines at once.
   *
   * **The two can never both fire**, and that is a property rather than an accident: the Arena
   * filter is fenced on `format === "arena"` and the inactive one on `!dropsInactive(format)`,
   * which excludes exactly `arena` and `mtgo`. They are written as one chain anyway, because the
   * day a format leaves `ACTIVE_ONLY` is not the day to discover the order was never decided —
   * and the order that would then be right is this one, for `formatExport`'s own reason: filter
   * before anything folds, so nothing held back survives to be merged into a row that is kept.
   *
   * Both are fenced on the format, not just on the flag. A reader who ticked `Include inactive
   * categories` on CSV and moved to Arena must not find Arena's own rule quietly overridden, and
   * one who ticked the Arena box and moved to CSV must not find their CSV short of rows.
   */
  const exported = useMemo(() => {
    let rows: readonly TransferCard[] = cards;
    if (format === "arena" && arenaOnly) rows = rows.filter(isInArena);
    if (excludesInactive) rows = rows.filter(isActivePile);
    return rows;
  }, [arenaOnly, cards, excludesInactive, format]);

  const text = useMemo(() => formatExport(exported, format, fields), [exported, format, fields]);
  /** Copies this format will not write — see `omittedCount`. Recomputed with the format, because
   *  it is a claim about the text on screen and goes stale the moment that changes. */
  const omitted = useMemo(() => omittedCount(exported, format), [exported, format]);
  /** Copies the Arena filter is holding back, or 0 when it is not the one holding anything.
   *  Counted over `cards` rather than `exported`, which is the list it has already emptied. */
  const notInArena = useMemo(
    () => (format === "arena" && arenaOnly ? notInArenaCopies(cards) : 0),
    [arenaOnly, cards, format],
  );
  /** Copies the reader's own `Include inactive categories` answer is holding back, or 0 when it
   *  is not the one holding anything. Counted over `cards` for `notInArena`'s reason — `exported`
   *  is the list this has already emptied — and it can never be non-zero at the same time as
   *  `omitted`, since the two are fenced on complementary halves of `dropsInactive`. */
  const heldBackInactive = useMemo(
    () => (excludesInactive ? inactiveCopies(cards) : 0),
    [cards, excludesInactive],
  );
  /**
   * Lines of the **file**, which is what the toggle names while the preview is shut.
   *
   * Rows of the text rather than cards in the pile, and the two really do differ: a sectioned
   * format writes headings and blank lines between them, and CSV opens on a header. The number
   * is a fact about the text under the toggle, so it is measured on that text — and it moves with
   * the format for the same reason the omission line does. `trimEnd` takes off the single
   * trailing newline every non-empty export ends with, which would otherwise count as a line
   * nobody wrote; an empty export is 0 rather than 1.
   */
  const lines = useMemo(() => (text === "" ? 0 : text.trimEnd().split("\n").length), [text]);

  return {
    format,
    fields,
    arenaOnly,
    includeInactive,
    /** The checkboxes to draw, `ALWAYS` already taken out. */
    available,
    offersInactive,
    text,
    omitted,
    notInArena,
    heldBackInactive,
    lines,
    chooseFormat,
    toggleField,
    toggleArenaOnly,
    toggleIncludeInactive,
  };
}

export type ExportModel = ReturnType<typeof useExportModel>;
