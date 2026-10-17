// Slice 3c experiment 5 (recall hill-climb): prompt additions inserted after EXTRACT_PROMPT's "If nothing qualifies" line.
// Designed from the misses' kinds (removals, raised minimum versions and default changes inside long lists), checked on
// DEV documents before one look at H1 + H2.
export const ADDENDA: Record<string, string> = {
  lists: `Long notes and upgrade guides often hold dozens of such changes. Treat every bullet, numbered item and table row as a
candidate: each removal, renamed or moved API, changed default, raised minimum version of a runtime or dependency, and
deprecation is its own record, even when many of them sit in one list.`,
};
export const ANCHOR = "If nothing qualifies, output [].";
export const withAddendum = (prompt: string, name: string | undefined): string => {
  if (!name) return prompt;
  const add = ADDENDA[name];
  if (!add || !prompt.includes(ANCHOR)) throw new Error(`addendum ${name}: unknown, or anchor not found`);
  return prompt.replace(ANCHOR, `${ANCHOR}\n${add}`);
};
