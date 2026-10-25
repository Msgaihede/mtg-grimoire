/**
 * `Projection v1`, as this Worker holds a device to it: the six tables, the five opt-in fields,
 * which keys a row of each table may carry, and the clear columns a stored row keeps beside its
 * sealed body. The plan's §3.1 is the contract
 * (`docs/superpowers/plans/2026-10-25-integrations-projection-store.md`); the Rust that writes
 * the documents is `grimoire_core::integration::projection`, and its committed golden
 * (`crates/grimoire-core/src/__golden__/projection.json`) is ingested by this Worker's suite.
 *
 * **The device filters and this file holds it to it** (plan §2). A row key outside its table's
 * list, or an opt-in key whose field the document did not switch on, is a refused document
 * rather than a quietly dropped key: a device that sent a note with notes off is a device whose
 * projector is wrong, and storing the rest of its rows would hide that until a reader noticed
 * their notes on a server they had said no to.
 *
 * Nothing here is I/O. `store.ts` calls it from inside the group's object.
 */

/** The six projected tables, and the only names `PUT /g/{group}/projection/{table}` takes. */
export const TABLES = [
  "collection_folders",
  "collection_entries",
  "wishlist_folders",
  "wishlist_entries",
  "decks",
  "deck_cards",
] as const;

export type Table = (typeof TABLES)[number];

/**
 * The five opt-in fields, **in canonical order** — the order a document's `fields` lists the ones
 * it switched on, and the order `IntegrationFields` declares them in the Rust. A document whose
 * `fields` names them in another order is refused: the digest is over that array, and two
 * spellings of one policy would be two digests for one table.
 */
export const FIELD_NAMES = ["condition", "lang", "value", "tags", "notes"] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

/** `IntegrationFields` on the wire: `{ "condition": bool, … }`, all five, nothing else. */
export type IntegrationFields = Record<FieldName, boolean>;

/** Every key a row of each table carries — or may omit when absent (an `image`, a `cover`). */
const ALWAYS: Record<Table, readonly string[]> = {
  collection_folders: ["uid", "name", "parentUid", "kind", "locked"],
  collection_entries: [
    "uid",
    "scryfallId",
    "name",
    "set",
    "cn",
    "finish",
    "quantity",
    "folderUid",
    "image",
  ],
  wishlist_folders: ["uid", "name", "parentUid"],
  wishlist_entries: [
    "uid",
    "scryfallId",
    "oracleId",
    "name",
    "set",
    "cn",
    "finish",
    "quantity",
    "folderUid",
    "image",
  ],
  decks: ["uid", "name", "format", "folderUid", "cover"],
  deck_cards: [
    "uid",
    "deckUid",
    "pile",
    "kind",
    "active",
    "scryfallId",
    "name",
    "set",
    "cn",
    "finish",
    "quantity",
    "image",
    "typeLine",
    "manaCost",
    "manaValue",
  ],
};

/**
 * The opt-in keys each table *can* carry. A row carries one only when the document's `fields`
 * switched it on — and the key is the field's own name, which is why this is a list of
 * `FieldName`s rather than of strings.
 *
 * **A wish carries entry tags** (`wishlist_entries.tags`, user schema v67, issue #1398 — the twin
 * of a copy's, under the same `tags` switch): the reader's own free-text tags on the wish, never a
 * Scryfall tag and never a deck's.
 *
 * **Absent from the format, and never a switch** (plan §3.1): purchase price and currency,
 * acquired-at, acquisition source, `needs_review`, serial number, grading, deck descriptions,
 * notes and tags, labels and to-dos. None of them is a key here, so a row that carries one is
 * refused whatever its document's `fields` says.
 */
const OPT_IN: Record<Table, readonly FieldName[]> = {
  collection_folders: [],
  collection_entries: ["condition", "lang", "value", "tags", "notes"],
  wishlist_folders: [],
  wishlist_entries: ["lang", "value", "tags", "notes"],
  decks: [],
  deck_cards: ["lang", "value"],
};

/** Is `name` one of the six? A `string` the router matched, narrowed. */
export function isTable(name: string): name is Table {
  return (TABLES as readonly string[]).includes(name);
}

