import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useId, useState, type JSX } from "react";
import { openExternal } from "@/lib/externalLinks";
import { ipc, ipcError, type DiscordStatus } from "@/lib/ipc";
import { DISCORD_KEY, DISCORD_POLL_KEY, SYNC_KEY } from "@/lib/query";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { ConfirmDialog } from "./ConfirmDialog";
import { PANEL_BUTTON, SWITCH, switchTone } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** How often a pending sign-in is claimed — spec §13.6's two seconds. */
export const LINK_POLL_MS = 2_000;

/**
 * The folder a collection add lands in when none is named — `ADDED_FROM_DISCORD` in
 * `crates/grimoire-core/src/integration/add.rs`, which the desktop makes on switch-on (spec
 * §14.3, §14.5). Copied, not read: the panel only names it.
 */
export const ADDED_FROM_DISCORD = "Added from Discord";

/**
 * What the reader can type in Discord once the bot is in their group, one line each — spec
 * §13.7's lookups and §14.4's two adds. **Exported so the stories and the tests read the list the
 * panel draws.**
 *
 * `search` is a subcommand because Discord refuses a command that is both run on its own and the
 * parent of others — and `/collection` is the parent of `add` too.
 */
export const DISCORD_COMMANDS: readonly { command: string; does: string }[] = [
  {
    command: "/collection search",
    does: "Shows a card from your collection — its printings, finishes, quantities and folders.",
  },
  {
    command: "/collection add",
    does: `Adds a card to your collection, in ${ADDED_FROM_DISCORD} unless you name a folder.`,
  },
  { command: "/wishlist search", does: "Shows a card from your wishlist." },
  { command: "/wishlist add", does: "Adds a card to your wishlist." },
  { command: "/card-search", does: "Shows any card from Scryfall, with its image and price." },
  {
    command: "/deck [format]",
    does: "Posts one of your decks as a list — plain text, Arena, MTGO or Moxfield.",
  },
];

/**
 * When the bot last brought its copy up to date — `Last updated 2 hours ago.`
 *
 * **`lastPullAt` is milliseconds** (`DiscordStatus`' unit) and {@link ago} takes seconds: the one
 * conversion on this panel, and the one a reader of `BackupPanel` beside it would get wrong by
 * copying, because that panel's clock is seconds.
 *
 * @param nowMs the clock — a default parameter, `lastPassLine`'s reason: a settings panel on a
 * timer would be motion without information.
 */
export function lastPullLine(status: DiscordStatus, nowMs: number = Date.now()): string {
  if (status.lastPullAt === null) return "The bot hasn't fetched your cards yet.";
  return `The bot last fetched your changes ${ago(status.lastPullAt / 1000, nowMs)}.`;
}

/**
 * Settings → Integrations → Discord (issue #1096, spec §1 and §13.6).
 *
 * **Three stages, each one the next press.** Not linked: a switch that starts the sign-in —
 * `discord_link_begin`, Discord's authorize page in the reader's own browser, then a claim every
 * {@link LINK_POLL_MS} until they approve. Linked: *Add the bot to your sync group*, behind a
 * `ConfirmDialog` that says what that hands the operator and what the bot may add, unless the
 * gate refuses — then the gate's sentence, and the button disabled. Enrolled: the bot's device,
 * when it last fetched, and the commands. Switching off from either of the last two asks first and runs `discord_disable`.
 *
 * **It reaches the backend itself**, `BackupPanel`'s rule: no other surface draws this state.
 * Every command answers a fresh status and it is written straight back under
 * {@link DISCORD_KEY}, so the panel draws one status whichever press produced it.
 *
 * **The poll stops on four things**: the link landing (the status it writes back is no longer
 * `linking`, which disables it), a refusal (an expired, denied or mismatched request — the
 * poll's `refetchInterval` goes `false` on an error), the request's own expiry, and the panel
 * unmounting.
 */
