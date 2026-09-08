import type { JSX } from "react";
import { WorkInProgress } from "@/components/WorkInProgress";

/**
 * The Trade view, which is a rail entry and a sentence and nothing else yet.
 *
 * **A file of its own rather than a `<WorkInProgress>` written inline in `App.tsx`**, so the view
 * is wired the way every other one is — `if (activeView === "trade") return <TradePage />` — and
 * the day it grows a page the diff is this file and no other. A router branch that names a shared
 * placeholder directly would have to be rewritten to name a page instead, which is an edit to the
 * one module every view shares.
 */
export function TradePage(): JSX.Element {
  return <WorkInProgress view="Trade" />;
}
