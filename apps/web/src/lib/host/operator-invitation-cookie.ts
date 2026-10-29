import type { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { cookieSealer } from "./cookie-seal";
import { cookieFits, hostCookieOptions } from "./session";

export const OPERATOR_INVITATION_COOKIE = "__Secure-niho_operator_invitation";
export const OPERATOR_INVITATION_COOKIE_PATH = "/host";
export const OPERATOR_INVITATION_MAX_AGE_SECONDS = 10 * 60;

export interface OperatorInvitationCookie {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAt: number;
}

interface Wire { readonly v: 1; readonly i: string; readonly t: string; readonly x: number }
const sealer = () => cookieSealer(config.hostSessionSecret, "product-operator-invitation");

export function encodeOperatorInvitationCookie(value: OperatorInvitationCookie): string {
  const sealed = sealer().seal({ v: 1, i: value.invitationId, t: value.token, x: value.expiresAt } satisfies Wire);
  if (!cookieFits(OPERATOR_INVITATION_COOKIE, sealed)) throw new Error("Invitation cookie is too large");
  return sealed;
}

export function decodeOperatorInvitationCookie(raw: string | null | undefined, now = Date.now()): OperatorInvitationCookie | null {
  const wire = sealer().open(raw) as Partial<Wire> | null;
  if (!wire || wire.v !== 1 || typeof wire.i !== "string" || typeof wire.t !== "string" || typeof wire.x !== "number" || now >= wire.x) return null;
  if (!/^[0-9a-f-]{36}$/i.test(wire.i) || !/^[A-Za-z0-9_-]{43}$/.test(wire.t)) return null;
  return { invitationId: wire.i, token: wire.t, expiresAt: wire.x };
}

export function setOperatorInvitationCookie(response: NextResponse, value: OperatorInvitationCookie, now = Date.now()): void {
  const maxAge = Math.max(0, Math.min(OPERATOR_INVITATION_MAX_AGE_SECONDS, Math.floor((value.expiresAt - now) / 1000)));
  response.cookies.set(OPERATOR_INVITATION_COOKIE, encodeOperatorInvitationCookie(value), hostCookieOptions(OPERATOR_INVITATION_COOKIE_PATH, maxAge));
}

export function clearOperatorInvitationCookie(response: NextResponse): void {
  response.cookies.set(OPERATOR_INVITATION_COOKIE, "", hostCookieOptions(OPERATOR_INVITATION_COOKIE_PATH, 0));
}
