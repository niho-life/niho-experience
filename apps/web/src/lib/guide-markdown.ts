import { safeHttpsUrl } from "./safe-url";

/**
 * The small Markdown subset that guide bodies are written in (docs/content/guides.md):
 *
 * - `## Heading` and `### Heading` (the page title is the only h1)
 * - paragraphs (consecutive lines join into one; a blank line ends a block)
 * - `- item` lists and `1. item` lists (numbered 1, 2, 3 …; one line per item, no nesting)
 * - a photo on a line of its own: `![alt](src)` or `![alt](src "caption")`, src following {@link guideLinkHref}
 * - a pipe table: a header row, a `| --- |` separator row, then body rows (the first cell of each row is its heading)
 * - a `:::note` … `:::` box holding paragraphs and lists only
 * - inline `**bold**`, `*italic*`, `[text](href)` (href is a site path or an https URL) and `[CONFIRM: fact to check]`
 * - `\` before punctuation for a literal character (`\*`, `\[`, `\_`, `\|`)
 *
 * Anything else (raw HTML, inline images, code, quotes, `_emphasis_`, entities, other link forms, malformed tables or
 * boxes) throws a {@link GuideMarkdownError} with the line, so a guide that would render differently from what its author
 * wrote fails the unit test (guides.test.ts), or keeps a draft off the preview, instead of reaching the page. The result
 * is a plain tree that `components/GuideBody.tsx` maps to React elements: no HTML string is ever produced or injected.
 */

export type GuideInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: GuideInline[] }
  | { type: "em"; children: GuideInline[] }
  | { type: "link"; href: string; external: boolean; children: GuideInline[] }
  /** `[CONFIRM: …]`: a fact still to check. Shown as a mark in drafts; a published guide may not keep one (guidePublishProblems). */
  | { type: "confirm"; value: string };

/** The blocks a `:::note` box may hold. */
export type GuideTextBlock =
  | { type: "paragraph"; children: GuideInline[] }
  | { type: "list"; ordered: boolean; items: GuideInline[][] };

export type GuideBlock =
  | { type: "heading"; level: 2 | 3; children: GuideInline[] }
  | GuideTextBlock
  | { type: "figure"; src: string; external: boolean; alt: string; caption: GuideInline[] | null }
  /** `label` names the table's scroll region: the nearest heading above it, else "Table" (numbered when repeated). */
  | { type: "table"; label: string; head: GuideInline[][]; rows: GuideInline[][][] }
  | { type: "note"; blocks: GuideTextBlock[] };

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
const CONFIRM_OPEN = "[CONFIRM:";

/**
 * A link or photo target a guide may use: a site path (`/experiences/x`, with an optional query or fragment) or an https
 * URL without credentials. Protocol-relative (`//host`), relative (`page`), `http:`, `mailto:`, `javascript:`, `data:` and
 * the like are refused.
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

/** Index of the `]` that closes the bracket opened at `start` (the `[`), skipping escaped characters. */
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

