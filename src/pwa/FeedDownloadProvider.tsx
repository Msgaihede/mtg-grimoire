import { createContext, useCallback, useContext, useState, type JSX, type ReactNode } from "react";
import { meteredLink, navigatorConnection, type LinkReading } from "@/pwa/connection";
import { FeedDownloadDialog } from "@/pwa/FeedDownloadDialog";
import { probeFeedSize, shouldPrompt, type FeedId, type FeedSize } from "@/pwa/feedSize";
import { isWebTarget } from "@/pwa/target";

/** Ask before running a reader-initiated download, if there is anything to ask about. */
export type AskFirst = (feed: FeedId, run: () => void) => void;

/**
 * Desktop's answer, and the default for anything rendered outside the provider.
 *
 * **Synchronous**, and that is load-bearing: three existing suites drive Refresh on the desktop
 * default and assert on what happens in the same tick. A pass-through that deferred by a frame
 * would make every desktop Refresh a frame slower and every one of those tests flaky.
 */
const RUN_IT: AskFirst = (_feed, run) => run();

const FeedDownloadContext = createContext<AskFirst>(RUN_IT);

/** The guard, from anywhere under the provider. */
export function useFeedDownload(): AskFirst {
  return useContext(FeedDownloadContext);
}

/** One asking in flight. There is one dialog, because a reader presses one Refresh at a time. */
interface Asking {
  feed: FeedId;
  run: () => void;
  size: FeedSize;
  link: LinkReading;
  preferred: "download" | "not-now";
}

/**
 * The guard around the three downloads a reader can start.
 *
 * There are exactly three, and the census is worth writing down because it is smaller than it
 * looks: `useSync`'s `syncRun`, `useDataReset`'s `useLocalCache` combo clear, and
 * `useMarketplace`'s `marketplaceFeedRefresh`.
 *
 * **The middle one changed hands rather than leaving, and which press it is now is the whole
 * reason to keep a census.** It was `CombosPanel`'s `combosRefresh` — a Refresh on a Settings
 * panel whose job was to make a reader go and fetch the combo feed. That panel is gone: the feed
 * downloads at launch on the tagger files' own weekly schedule, so there is nothing left for a
 * reader to start on purpose except *Clear combos* in the Local cache panel, which clears
 * the table and re-downloads it in one press. It is the same 27.5 MB started by the same
 * deliberate act, on the same `askFirst("combos", …)`, raising a dialog that names the same feed
 * — the *count* is unchanged and only the caller moved.
 *
 * **Three feeds download uninvited now, and that is a hole rather than a decision.** The two
 * tagger files have never had a UI caller — the backend refreshes them on its own weekly
 * schedule — so a prompt cannot be attached to a download nobody asked for, and **the combo feed
 * has joined them** on that same schedule and for that same reason. It is the largest of the
 * three by some way: on a metered link this is 5.85 MB, 12.5 MB and 27.5 MB spent unasked, which
 * is **45.85 MB** where it was 18.35. The guarded press above buys none of it back — a clear is
 * not what fetches the file any more, and the launch refresh runs whether or not anybody presses
 * anything, which is at once what made the old panel deletable and what made this worse.
 *
 * The fix is a "not on a metered link" gate in the scheduler, not another dialog. The figure is
 * written out because understating it is how it stays unfixed: eighteen megabytes reads as a
 * rounding error beside a card corpus, and forty-six does not.
 *
 * Mounted in `App` **inside `QueryClientProvider` and outside `ContextMenuProvider`**, which is
 * `CardToDeckProvider`'s placement argument verbatim: that provider draws its panel as a
 * *sibling* of `children`, so a context mounted inside it would be around every view and around
 * none of the menu's own rows.
 *
 * `fetchFn` and `connection` are injectable so the suite can stage a probe without a network.
 */
export function FeedDownloadProvider({
  children,
  fetchFn = (input: string, init?: RequestInit) => fetch(input, init),
  connection = navigatorConnection,
}: {
  children: ReactNode;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  connection?: () => ReturnType<typeof navigatorConnection>;
}): JSX.Element {
  const [asking, setAsking] = useState<Asking | null>(null);

  const ask = useCallback<AskFirst>(
    (feed, run) => {
      if (!isWebTarget()) {
        run();
        return;
      }
      void probeFeedSize(feed, fetchFn).then((size) => {
        const link = meteredLink(connection());
        const decision = shouldPrompt(size, link);
        if (!decision.show) {
          run();
          return;
        }
        setAsking({ feed, run, size, link, preferred: decision.preferred });
      });
    },
    [fetchFn, connection],
  );

  return (
    <FeedDownloadContext.Provider value={ask}>
      {children}
      {asking && (
        <FeedDownloadDialog
          open
          feed={asking.feed}
          size={asking.size}
          link={asking.link}
          preferred={asking.preferred}
          onDownload={() => {
            setAsking(null);
            asking.run();
          }}
          // Not now runs nothing at all. The refusal is the whole point of the dialog, so
          // there is no "later" queue and nothing is retried behind the reader's back.
          onNotNow={() => setAsking(null)}
        />
      )}
    </FeedDownloadContext.Provider>
  );
}
