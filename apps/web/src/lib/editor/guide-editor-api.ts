import type {
  GuideArticleStatus,
  GuideCategory,
  GuideContent,
  GuidePublicationVisibility,
  GuideSubject,
} from "@niho-experience/experience-store";
import type { GuidePublicationProblem } from "./guide-publication";
import { refreshEditorSession, type EditorRefreshOutcome } from "./client-session";

export interface EditorGuideArticle {
  readonly id: string;
  readonly slug: string;
  readonly subject: GuideSubject;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
  readonly status: GuideArticleStatus;
  readonly revision: number;
  readonly currentPublication?: {
    readonly id: number;
    readonly number: number;
    readonly visibility: GuidePublicationVisibility;
    readonly publishedAtUtc: string;
  };
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export type EditorApiErrorKind = "signed-out" | "reconnect" | "forbidden" | "conflict" | "not-found" | "invalid" | "unavailable";

export class EditorApiError extends Error {
  readonly kind: EditorApiErrorKind;
  readonly status?: number;

  constructor(kind: EditorApiErrorKind, status?: number) {
    super(kind);
    this.name = "EditorApiError";
    this.kind = kind;
    this.status = status;
  }
}

type EditorApiDeps = {
  fetch: typeof fetch;
  refresh: () => Promise<EditorRefreshOutcome>;
};

const browserDeps: EditorApiDeps = {
  fetch: (...args) => fetch(...args),
  refresh: () => refreshEditorSession(),
};

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function responseError(response: Response): EditorApiError {
  if (response.status === 401) return new EditorApiError("signed-out", 401);
  if (response.status === 403) return new EditorApiError("forbidden", 403);
  if (response.status === 409) return new EditorApiError("conflict", 409);
  if (response.status === 404) return new EditorApiError("not-found", 404);
  if (response.status === 400) return new EditorApiError("invalid", 400);
  return new EditorApiError("unavailable", response.status);
}

export async function editorApiRequest<T>(
  path: string,
  init: RequestInit = {},
  deps: EditorApiDeps = browserDeps,
  mayRefresh = true,
): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", ...init.headers },
    });
  } catch {
    throw new EditorApiError("unavailable");
  }
  const body = await responseBody(response);
  if (response.ok) return body as T;

  if (response.status === 401 && body.error === "refresh_required" && mayRefresh) {
    const refreshed = await deps.refresh();
    if (refreshed.status === "ok") return editorApiRequest<T>(path, init, deps, false);
    if (refreshed.status === "reconnect") throw new EditorApiError("reconnect", 401);
    if (refreshed.status === "signed-out") throw new EditorApiError("signed-out", 401);
    throw new EditorApiError("unavailable");
  }
  throw responseError(response);
}

export type GuideListResponse = { readonly guides: readonly EditorGuideArticle[] };
export type GuideResponse = { readonly guide: EditorGuideArticle };
export type GuideCategoriesResponse = { readonly categories: readonly GuideCategory[] };
export type GuideSubjectsResponse = { readonly subjects: readonly GuideSubject[] };
export type GuideMutationResponse = { readonly id: string; readonly revision: number };
export type GuidePublicationPreflightResponse = {
  readonly guide: EditorGuideArticle;
  readonly problems: readonly GuidePublicationProblem[];
};
