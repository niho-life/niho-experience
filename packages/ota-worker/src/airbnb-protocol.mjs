import { Buffer } from "node:buffer";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

export const AIRBNB_ORIGIN = "https://www.airbnb.jp";
export const AIRBNB_ASSET_ORIGIN = "https://a0.muscache.com";
export const AIRBNB_PROFILE_OPERATION = "UserProfileQuery";
export const AIRBNB_CALENDAR_OPERATION = "XSCalendarEventsQuery";
export const AIRBNB_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const AIRBNB_MAX_CALENDAR_ROWS = 512;

export const AIRBNB_READ_HASHES = Object.freeze({
  UserProfileQuery: "8b5d083bdcd64b6fe2fed05670a83680b5733d440cf7875ecbb7de09b6a2600c",
  XSCalendarEventsQuery: "3293ac982e0ab1ebd1dcd10bf032cf1b0cde33903f4679671d75db5b268dfa47",
  AnnouncementImpressionInfo: "579283c5748afc7936f6882cc79d1309a2bb0419554d8bc9c11d49b4077fa0ff",
  HostTermsOfServiceQuery: "660d1474d1234a48d00f740f4336db261ddb6b660e5a3f20722030739414f4c3",
  GetConsentFlagsQuery: "2c65c7d0b25c6d6c5a6a46b41d7bb87f158fcfd3b18294c038ecd090b1b99e15",
  FetchEmblemBadgeCounts: "bdc888dd01d83d51e06721f1e0073ac9ca1af8dcc01a3505c569a178c972033a",
  UserMetastoreWebQuery: "af6bbd5064094d72e479d2f62df3e9a28e61a5d87cc233c5d16b720603d36ad4",
  HostNotificationsBadgingQuery: "57c872540afb80562944ba522b1b17625a6de7ef1d4848e3b87035bf95ed4c78",
  XSCalendarDotsQuery: "496f4d2db446706b5f1867a87093e80d37417531eddd212bd54b672dc238f94d",
  ConnectCalendarPageQuery: "844413fbe787b32b98a859cb93f79912c6141fa66638d3909e4fc5e4aa704539",
  HostRecommendedActionsCountQuery: "306bf94715d2edf2e62224456576fd6d1d9a7722f7b71ffaae4e8aca5457337e",
  NaviServerAnnouncementsQuery: "982f049d3fff92bf9c902dc6ab8bb3e37f5d91922b9df6ca5ee7f7267e78beea",
  IsHostQuery: "1825c527396823ea398f2fc9083a94c70d7777a531396e92e94aa096f9aec8fd",
  PrivacyRoadblockAnnouncementQuery: "908e178c0fad122488c095aff7ee560cee31ed27869d134ef706fe478b01a521",
  GetThumbnailPicQuery: "ab55c22df96bd74dfabf0f78b14f8172bf2cf52b7e2c29abc75ae65a59610d4b",
  NotificationUnreadCountQuery: "9ac348bca67eb585e83b040a30cc6233b62fcdc6132a6dbdd6cbe8721bb7f25d",
  ProfileReintroductionQuery: "c1a5aa6ca3d19c795bba90f330c23438a20dbe411756f2408ce2a7e72bb8845e",
  Header: "90c152b4bd4dd2f734e037b69bfede138be70dd2b3ab83602c7c291aebd75d55",
});

const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const API_KEYS = Object.freeze(["operationName", "locale", "currency", "variables", "extensions"]);
const CALENDAR_VARIABLE_KEYS = Object.freeze(["startsAt", "endsAt", "listingIds", "filters", "filterByCoHostIds"]);
const PROFILE_VARIABLE_KEYS = Object.freeze(["userId", "mockIdentifier", "userProfileType", "isEditMode"]);
const SHARE_QUERY_KEYS = new Set(["availabilityKey", "offeringId", "locale"]);

function fail(code = "DOM_DRIFT") { throw new ContractError(code); }

