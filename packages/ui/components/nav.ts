import {
  Camera,
  Handshake,
  Heart,
  House,
  Receipt,
  Search,
  Settings,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { CabinetFiling, Cards } from "@/components/icons";
import type { ViewId } from "@/lib/store";

/** One destination: the view it opens, the word for it, and the glyph that stands beside it. */
export interface NavEntry {
  id: ViewId;
  label: string;
  Icon: LucideIcon;
}

/**
 * The ten destinations, in the order the column draws them — and the order is the point.
 *
 * Home first, then the way into the database, then the three lists the reader owns, then the
 * three things a reader *does* with them, then Settings. **Home is at the top because it is where
 * the app opens** and a reader reads a column downward: a landing page anywhere but the first row
 * would be a page the reader is on and cannot find. Search asks both "which card is this" and —
 * through its tag sidebar, where the Tagger page went on 2026-10-11 (issue #937) — "what is this
 * card of". Below it the run is by how often a reader is in it: Decks is where the app is used,
 * Collection is what backs a deck, Wishlist is what is not owned yet. Settings is last because it
 * is not a destination in the same sense.
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
 * so there is one word per view rather than two that can drift.
 *
 * **This is a module rather than a const inside `AppShell` because the rail is not its only
 * reader.** The keyboard map (`KeyMap`) heads each view's shortcuts with this label, and Settings'
 * opening-view picker (`StartViewPanel`) offers these destinations — each imports the list rather
 * than copying a column of labels out of the rail, which is exactly the drift the paragraph above
 * forbids. What stays in `AppShell` is the **row**: a full-width button with a left-anchored icon
 * and a tooltip while the rail is collapsed.
 */
export const NAV: readonly NavEntry[] = [
  // The page the app opens on, and therefore the row a reader looks for first — `store.ts`'s
  // `activeView` starts here and `useStartView` is what may move it. **Its arrival renumbered the
  // whole run of chords**: it takes `Ctrl+1`, everything below shifts one digit, and Settings is
  // pushed off the end of nine — until the Tagger row left (issue #937) and handed it `Ctrl+9`
  // back. `lib/shortcuts.ts`'s `switchView` is where that is argued and
  // `docs/reference/keyboard-shortcuts.md` carries the record.
  { id: "home", label: "Home", Icon: House },
  { id: "search", label: "Search", Icon: Search },
  { id: "decks", label: "Decks", Icon: Cards },
  { id: "collection", label: "Collection", Icon: CabinetFiling },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  // Somebody else's binder, opened from a link — a fourth list of cards, and the reason it wears
  // a handshake rather than a share glyph is that the reader is here to *trade*, not to publish.
  // Publishing is the Collection's own control.
  //
  // ⚠️ **The one destination with no chord, for a reason of its own.** This is the row that is
  // not always drawn: a chord's whole value is that it does not move, so binding a digit to a
  // row that appears and disappears is what would make one press mean two things to two readers
  // — and that is why the other nine rows fit `Ctrl+1…9` exactly. The reason this entry *had*
  // `Ctrl+6` was that nothing else reached the view; the collection's **Open a shared collection**
  // retired it, and was itself removed (issue #1028), so this row is the only way in.
  // `docs/reference/keyboard-shortcuts.md` carries the whole record.
  { id: "shared", label: "Shared", Icon: Handshake },
  // Before Settings so Settings stays the last row. **`Camera` and not `ScanLine`** (main,
  // 985b872e): that glyph drew a barcode scanner, and this view is a camera pointed at a card.
  { id: "scanner", label: "Scanner", Icon: Camera },
  // **Trade and Playtesting are pages now** (Playtesting since 2026-10-13: a game against phase's
  // AI). Both went into the column ahead of their pages on purpose: the rail is where a reader finds
  // out what this app intends to be, and `WorkInProgress` says so in one line rather than leaving
  // a row that looks finished and does nothing. They sit here for Scanner's reason — Settings
  // stays the last row —
  // so the chords after them moved again, moved a second time when Home arrived at the head, and
  // a third when the Tagger row left: Playtesting reads `Ctrl+8` now, and the keyboard doc has the
  // whole record of why an insertion or a removal anywhere but the end renumbers.
  { id: "trade", label: "Trade", Icon: Receipt },
  { id: "playtesting", label: "Playtesting", Icon: Swords },
  // `Ctrl+9` — Settings' chord from 2026-09-08 until Home pushed it off the end of the run, and
  // again since the Tagger row left (issue #937): ten rows, Shared without a digit, nine chords.
  { id: "settings", label: "Settings", Icon: Settings },
];
