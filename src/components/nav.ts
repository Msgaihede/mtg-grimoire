import {
  Camera,
  Handshake,
  Heart,
  House,
  Receipt,
  Search,
  Settings,
  Swords,
  Tags,
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
 * The eleven destinations, in the order the column draws them — and the order is the point.
 *
 * Home first, then two ways into the database, then the three lists the reader owns, then the
 * three things a reader *does* with them, then Settings. **Home is at the top because it is where
 * the app opens** and a reader reads a column downward: a landing page anywhere but the first row
 * would be a page the reader is on and cannot find. Search asks "which card is this"; Tagger asks
 * "what is this card of", which is why it sits directly under Search rather than among the lists.
 * Below the pair the run is by how often a reader is in it: Decks is where the app is used,
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
 * so there is one word per view rather than two that can drift. "Tagger" is Scryfall's own name
 * for the taxonomy that view browses, and the page's own heading below it still says what it
 * does in a sentence.
 *
 * **This is a module rather than a const inside `AppShell` because the rail is no longer the
 * only thing that draws it.** A bottom tab bar copying a column of labels out of the rail is
 * exactly the drift the paragraph above forbids. What deliberately did *not* move is the **row**: a rail
 * entry is a full-width button with a left-anchored icon and a tooltip when narrow, and a tab is
 * a square with its word under the glyph — two drawings, not one component with a flag.
 */
export const NAV: readonly NavEntry[] = [
  // The page the app opens on, and therefore the row a reader looks for first — `store.ts`'s
  // `activeView` starts here and `useStartView` is what may move it. **Its arrival renumbered the
  // whole run of chords**: it takes `Ctrl+1`, everything below shifts one digit, and Settings is
  // pushed off the end of nine. `lib/shortcuts.ts`'s `switchView` is where that is argued and
  // `docs/reference/keyboard-shortcuts.md` carries the record.
  { id: "home", label: "Home", Icon: House },
  { id: "search", label: "Search", Icon: Search },
  { id: "tags", label: "Tagger", Icon: Tags },
  { id: "decks", label: "Decks", Icon: Cards },
  { id: "collection", label: "Collection", Icon: CabinetFiling },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  // Somebody else's binder, opened from a link — a fourth list of cards, and the reason it wears
  // a handshake rather than a share glyph is that the reader is here to *trade*, not to publish.
  // Publishing is the Collection's own control.
  //
  // ⚠️ **One of the two destinations with no chord, and the one whose reason is its own.**
  // Eleven entries against `Ctrl+1…9` is two too many (`Ctrl+0` is not a tenth step of that run —
  // see `lib/shortcuts.ts`), and this is the row that is not always drawn: a chord's whole value
  // is that it does not move, so binding a digit to a row that appears and disappears is what
  // would make one press mean two things to two readers. Settings is the other, and it goes
  // without for an unrelated reason — the run simply ends before it. The reason this entry *had*
  // `Ctrl+6` was that nothing else reached the view, and that is retired —
  // `features/collection/ShareFolderMenu.tsx` draws **Open a shared collection** beside the Share
  // control, which is a signpost where a chord was only a key.
  // `docs/reference/keyboard-shortcuts.md` carries the whole record.
  { id: "shared", label: "Shared", Icon: Handshake },
  // Before Settings so Settings stays the last row. **`Camera` and not `ScanLine`** (main,
  // 985b872e): that glyph drew a barcode scanner, and this view is a camera pointed at a card.
  { id: "scanner", label: "Scanner", Icon: Camera },
  // **Two destinations that are a rail entry and a sentence, and nothing else yet.** They are in
  // the column ahead of their pages on purpose: the rail is where a reader finds out what this app
  // intends to be, and `WorkInProgress` says so in one line rather than leaving a row that looks
  // finished and does nothing. They sit here for Scanner's reason — Settings stays the last row —
  // so the chords after them moved again, and moved a second time when Home arrived at the head:
  // Playtesting reads `Ctrl+9` now, and the keyboard doc has the whole record of why an insertion
  // anywhere but the end renumbers.
  { id: "trade", label: "Trade", Icon: Receipt },
  { id: "playtesting", label: "Playtesting", Icon: Swords },
  // ⚠️ **The second destination with no chord, and `Ctrl+9` no longer opens it.** The run is nine
  // digits long against eleven rows, and the two that go without go without for two different
  // reasons: Shared's row is conditional, and this one is simply past the end. Losing the digit is
  // what buys Home the top of the column, which is where a reader looks for the page they are
  // landed on. It costs this view its chord and nothing else — unlike Shared, whose row can be
  // absent, this one is drawn on every screen at a fixed place, so it was always one press away
  // and still is.
  { id: "settings", label: "Settings", Icon: Settings },
];
