/** Types for the subset of Chrome DevTools Protocol used by the script harnesses. */
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import type { Protocol } from "devtools-protocol";

export type Command = keyof ProtocolMapping.Commands;
export type CommandParams<M extends Command> =
  | Exclude<ProtocolMapping.Commands[M]["paramsType"][0], undefined>
  | (ProtocolMapping.Commands[M]["paramsType"] extends [] ? Record<string, never> : never);
export type CommandResult<M extends Command> = ProtocolMapping.Commands[M]["returnType"];
export type Send = <M extends Command>(
  method: M,
  params?: CommandParams<M>,
  sessionId?: string,
) => Promise<CommandResult<M>>;
export type EventName = keyof ProtocolMapping.Events;
export type EventParams<M extends EventName> = ProtocolMapping.Events[M][0];
export type ProtocolEvent = {
  [M in EventName]: { method: M; params: EventParams<M>; sessionId?: string };
}[EventName];
export interface Reply {
  id: number;
  result: unknown;
  error?: { message: string; data?: unknown };
}
export interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}
export type Point = { x: number; y: number };
export type Request = Protocol.Network.Request;
export type Browser = {
  send: Send;
  on: <M extends EventName>(
    method: M,
    handler: (params: EventParams<M>, sessionId?: string) => unknown,
  ) => void;
  heard: ProtocolEvent[];
  close: () => void;
};
