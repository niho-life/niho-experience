import type { JSONContent } from "@tiptap/core";
import {
  guideLinkHref,
  parseGuideMarkdown,
  type GuideBlock,
  type GuideInline,
} from "@/lib/guide-markdown";

export class UnsupportedGuideEditorContentError extends Error {
  constructor(message = "この本文には初期版の編集画面で扱えない内容があります。") {
    super(message);
    this.name = "UnsupportedGuideEditorContentError";
  }
}

export function guideEditorLinkHref(value: string): string | null {
  if (value.includes("(") || value.includes(")")) return null;
  return guideLinkHref(value)?.href ?? null;
}

function inlineToEditorContent(inline: readonly GuideInline[], marks: NonNullable<JSONContent["marks"]> = []): JSONContent[] {
  return inline.flatMap((node): JSONContent[] => {
    if (node.type === "confirm") throw new UnsupportedGuideEditorContentError();
    if (node.type === "text") return node.value ? [{ type: "text", text: node.value, ...(marks.length ? { marks } : {}) }] : [];
    const mark = node.type === "strong"
      ? { type: "bold" }
      : node.type === "em"
        ? { type: "italic" }
        : { type: "link", attrs: { href: node.href } };
    return inlineToEditorContent(node.children, [...marks, mark]);
  });
}

function textBlockToEditorNode(block: Extract<GuideBlock, { type: "paragraph" | "list" }>): JSONContent {
  if (block.type === "paragraph") return { type: "paragraph", content: inlineToEditorContent(block.children) };
  return {
    type: block.ordered ? "orderedList" : "bulletList",
    content: block.items.map((item) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: inlineToEditorContent(item) }],
    })),
  };
}

export function markdownToGuideEditorDocument(markdown: string): JSONContent {
  const blocks = parseGuideMarkdown(markdown);
  const content = blocks.map((block): JSONContent => {
    if (block.type === "heading") {
      return { type: "heading", attrs: { level: block.level }, content: inlineToEditorContent(block.children) };
    }
    if (block.type === "paragraph" || block.type === "list") return textBlockToEditorNode(block);
    throw new UnsupportedGuideEditorContentError();
  });
  const document = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] } satisfies JSONContent;
  // The public parser accepts a wider legacy subset than this editor can safely
  // write. Validate the converted document before it ever becomes editable.
  guideEditorDocumentToMarkdown(document);
  return document;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

function escapeMarkdownText(value: string): string {
  if (value.includes("\n") || value.includes("\r")) throw new UnsupportedGuideEditorContentError("本文内の改行を保存できません。段落を分けてください。");
  return value.replace(ASCII_PUNCTUATION, "\\$&");
}

type Mark = NonNullable<JSONContent["marks"]>[number];

function markKey(marks: readonly Mark[]): string {
  return marks
    .map((mark) => `${mark.type}:${mark.type === "link" ? String(mark.attrs?.href ?? "") : ""}`)
    .sort()
    .join("|");
}

function serializeMarkedText(value: string, marks: readonly Mark[]): string {
  const types = marks.map((mark) => mark.type);
  if (new Set(types).size !== types.length || types.some((type) => !["bold", "italic", "link"].includes(type))) {
    throw new UnsupportedGuideEditorContentError("未対応の文字装飾があります。");
  }
  if (types.includes("bold") && types.includes("italic")) {
    throw new UnsupportedGuideEditorContentError("同じ文字に太字と斜体を重ねることはできません。");
  }
  const leading = value.match(/^\s+/)?.[0] ?? "";
  const trailing = value.match(/\s+$/)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length || undefined);
  if (!core) return escapeMarkdownText(value);

  let rendered = escapeMarkdownText(core);
  if (types.includes("italic")) rendered = `*${rendered}*`;
  if (types.includes("bold")) rendered = `**${rendered}**`;
  const link = marks.find((mark) => mark.type === "link");
  if (link) {
    const href = typeof link.attrs?.href === "string" ? guideEditorLinkHref(link.attrs.href) : null;
    if (!href) throw new UnsupportedGuideEditorContentError("安全でないリンクがあります。");
    rendered = `[${rendered}](${href})`;
  }
  return `${escapeMarkdownText(leading)}${rendered}${escapeMarkdownText(trailing)}`;
}

function serializeInline(content: JSONContent[] | undefined): string {
  if (!content?.length) return "";
  const merged: Array<{ text: string; marks: Mark[] }> = [];
  for (const node of content) {
    if (node.type !== "text" || typeof node.text !== "string" || node.content?.length) {
      throw new UnsupportedGuideEditorContentError("本文に未対応の要素があります。");
    }
    const marks = node.marks ?? [];
    const previous = merged.at(-1);
    if (previous && markKey(previous.marks) === markKey(marks)) previous.text += node.text;
    else merged.push({ text: node.text, marks: [...marks] });
  }
  return merged.map(({ text, marks }) => serializeMarkedText(text, marks)).join("");
}

function serializeList(node: JSONContent, ordered: boolean): string {
  if (!node.content?.length) throw new UnsupportedGuideEditorContentError("空のリストは保存できません。");
  return node.content.map((item, index) => {
    if (item.type !== "listItem" || item.content?.length !== 1 || item.content[0]?.type !== "paragraph") {
      throw new UnsupportedGuideEditorContentError("入れ子のリストは保存できません。");
    }
    const text = serializeInline(item.content[0].content);
    if (!text.trim()) throw new UnsupportedGuideEditorContentError("空のリスト項目は保存できません。");
    return `${ordered ? `${index + 1}.` : "-"} ${text}`;
  }).join("\n");
}

export function guideEditorDocumentToMarkdown(document: JSONContent): string {
  if (document.type !== "doc") throw new UnsupportedGuideEditorContentError();
  const blocks = (document.content ?? []).flatMap((node): string[] => {
    if (node.type === "paragraph") {
      const text = serializeInline(node.content);
      return text ? [text] : [];
    }
    if (node.type === "heading") {
      const level = node.attrs?.level;
      if (level !== 2 && level !== 3) throw new UnsupportedGuideEditorContentError("本文の見出しは H2 または H3 にしてください。");
      const text = serializeInline(node.content);
      if (!text.trim()) throw new UnsupportedGuideEditorContentError("空の見出しは保存できません。");
      return [`${"#".repeat(level)} ${text}`];
    }
    if (node.type === "bulletList") return [serializeList(node, false)];
    if (node.type === "orderedList") return [serializeList(node, true)];
    throw new UnsupportedGuideEditorContentError();
  });
  const markdown = blocks.join("\n\n");
  parseGuideMarkdown(markdown);
  return markdown;
}

export function guideSlugFromTitle(title: string, fallback: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
  return ascii || `draft-${fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "article"}`;
}

export function createGuideSlugFallback(
  randomUUID: () => string = () => crypto.randomUUID(),
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = randomUUID().replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 12);
  if (suffix.length < 8) throw new Error("crypto.randomUUID() did not return a usable UUID");
  return `${date}-${suffix}`;
}
