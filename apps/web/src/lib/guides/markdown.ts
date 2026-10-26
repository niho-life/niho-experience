import { GUIDE_SLUG } from "./frontmatter";
import type { Block, Inline, TableCell } from "./types";
import { guideImageSrc, guideLinkHref } from "./urls";

/**
 * The Markdown subset of docs/content/guides.md, parsed into the typed tree in ./types.
 * There is no HTML: `<b>` stays the text "<b>". Anything outside the subset is either plain text
 * (an unsupported link) or a problem that keeps the file from being published (an h1, an unclosed `:::note`).
 */

type Line = { text: string; no: number };
type Context = "top" | "note" | "faq";
type State = {
  problems: string[];
  images: string[];
  headings: { id: string; text: string }[];
  usedIds: Set<string>;
  tableLabels: Map<string, number>;
  lastHeading: string | null;
  faqSeen: boolean;
};

export type ParsedBody = { blocks: Block[]; headings: { id: string; text: string }[]; images: string[]; problems: string[] };

/** Ids the page itself uses next to the article's headings. */
const RESERVED_IDS = ["main", "faq", "on-this-page", "experiences-in-this-guide", "more-guides"];

export function parseGuideBody(body: string, firstLineNumber = 1): ParsedBody {
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((text, index) => ({ text: text.replace(/\t/g, "  "), no: firstLineNumber + index }));
  const state: State = { problems: [], images: [], headings: [], usedIds: new Set(RESERVED_IDS), tableLabels: new Map(), lastHeading: null, faqSeen: false };
  const blocks = parseBlocks(lines, "top", state);
  if (!blocks.length && !state.problems.length) state.problems.push("the article has no body text");
  return { blocks, headings: state.headings, images: state.images, problems: state.problems };
}

const blank = (line: Line | undefined) => !line || !line.text.trim();
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const UL_ITEM = /^[-*]\s+(.*)$/;
const OL_ITEM = /^\d{1,9}[.)]\s+(.*)$/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)$/;
const CITE = /^(?:—|–|--)\s*(.+)$/;

function isTableStart(lines: Line[], index: number): boolean {
  return Boolean(lines[index]?.text.trim().startsWith("|") && lines[index + 1] && isTableSeparator(lines[index + 1]!.text));
}

/** True for a line that begins a block other than a paragraph (it ends the paragraph or list item above it). */
function startsBlock(lines: Line[], index: number): boolean {
  const text = lines[index]!.text.trim();
  return HEADING.test(text) || text.startsWith(":::") || text.startsWith(">") || IMAGE_LINE.test(text) || isTableStart(lines, index);
}

