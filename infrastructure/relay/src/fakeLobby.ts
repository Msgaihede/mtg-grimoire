import { vi } from "vitest";
import { stubWorkerd } from "./fakeState";
import { Lobby } from "./lobby";

/**
 * A stand-in for workerd under `Lobby`: hibernatable sockets, the key-value storage API and an
 * alarm, and a `LOBBY` namespace that builds one real `Lobby` per code.
 *
 * **Not `fakeState.ts`, and not a second copy of it.** That stand-in fakes what `Group` touches —
 * SQL, and sockets a test hands it — and every `WebSocketPair` it makes is the same two objects.
 * A lobby needs what `Group` never asks for: a fresh pair per connection, attachments, the
 * storage API's `get`/`put`/`deleteAll`, and an alarm. What the two share, the 101 that Node's
 * `Response` refuses, is `fakeState.ts`'s `stubWorkerd`, reused.
 *
 * **A socket the object closes stays in `getWebSockets` until the test disconnects it**, as in
 * workerd, where a close the server started is not done until the client answers. So whatever
 * `lobby.ts` decides about who is online has to read `readyState`, and a test catches it if not.
 */

/** One end of a fake socket pair: the server end is what the object holds. */
export class FakeSocket {
  readyState = 1;
  tags: string[] = [];
  /** Every text frame the object sent down this socket, parsed. */
  readonly frames: unknown[] = [];
  /** The close the object asked for, if any. */
  closed: { code: number; reason: string } | null = null;
  /** True once the test has said the connection is gone. */
  disconnected = false;
  private attachment: unknown = null;

  send(text: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.frames.push(JSON.parse(text));
  }

  close(code: number, reason: string): void {
    if (this.closed !== null) throw new Error("closed twice");
    this.closed = { code, reason };
    this.readyState = 2;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** The frames sent since the last call, so a test reads what one step caused. */
  private read = 0;
  take(): unknown[] {
    const fresh = this.frames.slice(this.read);
    this.read = this.frames.length;
    return fresh;
  }
}

export interface FakeLobbyState {
  state: DurableObjectState;
  store: Map<string, unknown>;
  alarm: () => number | null;
  /** Every server end accepted, in order. */
  accepted: FakeSocket[];
}

export function fakeLobbyState(): FakeLobbyState {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const accepted: FakeSocket[] = [];

  const state = {
    storage: {
      get: (key: string) => Promise.resolve(structuredClone(store.get(key))),
      put: (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
        return Promise.resolve();
      },
      deleteAll: () => {
        store.clear();
        return Promise.resolve();
      },
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
    },
    setWebSocketAutoResponse: () => {},
    acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
      socket.tags = tags;
      accepted.push(socket);
    },
    getWebSockets: (tag?: string) =>
      accepted.filter((ws) => !ws.disconnected && (tag === undefined || ws.tags.includes(tag))),
    getTags: (socket: FakeSocket) => socket.tags,
  };
  return {
    state: state as unknown as DurableObjectState,
    store,
    alarm: () => alarm,
    accepted,
  };
}

/** The client end handed back in a 101, and the server end it is paired with. */
export class FakeClient {
  constructor(readonly server: FakeSocket) {}
}

/**
 * `stubWorkerd`'s globals, with a `WebSocketPair` that makes a fresh pair each time — index 0 the
 * client end, as workerd's is.
 */
export function stubLobbyWorkerd(): void {
  stubWorkerd();
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0: FakeClient;
      1: FakeSocket;
      constructor() {
        this[1] = new FakeSocket();
        this[0] = new FakeClient(this[1]);
      }
    },
  );
}

export interface FakeLobbies {
  namespace: DurableObjectNamespace;
  /** The lobby built for a code, and its state — built on first ask, as `get` would. */
  at: (code: string) => { lobby: Lobby; fake: FakeLobbyState };
  /** Every code the Worker asked an object of, in order. */
  asked: string[];
}

/** A `LOBBY` namespace over real `Lobby` objects, one per code, each over its own fake state. */
export function fakeLobbies(): FakeLobbies {
  const objects = new Map<string, { lobby: Lobby; fake: FakeLobbyState }>();
  const asked: string[] = [];
  const at = (code: string) => {
    let object = objects.get(code);
    if (object === undefined) {
      const fake = fakeLobbyState();
      object = { lobby: new Lobby(fake.state), fake };
      objects.set(code, object);
    }
    return object;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (input: Request | string, init?: RequestInit) => {
        asked.push(id);
        const request = typeof input === "string" ? new Request(input, init) : input;
        return at(id).lobby.fetch(request);
      },
    }),
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, at, asked };
}