/** Inline source that must stay plain text (alt text, a `[CONFIRM: …]` note): escapes are resolved, formatting is refused. */
function plainInline(source: string, line: number, what: string): string {
  const nodes = parseGuideInline(source, line, true);
  if (nodes.some((node) => node.type !== "text")) throw new GuideMarkdownError(`${what} is plain text: no bold, italic or links`, line);
  return guideInlineText(nodes);
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
    if (char === "!" && next === "[") throw new GuideMarkdownError("A photo goes on a line of its own: ![alt](/path \"caption\")", line);
    if (char === "_") throw new GuideMarkdownError("Use *italic* or **bold**; write \\_ for a literal underscore", line);
    if (char === "~" && next === "~") throw new GuideMarkdownError("Strikethrough (~~) is not supported", line);
    if (char === "]") throw new GuideMarkdownError("Unmatched ]; write \\] for a literal bracket", line);
    if (char === "[" && text.startsWith(CONFIRM_OPEN, i)) {
      const close = closingBracket(text, i, line);
      const value = plainInline(text.slice(i + CONFIRM_OPEN.length, close), line, "[CONFIRM: …]").replace(/\s+/g, " ").trim();
      if (!value) throw new GuideMarkdownError("[CONFIRM: …] needs the fact to check", line);
      top().children.push({ type: "confirm", value });
      i = close + 1;
      continue;
    }
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

/**
 * A FAQ answer: one paragraph with the inline subset (bold, italic, links, `[CONFIRM: …]`). Lines join with a space, as
 * in a body paragraph; a blank line inside the answer is refused. Line numbers count from the answer's first line.
 */
export function parseGuideAnswer(source: string): GuideInline[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const first = lines.findIndex(Boolean);
  if (first === -1) return [];
  const last = lines.findLastIndex(Boolean);
  const blank = lines.slice(first, last + 1).findIndex((line) => !line);
  if (blank !== -1) throw new GuideMarkdownError("An answer is one paragraph: remove the blank line", first + blank + 1);
  return parseGuideInline(lines.slice(first, last + 1).join(" "), first + 1);
}

type SourceLine = { text: string; no: number };
/** Shared across the top level: the latest heading names the tables below it. */
type TableLabels = { heading: string; used: Map<string, number> };

const HEADING = /^(#+)(\s+)(.*)$/;
const BULLET = /^-\s+(.*)$/;
const NUMBERED = /^(\d{1,3})\.\s+(.*)$/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

/** Block-level syntax that has no place in a guide body. */
function unsupportedBlock(line: string): string | null {
  if (/^(?:```|~~~)/.test(line)) return "Code blocks are not supported";
  if (line.startsWith(">")) return "Block quotes are not supported";
  if (line.startsWith("<")) return "Raw HTML is not supported";
  if (/^[*+]\s/.test(line)) return "Start list items with \"- \"";
  if (/^\d{1,3}\)\s/.test(line)) return "Number list items as \"1. \"";
  if (/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+\s*)$/.test(line)) return "Horizontal rules and underlined headings are not supported";
  if (/^\[[^\]]*\]:/.test(line)) return "Reference links and footnotes are not supported";
  if (/^(?:-|\d{1,3}\.)$/.test(line)) return "A list item needs text";
  return null;
}

/** `![alt](src)` or `![alt](src "caption")` alone on its line. */
function parseFigure(line: string, no: number): Extract<GuideBlock, { type: "figure" }> {
  const close = closingBracket(line, 1, no);
  const usage = "Write a photo alone on its line as ![alt](/path) or ![alt](/path \"caption\")";
  if (line[close + 1] !== "(" || !line.endsWith(")")) throw new GuideMarkdownError(usage, no);
  const target = /^(\S+)(?:\s+"(.*)")?$/.exec(line.slice(close + 2, -1));
  if (!target) throw new GuideMarkdownError(usage, no);
  const alt = plainInline(line.slice(2, close), no, "Alt text").trim();
  if (!alt) throw new GuideMarkdownError("A photo needs alt text: ![what the photo shows](/path)", no);
  const src = guideLinkHref(target[1]!);
  if (!src) throw new GuideMarkdownError(`Unsafe or unsupported photo "${target[1]}": use a site path (/guides/…) or an https:// URL`, no);
  const captionSource = target[2]?.trim() ?? "";
  if (target[2] !== undefined && !captionSource) throw new GuideMarkdownError("An empty caption: write the caption between the quotes, or leave the quotes out", no);
  return { type: "figure", src: src.href, external: src.external, alt, caption: captionSource ? parseGuideInline(captionSource, no) : null };
}

/** `| a | b |` → ["a", "b"]. The closing pipe is optional; `\|` stays escaped for the inline parser (a literal pipe). */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 1; i < row.length; i++) {
    const char = row[i]!;
    if (char === "\\" && i + 1 < row.length) {
      cell += char + row[i + 1];
      i++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

const isTableSeparator = (row: string) => {
  const cells = tableCells(row);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
};

function parseTable(rows: SourceLine[], label: string): Extract<GuideBlock, { type: "table" }> {
  const [header, separator, ...body] = rows as [SourceLine, ...SourceLine[]];
  if (isTableSeparator(header.text)) throw new GuideMarkdownError("A table starts with its header row, then the | --- | separator row", header.no);
  const headCells = tableCells(header.text);
  if (!headCells.length) throw new GuideMarkdownError("A table row needs cells: | a | b |", header.no);
  if (!separator || !isTableSeparator(separator.text)) {
    throw new GuideMarkdownError("Put a separator row (| --- | --- |) right under the table's header row", separator?.no ?? header.no);
  }
  const width = headCells.length;
  const separatorCells = tableCells(separator.text).length;
  if (separatorCells !== width) throw new GuideMarkdownError(`The separator row has ${separatorCells} cells; the header row has ${width}`, separator.no);
  // The top-left corner may stay empty (the row headings below it name themselves); every column heading needs text.
  if (headCells.some((cell, i) => i > 0 && !cell)) throw new GuideMarkdownError("Every column header cell needs text (only the top-left corner may be empty)", header.no);
  if (!body.length) throw new GuideMarkdownError("A table needs at least one row under the separator row", separator.no);
  return {
    type: "table",
    label,
    head: headCells.map((cell) => parseGuideInline(cell, header.no)),
    rows: body.map((row) => {
      if (isTableSeparator(row.text)) throw new GuideMarkdownError("A table has one separator row, right under the header row", row.no);
      const cells = tableCells(row.text);
      if (cells.length > width) throw new GuideMarkdownError(`This row has ${cells.length} cells; the header row has ${width}`, row.no);
      if (!cells[0]) throw new GuideMarkdownError("The first cell of a row is the row's heading and needs text", row.no);
      while (cells.length < width) cells.push("");
      return cells.map((cell) => parseGuideInline(cell, row.no));
    }),
  };
}

function tableLabel(labels: TableLabels): string {
  const base = labels.heading || "Table";
  const count = (labels.used.get(base) ?? 0) + 1;
  labels.used.set(base, count);
  return count > 1 ? `${base} (${count})` : base;
}

/** Blocks of the body (`labels` set) or of a `:::note` box (`labels` null: paragraphs and lists only). */
function parseBlocks(lines: readonly SourceLine[], labels: TableLabels | null): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  let paragraph: { start: number; lines: string[] } | null = null;
  let list: { ordered: boolean; items: GuideInline[][] } | null = null;

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
  const closeBlocks = () => {
    closeParagraph();
    closeList();
  };
  const outsideNote = (what: string, no: number): TableLabels => {
    if (!labels) throw new GuideMarkdownError(`A :::note box holds only paragraphs and lists, not ${what}`, no);
    return labels;
  };

  let index = 0;
  while (index < lines.length) {
    const { text: line, no } = lines[index]!;
    index++;
    if (!line.trim()) {
      closeBlocks();
      continue;
    }
    if (/^\s/.test(line)) throw new GuideMarkdownError("Indented lines are not supported (no nested lists or code blocks)", no);

    if (line.startsWith(":::")) {
      const name = line.slice(3).trim();
      if (!name) throw new GuideMarkdownError("\":::\" closes nothing: open a box with \":::note\"", no);
      if (name === "faq") throw new GuideMarkdownError("Questions go in the guide's faq, not in the body", no);
      if (name !== "note") throw new GuideMarkdownError(`Unknown block ":::${name}": only ":::note" is supported`, no);
      outsideNote("another :::note", no);
      closeBlocks();
      const end = lines.findIndex((candidate, at) => at >= index && candidate.text.trim() === ":::");
      if (end === -1) throw new GuideMarkdownError("\":::note\" is never closed: end the box with a line \":::\"", no);
      const inner = parseBlocks(lines.slice(index, end), null) as GuideTextBlock[];
      if (!inner.length) throw new GuideMarkdownError("The :::note box is empty", no);
      blocks.push({ type: "note", blocks: inner });
      index = end + 1;
      continue;
    }

    const unsupported = unsupportedBlock(line);
    if (unsupported) throw new GuideMarkdownError(unsupported, no);

    if (line.startsWith("#")) {
      const heading = HEADING.exec(line);
      if (!heading) throw new GuideMarkdownError("Write headings as \"## Heading\" (a space after the #)", no);
      const level = heading[1]!.length;
      if (level === 1) throw new GuideMarkdownError("The guide title is the page's only h1: use ## or ### in the body", no);
      if (level > 3) throw new GuideMarkdownError("Only ## and ### headings are supported", no);
      const text = heading[3]!.trim();
      if (!text) throw new GuideMarkdownError("A heading needs text", no);
      if (/\s#+$/.test(text)) throw new GuideMarkdownError("Closing # after a heading is not supported", no);
      const top = outsideNote("headings", no);
      closeBlocks();
      const children = parseGuideInline(text, no);
      top.heading = guideInlineText(children).replace(/\s+/g, " ").trim();
      blocks.push({ type: "heading", level: level as 2 | 3, children });
      continue;
    }

    if (line.startsWith("![")) {
      outsideNote("photos", no);
      closeBlocks();
      blocks.push(parseFigure(line, no));
      continue;
    }

    if (line.startsWith("|")) {
      const top = outsideNote("tables", no);
      closeBlocks();
      let end = index - 1;
      while (end < lines.length && lines[end]!.text.startsWith("|")) end++;
      const after = lines[end];
      if (after?.text.trim()) throw new GuideMarkdownError("Leave a blank line after a table; every table row starts with |", after.no);
      blocks.push(parseTable(lines.slice(index - 1, end), tableLabel(top)));
      index = end;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const text = (bullet ? bullet[1] : numbered![2])!.trim();
      if (!text) throw new GuideMarkdownError("A list item needs text", no);
      closeParagraph();
      const current = list as { ordered: boolean; items: GuideInline[][] } | null;
      if (current && current.ordered !== ordered) throw new GuideMarkdownError("Leave a blank line between a - list and a 1. list", no);
      const expected = (current?.items.length ?? 0) + 1;
      if (numbered && Number(numbered[1]) !== expected) throw new GuideMarkdownError(`Number this item ${expected}. (numbered lists count 1, 2, 3 …)`, no);
      const items = current?.items ?? [];
      items.push(parseGuideInline(text, no));
      list = current ?? { ordered, items };
      continue;
    }

    if (list) throw new GuideMarkdownError("Leave a blank line after a list; list items are one line each", no);
    if (paragraph) (paragraph as { start: number; lines: string[] }).lines.push(line.trim());
    else paragraph = { start: no, lines: [line.trim()] };
  }
  closeBlocks();
  return blocks;
}

/** Parse a guide body. Throws {@link GuideMarkdownError} on anything outside the subset. */
export function parseGuideMarkdown(source: string): GuideBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map((text, index) => ({ text: text.trimEnd(), no: index + 1 }));
  return parseBlocks(lines, { heading: "", used: new Map() });
}

/** The words of inline content (for checks and labels). `[CONFIRM: …]` notes are left out: they are not the guide's text. */
export function guideInlineText(children: readonly GuideInline[]): string {
  return children.map((child) => (child.type === "text" ? child.value : child.type === "confirm" ? "" : guideInlineText(child.children))).join("");
}

/** Every photo in parsed blocks, in order (publish checks). */
export function guideFigureSources(blocks: readonly GuideBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "figure" ? [block.src] : []));
}