function parseBlocks(lines: Line[], context: Context, state: State): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const text = line.text.trim();
    if (!text) {
      i += 1;
      continue;
    }
    const at = `line ${line.no}`;

    if (text.startsWith(":::")) {
      const directive = text.slice(3).trim();
      const name = directive.split(/\s+/)[0] ?? "";
      if (!directive) {
        state.problems.push(`${at}: ":::" closes nothing`);
        i += 1;
        continue;
      }
      if (name === "experience") {
        const slug = directive.slice(name.length).trim();
        if (context !== "top") state.problems.push(`${at}: ":::experience" cannot be inside :::note or :::faq`);
        else if (!GUIDE_SLUG.test(slug)) state.problems.push(`${at}: ":::experience" needs one experience slug`);
        else blocks.push({ type: "experience", slug });
        i += 1;
        continue;
      }
      if (name === "note" || name === "faq") {
        const close = lines.findIndex((candidate, index) => index > i && candidate.text.trim() === ":::");
        const inner = lines.slice(i + 1, close < 0 ? lines.length : close);
        if (close < 0) state.problems.push(`${at}: ":::${name}" is never closed with ":::"`);
        if (directive !== name) state.problems.push(`${at}: ":::${name}" takes nothing after it`);
        if (context !== "top") state.problems.push(`${at}: ":::${name}" cannot be inside another block`);
        else if (name === "note") {
          const noteBlocks = parseBlocks(inner, "note", state);
          if (noteBlocks.length) blocks.push({ type: "note", blocks: noteBlocks });
          else state.problems.push(`${at}: ":::note" is empty`);
        } else {
          if (state.faqSeen) state.problems.push(`${at}: only one ":::faq" per article`);
          state.faqSeen = true;
          const faq = parseFaq(inner, line, state);
          if (faq) blocks.push(faq);
        }
        i = close < 0 ? lines.length : close + 1;
        continue;
      }
      state.problems.push(`${at}: unknown block ":::${name}"`);
      i += 1;
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      const children = withoutLinks(parseInlines(heading[2]!));
      const plain = plainText(children).trim() || "Section";
      if (level === 1) state.problems.push(`${at}: "#" (h1) is not used in the body; the title is the page heading`);
      else if (level > 3) state.problems.push(`${at}: only "##" and "###" headings are supported`);
      else if (context !== "top") state.problems.push(`${at}: headings cannot be inside :::note${context === "faq" ? " (in :::faq, ### starts a question)" : ""}`);
      else if (level === 2) {
        const id = uniqueId(plain, state.usedIds);
        state.headings.push({ id, text: plain });
        state.lastHeading = plain;
        blocks.push({ type: "h2", id, text: plain, children });
      } else {
        state.lastHeading = plain;
        blocks.push({ type: "h3", text: plain, children });
      }
      i += 1;
      continue;
    }

    const image = IMAGE_LINE.exec(text);
    if (image) {
      const alt = image[1]!.trim();
      const src = guideImageSrc(image[2]!);
      if (!alt) state.problems.push(`${at}: the photo needs alt text: ![what the photo shows](${image[2]})`);
      if (!src) state.problems.push(`${at}: photo "${image[2]}" must be a site path starting with "/" or an https:// URL`);
      if (alt && src) {
        state.images.push(src);
        const caption = image[3]?.trim();
        blocks.push({ type: "figure", src, alt, caption: caption ? parseInlines(caption) : null });
      }
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      let end = i;
      while (end < lines.length && lines[end]!.text.trim().startsWith("|")) end += 1;
      blocks.push(parseTable(lines.slice(i, end), state));
      i = end;
      continue;
    }

    if (text.startsWith(">")) {
      let end = i;
      while (end < lines.length && lines[end]!.text.trim().startsWith(">")) end += 1;
      const quote = parseQuote(lines.slice(i, end).map((quoted) => quoted.text.trim().replace(/^>\s?/, "")));
      if (quote) blocks.push(quote);
      else state.problems.push(`${at}: the quote has no text`);
      i = end;
      continue;
    }

    const listKind = UL_ITEM.test(text) ? "ul" : OL_ITEM.test(text) ? "ol" : null;
    if (listKind) {
      const marker = listKind === "ul" ? UL_ITEM : OL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!.text.trim();
        if (!current) {
          // A blank line between items keeps one list; anything else after it ends the list.
          let next = i;
          while (blank(lines[next]) && next < lines.length) next += 1;
          if (next < lines.length && marker.test(lines[next]!.text.trim())) {
            i = next;
            continue;
          }
          break;
        }
        const item = marker.exec(current);
        if (item) items.push(item[1]!);
        else if (UL_ITEM.test(current) || OL_ITEM.test(current) || startsBlock(lines, i)) break;
        else items[items.length - 1] += ` ${current}`;
        i += 1;
      }
      blocks.push({ type: listKind, items: items.map((item) => parseInlines(item.trim())) });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (paragraph.length === 0 || !(startsBlock(lines, i) || UL_ITEM.test(lines[i]!.text.trim()) || OL_ITEM.test(lines[i]!.text.trim())))) {
      paragraph.push(lines[i]!.text.trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInlines(paragraph.join(" ")) });
  }
  return blocks;
}

