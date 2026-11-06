import type { ChannelCapabilities } from "@niho-experience/experience-store";

type CapabilityName = keyof ChannelCapabilities;

const CAPABILITY_NAMES: readonly CapabilityName[] = ["canObserve", "canReadReservations", "canClose", "canOpen", "canCreate"];
const MAX_KEY_LENGTH = 300;

/** The short form's capability words, each for one ChannelCapabilities name. */
const SHORT_CAPABILITIES: Readonly<Record<string, CapabilityName>> = {
  observe: "canObserve",
  readReservations: "canReadReservations",
  close: "canClose",
  open: "canOpen",
  create: "canCreate",
};
/** `site/adapter@version`, e.g. GetYourGuide/gyg-browser@1. */
const SHORT_KEY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9]+$/;

function parseJson(raw: string): Record<string, ChannelCapabilities> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result: Record<string, ChannelCapabilities> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || key.length > MAX_KEY_LENGTH) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((name) => !(CAPABILITY_NAMES as readonly string[]).includes(name))) return null;
    if (Object.values(record).some((item) => typeof item !== "boolean")) return null;
    result[key] = record as ChannelCapabilities;
  }
  return result;
}

function parseShort(raw: string): Record<string, ChannelCapabilities> | null {
  const result: Record<string, ChannelCapabilities> = {};
  for (const entry of raw.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) return null;
    const key = entry.slice(0, separator);
    if (key.length > MAX_KEY_LENGTH || !SHORT_KEY.test(key) || Object.hasOwn(result, key)) return null;
    const capabilities: Partial<Record<CapabilityName, boolean>> = {};
    for (const word of entry.slice(separator + 1).split("+")) {
      const name = Object.hasOwn(SHORT_CAPABILITIES, word) ? SHORT_CAPABILITIES[word] : undefined;
      if (!name || capabilities[name]) return null;
      capabilities[name] = true;
    }
    result[key] = capabilities;
  }
  return result;
}

/**
 * EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS: the deployed allowlist of `site/adapter@version` capabilities (docs/ota-runtime.md).
 * Two forms: the JSON object (`{"GetYourGuide/gyg-browser@1":{"canObserve":true,...}}`), and a short form without commas
 * for deploy flags, `key=cap(+cap)*` entries joined by `;` (`GetYourGuide/gyg-browser@1=observe+close+open`). Unset is
 * an empty allowlist; anything malformed makes the whole value invalid (null), never a partial allowlist.
 */
export function parseChannelAdapters(raw: string | undefined): Readonly<Record<string, ChannelCapabilities>> | null {
  if (!raw) return {};
  return raw.trimStart().startsWith("{") ? parseJson(raw) : parseShort(raw);
}
