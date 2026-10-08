/**
 * The formats a transfer can be written to or read from.
 *
 * Split out of `export/format.ts` because {@link ../fields.ts} declares field capabilities *per
 * format* and `export/format.ts` will consume `fields.ts` — leaving the format list inside
 * `format.ts` would make that an import cycle. `export/format.ts` re-exports these three names
 * so its existing importers keep working untouched.
 */
export const EXPORT_FORMATS = [
  "plain",
  "mtgo",
  "arena",
  "moxfield",
  "archidekt",
  "tcgplayer",
  "csv",
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  plain: "Plain text",
  mtgo: "MTGO",
  arena: "Arena",
  moxfield: "Moxfield",
  archidekt: "Archidekt",
  tcgplayer: "TCGplayer",
  csv: "CSV",
};

export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string> = {
  plain: "txt",
  mtgo: "txt",
  arena: "txt",
  moxfield: "txt",
  archidekt: "txt",
  tcgplayer: "txt",
  csv: "csv",
};