function boundedString(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function canonicalUtc(value) {
  return typeof value === "string" && CANONICAL_UTC.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function boundedJson(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 4_096;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 512 && value.every((item) => boundedJson(item, depth + 1));
  if (!isPlainObject(value) || Object.keys(value).length > 128) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 128 && boundedJson(item, depth + 1));
}

function parseJsonParameter(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32 * 1024) fail("UNSAFE_REQUEST");
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail("UNSAFE_REQUEST"); }
  if (!boundedJson(parsed)) fail("UNSAFE_REQUEST");
  return parsed;
}

export function opaqueAirbnbId(kind, decimal) {
  if (!POSITIVE_DECIMAL.test(decimal)) fail("TARGET_MISMATCH");
  return Buffer.from(`${kind}:${decimal}`, "utf8").toString("base64");
}

export function decodeOpaqueAirbnbId(value, kind) {
  if (!boundedString(value, 512) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return null;
    decoded = bytes.toString("utf8");
  } catch { return null; }
  const prefix = `${kind}:`;
  const decimal = decoded.startsWith(prefix) ? decoded.slice(prefix.length) : "";
  return POSITIVE_DECIMAL.test(decimal) ? decimal : null;
}

export function validateAirbnbCalendarVariables(value, job) {
  if (!exactKeys(value, CALENDAR_VARIABLE_KEYS) || !canonicalUtc(value.startsAt) || !canonicalUtc(value.endsAt)
    || Date.parse(value.startsAt) >= Date.parse(value.endsAt)
    || Date.parse(value.endsAt) - Date.parse(value.startsAt) > 63 * 86_400_000
    || ![value.listingIds, value.filters, value.filterByCoHostIds].every((item) => Array.isArray(item) && item.length === 0)
    || Date.parse(value.startsAt) > Date.parse(job.sourceStartAtUtc)
    || Date.parse(value.endsAt) < Date.parse(job.sourceEndAtUtc)) fail("UNSAFE_REQUEST");
  return Object.freeze({ ...value, listingIds: Object.freeze([]), filters: Object.freeze([]), filterByCoHostIds: Object.freeze([]) });
}

function validateProfileVariables(value, job) {
  const expected = opaqueAirbnbId("User", job.target.externalAccountId);
  if (!exactKeys(value, PROFILE_VARIABLE_KEYS) || value.userId !== expected || value.mockIdentifier !== null
    || value.userProfileType !== "HOST" || value.isEditMode !== true) fail("UNSAFE_REQUEST");
  return Object.freeze({ ...value });
}

export function parseAirbnbApiUrl(url, job) {
  if (!(url instanceof URL) || url.searchParams.size !== API_KEYS.length
    || !API_KEYS.every((key) => url.searchParams.getAll(key).length === 1)) fail("UNSAFE_REQUEST");
  const path = /^\/api\/v3\/([A-Za-z][A-Za-z0-9_]*)\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!path) fail("UNSAFE_REQUEST");
  const [, operationName, pathHash] = path;
  if (url.searchParams.get("operationName") !== operationName || AIRBNB_READ_HASHES[operationName] !== pathHash
    || url.searchParams.get("locale") !== "ja" || url.searchParams.get("currency") !== "JPY") fail("UNSAFE_REQUEST");
  const extensions = parseJsonParameter(url.searchParams.get("extensions"));
  if (!exactKeys(extensions, ["persistedQuery"]) || !exactKeys(extensions.persistedQuery, ["version", "sha256Hash"])
    || extensions.persistedQuery.version !== 1 || extensions.persistedQuery.sha256Hash !== pathHash) fail("UNSAFE_REQUEST");
  const variables = parseJsonParameter(url.searchParams.get("variables"));
  const selectedVariables = operationName === AIRBNB_PROFILE_OPERATION
    ? validateProfileVariables(variables, job)
    : operationName === AIRBNB_CALENDAR_OPERATION
      ? validateAirbnbCalendarVariables(variables, job)
      : Object.freeze(structuredClone(variables));
  return Object.freeze({ operationName, hash: pathHash, variables: selectedVariables });
}

