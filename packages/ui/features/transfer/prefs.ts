/**
 * What a transfer remembers for the length of a session — each surface's export setting and the
 * import's two fallbacks — as **shapes and opening values**, with no store behind them.
 *
 * **A module of its own so that a face without the app store can hold the same answers.** The
 * desktop keeps them in `useAppStore` (`exportPrefs`, `importDefaults`), and the light app's phone
 * face may not import that store (`apps/light/phone/fence.test.ts`). Both open on the values written
 * here, so a reader who has never touched either dialog meets the same CSV on the collection and
 * the same "Not set" condition on whichever face they are using — and a change to what a first
 * export looks like is one edit, not two that have to agree.
 *
 * Session state on both faces: no `app_meta` row and no persist middleware, so these literals are
 * what every launch opens on.
 */
import { CONDITION_NOT_SET, type Condition } from "@/lib/conditions";
import type { DeckFinish } from "@/lib/ipc";
import { defaultFields, type TransferFieldId, type TransferSurface } from "./fields";
import type { ExportFormat } from "./formats";

/**
 * What one surface's export dialog opens holding — see `useAppStore`'s `exportPrefs`, which is
 * where the per-surface argument and `arenaOnly`'s exemption from the format switch are made.
 *
 * Named and exported rather than written inline, because the export dialog's `setPrefs` calls
 * spread it: a fourth key added here must reach those call sites as a type error rather than as
 * a setting they silently drop on the next press.
 */
export interface ExportPrefs {
  format: ExportFormat;
  fields: TransferFieldId[];
  /** Leave out cards MTG Arena does not have. Read by the `arena` format alone. */
  arenaOnly: boolean;
  /**
   * Write the piles the reader has switched off — issue #390. Read only on a surface that has
   * piles (`SURFACE_HAS_PILES`) and only by the five formats that do not already answer the
   * question for themselves (`export/format.ts`'s `dropsInactive`).
   *
   * **Named for what ticking it does rather than for what leaving it does**, unlike `arenaOnly`
   * beside it, and the two therefore default off for opposite reasons — see
   * {@link INITIAL_EXPORT_PREFS}, where the behaviour change this cost is written down.
   */
  includeInactive: boolean;
}

/**
 * What a bulk import line that says nothing becomes — the collection's condition and finish, and
 * the wishlist's finish alone (it draws the same field and ignores `condition`, which is this
 * app's collection-only vocabulary). One shared pair rather than one per surface: see
 * `useAppStore`'s `importDefaults`.
 */
export interface ImportDefaults {
  condition: Condition;
  finish: DeckFinish;
}

/**
 * Each surface's export setting before the reader has chosen one.
 *
 * A collection opens on CSV because that is the only format that can carry a condition, and a
 * collection without conditions is a card list rather than a record of what the reader owns.
 * `arenaOnly` opens **off** everywhere: the Arena export has written every card handed to it
 * since it shipped, and a filter that starts on would quietly change what an existing reader's
 * next export contains. The dialog's own count line is how they find the box.
 *
 * **`includeInactive` opens off too, and that argument is spent on the other side** — issue #390
 * is a reader reporting the maybeboard turning up in a deck they exported, so leaving it on by
 * default would ship the fix with the bug still in it. It is worth naming what that costs: the
 * five formats that wrote a switched-off pile before this shipped — plain, Moxfield, Archidekt,
 * TCGplayer, CSV — stop writing one unless the reader ticks the box, so an existing reader's next
 * deck export **does** change. The dialog's own count line is how they find the box, and Arena and
 * MTGO are untouched because `dropsInactive` already answers for them. `false` on the two
 * pile-less surfaces is the value `SURFACE_HAS_PILES` makes unreachable rather than a decision
 * about them.
 */
export const INITIAL_EXPORT_PREFS: Readonly<Record<TransferSurface, ExportPrefs>> = {
  deck: {
    format: "plain",
    fields: defaultFields("plain", "deck"),
    arenaOnly: false,
    includeInactive: false,
  },
  collection: {
    format: "csv",
    fields: defaultFields("csv", "collection"),
    arenaOnly: false,
    includeInactive: false,
  },
  wishlist: {
    format: "plain",
    fields: defaultFields("plain", "wishlist"),
    arenaOnly: false,
    includeInactive: false,
  },
};

/**
 * The import's fallbacks before the reader has answered them.
 *
 * The condition opens on the sentinel since schema v35: an import line that says nothing about a
 * grade records that it said nothing, rather than the app writing the best grade on the scale on
 * the reader's behalf.
 *
 * **Nothing converts a value already in hand, and today there is none to convert** — this pair is
 * in-memory session state with no `app_meta` row and no persist middleware behind it. If it is
 * ever given a stored home, the migration to write is *none*: a reader whose stored answer is `NM`
 * either chose it or lived with it, and silently changing what their next import records is worse
 * than the inconsistency it would tidy away.
 */
export const INITIAL_IMPORT_DEFAULTS: Readonly<ImportDefaults> = {
  condition: CONDITION_NOT_SET,
  finish: null,
};
