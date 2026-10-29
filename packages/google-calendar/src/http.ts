const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const REQUEST_TIMEOUT_MS = 10_000;

export const GOOGLE_API = "https://www.googleapis.com/calendar/v3";

export interface GoogleFetchConfig {
  fetch?: typeof fetch;
}

export class GoogleCalendarError extends Error {
  readonly reason: "REVOKED" | "UNAVAILABLE" | "INVALID_RESPONSE";

  constructor(reason: "REVOKED" | "UNAVAILABLE" | "INVALID_RESPONSE") {
    super(`Google Calendar ${reason}`);
    this.reason = reason;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleCalendarError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A fixed-origin, no-cache, no-redirect Google request with a deadline covering body reads. */
export async function googleRequest(config: GoogleFetchConfig, url: string, init: RequestInit): Promise<Response> {
  if (!url.startsWith(`${GOOGLE_API}/`) && !url.startsWith("https://oauth2.googleapis.com/")) {
    throw new TypeError("Google request origin is not allowed");
  }
  try {
    return await (config.fetch ?? fetch)(url, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleCalendarError("UNAVAILABLE");
  }
}

function assertBoundedJsonShape(value: unknown): void {
  let nodes = 0;
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) throw new GoogleCalendarError("INVALID_RESPONSE");
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
}

export async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) throw new GoogleCalendarError("INVALID_RESPONSE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleCalendarError("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GoogleCalendarError("INVALID_RESPONSE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError("UNAVAILABLE");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertBoundedJsonShape(parsed);
    return asRecord(parsed);
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError("INVALID_RESPONSE");
  }
}
