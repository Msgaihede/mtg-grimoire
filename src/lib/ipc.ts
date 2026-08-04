/**
 * The only place the frontend names a Tauri command or an event.
 *
 * Every type here is a hand-written mirror of a `#[serde(rename_all = "camelCase")]`
 * struct in `src-tauri/src`, so the two can drift silently — a renamed field becomes an
 * `undefined` the compiler is happy with. Rust pins its side in
 * `sync::tests::dto_json_uses_the_camel_case_names_the_frontend_expects`; this side is
 * pinned by `ipc.test.ts` for the argument names, which are the other half of the
 * contract (`invoke` matches them by name, and a typo is a runtime rejection).
 *
 * Sources, verified field by field:
 * `SearchRequest`/`CardSummary`/`SearchResponse`/`SetSummary` — `src-tauri/src/search.rs`
 * `CardFace`/`CardDetail`/`Printing`/`PrintingsResponse`      — `src-tauri/src/card.rs`
 * `SyncOutcome`/`SyncStatus`/`Progress`          — `src-tauri/src/sync.rs`
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ImageVariant } from "./images";

/**
 * A search as the UI asks for it.
 *
 * Rust carries `#[serde(default)]`, so *every* field is optional on the wire — but
 * `limit`/`offset` stay required here on purpose: an omitted `limit` silently becomes
 * the backend's default page size, which a pager that thinks it asked for 100 would
 * then mis-count. Call sites say what they want.
 */
export interface SearchRequest {
  /** Free text, prefix-matched against name, type line and oracle/face text. */
  text?: string;
  /** A `legalities` key (`"modern"`, `"vintage"`, …). `restricted` counts as playable. */
  format?: string;
  /** Colour identity, e.g. `"WU"`; `"C"` means colourless only. Subset semantics. */
  colors?: string;
  setCode?: string;
  /** Set codes. ORed with each other, ANDed with every other filter. */
  sets?: string[];
  /** Mana-value chips: 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
  rarity?: string;
  /** Omitted means true: digital-only printings are hidden unless asked for. */
  paperOnly?: boolean;
  sort?: "name" | "released" | "price";
  /** Clamped to 200 by the backend; 0 means "use the default page size". */
  limit: number;
  offset: number;
}

/** One result row — the columns a card grid needs, not the whole card. */
export interface CardSummary {
  id: string;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  typeLine: string | null;
  manaCost: string | null;
  priceUsd: number | null;
  layout: string;
}

/** A page of results plus the size of the whole match set, for the pager. */
export interface SearchResponse {
  items: CardSummary[];
  /**
   * Matches, counted no further than 5 000. Only meaningful together with
   * `totalIsCapped` — an exact count of a 116 k-row browse cost a full table scan on
   * every keystroke, so the backend stops early and says it did.
   */
  total: number;
  /**
   * The count hit its ceiling: there are `total` matches *or more*. A pager must keep
   * asking for pages while this is true (and stop on the first short page instead), and
   * a caption should read `5,000+`.
   */
  totalIsCapped: boolean;
}

/** One physical side of a card. Empty for single-faced printings. */
export interface CardFace {
  /**
   * `""` for a face whose blob carried no name. Rust defaults it rather than dropping the
   * face, because a flip control addresses faces by *index* and a dropped face silently
   * renumbers every face after it.
   */
  name: string;
  typeLine: string | null;
  oracleText: string | null;
  /** Absent *and* empty both mean "no cost" — a transform's back sends `""`. */
  manaCost: string | null;
  /** Per face: a double-faced card's two sides are not always the same illustrator. */
  artist: string | null;
}

/** Everything the detail pane renders about one printing. */
export interface CardDetail {
  id: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  layout: string;
  lang: string;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  illustrationId: string | null;
  /** Required by Scryfall's image policy wherever art is shown. */
  artist: string | null;
  releasedAt: string | null;
  /** JSON: 23 legality keys and growing. Parse it, never index fixed fields. */
  legalities: string | null;
  /** JSON: six keys, decimal **strings**. A finish price is a lookup in here. */
  prices: string | null;
  finishes: string | null;
  imageStatus: string | null;
  faces: CardFace[];
}

/** One row of the "all printings" list. */
export interface Printing {
  id: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  releasedAt: string | null;
  rarity: string | null;
  /** Two printings differ in *art* iff this differs. `variation` is 0.09% true and useless. */
  illustrationId: string | null;
  artist: string | null;
  /** Scryfall's two-letter code. Every language is listed; `en` is merely the common one. */
  lang: string;
  finishes: string | null;
  prices: string | null;
  promo: boolean;
  fullArt: boolean;
  frameEffects: string | null;
  borderColor: string | null;
  layout: string;
}

