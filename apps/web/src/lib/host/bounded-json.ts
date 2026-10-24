import { readBoundedJson as readSharedBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

export type BoundedJsonResult = { ok: true; value: unknown } | { ok: false; reason: "media_type" | "too_large" | "invalid_json" };

/** Reads the actual request stream, so a missing or false Content-Length cannot bypass the cap. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  if (!JSON_TYPE.test(request.headers.get("content-type") ?? "")) return { ok: false, reason: "media_type" };
  try {
    return { ok: true, value: await readSharedBoundedJson(request, maxBytes, { fatalUtf8: true }) };
  } catch (error) {
    return { ok: false, reason: error instanceof ResponseBodyTooLarge ? "too_large" : "invalid_json" };
  }
}
