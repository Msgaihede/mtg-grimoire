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

/**
 * Where the export format picker draws each format: on its row of radios, or behind the row's
 * **More formats** dropdown (issue #1702).
 *
 * The row keeps the formats most readers reach for; the dropdown holds the ones a reader picks
 * for one site, so the row stops being seven chips wide. Both faces read this (the desktop's
 * `ExportDialog`, the phone's `ExportSheet`), so a format moves between the two in one place.
 *
 * **A `Record` rather than two lists**: a new writer added to {@link EXPORT_FORMATS} does not
 * compile until it is given a place, so it can never be written by `format.ts` and offered
 * nowhere.
 */
export const EXPORT_FORMAT_PLACE: Record<ExportFormat, "row" | "more"> = {
  plain: "row",
  mtgo: "more",
  arena: "row",
  moxfield: "more",
  archidekt: "row",
  tcgplayer: "more",
  csv: "row",
};

/** The formats drawn as radios, in {@link EXPORT_FORMATS}' own order — plain first. */
export const ROW_EXPORT_FORMATS: readonly ExportFormat[] = EXPORT_FORMATS.filter(
  (f) => EXPORT_FORMAT_PLACE[f] === "row",
);

/** The formats behind **More formats**, in {@link EXPORT_FORMATS}' own order. */
export const MORE_EXPORT_FORMATS: readonly ExportFormat[] = EXPORT_FORMATS.filter(
  (f) => EXPORT_FORMAT_PLACE[f] === "more",
);

export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string> = {
  plain: "txt",
  mtgo: "txt",
  arena: "txt",
  moxfield: "txt",
  archidekt: "txt",
  tcgplayer: "txt",
  csv: "csv",
};
