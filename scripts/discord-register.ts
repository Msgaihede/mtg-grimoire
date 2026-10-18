// The Discord bot's slash commands, put on the application — `pnpm discord:register`.
//
//   DISCORD_APPLICATION_ID=… DISCORD_CLIENT_SECRET=… pnpm discord:register
//
// **One `PUT` of the whole list** (`infrastructure/discord-worker/src/commands.ts`) to the
// application's *global* commands, which replaces whatever was registered before: a command
// that is not in the list is deleted, so this is also how one is taken away. Global commands
// reach every reader who has installed the app, in every context the list allows — a
// user-installed app has no server to register to.
//
// **The token is the application's own**, a client-credentials grant asked for with the
// application id and its client secret and scoped to `applications.commands.update` — no bot
// token exists for this app and none is needed. Both values come from the environment and
// nowhere else; without both it refuses before any request. **Neither the secret nor the token
// is ever printed**: what is said is which commands Discord now holds, by name.
//
// It is the owner's to run, once after the application is created and again whenever
// `commands.ts` changes (`infrastructure/discord-worker/README.md`, *Deploying*). No workflow
// runs it, and no agent runs it for real: it changes what every reader sees in Discord.
import { pathToFileURL } from "node:url";
import { COMMANDS } from "../infrastructure/discord-worker/src/commands.ts";

export const DISCORD_API = "https://discord.com/api/v10";
/** Discord asks every client of its HTTP API for a `User-Agent` of this shape. */
export const USER_AGENT = "DiscordBot (https://github.com/Msgaihede/mtg-grimoire, 1.0)";
/** The one scope that lets a client-credentials token write the application's commands. */
export const SCOPE = "applications.commands.update";

/** What the environment must hold, in the order the refusal names them. */
export const REQUIRED = ["DISCORD_APPLICATION_ID", "DISCORD_CLIENT_SECRET"] as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Why this cannot run, as a sentence — or `null` when it can. Never says a value. */
export function refusal(env: Record<string, string | undefined>): string | null {
  const missing = REQUIRED.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    return `Set ${missing.join(" and ")} in the environment first: the application's id and its OAuth2 client secret, from the Discord developer portal. Nothing was sent.`;
  }
  if (!/^\d{17,20}$/.test(env.DISCORD_APPLICATION_ID!.trim())) {
    return "DISCORD_APPLICATION_ID is not an application id (a number of 17 to 20 digits). Nothing was sent.";
  }
  return null;
}

/**
 * Registers {@link COMMANDS}: a token, then the `PUT`. Answers the names Discord now holds, or
 * throws a sentence that says which step failed and Discord's status — never a credential.
 */
export async function register(
  env: Record<string, string | undefined>,
  fetcher: Fetch = fetch,
): Promise<string[]> {
  const refused = refusal(env);
  if (refused !== null) throw new Error(refused);
  const id = env.DISCORD_APPLICATION_ID!.trim();
  const secret = env.DISCORD_CLIENT_SECRET!.trim();

  const granted = await fetcher(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }).toString(),
  });
  if (!granted.ok) {
    throw new Error(
      `Discord refused the client credentials (${granted.status}): check the application id and the client secret.`,
    );
  }
  const token = ((await granted.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token === "") {
    throw new Error("Discord answered the client credentials with no token.");
  }

  const put = await fetcher(`${DISCORD_API}/applications/${id}/commands`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(COMMANDS),
  });
  if (!put.ok) {
    // Discord's own sentence about the list is about the list, never about a credential.
    const detail = (await put.text()).slice(0, 2000);
    throw new Error(`Discord refused the commands (${put.status}): ${detail}`);
  }
  const held = (await put.json()) as { name?: unknown }[];
  return held.map((command) => String(command.name));
}

async function main() {
  try {
    const names = await register(process.env);
    console.log(
      `Discord now holds ${names.length} global commands: ${names.map((n) => `/${n}`).join(", ")}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
