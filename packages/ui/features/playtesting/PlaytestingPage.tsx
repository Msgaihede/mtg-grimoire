import type { JSX } from "react";
import { WorkInProgress } from "@/components/WorkInProgress";

/**
 * The Playtesting view, which is a rail entry and a sentence and nothing else yet.
 *
 * A file of its own for {@link import("@/features/trade/TradePage").TradePage}'s reason: the
 * router branch names a page, so the day this becomes one the diff is here and nowhere else.
 */
export function PlaytestingPage(): JSX.Element {
  return <WorkInProgress view="Playtesting" />;
}
