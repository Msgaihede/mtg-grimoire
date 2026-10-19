/**
 * **The one request this object makes to Discord**: writing the add's proposal into the reply it
 * deferred (`add.ts`) — `PATCH /webhooks/{application}/{token}/messages/@original`, Discord's
 * *Edit Original Interaction Response*.
 *
 * The interaction token is the credential: Discord put it in the body it signed, it is good for
 * fifteen minutes and for this one interaction's messages, and nothing else is needed (no bot
 * token exists for this app). The application id is the signed body's too. Neither is stored.
 */

export const DISCORD_API = "https://discord.com/api/v10";

/** Discord asks every client of its HTTP API for a `User-Agent` of this shape. */
export const DISCORD_USER_AGENT = "DiscordBot (https://github.com/Msgaihede/mtg-grimoire, 1.0)";

const SNOWFLAKE = /^\d{17,20}$/;
/** An interaction token: long, and URL-safe. Anything else is not put in a path. */
const TOKEN = /^[A-Za-z0-9._-]{1,500}$/;

/** Whether `applicationId` and `token` can name a webhook. */
export function webhookable(applicationId: unknown, token: unknown): boolean {
  return (
    typeof applicationId === "string" &&
    SNOWFLAKE.test(applicationId) &&
    typeof token === "string" &&
    TOKEN.test(token)
  );
}

/**
 * Replace the deferred reply's content with `data` (`content`, `components`). One attempt, and a
 * second after a 429 or a failure to connect; `false` when neither landed. There is nobody to tell
 * then — the reader sees Discord's own *The application did not respond* — and nothing to undo:
 * the proposal waits out its fifteen minutes unseen.
 */
export async function editOriginal(
  fetcher: typeof fetch,
  api: string,
  applicationId: string,
  token: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!webhookable(applicationId, token)) return false;
  const url = `${api.replace(/\/+$/, "")}/webhooks/${applicationId}/${token}/messages/@original`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const answer = await fetcher(url, {
        method: "PATCH",
        headers: { "content-type": "application/json", "user-agent": DISCORD_USER_AGENT },
        body: JSON.stringify({ ...data, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000),
      });
      if (answer.ok) return true;
      if (answer.status !== 429) return false;
      // Discord's own wait, in seconds, held to two.
      const wait = Math.min(2, Number(answer.headers.get("retry-after")) || 0.5);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    } catch {
      // A second try, below.
    }
  }
  return false;
}