/**
 * `{ "fields": IntegrationFields }`'s inner object, or `null`: exactly the five names, each a
 * boolean. An unknown name is refused rather than ignored — a newer device switching on a field
 * this Worker cannot hold it to would otherwise be told "saved".
 */
export function parseFields(value: unknown): IntegrationFields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== FIELD_NAMES.length) return null;
  const fields = {} as IntegrationFields;
  for (const name of FIELD_NAMES) {
    const on = (value as Record<string, unknown>)[name];
    if (typeof on !== "boolean") return null;
    fields[name] = on;
  }
  return fields;
}

/**
 * **The marketplaces a projection's prices can come from** — the projection document's
 * `marketplace` vocabulary, `grimoire_core::share::snapshot::marketplace_id`'s four answers.
 * A setting of the **group's**, held by its store, as the fields are: a device's own marketplace
 * would have two devices pricing one table two ways and overwriting each other on every publish
 * (the review of the Rust side, 2026-10-25).
 */
export const MARKETPLACES = ["tcgplayer", "cardmarket", "cardkingdom", "manapool"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

/**
 * The currency a marketplace's prices are in — `share::snapshot::currency`'s rule: Cardmarket's
 * are euros, every other marketplace's dollars. A document's `currency` must be this.
 */
export function currencyOf(marketplace: Marketplace): "EUR" | "USD" {
  return marketplace === "cardmarket" ? "EUR" : "USD";
}

/** Is `value` one of the four? */
export function isMarketplace(value: unknown): value is Marketplace {
  return typeof value === "string" && (MARKETPLACES as readonly string[]).includes(value);
}

/** What a group's store holds as its settings: the field policy and the marketplace. */
export interface GroupSettings {
  fields: IntegrationFields;
  marketplace: Marketplace;
}

/**
 * `PUT /g/{group}/settings`'s body — `{ "fields": IntegrationFields, "marketplace": "<id>",
 * "create": boolean }`, exactly those three keys — or `null` (`400 bad_settings`). `create`
 * says whether this write may make a store: `true` from the switch that turns integrations on,
 * `false` from a change of settings, which must not bring back a store another device just
 * switched off.
 */
export function parseSettings(value: unknown): (GroupSettings & { create: boolean }) | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join() !== "create,fields,marketplace") return null;
  const fields = parseFields(body.fields);
  if (fields === null || !isMarketplace(body.marketplace) || typeof body.create !== "boolean") {
    return null;
  }
  return { fields, marketplace: body.marketplace, create: body.create };
}

/** The names a policy switches on, in canonical order — what a document's `fields` must be. */
export function enabledNames(fields: IntegrationFields): FieldName[] {
  return FIELD_NAMES.filter((name) => fields[name]);
}

/** One projected row: an object with a non-empty string `uid`, and keys this file allowed. */
export type Row = Record<string, unknown> & { uid: string };

/** A document that passed {@link validateDocument}. */
export interface Document {
  table: Table;
  fields: FieldName[];
  marketplace: Marketplace;
  rows: Row[];
}

/**
 * The document, or the sentence that refuses it (`400 bad_projection`).
 *
 * What it checks is the shape the Worker relies on and the key policy the device promised —
 * `v === 1`, `table` equal to the path's, `fields` a list of known names in canonical order,
 * `marketplace` one of the four and `currency` the one it prices in, `rows` an array of objects
 * each with a non-empty string `uid`, every `uid` once, and every key on the table's list for
 * those fields. **Not the values' types beyond `uid`**: a row is sealed
 * whole and the reader of it is the group's own device or an integration the group switched on,
 * so a `quantity` that is a string is that reader's to refuse; what this side keeps in the clear
 * reads each value only when it is the type the column wants (`clearColumns`).
 *
 * `fields` and `marketplace` against the *store's* settings are not decided here: that is
 * `409 settings_mismatch`, and it needs the store.
 */
