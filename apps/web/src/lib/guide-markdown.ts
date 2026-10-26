import { safeHttpsUrl } from "./safe-url";

/**
 * The small Markdown subset that guide bodies are written in (docs/content/guides.md):
 *
 * - `## Heading` and `### Heading` (the page title is the only h1)
 * - paragraphs (consecutive lines join into one; a blank line ends a block)
 * - `- item` lists and `1. item` lists (numbered 1, 2, 3 …; one line per item, no nesting)
 * - inline `**bold**`, `*italic*` and `[text](href)`, where href is a site path (`/experiences/…`) or an https URL
 * - `\` before punctuation for a literal character (`\*`, `\[`, `\_`)
 *
 * Anything else (raw HTML, images, code, quotes, tables, `_emphasis_`, entities, other link forms) throws a
 * {@link GuideMarkdownError} with the line, so a guide that would render differently from what its author wrote
 * fails the unit test (guides.test.ts) instead of reaching the page. The result is a plain tree that
 * `components/GuideBody.tsx` maps to React elements: no HTML string is ever produced or injected.
 */

export type GuideInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: GuideInline[] }
  | { type: "em"; children: GuideInline[] }
  | { type: "link"; href: string; external: boolean; children: GuideInline[] };

export type GuideBlock =
  | { type: "heading"; level: 2 | 3; children: GuideInline[] }
  | { type: "paragraph"; children: GuideInline[] }
  | { type: "list"; ordered: boolean; items: GuideInline[][] };

export class GuideMarkdownError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "GuideMarkdownError";
    this.line = line;
  }
}

const SITE_BASE = "https://guide-link.invalid";
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * A link target a guide may use: a site path (`/experiences/x`, with an optional query or fragment) or an https URL
 * without credentials. Protocol-relative (`//host`), relative (`page`), `http:`, `mailto:`, `javascript:` and the like are refused.
 */
