/**
 * The fake's local MCP server — the workbench's stand-in for the desktop's five `mcp_*` commands
 * (issue #1395).
 *
 * There is no socket, so what is held here is what the panel's stories lean on: that every world
 * opens off on the default port, that a press answers the status it made, that a refused press
 * changes nothing, that the `mcpPortTaken` world is On and not listening with the bind's sentence,
 * and that the fake's refusals are the desktop's words.
 */
import { describe, expect, it } from "vitest";
import mcpRs from "../../apps/desktop/src-tauri/src/mcp/mod.rs?raw";
import {
  applyMcpFault,
  FAKE_MCP_TOKEN,
  MCP_DEFAULT_PORT,
  MCP_PORT_RANGE,
  MCP_TAKEN_PORT,
  makeDb,
  mcpHandlers,
  mcpPortTaken,
  type FakeDb,
} from "./db";

/** A world with the given fault applied the way `installWorld` applies it. */
function world(fault: FakeDb["fault"] = null): FakeDb {
  const db = makeDb();
  db.fault = fault;
  applyMcpFault(db);
  return db;
}

describe("the fake's MCP sentences are the desktop's", () => {
  // `format!` strings, so the port is a `{port}` / `{MIN_PORT}` placeholder in the Rust text.
  it("says a taken port in `mcp::bind`'s words", () => {
    expect(mcpRs).toContain(`"${mcpPortTaken(0).replace("Port 0 ", "Port {port} ")}"`);
  });

  it("says a port below the range in `mcp_set_port`'s words", () => {
    expect(mcpRs).toContain(`"${MCP_PORT_RANGE.replace("1024", "{MIN_PORT}")}"`);
  });
});

describe("the local MCP server, as the fake answers it", () => {
  it("opens off, on the default port, with a 64-hex-digit token", () => {
    expect(mcpHandlers(world()).mcp_status()).toEqual({
      enabled: false,
      running: false,
      port: MCP_DEFAULT_PORT,
      url: `http://127.0.0.1:${MCP_DEFAULT_PORT}/mcp`,
      token: FAKE_MCP_TOKEN,
      error: null,
    });
    expect(FAKE_MCP_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("switches on and off, answering the status each press made", () => {
    const commands = mcpHandlers(world());

    expect(commands.mcp_enable()).toMatchObject({ enabled: true, running: true, error: null });
    expect(commands.mcp_disable()).toMatchObject({ enabled: false, running: false });
  });

  it("replaces the token with one it has not answered before, every time", () => {
    const commands = mcpHandlers(world());
    const first = commands.mcp_rotate_token().token;
    const second = commands.mcp_rotate_token().token;

    expect(new Set([FAKE_MCP_TOKEN, first, second]).size).toBe(3);
    for (const token of [first, second]) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves a running server, and refuses a taken port with the old one still serving", () => {
    const commands = mcpHandlers(world());
    commands.mcp_enable();

    expect(commands.mcp_set_port({ port: 40000 })).toMatchObject({
      port: 40000,
      running: true,
      url: "http://127.0.0.1:40000/mcp",
    });
    expect(() => commands.mcp_set_port({ port: MCP_TAKEN_PORT })).toThrow(
      mcpPortTaken(MCP_TAKEN_PORT),
    );
    expect(commands.mcp_status()).toMatchObject({ port: 40000, running: true });
  });

  it("refuses a port below 1024 and changes nothing", () => {
    const commands = mcpHandlers(world());

    expect(() => commands.mcp_set_port({ port: 80 })).toThrow(MCP_PORT_RANGE);
    expect(commands.mcp_status().port).toBe(MCP_DEFAULT_PORT);
  });

  it("refuses to switch on over a taken port, and leaves the switch off", () => {
    const commands = mcpHandlers(world());
    commands.mcp_set_port({ port: MCP_TAKEN_PORT });

    expect(() => commands.mcp_enable()).toThrow(mcpPortTaken(MCP_TAKEN_PORT));
    expect(commands.mcp_status()).toMatchObject({ enabled: false, running: false });
  });

  /**
   * **The launch that could not bind**: On and not listening, the sentence beside the switch. A
   * taken port is refused with the sentence kept; a free one starts the server there — the
   * desktop's `mcp_set_port` binds a server that is switched on, running or not.
   */
  it("draws the mcpPortTaken world On and not listening, and recovers through a new port", () => {
    const commands = mcpHandlers(world("mcpPortTaken"));

    expect(commands.mcp_status()).toMatchObject({
      enabled: true,
      running: false,
      error: mcpPortTaken(MCP_DEFAULT_PORT),
    });
    expect(() => commands.mcp_enable()).toThrow(mcpPortTaken(MCP_DEFAULT_PORT));

    expect(() => commands.mcp_set_port({ port: MCP_TAKEN_PORT })).toThrow(
      mcpPortTaken(MCP_TAKEN_PORT),
    );
    expect(commands.mcp_status()).toMatchObject({ running: false, port: MCP_DEFAULT_PORT });

    expect(commands.mcp_set_port({ port: 40000 })).toMatchObject({
      enabled: true,
      running: true,
      port: 40000,
      error: null,
    });
  });
});
