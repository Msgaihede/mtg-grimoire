import { Handshake, Heart, ScanLine, Search, Settings, Tags, type LucideIcon } from "lucide-react";
import { CabinetFiling, Cards } from "@/components/icons";
import type { ViewId } from "@/lib/store";

/** One destination: the view it opens, the word for it, and the glyph that stands beside it. */
export interface NavEntry {
  id: ViewId;
  label: string;
  Icon: LucideIcon;
}

/**
 * The eight destinations, in the order the column draws them — and the order is the point.
 *
 * Two ways into the database first, then the three lists the reader owns, then Settings. Search
 * asks "which card is this"; Tagger asks "what is this card of", which is why it sits directly
 * under Search rather than among the lists. Below the pair the run is by how often a reader is
 * in it: Decks is where the app is used, Collection is what backs a deck, Wishlist is what is
 * not owned yet. Settings is last because it is not a destination in the same sense.
 *
 * **`shared` is a list of cards too, which is why it is filed with them rather than beside
 * Scanner** — and it is the one the reader does not own, which is why it is last of the four.
 *
 * **This module is still the whole set, and `AppShell` is what hides a row.** Shared appears only
 * once a reader has opened a link (spec decision 6), and the filter lives at the shell rather
 * than here so that this stays a plain list — one that `nav.test.ts` can go on asserting
 * literally, and that `switchView`'s chords can go on binding against by index.
 *
 * **The label is also the ribbon's `<h1>`** — `Shell` looks the active view's title up in here,
 * so there is one word per view rather than two that can drift. "Tagger" is Scryfall's own name
 * for the taxonomy that view browses, and the page's own heading below it still says what it
 * does in a sentence.
 *
 * **This is a module rather than a const inside `AppShell` because the rail is no longer the
 * only thing that draws it.** A bottom tab bar copying seven labels out of the rail is exactly
 * the drift the paragraph above forbids. What deliberately did *not* move is the **row**: a rail
 * entry is a full-width button with a left-anchored icon and a tooltip when narrow, and a tab is
 * a square with its word under the glyph — two drawings, not one component with a flag.
 */
export const NAV: readonly NavEntry[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "tags", label: "Tagger", Icon: Tags },
  { id: "decks", label: "Decks", Icon: Cards },
  { id: "collection", label: "Collection", Icon: CabinetFiling },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  // Somebody else's binder, opened from a link — a fourth list of cards, and the reason it wears
  // a handshake rather than a share glyph is that the reader is here to *trade*, not to publish.
  // Publishing is the Collection's own control. The chord that moved is `Ctrl+6`; Scanner is
  // `Ctrl+7` and Settings `Ctrl+8`, and `docs/reference/keyboard-shortcuts.md` says so.
  { id: "shared", label: "Shared", Icon: Handshake },
  // Before Settings so Settings stays the last row.
  { id: "scanner", label: "Scanner", Icon: ScanLine },
  { id: "settings", label: "Settings", Icon: Settings },
];
