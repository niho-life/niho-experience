import { describe, expect, it, vi } from "vitest";
import { readBoundedJson, ResponseBodyTooLarge } from "./read-bounded-json";

describe("readBoundedJson", () => {
  it("keeps replacement decoding as the default and offers fatal UTF-8 for command readers", async () => {
    const bytes = new Uint8Array([0x22, 0xc3, 0x28, 0x22]);
    expect(await readBoundedJson(new Response(bytes), 16)).toBe("�(");
    await expect(readBoundedJson(new Response(bytes), 16, { fatalUtf8: true })).rejects.toBeInstanceOf(TypeError);
  });

  it("preserves the size error and releases the stream when cancellation fails", async () => {
    const cancel = vi.fn(() => { throw new Error("cancel failed"); });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel });
    const response = new Response(stream);
    await expect(readBoundedJson(response, 4, { fatalUtf8: true })).rejects.toBeInstanceOf(ResponseBodyTooLarge);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
