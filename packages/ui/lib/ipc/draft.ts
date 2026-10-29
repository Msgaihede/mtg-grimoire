/**
 * A draft — boosters passed round a table of bots, or of people in a lobby — over phase.rs's
 * draft module (`crates/grimoire-play/src/draft/`), the deck its pool becomes, and the lobby a pod
 * meets in (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §4–§6).
 *
 * **A domain of `../ipc.ts`**, read through `@/lib/ipc` only. The draft's shapes are
 * `grimoire-play`'s `draft/view.rs`; the deck's `grimoire-core`'s `draft_deck.rs`; the lobby's the
 * desktop host's `draft/lobby.rs` — each held field for field by `ipc.test.ts`.
 *
 * **The page makes the boosters** (`features/draft/booster/`) and hands them over as printing ids:
 * one collation for Packs and for Draft. A card's `instanceId` is `"{cardId}#{seat}.{round}.{n}"`.
 *
 * **A web or phone host refuses every command here** — they are on the desktop's `DESKTOP_ONLY`
 * list, and the light app draws no Draft & Packs page.
 */
import { core } from "@/lib/core";
import type { DeckRow } from "./decks";
import { invoke, type Unlisten } from "./invoke";
import type { PlaytestDifficulty } from "./playtest";
import type { LobbyTrade } from "./trade";

/**
 * Which kind of draft: boosters with bots, sealed, a cube with bots, a pod of people, a Commander
 * draft with bots (two cards a pick, a 60-card deck with a commander), or a Winston draft against a
 * bot (a shared stack dealt into three piles, each taken or declined).
 */
export type DraftMode = "quick" | "sealed" | "cube" | "pod" | "commander" | "winston";

/** What a pod drafts. Read only when the mode is `pod`. */
export type PodFormat = "booster" | "commander" | "winston";

/** Picking, or done picking and building. */
export type DraftStatus = "drafting" | "deckbuilding";

/** A new draft, as the page sets it up. */
export interface DraftSetup {
  mode: DraftMode;
  difficulty: PlaytestDifficulty;
  /** The bots' dice. A 32-bit number. */
  seed: number;
  /** "Reality Fracture · Lorwyn Eclipsed · The Hobbit" — what *Draft in progress* calls it. */
  label: string;
  /** In table order; seat 0 is this reader. */
  seats: DraftSeatSetup[];
  /** `[seat][round]` → printing ids, in the order the booster was opened. */
  packs: string[][][];
  /** Per round, the set code to show; `""` for a cube. */
  packSets: string[];
  /** 40 for Limited, 60 for a Commander draft. */
  minDeckSize: number;
  /** What a pod drafts; `"booster"` for every other mode. */
  podFormat: PodFormat;
}

/** One seat at the table: a person (this reader, or a lobby's peer) or a bot. */
export interface DraftSeatSetup {
  name: string;
  bot: boolean;
  /** The lobby peer who sits here, in a pod. */
  peer: string | null;
}

/** One card in a pack or a pool. */
export interface DraftCard {
  instanceId: string;
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string;
  colors: string[];
  cmc: number;
  typeLine: string;
}

/** One seat as everyone at the table may see it. */
export interface DraftSeatView {
  name: string;
  bot: boolean;
  connected: boolean;
  /** Has picked this step. */
  picked: boolean;
  poolCount: number;
}

/** The draft from one seat. */
export interface DraftView {
  mode: DraftMode;
  status: DraftStatus;
  label: string;
  seat: number;
  /** 0-based round. */
  packNumber: number;
  packCount: number;
  /** 0-based pick within the round. */
  pickNumber: number;
  /** Cards this round's booster held when it was opened. */
  packSize: number;
  passLeft: boolean;
  /** Empty while waiting, and once the draft is over. */
  pack: DraftCard[];
  /** Picked this step; the table has not caught up. */
  waiting: boolean;
  pool: DraftCard[];
  seats: DraftSeatView[];
  packSets: string[];
  minDeckSize: number;
  podFormat: PodFormat;
  /** Cards a pick takes: 2 in a Commander draft, else 1. */
  picksPerStep: number;
  /** Commanders the deck designates: 1 in a Commander draft, else 0. */
  commanders: number;
  /** A Winston draft's table; `null` for every other. */
  stack: WinstonView | null;
}

/**
 * A Winston draft's table from one seat. A pile's cards are told only to the seat whose turn it is,
 * for the pile it is looking at; every other pile is a count.
 */
export interface WinstonView {
  mainCount: number;
  piles: WinstonPile[];
  turnSeat: number;
  yourTurn: boolean;
  /** The pile the turn is deciding on, 0-based. */
  activePile: number | null;
}

/** One of a Winston draft's piles. */
export interface WinstonPile {
  count: number;
  /** Its cards, for the seat deciding on it; empty for everyone else. */
  cards: DraftCard[];
  active: boolean;
}

/** The solo draft left off, for *Draft in progress*. */
export interface DraftSaved {
  label: string;
  mode: DraftMode;
  status: DraftStatus;
  packNumber: number;
  packCount: number;
  pickNumber: number;
  /** Milliseconds. */
  updatedAt: number;
}

/** A basic land's printing the draft bar adds. */
export interface BasicLand {
  /** `W`, `U`, `B`, `R`, `G`. */
  color: string;
  name: string;
  cardId: string;
}

/** Hosting a lobby, or a guest in one. */
export type LobbyRole = "host" | "guest";

