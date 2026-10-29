import type { CookieSealer } from "@/lib/host/cookie-seal";
import { cookieFits } from "@/lib/host/session";
import { EXPERIENCE_EDITOR_CLIENT_ID } from "@niho-experience/api-client/editor-auth";

export const EDITOR_SESSION_COOKIE = "__Secure-niho_editor_session";
export const EDITOR_LOGIN_COOKIE = "__Secure-niho_editor_login";
export const EDITOR_SESSION_PATH = "/editor";
export const EDITOR_LOGIN_PATH = "/editor/auth";
export const EDITOR_LOGIN_MAX_AGE_SECONDS = 10 * 60;
export const EDITOR_SESSION_ABSOLUTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface EditorSession {
  refreshToken: string;
  idToken: string;
  idTokenExpiresAt: number;
  connectionId: string;
  connectionExpiresAt: number;
  /** The editor cookie never outlives this original sign-in deadline. */
  expiresAt: number;
  actorId: string;
}

export interface EditorLoginState {
  verifier: string;
  state: string;
  expiresAt: number;
}

interface SessionWire {
  v: 1;
  client: typeof EXPERIENCE_EDITOR_CLIENT_ID;
  r: string;
  t: string;
  te: number;
  c: string;
  ce: number;
  x: number;
  a: string;
}

interface LoginWire {
  v: 1;
  client: typeof EXPERIENCE_EDITOR_CLIENT_ID;
  verifier: string;
  state: string;
  expiresAt: number;
}

const isText = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function startEditorSession(
  fields: Omit<EditorSession, "connectionExpiresAt" | "expiresAt"> & {
    exchangedConnectionExpiresAt: number;
    verifiedConnectionExpiresAt: number;
    absoluteExpiresAt?: number;
  },
  now: number,
): EditorSession | null {
  const connectionExpiresAt = Math.min(fields.exchangedConnectionExpiresAt, fields.verifiedConnectionExpiresAt);
  const expiresAt = Math.min(connectionExpiresAt, fields.absoluteExpiresAt ?? now + EDITOR_SESSION_ABSOLUTE_MAX_AGE_MS);
  if (!isTime(connectionExpiresAt) || !isTime(expiresAt) || expiresAt <= now || fields.idTokenExpiresAt <= now) return null;
  return {
    refreshToken: fields.refreshToken,
    idToken: fields.idToken,
    idTokenExpiresAt: fields.idTokenExpiresAt,
    connectionId: fields.connectionId,
    connectionExpiresAt,
    expiresAt,
    actorId: fields.actorId,
  };
}

export function encodeEditorSession(sealer: CookieSealer, session: EditorSession): string {
  const value = sealer.seal({
    v: 1,
    client: EXPERIENCE_EDITOR_CLIENT_ID,
    r: session.refreshToken,
    t: session.idToken,
    te: session.idTokenExpiresAt,
    c: session.connectionId,
    ce: session.connectionExpiresAt,
    x: session.expiresAt,
    a: session.actorId,
  } satisfies SessionWire);
  if (!cookieFits(EDITOR_SESSION_COOKIE, value)) throw new Error("The editor session does not fit in one cookie");
  return value;
}

export function decodeEditorSession(sealer: CookieSealer, raw: string | null | undefined, now: number): EditorSession | null {
  const wire = sealer.open(raw) as Partial<SessionWire> | null;
  if (!wire || wire.v !== 1 || wire.client !== EXPERIENCE_EDITOR_CLIENT_ID) return null;
  if (!isText(wire.r, 1024) || !isText(wire.t) || !isText(wire.c, 256) || !isText(wire.a, 256)) return null;
  if (!isTime(wire.te) || !isTime(wire.ce) || !isTime(wire.x) || now >= wire.ce || now >= wire.x || wire.x > wire.ce) return null;
  return {
    refreshToken: wire.r,
    idToken: wire.t,
    idTokenExpiresAt: wire.te,
    connectionId: wire.c,
    connectionExpiresAt: wire.ce,
    expiresAt: wire.x,
    actorId: wire.a,
  };
}

export function encodeEditorLogin(sealer: CookieSealer, login: EditorLoginState): string {
  return sealer.seal({ v: 1, client: EXPERIENCE_EDITOR_CLIENT_ID, ...login } satisfies LoginWire);
}

export function decodeEditorLogin(sealer: CookieSealer, raw: string | null | undefined, now: number): EditorLoginState | null {
  const wire = sealer.open(raw) as Partial<LoginWire> | null;
  if (!wire || wire.v !== 1 || wire.client !== EXPERIENCE_EDITOR_CLIENT_ID) return null;
  if (!isText(wire.verifier, 128) || !isText(wire.state, 128) || !isTime(wire.expiresAt) || now >= wire.expiresAt) return null;
  return { verifier: wire.verifier, state: wire.state, expiresAt: wire.expiresAt };
}

export function editorCookieOptions(path: string, maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path, maxAge };
}

export function editorSessionMaxAgeSeconds(session: EditorSession, now: number): number {
  return Math.max(0, Math.floor((session.expiresAt - now) / 1000));
}
