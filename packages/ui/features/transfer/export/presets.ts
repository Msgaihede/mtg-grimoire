/**
 * **Presets** — one site's whole export setting under the site's own name (issue #1726).
 *
 * A preset is a format **and** a field set, decided here rather than by the reader: picking
 * `Card Kingdom` is the whole decision, and the dialog draws no `Fields` checkboxes and no
 * `Include inactive categories` box while one is chosen (`useExportModel`'s `preset`). A reader who
 * wants to tune a file picks a format radio instead; a reader who wants "whatever this site reads"
 * picks the site.
 *
 * **Every preset is written by one of the seven canonical writers** (`format.ts`) — a preset is a
 * setting, never a format of its own — so nothing here reaches the Rust mirror or the golden
 * fence. `formats.ts`' `EXPORT_FORMAT_PLACE` puts MTGO, Moxfield and TCGplayer behind presets
 * alone, and `presets.test.ts` holds that each of those is some preset's format.
 *
 * **Every preset leaves switched-off piles out.** A maybeboard is not something a reader buys or
 * prints, and a preset has no box to ask; the count line (`heldBackInactive`) still says how many
 * copies that held back, so the omission is never silent.
 *
 * **What each site reads, as far as it is written down** (2026-11-25):
 * - Mana Pool's mass entry documents `4 Plains [M20] 261` — TCGplayer's line, flat, set in
 *   brackets — so it pins the printing.
 * - MTGO, Moxfield and TCGplayer keep the setting they had as **More formats** rows: their
 *   writers' defaults.
 * - Card Kingdom, Cardmarket and the four proxy printers do not document their paste box (or
 *   refused the fetch), and mtgproxy.net documents `1 Card Name` for Arena/MTGO lists. So they get
 *   the one shape no list reader misparses: a flat `1 Name` per line, plain text with no finish
 *   mark, no set and no heading. A site later found to read `(SET) 123` can move to a pinning
 *   setting here without either face changing.
 */
import { availableFields, type TransferFieldId, type TransferSurface } from "../fields";
import type { ExportFormat } from "../formats";

export const EXPORT_PRESET_IDS = [
  "cardkingdom",
  "cardmarket",
  "manapool",
  "moxfield",
  "mtgprint",
  "mtgproxy",
  "mtgo",
  "proxxied",
  "proxyprint",
  "tcgplayer",
] as const;
export type ExportPresetId = (typeof EXPORT_PRESET_IDS)[number];

export interface ExportPreset {
  /** The site's own name — the row's word and, while chosen, the trigger's. */
  label: string;
  /** Where the site is — the row's dim hint, and searchable. */
  site: string;
  /** The canonical writer. */
  format: ExportFormat;
  /** The fields written, `ALWAYS` included; narrowed to what the surface holds by
   *  {@link presetFields}. */
  fields: readonly TransferFieldId[];
}

const NAME_ONLY: readonly TransferFieldId[] = ["quantity", "name"];
const PRINTING: readonly TransferFieldId[] = ["quantity", "name", "setCode", "collectorNumber"];

/** A `Record` so a new id does not compile until it says what it writes. */
export const EXPORT_PRESETS: Readonly<Record<ExportPresetId, ExportPreset>> = {
  cardkingdom: {
    label: "Card Kingdom",
    site: "cardkingdom.com",
    format: "plain",
    fields: NAME_ONLY,
  },
  cardmarket: { label: "Cardmarket", site: "cardmarket.com", format: "plain", fields: NAME_ONLY },
  manapool: { label: "Mana Pool", site: "manapool.com", format: "tcgplayer", fields: PRINTING },
  moxfield: {
    label: "Moxfield",
    site: "moxfield.com",
    format: "moxfield",
    fields: [...PRINTING, "finish"],
  },
  mtgprint: { label: "MTG Print", site: "mtgprint.net", format: "plain", fields: NAME_ONLY },
  mtgproxy: { label: "MTG Proxy", site: "mtgproxy.net", format: "plain", fields: NAME_ONLY },
  mtgo: { label: "MTGO", site: "Magic Online", format: "mtgo", fields: NAME_ONLY },
  proxxied: { label: "Proxxied", site: "proxxied.com", format: "plain", fields: NAME_ONLY },
  proxyprint: {
    label: "Proxy Print",
    site: "proxyprint.taxiera.net",
    format: "plain",
    fields: NAME_ONLY,
  },
  tcgplayer: { label: "TCGplayer", site: "tcgplayer.com", format: "tcgplayer", fields: PRINTING },
};

/**
 * The presets in the order the dropdown draws them: by label, case-insensitively — ten site names
 * with nothing deliberate about any order, so the reader scans an alphabet.
 */
export const EXPORT_PRESET_ORDER: readonly ExportPresetId[] = [...EXPORT_PRESET_IDS].sort((a, b) =>
  EXPORT_PRESETS[a].label.localeCompare(EXPORT_PRESETS[b].label, "en", { sensitivity: "base" }),
);

/** A stored string back to a preset id, or `null` — the dropdown speaks strings. */
export function presetIdOf(value: string): ExportPresetId | null {
  return EXPORT_PRESET_IDS.find((id) => id === value) ?? null;
}

/**
 * What a preset writes on this surface: its fields, narrowed to what the format can carry and the
 * surface holds — `availableFields`' intersection, in its order, so a wishlist's Moxfield preset
 * writes no category it does not have and the field order matches a radio's.
 */
export function presetFields(id: ExportPresetId, surface: TransferSurface): TransferFieldId[] {
  const preset = EXPORT_PRESETS[id];
  const on = new Set(preset.fields);
  return availableFields(preset.format, surface).filter((f) => on.has(f));
}
