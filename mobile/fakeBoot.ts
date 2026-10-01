import { setArtMode } from "../.storybook/fake/images";
import { installWorld } from "../.storybook/fake/world";

/**
 * Stands the Storybook fake's `starter` world up behind the light app — `npm run mobile:dev`.
 *
 * Called once, before React, because the fake answers from whichever world was installed last
 * and a query that fires against an empty dispatch table gets "No fake handler registered".
 * One world for the life of the page: there is no second story to keep it apart from.
 *
 * `?art=live` draws real Scryfall pictures instead of the synthetic frames, for a look that is
 * closer to the shipped app when there is a network to ask.
 */
export function bootFake(): void {
  const world = installWorld({ seed: "starter" });
  world.mount();
  if (new URLSearchParams(window.location.search).get("art") === "live") setArtMode("live");
}
