import { holdProfileAccess } from "./profile-access-hold.mjs";
import { ContractError } from "./validation.mjs";

const CAPTCHA_DOCUMENT_HOST = /(?:^|\.)captcha-delivery\.com$/i;
const SUPPLIER_LIMIT_PATHS = new Set(["/availability/api", "/availability/update"]);
const MAX_BODY_TEXT = 32_768;
const HOLD_PERSIST_TIMEOUT_MS = 2_000;

const RATE_LIMIT_TEXT = /too many requests|rate limit(?:ed|ing)?|try again later|リクエスト(?:が)?多すぎ|アクセスが集中/i;
const BOT_CHALLENGE_TEXT = /(?:verify|confirm).{0,48}(?:you are|you're)\s+(?:a\s+)?(?:human|not a robot)|robot check|bot challenge|ロボットによるアクセスでないことを確認いたします[。.．]?|(?:complete|solve|verify).{0,48}captcha|captcha.{0,48}(?:challenge|verification|required)/i;
const ACCESS_LIMIT_TEXT = /access.{0,32}(?:restricted|limited|blocked|denied)|temporarily.{0,24}(?:restricted|blocked)|unusual activity|enable\s+(?:javascript|js)|(?:javascript|js).{0,24}(?:required|disabled)|disable.{0,24}(?:any\s+)?(?:ad\s*)?blocker|アクセス(?:は|が|を)?一時的に制限されています[。.．]?|アクセス(?:は|が|を)?(?:制限|拒否)|一時的に利用できません/i;

function urlOrNull(value) {
  try { return new URL(value); } catch { return null; }
}

function isCaptchaDocument(request) {
  const url = urlOrNull(request.url());
  return request.resourceType?.() === "document" && url !== null && CAPTCHA_DOCUMENT_HOST.test(url.hostname);
}

function restrictedResponse(response, supplierOrigin) {
  if (![403, 429].includes(response.status())) return null;
  const request = response.request();
  const url = urlOrNull(response.url());
  if (url?.origin !== supplierOrigin) return null;
  const relevant = request.resourceType?.() === "document" || SUPPLIER_LIMIT_PATHS.has(url.pathname);
  if (!relevant) return null;
  return response.status() === 429 ? "RATE_LIMITED" : "ACCESS_RESTRICTED";
}

function classifyText(text) {
  if (RATE_LIMIT_TEXT.test(text)) return "RATE_LIMITED";
  if (BOT_CHALLENGE_TEXT.test(text)) return "BOT_CHALLENGE";
  if (ACCESS_LIMIT_TEXT.test(text)) return "ACCESS_RESTRICTED";
  return null;
}

export function createViatorAccessMonitor({ page, guard, profile, supplierOrigin, persistHold = holdProfileAccess,
  persistHoldTimeoutMs = HOLD_PERSIST_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(persistHoldTimeoutMs) || persistHoldTimeoutMs < 1 || persistHoldTimeoutMs > 5_000) {
    throw new ContractError("INVALID_ACCESS_MONITOR_CONFIG");
  }
  let reason = null;
  let holdPromise = null;
  let holdError = null;
  let detached = false;
  const inspections = new Set();

  const restrict = (nextReason) => {
    if (reason !== null) return;
    reason = nextReason;
    guard.freeze();
    let timer;
    // A stalled profile disk cannot prevent a stopped result from reaching the
    // durable worker journal and Cloud. Late failures remain observed, but can
    // neither clear the restriction nor replace the bounded outcome.
    const persistence = Promise.resolve().then(() => persistHold(profile, nextReason)).then(() => null, (error) => error);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(new ContractError("PROFILE_ACCESS_HOLD_TIMEOUT")), persistHoldTimeoutMs);
    });
    holdPromise = Promise.race([persistence, timeout]).then((error) => { holdError = error; }).finally(() => clearTimeout(timer));
  };

  const inspectFrame = async (frame) => {
    if (reason !== null || detached) return;
    const url = urlOrNull(frame.url());
    if (url && CAPTCHA_DOCUMENT_HOST.test(url.hostname)) { restrict("BOT_CHALLENGE"); return; }
    if (url?.origin !== supplierOrigin) return;
    const text = await frame.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
    if (reason !== null || detached || typeof text !== "string") return;
    const classified = classifyText(text.slice(0, MAX_BODY_TEXT));
    if (classified) restrict(classified);
  };

  const scheduleInspection = (frame) => {
    const inspection = inspectFrame(frame).finally(() => inspections.delete(inspection));
    inspections.add(inspection);
  };

  const onRequest = (request) => { if (isCaptchaDocument(request)) restrict("BOT_CHALLENGE"); };
  const onResponse = (response) => {
    const classified = restrictedResponse(response, supplierOrigin);
    if (classified) restrict(classified);
  };
  const onFrameNavigated = (frame) => { scheduleInspection(frame); };
  const onDomContentLoaded = () => { for (const frame of page.frames()) scheduleInspection(frame); };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("framenavigated", onFrameNavigated);
  page.on("domcontentloaded", onDomContentLoaded);

  const detach = () => {
    if (detached) return;
    detached = true;
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("framenavigated", onFrameNavigated);
    page.off("domcontentloaded", onDomContentLoaded);
  };

  return Object.freeze({
    async assertAvailable() {
      if (reason === null && inspections.size > 0) await Promise.allSettled([...inspections]);
      // The supplier page is a SPA. Re-read only the already loaded frame
      // bodies immediately before an operation; this performs no HTTP request,
      // reload, navigation, or polling loop.
      if (reason === null && !detached) {
        for (const frame of page.frames()) scheduleInspection(frame);
        if (inspections.size > 0) await Promise.allSettled([...inspections]);
      }
      if (reason === null) return true;
      await holdPromise;
      const error = new ContractError("SITE_ACCESS_RESTRICTED");
      error.reasonCode = reason;
      if (holdError) error.cause = holdError;
      throw error;
    },
    async stop() {
      detach();
      if (holdPromise) await holdPromise;
    },
    get restricted() { return reason !== null; },
    get reasonCode() { return reason; },
  });
}

export const viatorAccessMonitorInternals = Object.freeze({
  MAX_BODY_TEXT,
  HOLD_PERSIST_TIMEOUT_MS,
  classifyText,
  isCaptchaDocument,
  restrictedResponse,
});
