/**
 * The Discord integration (issue #1096, spec §13.6): linking the reader's Discord account, then
 * pairing the operator's bot into their sync group as a **read-only device**, and taking it out.
 *
 * **One domain of `../ipc.ts`.** Nothing outside `packages/ui/lib/ipc*` imports this file: every
 * page, hook, story and test goes through `@/lib/ipc`, which re-exports these types and spreads
 * `discordCommands` into `ipc`. `ipc.test.ts` reads this file with its siblings, so the
 * struct-parity walk and the command fences cover it.
 *
 * **Desktop only, like `share.ts`** — the six commands are registered by the desktop host alone
 * (`apps/desktop/src-tauri/src/discord/commands.rs`). No light host has them, so the light
 * edition's Settings does not draw the panel (`LIGHT_SETTINGS`).
 *
 * **Every time on this page is Unix milliseconds** — pairing's own unit (`now_ms`, the rendezvous'
 * `expires_at`) and the Workers' `Date.now()` — unlike the share rows' seconds one file over. A
 * reader that handed one to `ago` as seconds would print a date fifty thousand years out.
 */
import { invoke } from "./invoke";

/**
 * Where the integration stands — `discord::commands::DiscordStatus`.
 *
 * Three stages, read in this order: a sign-in standing open (`linking`), a Discord account
 * linked (`linked`), and the bot enrolled in the sync group (`enrolled`). **They are separate
 * facts rather than one word**, because the desktop answers them from separate rows — the pending
 * PKCE request, the link secret, and the bot's device row — and the panel reads `enrolled` first,
 * then `linked`, so a row left behind by a crash draws the furthest stage rather than a wait.
 */
export interface DiscordStatus {
  /** A link secret is stored: this install has a Discord account behind it. */
  linked: boolean;
  /** The Discord name the account had when it was linked, or `null` before a link. Shown as
   *  *Signed in as …* — a name, never an id, where one is known. */
  username: string | null;
  /** The account's Discord snowflake, as a string (it does not fit a JavaScript number). */
  discordUserId: string | null;
  /** A link request is pending: the reader is (or was) in their browser signing in, and
   *  `discord_link_poll` is what to ask, every two seconds. */
  linking: boolean;
  /** When the pending request stops being claimable, in **milliseconds**. `null` with no
   *  request pending. */
  linkExpiresAt: number | null;
  /** The bot is a device in this reader's sync group, with the `read` capability. */
  enrolled: boolean;
  /** The bot's device id in the group, or `null` before it is enrolled. */
  botDeviceId: string | null;
  /** When the bot last pulled the group's changes, in **milliseconds**, or `null` for never
   *  (or for a front that would not say). */
  lastPullAt: number | null;
  /**
   * **`null` is ready to enable; a sentence is why not** — the engine's `integration::gate`
   * (spec §13.5): not in a group, not a supporter, a relay without signatures, a member with no
   * signing key, five devices already, a restricted device already present. Drawn as it is and
   * never reworded on this side.
   */
  gate: string | null;
}

/** What `discord_link_begin` answers: where to send the reader, and until when. */
export interface DiscordLinkStart {
  /** Discord's own authorize page, with this request's `state` on it. Opened in the system
   *  browser through `openExternal`; never in the app's own window. */
  authorizeUrl: string;
  /** In **milliseconds** — {@link DiscordStatus.linkExpiresAt}, answered once more so the page
   *  need not re-read the status to know it. */
  expiresAt: number;
}

/** The Discord commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this
 *  object. **None takes an argument**: the desktop holds every secret and every id. */
export const discordCommands = {
  /** `discord_status` — the integration's local state, plus the gate. **No request to the
   *  Discord front**, so it is free to ask whenever the panel mounts. */
  discordStatus: () => invoke<DiscordStatus>("discord_status"),
  /**
   * `discord_link_begin` — start a link: the desktop makes a PKCE verifier, asks the front for a
   * link request and stores it, and answers where to send the reader. **It opens nothing**: the
   * page hands {@link DiscordLinkStart.authorizeUrl} to `openExternal`, the app's one way out.
   */
  discordLinkBegin: () => invoke<DiscordLinkStart>("discord_link_begin"),
  /**
   * `discord_link_poll` — claim the request: has the reader approved yet? Answers the status
   * either way — `linking` still true is *not yet*, `linked` true is done. A refused request
   * (denied, expired, mismatched) rejects with the desktop's sentence.
   */
  discordLinkPoll: () => invoke<DiscordStatus>("discord_link_poll"),
  /** `discord_link_cancel` — forget a pending request. The front's request simply expires
   *  unclaimed. */
  discordLinkCancel: () => invoke<DiscordStatus>("discord_link_cancel"),
  /**
   * `discord_enable` — the gate, then a pairing offer, the bot's enrolment against it, and the
   * pinned confirm that admits it with `read` and enters signed mode. Slow (several trips to two
   * services); answers the status with `enrolled` true, or rejects with the sentence of the step
   * that refused.
   */
  discordEnable: () => invoke<DiscordStatus>("discord_enable"),
  /**
   * `discord_disable` — remove the bot from the sync group (which rotates the group key), have
   * the front delete the link and the bot's whole copy, and forget the link here. It cannot take
   * the app off the reader's Discord account; Discord's *Authorized Apps* does that.
   */
  discordDisable: () => invoke<DiscordStatus>("discord_disable"),
};
