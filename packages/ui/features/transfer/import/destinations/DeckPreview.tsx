/**
 * The deck as a destination **on the desktop** — the store-free step in `./DeckPreviewBody`, with
 * `useAppStore`'s `importDefaults` handed in for the "I own these" box.
 *
 * The body and everything it exports moved out so the light app's phone face could draw the same
 * step over a store of its own (`apps/light/phone/fence.test.ts` keeps the app store off that face);
 * this file kept the names every desktop caller and test imports, re-exporting the rest, so none
 * of them changed.
 */
import type { JSX } from "react";
import { useAppStore } from "@/lib/store";
import type { DestinationPreviewProps } from "../destination";
import { DeckPreviewBody, type DeckImportInto } from "./DeckPreviewBody";

export * from "./DeckPreviewBody";

export function DeckPreview(props: DestinationPreviewProps & DeckImportInto): JSX.Element {
  const importDefaults = useAppStore((s) => s.importDefaults);
  return <DeckPreviewBody {...props} importDefaults={importDefaults} />;
}
