import type { JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { EXPORT_FORMAT_LABEL, MORE_EXPORT_FORMATS, type ExportFormat } from "../formats";

/** What the trigger says while the export's format is one of the row's radios. */
export const MORE_FORMATS = "More formats";

/**
 * The rows, in `MORE_EXPORT_FORMATS`' own order — the same deliberate order the radio row keeps,
 * and not re-sorted: the list is a constant, so there is nothing for an order to settle.
 */
const OPTIONS: readonly DropdownOption[] = MORE_EXPORT_FORMATS.map((f) => ({
  value: f,
  label: EXPORT_FORMAT_LABEL[f],
}));

/**
 * **More formats** — the export format picker's second half (issue #1702): the formats
 * `EXPORT_FORMAT_PLACE` puts behind the row, as the app's searchable `<Dropdown>` (the shell the
 * set filter is built on), drawn after the format radios on both faces.
 *
 * **Picking a row makes it the export's format**, through the same `chooseFormat` the radios
 * call, so a format picked here and a radio pressed there cannot mean two different things. While
 * one of these is the format, no radio is checked and this trigger takes their place in saying
 * so: it reads the format's name in the radios' own gold (`active`), and its accessible name
 * carries the format too, since the trigger's `aria-label` is all a screen reader hears of it.
 * While the format is a radio's, the trigger reads `More formats` — the `placeholder` a
 * `<Dropdown>` draws when its `value` is not one of its rows.
 *
 * Re-picking the format already chosen does nothing, as a select's does: `chooseFormat`
 * re-derives the field row from the format's defaults, and a press that changes nothing must not
 * throw away the reader's field choices.
 */
export function MoreFormats({
  format,
  onChoose,
  className,
}: {
  /** The export's format — a radio's or one of this control's. */
  format: ExportFormat;
  /** `useExportModel`'s `chooseFormat`. */
  onChoose: (format: ExportFormat) => void;
  /** On the trigger — each face sizes it to sit level with its own radios. */
  className?: string;
}): JSX.Element {
  const picked = MORE_EXPORT_FORMATS.includes(format);
  return (
    <Dropdown
      label={picked ? `${MORE_FORMATS}: ${EXPORT_FORMAT_LABEL[format]}` : MORE_FORMATS}
      value={format}
      onChange={(next) => {
        const chosen = MORE_EXPORT_FORMATS.find((f) => f === next);
        if (chosen !== undefined && chosen !== format) onChoose(chosen);
      }}
      options={OPTIONS}
      placeholder={MORE_FORMATS}
      active={picked}
      searchable
      searchPlaceholder="Search formats"
      searchLabel="Search formats"
      panelClassName="w-52"
      className={className}
    />
  );
}