/**
 * A page of printings and the size of the list it was taken from.
 *
 * `card::list_printings` caps the page at 400 rows, so `items.length < total` is the whole
 * signal that a list was truncated — and the only thing standing between a caption reading
 * "400 printings" and the 862 paper printings Forest actually has.
 *
 * No `totalIsCapped` twin of {@link SearchResponse}'s, deliberately: that count scans
 * toward 116 k rows on every keystroke, while this one is narrowed by `idx_cards_oracle`
 * to a single card's printings, so it is counted in full every time.
 */
export interface PrintingsResponse {
  /** Newest first. Paper only — digital printings cannot be owned in paper and have no
   *  paper price, so the backend filters them out and the count agrees with the page. */
  items: Printing[];
  total: number;
}

/** One row of the set picker. */
export interface SetSummary {
  /** Lowercase, as `cards.set_code` stores it — this is what the filter sends back. */
  code: string;
  name: string;
  setType: string | null;
  releasedAt: string | null;
  /**
   * Paper printings of this set in the local database.
   *
   * `0` both for the sets `default_cards` omits entirely and for the Arena/MTGO ones the
   * search's `paperOnly` default hides — the two are indistinguishable to a picker, and
   * a row that can only ever return nothing should not be offered either way.
   */
  cardCount: number;
}

/**
 * Result of a sync run.
 *
 * `updatedAt` is not a companion of `updated`: Scryfall can serve a bulk listing with
 * no `updated_at` at all, which is stored as absent and comes back `null` even though
 * cards were ingested. Read the two independently.
 */
export interface SyncOutcome {
  updated: boolean;
  cardCount: number;
  updatedAt: string | null;
}

/**
 * What the UI polls.
 *
 * `dataDir` and `syncing` are always answered. The five database-derived fields are
 * `null` only when the read-only connection could not be used at all; an ingest no
 * longer blanks them. `null` there means "not readable right now", never "zero" and
 * never "cleared": a UI that renders it literally reports an empty collection and
 * throws away an error banner the user has not read yet. See `mergeStatus` in
 * `useSync.ts`, which is the one place that resolves this.
 */
export interface SyncStatus {
  cardCount: number | null;
  /** Unix seconds, as a string. */
  lastCheckAt: string | null;
  /** Scryfall's timestamp for the ingested bulk file, ISO-8601. */
  bulkUpdatedAt: string | null;
  /** Why the last run failed, still readable long after its event was dropped. */
  lastError: string | null;
  /**
   * Lines the last ingest could not read as cards (spec §8 requires the count be
   * surfaced, not swallowed). `null` before any ingest has run — which is not the same
   * as `0`, "the last ingest skipped nothing".
   */
  lastIngestSkipped: number | null;
  dataDir: string;
  syncing: boolean;
}

/** The phases `sync.rs` emits, and the only values `SyncProgressEvent.phase` takes. */
export type SyncPhase =
  | "checking"
  | "downloading"
  | "ingesting"
  | "reclaiming"
  | "sets"
  | "compacting"
  | "done"
  | "error";

/**
 * Payload of the `sync:progress` event.
 *
 * Not a complete account of a sync: a run throttled by the 24 h check window emits
 * nothing at all, and events emitted before the webview registered its listener are
 * dropped by Tauri. Progress is the fast path; `SyncStatus` is the reliable one.
 */
export interface SyncProgressEvent {
  phase: SyncPhase;
  done: number;
  total: number;
  message: string | null;
}

export const ipc = {
  searchCards: (req: SearchRequest) => invoke<SearchResponse>("search_cards", { req }),
  /** Every set, newest first. Cached for the session — it changes once a sync, at most. */
  listSets: () => invoke<SetSummary[]>("list_sets"),
  /** One printing in full, or `null` when no row has that id. */
  cardDetail: (id: string) => invoke<CardDetail | null>("card_detail", { id }),
  /** Every paper printing of the oracle card, newest first, capped at 400 with a full count. */
  cardPrintings: (oracleId: string) => invoke<PrintingsResponse>("card_printings", { oracleId }),
  /**
   * Warm the image cache for a page of results. Fire-and-forget: it resolves as soon as
   * the work is queued, and an image that fails to prefetch simply fetches when it is
   * rendered. The backend takes the front face only and caps the batch at 100.
   */
  prefetchImages: (cardIds: string[], variant: ImageVariant) =>
    invoke<void>("prefetch_images", { cardIds, variant }),
  /** `force` skips the 24 h throttle. Rejects if a sync is already running. */
  syncRun: (force: boolean) => invoke<SyncOutcome>("sync_run", { force }),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  onSyncProgress: (cb: (e: SyncProgressEvent) => void): Promise<UnlistenFn> =>
    listen<SyncProgressEvent>("sync:progress", (evt) => cb(evt.payload)),
};

/**
 * The message out of a rejected `invoke`.
 *
 * All three commands return `Result<_, String>`, so the rejection value is that bare
 * string — not an `Error`. Rendering it with `String(e)` would be right for those and
 * `"[object Object]"` for anything the IPC layer itself throws, so both are handled.
 */
export function ipcError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error: " + JSON.stringify(e);
}
