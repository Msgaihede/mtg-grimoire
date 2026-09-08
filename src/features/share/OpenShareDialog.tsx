/**
 * Open somebody else's shared collection from its link.
 *
 * **Paste is the whole of the way in, and that is a decision rather than a first cut.** The app
 * reads no launch intent and registers no URL scheme; `relay/src/pair.ts` carries the argument
 * for why adding one is separate work with an Android trap in it. So a reader who was handed a
 * link in a chat window pastes it here, and the link is the whole of the capability — no
 * membership, no account, no token (spec §9).
 *
 * **The link is fetched before it is remembered**, which is why this dialog is not a form that
 * merely writes to the store. A link that answers 410 is not a binder the reader has opened, and
 * the sentence saying so belongs beside the box they typed it into rather than on a page they
 * would first have to be navigated to.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { BUTTON } from "@/features/settings/controls";
import { FOCUS } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { sharedSnapshotQuery } from "./useSharedSnapshot";

/**
 * What a paste that is not a share link is told.
 *
 * **The crate's own `share::publish::NOT_A_LINK`, word for word.** The same paste can be refused
 * on either side of the boundary — this one checks the shape, the command checks the scheme
 * again — and a reader who typed one wrong thing must not be told two different things depending
 * on which half noticed.
 */
export const NOT_A_SHARE_LINK = "That is not a shared collection link.";

/**
 * The share link inside whatever was pasted, or `null`.
 *
 * Every published link is `{SHARE_BASE}/s/{id}` — `share-worker/src/env.ts`'s `shareUrl`, and the
 * only link there is — so the shape is checkable here without knowing the host. It is checked
 * here **as well as** in the crate, and neither check is redundant: this one is what makes a
 * typo an instant sentence rather than a network round trip, and the crate's is what a caller
 * that is not this dialog still meets.
 *
 * The **host** is what cannot be checked. `SHARE_BASE` is compiled into the binary and a reader
 * who forked the relay has their own, so a viewer that refused an unfamiliar host would refuse
 * exactly the links a fork exists to serve.
 *
 * The answer is canonicalised (`URL.href`), so `HTTPS://Share.Example/s/x` and
 * `https://share.example/s/x` are one link and one cache entry rather than two.
 */
export function shareLinkFrom(text: string): string | null {
  // A chat window wraps a bare URL in angle brackets to stop itself unfurling it, and the reader
  // copying the line back out brings them along.
  const trimmed = text.trim().replace(/^<+/, "").replace(/>+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // `javascript:` and `file:` parse perfectly well; the scheme is what tells them from a link.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter((s) => s !== "");
  // `/s/{id}` — the id last, `s` immediately before it, and whatever path the base carries in
  // front of both.
  if (segments.length < 2 || segments[segments.length - 2] !== "s") return null;
  return url.href;
}

/**
 * The paste box.
 *
 * Its host owns `open` and the navigation: this dialog reports that a link opened and does not
 * decide where the reader goes, which is what lets it be drawn both from inside the shared view
 * (open another) and from outside it (open the first).
 */
export function OpenShareDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  /** A link answered and has been remembered. The host navigates. */
  onOpened: (url: string) => void;
}) {
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openShare = useAppStore((s) => s.openShare);
  const client = useQueryClient();

  const submit = async () => {
    const link = shareLinkFrom(text);
    if (link === null) {
      setRefusal(NOT_A_SHARE_LINK);
      return;
    }
    setRefusal(null);
    setOpening(true);
    try {
      // `fetchQuery` rather than a bare call: the answer lands in the cache under the key the
      // view reads, so the binder is already there when the reader arrives at it.
      await client.fetchQuery(sharedSnapshotQuery(link));
      openShare(link);
      onOpened(link);
      onClose();
    } catch (e) {
      setRefusal(ipcError(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Open a shared collection"
      subtitle="Paste the link somebody sent you."
      closeLabel="Close open a shared collection"
      size="w-[32rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-link" className="text-sm text-dim">
            Link to a shared collection
          </label>
          <input
            id="share-link"
            // ⚠️ **`text` with an `inputMode`, and `type="url"` is the trap it avoids.** A
            // `type="url"` field takes part in the browser's own constraint validation, so a
            // form containing one with anything unparseable in it **never fires `submit`** — the
            // browser shows its own bubble instead and {@link NOT_A_SHARE_LINK} is never reached.
            // The refusal is a spec requirement (§10) and this app's own voice; a native bubble
            // is neither, and it is the one refusal a reader cannot copy or act on. Caught by
            // this component's test, which went green on the fetch cases and red on both refusal
            // cases at once. `inputMode` is what still gets a phone the right keyboard, and
            // deliberately not `type="search"`, whose native Escape-clear would fight the
            // dialog's own dismiss rung.
            type="text"
            inputMode="url"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // The refusal is about what *was* in the box. Left standing over an edited link it
              // reads as a refusal the app will not take back.
              setRefusal(null);
            }}
            placeholder="https://…/s/…"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              "h-9 rounded-md border border-border bg-surface px-3 font-mono text-sm text-text",
              "placeholder:font-sans placeholder:text-dim",
              FOCUS,
            )}
          />
        </div>

        {refusal !== null && (
          // `alert`, not `status`: this region is mounted only when there is something to say,
          // and announcing on insertion is what the role is for.
          <p role="alert" className="text-sm text-destructive">
            {refusal}
          </p>
        )}

        <p className="text-sm text-dim">
          You will see a read-only snapshot of their collection, cross-referenced against your own.
          Nothing you do here changes their cards or yours.
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={cn(BUTTON, "border-border")}>
            Cancel
          </button>
          <button
            type="submit"
            // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and
            // this one greys as the reader types.
            aria-disabled={text.trim() === "" || opening}
            onClick={(e) => {
              if (text.trim() === "" || opening) e.preventDefault();
            }}
            className={cn(
              BUTTON,
              "border-accent/50 text-accent",
              (text.trim() === "" || opening) && "opacity-50",
            )}
          >
            {opening ? "Opening…" : "Open collection"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
