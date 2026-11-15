import { otherReader, theyAccepted, youAccepted, type TradeLobby } from "./useTradeLobby";

/**
 * The trade lobby's sentences, apart from the band that draws them so each is a test away.
 */

/** Who the reader is trading with, or why they are not yet — or not any more. */
export function readerLine(lobby: TradeLobby): string {
  if (lobby.phase === "closed") {
    return `Lobby ${lobby.code} closed${lobby.closedReason ? `: ${lobby.closedReason}` : "."}`;
  }
  if (lobby.phase === "connecting") return "Reconnecting to the lobby…";
  const other = otherReader(lobby);
  if (other === null) return "Waiting for the other person. Share the code with them.";
  return other.online ? `Trading with ${other.name}` : `Trading with ${other.name} (away)`;
}

/** Where the deal stands. */
export function dealLine(lobby: TradeLobby): string {
  const them = otherReader(lobby)?.name ?? "They";
  if (lobby.phase === "agreed") {
    return "You both accepted. Finish the trade to choose what changes in your collection.";
  }
  const yours = youAccepted(lobby);
  const theirs = theyAccepted(lobby);
  if (yours && theirs) return "You both accepted.";
  if (yours) return `You accepted. Waiting for ${them}.`;
  if (theirs) return `${them} accepted. Review the trade and accept it too.`;
  return "Add what you give to your side. Any change resets both acceptances.";
}

/** What this app could not show of the other reader's offer, or `null` when it showed it all. */
export function unknownLine(unknown: number): string | null {
  if (unknown <= 0) return null;
  const cards = unknown === 1 ? "1 card they offer is" : `${unknown} cards they offer are`;
  return `${cards} not in your card data yet, so not shown here. Update card data in Settings to see ${unknown === 1 ? "it" : "them"}.`;
}
