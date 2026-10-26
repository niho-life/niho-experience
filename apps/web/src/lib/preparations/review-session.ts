import type { CookieSealer } from "@/lib/host/cookie-seal";
import { cookieFits, hostCookieOptions } from "@/lib/host/session";
import { preparationCaseIdOrNull } from "@/lib/host/routes";

export const PREPARATION_REVIEW_COOKIE = "__Secure-niho_preparation_review";
export const PREPARATION_REVIEW_COOKIE_PATH = "/host";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface PreparationReviewGrant {
  token: string;
  caseId: string;
  expiresAt: number;
}

interface Wire { v: 1; t: string; c: string; x: number }

export function encodePreparationReviewGrant(sealer: CookieSealer, grant: PreparationReviewGrant): string {
  if (!TOKEN.test(grant.token) || !preparationCaseIdOrNull(grant.caseId) || !Number.isFinite(grant.expiresAt)) throw new Error("Invalid preparation review grant");
  const value = sealer.seal({ v: 1, t: grant.token, c: grant.caseId, x: grant.expiresAt } satisfies Wire);
  if (!cookieFits(PREPARATION_REVIEW_COOKIE, value)) throw new Error("Preparation review grant does not fit in one cookie");
  return value;
}

export function decodePreparationReviewGrant(sealer: CookieSealer, raw: string | null | undefined, now: number): PreparationReviewGrant | null {
  const wire = sealer.open(raw) as Partial<Wire> | null;
  const caseId = preparationCaseIdOrNull(wire?.c);
  if (!wire || wire.v !== 1 || typeof wire.t !== "string" || !TOKEN.test(wire.t) || !caseId || typeof wire.x !== "number" || !Number.isFinite(wire.x) || now >= wire.x) return null;
  return { token: wire.t, caseId, expiresAt: wire.x };
}

export function preparationReviewCookieOptions(expiresAt: number, now: number) {
  return hostCookieOptions(PREPARATION_REVIEW_COOKIE_PATH, Math.max(0, Math.min(MAX_AGE_SECONDS, Math.floor((expiresAt - now) / 1000))));
}