function parseFaq(lines: Line[], opener: Line, state: State): Extract<Block, { type: "faq" }> | null {
  const items: { question: string; questionInlines: Inline[]; answer: Line[]; no: number }[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    const question = /^###\s+(.+?)\s*$/.exec(text);
    if (question) {
      items.push({ question: "", questionInlines: withoutLinks(parseInlines(question[1]!)), answer: [], no: line.no });
      continue;
    }
    if (!text) {
      items.at(-1)?.answer.push(line);
      continue;
    }
    if (!items.length) {
      state.problems.push(`line ${line.no}: in ":::faq", start each question with "### "`);
      continue;
    }
    items.at(-1)!.answer.push(line);
  }
  if (!items.length) {
    state.problems.push(`line ${opener.no}: ":::faq" has no "### " questions`);
    return null;
  }
  return {
    type: "faq",
    items: items.map((item) => {
      const question = plainText(item.questionInlines).trim();
      state.lastHeading = question;
      const answer = parseBlocks(item.answer, "faq", state);
      if (!answer.length) state.problems.push(`line ${item.no}: the question "${question}" has no answer`);
      return { question, questionInlines: item.questionInlines, answer };
    }),
  };
}

function parseQuote(lines: string[]): Extract<Block, { type: "quote" }> | null {
  const content = [...lines];
  while (content.length && !content.at(-1)!.trim()) content.pop();
  const cite = content.length > 1 || (content.length === 1 && CITE.test(content[0]!.trim())) ? CITE.exec(content.at(-1)!.trim()) : null;
  if (cite) content.pop();
  const paragraphs: Inline[][] = [];
  let current: string[] = [];
  for (const line of [...content, ""]) {
    if (line.trim()) current.push(line.trim());
    else if (current.length) {
      paragraphs.push(parseInlines(current.join(" ")));
      current = [];
    }
  }
  return paragraphs.length ? { type: "quote", paragraphs, cite: cite ? parseInlines(cite[1]!) : null } : null;
}

/** `| a | b |` → ["a", "b"]. The outer pipes are optional; `\|` is a literal pipe inside a cell. */
export function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]!;
    if (char === "\\" && row[index + 1] === "|") {
      cell += "\\|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** `| --- | :---: |`: dashes with optional alignment colons (alignment is ignored). */
export function isTableSeparator(line: string): boolean {
  const text = line.trim();
  if (!text.startsWith("|")) return false;
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function parseTable(lines: Line[], state: State): Extract<Block, { type: "table" }> {
  const head = splitTableRow(lines[0]!.text).map((cell) => parseInlines(cell));
  const rows = lines.slice(2).map((line) => {
    const cells = splitTableRow(line.text).slice(0, head.length).map((cell) => parseInlines(cell));
    while (cells.length < head.length) cells.push([] as TableCell);
    return cells;
  });
  const base = state.lastHeading ?? "Table";
  const count = (state.tableLabels.get(base) ?? 0) + 1;
  state.tableLabels.set(base, count);
  return { type: "table", label: count > 1 ? `${base} (${count})` : base, head, rows };
}

/** Lowercase ASCII words joined by hyphens: "Watch the sun go down" → "watch-the-sun-go-down". */
export function headingId(text: string): string {
  const id = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return id || "section";
}

function uniqueId(text: string, used: Set<string>): string {
  const base = headingId(text);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** The words of some inline content, without the `[CONFIRM: …]` markers (for ids, the table of contents, labels). */
export function plainText(inlines: Inline[]): string {
  return inlines.map((node) => (node.type === "text" ? node.text : node.type === "confirm" ? "" : plainText(node.children))).join("").replace(/\s+/g, " ");
}

const ESCAPABLE = new Set("\\`*_[](){}#+-.!|>:~<".split(""));

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out.at(-1);
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

function pushNodes(out: Inline[], nodes: Inline[]) {
  for (const node of nodes) {
    if (node.type === "text") pushText(out, node.text);
    else out.push(node);
  }
}

/** Headings keep a link's words but not the link (a heading is itself a table-of-contents target). */
function withoutLinks(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.type === "link") pushNodes(out, withoutLinks(node.children));
    else if (node.type === "strong" || node.type === "em") out.push({ type: node.type, children: withoutLinks(node.children) });
    else pushNodes(out, [node]);
  }
  return out;
}

/** `[label](target)` starting at `start` (the `[`). Brackets and parentheses may nest. */
function matchLink(src: string, start: number): { label: string; target: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let index = start; index < src.length; index += 1) {
    const char = src[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close < 0 || src[close + 1] !== "(") return null;
  depth = 0;
  for (let index = close + 1; index < src.length; index += 1) {
    const char = src[index];
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) {
      return { label: src.slice(start + 1, close), target: src.slice(close + 2, index).trim(), end: index + 1 };
    }
  }
  return null;
}

