import "server-only";
import { readBoundedJson } from "../read-bounded-json";
import {
  EDITOR_RESPONSE_LIMITS,
  editorPublicationPaths,
  parseEditorArticleBody,
  parseEditorPreview,
  parseEditorPublishedList,
  type EditorArticleBodyResult,
  type EditorPreviewResult,
  type EditorPublishedList,
} from "./contract";

/**
 * Reads editor.niho.life's public API (paths and shapes: contract.ts, provisional) with a per-instance memory cache:
 *
 * - A response stays fresh for 30 s; after that it is revalidated with `If-None-Match`, and a 304 reuses it.
 * - Only a network failure, a timeout, a 5xx or a 429 may serve the last copy, for at most 10 minutes after it was last
 *   confirmed; a failure then backs off for the fresh period instead of making every page wait for the timeout again.
 * - 401/403 is a broken setting, never "no content": it always throws, even with a cached copy.
 * - Article bodies are kept per ID while the list's `updatedAt` for it stays the same: no request at all.
 * - Previews are never cached.
 *
 * Next's data cache is bypassed (`cache: "no-store"`); this layer is the only cache. Errors and log lines name the
 * endpoint kind only: never the URL (a preview path carries its token), the token or a response body.
 */

export type EditorEndpoint = "list" | "article" | "preview";
export type EditorFailureKind = "auth" | "unavailable" | "contract";

