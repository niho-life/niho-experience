import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "@/lib/config";
import { translationFromMessage, type TranslationResult } from "./prompts";

/**
 * The Claude API with experience's own key (EXPERIENCE_ANTHROPIC_API_KEY, Secret Manager; owner decision
 * 2026-10-31). The key is read here, where it is used, and is never logged; the SDK's own logging and
 * tracing are off so no text reaches a log or a trace. One attempt per call: the caller decides what
 * happens next (the job tries again later, the host writes the English).
 */
export type Translator = (request: MessageCreateParamsNonStreaming) => Promise<TranslationResult>;

type CreateMessage = (body: MessageCreateParamsNonStreaming, options: { timeout: number; maxRetries: number }) => Promise<Pick<BetaMessage, "content" | "stop_reason">>;

/** A translator over `create` (the SDK's beta messages, or a stub in tests). Any thrown error is `unavailable`. */
export function createTranslator(create: CreateMessage, timeoutMs: number): Translator {
  return async (request) => {
    let message: Pick<BetaMessage, "content" | "stop_reason">;
    try {
      message = await create(request, { timeout: timeoutMs, maxRetries: 0 });
    } catch {
      // Timeout, network, rate limit, overload, a refused key: nothing about the text is kept.
      return { ok: false, failure: "unavailable" };
    }
    return translationFromMessage(message);
  };
}

/** The translator for this server, or null while translation is off or its key is missing. */
export function anthropicTranslator({ timeoutMs }: { timeoutMs: number }): Translator | null {
  if (!config.translationEnabled) return null;
  const apiKey = process.env.EXPERIENCE_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, authToken: null, logLevel: "off", openTelemetry: false });
  return createTranslator((body, options) => client.beta.messages.create(body, options), timeoutMs);
}
