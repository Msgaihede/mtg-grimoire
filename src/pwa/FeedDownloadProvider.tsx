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
 * looks: `useSync`'s `syncRun`, `CombosPanel`'s `combosRefresh`, and `useMarketplace`'s
 * `marketplaceFeedRefresh`.
 *
 * **The two tagger feeds are not guarded, and that is a hole rather than a decision.** They have
 * no UI caller at all — the backend refreshes them on its own weekly schedule — so a prompt
 * cannot be attached to a download nobody asked for. On a metered link that is 5.85 MB and
 * 12.5 MB spent unasked. The fix is a "not on a metered link" gate in the scheduler, not another
 * dialog.
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