/** Index of the marker closing emphasis that opened just before `from`, or -1. */
function findClose(src: string, from: number, strong: boolean): number {
  for (let index = from + 1; index < src.length; index += 1) {
    const char = src[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "*") continue;
    const double = src[index + 1] === "*";
    const closes = !/\s/.test(src[index - 1]!);
    if (strong) {
      if (double && closes) return index;
      if (double) index += 1;
    } else if (double) {
      // Strong text inside emphasis: skip over it. Otherwise the first star may close the emphasis.
      const inner = !/\s/.test(src[index + 2] ?? " ") ? findClose(src, index + 1, true) : -1;
      if (inner >= 0) index = inner + 1;
      else if (closes) return index;
      else index += 1;
    } else if (closes) return index;
  }
  return -1;
}

/**
 * Inline Markdown: `**strong**`, `*em*`, `[text](href)` and `[CONFIRM: …]`, with `\` escapes.
 * Links point only to a site path, an in-page anchor or an https URL; any other link keeps its text, unlinked.
 * Inline images are not supported and stay as text.
 */
export function parseInlines(src: string, allowLinks = true): Inline[] {
  const out: Inline[] = [];
  let index = 0;
  while (index < src.length) {
    const char = src[index]!;
    if (char === "\\" && ESCAPABLE.has(src[index + 1] ?? "")) {
      pushText(out, src[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "[") {
      const confirm = /^\[CONFIRM:/i.exec(src.slice(index));
      const confirmEnd = confirm ? src.indexOf("]", index) : -1;
      if (confirm && confirmEnd > 0) {
        out.push({ type: "confirm", text: src.slice(index + confirm[0].length, confirmEnd).trim() });
        index = confirmEnd + 1;
        continue;
      }
      const link = allowLinks ? matchLink(src, index) : null;
      if (link) {
        const href = /\s/.test(link.target) ? null : guideLinkHref(link.target);
        const children = parseInlines(link.label, false);
        if (href && children.length) out.push({ type: "link", href, children });
        else pushNodes(out, children);
        index = link.end;
        continue;
      }
    }
    if (char === "!" && src[index + 1] === "[") {
      const image = matchLink(src, index + 1);
      if (image) {
        pushText(out, src.slice(index, image.end));
        index = image.end;
        continue;
      }
    }
    if (char === "*") {
      const strong = src[index + 1] === "*";
      const width = strong ? 2 : 1;
      const start = index + width;
      if (start < src.length && !/\s/.test(src[start]!)) {
        const close = findClose(src, start - 1, strong);
        if (close > start) {
          out.push({ type: strong ? "strong" : "em", children: parseInlines(src.slice(start, close), allowLinks) });
          index = close + width;
          continue;
        }
      }
      pushText(out, src.slice(index, start));
      index = start;
      continue;
    }
    pushText(out, char);
    index += 1;
  }
  return out;
}
