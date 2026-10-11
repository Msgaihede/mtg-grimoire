/**
 * Shared collections: publishing a folder as a link, refreshing and revoking it, and opening somebody else's.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `shareCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { invoke } from "./invoke";

/**
 * One published share, as the list draws it — `collection_shares`' row, `share/commands.rs`.
 *
 * **The cache is the app's copy of the relay's list and is deliberately not a synced table**, so
 * every field here is either the reader's own answer or the relay's, written down at publish
 * time. Two of them look derivable and are not, which is the thing to know before reaching for a
 * shortcut:
 *
 * * {@link url} is built by the Worker from its own `SHARE_BASE` binding, so this side stores
 *   the link rather than rebuilding it. A share list with no links is not a share list, and it
 *   has to be drawable with no network.
 * * {@link ownerName} is what the *next* device in the group publishes under (spec §4.3). The
 *   device that pressed Share already knows the name it typed; a second device inherits it from
 *   `GET /g/{group}/shares` rather than asking the reader to type it again, which is a question
 *   nothing else on this row could answer.
 */
export interface ShareRow {
  /** The share id — and the last path segment of {@link url}. */
  id: string;
  /** `collection_folders.sync_uid`, and `null` for a whole-collection share. **A folder's sync
   *  uid rather than its local id**, because a share outlives the device that made it and a row
   *  id names a row in a database no other device has seen. */
  folderUid: string | null;
  /** The folder's own name, or `Collection` for a whole-collection share — the title the
   *  snapshot carries and the viewer draws. */
  title: string;
  /** What the owner typed, never anything Patreon supplied. See this interface's header. */
  ownerName: string;
  /** The link to hand somebody. **Stored, never rebuilt** — see this interface's header. */
  url: string;
  /**
   * Which optional columns this share answers — some of `condition`, `lang`, `value`, and the
   * wire form of the three switches {@link ShareFields} sends.
   *
   * ⚠️ **Not a promise that every card in the snapshot carries them**, which is a rule about the
   * format rather than about this row: `@/lib/shareSnapshot`'s header is where it is written
   * down, and any viewer of a snapshot has to have read it.
   *
   * A `string[]` rather than a union for {@link CollectionFolder.kind}'s reason: Rust stores the
   * words, a fourth column is a migration rather than a type error, and a reader that compares
   * and falls through keeps working the day there is one.
   */
  fields: string[];
  /**
   * `live`, `lapsed` or `revoked`.
   *
   * The middle one is the relay's daily pass talking — a membership that stopped paying, whose
   * shares stop answering — and is the one a reader must be told about before their friends tell
   * them. `revoked` is the reader's own press and is terminal.
   *
   * A plain `string` rather than a union, {@link CollectionFolder.kind}'s rule again and with a
   * sharper edge here: the word can arrive from the *relay* rather than from this build, so a
   * union would be a claim about a vocabulary neither side of this file owns.
   */
  state: string;
  /**
   * When **this device** last uploaded a snapshot, in seconds — and `null` for a device that
   * never has.
   *
   * The relay knows nothing about it. `null` is what a second device in the group reads before
   * it offers *Update* rather than *Share*, so it is a fact about this machine sitting on a row
   * that otherwise describes the group's.
   */
  published: number | null;
  /** When the row itself last changed, in seconds. */
  updatedAt: number;
}

export interface ShareFields {
  /** The grade each copy is in, `NM` and friends. An **ungraded** copy still carries nothing —
   *  see `@/lib/shareSnapshot`'s header. */
  condition: boolean;
  /** The language each copy is in. */
  lang: boolean;
  /** What each copy is worth, at the publisher's own marketplace and in its currency. */
  value: boolean;
}

/** The share commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const shareCommands = {
  /**
   * Every share the group has published — `share::commands::share_list`, and the only one of the
   * five that could reconcile against the relay first.
   *
   * It does, when it can: spec §4.3 has a second device inherit {@link ShareRow.ownerName} from
   * the relay's list, and every other `share_*` command needs an id or a name that device does
   * not yet have. **A failure — or no membership at all — answers the cache**, which is what the
   * cache is for, so this is a read that is allowed to be offline and never a read that reports
   * one.
   */
  shareList: () => invoke<ShareRow[]>("share_list"),
  /**
   * Publish a folder read-only — or the whole collection, for a `null` `folderUid`.
   *
   * ⚠️ **`null` is the whole collection and is a destination rather than an omission**, which
   * makes this the one wrapper on this page where a misspelt argument is worse than a rejection:
   * `invoke` matches by name, so a key the command does not declare is *dropped*, `folder_uid`
   * arrives `None`, and the press succeeds — publishing every card the reader owns instead of
   * the one binder they picked. `ipc.test.ts` pins the three names against `share/commands.rs`
   * itself for exactly that.
   *
   * `folderUid` is `collection_folders.sync_uid` and never a row id — see
   * {@link ShareRow.folderUid}. `ownerName` is what the reader typed, and
   * {@link ipc.shareList} is where a second device gets it from.
   */
  shareCreate: (folderUid: string | null, ownerName: string, fields: ShareFields) =>
    invoke<ShareRow>("share_create", { folderUid, ownerName, fields }),
  /** Upload a fresh snapshot for a share that already exists, **keeping its link** — so a reader
   *  who has handed the URL out never has to hand out a second one. Answers the row re-read. */
  shareRefresh: (id: string) => invoke<ShareRow>("share_refresh", { id }),
  /** Withdraw a share. **Terminal and the reader's own press** — the link stops answering, and
   *  {@link ShareRow.state} is `revoked` rather than the row going away. */
  shareRevoke: (id: string) => invoke<void>("share_revoke", { id }),
  /**
   * Open somebody else's shared collection from its link. **Needs no membership and sends no
   * token** (spec §9): viewing is open to everyone and the link is the whole of the capability.
   *
   * ⚠️ **`unknown`, and that is the type rather than a gap to be tightened.** The crate answers
   * `serde_json::Value` on purpose — spec §10 wants a snapshot published by a *newer* build told
   * about rather than refused, which a strict Rust struct turns into a parse error at the wrong
   * layer, with no sentence a reader could act on. So the conclusion is drawn one module over:
   * **hand the answer to `parseSnapshotValue` in `@/lib/shareSnapshot`**, which is the one reader
   * of this format on this side and the only thing entitled to say what it is. It takes a parsed
   * value, so nothing is re-serialised on the way in — `parseSnapshot` is its sibling, for the
   * web viewer, which has a response body and therefore has text.
   *
   * A `ShareSnapshot` return type here would be this file claiming a shape it has not checked,
   * and a second implementation of the format's rules to keep in step with the writer and both
   * viewers.
   */
  shareOpen: (url: string) => invoke<unknown>("share_open", { url }),
};
