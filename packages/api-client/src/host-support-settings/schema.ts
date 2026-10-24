import type {
  ExperienceHostSupportSettingsHost,
  ExperienceHostSupportSettingsHostKind,
  ExperienceHostSupportSettingsHostListResponse,
  ExperienceHostSupportSettingsPolicy,
  ExperienceHostSupportSettingsPutRequest,
  ExperienceHostSupportSettingsSetting,
  ExperienceHostSupportSettingsStateResponse,
  ExperienceHostSupportSettingsWriteCapability,
} from "./types.ts";
export type {
  ExperienceHostSupportSettingsHost,
  ExperienceHostSupportSettingsHostKind,
  ExperienceHostSupportSettingsHostListResponse,
  ExperienceHostSupportSettingsPolicy,
  ExperienceHostSupportSettingsPutRequest,
  ExperienceHostSupportSettingsSetting,
  ExperienceHostSupportSettingsStateResponse,
  ExperienceHostSupportSettingsWriteCapability,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HOST_KINDS = ["SPOT", "EXPERIENCE_PROVIDER"] as const;
const SETTING_STATES = ["UNSET", "CURRENT", "RECONSENT_REQUIRED"] as const;
export const EXPERIENCE_HOST_SUPPORT_SETTINGS_CONSENT_VERSION = "2026-10-23" as const;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0") && (() => { try { encodeURIComponent(value); return true; } catch { return false; } })();
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const dateTime = (value: unknown): value is string => text(value) && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));

/** One decoded opaque path segment. Unicode scalar count follows OpenAPI min/maxLength. */
export function isExperienceHostSupportSettingsPathId(value: unknown): value is string {
  if (!text(value)) return false;
  const characters = Array.from(value);
  return characters.length <= 200 && value !== "." && value !== ".." && !/[/\\%?#\uFFFD]/u.test(value) && !characters.some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || (point >= 127 && point <= 159);
  });
}

export const isExperienceHostSupportSettingsHostKind = (value: unknown): value is ExperienceHostSupportSettingsHostKind => oneOf(HOST_KINDS, value);

function host(value: unknown): ExperienceHostSupportSettingsHost | null {
  if (!isObject(value) || !exact(value, ["kind", "id", "displayName"]) || !isExperienceHostSupportSettingsHostKind(value.kind) || !isExperienceHostSupportSettingsPathId(value.id) || !text(value.displayName) || Array.from(value.displayName).length > 200) return null;
  return value as ExperienceHostSupportSettingsHost;
}

function policy(value: unknown): ExperienceHostSupportSettingsPolicy | null {
  if (!isObject(value) || !exact(value, ["policyVersion", "consentVersion", "offTotalRateBps", "onTotalRateBps", "peopleCostPaidDirectlyByHost", "processingFeesIncluded"])) return null;
  if (value.policyVersion !== EXPERIENCE_HOST_SUPPORT_SETTINGS_CONSENT_VERSION || value.consentVersion !== EXPERIENCE_HOST_SUPPORT_SETTINGS_CONSENT_VERSION || value.offTotalRateBps !== 1000 || value.onTotalRateBps !== 1500 || value.peopleCostPaidDirectlyByHost !== true || value.processingFeesIncluded !== true) return null;
  return value as ExperienceHostSupportSettingsPolicy;
}

function setting(value: unknown): ExperienceHostSupportSettingsSetting | null {
  if (!isObject(value) || !exact(value, ["enabled", "policyVersion", "consentVersion", "consentedAt", "agreementRevision", "sharedConsultationMemo", "revision", "updatedAt"])) return null;
  if (typeof value.enabled !== "boolean" || !text(value.policyVersion) || !text(value.consentVersion) || !dateTime(value.consentedAt) || !integer(value.agreementRevision, 0, 2_147_483_647) || !(value.sharedConsultationMemo === null || (typeof value.sharedConsultationMemo === "string" && Array.from(value.sharedConsultationMemo).length <= 4000 && !value.sharedConsultationMemo.includes("\0"))) || !integer(value.revision, 1, 2_147_483_647) || !dateTime(value.updatedAt)) return null;
  return value as ExperienceHostSupportSettingsSetting;
}

function capability(value: unknown): ExperienceHostSupportSettingsWriteCapability | null {
  if (!isObject(value) || !exact(value, ["writable", "reason"])) return null;
  if (value.writable === true && value.reason === null) return value as ExperienceHostSupportSettingsWriteCapability;
  if (value.writable === false && value.reason === "SUPPORT_WRITES_DISABLED") return value as ExperienceHostSupportSettingsWriteCapability;
  return null;
}

export function decodeExperienceHostSupportSettingsHostListResponse(value: unknown): ExperienceHostSupportSettingsHostListResponse | null {
  if (!isObject(value) || !exact(value, ["hosts", "limit", "truncated"]) || !Array.isArray(value.hosts) || value.hosts.length > 100 || value.limit !== 100 || typeof value.truncated !== "boolean") return null;
  const hosts = value.hosts.map(host);
  if (hosts.some((item) => item === null)) return null;
  return { hosts: hosts as ExperienceHostSupportSettingsHost[], limit: 100, truncated: value.truncated };
}

export function decodeExperienceHostSupportSettingsStateResponse(value: unknown): ExperienceHostSupportSettingsStateResponse | null {
  if (!isObject(value) || !exact(value, ["host", "setting", "settingState", "policy", "writeCapability"])) return null;
  const decodedHost = host(value.host);
  const decodedSetting = value.setting === null ? null : setting(value.setting);
  const decodedPolicy = policy(value.policy);
  const decodedCapability = capability(value.writeCapability);
  if (!decodedHost || (value.setting !== null && !decodedSetting) || !oneOf(SETTING_STATES, value.settingState) || !decodedPolicy || !decodedCapability) return null;
  if ((value.settingState === "UNSET") !== (decodedSetting === null)) return null;
  if (value.settingState === "CURRENT" && decodedSetting && (decodedSetting.policyVersion !== decodedPolicy.policyVersion || decodedSetting.consentVersion !== decodedPolicy.consentVersion)) return null;
  return { host: decodedHost, setting: decodedSetting, settingState: value.settingState, policy: decodedPolicy, writeCapability: decodedCapability };
}

export function decodeExperienceHostSupportSettingsPutRequest(value: unknown): ExperienceHostSupportSettingsPutRequest | null {
  if (!isObject(value) || !exact(value, ["enabled", "consentVersion", "expectedRevision"]) || typeof value.enabled !== "boolean" || value.consentVersion !== EXPERIENCE_HOST_SUPPORT_SETTINGS_CONSENT_VERSION || !integer(value.expectedRevision, 0, 2_147_483_646)) return null;
  return { enabled: value.enabled, consentVersion: value.consentVersion, expectedRevision: value.expectedRevision };
}