export function validateDocument(value: unknown, table: Table): Document | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "that projection is not a JSON object";
  }
  const doc = value as Record<string, unknown>;
  if (doc.v !== 1) return "that projection is not version 1";
  if (doc.table !== table) return `that projection is of ${String(doc.table)}, not ${table}`;

  const fields = doc.fields;
  if (!Array.isArray(fields) || fields.some((name) => typeof name !== "string")) {
    return "that projection's fields are not a list of names";
  }
  const canonical = FIELD_NAMES.filter((name) => fields.includes(name));
  if (canonical.length !== fields.length || canonical.some((name, at) => name !== fields[at])) {
    return "that projection's fields are not known names in their canonical order";
  }
  if (!isMarketplace(doc.marketplace))
    return "that projection names no marketplace this store knows";
  if (doc.currency !== currencyOf(doc.marketplace)) {
    return `that projection's currency is not ${currencyOf(doc.marketplace)}, ${doc.marketplace}'s`;
  }

  const rows = doc.rows;
  if (!Array.isArray(rows)) return "that projection's rows are not a list";
  const allowed = new Set<string>([
    ...ALWAYS[table],
    ...OPT_IN[table].filter((name) => canonical.includes(name)),
  ]);
  const seen = new Set<string>();
  for (const [at, row] of rows.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return `row ${at} is not an object`;
    }
    const uid = (row as Record<string, unknown>).uid;
    if (typeof uid !== "string" || uid === "") return `row ${at} has no uid`;
    if (seen.has(uid)) return `row ${at} repeats the uid of an earlier row`;
    seen.add(uid);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) return `row ${at} carries ${key}, which ${table} may not`;
    }
  }
  return { table, fields: canonical, marketplace: doc.marketplace, rows: rows as Row[] };
}

/**
 * **The version of {@link clearColumns} and {@link normaliseName}**, and part of every row's MAC
 * (`seal.ts`'s `rowMac`). A store writes only the rows whose MAC moved, so a change to how a
 * clear column is derived would otherwise reach only the rows that happened to change — and
 * leave every other row indexed the old way, for ever. Bumping this moves every MAC: the next
 * publish of each table seals and writes it whole once, under the new derivation.
 */
export const CLEAR_COLUMNS_VERSION = 1;

/**
 * The columns a stored row keeps **in the clear**, beside its sealed body — only what a later
 * query has to find a row by (the issue's knob 2): its `sync_uid`, the Scryfall id, the
 * normalised name, set, collector number, finish, quantity, the uid of what holds it, and kind.
 *
 * `folder_uid` is the row's **container**, whichever key names it in its table: an entry's
 * `folderUid`, a folder's `parentUid`, a deck's `folderUid`, a deck card's `deckUid` — so "the
 * rows in X" is one indexed read whatever X is. `kind` is a folder's `kind` and a deck card's
 * pile kind; nothing else has one.
 *
 * Each value is kept only when it is the type the column holds, and is `null` otherwise — a
 * column is an index, not a second copy of the row to validate. The row itself, with everything
 * here and everything else, is the sealed body.
 *
 * ⚠️ **A change to how any of these is derived bumps {@link CLEAR_COLUMNS_VERSION}.**
 */
export interface Clear {
  scryfall_id: string | null;
  name_norm: string | null;
  set_code: string | null;
  cn: string | null;
  finish: string | null;
  quantity: number | null;
  folder_uid: string | null;
  kind: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function clearColumns(table: Table, row: Row): Clear {
  const container =
    table === "deck_cards"
      ? row.deckUid
      : table === "collection_folders" || table === "wishlist_folders"
        ? row.parentUid
        : row.folderUid;
  const name = text(row.name);
  return {
    scryfall_id: text(row.scryfallId),
    name_norm: name === null ? null : normaliseName(name),
    set_code: text(row.set),
    cn: text(row.cn),
    finish: text(row.finish),
    quantity: Number.isSafeInteger(row.quantity) ? (row.quantity as number) : null,
    folder_uid: text(container),
    kind: text(row.kind),
  };
}

/**
 * A name as a lookup compares it: lower case, compatibility-decomposed (NFKD) with its combining
 * marks dropped, and runs of whitespace collapsed to one space with none at either end — so
 * `Lim-Dûl's Vault`, `lim-dul's vault` and ` LIM-DUL'S  VAULT ` are one name. Punctuation is
 * left alone: a typographic apostrophe is not a straight one under NFKD, and is not made one.
 *
 * ⚠️ **Not the engine's search normaliser, and it need not be.** This column is written and read
 * by this Worker alone (the intents and integrations of PR 3 and 4 query it here). A later change
 * to it bumps {@link CLEAR_COLUMNS_VERSION}, which is what makes the next publish rewrite every
 * row: without the bump, only the rows that changed would be.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
