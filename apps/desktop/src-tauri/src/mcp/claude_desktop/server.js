// MTG Grimoire's Claude Desktop extension: a bridge from the stdio Claude Desktop starts an
// extension's server on to the streamable-HTTP MCP server the running app serves on 127.0.0.1.
//
// Claude Desktop runs this on the Node.js it ships with, so it may need nothing the reader has
// installed: no dependencies, only Node's own `readline` and `fetch` (Node 18 and later). One
// JSON-RPC message per line in, each POSTed to the app as it is, and every message the app
// answers written back one per line. The address and the token are the bundle's own — written
// into its manifest by the app when it built the bundle (`src/mcp/claude_desktop.rs`).
//
// A request the app cannot answer — it is closed, its server is switched off, its token was
// replaced — is answered here with a JSON-RPC error saying so in words, so Claude never waits on
// a request nobody will answer.
"use strict";

const readline = require("node:readline");

const URL = process.env.MTG_GRIMOIRE_URL;
const TOKEN = process.env.MTG_GRIMOIRE_TOKEN;

/** The sentence for an app that did not answer at all. */
const NOT_ANSWERING =
  "MTG Grimoire isn't answering. Open the app, and check that Settings → Integrations → " +
  "AI agents on this computer is on.";

/** The revision `initialize` agreed, sent on every later request as the transport asks. */
let protocolVersion = null;

/** One request at a time, in the order Claude sent them. */
let queue = Promise.resolve();

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/** The ids a message (or a batch of them) expects an answer for — notifications have none. */
function requestIds(message) {
  const messages = Array.isArray(message) ? message : [message];
  return messages
    .filter((m) => m && typeof m === "object" && "method" in m && m.id != null)
    .map((m) => m.id);
}

/** Answer every request in `message` with `text` as a JSON-RPC error. */
function refuse(message, text) {
  for (const id of requestIds(message)) {
    write({ jsonrpc: "2.0", id, error: { code: -32000, message: text } });
  }
}

/** What an HTTP refusal with no JSON-RPC body means, in words. */
function explain(status, body) {
  switch (status) {
    case 401:
      return (
        "MTG Grimoire refused this extension's token — it was replaced. Install the Claude " +
        "Desktop extension again from Settings → Integrations."
      );
    case 503:
      return NOT_ANSWERING;
    default:
      return `MTG Grimoire answered ${status}${body ? `: ${body.trim()}` : "."}`;
  }
}

/**
 * The JSON-RPC messages in a response body: one JSON value (a message or a batch), or an event
 * stream whose `data:` lines are messages. `[]` for a body that is neither.
 */
function messagesIn(contentType, body) {
  const values = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) values.push(data);
    }
  } else if (body.trim()) {
    values.push(body);
  }
  const messages = [];
  for (const value of values) {
    try {
      const parsed = JSON.parse(value);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Not JSON-RPC — the caller says what the status meant instead.
    }
  }
  return messages;
}

async function forward(message) {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  let response;
  let body;
  try {
    response = await fetch(URL, { method: "POST", headers, body: JSON.stringify(message) });
    body = await response.text();
  } catch {
    return refuse(message, NOT_ANSWERING);
  }

  const answers = messagesIn(response.headers.get("content-type") || "", body);
  if (answers.length === 0) {
    if (!response.ok) refuse(message, explain(response.status, body));
    return;
  }
  for (const answer of answers) {
    if (
      !Array.isArray(message) &&
      message.method === "initialize" &&
      answer.id === message.id &&
      answer.result &&
      typeof answer.result.protocolVersion === "string"
    ) {
      protocolVersion = answer.result.protocolVersion;
    }
    write(answer);
  }
}

if (!URL || !TOKEN) {
  process.stderr.write("mtg-grimoire: the extension was built without an address or a token.\n");
  process.exit(1);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } });
    return;
  }
  queue = queue.then(() => forward(message)).catch(() => refuse(message, NOT_ANSWERING));
});
lines.on("close", () => {
  void queue.then(() => process.exit(0));
});
