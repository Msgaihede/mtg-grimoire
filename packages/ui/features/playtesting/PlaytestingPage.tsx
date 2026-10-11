import type { JSX } from "react";
import { WorkInProgress } from "@/components/WorkInProgress";

/**
 * The Playtesting view, which is a rail entry and a sentence and nothing else yet.
 *
 * A file of its own so the router branch names a page: the day this becomes one the diff is here
 * and nowhere else. {@link import("@/features/trade/TradePage").TradePage} was the other
 * placeholder and is the proof — it grew a page, and `App.tsx`'s branch did not change.
 */
export function PlaytestingPage(): JSX.Element {
  return <WorkInProgress view="Playtesting" />;
}
