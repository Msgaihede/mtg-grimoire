/**
 * A list as a new deck **on the desktop** — the store-free step in `./NewDeckPreviewBody`, with
 * `useAppStore`'s `importDefaults` handed in for the "I own these" box.
 *
 * `DeckPreview`'s split, one destination along: the body moved out so the light app's phone face
 * could draw the same step over a store of its own (`apps/light/phone/fence.test.ts` keeps the app
 * store off that face), and this file kept the names every desktop caller and test imports.
 */
import type { JSX } from "react";
import { useAppStore } from "@/lib/store";
import type { DestinationPreviewProps } from "../destination";
import { NewDeckPreviewBody, type NewDeckInto } from "./NewDeckPreviewBody";

export type { NewDeckInto } from "./NewDeckPreviewBody";

export function NewDeckPreview(props: DestinationPreviewProps & NewDeckInto): JSX.Element {
  const importDefaults = useAppStore((s) => s.importDefaults);
  return <NewDeckPreviewBody {...props} importDefaults={importDefaults} />;
}
