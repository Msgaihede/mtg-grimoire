import type { Fault } from "../../packages/fake/db";
import { setArtMode } from "../../packages/fake/images";
import type { SeedName } from "../../packages/fake/seeds";
import { installWorld } from "../../packages/fake/world";

/**
 * Stands the Storybook fake's `starter` world up behind the light app — `npm run mobile:dev`.
 *
 * Called once, before React, because the fake answers from whichever world was installed last
 * and a query that fires against an empty dispatch table gets "No fake handler registered".
 * One world for the life of the page: there is no second story to keep it apart from.
 *
 * `?art=live` draws real Scryfall pictures instead of the synthetic frames, for a look that is
 * closer to the shipped app when there is a network to ask.
 *
 * **`?seed=` and `?fault=` are a story's `parameters.fake`, spelled in the address** — so a state
 * a story reaches through its seed (`paired`: this device in a group) or its fault (`busy`,
 * `patreonLapsed`) can be stood behind the whole light app at a phone's width, which is the one
 * thing a story at the Settings column's width cannot show. Read once, here: the world is
 * installed before React and stays for the life of the page, whatever the address becomes. A
 * seed the fake does not know is the `starter` world, which is what a page with no query gets.
 */
export function bootFake(): void {
  const query = new URLSearchParams(window.location.search);
  const world = installWorld({
    seed: (query.get("seed") ?? "starter") as SeedName,
    fault: query.get("fault") as Fault | null,
  });
  world.mount();
  if (query.get("art") === "live") setArtMode("live");
}