export function DiscordPanel(): JSX.Element {
  const id = useId();
  const client = useQueryClient();
  /** The question before enrolling the bot, or before switching off. One value, never two
   *  flags — `DangerZonePanel`'s `Asking`. */
  const [asking, setAsking] = useState<"enable" | "disable" | null>(null);
  /** The question's subject outlives the flag by the dialog's fade — `DangerZonePanel`'s reason:
   *  a title derived from `asking` would blank while the dialog animates out. */
  const [shown, setShown] = useState<"enable" | "disable">("enable");
  /** The sign-in page this window opened, held so *Open the sign-in page* can open it again.
   *  Only the press that began it had the URL; the status does not carry it. */
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  /** The browser would not open — `openExternal` refused. Cleared by the next begin. */
  const [openRefusal, setOpenRefusal] = useState<string | null>(null);
  /** The expiry that has passed, by its own stamp, so a fresh request — a new `linkExpiresAt` —
   *  is unexpired without anything resetting this. */
  const [expiredFor, setExpiredFor] = useState<number | null>(null);

  const read = useQuery({ queryKey: DISCORD_KEY, queryFn: () => ipc.discordStatus() });
  const status = read.data ?? null;
  const settle = (next: DiscordStatus) => client.setQueryData<DiscordStatus>(DISCORD_KEY, next);

  const expiresAt = status?.linking ? status.linkExpiresAt : null;
  const expired = expiresAt !== null && expiredFor === expiresAt;
  /** A sign-in that can still be finished: pending, not linked yet, and not past its deadline. */
  const linking = status !== null && !status.linked && status.linking && !expired;

  /**
   * The expiry, as one timer for the request's own deadline rather than a ticking `now` — the
   * panel redraws once, when it matters. A deadline already behind the clock fires at once.
   */
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setExpiredFor(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  /**
   * The claim. Its answer is a status and goes straight back under {@link DISCORD_KEY}, and the
   * first answer that is no longer `linking` is what turns this off. `staleTime: 0` for
   * `SyncPanelBody`'s pairing poll's reason: an answer from cache would sit on *Waiting* after the
   * reader had already approved. Unmounting the panel unmounts the query, and its interval with it.
   *
   * **A refusal re-reads the status** before it is drawn: the desktop forgets a request Discord
   * denied or that expired, and the panel must not go on offering a Cancel for nothing.
   */
  const poll = useQuery({
    queryKey: DISCORD_POLL_KEY,
    queryFn: async () => {
      // A deadline already behind the clock asks nothing: the timer above has not redrawn the
      // panel yet on the render that mounts it, and a claim of an expired request is one the
      // front can only refuse.
      if (status !== null && expiresAt !== null && Date.now() >= expiresAt) return status;
      try {
        const next = await ipc.discordLinkPoll();
        settle(next);
        return next;
      } catch (e) {
        void client.invalidateQueries({ queryKey: DISCORD_KEY });
        throw e;
      }
    },
    enabled: linking,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      // The deadline, checked on every tick as well as by the timer above: the timer redraws the
      // panel, and this is what stops the claim that would have gone out in the meantime.
      return expiresAt !== null && Date.now() >= expiresAt ? false : LINK_POLL_MS;
    },
    staleTime: 0,
    retry: false,
  });

  /** The app's one way out (`openExternal`): the system browser, never this window. */
  const open = (url: string) => {
    setOpenRefusal(null);
    openExternal(url).catch(() =>
      setOpenRefusal("Couldn't open your browser. Press Open the sign-in page to try again."),
    );
  };

  const begin = useMutation({
    mutationFn: () => ipc.discordLinkBegin(),
    onSuccess: (started) => {
      setAuthorizeUrl(started.authorizeUrl);
      // A refused claim from an earlier attempt would otherwise be the state this one's poll
      // starts from, and `refetchInterval` reads an error as *stop*.
      client.removeQueries({ queryKey: DISCORD_POLL_KEY });
      // Re-read rather than patched: the desktop stored the request, and the status it now
      // answers is the one to draw — `linking`, with this request's deadline.
      void client.invalidateQueries({ queryKey: DISCORD_KEY });
      open(started.authorizeUrl);
    },
  });
  const cancel = useMutation({
    mutationFn: () => ipc.discordLinkCancel(),
    onSuccess: (next) => {
      setAuthorizeUrl(null);
      settle(next);
    },
  });
  /**
   * Both of these change who is in the sync group, so the Sync panel's roster and status are
   * re-read with them (`SYNC_KEY` is `PAIRING_KEY`'s root). A refusal re-reads this panel's own
   * status too: an enable that failed part-way may have left a step behind it.
   */
  const enable = useMutation({
    mutationFn: () => ipc.discordEnable(),
    onSuccess: (next) => settle(next),
    onError: () => void client.invalidateQueries({ queryKey: DISCORD_KEY }),
    onSettled: () => void client.invalidateQueries({ queryKey: SYNC_KEY }),
  });
  const disable = useMutation({
    mutationFn: () => ipc.discordDisable(),
    onSuccess: (next) => {
      setAuthorizeUrl(null);
      settle(next);
    },
    onError: () => void client.invalidateQueries({ queryKey: DISCORD_KEY }),
    onSettled: () => void client.invalidateQueries({ queryKey: SYNC_KEY }),
  });
  const writes = [begin, cancel, enable, disable] as const;
  const busy = writes.some((w) => w.isPending);

  const ask = (what: "enable" | "disable") => {
    setShown(what);
    setAsking(what);
  };
  const on = status !== null && (status.linked || linking);
  const toggle = () => {
    if (status === null) return;
    if (status.linked) ask("disable");
    else if (linking) cancel.mutate();
    else begin.mutate();
  };

  /**
   * The panel's one line of bad news. A refused claim first, because it is the newest thing to
   * have gone wrong while a sign-in is on screen; then the browser that would not open; then the
   * newest write's refusal (`@/lib/writes`); then a status that never loaded.
   */
  const problem =
    (status?.linking && poll.isError ? ipcError(poll.error) : null) ??
    (linking ? openRefusal : null) ??
    writeFailure(writes) ??
    (status === null && read.isError ? ipcError(read.error) : null);

  return (
    <SettingsSection id="discord" title="Discord">
      <p className="text-sm text-dim">
        Look up cards in your collection, your wishlist and your decks from Discord, and add cards
        to your collection and wishlist, with slash commands that work in any server or chat — no
        bot to invite. The commands are answered by a device that joins your sync group, so this is
        a supporter feature, like sync.
      </p>

      {status === null ? (
        !read.isError && <p className="text-sm text-dim">Loading…</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <p id={`${id}-switch`} className="min-w-0 flex-1 text-sm">
              Enable Discord integration
            </p>
            {/* Named by the line beside it *and* by its own word — `BackupPanel`'s switch, and
                its WCAG 2.5.3 reason: an `aria-label` would replace the visible "On". */}
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby={`${id}-switch ${id}-switch-state`}
              disabled={busy}
              onClick={toggle}
              className={cn(SWITCH, switchTone(on))}
            >
              <span id={`${id}-switch-state`}>{on ? "On" : "Off"}</span>
            </button>
          </div>

          {linking && (
            <div className="space-y-3">
              <p role="status" className="text-sm">
                Waiting for Discord… Approve MTG Grimoire in your browser, then come back here.
              </p>
              <div className="flex flex-wrap gap-2">
                {authorizeUrl !== null && (
                  <button
                    type="button"
                    onClick={() => open(authorizeUrl)}
                    className={cn(PANEL_BUTTON, "border-border hover:bg-bg")}
                  >
                    <ExternalLink className="size-4" aria-hidden="true" />
                    Open the sign-in page
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => cancel.mutate()}
                  disabled={busy}
                  className={cn(
                    PANEL_BUTTON,
                    "border-border hover:bg-bg disabled:hover:bg-transparent",
                  )}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Plain rather than red: a sign-in left for ten minutes is not a fault, and the switch
              right above is how to start another. */}
          {!status.linked && expired && (
            <p className="text-sm text-dim">
              The sign-in expired before Discord answered. Turn the integration on to try again.
            </p>
          )}

          {status.linked && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm">
                Signed in as{" "}
                <span className="font-medium">
                  {status.username ?? status.discordUserId ?? "your Discord account"}
                </span>
              </p>

              {status.enrolled ? (
                <Enrolled status={status} />
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-dim">
                    One step left: the bot joins your sync group, and the commands answer from its
                    copy. It can add cards when you confirm in Discord, and can never change or
                    remove anything.
                  </p>
                  {/* The gate's sentence, as the engine wrote it — the reason the next step is
                      not open yet. Plain rather than red: it is a fact about the group, not
                      something that went wrong. */}
                  {status.gate !== null && <p className="text-sm">{status.gate}</p>}
                  <button
                    type="button"
                    onClick={() => ask("enable")}
                    disabled={busy || status.gate !== null}
                    aria-busy={enable.isPending || undefined}
                    className={cn(
                      PANEL_BUTTON,
                      "border-accent text-accent hover:bg-bg disabled:hover:bg-transparent",
                    )}
                  >
                    {enable.isPending ? "Adding the bot…" : "Add the bot to your sync group"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <PanelAlert tone="problem">{problem}</PanelAlert>

      <ConfirmDialog
        open={asking !== null}
        title={
          shown === "enable" ? "Add the bot to your sync group" : "Turn off Discord integration"
        }
        confirmLabel={shown === "enable" ? "Add the bot" : "Turn off"}
        typeToConfirm={false}
        pending={shown === "enable" ? enable.isPending : disable.isPending}
        onConfirm={() => (shown === "enable" ? enable.mutate() : disable.mutate())}
        onDismiss={() => setAsking(null)}
        onClose={() => setAsking(null)}
      >
        {shown === "enable" ? (
          <>
            The MTG Grimoire bot becomes a device in your sync group. It can read everything that
            syncs, and it can add cards to your collection and your wishlist, but only after you
            press Confirm in Discord. It can never change or remove anything. Cards it adds to your
            collection go to <span className="font-medium">{ADDED_FROM_DISCORD}</span> unless you
            name another folder; that folder is made now if you don&rsquo;t have one. Because the
            bot reads your cards, the MTG Grimoire Discord service&rsquo;s servers hold a copy of
            your collection, wishlist and decks that they can decrypt — unlike the sync relay, which
            stores only what it cannot read. The bot takes one of your group&rsquo;s five device
            slots. You can remove it at any time by turning the integration off.
          </>
        ) : (
          <>
            {status?.enrolled === true &&
              "This removes the bot from your sync group and deletes its copy of your " +
                "collection, wishlist and decks. Cards it already added stay. "}
            The slash commands stop answering for you. To remove MTG Grimoire from your Discord
            account as well, open Discord&rsquo;s User Settings, then Authorized Apps, and remove it
            there.
          </>
        )}
      </ConfirmDialog>
    </SettingsSection>
  );
}

/** The bot as a device in the group: its id, when it last fetched, what it answers, and what an
 *  add asks of the reader. */
function Enrolled({ status }: { status: DiscordStatus }): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm">
          The bot is in your sync group
          {status.botDeviceId !== null && (
            <>
              {" "}
              as <code className="font-mono text-xs text-dim">{status.botDeviceId}</code>
            </>
          )}
          .
        </p>
        <p className="text-sm text-dim">{lastPullLine(status)}</p>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Commands</h3>
        <ul className="space-y-2">
          {DISCORD_COMMANDS.map(({ command, does }) => (
            <li key={command} className="text-sm">
              <code className="font-mono text-xs text-text">{command}</code>
              <span className="block text-dim">{does}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-dim">
          An add waits for you to press Confirm in Discord. The bot can never change or remove
          anything.
        </p>
      </div>
    </div>
  );
}
