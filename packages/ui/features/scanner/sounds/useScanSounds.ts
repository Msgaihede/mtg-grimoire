import { useEffect, useEffectEvent, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ScannerTrayRow } from "@/lib/ipc";
import { resolveMarketplace, type MarketplaceId } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import type { LandedCard } from "../reader/AddedToast";
import { landedPrice, landedPriceIds, trayRowPrice } from "../reader/trayPrice";
import { trayPricesQuery } from "../reader/useTrayPrices";
import { playScanSound, preloadScanSounds } from "./player";
import { landingNeedsInput, settledRows, soundForPrice, type ScanSound } from "./scanSounds";
import { useScanSoundSettings } from "./useScanSoundSettings";

/**
 * **The scanner's sounds, played** — once for every card that lands in the tray, and once for
 * every row the reader settles there. Both faces' Scanner pages call it, beside `useTrayLanding`.
 *
 * - **A landing** (`landed`, a new `stamp` each time — a new row, a second copy, a second
 *   opinion, a card added by hand) plays `needs-input` while it asks the reader something, and
 *   otherwise its price's sound (`soundForPrice`).
 * - **A settle** (`settledRows` over `rows`: a printing picked, a finish named) plays the price's
 *   sound for the card the reader chose — the jingle the card would have had if the camera had
 *   known. Never on the first render, `useHeadLanded`'s rule: a tray opened on cards it held
 *   settled nothing.
 *
 * **The price is the tray's own read** (`trayPricesQuery`), at the marketplace the tray quotes
 * (`at`: a trade's while filing onto one) — the figure over the camera and the figure the jingle
 * is judged by are one figure. A read that fails is unpriced, which is the plain sound. **Only the
 * newest event plays**: a read that answers after a later card has landed is dropped, so a slow
 * price never sounds over the card after it.
 */
export function useScanSounds({
  landed,
  rows,
  at,
}: {
  landed: LandedCard | null;
  rows: readonly ScannerTrayRow[];
  at?: MarketplaceId;
}): void {
  const { sounds } = useScanSoundSettings();
  const { marketplace: own } = useMarketplace();
  const marketplace = at === undefined ? own : resolveMarketplace(at);
  const queryClient = useQueryClient();
  const latest = useRef(0);

  const enabled = sounds.enabled;
  useEffect(() => {
    if (enabled) preloadScanSounds();
  }, [enabled]);

  /**
   * Play `sound` — or, for a function, the sound its price read decides, if nothing newer has
   * happened by the time it answers.
   */
  const play = useEffectEvent((sound: ScanSound | (() => Promise<ScanSound>)) => {
    if (!sounds.enabled) return;
    const seq = ++latest.current;
    if (typeof sound === "string") {
      playScanSound(sound);
      return;
    }
    void sound().then((decided) => {
      if (seq === latest.current) playScanSound(decided);
    });
  });

  /** The prices of `ids` at the tray's marketplace — `null` for a read that would not answer. */
  const priced = (ids: string[]) =>
    queryClient
      .fetchQuery(trayPricesQuery(marketplace.id, ids))
      .then((answered) => answered.prices)
      .catch(() => null);

  const onLanded = useEffectEvent((card: LandedCard) => {
    if (landingNeedsInput(card)) {
      play("needs-input");
      return;
    }
    play(async () => {
      const prices = await priced(landedPriceIds(card));
      const span = prices === null ? null : landedPrice(card, prices);
      return soundForPrice(span?.high ?? null, sounds);
    });
  });

  const onSettled = useEffectEvent((settled: ScannerTrayRow[]) => {
    play(async () => {
      const prices = await priced([...new Set(settled.map((row) => row.cardId))].sort());
      // Two rows settled by one write is one press, and it plays the dearer card's sound.
      let dearest: number | null = null;
      for (const row of settled) {
        const price = prices === null ? null : trayRowPrice(row, prices);
        if (price !== null && (dearest === null || price > dearest)) dearest = price;
      }
      return soundForPrice(dearest, sounds);
    });
  });

  // A new object on every landing and `null` between them, so the effect runs once a landing.
  useEffect(() => {
    if (landed !== null) onLanded(landed);
  }, [landed]);

  const drawn = useRef(rows);
  useEffect(() => {
    const before = drawn.current;
    drawn.current = rows;
    const settled = settledRows(before, rows);
    if (settled.length > 0) onSettled(settled);
  }, [rows]);
}
