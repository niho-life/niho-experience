import type {
  GuideArticleRecord,
  GuidePublicationVisibility,
} from "@niho-experience/experience-store";
import {
  parseGuideMarkdown,
  type GuideBlock,
} from "@/lib/guide-markdown";

type JsonObject = Record<string, unknown>;

export type GuidePublicationProblemField = "title" | "body" | "category" | "description" | "author";

export type GuidePublicationProblem = {
  readonly field: GuidePublicationProblemField;
  readonly message: string;
};

export type GuidePublicationInput = {
  readonly expectedRevision: number;
  readonly visibility: GuidePublicationVisibility;
};

export type GuideStopPublicationInput = {
  readonly expectedRevision: number;
};

function exactObject(value: unknown, keys: readonly string[]): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as JsonObject;
  const actual = Object.keys(object);
  return actual.length === keys.length && actual.every((key) => keys.includes(key)) ? object : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseGuidePublicationInput(value: unknown): GuidePublicationInput | null {
  const input = exactObject(value, ["expectedRevision", "visibility"]);
  if (!input || !positiveSafeInteger(input.expectedRevision)) return null;
  if (input.visibility !== "PUBLIC" && input.visibility !== "UNLISTED") return null;
  return { expectedRevision: input.expectedRevision, visibility: input.visibility };
}

export function parseGuideStopPublicationInput(value: unknown): GuideStopPublicationInput | null {
  const input = exactObject(value, ["expectedRevision"]);
  if (!input || !positiveSafeInteger(input.expectedRevision)) return null;
  return { expectedRevision: input.expectedRevision };
}

const hasConfirmMarker = (value: string) => value.includes("[CONFIRM:");
const hasSamplePlaceholder = (value: string) => value.includes("/sample/");

function addProblem(
  problems: GuidePublicationProblem[],
  field: GuidePublicationProblemField,
  message: string,
) {
  if (!problems.some((problem) => problem.field === field && problem.message === message)) {
    problems.push({ field, message });
  }
}

/**
 * Checks the saved snapshot that is about to be published. The store remains
 * responsible for the transactional revision, category and authority checks.
 */
export function guidePublicationProblems(
  article: GuideArticleRecord,
  activeCategorySlugs?: ReadonlySet<string>,
): readonly GuidePublicationProblem[] {
  const problems: GuidePublicationProblem[] = [];
  const title = article.title.trim();
  const description = article.description.trim();
  const markdown = article.content.markdown;
  const author = article.content.author;

  if (!title) addProblem(problems, "title", "タイトルを入力してください。");
  if (hasConfirmMarker(article.title)) addProblem(problems, "title", "タイトルの確認待ちを解消してください。");
  if (hasSamplePlaceholder(article.title)) addProblem(problems, "title", "サンプル用の参照を削除してください。");

  if (!description) addProblem(problems, "description", "説明を入力してください。");
  if (hasConfirmMarker(article.description)) addProblem(problems, "description", "説明の確認待ちを解消してください。");
  if (hasSamplePlaceholder(article.description)) addProblem(problems, "description", "サンプル用の参照を削除してください。");

  if (!article.categorySlug) {
    addProblem(problems, "category", "カテゴリを選択してください。");
  } else if (activeCategorySlugs && !activeCategorySlugs.has(article.categorySlug)) {
    addProblem(problems, "category", "現在利用できるカテゴリを選び直してください。");
  }

  if (!author || !author.name.trim() || !author.role.trim() || !author.bio.trim()) {
    addProblem(problems, "author", "著者名・肩書き・紹介をすべて入力してください。");
  }
  if (author) {
    const authorText = `${author.name}\n${author.role}\n${author.bio}`;
    if (hasConfirmMarker(authorText)) addProblem(problems, "author", "著者情報の確認待ちを解消してください。");
    if (hasSamplePlaceholder(authorText)) addProblem(problems, "author", "著者情報のサンプル用参照を削除してください。");
  }

  if (!markdown.trim()) {
    addProblem(problems, "body", "本文を入力してください。");
    return problems;
  }
  if (hasConfirmMarker(markdown)) addProblem(problems, "body", "本文の確認待ちを解消してください。");
  if (hasSamplePlaceholder(markdown)) addProblem(problems, "body", "本文のサンプル用参照を削除してください。");

  try {
    const blocks = parseGuideMarkdown(markdown);
    if (!blocks.some((block) => block.type === "heading" && block.level === 2)) {
      addProblem(problems, "body", "本文にH2見出しを1つ以上追加してください。");
    }
    if (blocks.some((block) => block.type === "figure")) {
      addProblem(problems, "body", "写真は掲載許諾の仕組みが整うまで公開できません。");
    }
  } catch {
    // Parser failures are author-correctable input, never service failures.
    addProblem(problems, "body", "本文に未対応または安全でないMarkdownがあります。本文を修正してください。");
  }

  return problems;
}

export type GuideDraftPreview =
  | { readonly ok: true; readonly blocks: readonly GuideBlock[] }
  | { readonly ok: false; readonly message: string };

export function parseGuideDraftPreview(markdown: string): GuideDraftPreview {
  if (!markdown.trim()) return { ok: false, message: "本文がまだありません。編集画面で本文を保存してください。" };
  if (hasSamplePlaceholder(markdown)) {
    return { ok: false, message: "サンプル用の画像や参照を含む本文はプレビューできません。" };
  }
  try {
    const blocks = parseGuideMarkdown(markdown);
    if (blocks.some((block) => block.type === "figure")) {
      return { ok: false, message: "写真は掲載許諾の仕組みが整うまでプレビューできません。" };
    }
    return { ok: true, blocks };
  } catch {
    return { ok: false, message: "本文に未対応または安全でないMarkdownがあります。編集画面で修正してください。" };
  }
}
