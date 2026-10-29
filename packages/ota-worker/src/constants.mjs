export const SUPPLIER_ORIGIN = "https://supplier.getyourguide.com";
export const CDN_ORIGIN = "https://cdn.getyourguide.com";
export const ADAPTER = "gyg-browser";
export const ADAPTER_VERSION = "1";
export const SITE = "GetYourGuide";
export const VIATOR_ORIGIN = "https://supplier.viator.com";
export const JALAN_ORIGIN = "https://activityboard.jp";
export const ADAPTER_REGISTRY = Object.freeze({
  GetYourGuide: Object.freeze({ site: "GetYourGuide", adapter: "gyg-browser", adapterVersion: "1", profileNamespace: null }),
  Viator: Object.freeze({ site: "Viator", adapter: "viator-browser", adapterVersion: "1", profileNamespace: "viator" }),
  Jalan: Object.freeze({ site: "Jalan", adapter: "jalan-browser", adapterVersion: "1", profileNamespace: "jalan" }),
});
export const CONNECTION_MODE = "BROWSER";
export const TIME_ZONE = "Asia/Tokyo";
export const MAX_JOB_MS = 180_000;
export const MAX_CLOCK_SKEW_MS = 5_000;
export const DEFAULT_RENEW_MS = 20_000;
export const DEFAULT_POLL_MS = 15_000;
export const BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000]);
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_MCP_LINE_BYTES = 16 * 1024;
export const CLAUDE_VERSION = "2.1.292";
export const PLAYWRIGHT_VERSION = "1.56.1";
export const CHROME_VERSION = "156.0.8078.49";

export const EXPECTED_MUTATION = "mutation UpdateMultipleTimeSlots($input: TimeSlotUpdateInput!) { updateMultipleTimeSlots(input: $input) { message success result { tourOptionId dateTime cutOffTimeInSeconds cutOffIsActive __typename } __typename } }";

export const TOOL_NAMES = Object.freeze([
  "observe_target",
  "apply_desired_state",
  "verify_after_reload",
]);

export const TARGET_KEYS = Object.freeze([
  "site", "externalAccountId", "externalProductId", "timeZone", "adapter", "adapterVersion", "connectionMode",
]);

export const OPTIONAL_TARGET_KEYS = Object.freeze(["externalOptionId"]);
