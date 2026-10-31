import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Claude API client for translations (#285 slice 5), with the SDK replaced by a stub: no request leaves. */
const mocks = vi.hoisted(() => ({
  config: { translationEnabled: true },
  options: [] as unknown[],
  create: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class Anthropic {
    beta = { messages: { create: mocks.create } };
    constructor(options: unknown) {
      mocks.options.push(options);
    }
  }
  return { ...actual, default: Anthropic };
});

import { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { anthropicTranslator, createTranslator } from "./anthropic";
import { guestMessageToJapanese } from "./prompts";

const request = guestMessageToJapanese("Is there a vegetarian option?");
const answer = { stop_reason: "end_turn", content: [{ type: "text", text: "ベジタリアンの選択肢はありますか？" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
  mocks.config.translationEnabled = true;
  vi.stubEnv("EXPERIENCE_ANTHROPIC_API_KEY", "sample-anthropic-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "sample-other-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anthropicTranslator", () => {
  it("uses experience's own key with the SDK's logging and tracing off, one attempt within the timeout", async () => {
    mocks.create.mockResolvedValueOnce(answer);
    const translate = anthropicTranslator({ timeoutMs: 15_000 });
    expect(translate).not.toBeNull();
    expect(await translate!(request)).toEqual({ ok: true, text: "ベジタリアンの選択肢はありますか？" });
    expect(mocks.options).toEqual([{ apiKey: "sample-anthropic-key", authToken: null, logLevel: "off", openTelemetry: false }]);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(request, { timeout: 15_000, maxRetries: 0 });
  });

  it("is null while translation is off or the key is missing, and builds no client", () => {
    mocks.config.translationEnabled = false;
    expect(anthropicTranslator({ timeoutMs: 15_000 })).toBeNull();
    mocks.config.translationEnabled = true;
    vi.stubEnv("EXPERIENCE_ANTHROPIC_API_KEY", " ");
    expect(anthropicTranslator({ timeoutMs: 15_000 })).toBeNull();
    expect(mocks.options).toEqual([]);
  });
});

describe("createTranslator", () => {
  it("answers unavailable for every error the call throws, and logs nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const error of [
      new APIConnectionTimeoutError(),
      new APIConnectionError({ message: "synthetic" }),
      new RateLimitError(429, undefined, "rate limited", new Headers()),
      new AuthenticationError(401, undefined, "invalid key", new Headers()),
      new TypeError("synthetic"),
    ]) {
      const create = vi.fn(async () => Promise.reject(error));
      expect(await createTranslator(create, 30_000)(request)).toEqual({ ok: false, failure: "unavailable" });
      expect(create).toHaveBeenCalledWith(request, { timeout: 30_000, maxRetries: 0 });
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it("reads a refusal and an unusable answer as such", async () => {
    expect(await createTranslator(async () => ({ stop_reason: "refusal", content: [] }), 30_000)(request)).toEqual({ ok: false, failure: "refused" });
    expect(await createTranslator(async () => ({ stop_reason: "max_tokens", content: [] }), 30_000)(request)).toEqual({ ok: false, failure: "unusable" });
  });
});
