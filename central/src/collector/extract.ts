// Turn a decoded response into comparable text.
// HTML becomes Markdown (headings survive for section hashing); link targets, images and
// inline formatting are dropped because they produced reader-invisible noise in the Node replay.
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import { removeElement, textContent } from "domutils";
import type { AnyNode, Document, Element } from "domhandler";
import { sortKeys } from "./normalize.ts";
import type { Format } from "./schema.ts";

export class ExtractFailure extends Error {
  readonly kind: "format_mismatch" | "selector_not_found" | "empty_text" | "parse";
  constructor(kind: ExtractFailure["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** What the response actually is, from Content-Type and the first bytes. */
export function detectFormat(contentType: string | null, text: string): Format {
  const ct = (contentType ?? "").toLowerCase();
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (ct.includes("html") || head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (ct.includes("markdown")) return "markdown";
  if (ct.includes("json")) return "json";
  if (/(rss|atom)\+xml/.test(ct) || /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:rdf)[\s>]/.test(head)) return "feed";
  if (ct.includes("xml")) return "feed";
  return "text";
}

const COMPATIBLE: Record<Format, readonly Format[]> = {
  markdown: ["markdown", "text"],
  text: ["text", "markdown"],
  html: ["html"],
  json: ["json"],
  feed: ["feed"],
};

export interface ExtractSpec {
  format: Format;
  selector?: string | undefined;
  remove: readonly string[];
}

export function extract(spec: ExtractSpec, contentType: string | null, text: string): string {
  const actual = detectFormat(contentType, text);
  if (!COMPATIBLE[spec.format].includes(actual)) {
    throw new ExtractFailure("format_mismatch", `expected ${spec.format}, got ${actual} (${contentType ?? "no content-type"})`);
  }
  let out: string;
  switch (spec.format) {
    case "html":
      out = htmlToMarkdown(text, spec.selector, spec.remove);
      break;
    case "json":
      out = stableJson(text);
      break;
    case "feed":
      out = feedToText(text);
      break;
    case "markdown":
    case "text":
      out = text;
      break;
  }
  if (!out.trim()) throw new ExtractFailure("empty_text", "no text after extraction");
  return out;
}

// ---- HTML -------------------------------------------------------------------------------

const SKIP = new Set([
  "head", "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "embed",
  "button", "select", "input", "textarea", "form", "img", "picture", "video", "audio", "source",
]);
/** Removed only when no content selector is given: page chrome around the content. */
const CHROME = ["nav", "footer", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[hidden]", "[aria-hidden=true]"];
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "figure", "figcaption", "details", "summary",
  "dl", "dt", "dd", "address", "nav", "aside", "body", "html", "center", "fieldset", "legend", "caption",
]);

export function htmlToMarkdown(html: string, selector: string | undefined, remove: readonly string[]): string {
  const doc = parseDocument(html, { decodeEntities: true });
  for (const sel of [...remove, ...(selector ? [] : CHROME)]) {
    for (const el of selectAll(sel, doc)) removeElement(el);
  }
  let roots: AnyNode[];
  if (selector) {
    roots = selectAll(selector, doc);
    if (roots.length === 0) throw new ExtractFailure("selector_not_found", `selector ${selector} matched nothing`);
  } else {
    const el = selectOne("main", doc) ?? selectOne("article", doc) ?? selectOne("[role=main]", doc) ?? selectOne("body", doc);
    roots = [el ?? (doc as Document)];
  }
  return tidy(roots.map((r) => render(r, { pre: false })).join("\n\n"));
}

interface Ctx {
  pre: boolean;
}

function render(node: AnyNode, ctx: Ctx): string {
  if (node.type === "text") {
    const t = (node as unknown as { data: string }).data;
    return ctx.pre ? t : t.replace(/\s+/g, " ");
  }
  if (node.type === "root") return children(node as unknown as Element, ctx);
  if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return "";
  const el = node as Element;
  const tag = el.name.toLowerCase();
  if (SKIP.has(tag) || "hidden" in el.attribs) return "";
  const h = /^h([1-6])$/.exec(tag);
  if (h) return `\n\n${"#".repeat(Number(h[1]))} ${inline(el)}\n\n`;
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "pre":
      return `\n\n\`\`\`\n${textContent(el).replace(/\n+$/, "")}\n\`\`\`\n\n`;
    case "code":
      return ctx.pre ? textContent(el) : `\`${textContent(el).replace(/\s+/g, " ")}\``;
    case "ul":
    case "ol":
      return `\n\n${list(el, tag === "ol", ctx)}\n\n`;
    case "blockquote":
      return `\n\n${tidy(children(el, ctx)).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
    case "table":
      return `\n\n${table(el)}\n\n`;
    case "li":
      return `\n\n- ${tidy(children(el, ctx))}\n\n`;
  }
  const inner = children(el, ctx);
  return BLOCK.has(tag) ? `\n\n${inner}\n\n` : inner;
}

function children(el: Element | Document, ctx: Ctx): string {
  return el.children.map((c) => render(c, ctx)).join("");
}

function inline(el: Element): string {
  return tidy(children(el, { pre: false })).replace(/\s*\n\s*/g, " ");
}

function list(el: Element, ordered: boolean, ctx: Ctx): string {
  let n = 0;
  const items: string[] = [];
  for (const c of el.children) {
    if (c.type !== "tag" || (c as Element).name.toLowerCase() !== "li") continue;
    n++;
    const body = tidy(children(c as Element, ctx));
    const marker = ordered ? `${n}. ` : "- ";
    const pad = " ".repeat(marker.length);
    items.push(marker + body.split("\n").map((l, i) => (i === 0 || !l ? l : pad + l)).join("\n"));
  }
  return items.join("\n");
}

function table(el: Element): string {
  const rows = selectAll("tr", el).filter((tr) => closestTable(tr) === el);
  const lines: string[] = [];
  rows.forEach((tr, i) => {
    const cells = tr.children
      .filter((c): c is Element => c.type === "tag" && ["td", "th"].includes((c as Element).name.toLowerCase()))
      .map((c) => inline(c).replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0) lines.push(`|${cells.map(() => " --- ").join("|")}|`);
  });
  return lines.join("\n");
}

function closestTable(node: AnyNode): AnyNode | null {
  let p = node.parent;
  while (p && !(p.type === "tag" && (p as Element).name.toLowerCase() === "table")) p = p.parent;
  return p;
}

/** Collapse whitespace between blocks; trim line ends. Code fences are left intact. */
export function tidy(s: string): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of s.split("\n")) {
    if (raw.trimStart().startsWith("```")) fence = !fence;
    let line: string;
    if (fence) {
      line = raw.replace(/\s+$/, "");
    } else {
      // Indentation of two or more spaces is list nesting we produced; a single space is HTML whitespace.
      const [, lead = "", rest = ""] = /^([ \t]*)(.*)$/.exec(raw) ?? [];
      const indent = lead.replace(/\t/g, "  ");
      line = (indent.length >= 2 ? indent : "") + rest.replace(/[ \t]+/g, " ").replace(/\s+$/, "");
    }
    if (!fence && line === "" && out.at(-1) === "") continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ---- JSON and feeds ---------------------------------------------------------------------

export function stableJson(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ExtractFailure("parse", `invalid JSON: ${(e as Error).message}`);
  }
  return JSON.stringify(sortKeys(value), null, 2);
}


/** One block per RSS item or Atom entry (title, link, id, date), or a sitemap's sorted URLs. Feed-level metadata is ignored. */
export function feedToText(xml: string): string {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  // Sitemaps: the set of page URLs (lastmod is unreliable as a change signal, so it is left out).
  if (selectOne("urlset, sitemapindex", doc)) {
    return [...new Set(selectAll("loc", doc).map((l) => textContent(l).trim()))].sort().join("\n");
  }
  const items = selectAll("item, entry", doc);
  if (items.length === 0 && !selectOne("rss, feed, rdf\\:RDF, channel", doc)) {
    throw new ExtractFailure("parse", "not an RSS or Atom feed");
  }
  return items
    .map((it) => {
      const field = (sel: string) => {
        const el = selectOne(sel, it);
        return el ? tidy(textContent(el)).replace(/\s*\n\s*/g, " ") : "";
      };
      const linkEl = (selectOne("link[rel=alternate], link:not([rel])", it) ?? selectOne("link", it)) as Element | null;
      const link = linkEl?.attribs["href"] ?? (linkEl ? textContent(linkEl).trim() : "");
      return [`## ${field("title")}`, link, field("guid, id"), field("pubDate, updated, published, dc\\:date")]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
