import { useEffect, useRef, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { formatBytes } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";
import { BUTTON } from "@/features/settings/controls";
import type { LinkReading } from "@/pwa/connection";
import { FEED_NAME, type FeedId, type FeedSize, type PromptDecision } from "@/pwa/feedSize";

export interface FeedDownloadDialogProps {
  open: boolean;
  feed: FeedId;
  size: FeedSize;
  link: LinkReading;
  /** Which button opens focused — `shouldPrompt`'s answer. */
  preferred: PromptDecision["preferred"];
  onDownload: () => void;
  onNotNow: () => void;
}

/**
 * What a feed costs, before it starts.
 *
 * Spec §5.3: on web and Android, any feed over 5 MB shows its **measured** size and, where the
 * link reports itself metered, says so and defaults to *Not now*.
 *
 * **The size is the feed's own number**, never this app's estimate of it — Scryfall's
 * `compressed_size` out of the bulk descriptor and a `Content-Length` for Spellbook. Where there
 * is none, the dialog says there is none: Card Kingdom's feed is paginated and its HEAD carries
 * no length, and reprinting a figure somebody measured once in August would be worse than the
 * honest sentence.
 *
 * `formatBytes` is `useUpdate`'s, so "78.0 MB" is written the way the desktop updater already
 * writes one.
 */
export function FeedDownloadDialog({
  open,
  feed,
  size,
  link,
  preferred,
  onDownload,
  onNotNow,
}: FeedDownloadDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Download now?"
      closeLabel="Close download question"
      size="w-[26rem]"
      onDismiss={onNotNow}
      onClose={onNotNow}
    >
      <Body
        feed={feed}
        size={size}
        link={link}
        preferred={preferred}
        onDownload={onDownload}
        onNotNow={onNotNow}
      />
    </Dialog>
  );
}

/**
 * The question, mounted only while the dialog is open — `Dialog`'s stated rule, and what makes
 * the `autoFocus` below happen once per asking rather than once per app.
 */
function Body({
  feed,
  size,
  link,
  preferred,
  onDownload,
  onNotNow,
}: Omit<FeedDownloadDialogProps, "open">) {
  const downloadRef = useRef<HTMLButtonElement>(null);
  const notNowRef = useRef<HTMLButtonElement>(null);

  // The lean, as a caret rather than as a colour: a metered link opens on Not now, everything
  // else on Download. `autoFocus` on a JSX attribute would be evaluated once per element and
  // could not follow a prop, so it is an effect on the ref the decision names.
  useEffect(() => {
    (preferred === "not-now" ? notNowRef : downloadRef).current?.focus();
  }, [preferred]);

  return (
    <div className="space-y-4 p-4 pt-0 text-sm">
      <p className="leading-relaxed text-dim">
        Refreshing {FEED_NAME[feed]} downloads{" "}
        {size.bytes === null ? (
          "a file whose size is not published"
        ) : (
          <span className="font-medium text-text">{formatBytes(size.bytes)}</span>
        )}
        .
      </p>
      {link.why && <p className="leading-relaxed text-dim">{link.why}</p>}

      <div className="flex justify-end gap-2">
        <button ref={notNowRef} type="button" onClick={onNotNow} className={BUTTON}>
          Not now
        </button>
        <button
          ref={downloadRef}
          type="button"
          onClick={onDownload}
          className={cn(BUTTON, "border-accent text-accent")}
        >
          Download
        </button>
      </div>
    </div>
  );
}
