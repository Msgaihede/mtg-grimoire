import type { JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { EXPORT_PRESET_ORDER, EXPORT_PRESETS, presetIdOf, type ExportPresetId } from "./presets";

/** What the trigger says while the export's format is one of the row's radios. */
export const PRESETS = "Presets";

/** The rows, by label — `EXPORT_PRESET_ORDER` — each with its site as the dim hint. */
const OPTIONS: readonly DropdownOption[] = EXPORT_PRESET_ORDER.map((id) => ({
  value: id,
  label: EXPORT_PRESETS[id].label,
  hint: EXPORT_PRESETS[id].site,
}));

/** A search finds a preset by its name or its site — "taxiera" finds Proxy Print. */
function matchesPreset(option: DropdownOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  return option.label.toLowerCase().includes(q) || (option.hint ?? "").toLowerCase().includes(q);
}

/**
 * **Presets** — the export format picker's second half (issue #1726, which renamed issue #1702's
 * **More formats** and made its rows site presets): the app's searchable `<Dropdown>`, drawn after
 * the format radios on both faces and pushed to the row's far end, with space between it and them,
 * because a preset is a different kind of choice from a radio — a whole setting, not a format to
 * tune.
 *
 * **Picking a row makes it the export's setting**, through `useExportModel`'s `choosePreset`: the
 * preset's format and its fields together, with no checkbox drawn while it holds. While one is
 * chosen no radio is checked and this trigger takes their place in saying so: it reads the
 * preset's name in the radios' own gold (`active`), and its accessible name carries the preset
 * too, since the trigger's `aria-label` is all a screen reader hears of it. While the format is a
 * radio's, the trigger reads `Presets` — the `placeholder` a `<Dropdown>` draws when its `value` is
 * not one of its rows.
 *
 * Re-picking the preset already chosen does nothing, as a select's does.
 */
export function PresetPicker({
  preset,
  onChoose,
  className,
}: {
  /** The export's preset, or `null` while the format is a radio's. */
  preset: ExportPresetId | null;
  /** `useExportModel`'s `choosePreset`. */
  onChoose: (preset: ExportPresetId) => void;
  /** On the trigger — each face sizes it to sit level with its own radios. */
  className?: string;
}): JSX.Element {
  return (
    <Dropdown
      label={preset === null ? PRESETS : `${PRESETS}: ${EXPORT_PRESETS[preset].label}`}
      value={preset ?? ""}
      onChange={(next) => {
        const chosen = presetIdOf(next);
        if (chosen !== null && chosen !== preset) onChoose(chosen);
      }}
      options={OPTIONS}
      placeholder={PRESETS}
      active={preset !== null}
      // The trigger sits at the row's right edge, so the panel opens leftwards from it.
      align="end"
      searchable
      searchPlaceholder="Search presets"
      searchLabel="Search presets"
      matches={matchesPreset}
      panelClassName="w-80"
      className={className}
    />
  );
}
