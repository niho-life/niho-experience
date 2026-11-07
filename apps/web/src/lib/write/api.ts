import type { WriteGuide } from "./client-types";

export type WriteApiErrorKind = "unauthenticated" | "forbidden" | "conflict" | "invalid" | "not-found" | "unavailable";

export class WriteApiError extends Error {
  constructor(readonly kind: WriteApiErrorKind, readonly status: number) {
    super(kind);
    this.name = "WriteApiError";
  }
}

function kindForStatus(status: number): WriteApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "unavailable";
}

export async function writeApi<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new WriteApiError("unavailable", 0);
  }
  if (!response.ok) throw new WriteApiError(kindForStatus(response.status), response.status);
  return response.json() as Promise<T>;
}

export type GuideResponse = { readonly guide: WriteGuide };