export function guideLinkHref(value: string): { href: string; external: boolean } | null {
  if (!value || /[\s\\<>"'`]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return null;
    try {
      const url = new URL(value, SITE_BASE);
      return url.origin === SITE_BASE ? { href: `${url.pathname}${url.search}${url.hash}`, external: false } : null;
    } catch {
      return null;
    }
  }
  const https = safeHttpsUrl(value);
  return https ? { href: https, external: true } : null;
}

type Frame = { type: "root" | "strong" | "em"; children: GuideInline[] };

function pushText(children: GuideInline[], value: string) {
  if (!value) return;
  const last = children.at(-1);
  if (last?.type === "text") last.value += value;
  else children.push({ type: "text", value });
}

/** Index of the `]` that closes the link text opened at `start` (the `[`), skipping escaped characters. */
function closingBracket(text: string, start: number, line: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[") throw new GuideMarkdownError("Links cannot contain another [; write \\[ for a literal bracket", line);
    if (char === "]") return i;
  }
  throw new GuideMarkdownError("Unclosed [; write links as [text](/path or https://…), or \\[ for a literal bracket", line);
}

export function parseGuideInline(text: string, line: number, inLink = false): GuideInline[] {
  const stack: Frame[] = [{ type: "root", children: [] }];
  const top = () => stack.at(-1)!;
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1] ?? "";
    if (char === "\\") {
      if (!next || !PUNCTUATION.test(next)) throw new GuideMarkdownError("A backslash must escape punctuation (\\* \\[ \\_ …); line breaks are not supported", line);
      pushText(top().children, next);
      i += 2;
      continue;
    }
    if (char === "`") throw new GuideMarkdownError("Inline code (`…`) is not supported", line);
    if (char === "<" && /[A-Za-z/!?]/.test(next)) throw new GuideMarkdownError("Raw HTML and <autolinks> are not supported", line);
    if (char === "&" && /^&#?[A-Za-z0-9]+;/.test(text.slice(i))) throw new GuideMarkdownError("HTML entities are not supported; type the character itself", line);
    if (char === "!" && next === "[") throw new GuideMarkdownError("Images are not supported in the body; use the guide's hero image", line);
    if (char === "_") throw new GuideMarkdownError("Use *italic* or **bold**; write \\_ for a literal underscore", line);
    if (char === "~" && next === "~") throw new GuideMarkdownError("Strikethrough (~~) is not supported", line);
    if (char === "]") throw new GuideMarkdownError("Unmatched ]; write \\] for a literal bracket", line);
    if (char === "[") {
      if (inLink) throw new GuideMarkdownError("Links cannot be nested", line);
      const close = closingBracket(text, i, line);
      if (text[close + 1] !== "(") throw new GuideMarkdownError("Write links as [text](/path or https://…); reference links and footnotes are not supported", line);
      const end = text.indexOf(")", close + 2);
      if (end === -1) throw new GuideMarkdownError("Unclosed ( in a link", line);
      const target = text.slice(close + 2, end);
      if (/\s/.test(target)) throw new GuideMarkdownError("Link targets cannot contain spaces or titles", line);
      if (target.includes("(")) throw new GuideMarkdownError("Link targets cannot contain parentheses", line);
      const href = guideLinkHref(target);
      if (!href) throw new GuideMarkdownError(`Unsafe or unsupported link "${target}": use a site path (/experiences/…) or an https:// URL`, line);
      const children = parseGuideInline(text.slice(i + 1, close), line, true);
      if (!children.length) throw new GuideMarkdownError("A link needs text", line);
      top().children.push({ type: "link", ...href, children });
      i = end + 1;
      continue;
    }
    if (char === "*") {
      let run = 1;
      while (text[i + run] === "*") run++;
      if (run > 2) throw new GuideMarkdownError("*** is not supported; use **bold** or *italic*, or \\* for a literal asterisk", line);
      const type = run === 2 ? "strong" : "em";
      const before = text[i - 1] ?? "";
      const after = text[i + run] ?? "";
      const frame = top();
      if (frame.type === type) {
        if (!before || /\s/.test(before)) throw new GuideMarkdownError(`The closing ${"*".repeat(run)} must follow text without a space`, line);
        if (!frame.children.length) throw new GuideMarkdownError("Empty emphasis", line);
        stack.pop();
        top().children.push({ type, children: frame.children });
      } else {
        if (stack.some((open) => open.type === type)) throw new GuideMarkdownError("Bold and italic must close in the order they open", line);
        if (!after || /\s/.test(after)) throw new GuideMarkdownError(`The opening ${"*".repeat(run)} must touch the text it marks; write \\* for a literal asterisk`, line);
        stack.push({ type, children: [] });
      }
      i += run;
      continue;
    }
    pushText(top().children, char);
    i++;
  }
  if (stack.length > 1) throw new GuideMarkdownError(`Unclosed ${top().type === "strong" ? "**" : "*"}`, line);
  return stack[0]!.children;
}

const HEADING = /^(#+)(\s+)(.*)$/;
const BULLET = /^-\s+(.*)$/;
const NUMBERED = /^(\d{1,3})\.\s+(.*)$/;

/** Block-level syntax that has no place in a guide body. */
function unsupportedBlock(line: string): string | null {
  if (/^(?:```|~~~)/.test(line)) return "Code blocks are not supported";
  if (line.startsWith(">")) return "Block quotes are not supported";
  if (line.startsWith("|")) return "Tables are not supported";
  if (line.startsWith("<")) return "Raw HTML is not supported";
  if (/^[*+]\s/.test(line)) return "Start list items with \"- \"";
  if (/^\d{1,3}\)\s/.test(line)) return "Number list items as \"1. \"";
  if (/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+\s*)$/.test(line)) return "Horizontal rules and underlined headings are not supported";
  if (/^\[[^\]]*\]:/.test(line)) return "Reference links and footnotes are not supported";
  if (/^(?:-|\d{1,3}\.)$/.test(line)) return "A list item needs text";
  return null;
}

/** Parse a guide body. Throws {@link GuideMarkdownError} on anything outside the subset. */
export function parseGuideMarkdown(source: string): GuideBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: GuideBlock[] = [];
  let paragraph: { start: number; lines: string[] } | null = null;
  let list: { ordered: boolean; items: GuideInline[][]; start: number } | null = null;

  const closeParagraph = () => {
    if (!paragraph) return;
    blocks.push({ type: "paragraph", children: parseGuideInline(paragraph.lines.join(" "), paragraph.start) });
    paragraph = null;
  };
  const closeList = () => {
    if (!list) return;
    blocks.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeParagraph();
      closeList();
      return;
    }
    if (/^\s/.test(line)) throw new GuideMarkdownError("Indented lines are not supported (no nested lists or code blocks)", lineNumber);
    const unsupported = unsupportedBlock(line);
    if (unsupported) throw new GuideMarkdownError(unsupported, lineNumber);

    if (line.startsWith("#")) {
      const heading = HEADING.exec(line);
      if (!heading) throw new GuideMarkdownError("Write headings as \"## Heading\" (a space after the #)", lineNumber);
      const level = heading[1]!.length;
      if (level === 1) throw new GuideMarkdownError("The guide title is the page's only h1: use ## or ### in the body", lineNumber);
      if (level > 3) throw new GuideMarkdownError("Only ## and ### headings are supported", lineNumber);
      const text = heading[3]!.trim();
      if (!text) throw new GuideMarkdownError("A heading needs text", lineNumber);
      if (/\s#+$/.test(text)) throw new GuideMarkdownError("Closing # after a heading is not supported", lineNumber);
      closeParagraph();
      closeList();
      blocks.push({ type: "heading", level: level as 2 | 3, children: parseGuideInline(text, lineNumber) });
      return;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const text = (bullet ? bullet[1] : numbered![2])!.trim();
      if (!text) throw new GuideMarkdownError("A list item needs text", lineNumber);
      closeParagraph();
      const current = list as { ordered: boolean; items: GuideInline[][]; start: number } | null;
      if (current && current.ordered !== ordered) throw new GuideMarkdownError("Leave a blank line between a - list and a 1. list", lineNumber);
      const expected = (current?.items.length ?? 0) + 1;
      if (numbered && Number(numbered[1]) !== expected) throw new GuideMarkdownError(`Number this item ${expected}. (numbered lists count 1, 2, 3 …)`, lineNumber);
      const items = current?.items ?? [];
      items.push(parseGuideInline(text, lineNumber));
      list = current ?? { ordered, items, start: lineNumber };
      return;
    }

    if (list) throw new GuideMarkdownError("Leave a blank line after a list; list items are one line each", lineNumber);
    if (paragraph) (paragraph as { start: number; lines: string[] }).lines.push(line.trim());
    else paragraph = { start: lineNumber, lines: [line.trim()] };
  });
  closeParagraph();
  closeList();
  return blocks;
}

/** The plain text of inline content (for checks and summaries). */
export function guideInlineText(children: readonly GuideInline[]): string {
  return children.map((child) => (child.type === "text" ? child.value : guideInlineText(child.children))).join("");
}
