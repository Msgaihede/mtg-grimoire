/**
 * **A custom widget's query variables, from its settings** — what lets a setting change what the
 * query asks rather than only what the answer shows.
 *
 * The rule is a name: **every variable the document declares is filled from the setting of the
 * same name.** `query Shelf($archived: Boolean) { decks(archived: $archived) { name } }` is asked
 * with `/settings/archived`, and a change in the settings popover asks again. A declared variable
 * with no setting is left out, so the document's default (or GraphQL's `null`) applies; a setting
 * no variable names is never sent. `CATALOG_RULES` tells a model the same.
 *
 * The desktop's MCP tool `widget_preview` fills variables in Rust by the same rule; both hold to
 * `__golden__/query-variables.json`.
 */

type Plain = Record<string, unknown>;

/** A GraphQL name: `/[_A-Za-z][_0-9A-Za-z]*\/`. */
const NAME = /[_A-Za-z][_0-9A-Za-z]*/;

/**
 * The variables a document declares, in order, each once. A declaration is `$name:` — a variable's
 * *use* has no colon after it — read with strings and comments taken out first, so `"$x:"` in an
 * argument or `# $x:` in a comment declares nothing.
 */
export function declaredVariables(query: string): string[] {
  const code = query
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, " ")
    .replace(/#[^\n]*/g, " ");
  const declaration = new RegExp(`\\$(${NAME.source})\\s*:`, "g");
  const names: string[] = [];
  for (const match of code.matchAll(declaration)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The variables a document is asked with: each declared one the settings hold, by name — or
 * `undefined` for a document that declares none, so its cache key is the one it always had.
 */
export function queryVariables(query: string, settings: Plain): Plain | undefined {
  const declared = declaredVariables(query);
  if (declared.length === 0) return undefined;
  return Object.fromEntries(
    declared.filter((name) => settings[name] !== undefined).map((name) => [name, settings[name]]),
  );
}
