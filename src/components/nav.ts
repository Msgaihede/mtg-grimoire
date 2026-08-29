import { Heart, Search, Settings, Tags, type LucideIcon } from "lucide-react";
import { CabinetFiling, Cards } from "@/components/icons";
import type { ViewId } from "@/lib/store";

/** One destination: the view it opens, the word for it, and the glyph that stands beside it. */
export interface NavEntry {
  id: ViewId;
  label: string;
  Icon: LucideIcon;
}

/**
 * The six destinations, in the order the column draws them — and the order is the point.
 *
 * Two ways into the database first, then the three lists the reader owns, then Settings. Search
 * asks "which card is this"; Tagger asks "what is this card of", which is why it sits directly
 * under Search rather than among the lists. Below the pair the run is by how often a reader is
 * in it: Decks is where the app is used, Collection is what backs a deck, Wishlist is what is
 * not owned yet. Settings is last because it is not a destination in the same sense.
 *
 * **The label is also the ribbon's `<h1>`** — `Shell` looks the active view's title up in here,
 * so there is one word per view rather than two that can drift. "Tagger" is Scryfall's own name
 * for the taxonomy that view browses, and the page's own heading below it still says what it
 * does in a sentence.
 *
 * **This is a module rather than a const inside `AppShell` because the rail is no longer the
 * only thing that draws it.** A bottom tab bar copying six labels out of the rail is exactly the
 * drift the paragraph above forbids. What deliberately did *not* move is the **row**: a rail
 * entry is a full-width button with a left-anchored icon and a tooltip when narrow, and a tab is
 * a square with its word under the glyph — two drawings, not one component with a flag.
 */
export const NAV: readonly NavEntry[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "tags", label: "Tagger", Icon: Tags },
  { id: "decks", label: "Decks", Icon: Cards },
  { id: "collection", label: "Collection", Icon: CabinetFiling },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "settings", label: "Settings", Icon: Settings },
];
