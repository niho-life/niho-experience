import type { CookieSealer } from "@/lib/host/cookie-seal";

export const ADMIN_SESSION_COOKIE = "__Secure-niho_admin_preview";
export const ADMIN_SESSION_PATH = "/admin";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface AdminSession {
  id: string;
  actorId: string;
  actorName: string;
  expiresAt: number;
}

interface AdminSessionWire {
  v: 1;
  sid: string;
  aid: string;
  name: string;
  x: number;
}

const ID = /^[A-Za-z0-9_-]{8,100}$/;

export function startAdminSession(id: string, now: number): AdminSession {
  return { id, actorId: "admin-preview-yamamoto", actorName: "NIHO サポート 山本", expiresAt: now + ADMIN_SESSION_MAX_AGE_SECONDS * 1000 };
}

export function encodeAdminSession(sealer: CookieSealer, session: AdminSession): string {
  return sealer.seal({ v: 1, sid: session.id, aid: session.actorId, name: session.actorName, x: session.expiresAt } satisfies AdminSessionWire);
}

export function decodeAdminSession(sealer: CookieSealer, raw: string | null | undefined, now: number): AdminSession | null {
  const wire = sealer.open(raw) as Partial<AdminSessionWire> | null;
  if (!wire || wire.v !== 1 || !ID.test(wire.sid ?? "") || !ID.test(wire.aid ?? "") || typeof wire.name !== "string" || wire.name.length < 1 || wire.name.length > 80 || typeof wire.x !== "number" || now >= wire.x) return null;
  return { id: wire.sid!, actorId: wire.aid!, actorName: wire.name, expiresAt: wire.x };
}

export function adminCookieOptions(maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: ADMIN_SESSION_PATH, maxAge };
}

