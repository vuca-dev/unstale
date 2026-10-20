// Slice 3c experiment 5 (recall hill-climb): prompt additions inserted after EXTRACT_PROMPT's "If nothing qualifies" line.
// Designed from the misses' kinds (removals, raised minimum versions and default changes inside long lists), checked on
// DEV documents before one look at H1 + H2.
export const ADDENDA: Record<string, string> = {
  lists: `Long notes and upgrade guides often hold dozens of such changes. Treat every bullet, numbered item and table row as a
candidate: each removal, renamed or moved API, changed default, raised minimum version of a runtime or dependency, and
deprecation is its own record, even when many of them sit in one list.`,
};
export const ANCHOR = "If nothing qualifies, output [].";
// Slice 11 (eval/select/slice11/PREREG.md): DEV revisions of the extract prompt for minimax/minimax-m3.1-flash. Each
// replaces EXTRACT_PROMPT's evidence field (and, from r2 on, may add a line after the anchor); the label prompt is unchanged.
export const EVIDENCE_LINE = ` "evidence": a sentence or phrase copied verbatim from the notes that supports the record`;
export const REVISIONS: Record<string, { evidence: string; add?: string }> = {
  "mm-r1": {
    evidence: ` "evidence": copied verbatim from the notes: the sentence, list item or table row that states this change itself
             (what is new, removed, renamed, required or now fails). Not a heading, and not a sentence that only
             introduces several changes; when the notes follow the statement with what to do about it, copy both`,
  },
  // r2 (after r1's DEV run): r1's statement quotes carried markdown link URLs ("[custom `webpack`](/docs/…) configuration"),
  // which made four statements no longer read as the page reads. r2 = r1 + copy a link as its text.
  "mm-r2": {
    evidence: ` "evidence": copied verbatim from the notes: the sentence, list item or table row that states this change itself
             (what is new, removed, renamed, required or now fails). Not a heading, and not a sentence that only
             introduces several changes; when the notes follow the statement with what to do about it, copy both.
             Copy a markdown link as its text alone, without the URL`,
  },
  // r3 (after r2's DEV run): r2 still copied link URLs into four statement quotes (the field's last sentence was not
  // followed). r3 = r2 + the rule restated after the task, with an example.
  "mm-r3": {
    evidence: ` "evidence": copied verbatim from the notes: the sentence, list item or table row that states this change itself
             (what is new, removed, renamed, required or now fails). Not a heading, and not a sentence that only
             introduces several changes; when the notes follow the statement with what to do about it, copy both.
             Copy a markdown link as its text alone, without the URL`,
    add: `In "evidence", write every markdown link as its text only and change nothing else: the notes' line
"The [\`timeout\`](/docs/api/options#timeout) option now defaults to [30 seconds](/docs/limits)." is copied as
"The \`timeout\` option now defaults to 30 seconds."`,
  },
};
export const withAddendum = (prompt: string, name: string | undefined): string => {
  if (!name) return prompt;
  const rev = REVISIONS[name];
  if (rev) {
    if (!prompt.includes(EVIDENCE_LINE)) throw new Error(`revision ${name}: evidence line not found`);
    const p = prompt.replace(EVIDENCE_LINE, rev.evidence);
    return rev.add ? p.replace(ANCHOR, `${ANCHOR}\n${rev.add}`) : p;
  }
  const add = ADDENDA[name];
  if (!add || !prompt.includes(ANCHOR)) throw new Error(`addendum ${name}: unknown, or anchor not found`);
  return prompt.replace(ANCHOR, `${ANCHOR}\n${add}`);
};