function rejectGraphqlErrors(value) {
  if (!isPlainObject(value) || (Object.hasOwn(value, "errors") && (!Array.isArray(value.errors) || value.errors.length !== 0))) fail();
}

export function validateAirbnbSelfProfile(value, job) {
  rejectGraphqlErrors(value);
  const node = value.data?.node;
  const owner = node?.owner;
  const expected = opaqueAirbnbId("User", job.target.externalAccountId);
  if (!isPlainObject(value.data) || !isPlainObject(node) || node.__typename !== "User" || node.id !== expected
    || !isPlainObject(owner) || owner.__typename !== "ContextualUser" || owner.isViewerProfileOwner !== true) fail("ACCOUNT_MISMATCH");
  return true;
}

function canonicalShareListing(value) {
  if (!boundedString(value, 2_048)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const path = /^\/book\/experiences\/([1-9]\d*)$/.exec(url.pathname);
  if (url.protocol !== "https:" || !["www.airbnb.com", "www.airbnb.jp"].includes(url.hostname)
    || url.port || url.username || url.password || url.hash || !path
    || [...url.searchParams.keys()].some((key) => !SHARE_QUERY_KEYS.has(key))
    || [...SHARE_QUERY_KEYS].some((key) => url.searchParams.getAll(key).length > 1)
    || ![...url.searchParams.values()].every((item) => item.length <= 512)) return null;
  return path[1];
}

function validateShareLink(value, listingDecimal) {
  return canonicalShareListing(value) === listingDecimal;
}

function validateCalendarRow(row) {
  if (!isPlainObject(row) || !boundedString(row.__typename, 128) || !boundedString(row.id)
    || !boundedString(row.calendarEventId) || row.itemType !== "calendarInstance" || row.productType !== "EXPERIENCE"
    || !canonicalUtc(row.startsAt) || !canonicalUtc(row.endsAt) || Date.parse(row.startsAt) >= Date.parse(row.endsAt)
    || typeof row.isAvailable !== "boolean" || typeof row.isVisible !== "boolean"
    || !Number.isSafeInteger(row.remainingCapacity) || row.remainingCapacity < 0) fail();
  const listingDecimal = decodeOpaqueAirbnbId(row.listingId, "ActivityListing");
  if (listingDecimal === null || !validateShareLink(row.shareLink, listingDecimal)) fail("TARGET_MISMATCH");
  return listingDecimal;
}

export function selectAirbnbCalendarObservation(value, job, requestVariables) {
  validateAirbnbCalendarVariables(requestVariables, job);
  rejectGraphqlErrors(value);
  const rows = value.data?.presentation?.activityHostCalendarContainer?.iCalendarItemsConnection;
  if (!Array.isArray(rows) || rows.length > AIRBNB_MAX_CALENDAR_ROWS) fail();
  const start = new Date(job.sourceStartAtUtc).toISOString();
  const end = new Date(job.sourceEndAtUtc).toISOString();
  const matches = [];
  for (const row of rows) {
    const claimedByListing = decodeOpaqueAirbnbId(row?.listingId, "ActivityListing") === job.target.externalProductId;
    const claimedByShareLink = canonicalShareListing(row?.shareLink) === job.target.externalProductId;
    if (!claimedByListing && !claimedByShareLink) continue;
    const listingDecimal = validateCalendarRow(row);
    if (listingDecimal !== job.target.externalProductId || !claimedByShareLink) fail("TARGET_MISMATCH");
    if (row.startsAt === start && row.endsAt === end) matches.push(row);
  }
  if (matches.length !== 1 || matches[0].isVisible !== true) fail("TARGET_MISMATCH");
  return Object.freeze({ bookable: matches[0].isAvailable && matches[0].remainingCapacity >= 1 });
}

export const airbnbProtocolInternals = Object.freeze({ boundedJson, canonicalUtc, validateShareLink });
