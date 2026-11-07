import type { JSONContent } from "@tiptap/core";
import {
  GUIDE_ASSET_URI_PREFIX,
  GUIDE_ASSET_UUID_V4,
  guideLinkHref,
  parseGuideMarkdown,
  type GuideBlock,
  type GuideInline,
} from "@/lib/guide-markdown";

export class UnsupportedWriteContentError extends Error {
  constructor(message = "この本文には現在の編集画面で安全に扱えない内容があります。") {
    super(message);
    this.name = "UnsupportedWriteContentError";
  }
}

export function writeLinkHref(value: string): string | null {
  if (value.includes("(") || value.includes(")")) return null;
  return guideLinkHref(value)?.href ?? null;
}

function inlineToContent(inline: readonly GuideInline[], marks: NonNullable<JSONContent["marks"]> = []): JSONContent[] {
  return inline.flatMap((node): JSONContent[] => {
    if (node.type === "confirm") throw new UnsupportedWriteContentError();
    if (node.type === "text") return node.value ? [{ type: "text", text: node.value, ...(marks.length ? { marks } : {}) }] : [];
    const mark = node.type === "strong" ? { type: "bold" }
      : node.type === "em" ? { type: "italic" }
        : { type: "link", attrs: { href: node.href } };
    return inlineToContent(node.children, [...marks, mark]);
  });
}

function textNode(block: Extract<GuideBlock, { type: "paragraph" | "list" }>): JSONContent {
  if (block.type === "paragraph") return { type: "paragraph", content: inlineToContent(block.children) };
  return {
    type: block.ordered ? "orderedList" : "bulletList",
    content: block.items.map((item) => ({ type: "listItem", content: [{ type: "paragraph", content: inlineToContent(item) }] })),
  };
}

export function markdownToWriteDocument(markdown: string): JSONContent {
  const blocks = parseGuideMarkdown(markdown);
  const content = blocks.map((block): JSONContent => {
    if (block.type === "heading") return { type: "heading", attrs: { level: block.level }, content: inlineToContent(block.children) };
    if (block.type === "paragraph" || block.type === "list") return textNode(block);
    if (block.type === "figure") {
      if (block.assetId && block.caption) throw new UnsupportedWriteContentError("caption付き本文写真は現在の編集画面では扱えません。");
      return {
        type: "guideFigure",
        attrs: block.assetId
          ? { assetId: block.assetId, alt: block.alt }
          : { assetId: null, alt: block.alt, originalMarkdown: block.source },
      };
    }
    throw new UnsupportedWriteContentError();
  });
  const document = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] } satisfies JSONContent;
  writeDocumentToMarkdown(document);
  return document;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
function escapeText(value: string): string {
  if (value.includes("\n") || value.includes("\r")) throw new UnsupportedWriteContentError("本文内の改行を保存できません。段落を分けてください。");
  return value.replace(ASCII_PUNCTUATION, "\\$&");
}
type Mark = NonNullable<JSONContent["marks"]>[number];
function markKey(marks: readonly Mark[]) {
  return marks.map((mark) => `${mark.type}:${mark.type === "link" ? String(mark.attrs?.href ?? "") : ""}`).sort().join("|");
}
function marked(value: string, marks: readonly Mark[]): string {
  const types = marks.map((mark) => mark.type);
  if (new Set(types).size !== types.length || types.some((type) => !["bold", "italic", "link"].includes(type))) throw new UnsupportedWriteContentError("未対応の文字装飾があります。");
  if (types.includes("bold") && types.includes("italic")) throw new UnsupportedWriteContentError("同じ文字に太字と斜体を重ねることはできません。");
  const leading = value.match(/^\s+/)?.[0] ?? "";
  const trailing = value.match(/\s+$/)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length || undefined);
  if (!core) return escapeText(value);
  let rendered = escapeText(core);
  if (types.includes("italic")) rendered = `*${rendered}*`;
  if (types.includes("bold")) rendered = `**${rendered}**`;
  const link = marks.find((mark) => mark.type === "link");
  if (link) {
    const href = typeof link.attrs?.href === "string" ? writeLinkHref(link.attrs.href) : null;
    if (!href) throw new UnsupportedWriteContentError("安全でないリンクがあります。");
    rendered = `[${rendered}](${href})`;
  }
  return `${escapeText(leading)}${rendered}${escapeText(trailing)}`;
}
function inline(content: JSONContent[] | undefined): string {
  if (!content?.length) return "";
  const merged: Array<{ text: string; marks: Mark[] }> = [];
  for (const node of content) {
    if (node.type !== "text" || typeof node.text !== "string" || node.content?.length) throw new UnsupportedWriteContentError("本文に未対応の要素があります。");
    const marks = node.marks ?? [];
    const previous = merged.at(-1);
    if (previous && markKey(previous.marks) === markKey(marks)) previous.text += node.text;
    else merged.push({ text: node.text, marks: [...marks] });
  }
  return merged.map(({ text, marks }) => marked(text, marks)).join("");
}
function list(node: JSONContent, ordered: boolean): string {
  if (!node.content?.length) throw new UnsupportedWriteContentError("空のリストは保存できません。");
  return node.content.map((item, index) => {
    if (item.type !== "listItem" || item.content?.length !== 1 || item.content[0]?.type !== "paragraph") throw new UnsupportedWriteContentError("入れ子のリストは保存できません。");
    const text = inline(item.content[0].content);
    if (!text.trim()) throw new UnsupportedWriteContentError("空のリスト項目は保存できません。");
    return `${ordered ? `${index + 1}.` : "-"} ${text}`;
  }).join("\n");
}
function figure(node: JSONContent): string {
  const assetId = node.attrs?.assetId;
  const alt = node.attrs?.alt;
  if (assetId === null && typeof node.attrs?.originalMarkdown === "string") return node.attrs.originalMarkdown;
  if (typeof assetId !== "string" || !GUIDE_ASSET_UUID_V4.test(assetId) || typeof alt !== "string" || !alt.trim()) throw new UnsupportedWriteContentError("本文写真のassetまたは英語altが不正です。");
  if (alt.trim().length > 300) throw new UnsupportedWriteContentError("本文写真の英語altは300文字以内にしてください。");
  return `![${escapeText(alt.trim())}](${GUIDE_ASSET_URI_PREFIX}${assetId})`;
}

export function writeDocumentToMarkdown(document: JSONContent): string {
  if (document.type !== "doc") throw new UnsupportedWriteContentError();
  const blocks = (document.content ?? []).flatMap((node): string[] => {
    if (node.type === "paragraph") { const text = inline(node.content); return text ? [text] : []; }
    if (node.type === "heading") {
      const level = node.attrs?.level;
      if (level !== 2 && level !== 3) throw new UnsupportedWriteContentError("本文の見出しは H2 または H3 にしてください。");
      const text = inline(node.content);
      if (!text.trim()) throw new UnsupportedWriteContentError("空の見出しは保存できません。");
      return [`${"#".repeat(level)} ${text}`];
    }
    if (node.type === "bulletList") return [list(node, false)];
    if (node.type === "orderedList") return [list(node, true)];
    if (node.type === "guideFigure") return [figure(node)];
    throw new UnsupportedWriteContentError();
  });
  const markdown = blocks.join("\n\n");
  parseGuideMarkdown(markdown);
  return markdown;
}

export function slugFromTitle(title: string, fallback: string): string {
  const ascii = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160).replace(/-+$/g, "");
  return ascii || `draft-${fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "article"}`;
}

export function createSlugFallback(id: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = id.replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 12);
  return `${date}-${suffix}`;
}
