import { Check, RefreshCw } from "lucide-react";
import { useId } from "react";
import { FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import { MARKETPLACE_LIST, type Currency, type Marketplace } from "@/lib/marketplace";
import { PRESS_SOFT } from "@/lib/motion";
import { ago } from "@/lib/relativeTime";
import { nowSeconds, type FeedInfo, type FeedState, type MarketplaceState } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * One row of the picker — the app's existing "on / off / out of reach" control, laid out down
 * the page instead of along a filter row.
 *
 * The press is {@link PRESS_SOFT} — the app's recipe at 0.99 rather than the chips' 0.97,
 * because this control is the width of the panel and a full-width row that dips 3% reads as
 * the page moving. That argument, and the two reasons the property list is written out one
 * longhand at a time, now live on the constant in `lib/motion.ts`.
 *
 * `aria-disabled:` and not the attribute: a marketplace whose feed is fetching greys as the
 * reader watches and must not leave the tab order.
 */
const ROW =
  "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm " +
  `${PRESS_SOFT} ` +
  "aria-disabled:active:scale-100";

/**
 * The currency beside the name, in the app's third type role.
 *
 * The code rather than the symbol: "$" is read aloud as "dollar" and would leave a reader
 * choosing between three marketplaces that all quote in it with nothing to tell them apart,
 * where `USD` is the thing actually written on the setting.
 */
const CURRENCY_LABEL: Record<Currency, string> = { usd: "USD", eur: "EUR" };

/**
 * Why an entry is listed and not selectable, in that entry's own words.
 *
 * **It explains rather than greys.** One of the five has no feed in this build — Card trader's
 * API needs a per-user JWT and publishes no bulk download, so there is nothing to sync — and a
 * row that simply dimmed would leave a reader to guess whether the app had broken, whether they
 * had to sync, or whether the marketplace itself had stopped.
 */
function noFeedNote(marketplace: Marketplace): string {
  return (
    `No price feed yet — ${marketplace.label}'s API needs a personal access token and ` +
    `publishes no bulk price list, so there is nothing for this app to download.`
  );
}

/**
 * `2 hours ago`, `3 days ago` — the coarsest unit that is still true.
 *
 * Coarse on purpose: this line is read to answer "are these prices current", and a feed that
 * regenerates once a day cannot be usefully described to the minute. Below a minute it says
 * `just now`, because a fetch that has this moment finished is what the reader is watching.
 *
 * That argument is `lib/relativeTime`'s rule now — this was the one of the page's three
 * relative times that already floored, so the other two were moved onto it rather than the
 * other way round. **`now` here is in seconds** (`useMarketplace`'s `nowSeconds`), which is
 * what the conversion below is: `ago` takes milliseconds, like `Date.now()`, and nothing in
 * the types could tell the two apart while there were three copies of the arithmetic.
 */
export function agoText(seconds: number, now: number): string {
  return ago(seconds, now * 1000);
}

/**
 * What a feed's state says, in one sentence per state.
 *
 * Five states and five sentences rather than one sentence with a date in it, because the states
 * are not degrees of the same thing: `never` is an action the reader can take, `failed` is news
 * about prices that are still on screen, and `stale` and `fresh` differ only in whether the
 * reader should believe them. The date rides along where there is one — `fetchedAt` is `null`
 * exactly when nothing has ever been pulled.
 */
export function feedNote(feed: FeedInfo, now: number): string {
  const at = feed.status?.fetchedAt ?? null;
  const when = at === null ? null : agoText(at, now);
  switch (feed.state) {
    case "fetching":
      return "Downloading the price list…";
    case "never":
      return "No prices downloaded yet. Choosing this marketplace fetches them.";
    case "failed":
      return when === null
        ? "The last download failed, so there are no prices yet."
        : `The last download failed. Showing the prices from ${when}.`;
    case "stale":
      return `Prices from ${when}. A refresh is due.`;
    default:
      return `Prices from ${when}.`;
  }
}

/**
 * The **feed's own** build stamp, where it publishes one.
 *
 * A second date rather than a replacement for the first, because they answer two different
 * questions and either can be the surprising one: `fetchedAt` is when this app asked, and this
 * is when the marketplace last rebuilt the list. Card Kingdom publishes it; Mana Pool does not,
 * and `null` there is an absence rather than a value to invent.
 */
function builtNote(feed: FeedInfo): string | null {
  const built = feed.status?.feedBuiltAt ?? null;
  return built === null ? null : `${feed.marketplace.label} built this list ${built}.`;
}

/** The one state worth colouring, and it is the only one: a failure in the app's destructive
 *  red, everything else in the panel's `text-dim` grey — which is the app's dim *text* token
 *  rather than its muted *surface* one. `src/lib/tokens.test.ts` is what keeps the two apart. */
function feedNoteClass(state: FeedState): string {
  return state === "failed" ? "text-destructive" : "text-dim";
}

/**
 * One marketplace, offered.
 *
 * **`aria-disabled` and never the attribute.** A `disabled` button leaves the tab order, so a
 * keyboard reader walking this list would find four rows where a sighted one sees five and never
 * meet the sentence that says why the fifth is out. The row stays focusable, keeps saying whether
 * it is the chosen one, carries its reason as its accessible *description*, and ignores the press.
 *
 * The name is pinned to the label and the currency with `aria-labelledby` for that last part:
 * name-from-content would otherwise swallow the whole note into the button's name, and a
 * control called "Card Kingdom USD Prices from 2 hours ago." is one nobody can ask for by name.
 * The feed line is a *description* for the same reason the unavailable note is.
 */
function Option({
  marketplace,
  chosen,
  feed,
  now,
  onChoose,
  onRefresh,
}: {
  marketplace: Marketplace;
  chosen: boolean;
  /** This marketplace's feed, or `null` when its prices arrive with the card data (or when it
   *  has none at all). */
  feed: FeedInfo | null;
  /** Unix seconds, passed rather than read so the panel and its stories agree about the clock. */
  now: number;
  onChoose: () => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const unavailable = !marketplace.priced;
  const built = feed === null ? null : builtNote(feed);
  // Everything under the name, in reading order, so the accessible description says what the
  // eye reads rather than a subset of it.
  const describedBy = [
    unavailable ? `${id}-note` : null,
    feed ? `${id}-feed` : null,
    built ? `${id}-built` : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" ");

  return (
    <li>
      <div className="relative">
        <button
          type="button"
          aria-pressed={chosen}
          aria-disabled={unavailable || undefined}
          aria-labelledby={`${id}-name ${id}-currency`}
          aria-describedby={describedBy || undefined}
          onClick={() => {
            if (!unavailable) onChoose();
          }}
          className={cn(ROW, FILTER_FOCUS, filterChipState(chosen, unavailable))}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span id={`${id}-name`}>{marketplace.label}</span>
              {/* A currency is data, and data is Geist Mono — the same role prices, versions and
                  collector numbers already carry in this window. */}
              <span id={`${id}-currency`} className="font-mono text-xs tabular-nums">
                {CURRENCY_LABEL[marketplace.currency]}
              </span>
            </span>
            {unavailable && (
              <span id={`${id}-note`} className="mt-1 block text-xs">
                {noFeedNote(marketplace)}
              </span>
            )}
            {feed && (
              <span
                id={`${id}-feed`}
                className={cn("mt-1 block text-xs", feedNoteClass(feed.state))}
              >
                {feedNote(feed, now)}
              </span>
            )}
            {built && (
              <span id={`${id}-built`} className="block text-xs text-dim">
                {built}
              </span>
            )}
          </span>
          {/* The mark, beside the gold border and the gold text: three signals rather than
              colour alone, since "which one is on" is the only question this panel answers. */}
          {chosen && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        </button>

        {/* **A sibling of the row, not a child of it**: a button inside a button is invalid
            HTML that the parser silently unnests, and the two controls do different things —
            one changes what the window quotes, the other re-downloads a list. It is offered
            only for a feed, because only a feed has anything to fetch. Absolutely positioned so
            it does not change the row's own geometry, which every other row shares. */}
        {feed && (
          <button
            type="button"
            aria-disabled={feed.state === "fetching" || undefined}
            aria-label={`Refresh ${marketplace.label} prices`}
            onClick={() => {
              if (feed.state !== "fetching") onRefresh();
            }}
            className={cn(
              "absolute right-2 top-2 rounded-md border border-border p-1.5 text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "hover:text-text aria-disabled:opacity-50 motion-reduce:transition-none",
              FILTER_FOCUS,
            )}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-3.5", feed.state === "fetching" && "animate-spin")}
            />
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Where every price in this window comes from.
 *
 * Quiet like its two neighbours — `bg-surface`, border grey, and the only gold on it is the
 * chosen row and the focus ring, which is what gold already means everywhere else here.
 *
 * **All five are listed and four can be picked.** Hiding the fifth would be the tidier panel and
 * the worse one: a reader who trades on Card trader would search this list, find nothing, and be
 * left unable to tell "not supported" from "not found". `marketplace.ts`'s `priced` flag is a
 * fact about what this build can reach rather than a placeholder, and the row says so in its own
 * words.
 *
 * **Two of the four carry a feed, and that is the whole of what this panel gained.** TCGplayer's
 * and Cardmarket's prices ride in with the card data and are as old as the last sync, which the
 * ribbon already says; Card Kingdom's and Mana Pool's are downloaded on their own schedule, so
 * each says when it was last pulled, offers a refresh, and — where the feed publishes one —
 * shows the marketplace's own build stamp beside it.
 *
 * The state is a prop, exactly as `ErrorLogPanel`'s log is: `SettingsPage` calls
 * `useMarketplace()` and hands the answer down, so every story here is an argument and the
 * panel itself never reaches the backend.
 */
export function MarketplacePanel({ marketplace }: { marketplace: MarketplaceState }) {
  const { marketplace: chosen, select, selecting, error, feeds, refresh } = marketplace;
  // One clock for the whole render, so two rows cannot disagree about what "2 hours ago" means.
  // See {@link nowSeconds} for why this is a render-time read and not state.
  const now = nowSeconds();
  const feedOf = (id: string) => feeds.find((f) => f.marketplace.id === id) ?? null;
  // The first failure there is, and only its own row draws it: a refusal about Card Kingdom
  // under a list that also holds Mana Pool would be an alert nobody could attribute.
  const feedError = feeds.find((f) => f.error !== null)?.error ?? null;

  return (
    <SettingsSection id="prices" title="Prices">
      <p className="text-sm text-dim">
        Every price this app shows — in search, the collection, decks and the wishlist — is quoted
        from one marketplace, in that marketplace&rsquo;s currency. Switching re-reads the lists you
        are looking at; nothing re-syncs. A card a marketplace does not list shows an em dash there
        rather than another marketplace&rsquo;s number.
      </p>

      {/* `aria-busy` on the list rather than `disabled` on the rows: the write is one row
          long and a list that emptied its own tab order for the length of it would move the
          caret out from under a keyboard reader mid-press. */}
      <ul aria-busy={selecting || undefined} className="space-y-2">
        {MARKETPLACE_LIST.map((entry) => (
          <Option
            key={entry.id}
            marketplace={entry}
            chosen={entry.id === chosen.id}
            feed={feedOf(entry.id)}
            now={now}
            onChoose={() => select(entry.id)}
            onRefresh={() => refresh(entry.id)}
          />
        ))}
      </ul>

      {/* A refusal to switch, or the first feed that would not download. */}
      <PanelAlert tone="problem">{error ?? feedError}</PanelAlert>
    </SettingsSection>
  );
}
