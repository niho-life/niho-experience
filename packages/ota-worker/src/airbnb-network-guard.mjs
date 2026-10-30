import { ContractError } from "./validation.mjs";
import {
  AIRBNB_ASSET_ORIGIN,
  AIRBNB_CALENDAR_OPERATION,
  AIRBNB_ORIGIN,
  AIRBNB_PROFILE_OPERATION,
  parseAirbnbApiUrl,
} from "./airbnb-protocol.mjs";

const ASSET_TYPES = new Set(["script", "stylesheet", "font", "image", "media"]);
const ASSET_PATH = /\.(?:css|m?js|map|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)$/i;
const TELEMETRY = /(?:analytics|beacon|logging|log_batch|metrics?|telemetry|tracking|rum|impression|performance)/i;

export function airbnbProfileUrl(origin = AIRBNB_ORIGIN) {
  return `${origin}/users/profile/about?context=host`;
}

function airbnbProfileEditUrl(origin = AIRBNB_ORIGIN) {
  return `${origin}/users/profile/about?context=host&editMode=true`;
}

export function airbnbCalendarUrl(job, origin = AIRBNB_ORIGIN) {
  return `${origin}/multicalendar/experiences-and-services/${job.localDateTime.slice(0, 10)}/week`;
}

function isExactNavigation(url, job, supplierOrigin) {
  return url.href === airbnbProfileUrl(supplierOrigin)
    || url.href === airbnbProfileEditUrl(supplierOrigin)
    || url.href === airbnbCalendarUrl(job, supplierOrigin);
}

function sourcePage(request, job, supplierOrigin) {
  try {
    const source = new URL(request.frame().url());
    return source.href === airbnbProfileUrl(supplierOrigin)
      || source.href === airbnbProfileEditUrl(supplierOrigin)
      || source.href === airbnbCalendarUrl(job, supplierOrigin);
  } catch { return false; }
}

export function createAirbnbNetworkGuard({ job, supplierOrigin = AIRBNB_ORIGIN, assetOrigin = AIRBNB_ASSET_ORIGIN }) {
  let allowed = 0;
  let refused = 0;
  let writeAttempts = 0;
  let profileReads = 0;
  let calendarReads = 0;
  let auxiliaryReads = 0;
  let webSockets = 0;
  let optionalUiSockets = 0;
  let fatalRead = null;
  let externalNavigationBlocked = false;
  let frozen = false;
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();
  const refuse = (route, { fatal = false, externalNavigation = false } = {}) => {
    refused += 1;
    if (externalNavigation) externalNavigationBlocked = true;
    if (fatal && fatalRead === null) fatalRead = new ContractError("UNSAFE_REQUEST");
    return route.abort("blockedbyclient");
  };

  async function handle(route) {
    if (frozen) return refuse(route);
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return refuse(route, { fatal: true }); }
    if (url.username || url.password || url.hash) return refuse(route, { fatal: true });
    const method = request.method();
    const navigation = request.isNavigationRequest?.() === true;
    // The profile UI can render the required self-owner query without these
    // unrelated requests. Abort them, without allowing a business operation.
    const ignoredProfileRequest = url.origin === supplierOrigin && !navigation && !request.redirectedFrom?.()
      && sourcePage(request, job, supplierOrigin)
      && ((method === "POST" && url.pathname === "/api/v2/client_configs")
        || (method === "GET" && url.pathname === "/api/v2/get_travel_guides_by_user"));
    if (ignoredProfileRequest) {
      if (method !== "GET") writeAttempts += 1;
      return refuse(route);
    }
    if (method !== "GET") {
      writeAttempts += 1;
      const nonFatalTelemetry = TELEMETRY.test(`${url.hostname}${url.pathname}`);
      return refuse(route, { fatal: !nonFatalTelemetry, externalNavigation: navigation });
    }
    if (url.origin === supplierOrigin && navigation) {
      if (!isExactNavigation(url, job, supplierOrigin) || request.redirectedFrom?.()) {
        return refuse(route, { fatal: true, externalNavigation: true });
      }
      allowed += 1;
      return forward(route);
    }
    if (url.origin === supplierOrigin && url.pathname.startsWith("/api/v3/")) {
      let descriptor;
      try { descriptor = parseAirbnbApiUrl(url, job); } catch { return refuse(route, { fatal: true }); }
      if (navigation || request.redirectedFrom?.() || !["fetch", "xhr"].includes(request.resourceType?.())
        || !sourcePage(request, job, supplierOrigin)) return refuse(route, { fatal: true });
      allowed += 1;
      if (descriptor.operationName === AIRBNB_PROFILE_OPERATION) profileReads += 1;
      else if (descriptor.operationName === AIRBNB_CALENDAR_OPERATION) calendarReads += 1;
      else auxiliaryReads += 1;
      return forward(route);
    }
    const type = request.resourceType?.();
    if (url.origin === assetOrigin && !navigation && ASSET_TYPES.has(type) && ASSET_PATH.test(url.pathname)
      && !url.username && !url.password && !url.hash) {
      allowed += 1;
      return forward(route);
    }
    const telemetry = TELEMETRY.test(`${url.hostname}${url.pathname}`);
    const externalNavigation = navigation && url.origin !== supplierOrigin;
    const businessLike = navigation || ["document", "fetch", "xhr", "websocket", "eventsource"].includes(type);
    return refuse(route, { fatal: !telemetry && businessLike, externalNavigation });
  }

  const guard = {
    handle,
    noteWebSocket(value) {
      webSockets += 1;
      // This UI socket is always closed before connectToServer. It carries no
      // evidence and must not prevent the independent profile/calendar reads.
      try {
        const url = new URL(value);
        if (url.origin === "wss://ws.airbnb.jp" && url.pathname === "/ws/" && !url.username && !url.password && !url.hash
          && url.searchParams.size === 2 && ["connection_id", "key"].every((key) => url.searchParams.getAll(key).length === 1
            && url.searchParams.get(key).length > 0 && url.searchParams.get(key).length <= 512)) {
          optionalUiSockets += 1;
          return;
        }
      } catch {}
      if (fatalRead === null) fatalRead = new ContractError("UNSAFE_REQUEST");
    },
    freeze() { frozen = true; },
    assertSafe() { if (fatalRead) throw fatalRead; },
    get allowed() { return allowed; },
    get refused() { return refused; },
    get writes() { return 0; },
    get writeAttempts() { return writeAttempts; },
    get profileReads() { return profileReads; },
    get calendarReads() { return calendarReads; },
    get auxiliaryReads() { return auxiliaryReads; },
    get webSockets() { return webSockets; },
    get optionalUiSockets() { return optionalUiSockets; },
    get fatalRead() { return fatalRead; },
    get externalNavigationBlocked() { return externalNavigationBlocked; },
    get frozen() { return frozen; },
  };
  return Object.freeze(guard);
}