/**
 * What a lobby meets for: a pod's draft (Draft & Packs), a game on decks (Playtesting, issue
 * #1419), or a trade between two readers (the Trade page). One lobby at a time, of any kind; each
 * page leaves the others' alone.
 */
export type LobbyKind = "draft" | "game" | "trade";

/** Where a lobby is. A draft's is `drafting` once dealt, a game's `playing`, a trade's `agreed`
 *  once both readers have accepted the same deal. */
export type LobbyPhase = "connecting" | "open" | "drafting" | "playing" | "agreed" | "closed";

/** A guest in a lobby. */
export interface LobbyPeer {
  peer: string;
  name: string;
  online: boolean;
  /** The name of the deck this guest brings to a game (`lobbyDeck`); `null` until it sent one,
   *  and always in a draft. */
  deck: string | null;
}

/** This app's lobby. */
export interface LobbyState {
  role: LobbyRole;
  /** What the lobby is for. A guest's is `null` until the host's room says. */
  kind: LobbyKind | null;
  code: string;
  phase: LobbyPhase;
  /** This reader's name in the lobby. */
  name: string;
  hostName: string;
  hostOnline: boolean;
  peers: LobbyPeer[];
  /** The host's draft, as the room describes it. */
  label: string;
  closedReason: string | null;
  /** A trade's lobby: this reader's copy of the trade and the deal on the table. `null` in a
   *  draft's or a game's. */
  trade: LobbyTrade | null;
}

/** What a host tells its guests about the room. */
export interface LobbyRoom {
  kind: LobbyKind;
  hostName: string;
  label: string;
  peers: LobbyPeer[];
  started: boolean;
}

export const draftCommands = {
  /** Deal a new draft and answer seat 0's view. `draft` is the page's name for it. */
  draftStart: (setup: DraftSetup, draft: number) =>
    invoke<DraftView>("draft_start", { setup, draft }),
  draftView: (draft: number) => invoke<DraftView | null>("draft_view", { draft }),
  draftPick: (draft: number, cardInstanceIds: string[]) =>
    invoke<DraftView>("draft_pick", { draft, cardInstanceIds }),
  /** A Winston turn: take the pile, or decline it (the next pile, or the stack's top card). */
  draftWinston: (draft: number, pile: number, take: boolean) =>
    invoke<DraftView>("draft_winston", { draft, pile, take }),
  /** The bots' choice, for the reader. */
  draftAutoPick: (draft: number) => invoke<DraftView>("draft_auto_pick", { draft }),
  /** Put the draft away, and its saved copy. */
  draftEnd: (draft: number) => invoke<void>("draft_end", { draft }),
  /** The solo draft left off, if any. */
  draftSaved: () => invoke<DraftSaved | null>("draft_saved"),
  /** Take the saved draft back up under the name `draft`. */
  draftResume: (draft: number) => invoke<DraftView>("draft_resume", { draft }),

  /**
   * The pool as a virtual deck, in the draft's unsaved list: Limited, or with `commander` a Casual
   * deck with a Commander pile (a Commander draft's 60 cards and its commander).
   */
  draftDeckCreate: (name: string, cardIds: string[], commander: boolean) =>
    invoke<DeckRow>("draft_deck_create", { name, cardIds, commander }),
  /** The draft decks not saved yet. */
  draftDeckIds: () => invoke<number[]>("draft_deck_ids"),
  /** Save: the deck leaves the unsaved list, and is a deck like any other. */
  draftDeckKeep: (deckId: number) => invoke<void>("draft_deck_keep", { deckId }),
  /** Discard: the deck is deleted. */
  draftDeckDiscard: (deckId: number) => invoke<void>("draft_deck_discard", { deckId }),
  /** The five basics, in a printing of `setCodes` where the corpus has one. */
  draftBasicLands: (setCodes: string[]) => invoke<BasicLand[]>("draft_basic_lands", { setCodes }),

  /** Open a lobby — a supporter's — for a pod's draft, a game on decks, or a trade; a trade's
   *  names the reader's own copy of the trade (`trade`), whose `mine` side is their offer. */
  lobbyCreate: (name: string, kind: LobbyKind, trade?: number) =>
    invoke<LobbyState>(
      "lobby_create",
      trade === undefined ? { name, kind } : { name, kind, trade },
    ),
  /** Join by code; a page joining for a trade names the reader's own copy of it (`trade`). */
  lobbyJoin: (code: string, name: string, trade?: number) =>
    invoke<LobbyState>("lobby_join", trade === undefined ? { code, name } : { code, name, trade }),
  lobbyState: () => invoke<LobbyState | null>("lobby_state"),
  /** Leave; a host closes the lobby. */
  lobbyLeave: () => invoke<void>("lobby_leave"),
  /** The host deals the pod's draft. */
  lobbyStart: (setup: DraftSetup, draft: number) =>
    invoke<DraftView>("lobby_start", { setup, draft }),
  /** A guest's pick; the view arrives as `draft:view`. */
  lobbyPick: (cardInstanceIds: string[]) => invoke<void>("lobby_pick", { cardInstanceIds }),
  /** A guest's Winston turn; the view arrives as `draft:view`. */
  lobbyWinston: (pile: number, take: boolean) => invoke<void>("lobby_winston", { pile, take }),
  lobbyKick: (peer: string) => invoke<void>("lobby_kick", { peer }),
  onLobbyState: (cb: (state: LobbyState) => void): Unlisten =>
    core.listen<LobbyState>("lobby:state", cb),
  onDraftView: (cb: (view: DraftView) => void): Unlisten =>
    core.listen<DraftView>("draft:view", cb),
};
