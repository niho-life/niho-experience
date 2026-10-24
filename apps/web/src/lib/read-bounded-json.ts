export class ResponseBodyTooLarge extends Error {}

export interface ReadBoundedJsonOptions {
  /** Existing callers remain replacement-tolerant; security-sensitive commands opt into fatal UTF-8. */
  fatalUtf8?: boolean;
}

/** Read and decode JSON without ever buffering more than the configured body cap (requests and responses). */
export async function readBoundedJson(response: Pick<Response, "body" | "headers">, maxBytes: number, options: ReadBoundedJsonOptions = {}): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ResponseBodyTooLarge();
  if (!response.body) throw new Error("Empty response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: options.fatalUtf8 ?? false });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ResponseBodyTooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    try { await reader.cancel(); } catch { /* The parse/limit failure remains authoritative. */ }
    finally { reader.releaseLock(); }
  }
}