export class EditorPublicationError extends Error {
  readonly kind: EditorFailureKind;
  readonly endpoint: EditorEndpoint;
  readonly detail: string;
  constructor(kind: EditorFailureKind, endpoint: EditorEndpoint, detail: string) {
    super(`editor publication API (${endpoint}): ${detail}`);
    this.name = "EditorPublicationError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

export const EDITOR_FETCH_TIMING = { freshMs: 30_000, staleMs: 10 * 60_000, timeoutMs: 5_000 } as const;

export type EditorPublicationClientOptions = Readonly<{
  baseUrl: string;
  handle: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
  timeoutMs?: number;
}>;

export type EditorArticleOutcome = Readonly<{ status: "ok"; result: EditorArticleBodyResult }> | Readonly<{ status: "gone" }>;

export type EditorPublicationClient = Readonly<{
  list(): Promise<EditorPublishedList>;
  /** The body of one listed article. `updatedAt` is the list's value: while it is unchanged, no request is made. */
  article(id: string, updatedAt: string): Promise<EditorArticleOutcome>;
  /** A draft, or null when the token is unknown or expired (404/410). */
  preview(token: string): Promise<EditorPreviewResult | null>;
}>;

type Entry = { etag: string | null; value: unknown; fetchedAt: number; failedAt: number | null };
type Cached<T> = Readonly<{ status: "ok"; value: T }> | Readonly<{ status: "missing" | "gone" }>;

const TRANSIENT_ERRORS = new Set(["TimeoutError", "AbortError", "TypeError"]);
const transient = (error: unknown) => error instanceof Error && TRANSIENT_ERRORS.has(error.name);
const failureDetail = (error: unknown) => (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out" : "network failure");

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

export function createEditorPublicationClient(options: EditorPublicationClientOptions): EditorPublicationClient {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? EDITOR_FETCH_TIMING.freshMs;
  const staleMs = options.staleMs ?? EDITOR_FETCH_TIMING.staleMs;
  const timeoutMs = options.timeoutMs ?? EDITOR_FETCH_TIMING.timeoutMs;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Cached<unknown>>>();
  const bodies = new Map<string, { updatedAt: string; result: EditorArticleBodyResult }>();
  const url = (path: string) => `${options.baseUrl}${path}`;

  async function send(target: string, endpoint: EditorEndpoint, etag: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${options.token}` };
    if (etag) headers["if-none-match"] = etag;
    try {
      // `manual`: a redirect is a contract error, and the bearer token never follows one.
      return await fetchImpl(target, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new EditorPublicationError("unavailable", endpoint, failureDetail(error));
    }
  }

  async function json(response: Response, endpoint: EditorEndpoint, maxBytes: number): Promise<unknown> {
    try {
      return await readBoundedJson(response, maxBytes);
    } catch (error) {
      if (transient(error)) throw new EditorPublicationError("unavailable", endpoint, failureDetail(error));
      throw new EditorPublicationError("contract", endpoint, "the response is too large or not JSON");
    }
  }

  /** Statuses every endpoint treats alike. Returns normally only for 200 (and 304/404/410, which the caller decides). */
  async function refuse(response: Response, endpoint: EditorEndpoint): Promise<void> {
    const { status } = response;
    if (status === 200 || status === 304 || status === 404 || status === 410) return;
    await discard(response);
    if (status === 401 || status === 403) throw new EditorPublicationError("auth", endpoint, `the API refused the credentials (${status})`);
    if (status === 429 || status >= 500) throw new EditorPublicationError("unavailable", endpoint, `the API answered ${status}`);
    throw new EditorPublicationError("contract", endpoint, `unexpected status ${status}`);
  }

  async function revalidate<T>(target: string, endpoint: EditorEndpoint, maxBytes: number, parse: (value: unknown) => T, entry: Entry | undefined): Promise<Cached<T>> {
    try {
      const response = await send(target, endpoint, entry?.etag ?? null);
      await refuse(response, endpoint);
      if (response.status === 304) {
        await discard(response);
        if (!entry) throw new EditorPublicationError("contract", endpoint, "304 without a cached copy");
        entry.fetchedAt = now();
        entry.failedAt = null;
        return { status: "ok", value: entry.value as T };
      }
      if (response.status === 404 || response.status === 410) {
        await discard(response);
        entries.delete(target);
        return { status: response.status === 410 ? "gone" : "missing" };
      }
      const body = await json(response, endpoint, maxBytes);
      let value: T;
      try {
        value = parse(body);
      } catch {
        throw new EditorPublicationError("contract", endpoint, "the response does not match the contract");
      }
      entries.set(target, { etag: response.headers.get("etag"), value, fetchedAt: now(), failedAt: null });
      return { status: "ok", value };
    } catch (error) {
      if (error instanceof EditorPublicationError && error.kind === "unavailable" && entry && now() - entry.fetchedAt <= staleMs) {
        entry.failedAt = now();
        console.error(`[guides] ${error.message}; serving the copy confirmed ${Math.round((now() - entry.fetchedAt) / 1000)} s ago`);
        return { status: "ok", value: entry.value as T };
      }
      throw error;
    }
  }

  function cached<T>(target: string, endpoint: EditorEndpoint, maxBytes: number, parse: (value: unknown) => T): Promise<Cached<T>> {
    const entry = entries.get(target);
    const at = now();
    if (entry && at - entry.fetchedAt < freshMs) return Promise.resolve({ status: "ok", value: entry.value as T });
    // Recently failed: keep serving the copy without waiting for another timeout, within the stale limit.
    if (entry?.failedAt != null && at - entry.failedAt < freshMs && at - entry.fetchedAt <= staleMs) return Promise.resolve({ status: "ok", value: entry.value as T });
    const pending = inflight.get(target);
    if (pending) return pending as Promise<Cached<T>>;
    const request = revalidate(target, endpoint, maxBytes, parse, entry).finally(() => inflight.delete(target));
    inflight.set(target, request);
    return request;
  }

  return {
    async list() {
      const outcome = await cached(url(editorPublicationPaths.list(options.handle)), "list", EDITOR_RESPONSE_LIMITS.listBytes, parseEditorPublishedList);
      if (outcome.status !== "ok") throw new EditorPublicationError("contract", "list", `the published list answered ${outcome.status === "gone" ? 410 : 404}`);
      const listed = new Set(outcome.value.items.map((item) => item.id));
      for (const id of bodies.keys()) if (!listed.has(id)) bodies.delete(id);
      return outcome.value;
    },

    async article(id, updatedAt) {
      const known = bodies.get(id);
      if (known && known.updatedAt === updatedAt) return { status: "ok", result: known.result };
      let result: EditorArticleBodyResult;
      try {
        const outcome = await cached(url(editorPublicationPaths.article(options.handle, id)), "article", EDITOR_RESPONSE_LIMITS.articleBytes, (value) => parseEditorArticleBody(value, id));
        // Unpublished (410) or unknown (404) since the list was read: left out now, asked again with the next list.
        if (outcome.status !== "ok") return { status: "gone" };
        result = outcome.value;
      } catch (error) {
        // One unreadable article is left out; an outage or a refused credential stops the whole read.
        if (!(error instanceof EditorPublicationError) || error.kind !== "contract") throw error;
        result = { ok: false, reason: error.detail };
      }
      bodies.set(id, { updatedAt, result });
      return { status: "ok", result };
    },

    async preview(token) {
      const response = await send(url(editorPublicationPaths.preview(token)), "preview", null);
      await refuse(response, "preview");
      if (response.status !== 200) {
        await discard(response);
        if (response.status === 304) throw new EditorPublicationError("contract", "preview", "unexpected status 304");
        return null;
      }
      return parseEditorPreview(await json(response, "preview", EDITOR_RESPONSE_LIMITS.previewBytes));
    },
  };
}
