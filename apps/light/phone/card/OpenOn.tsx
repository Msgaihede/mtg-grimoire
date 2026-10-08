import { skipToken, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { cardTcgplayerIdsKey } from "@/features/card/cardKeys";
import { marketplaceUrlForCard } from "@/features/card/openMarketplace";
import { edhrecCardUrl, scryfallCardUrl } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { ipc, type CardDetail } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { PRESS_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SheetSection } from "./parts";

/**
 * A way out's box — the desktop rail entry's shape (`CardModalRail`'s `RAIL_ENTRY`: 44px, the
 * column's full width, the word at the left and the mark at the far end), which is also this
 * sheet's own press, `ShowMore`. Spelled here because the rail's file reaches the desktop store.
 */
const ROW = cn(
  "flex h-11 w-full items-center gap-2 rounded-md border border-border px-4 text-sm text-text",
  "active:bg-surface",
  PRESS_SOFT,
  FOCUS,
);

/**
 * **Open on** — the card somewhere that is not this app: Scryfall, EDHREC, and the one
 * marketplace Settings quotes prices from. The desktop's ladder in the desktop's order
 * (`CardModalRail`'s last three rows, `cardMenu`'s `Open on →`), and not alphabetical for that
 * ladder's reason: the first two hold still on every card, and the row whose name follows a
 * setting goes last so they never move.
 *
 * **Real links, where the desktop's are presses.** A reader leaves a phone page by a link — one
 * they can long-press, copy, or open beside the app — and on the two hosts this face ships on a
 * link needs nothing from the app to open: a browser opens a new tab, and the Android host's
 * navigation guard hands any address that is not the app's to the system browser
 * (`apps/light/src-tauri/src/navigation.rs`). So nothing here calls the opener, and `rel` cuts the
 * way back as `noteBody`'s links do. **`mobile:tauri` is the exception, and it is a development
 * window**: that is the desktop binary, which has no such guard, and there a `_blank` link opens
 * a bare WebView2 window of its own rather than the reader's browser — as the note links this
 * face has drawn since phase 3 do.
 *
 * **A link always names a printing** (`docs/reference/external-links.md`), and the addresses are
 * the desktop's own, built by the functions its rows open: Scryfall's permalink for this printing,
 * EDHREC's router by name, and `marketplaceUrlForCard` — the exact TCGplayer product at the
 * printing's most ordinary finish, the name search for the other four. The sheet names no finish,
 * so the printing answers for itself, as it does for a card opened from the desktop's search wall.
 *
 * **One read the desktop does not make until the press**: the printing's two product ids, asked
 * when the sheet opens and only while the marketplace is TCGplayer, because an `href` has to
 * exist before it is pressed. It is a read of the reader's own database and visits nobody —
 * `externalLinks`' doctrine is about the sites. Until it answers, and if it is refused, the row
 * is the name search: a link must never go nowhere.
 *
 * **Named whole.** The heading says *Open on* and each row says where; out of the section — a
 * screen reader's list of links — a bare `Scryfall` says nothing about what the press does, so
 * each link's name is the phrase, and the visible word is inside it.
 */
export function OpenOnSection({
  card,
  marketplace,
}: {
  card: CardDetail;
  /** The marketplace Settings selects — the sheet already holds it for its prices. */
  marketplace: Marketplace;
}) {
  const ids = useQuery({
    queryKey: cardTcgplayerIdsKey(card.id),
    queryFn: marketplace.id === "tcgplayer" ? () => ipc.cardTcgplayerIds(card.id) : skipToken,
    // A refusal is a link that searches by name instead; asking again changes nothing a reader
    // is waiting on.
    retry: false,
  });

  const rows = [
    { site: "Scryfall", href: scryfallCardUrl(card.setCode, card.collectorNumber) },
    { site: "EDHREC", href: edhrecCardUrl(card.name) },
    {
      site: marketplace.label,
      href: marketplaceUrlForCard({
        marketplace,
        cardName: card.name,
        ids: ids.data ?? null,
        finish: null,
        finishes: card.finishes,
      }),
    },
  ];

  return (
    <SheetSection title="Open on">
      <ul className="flex flex-col gap-1.5">
        {rows.map(({ site, href }) => (
          <li key={site}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open on ${site}`}
              className={ROW}
            >
              <span className="min-w-0 flex-1 truncate">{site}</span>
              <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-dim" />
            </a>
          </li>
        ))}
      </ul>
    </SheetSection>
  );
}
