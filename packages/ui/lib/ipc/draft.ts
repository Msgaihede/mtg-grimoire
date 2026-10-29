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

/** Which kind of draft: boosters with bots, sealed, a cube with bots, or a pod of people. */
export type DraftMode = "quick" | "sealed" | "cube" | "pod";

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
  minDeckSize: number;
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

/** Where a lobby is. */
export type LobbyPhase = "connecting" | "open" | "drafting" | "closed";

/** A guest in a lobby. */
export interface LobbyPeer {
  peer: string;
  name: string;
  online: boolean;
}

/** This app's lobby. */
export interface LobbyState {
  role: LobbyRole;
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
}

/** What a host tells its guests about the room. */
export interface LobbyRoom {
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
  /** The bots' choice, for the reader. */
  draftAutoPick: (draft: number) => invoke<DraftView>("draft_auto_pick", { draft }),
  /** Put the draft away, and its saved copy. */
  draftEnd: (draft: number) => invoke<void>("draft_end", { draft }),
  /** The solo draft left off, if any. */
  draftSaved: () => invoke<DraftSaved | null>("draft_saved"),
  /** Take the saved draft back up under the name `draft`. */
  draftResume: (draft: number) => invoke<DraftView>("draft_resume", { draft }),

  /** The pool as a virtual Limited deck, in the draft's unsaved list. */
  draftDeckCreate: (name: string, cardIds: string[]) =>
    invoke<DeckRow>("draft_deck_create", { name, cardIds }),
  /** The draft decks not saved yet. */
  draftDeckIds: () => invoke<number[]>("draft_deck_ids"),
  /** Save: the deck leaves the unsaved list, and is a deck like any other. */
  draftDeckKeep: (deckId: number) => invoke<void>("draft_deck_keep", { deckId }),
  /** Discard: the deck is deleted. */
  draftDeckDiscard: (deckId: number) => invoke<void>("draft_deck_discard", { deckId }),
  /** The five basics, in a printing of `setCodes` where the corpus has one. */
  draftBasicLands: (setCodes: string[]) =>
    invoke<BasicLand[]>("draft_basic_lands", { setCodes }),

  /** Open a lobby — a supporter's. */
  lobbyCreate: (name: string) => invoke<LobbyState>("lobby_create", { name }),
  lobbyJoin: (code: string, name: string) => invoke<LobbyState>("lobby_join", { code, name }),
  lobbyState: () => invoke<LobbyState | null>("lobby_state"),
  /** Leave; a host closes the lobby. */
  lobbyLeave: () => invoke<void>("lobby_leave"),
  /** The host deals the pod's draft. */
  lobbyStart: (setup: DraftSetup, draft: number) =>
    invoke<DraftView>("lobby_start", { setup, draft }),
  /** A guest's pick; the view arrives as `draft:view`. */
  lobbyPick: (cardInstanceIds: string[]) => invoke<void>("lobby_pick", { cardInstanceIds }),
  lobbyKick: (peer: string) => invoke<void>("lobby_kick", { peer }),
  onLobbyState: (cb: (state: LobbyState) => void): Unlisten =>
    core.listen<LobbyState>("lobby:state", cb),
  onDraftView: (cb: (view: DraftView) => void): Unlisten =>
    core.listen<DraftView>("draft:view", cb),
};
