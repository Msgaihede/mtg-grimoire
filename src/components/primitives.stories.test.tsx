import { composeStories } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";
import * as manaLine from "./ManaLine.stories";
import * as manaText from "./ManaText.stories";
import * as ownedBadge from "./OwnedBadge.stories";
import * as rarityGem from "./RarityGem.stories";

/**
 * The `play` functions of the primitive stories, run under Vitest.
 *
 * A `play` is the right place for a story's claim: it travels with the story, and a reader who
 * opens Storybook sees it pass or fail in the Interactions panel beside the thing it is about.
 * But nothing in this repository's checks runs one — `npm run build-storybook` compiles
 * stories, it does not play them. So the stories whose entire subject is a fact nobody can
 * *see* (a component that renders `null`, an ARIA attribute that must be absent) would be
 * asserted only by a browser `npm run verify` never opens.
 *
 * `composeStories` closes that: it applies each story's args and returns something renderable,
 * and `.run()` renders it and awaits its `play`. Deliberately **without**
 * `setProjectAnnotations`, so the preview's `FakeWorld` decorator and its three CSS imports
 * stay out of jsdom — every story named here is props-only and asks the fake backend nothing.
 * A story that needs the fake world does not belong in this file.
 *
 * This is not a second copy of the component tests beside it. `ManaText.test.tsx` and friends
 * cover the components; this covers the *stories*, and it fails for the two reasons a story
 * fails on its own — args that stopped type-checking against the component, and a play whose
 * claim about the rendered DOM stopped being true.
 */
interface Played {
  run: () => Promise<void>;
}

/**
 * The stories in one composed module that carry a `play`.
 *
 * Narrowed through `Record<string, unknown>` rather than `composeStories`' own return type,
 * because the four modules have four different types and a loop over them widens to a union
 * `composeStories` will not accept.
 */
function playsIn(stories: Record<string, unknown>): [string, Played][] {
  return Object.entries(stories).filter((entry): entry is [string, Played] => {
    const story = entry[1] as { play?: unknown };
    return typeof story?.play === "function";
  });
}

/** The expected count is the point of the `expected` field: a loop over stories is silent when
 *  it finds none, which is the one way this file could pass while running nothing at all. */
const SUITES = [
  { component: "ManaText", plays: playsIn(composeStories(manaText)), expected: 2 },
  { component: "ManaLine", plays: playsIn(composeStories(manaLine)), expected: 1 },
  { component: "RarityGem", plays: playsIn(composeStories(rarityGem)), expected: 1 },
  { component: "OwnedBadge", plays: playsIn(composeStories(ownedBadge)), expected: 1 },
];

for (const { component, plays, expected } of SUITES) {
  describe(`${component} stories`, () => {
    it("still has the plays that carry its invisible claims", () => {
      expect(plays.map(([name]) => name)).toHaveLength(expected);
    });

    for (const [name, story] of plays) {
      it(`${name} plays`, async () => {
        await story.run();
      });
    }
  });
}
